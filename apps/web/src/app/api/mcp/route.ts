import { createHash } from "node:crypto";

import { AiCredentialService } from "@Kavero/api/services/ai-credential-service";
import { CatalogService } from "@Kavero/api/services/catalog-service";
import { quotaFor } from "@Kavero/api/platform/quota";
import { MAX_FONT_BYTES, downloadFont, googleFontFaces, sniffFont } from "@Kavero/api/services/font-files";
import { imageSize } from "@Kavero/api/services/image-size";
import { fetchImageAsDataUrl } from "@Kavero/api/services/safe-fetch";
import { audit, isBanned, permissionsToScopes, type ApiKeyPrincipal } from "@Kavero/api/services/audit-service";
import { user } from "@Kavero/db/schema/auth";
import type { Database } from "@Kavero/db";
import { eq } from "drizzle-orm";
import type { CatalogDocument } from "@Kavero/catalog-engine";
import { renderPdf, renderSlideImage } from "@Kavero/export-chromium";
import { createKaveroMcpServer } from "@Kavero/mcp-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createResilientRateLimiter, type ResilientRateLimiter } from "@Kavero/redis";

import { renderOrigin } from "@/modules/export/access";
import { deleteUnreferencedObjects, objectStorage } from "@/modules/storage/object-storage";
import { ENV } from "@/env.server";
import { allowPrivateUrls, platform, runtimeConfig, secretBox, serverAiProvider } from "@/platform";
import { auth, db } from "@/services";

export const runtime = "nodejs";


// Per-API-key request limit (Admin → System → MCP). One limiter per configured value.
const limiters = new Map<number, ResilientRateLimiter>();
function mcpLimiter(perMinute: number) {
  let limiter = limiters.get(perMinute);
  if (!limiter) {
    limiter = createResilientRateLimiter({ namespace: `mcp-${perMinute}`, maxRequests: perMinute, windowMs: 60_000, fallbackMode: platform.edition === "cloud" ? "error" : "local" });
    limiters.set(perMinute, limiter);
  }
  return limiter;
}

const unauthorized = (message: string) =>
  Response.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="kavero"' } });

/**
 * Kavero MCP server (Streamable HTTP, stateless JSON mode).
 * Authenticate with a Better Auth API key: `Authorization: Bearer kv_...`.
 */
