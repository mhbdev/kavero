import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { AiCredentialService } from "@Kavero/api/services/ai-credential-service";
import { createRedisJobQueue, createResilientRateLimiter, closeRedisRuntime, type JobQueue, type QueueJob, type ResilientRateLimiter } from "@Kavero/redis";
import { mediaJob } from "@Kavero/db/schema/integration";
import { catalogUpload } from "@Kavero/db/schema/catalog";
import { workspaceRole } from "@Kavero/api/services/access";
import { ensurePersonalWorkspace } from "@Kavero/db/personal-workspace";
import { imageModelFromCredential, videoModelFromCredential, type AiProvider } from "@Kavero/ai";
import { and, count, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { createDownload, experimental_generateVideo, generateImage } from "ai";

import { ENV } from "@/env.server";
import { db } from "@/services";
import { allowPrivateUrls, platform, secretBox } from "@/platform";
import { objectStorage } from "@/modules/storage/object-storage";
import { quotaFor } from "@Kavero/api/platform/quota";
import { ffmpegPath } from "@Kavero/export-chromium";

export type MediaPurpose = "image" | "video";
export type MediaJobStatus = "queued" | "generating" | "done" | "error";
export type MediaJob = typeof mediaJob.$inferSelect;
type MediaQueuePayload = { jobId: string };
type MediaFileFormat = "original" | "gif" | "poster";

const KEEP_MS = 60 * 60 * 1000;
const MAX_JOB_AGE_MS = 24 * 60 * 60 * 1000;
const GENERATION_TIMEOUTS = { image: 5 * 60_000, video: 16 * 60_000 } as const;
const LEASE_MS = 25 * 60_000;
const QUEUE_NAME = "media-generation";
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const MAX_ACTIVE_MEDIA_JOBS = 6;

const GOOGLE_IMAGE_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:8", "8:1", "1:4", "4:1"] as const;
const rateLimiters = new Map<number, ResilientRateLimiter>();
let queue: JobQueue<MediaQueuePayload> | null = null;
let localQueue: Promise<void> = Promise.resolve();

export class MediaJobCapacityError extends Error {
  constructor() {
    super("Media generation is busy for this workspace. Wait for a current job to finish, then try again.");
    this.name = "MediaJobCapacityError";
  }
}

export class MediaJobRateLimitError extends Error {
  constructor() {
    super("Too many media generations for this workspace. Wait a minute and try again.");
    this.name = "MediaJobRateLimitError";
  }
}

function mediaQueue() {
  if (!queue) {
    queue = createRedisJobQueue<MediaQueuePayload>({
      name: QUEUE_NAME,
      prefix: "kavero:v1:queue",
      maxAttempts: 3,
      visibilityTimeoutMs: LEASE_MS,
      redisUrl: ENV.REDIS_URL,
    });
  }
  return queue;
}

function workspaceLimiter() {
  const limit = 8;
  let limiter = rateLimiters.get(limit);
  if (!limiter) {
    limiter = createResilientRateLimiter({ namespace: `media-generation-${limit}`, maxRequests: limit, windowMs: 60_000, redisUrl: ENV.REDIS_URL, fallbackMode: platform.edition === "desktop" ? "local" : "error" });
    rateLimiters.set(limit, limiter);
  }
  return limiter;
}

function normalizeAspectRatio(provider: AiProvider, purpose: MediaPurpose, value: string, supportedAspectRatios: string[] = []): `${number}:${number}` | undefined {
  const [width, height] = value.split(":").map(Number);
  const ratio = width! / height!;
  const closest = (values: readonly string[]) => values.reduce((best, candidate) => {
    const [w, h] = candidate.split(":").map(Number);
    const [bw, bh] = best.split(":").map(Number);
    return Math.abs(Math.log(ratio / (w! / h!))) < Math.abs(Math.log(ratio / (bw! / bh!))) ? candidate : best;
  });
  if (provider === "google" && purpose === "image") return closest(GOOGLE_IMAGE_ASPECT_RATIOS) as `${number}:${number}`;
  if (provider === "google" && purpose === "video") return ratio >= 1 ? "16:9" : "9:16";
  if (provider === "openrouter" && purpose === "video") return supportedAspectRatios.length ? closest(supportedAspectRatios) as `${number}:${number}` : undefined;
  if (provider === "ai-gateway" && purpose === "video") return undefined;
  return value as `${number}:${number}`;
}

/** Persist a media job, reserve it within the workspace and enqueue only its opaque id. */
export async function startMediaJob(input: {
  userId: string;
  purpose: MediaPurpose;
  prompt: string;
  provider: AiProvider;
  model: string;
  aspectRatio: string;
  workspaceId?: string;
}) {
  if (!ENV.REDIS_URL && platform.edition !== "desktop") throw new Error("Configure REDIS_URL and run the Kavero media worker to generate images and videos.");
  const workspace = input.workspaceId
    ? { id: input.workspaceId }
    : await ensurePersonalWorkspace(db, input.userId);
  const role = await workspaceRole(db, input.userId, workspace.id);
  if (!role || role === "viewer") throw new Error("You need an editor role in this workspace to generate media.");
  if (!(await workspaceLimiter().limit(workspace.id)).allowed) throw new MediaJobRateLimitError();
  const id = randomUUID();
  const reservedBytes = MAX_MEDIA_BYTES * (input.purpose === "video" ? 3 : 1);
  await quotaFor({ db, platform }).reserveStorage(workspace.id, reservedBytes, async (tx, assertQuota) => {
    const [{ n: activeJobs = 0 } = { n: 0 }] = await tx.select({ n: count() }).from(mediaJob).where(and(
      eq(mediaJob.workspaceId, workspace.id),
      inArray(mediaJob.status, ["queued", "generating"]),
    ));
    if (activeJobs >= MAX_ACTIVE_MEDIA_JOBS) throw new MediaJobCapacityError();
    await assertQuota();
    await tx.insert(mediaJob).values({
      id,
      userId: input.userId,
      workspaceId: workspace.id,
      purpose: input.purpose,
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      provider: input.provider,
      model: input.model,
      status: "queued",
      storageBytes: reservedBytes,
    });
  });
  try {
    if (ENV.REDIS_URL) await mediaQueue().enqueue({ jobId: id }, { jobId: id });
    else enqueueLocalMediaJob(id);
  } catch (error) {
    await db.update(mediaJob).set({ status: "error", error: "The background worker is unavailable. Try again shortly.", storageBytes: 0, expiresAt: new Date(Date.now() + KEEP_MS) }).where(eq(mediaJob.id, id));
    throw error;
  }
  const [created] = await db.select().from(mediaJob).where(eq(mediaJob.id, id)).limit(1);
  if (!created) throw new Error("The media job could not be created.");
  return created;
}

function enqueueLocalMediaJob(jobId: string) {
  localQueue = localQueue.then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await processMediaQueueJob({ id: jobId, data: { jobId }, attempts: attempt, enqueuedAt: Date.now() });
        return;
      } catch (error) {
        if (attempt === 2) console.error("[media-job] local generation failed", safeError(error, ""));
      }
    }
  }).catch((error) => console.error("[media-job] local queue failed", error instanceof Error ? error.message : error));
}

