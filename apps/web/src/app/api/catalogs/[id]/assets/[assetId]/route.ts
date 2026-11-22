import { createHash, randomUUID } from "node:crypto";

import { CatalogService } from "@Kavero/api/services/catalog-service";
import { sniffFont } from "@Kavero/api/services/font-files";
import { imageSize } from "@Kavero/api/services/image-size";
import { readLimited } from "@Kavero/api/services/safe-fetch";
import { catalogAsset, catalogUpload } from "@Kavero/db/schema/catalog";
import type { Database } from "@Kavero/db";
import { and, eq, gt, isNull, lte } from "drizzle-orm";

import { audit } from "@Kavero/api/services/audit-service";
import { quotaFor } from "@Kavero/api/platform/quota";
import { db, auth } from "@/services";
import { deleteUnreferencedObjects, objectStorage } from "@/modules/storage/object-storage";
import { platform } from "@/platform";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FONT_BYTES = 15 * 1024 * 1024;
const ALLOWED = /^(image\/(png|jpe?g|gif|webp|avif|svg\+xml)|font\/(ttf|otf|woff2?)|video\/(mp4|webm))$/;
const HASH = /^[a-f0-9]{64}$/;
type Ctx = { params: Promise<{ id: string; assetId: string }> };

async function userId(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user.id ?? null;
}

async function jsonBody(request: Request) {
  const body = await readLimited(request.body, 8 * 1024, "Request is too large.");
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

function detectMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && new TextDecoder().decode(bytes.subarray(0, 6)).match(/^GIF8[79]a$/)) return "image/gif";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp") {
    const brands = String.fromCharCode(...bytes.subarray(8, Math.min(bytes.length, 32)));
    if (/avif|avis/.test(brands)) return "image/avif";
    if (/isom|iso2|mp41|mp42|M4V|qt/.test(brands)) return "video/mp4";
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  if (bytes.length >= 4) {
    try {
      return sniffFont(bytes);
    } catch {
      // Continue with textual SVG detection.
    }
  }
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 16 * 1024))).replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[^]*?-->\s*)*(?:<!doctype\s+svg\b[^>]*>\s*)?<svg(?:[\s>])/i.test(text)) {
    if (/<\s*script\b|<\s*foreignObject\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|data:|javascript:)/i.test(text)) return null;
    return "image/svg+xml";
  }
  return null;
}

function invalidFile(bytes: Uint8Array, expected: string) {
  const detected = detectMimeType(bytes);
  if (!detected || detected !== expected) return "The uploaded file content does not match its declared file type.";
  if (expected.startsWith("image/") && !["image/svg+xml", "image/avif"].includes(expected) && !imageSize(bytes)) return "The image file is incomplete or invalid.";
  return null;
}

function assetKey(workspaceId: string, hash: string) {
  return `workspaces/${workspaceId}/assets/${hash}`;
}

async function ensureStoredAsset(storage: Awaited<ReturnType<typeof objectStorage>>, key: string, bytes: Uint8Array, mimeType: string, hash: string) {
  const current = await storage.get(key);
  if (current && current.byteLength === bytes.byteLength && createHash("sha256").update(current).digest("hex") === hash) return;
  // The content was already checked against this hash and MIME signature. If a
  // previous orphan cleanup or storage repair removed/corrupted the canonical
  // object, restore it while the workspace row lock prevents a concurrent
  // last-reference deletion.
  await storage.put(key, bytes, mimeType);
  const stored = await storage.get(key);
  if (!stored || stored.byteLength !== bytes.byteLength || createHash("sha256").update(stored).digest("hex") !== hash) {
    throw new Error("The verified asset could not be committed to shared storage.");
  }
}

function pendingUploadKey(workspaceId: string, uploadId: string) {
  return `workspaces/${workspaceId}/uploads/${uploadId}`;
}

type AssetReuse = { assetId: string; hash: string; bytes: number; deduplicated: true } | { error: string };

