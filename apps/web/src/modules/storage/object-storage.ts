import { createHash } from "node:crypto";
import { join } from "node:path";

import type { Database } from "@Kavero/db";
import { catalogAsset } from "@Kavero/db/schema/catalog";
import { publicationAsset } from "@Kavero/db/schema/publication";
import { workspace } from "@Kavero/db/schema/workspace";
import { LocalStorageProvider } from "@circulo-ai/upload/local";
import { isPresignedUrlProvider, type PresignedUrlResponse, type StorageProvider, type StoredObjectMetadata } from "@circulo-ai/upload/core";
import { S3StorageProvider } from "@circulo-ai/upload/s3";
import { eq, inArray } from "drizzle-orm";

const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

/** Kavero-owned object storage port. Application authorization and ownership stay outside the provider. */
export interface ObjectStorage {
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  putImmutable(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<StoredObjectMetadata>;
  supportsPresignedUrls(): Promise<boolean>;
  presignUpload(input: { key: string; fileName: string; contentType: string; fileSize: number; metadata?: Record<string, string> }): Promise<PresignedUrlResponse>;
  presignDownload(key: string, expirationSeconds?: number): Promise<string>;
}

type StorageSettings = Record<string, string | number | boolean | null>;
type Handle = { provider: StorageProvider; signature: string; active: number; retired: boolean };
type StorageCache = { current?: Handle; port?: ObjectStorage };
const globalCache = globalThis as typeof globalThis & { __kaveroStorageCache?: StorageCache };
const cache = (globalCache.__kaveroStorageCache ??= {});

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function closeIfIdle(handle: Handle) {
  if (handle.retired && handle.active === 0) void Promise.resolve(handle.provider.close?.()).catch((error) => console.error("[storage] provider close failed", error));
}

function createProvider(settings: StorageSettings): StorageProvider {
  const driver = String(settings.driver ?? "filesystem");
  if (driver === "s3") {
    const bucket = text(settings.bucket);
    if (!bucket) throw new Error("S3 storage needs a bucket (S3_BUCKET)");
    const accessKeyId = text(settings.accessKeyId);
    const secretAccessKey = text(settings.secretAccessKey);
    if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together.");
    const endpoint = text(settings.endpoint);
    return new S3StorageProvider({
      bucket,
      region: text(settings.region) ?? (endpoint ? "auto" : "us-east-1"),
      ...(endpoint ? { endpoint } : {}),
      ...(text(settings.publicEndpoint) ? { publicEndpoint: text(settings.publicEndpoint) } : {}),
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
      forcePathStyle: settings.forcePathStyle === true,
      maxAttempts: 3,
      connectionTimeoutMs: 5_000,
      requestTimeoutMs: 30_000,
      maxDownloadBytes: MAX_OBJECT_BYTES,
    });
  }
  if (driver !== "filesystem") throw new Error(`Unknown storage driver "${driver}" (expected filesystem or s3)`);
  if (process.env.KAVERO_EDITION?.trim().toLowerCase() === "cloud") throw new Error("Cloud edition requires private S3-compatible object storage; filesystem storage is not durable across serverless instances.");
  return new LocalStorageProvider({
    basePath: process.env.KAVERO_STORAGE_DIR || join(process.cwd(), ".storage"),
    maxDownloadBytes: MAX_OBJECT_BYTES,
  });
}

async function currentHandle(): Promise<Handle> {
  const { runtimeConfig } = await import("@/platform");
  const settings = await runtimeConfig.values("storage");
  const signature = createHash("sha256").update(JSON.stringify(settings)).digest("hex");
  if (cache.current?.signature !== signature) {
    if (cache.current) {
      cache.current.retired = true;
      closeIfIdle(cache.current);
    }
    cache.current = { signature, provider: createProvider(settings), active: 0, retired: false };
  }
  return cache.current;
}

async function useProvider<T>(operation: (provider: StorageProvider) => Promise<T>): Promise<T> {
  const handle = await currentHandle();
  handle.active++;
  try {
    return await operation(handle.provider);
  } finally {
    handle.active--;
    closeIfIdle(handle);
  }
}

function isMissingObject(error: unknown) {
  const candidate = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return candidate?.$metadata?.httpStatusCode === 404 || ["NoSuchKey", "NotFound", "NoSuchObject"].includes(candidate?.name ?? candidate?.code ?? "");
}

/** Reuses initialized providers and closes replaced clients only after active operations finish. */
export async function objectStorage(): Promise<ObjectStorage> {
  if (cache.port) return cache.port;
  cache.port = {
    put: (key, data, contentType = "application/octet-stream") => useProvider(async (provider) => {
      await provider.upload({ file: Buffer.from(data), fileName: key, contentType, customKey: key, writeMode: "overwrite" });
    }),
    putImmutable: (key, data, contentType = "application/octet-stream") => useProvider(async (provider) => {
      await provider.upload({ file: Buffer.from(data), fileName: key, contentType, customKey: key, writeMode: "create-only" });
    }),
    get: (key) => useProvider(async (provider) => {
      try {
        return new Uint8Array(await provider.download({ key, maxBytes: MAX_OBJECT_BYTES }));
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw error;
      }
    }),
    delete: (key) => useProvider(async (provider) => {
      try {
        await provider.delete({ key });
      } catch (error) {
        if (!isMissingObject(error)) throw error;
      }
    }),
    stat: (key) => useProvider(async (provider) => {
      if (!provider.stat) throw new Error("The configured storage provider does not support object metadata checks.");
      return provider.stat({ key });
    }),
    supportsPresignedUrls: async () => useProvider(async (provider) => isPresignedUrlProvider(provider)),
    presignUpload: (input) => useProvider(async (provider) => {
      if (!isPresignedUrlProvider(provider)) throw new Error("The configured storage provider does not support direct signed uploads.");
      return provider.generatePresignedUploadUrl({ ...input, customKey: input.key, writeMode: "create-only", expirationSeconds: 300 });
    }),
    presignDownload: (key, expirationSeconds = 300) => useProvider(async (provider) => {
      if (!isPresignedUrlProvider(provider)) throw new Error("The configured storage provider does not support direct signed downloads.");
      return provider.generatePresignedDownloadUrl({ key, expirationSeconds });
    }),
  };
  return cache.port;
}

/** Content-addressed objects are removed only after every catalog and publication reference is gone. */
export async function deleteUnreferencedObjects(db: Database, keys: string[]) {
  const unique = [...new Set(keys)];
  if (!unique.length) return;
  const storage = await objectStorage();
  const groups = new Map<string, string[]>();
  const unscoped: string[] = [];
  for (const key of unique) {
    const workspaceId = /^workspaces\/([^/]+)\/(?:assets|uploads)\//.exec(key)?.[1];
    if (!workspaceId) {
      unscoped.push(key);
      continue;
    }
    const group = groups.get(workspaceId) ?? [];
    group.push(key);
    groups.set(workspaceId, group);
  }

  const deleteIfUnreferenced = async (tx: Database, candidates: string[]) => {
    const [catalogRefs, publishedRefs] = await Promise.all([
      tx.select({ key: catalogAsset.storageKey }).from(catalogAsset).where(inArray(catalogAsset.storageKey, candidates)),
      tx.select({ key: publicationAsset.storageKey }).from(publicationAsset).where(inArray(publicationAsset.storageKey, candidates)),
    ]);
    const retained = new Set([...catalogRefs, ...publishedRefs].map((ref) => ref.key));
    await Promise.all(candidates.filter((key) => !retained.has(key)).map((key) => storage.delete(key)));
  };

  // All workspace asset attachments use the matching workspace row lock. Keep
  // the reference check and object deletion in the same transaction so a last
  // reference cannot be attached between the check and delete.
  for (const [workspaceId, candidates] of groups) {
    await db.transaction(async (tx) => {
      await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, workspaceId)).for("update");
      await deleteIfUnreferenced(tx as unknown as Database, candidates);
    });
  }
  if (unscoped.length) await deleteIfUnreferenced(db, unscoped);
}

/** Writes, reads and deletes a probe file with the current settings (Admin → System → Test). */
export async function testObjectStorage(): Promise<{ ok: boolean; driver: string; message?: string }> {
  const { runtimeConfig } = await import("@/platform");
  const settings = await runtimeConfig.values("storage");
  const driver = String(settings.driver ?? "filesystem");
  const key = `health/probe-${crypto.randomUUID()}`;
  try {
    const storage = await objectStorage();
    await storage.put(key, new Uint8Array([1]), "application/octet-stream");
    const read = await storage.get(key);
    await storage.delete(key);
    if (read?.length !== 1 || read[0] !== 1) return { ok: false, driver, message: "The file read back didn't match what was written." };
    return { ok: true, driver };
  } catch (error) {
    return { ok: false, driver, message: error instanceof Error ? error.message.slice(0, 300) : "Storage check failed" };
  }
}
