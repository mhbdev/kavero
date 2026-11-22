import type { Database } from "@Kavero/db";
import { catalog, catalogAsset, catalogUpload } from "@Kavero/db/schema/catalog";
import { mediaJob } from "@Kavero/db/schema/integration";
import { publication, publicationAsset } from "@Kavero/db/schema/publication";
import { workspace } from "@Kavero/db/schema/workspace";
import { createResilientRateLimiter, type ResilientRateLimiter } from "@Kavero/redis";
import { TRPCError } from "@trpc/server";
import { and, count, eq, gt, inArray, isNull, notExists, sql, sum } from "drizzle-orm";

import { unlimitedEntitlements, type Entitlements, type EntitlementProvider, type Platform } from "./edition";
import { requireCatalog } from "../services/access";

/** Quota checks for a request context (unlimited when the host provides no platform). */
export function quotaFor(ctx: { db: Database; platform?: Platform }) {
  return new QuotaService(ctx.db, ctx.platform?.entitlements ?? unlimitedEntitlements, ctx.platform?.edition);
}

/**
 * Enforces workspace entitlements (plan limits). Outside the cloud edition every
 * limit is null (unlimited), so these checks cost one in-memory call and no queries.
 */
export class QuotaService {
  constructor(private readonly db: Database, private readonly entitlements: EntitlementProvider, private readonly platformEdition?: string) {}

  private limits(workspaceId: string): Promise<Entitlements> {
    return this.entitlements.forWorkspace(workspaceId);
  }

  /** Before saving a catalog to the cloud: a new one must fit within its workspace limit. */
  async assertCanSaveCatalog(userId: string, workspaceId: string, documentId: string) {
    const existing = await requireCatalog(this.db, userId, documentId, "read").catch((error) => {
      if (error instanceof TRPCError && error.code === "NOT_FOUND") return null;
      throw error;
    });
    workspaceId = existing?.row.workspaceId ?? workspaceId;
    const { maxCatalogs, plan } = await this.limits(workspaceId);
    if (maxCatalogs === null) return;
    const [exists] = await this.db.select({ id: catalog.id }).from(catalog).where(and(eq(catalog.workspaceId, workspaceId), eq(catalog.documentId, documentId))).limit(1);
    if (exists) return;
    const [row] = await this.db.select({ n: count() }).from(catalog).where(eq(catalog.workspaceId, workspaceId));
    if ((row?.n ?? 0) >= maxCatalogs) throw limitError(`This workspace's ${plan} plan includes ${maxCatalogs} cloud catalog${maxCatalogs === 1 ? "" : "s"}. Delete one or keep this catalog in your browser.`);
  }