export async function getMediaJobForUser(userId: string, id: string): Promise<MediaJob | null> {
  const [job] = await db.select().from(mediaJob).where(and(eq(mediaJob.id, id), eq(mediaJob.userId, userId))).limit(1);
  return job ?? null;
}

export function publicMediaJob(job: MediaJob) {
  return {
    id: job.id,
    purpose: job.purpose,
    status: job.status,
    prompt: job.prompt,
    provider: job.provider,
    model: job.model,
    mimeType: job.mimeType,
    bytes: job.bytes,
    error: job.error,
    createdAt: job.createdAt.getTime(),
  };
}

function extensionFor(mimeType: string) {
  return mimeType === "image/svg+xml" ? "svg" : mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
}

function generatedSvg(bytes: Uint8Array, mediaType: string | undefined) {
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 16_384))).replace(/^\uFEFF/, "").trimStart();
  return mediaType === "image/svg+xml" || /^<svg(?:[\s>])/i.test(text) || /^<\?xml[^>]*>\s*<svg(?:[\s>])/i.test(text);
}

function runFfmpeg(args: string[], timeoutMs = 120_000) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("FFmpeg conversion timed out. Try a shorter video."));
    }, timeoutMs);
    timer.unref();
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-400); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`FFmpeg conversion failed (${code}): ${stderr}`));
    });
  });
}

