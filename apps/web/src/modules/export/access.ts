import { readLimited } from "@Kavero/api/services/safe-fetch";
import { audit } from "@Kavero/api/services/audit-service";
import { BrowserBusyError, isBrowserClosedError } from "@Kavero/export-chromium";
import { z } from "zod";

import { runtimeConfig } from "@/platform";
import { objectStorage } from "@/modules/storage/object-storage";
import { auth, db } from "@/services";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Video export launches Chrome on the server. Allow it for a local Kavero
 * (local-first, no account needed) or for signed-in users on a hosted server.
 */
export async function canExport(request: Request): Promise<boolean> {
  const host = new URL(request.url).hostname;
  if (LOCAL_HOSTS.has(host) && process.env.NODE_ENV !== "production") return true;
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    return !!session?.user;
  } catch {
    return false;
  }
}

/** Record authenticated export attempts without retaining the exported document or its assets. */
export async function auditExport(request: Request, kind: "pdf" | "images" | "video", target: string, outcome: "ok" | "error", details?: unknown) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return;
  await audit(db, { userId: session.user.id, area: "exports", channel: "web", action: `export:${kind}`, target, outcome, details });
}

/**
 * Origin headless Chrome loads /render from. Never derived from the request:
 * the Host header is client-controlled and would let a caller aim Chrome at
 * another host. KAVERO_RENDER_URL overrides it, e.g. an internal address.
 */
export function renderOrigin(request: Request): string {
  const configured = process.env.KAVERO_RENDER_URL || process.env.BETTER_AUTH_URL;
  return new URL(configured || request.url).origin;
}

/**
 * Export requests carry the document plus its media/fonts: as multipart form
 * data (the editor: raw files, no base64) or JSON with data: URLs (older clients).
 * The cap is Admin → System → Exports → Largest export (KAVERO_MAX_EXPORT_MB):
 * 60 MB by default on servers, 4 GB in the desktop app.
 */
export function maxExportBytes(): number {
  const mb = runtimeConfig.valuesSync("exports").maxRequestMb;
  const configuredMb = typeof mb === "number" && mb > 0 ? mb : 60;
  if (process.env.VERCEL === "1") {
    // Vercel functions default to a 4.5 MiB body limit. The 20 MiB preview
    // requires an explicit project opt-in and 4 GB function memory. Leave
    // space for multipart headers and the document JSON.
    const platformMb = process.env.VERCEL_SUPPORT_LARGE_REQUEST_BODY === "1" ? 19 : 4;
    return Math.min(configuredMb, platformMb) * 1024 * 1024;
  }
  return configuredMb * 1024 * 1024;
}

/** Deliver an export directly from private object storage on Vercel. */
export async function exportDownloadResponse(bytes: Uint8Array, contentType: string, filename: string): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (process.env.VERCEL === "1") {
    const storage = await objectStorage();
    if (!(await storage.supportsPresignedUrls())) {
      return Response.json({ error: "Vercel exports require private S3-compatible storage with signed downloads." }, { status: 503, headers });
    }
    const key = `exports/${crypto.randomUUID()}/${filename}`;
    // Generic binary type makes browsers download the object. The filename is
    // the final key segment; a bucket lifecycle rule removes temporary exports.
    await storage.putImmutable(key, bytes, "application/octet-stream");
    const downloadUrl = await storage.presignDownload(key, 300);
    return Response.json({ downloadUrl }, { headers });
  }

  const { attachmentHeader } = await import("@Kavero/catalog-engine");
  return new Response(new Blob([bytes as BlobPart], { type: contentType }), {
    headers: { ...headers, "Content-Disposition": attachmentHeader(filename) },
  });
}

const EXPORT_MEDIA_TYPE = /^(image\/(png|jpe?g|gif|webp|avif|svg\+xml)|video\/(mp4|webm)|font\/(ttf|otf|woff2?))$/;

/** An uploaded export file: raw bytes and their media type. */
export type ExportFile = { data: Uint8Array; type: string };

/**
 * data: URLs for supported images, MP4/WebM video and fonts, or public https URLs for
 * linked media. The server never fetches these itself; the export browser loads https
 * URLs through openRenderPage, which only allows public hosts.
 */
export const exportAssetsSchema = z
  .record(z.string(), z.union([
    z.string().regex(/^data:(image\/(png|jpe?g|gif|webp|avif|svg\+xml)|video\/(mp4|webm)|font\/(ttf|otf|woff2?));base64,/),
    z.string().max(2000).regex(/^https:\/\/[^\s]+$/),
  ]))
  .refine((a) => Object.values(a).reduce((n, v) => n + v.length, 0) <= maxExportBytes(), { message: "Files are too large to export" })
  .default({});

/**
 * The request body (JSON, or the `payload` field of a multipart form) plus any
 * uploaded files (`asset:<id>` form fields), or an error Response when it is too
 * large or malformed. Never buffers past the limit.
 */
export async function readExportBody(request: Request): Promise<{ body: unknown; files: Record<string, ExportFile> } | { error: Response }> {
  await runtimeConfig.refresh();
  const limit = maxExportBytes();
  const tooLarge = () => ({ error: Response.json({ error: `This catalog is too large to export here (${Math.round(limit / 1024 / 1024)} MB limit including media).` }, { status: 413 }) });
  if (Number(request.headers.get("content-length") ?? 0) > limit) return tooLarge();
  let bytes: Uint8Array;
  try {
    bytes = await readLimited(request.body, limit);
  } catch {
    return tooLarge();
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (/^multipart\/form-data/i.test(contentType)) {
    let form: FormData;
    try {
      form = await new Response(bytes as BodyInit, { headers: { "content-type": contentType } }).formData();
    } catch {
      return { error: Response.json({ error: "Invalid export request." }, { status: 400 }) };
    }
    const files: Record<string, ExportFile> = {};
    let body: unknown = null;
    for (const [key, value] of form.entries()) {
      if (key === "payload" && typeof value === "string") {
        try {
          body = JSON.parse(value);
        } catch {
          body = null;
        }
      } else if (key.startsWith("asset:") && typeof value !== "string") {
        const type = value.type.split(";")[0]!.trim().toLowerCase();
        if (!EXPORT_MEDIA_TYPE.test(type)) return { error: Response.json({ error: `Unsupported file type for export: ${type || "unknown"}.` }, { status: 415 }) };
        files[key.slice("asset:".length)] = { data: new Uint8Array(await value.arrayBuffer()), type };
      }
    }
    return { body, files };
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)), files: {} };
  } catch {
    return { body: null, files: {} };
  }
}

/** 503 when every Chrome slot is busy, otherwise a 500 with the reason. */
export function exportFailed(e: unknown, what: string): Response {
  // By name too: route bundles may each load their own copy of the class.
  if (e instanceof BrowserBusyError || (e as Error)?.name === "BrowserBusyError") return Response.json({ error: (e as Error).message }, { status: 503, headers: { "Retry-After": "30" } });
  if (isBrowserClosedError(e)) {
    console.error(`[kavero] ${what}: Chrome closed during export`, (e as Error).message);
    return Response.json({ error: `${what} failed: Chrome ran out of memory or closed while rendering. Try exporting fewer slides at a time, or use smaller images.` }, { status: 500 });
  }
  return Response.json({ error: `${what} failed: ${(e as Error).message}` }, { status: 500 });
}