  /** Before publishing: a catalog that isn't published yet must fit within maxPublishedSites. */
  async assertCanPublish(userId: string, catalogRowId: string) {
    const { row } = await requireCatalog(this.db, userId, catalogRowId, "read");
    const workspaceId = row.workspaceId;
    if (!workspaceId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Move this catalog into a workspace before publishing it." });
    const { maxPublishedSites, plan } = await this.limits(workspaceId);
    if (maxPublishedSites === null) return;
    const [exists] = await this.db.select({ id: publication.id }).from(publication).where(eq(publication.catalogId, catalogRowId)).limit(1);
    if (exists) return;
    const [publishedCount] = await this.db.select({ n: count() }).from(publication).innerJoin(catalog, eq(catalog.id, publication.catalogId)).where(eq(catalog.workspaceId, workspaceId));
    if ((publishedCount?.n ?? 0) >= maxPublishedSites) throw limitError(`This workspace's ${plan} plan includes ${maxPublishedSites} published site${maxPublishedSites === 1 ? "" : "s"}. Unpublish one first.`);
  }

  /** Enforce the target workspace's catalog, publication and storage limits on a move. */
  async assertCanMoveCatalog(userId: string, catalogRowId: string, targetWorkspaceId: string) {
    const { row } = await requireCatalog(this.db, userId, catalogRowId, "delete");
    if (row.workspaceId === targetWorkspaceId) return;
    const entitlements = await this.limits(targetWorkspaceId);

    if (entitlements.maxCatalogs !== null) {
      const [targetCount] = await this.db.select({ n: count() }).from(catalog).where(eq(catalog.workspaceId, targetWorkspaceId));
      if ((targetCount?.n ?? 0) >= entitlements.maxCatalogs) {
        throw limitError(`This workspace's ${entitlements.plan} plan includes ${entitlements.maxCatalogs} cloud catalogs. Delete one before moving this catalog here.`);
      }
    }

    if (entitlements.maxPublishedSites !== null) {
      const [currentPublication] = await this.db.select({ id: publication.id }).from(publication).where(eq(publication.catalogId, row.id)).limit(1);
      if (currentPublication) {
        const [targetPublishedCount] = await this.db.select({ n: count() }).from(publication)
          .innerJoin(catalog, eq(catalog.id, publication.catalogId)).where(eq(catalog.workspaceId, targetWorkspaceId));
        if ((targetPublishedCount?.n ?? 0) >= entitlements.maxPublishedSites) {
          throw limitError(`This workspace's ${entitlements.plan} plan includes ${entitlements.maxPublishedSites} published sites. Unpublish one before moving this catalog here.`);
        }
      }
    }

    if (entitlements.maxStorageMb !== null) {
      const [catalogAssets, publishedAssets, targetCatalogAssets, targetPublishedAssets] = await Promise.all([
        this.db.select({ hash: catalogAsset.hash, bytes: catalogAsset.bytes }).from(catalogAsset).where(eq(catalogAsset.catalogId, row.id)),
        this.db.select({ hash: publicationAsset.hash, bytes: publicationAsset.bytes }).from(publicationAsset)
          .innerJoin(publication, eq(publication.id, publicationAsset.publicationId)).where(eq(publication.catalogId, row.id)),
        this.db.select({ hash: catalogAsset.hash }).from(catalogAsset).innerJoin(catalog, eq(catalog.id, catalogAsset.catalogId)).where(eq(catalog.workspaceId, targetWorkspaceId)),
        this.db.select({ hash: publicationAsset.hash }).from(publicationAsset).innerJoin(publication, eq(publication.id, publicationAsset.publicationId))
          .innerJoin(catalog, eq(catalog.id, publication.catalogId)).where(eq(catalog.workspaceId, targetWorkspaceId)),
      ]);
      const alreadyStored = new Set([...targetCatalogAssets, ...targetPublishedAssets].map((asset) => asset.hash));
      const incoming = new Map<string, number>();
      for (const asset of [...catalogAssets, ...publishedAssets]) {
        if (!alreadyStored.has(asset.hash)) incoming.set(asset.hash, Math.max(incoming.get(asset.hash) ?? 0, asset.bytes));
      }
      await this.assertStorage(targetWorkspaceId, [...incoming.values()].reduce((total, bytes) => total + bytes, 0));
    }
  }

  /** Before storing `addBytes` more unique media for this workspace. */
  async assertStorage(workspaceId: string, addBytes: number) {
    const { maxStorageMb, plan } = await this.limits(workspaceId);
    if (maxStorageMb === null) return;
    const [stored] = await this.db.select({
      total: sql<string | null>`(
        SELECT COALESCE(SUM(unique_assets.bytes), 0)
        FROM (
          SELECT hash, MAX(bytes) AS bytes
          FROM (
            SELECT ca.hash, ca.bytes
            FROM catalog_asset ca
            INNER JOIN catalog c ON c.id = ca.catalog_id
            WHERE c.workspace_id = ${workspaceId}
            UNION
            SELECT pa.hash, pa.bytes
            FROM publication_asset pa
            INNER JOIN publication p ON p.id = pa.publication_id
            INNER JOIN catalog c ON c.id = p.catalog_id
            WHERE c.workspace_id = ${workspaceId}
          ) assets
          GROUP BY hash
        ) unique_assets
      )`,
    }).from(workspace).where(eq(workspace.id, workspaceId));
    const pendingUploads = this.db
      .select({ hash: catalogUpload.hash, bytes: catalogUpload.bytes })
      .from(catalogUpload)
      .where(and(
        eq(catalogUpload.workspaceId, workspaceId),
        isNull(catalogUpload.completedAt),
        gt(catalogUpload.expiresAt, new Date()),
        notExists(this.db.select({ id: catalogAsset.id }).from(catalogAsset)
          .innerJoin(catalog, eq(catalog.id, catalogAsset.catalogId))
          .where(and(eq(catalog.workspaceId, workspaceId), eq(catalogAsset.hash, catalogUpload.hash)))),
        notExists(this.db.select({ id: publicationAsset.id }).from(publicationAsset)
          .innerJoin(publication, eq(publication.id, publicationAsset.publicationId))
          .innerJoin(catalog, eq(catalog.id, publication.catalogId))
          .where(and(eq(catalog.workspaceId, workspaceId), eq(publicationAsset.hash, catalogUpload.hash)))),
      ))
      .groupBy(catalogUpload.hash, catalogUpload.bytes)
      .as("workspace_pending_uploads");
    const [[reservedUploads], [reservedJobs]] = await Promise.all([
      this.db.select({ total: sum(pendingUploads.bytes) }).from(pendingUploads),
      this.db.select({ total: sum(mediaJob.storageBytes) }).from(mediaJob)
        .where(and(eq(mediaJob.workspaceId, workspaceId), inArray(mediaJob.status, ["queued", "generating", "done"]))),
    ]);
    const used = Number(stored?.total ?? 0) + Number(reservedUploads?.total ?? 0) + Number(reservedJobs?.total ?? 0);
    if (used + addBytes > maxStorageMb * 1024 * 1024) throw limitError(`This workspace's ${plan} plan includes ${maxStorageMb} MB of media storage, and it's full.`);
  }

  /** Serialize a workspace's quota check with its new reservation/asset record. */
  async reserveStorage(workspaceId: string, addBytes: number, reserve: (tx: Database, assertQuota: () => Promise<void>) => Promise<void>) {
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, workspaceId)).for("update");
      if (!locked) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found." });
      const transactionalDb = tx as unknown as Database;
      const transactionalQuota = new QuotaService(transactionalDb, this.entitlements, this.platformEdition);
      await reserve(transactionalDb, () => transactionalQuota.assertStorage(workspaceId, addBytes));
    });
  }

  /** Counts one server-funded AI request against aiRequestsPerDay. */
  async consumeAiRequest(workspaceId: string) {
    const { aiRequestsPerDay, plan } = await this.limits(workspaceId);
    if (aiRequestsPerDay === null) return;
    if (aiRequestsPerDay === 0) throw limitError(`AI isn't included in your ${plan} plan.`);
    const decision = await dailyLimiter(aiRequestsPerDay, this.platformEdition === "cloud").limit(workspaceId);
    if (!decision.allowed) throw limitError(`This workspace has used today's ${aiRequestsPerDay} AI requests on its ${plan} plan. Try again tomorrow.`);
  }
}

const limiters = new Map<number, ResilientRateLimiter>();
function dailyLimiter(max: number, strict: boolean) {
  let l = limiters.get(max);
  if (!l) {
    l = createResilientRateLimiter({ namespace: `ai-daily-${max}`, maxRequests: max, windowMs: 24 * 60 * 60 * 1000, fallbackMode: strict ? "error" : "local" });
    limiters.set(max, l);
  }
  return l;
}

function limitError(message: string) {
  return new TRPCError({ code: "FORBIDDEN", message, cause: "plan-limit" });
}
