import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { ffmpegPath } from "@Kavero/export-chromium";
import { pingRedis } from "@Kavero/redis";
import { sql } from "drizzle-orm";

import { objectStorage } from "@/modules/storage/object-storage";
import { platform } from "@/platform";
import { db } from "@/services";

import pkg from "../../../../package.json";

export const runtime = "nodejs";
// Never prerender or cache: every request runs the probes.
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 3000;

// Mirrors the lookup order in @Kavero/export-chromium (browser.ts) without launching anything.
const CHROME_CANDIDATES = [
  process.env.KAVERO_CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS).unref()),
  ]);
}

async function checkDb() {
  try {
    await withTimeout(db.execute(sql`select 1`));
    return true;
  } catch {
    return false;
  }
}

async function checkStorage() {
  const key = `health/probe-${randomUUID()}`;
  const probe = new Uint8Array([1]);
  const storage = await objectStorage().catch(() => null);
  if (!storage) return false;
  let healthy = false;
  try {
    await withTimeout(storage.put(key, probe));
    const read = await withTimeout(storage.get(key));
    healthy = read?.length === 1 && read[0] === 1;
  } catch {
    healthy = false;
  }
  try {
    await withTimeout(storage.delete(key));
  } catch {
    healthy = false;
  }
  return healthy;
}

function checkChrome() {
  if (CHROME_CANDIDATES.some((p) => !!p && existsSync(p))) return true;
  if (process.env.VERCEL !== "1") return false;
  try {
    return import.meta.resolve("@sparticuz/chromium").startsWith("file:");
  } catch {
    return false;
  }
}

function checkFfmpeg() {
  try {
    return existsSync(ffmpegPath());
  } catch {
    return false;
  }
}

/** Readiness probe. Cloud requires all shared/runtime dependencies; never returns config or secrets. */
export async function GET() {
  const cloud = platform.edition === "cloud";
  const [dbOk, storageOk, redisOk] = await Promise.all([checkDb(), checkStorage(), pingRedis()]);
  const chromeOk = checkChrome();
  const ffmpegOk = checkFfmpeg();
  const ready = dbOk && (!cloud || (storageOk && redisOk && chromeOk && ffmpegOk));
  const body = {
    status: ready ? "ok" : dbOk ? "degraded" : "error",
    db: dbOk,
    storage: storageOk,
    redis: redisOk,
    chrome: chromeOk,
    ffmpeg: ffmpegOk,
    version: pkg.version,
  };
  return Response.json(body, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