async function reuseAsset(userId: string, input: { catalogId: string; assetId: string; workspaceId: string; hash: string; mimeType: string; bytes: number }): Promise<AssetReuse | null> {
  let result: AssetReuse | null = null;
  await quotaFor({ db, platform }).reserveStorage(input.workspaceId, 0, async (tx) => {
    const service = new CatalogService(tx as unknown as Database);
    const target = await service.assetTarget(userId, input.catalogId, input.assetId, { forUpdate: true });
    if (!target || target.workspaceId !== input.workspaceId || !target.asset || target.asset.mimeType !== input.mimeType || (target.asset.bytes !== undefined && target.asset.bytes !== input.bytes) || (target.asset.hash && target.asset.hash !== input.hash)) {
      result = { error: "The catalog asset changed while the upload was being deduplicated." };
      return;
    }
    const existing = await service.findWorkspaceAsset(input.workspaceId, input.hash);
    if (!existing) return;
    if (existing.bytes !== input.bytes || existing.mimeType !== input.mimeType) {
      result = { error: "The content hash matched an asset with different metadata." };
      return;
    }
    await service.recordAsset({ catalogId: input.catalogId, assetId: input.assetId, mimeType: input.mimeType, bytes: input.bytes, hash: input.hash, storageKey: existing.storageKey });
    result = { assetId: input.assetId, hash: input.hash, bytes: input.bytes, deduplicated: true };
  });
  return result as AssetReuse | null;
}

async function clearPendingUploads(workspaceId: string, hash: string) {
  await db.update(catalogUpload).set({ completedAt: new Date() }).where(and(eq(catalogUpload.workspaceId, workspaceId), eq(catalogUpload.hash, hash), isNull(catalogUpload.completedAt)));
}

async function rejectObject(key: string, error: string, status: number) {
  await deleteUnreferencedObjects(db, [key]).catch(() => undefined);
  return Response.json({ error }, { status });
}

async function rejectPendingObject(key: string, uploadId: string, error: string, status: number) {
  await Promise.all([
    (await objectStorage()).delete(key).catch(() => undefined),
    db.update(catalogUpload).set({ completedAt: new Date() }).where(eq(catalogUpload.id, uploadId)),
  ]);
  return Response.json({ error }, { status });
}