function safeError(error: unknown, apiKey: string) {
  const message = error instanceof Error ? error.message : "Media generation failed.";
  return (apiKey ? message.replaceAll(apiKey, "[redacted]") : message).slice(0, 500);
}

async function generateAndStore(job: MediaJob) {
  const allowLocal = await allowPrivateUrls();
  const credentials = await new AiCredentialService(db, secretBox, { allowLocal, appUrl: ENV.BETTER_AUTH_URL, requireApiKey: platform.edition === "cloud" }).mediaCredential(job.userId, job.purpose);
  if (credentials.provider !== job.provider || credentials.model !== job.model) throw new Error("Your assigned media model changed before this job started. Submit it again with your current model.");
  const ratio = normalizeAspectRatio(credentials.provider, job.purpose, job.aspectRatio, credentials.supportedAspectRatios);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Media generation timed out.")), GENERATION_TIMEOUTS[job.purpose]);
  timeout.unref();
  const storage = await objectStorage();
  const prefix = `media-jobs/${job.workspaceId}/${job.id}`;
  const temp = await mkdtemp(join(tmpdir(), `kavero-${job.id}-`));
  const outputKeys: string[] = [];
  try {
    if (job.purpose === "image") {
      const result = await generateImage({
        model: imageModelFromCredential(credentials),
        prompt: job.prompt,
        ...(credentials.provider === "google" && ratio ? { aspectRatio: ratio } : {}),
        n: 1,
        maxRetries: 1,
        abortSignal: controller.signal,
      });
      const bytes = Buffer.from(result.image.uint8Array);
      if (!bytes.byteLength || bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("The generated image is empty or larger than the 25 MB asset limit.");
      const mimeType = generatedSvg(bytes, result.image.mediaType) ? "image/svg+xml" : result.image.mediaType || "image/png";
      if (!["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"].includes(mimeType)) throw new Error("The image provider returned an unsupported file type.");
      const storageKey = `${prefix}/original.${extensionFor(mimeType)}`;
      await storage.put(storageKey, bytes, mimeType);
      outputKeys.push(storageKey);
      const [saved] = await db.update(mediaJob).set({
        status: "done", storageKey, mimeType, bytes: bytes.byteLength, storageBytes: bytes.byteLength, leaseUntil: null, expiresAt: new Date(Date.now() + KEEP_MS), error: null,
      }).where(and(eq(mediaJob.id, job.id), eq(mediaJob.status, "generating"))).returning({ id: mediaJob.id });
      if (!saved) throw new Error("This media job was removed before its output could be saved.");
      return;
    }

    const result = await experimental_generateVideo({
      model: videoModelFromCredential(credentials),
      prompt: job.prompt,
      ...(ratio ? { aspectRatio: ratio } : {}),
      n: 1,
      maxRetries: 1,
      abortSignal: controller.signal,
      download: createDownload({ maxBytes: MAX_MEDIA_BYTES }),
      poll: { timeoutMs: 15 * 60_000 },
    });
    const bytes = Buffer.from(result.video.uint8Array);
    if (!bytes.byteLength || bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("The generated video is empty or larger than the 25 MB asset limit.");
    if (result.video.mediaType !== "video/mp4") throw new Error("The video provider returned an unsupported format. Kavero currently accepts MP4 video.");
    const storageKey = `${prefix}/original.mp4`;
    const posterStorageKey = `${prefix}/poster.png`;
    const videoPath = join(temp, "original.mp4");
    const posterPath = join(temp, "poster.png");
    await writeFile(videoPath, bytes);
    await runFfmpeg(["-y", "-loglevel", "error", "-ss", "0.5", "-i", videoPath, "-frames:v", "1", posterPath]);
    const posterStat = await stat(posterPath);
    if (!posterStat.size || posterStat.size > MAX_MEDIA_BYTES) throw new Error("Could not create a usable video cover image.");
    await storage.put(storageKey, bytes, "video/mp4");
    outputKeys.push(storageKey);
    await storage.put(posterStorageKey, await readFile(posterPath), "image/png");
    outputKeys.push(posterStorageKey);
    const [saved] = await db.update(mediaJob).set({
      status: "done", storageKey, posterStorageKey, mimeType: "video/mp4", bytes: bytes.byteLength,
      storageBytes: bytes.byteLength + posterStat.size,
      leaseUntil: null, expiresAt: new Date(Date.now() + KEEP_MS), error: null,
    }).where(and(eq(mediaJob.id, job.id), eq(mediaJob.status, "generating"))).returning({ id: mediaJob.id });
    if (!saved) throw new Error("This media job was removed before its output could be saved.");
  } catch (error) {
    await Promise.all(outputKeys.map((key) => storage.delete(key).catch(() => undefined)));
    throw new Error(safeError(error, credentials.apiKey), { cause: error });
  } finally {
    clearTimeout(timeout);
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** At-least-once Redis delivery is guarded by an atomic DB lease; only the job id is queued. */
async function processMediaQueueJob(queueJob: QueueJob<MediaQueuePayload>) {
  const { jobId } = queueJob.data;
  const now = new Date();
  const [claimed] = await db.update(mediaJob).set({
    status: "generating",
    startedAt: now,
    leaseUntil: new Date(now.getTime() + LEASE_MS),
    attempts: sql`${mediaJob.attempts} + 1`,
    error: null,
  }).where(and(
    eq(mediaJob.id, jobId),
    or(eq(mediaJob.status, "queued"), and(eq(mediaJob.status, "generating"), lte(mediaJob.leaseUntil, now))),
  )).returning();
  if (!claimed) return;
  const attempt = queueJob.attempts + 1;
  try {
    await generateAndStore(claimed);
  } catch (error) {
    const final = attempt >= 3;
    const message = safeError(error, "");
    await db.update(mediaJob).set({
      status: final ? "error" : "queued",
      error: final ? message : null,
      storageBytes: final ? 0 : claimed.storageBytes,
      leaseUntil: null,
      expiresAt: final ? new Date(Date.now() + KEEP_MS) : null,
    }).where(eq(mediaJob.id, jobId));
    if (final) {
      const storage = await objectStorage();
      await Promise.all([claimed.storageKey, claimed.posterStorageKey, claimed.gifStorageKey].filter((key): key is string => !!key).map((key) => storage.delete(key).catch(() => undefined)));
    }
    throw error;
  }
}

async function recoverQueuedJobs() {
  const pending = await db.select({ id: mediaJob.id }).from(mediaJob).where(eq(mediaJob.status, "queued")).limit(100);
  for (const item of pending) await mediaQueue().enqueue({ jobId: item.id }, { jobId: item.id });
}

async function cleanupExpiredJobs() {
  const cutoff = new Date(Date.now() - MAX_JOB_AGE_MS);
  const expired = await db.select().from(mediaJob).where(or(
    lte(mediaJob.expiresAt, new Date()),
    and(inArray(mediaJob.status, ["queued", "generating"]), lte(mediaJob.createdAt, cutoff)),
  )).limit(100);
  if (!expired.length) return;
  const storage = await objectStorage();
  for (const job of expired) {
    await Promise.all([job.storageKey, job.posterStorageKey, job.gifStorageKey].filter((key): key is string => !!key).map((key) => storage.delete(key).catch(() => undefined)));
    await db.delete(mediaJob).where(eq(mediaJob.id, job.id));
  }
}

async function cleanupExpiredUploads() {
  const expired = await db.select().from(catalogUpload).where(lte(catalogUpload.expiresAt, new Date())).limit(100);
  if (!expired.length) return;
  const storage = await objectStorage();
  for (const upload of expired) {
    try {
      await storage.delete(upload.storageKey);
      await db.delete(catalogUpload).where(eq(catalogUpload.id, upload.id));
    } catch (error) {
      console.error("[media-worker] expired upload cleanup failed", error instanceof Error ? error.message : error);
    }
  }
}

/** Long-running service command used by Docker/self-hosted and a separate cloud worker host. */
export async function runMediaWorker() {
  if (!ENV.REDIS_URL) throw new Error("REDIS_URL is required by the Kavero media worker.");
  await recoverQueuedJobs();
  await cleanupExpiredJobs();
  await cleanupExpiredUploads();
  const worker = mediaQueue().worker(processMediaQueueJob, {
    group: "kavero-media-v1",
    concurrency: 2,
    blockMs: 1_000,
    hooks: {
      onError: (error) => console.error("[media-worker] queue error", error.message),
      onDeadLetter: async (job, error) => {
        await db.update(mediaJob).set({ status: "error", error: safeError(error, ""), storageBytes: 0, leaseUntil: null, expiresAt: new Date(Date.now() + KEEP_MS) }).where(eq(mediaJob.id, job.id));
      },
    },
  });
  const recovery = setInterval(() => {
    void recoverQueuedJobs().catch((error) => console.error("[media-worker] queued-job recovery failed", error instanceof Error ? error.message : error));
    void cleanupExpiredJobs().catch((error) => console.error("[media-worker] expiry cleanup failed", error instanceof Error ? error.message : error));
    void cleanupExpiredUploads().catch((error) => console.error("[media-worker] upload cleanup failed", error instanceof Error ? error.message : error));
  }, 30_000);
  recovery.unref();
  const stop = () => { void worker.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await worker.start();
  } finally {
    clearInterval(recovery);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await closeRedisRuntime(ENV.REDIS_URL);
  }
}

async function createGif(job: MediaJob) {
  if (!job.storageKey || job.purpose !== "video" || job.status !== "done") throw new Error("This media job has no video result to convert.");
  if (job.gifStorageKey) return job.gifStorageKey;
  const storage = await objectStorage();
  const video = await storage.get(job.storageKey);
  if (!video) throw new Error("The generated video is no longer available.");
  const temp = await mkdtemp(join(tmpdir(), `kavero-gif-${job.id}-`));
  const videoPath = join(temp, "original.mp4");
  const gifPath = join(temp, "preview.gif");
  const key = `media-jobs/${job.workspaceId}/${job.id}/preview.gif`;
  let wroteObject = false;
  try {
    await writeFile(videoPath, video);
    await runFfmpeg([
      "-y", "-loglevel", "error", "-i", videoPath, "-t", "20",
      "-vf", "fps=12,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer",
      "-loop", "0", gifPath,
    ]);
    const info = await stat(gifPath);
    if (!info.size) throw new Error("FFmpeg produced an empty GIF.");
    if (info.size > MAX_MEDIA_BYTES) throw new Error("The GIF exceeds the 25 MB asset limit. Convert a shorter video or use the MP4.");
    const bytes = await readFile(gifPath);
    let resultKey = key;
    await quotaFor({ db, platform }).reserveStorage(job.workspaceId, info.size, async (tx, assertQuota) => {
      const [current] = await tx.select({ status: mediaJob.status, gifStorageKey: mediaJob.gifStorageKey })
        .from(mediaJob).where(eq(mediaJob.id, job.id)).for("update");
      if (!current || current.status !== "done") throw new Error("This video job is no longer available.");
      if (current.gifStorageKey) {
        resultKey = current.gifStorageKey;
        return;
      }
      await assertQuota();
      await storage.put(key, bytes, "image/gif");
      wroteObject = true;
      const [saved] = await tx.update(mediaJob)
        .set({ gifStorageKey: key, storageBytes: sql`${mediaJob.storageBytes} + ${info.size}` })
        .where(and(eq(mediaJob.id, job.id), eq(mediaJob.status, "done"), isNull(mediaJob.gifStorageKey)))
        .returning({ gifStorageKey: mediaJob.gifStorageKey });
      if (!saved) throw new Error("This video job changed while its preview was being saved.");
    });
    return resultKey;
  } catch (error) {
    if (wroteObject) {
      const [saved] = await db.select({ gifStorageKey: mediaJob.gifStorageKey }).from(mediaJob).where(eq(mediaJob.id, job.id)).limit(1).catch(() => []);
      if (saved?.gifStorageKey !== key) await storage.delete(key).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function mediaJobFile(job: MediaJob, format: MediaFileFormat = "original") {
  if (job.status !== "done") throw new Error("This media job has no completed result yet.");
  if (format === "gif") return { storageKey: await createGif(job), mimeType: "image/gif", bytes: null as number | null };
  if (format === "poster") {
    if (job.purpose !== "video" || !job.posterStorageKey) throw new Error("This media job has no video cover image.");
    return { storageKey: job.posterStorageKey, mimeType: "image/png", bytes: null as number | null };
  }
  if (!job.storageKey) throw new Error("This media job has no completed result yet.");
  return { storageKey: job.storageKey, mimeType: job.mimeType ?? "application/octet-stream", bytes: job.bytes };
}

export async function readMediaFile(storageKey: string) {
  return (await objectStorage()).get(storageKey);
}