export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return unauthorized("Missing bearer token. Create one in Kavero → Settings → API keys.");
  const verified = await auth.api.verifyApiKey({ body: { key: token } }).catch(() => null);
  if (!verified?.valid || !verified.key) return unauthorized("Invalid, expired or revoked API key.");
  const [owner] = await db.select({ banned: user.banned, banExpires: user.banExpires }).from(user).where(eq(user.id, verified.key.referenceId)).limit(1);
  if (!owner || isBanned(owner)) return unauthorized("Invalid, expired or revoked API key.");
  const perMinute = Number((await runtimeConfig.values("mcp")).requestsPerMinute) || 600;
  let decision;
  try {
    decision = await mcpLimiter(perMinute).limit(verified.key.id);
  } catch {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32003, message: "The MCP service is temporarily unavailable. Try again shortly." }, id: null },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
  if (!decision.allowed) {
    const retry = Math.max(1, Math.ceil((decision.resetAt.getTime() - Date.now()) / 1000));
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32029, message: `Rate limit: this API key may make ${perMinute} requests per minute. Try again in ${retry} s (an admin can raise it in Admin → System → MCP).` }, id: null },
      { status: 429, headers: { "Retry-After": String(retry) } },
    );
  }
  const principal: ApiKeyPrincipal = {
    userId: verified.key.referenceId,
    apiKeyId: verified.key.id,
    scopes: permissionsToScopes(verified.key.permissions),
  };

  // Links handed to agents use the app's public address (BETTER_AUTH_URL), not the
  // address this request happened to arrive on (an internal or localhost name).
  const origin = new URL(ENV.BETTER_AUTH_URL).origin;
  // Desktop local mode: editor links open in the Kavero app (kavero://), which is signed in.
  const localMode = platform.edition === "desktop";
  const allowLocal = await allowPrivateUrls();
  const catalogs = new CatalogService(db, undefined, platform);
  /** Store bytes once per workspace hash and attach the reference to a cloud catalog. */
  const storeImage = async (catalogRowId: string, bytes: Uint8Array, mimeType: string) => {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const assetId = `ast_${hash}`;
    const { row } = await catalogs.access(principal.userId, catalogRowId, "write");
    if (!row.workspaceId) throw new Error("Move the catalog into a workspace before importing media.");
    let storageKey = `workspaces/${row.workspaceId}/assets/${hash}`;
    const storage = await objectStorage();
    await quotaFor({ db, platform }).reserveStorage(row.workspaceId, bytes.byteLength, async (tx, assertQuota) => {
      const transactionalDb = tx as unknown as Database;
      const service = new CatalogService(transactionalDb);
      const current = await service.access(principal.userId, catalogRowId, "write", { forUpdate: true });
      if (current.row.workspaceId !== row.workspaceId) throw new Error("The catalog moved while this media import was in progress.");
      const existing = await service.findWorkspaceAsset(row.workspaceId!, hash);
      if (existing) {
        if (existing.bytes !== bytes.byteLength || existing.mimeType !== mimeType) throw new Error("The asset hash matched content with different metadata.");
        storageKey = existing.storageKey;
      } else {
        await assertQuota();
        try {
          await storage.putImmutable(storageKey, bytes, mimeType);
        } catch {
          const alreadyWritten = await storage.get(storageKey).catch(() => null);
          if (!alreadyWritten || createHash("sha256").update(alreadyWritten).digest("hex") !== hash) throw new Error("Could not safely write the imported asset to storage.");
        }
      }
      await service.recordAsset({ catalogId: catalogRowId, assetId, mimeType, bytes: bytes.byteLength, hash, storageKey });
    });
    return { id: assetId, mimeType, bytes: bytes.byteLength, hash, ...(imageSize(bytes) ?? {}) };
  };
  /** The catalog's stored images and fonts as data: URLs (access-checked per file). */
  const loadAssets = async (doc: CatalogDocument) => {
    const assets: Record<string, string> = {};
    for (const a of doc.assets) {
      if (a.kind === "video") continue;
      const file = await catalogs.findAsset(principal.userId, doc.id, a.id);
      const bytes = file && (await (await objectStorage()).get(file.storageKey));
      if (bytes) assets[a.id] = `data:${file.mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
      else if (a.attribution?.provider !== "GIPHY" && /^https:\/\//i.test(a.uri)) assets[a.id] = a.uri;
    }
    return assets;
  };
  const server = createKaveroMcpServer({
    db,
    principal,
    host: {
      platform,
      publicUrl: (slug) => `${origin}/c/${slug}`,
      editorUrl: (documentId) => (localMode ? `kavero://editor/${encodeURIComponent(documentId)}` : `${origin}/editor/${encodeURIComponent(documentId)}`),
      importImage: async (catalogRowId, url) => {
        const dataUrl = await fetchImageAsDataUrl(url, { allowLocal });
        const [, mimeType = "", b64 = ""] = /^data:([^;]+);base64,([A-Za-z0-9+/=]*)$/.exec(dataUrl) ?? [];
        return storeImage(catalogRowId, Uint8Array.from(Buffer.from(b64, "base64")), mimeType);
      },
      importImageData: async (catalogRowId, bytes, mimeType) => {
        if (bytes.byteLength > 15 * 1024 * 1024) throw new Error("Images must be under 15 MB");
        if (!imageSize(bytes)) throw new Error("That data isn't a PNG, JPEG, GIF or WebP image");
        return storeImage(catalogRowId, bytes, mimeType);
      },
      importFont: async (catalogRowId, source) => {
        if ("url" in source) {
          const { bytes, mimeType } = await downloadFont(source.url, { allowLocal });
          return storeImage(catalogRowId, bytes, mimeType);
        }
        if (source.bytes.byteLength > MAX_FONT_BYTES) throw new Error("Font files must be under 15 MB");
        return storeImage(catalogRowId, source.bytes, sniffFont(source.bytes));
      },
      googleFontFaces,
      loadAssets,
      renderPreview: async (doc, slideIndex) => renderSlideImage({ doc, assets: await loadAssets(doc), baseUrl: renderOrigin(request), slideIndex, width: 1280 }),
      renderPdf: async (doc) => renderPdf({ doc, assets: await loadAssets(doc), baseUrl: renderOrigin(request) }),
      deleteObjects: (keys) => deleteUnreferencedObjects(db, keys),
      ai: (await new AiCredentialService(db, secretBox, { allowLocal, appUrl: ENV.BETTER_AUTH_URL, requireApiKey: platform.edition === "cloud" }).provider(principal.userId).catch(() => null)) ?? (await serverAiProvider()),
    },
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
      return await transport.handleRequest(request, { authInfo: { token, clientId: principal.apiKeyId, scopes: principal.scopes } });
  } finally {
    void server.close();
  }
}

// Stateless server: no standalone SSE stream or sessions to delete.
const notAllowed = () => Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, { status: 405, headers: { Allow: "POST" } });
export const GET = notAllowed;
export const DELETE = notAllowed;