/** Ask Kavero to authorize and sign an immutable direct upload. */
export async function POST(request: Request, { params }: Ctx) {
  const uid = await userId(request);
  if (!uid) return Response.json({ error: "Sign in required" }, { status: 401 });
  const { id, assetId } = await params;
  const input = await jsonBody(request).catch(() => null) as { hash?: unknown; bytes?: unknown } | null;
  const hash = typeof input?.hash === "string" ? input.hash : "";
  const bytes = Number(input?.bytes);
  if (!HASH.test(hash)) return Response.json({ error: "A valid SHA-256 asset hash is required." }, { status: 400 });
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) return Response.json({ error: "File size is outside the supported 25 MB limit." }, { status: 413 });

  const service = new CatalogService(db);
  const target = await service.assetTarget(uid, id, assetId);
  if (!target) return Response.json({ error: "Catalog not found" }, { status: 404 });
  if (!target.asset) return Response.json({ error: "Save the catalog before uploading its files" }, { status: 409 });
  if (!target.workspaceId) return Response.json({ error: "This catalog must belong to a workspace before uploading files." }, { status: 409 });
  const workspaceId = target.workspaceId;
  if (target.asset.hash && target.asset.hash !== hash) return Response.json({ error: "The asset changed after its cloud catalog was saved. Save the catalog again." }, { status: 409 });
  if (target.asset.bytes !== undefined && target.asset.bytes !== bytes) return Response.json({ error: "The uploaded file size does not match the catalog asset." }, { status: 409 });
  if (!ALLOWED.test(target.asset.mimeType) || (target.asset.kind === "font" && bytes > MAX_FONT_BYTES)) return Response.json({ error: "Unsupported file type or size." }, { status: 415 });

  const reused = await reuseAsset(uid, { catalogId: target.catalogId, assetId, workspaceId: target.workspaceId, hash, mimeType: target.asset.mimeType, bytes });
  if (reused) {
    await clearPendingUploads(target.workspaceId, hash);
    return "error" in reused ? Response.json({ error: reused.error }, { status: 409 }) : Response.json(reused);
  }

  const storage = await objectStorage();
  if (!(await storage.supportsPresignedUrls())) return Response.json({ direct: false });
  const canonicalKey = assetKey(target.workspaceId, hash);
  let alreadyStored: Uint8Array | null;
  try {
    alreadyStored = await storage.get(canonicalKey);
  } catch {
    return Response.json({ error: "Object storage could not verify an existing asset." }, { status: 503 });
  }
  if (alreadyStored) {
    const actualHash = createHash("sha256").update(alreadyStored).digest("hex");
    if (actualHash === hash) {
      const invalid = alreadyStored.byteLength === bytes ? invalidFile(alreadyStored, target.asset.mimeType) : "The stored object has an unexpected size.";
      if (invalid) return Response.json({ error: invalid }, { status: 409 });
      try {
        await quotaFor({ db, platform }).reserveStorage(target.workspaceId, bytes, async (tx, assertQuota) => {
          const transactional = new CatalogService(tx as unknown as Database);
          const current = await transactional.assetTarget(uid, id, assetId, { forUpdate: true });
          if (!current || current.catalogId !== target.catalogId || current.workspaceId !== target.workspaceId || !current.asset || current.asset.mimeType !== target.asset!.mimeType || (current.asset.hash && current.asset.hash !== hash)) {
            throw new Error("The catalog changed while this asset was being attached.");
          }
          const existing = await transactional.findWorkspaceAsset(target.workspaceId!, hash);
          if (existing && (existing.bytes !== bytes || existing.mimeType !== target.asset!.mimeType)) throw new Error("The content hash matched an asset with different metadata.");
          if (!existing) {
            const [reservation] = await tx.select({ id: catalogUpload.id }).from(catalogUpload).where(and(
              eq(catalogUpload.workspaceId, target.workspaceId!), eq(catalogUpload.hash, hash), isNull(catalogUpload.completedAt), gt(catalogUpload.expiresAt, new Date()),
            )).limit(1);
            if (!reservation) await assertQuota();
          }
          const storageKey = existing?.storageKey ?? canonicalKey;
          await ensureStoredAsset(storage, storageKey, alreadyStored, target.asset!.mimeType, hash);
          await transactional.recordAsset({ catalogId: target.catalogId, assetId, mimeType: target.asset!.mimeType, bytes, hash, storageKey });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Workspace storage limit reached.";
        return Response.json({ error: message }, { status: message.includes("plan includes") ? 403 : 409 });
      }
      await clearPendingUploads(target.workspaceId, hash);
      return Response.json({ assetId, hash, bytes, deduplicated: true });
    }
    await deleteUnreferencedObjects(db, [canonicalKey]);
  }

  const uploadId: string = randomUUID();
  let activeStorageKey = pendingUploadKey(workspaceId, uploadId);
  const now = new Date();
  let activeUploadId = uploadId;
  let createdReservation = false;
  let expiredKeys: string[] = [];
  try {
    await quotaFor({ db, platform }).reserveStorage(workspaceId, bytes, async (tx, assertQuota) => {
      expiredKeys = (await tx.delete(catalogUpload).where(and(eq(catalogUpload.workspaceId, workspaceId), lte(catalogUpload.expiresAt, now))).returning({ key: catalogUpload.storageKey })).map((row) => row.key);
      const [sameRequest] = await tx.select({ id: catalogUpload.id, key: catalogUpload.storageKey }).from(catalogUpload).where(and(
        eq(catalogUpload.workspaceId, workspaceId), eq(catalogUpload.catalogId, target.catalogId),
        eq(catalogUpload.userId, uid), eq(catalogUpload.assetId, assetId), eq(catalogUpload.hash, hash),
        isNull(catalogUpload.completedAt), gt(catalogUpload.expiresAt, now),
      )).limit(1);
      if (sameRequest) {
        activeUploadId = sameRequest.id;
        activeStorageKey = sameRequest.key;
        return;
      }
      const [sameHashPending] = await tx.select({ id: catalogUpload.id }).from(catalogUpload).where(and(
        eq(catalogUpload.workspaceId, workspaceId), eq(catalogUpload.hash, hash),
        isNull(catalogUpload.completedAt), gt(catalogUpload.expiresAt, now),
      )).limit(1);
      if (!sameHashPending) await assertQuota();
      await tx.insert(catalogUpload).values({
        id: uploadId,
        catalogId: target.catalogId,
        userId: uid,
        workspaceId,
        assetId,
        mimeType: target.asset!.mimeType,
        bytes,
        hash,
        storageKey: activeStorageKey,
        // The URL lasts five minutes. Keep the reservation for an extra minute
        // so cleanup/deletion can never race an upload that is still signed.
        expiresAt: new Date(now.getTime() + 6 * 60_000),
      });
      createdReservation = true;
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Workspace storage limit reached." }, { status: 403 });
  }
  await Promise.all(expiredKeys.map((key) => storage.delete(key).catch(() => undefined)));
  try {
    const signed = await storage.presignUpload({ key: activeStorageKey, fileName: target.asset.name.slice(0, 200), contentType: target.asset.mimeType, fileSize: bytes, metadata: { sha256: hash } });
    return Response.json({ direct: true, uploadId: activeUploadId, uploadUrl: signed.url, uploadHeaders: signed.uploadHeaders ?? {} }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (createdReservation) await db.delete(catalogUpload).where(eq(catalogUpload.id, uploadId));
    return Response.json({ error: error instanceof Error ? error.message : "Could not prepare the upload." }, { status: 503 });
  }
}

/** Complete a signed upload only after verifying the stored bytes against the pending record. */
export async function PATCH(request: Request, { params }: Ctx) {
  const uid = await userId(request);
  if (!uid) return Response.json({ error: "Sign in required" }, { status: 401 });
  const { id, assetId } = await params;
  const input = await jsonBody(request).catch(() => null) as { uploadId?: unknown } | null;
  const uploadId = typeof input?.uploadId === "string" ? input.uploadId : "";
  const service = new CatalogService(db);
  const target = await service.assetTarget(uid, id, assetId);
  if (!target || !target.asset) return Response.json({ error: "Catalog asset not found." }, { status: 404 });
  const recorded = await service.findAsset(uid, id, assetId);
  if (recorded && target.asset.hash && recorded.hash === target.asset.hash && (target.asset.bytes === undefined || recorded.bytes === target.asset.bytes)) {
    return Response.json({ assetId, hash: recorded.hash, bytes: recorded.bytes, deduplicated: true });
  }
  const now = new Date();
  const [pending] = await db.select().from(catalogUpload).where(and(
    eq(catalogUpload.id, uploadId),
    eq(catalogUpload.catalogId, target.catalogId),
    eq(catalogUpload.assetId, assetId),
    eq(catalogUpload.userId, uid),
    isNull(catalogUpload.completedAt),
    gt(catalogUpload.expiresAt, now),
  )).limit(1);
  if (!pending || pending.workspaceId !== target.workspaceId || (target.asset.hash && target.asset.hash !== pending.hash)) return Response.json({ error: "Upload authorization expired or no longer matches this asset." }, { status: 409 });

  const storage = await objectStorage();
  try {
    const metadata = await storage.stat(pending.storageKey);
    if (metadata.byteSize !== pending.bytes) return rejectPendingObject(pending.storageKey, pending.id, "The uploaded object has an unexpected size.", 409);
    if (metadata.contentType && metadata.contentType !== pending.mimeType) return rejectPendingObject(pending.storageKey, pending.id, "The uploaded object has an unexpected content type.", 409);
    const data = await storage.get(pending.storageKey);
    if (!data || data.byteLength !== pending.bytes) return Response.json({ error: "The uploaded object is missing or incomplete." }, { status: 409 });
    const actualHash = createHash("sha256").update(data).digest("hex");
    if (actualHash !== pending.hash) return rejectPendingObject(pending.storageKey, pending.id, "The file hash does not match the authorized upload.", 422);
    const invalid = invalidFile(data, pending.mimeType);
    if (invalid) return rejectPendingObject(pending.storageKey, pending.id, invalid, 415);
    await quotaFor({ db, platform }).reserveStorage(pending.workspaceId, 0, async (tx) => {
      const transactionalDb = tx as unknown as Database;
      const transactional = new CatalogService(transactionalDb);
      const current = await transactional.assetTarget(uid, id, assetId, { forUpdate: true });
      if (!current || current.catalogId !== target.catalogId || current.workspaceId !== pending.workspaceId || !current.asset || (current.asset.hash && current.asset.hash !== pending.hash) || (current.asset.bytes !== undefined && current.asset.bytes !== pending.bytes)) throw new Error("The catalog changed while this upload was in progress.");
      const existing = await transactional.findWorkspaceAsset(pending.workspaceId, actualHash);
      if (existing && (existing.bytes !== pending.bytes || existing.mimeType !== pending.mimeType)) throw new Error("The content hash matched an asset with different metadata.");
      const canonicalKey = existing?.storageKey ?? assetKey(pending.workspaceId, actualHash);
      await ensureStoredAsset(storage, canonicalKey, data, pending.mimeType, actualHash);
      const completed = await tx.update(catalogUpload).set({ completedAt: new Date() }).where(and(
        eq(catalogUpload.id, uploadId), eq(catalogUpload.userId, uid), eq(catalogUpload.workspaceId, pending.workspaceId),
        isNull(catalogUpload.completedAt), gt(catalogUpload.expiresAt, new Date()),
      )).returning({ id: catalogUpload.id });
      if (!completed.length) throw new Error("This upload has already been completed.");
      await tx.insert(catalogAsset).values({ id: randomUUID(), catalogId: target.catalogId, assetId, mimeType: pending.mimeType, bytes: pending.bytes, hash: actualHash, storageKey: canonicalKey })
        .onConflictDoUpdate({ target: [catalogAsset.catalogId, catalogAsset.assetId], set: { mimeType: pending.mimeType, bytes: pending.bytes, hash: actualHash, storageKey: canonicalKey } });
    });
    await audit(db, { userId: uid, area: "assets", action: "asset:upload", target: `${id}/${assetId}`, outcome: "ok", details: { mimeType: pending.mimeType, bytes: pending.bytes } });
    return Response.json({ assetId, hash: actualHash, bytes: pending.bytes });
  } catch (error) {
    await audit(db, { userId: uid, area: "assets", action: "asset:upload", target: `${id}/${assetId}`, outcome: "error" });
    await deleteUnreferencedObjects(db, [assetKey(pending.workspaceId, pending.hash)]).catch(() => undefined);
    return Response.json({ error: error instanceof Error ? error.message : "Upload verification failed." }, { status: 409 });
  }
}

/** Bounded upload fallback for local/self-hosted providers without direct signed transfers. */
export async function PUT(request: Request, { params }: Ctx) {
  const uid = await userId(request);
  if (!uid) return Response.json({ error: "Sign in required" }, { status: 401 });
  const { id, assetId } = await params;
  const service = new CatalogService(db);
  const target = await service.assetTarget(uid, id, assetId);
  if (!target) return Response.json({ error: "Catalog not found" }, { status: 404 });
  if (!target.asset || !target.workspaceId) return Response.json({ error: "Save the catalog in a workspace before uploading its files" }, { status: 409 });
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!ALLOWED.test(type) || type !== target.asset.mimeType) return Response.json({ error: "Unsupported file type" }, { status: 415 });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) return Response.json({ error: "File too large" }, { status: 413 });
  let bytes: Uint8Array;
  try {
    bytes = await readLimited(request.body, MAX_BYTES);
  } catch {
    return Response.json({ error: "File too large" }, { status: 413 });
  }
  if (!bytes.byteLength || (target.asset.bytes !== undefined && target.asset.bytes !== bytes.byteLength)) return Response.json({ error: "The uploaded file size does not match the catalog asset." }, { status: 409 });
  const invalid = invalidFile(bytes, type);
  if (invalid) return Response.json({ error: invalid }, { status: 415 });
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (target.asset.hash && target.asset.hash !== hash) return Response.json({ error: "The uploaded file hash does not match the catalog asset." }, { status: 422 });
  const reused = await reuseAsset(uid, { catalogId: target.catalogId, assetId, workspaceId: target.workspaceId, hash, mimeType: type, bytes: bytes.byteLength });
  if (reused) return "error" in reused ? Response.json({ error: reused.error }, { status: 409 }) : Response.json(reused);
  const storageKey = assetKey(target.workspaceId, hash);
  const storage = await objectStorage();
  let deduplicated = false;
  try {
    await quotaFor({ db, platform }).reserveStorage(target.workspaceId, bytes.byteLength, async (tx, assertQuota) => {
      const transactionalDb = tx as unknown as Database;
      const current = await new CatalogService(transactionalDb).assetTarget(uid, id, assetId, { forUpdate: true });
      if (!current || current.catalogId !== target.catalogId || current.workspaceId !== target.workspaceId || !current.asset || current.asset.mimeType !== type || (current.asset.hash && current.asset.hash !== hash)) {
        throw new Error("The catalog changed while this upload was in progress.");
      }
      const transactionalCatalogs = new CatalogService(transactionalDb);
      const existing = await transactionalCatalogs.findWorkspaceAsset(target.workspaceId!, hash);
      if (existing) {
        if (existing.bytes !== bytes.byteLength || existing.mimeType !== type) throw new Error("The content hash matched an asset with different metadata.");
        await transactionalCatalogs.recordAsset({ catalogId: target.catalogId, assetId, mimeType: type, bytes: bytes.byteLength, hash, storageKey: existing.storageKey });
        deduplicated = true;
        return;
      }
      await assertQuota();
      try {
        await storage.putImmutable(storageKey, bytes, type);
      } catch {
        const alreadyWritten = await storage.get(storageKey).catch(() => null);
        if (!alreadyWritten || createHash("sha256").update(alreadyWritten).digest("hex") !== hash) throw new Error("Could not safely write the uploaded asset to storage.");
      }
      await transactionalCatalogs.recordAsset({ catalogId: target.catalogId, assetId, mimeType: type, bytes: bytes.byteLength, hash, storageKey });
    });
  } catch (error) {
    await audit(db, { userId: uid, area: "assets", action: "asset:upload", target: `${id}/${assetId}`, outcome: "error" });
    if (!deduplicated) await deleteUnreferencedObjects(db, [storageKey]).catch(() => undefined);
    const message = error instanceof Error ? error.message : "Asset upload failed.";
    return Response.json({ error: message }, { status: message.includes("plan includes") || message.includes("storage") ? 403 : 409 });
  }
  await audit(db, { userId: uid, area: "assets", action: "asset:upload", target: `${id}/${assetId}`, outcome: "ok", details: { mimeType: type, bytes: bytes.byteLength } });
  return Response.json({ assetId, hash, bytes: bytes.byteLength, ...(deduplicated ? { deduplicated: true } : {}) });
}

/** Download only after catalog ownership/membership has been checked. */
export async function GET(request: Request, { params }: Ctx) {
  const uid = await userId(request);
  if (!uid) return Response.json({ error: "Sign in required" }, { status: 401 });
  const { id, assetId } = await params;
  const asset = await new CatalogService(db).findAsset(uid, id, assetId);
  if (!asset) return Response.json({ error: "Not found" }, { status: 404 });
  const storage = await objectStorage();
  if (asset.mimeType !== "image/svg+xml" && await storage.supportsPresignedUrls()) {
    const url = await storage.presignDownload(asset.storageKey, 300);
    return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  }
  const bytes = await storage.get(asset.storageKey);
  if (!bytes) return Response.json({ error: "File missing from storage" }, { status: 404 });
  return new Response(new Blob([bytes as BlobPart], { type: asset.mimeType }), {
    headers: {
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
