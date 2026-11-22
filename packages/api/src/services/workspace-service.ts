import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Database } from "@Kavero/db";
import { user } from "@Kavero/db/schema/auth";
import { catalog, catalogUpload } from "@Kavero/db/schema/catalog";
import { mediaJob } from "@Kavero/db/schema/integration";
import { WORKSPACE_ROLES, workspace, workspaceInvite, workspaceMember, type WorkspaceRole } from "@Kavero/db/schema/workspace";
import { ensurePersonalWorkspace } from "@Kavero/db/personal-workspace";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";

import { quotaFor } from "../platform/quota";
import type { Platform } from "../platform/edition";
import { workspaceRole } from "./access";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const RANK: Record<WorkspaceRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const PERSONAL_WORKSPACE_NAME = "Personal workspace";

function editableName(name: string) {
  const value = name.trim().slice(0, 80);
  if (!value) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a workspace name" });
  if (value.toLowerCase() === PERSONAL_WORKSPACE_NAME.toLowerCase()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `“${PERSONAL_WORKSPACE_NAME}” is reserved for your default workspace` });
  }
  return value;
}

/** Workspaces, members, invitations and roles. */
export class WorkspaceService {
  constructor(
    private readonly db: Database,
    private readonly platform?: Platform,
    private readonly deleteObjects?: (keys: string[]) => Promise<void>,
  ) {}

  private async require(userId: string, workspaceId: string, min: WorkspaceRole) {
    const role = await workspaceRole(this.db, userId, workspaceId);
    if (!role) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
    if (RANK[role] < RANK[min]) throw new TRPCError({ code: "FORBIDDEN", message: `This needs the ${min} role (you're ${role})` });
    return role;
  }

  private async assertNotPersonal(workspaceId: string, action: string) {
    const [personal] = await this.db
      .select({ id: workspace.id })
      .from(workspace)
      .where(and(eq(workspace.id, workspaceId), isNotNull(workspace.personalOwnerId)))
      .limit(1);
    if (personal) throw new TRPCError({ code: "BAD_REQUEST", message: `The Personal workspace is protected and can't be ${action}` });
  }

  async list(userId: string) {
    await ensurePersonalWorkspace(this.db, userId);
    const rows = await this.db
      .select({ id: workspace.id, name: workspace.name, role: workspaceMember.role, createdAt: workspace.createdAt, personalOwnerId: workspace.personalOwnerId })
      .from(workspaceMember)
      .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
      .where(eq(workspaceMember.userId, userId))
      .orderBy(workspace.name);
    return rows
      .map(({ personalOwnerId, ...row }) => ({ ...row, isPersonal: personalOwnerId !== null }))
      .sort((a, b) => Number(b.isPersonal) - Number(a.isPersonal) || a.name.localeCompare(b.name));
  }

  async create(userId: string, name: string) {
    const id = randomUUID();
    const cleanName = editableName(name);
    await this.db.transaction(async (tx) => {
      await tx.insert(workspace).values({ id, name: cleanName, createdBy: userId });
      await tx.insert(workspaceMember).values({ id: randomUUID(), workspaceId: id, userId, role: "owner" });
    });
    return { id };
  }

  async rename(userId: string, workspaceId: string, name: string) {
    await this.require(userId, workspaceId, "admin");
    await this.assertNotPersonal(workspaceId, "renamed");
    await this.db.update(workspace).set({ name: editableName(name) }).where(eq(workspace.id, workspaceId));
    return { ok: true };
  }

  async members(userId: string, workspaceId: string) {
    const role = await this.require(userId, workspaceId, "viewer");
    const [workspaceRow] = await this.db
      .select({ personalOwnerId: workspace.personalOwnerId })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    const members = await this.db
      .select({ userId: workspaceMember.userId, role: workspaceMember.role, name: user.name, email: user.email, joinedAt: workspaceMember.createdAt })
      .from(workspaceMember)
      .innerJoin(user, eq(user.id, workspaceMember.userId))
      .where(eq(workspaceMember.workspaceId, workspaceId))
      .orderBy(user.name);
    const invites = RANK[role] >= RANK.admin
      ? await this.db
          .select({ id: workspaceInvite.id, email: workspaceInvite.email, role: workspaceInvite.role, expiresAt: workspaceInvite.expiresAt, createdAt: workspaceInvite.createdAt })
          .from(workspaceInvite)
          .where(and(eq(workspaceInvite.workspaceId, workspaceId), isNull(workspaceInvite.acceptedAt), gt(workspaceInvite.expiresAt, new Date())))
          .orderBy(desc(workspaceInvite.createdAt))
      : [];
    return { you: role, isPersonal: !!workspaceRow?.personalOwnerId, members, invites };
  }

  /** Create an invitation; returns a one-time token for the link (shown once). */
  async invite(userId: string, workspaceId: string, email: string, role: WorkspaceRole) {
    const mine = await this.require(userId, workspaceId, "admin");
    await this.assertNotPersonal(workspaceId, "shared");
    if (role === "owner" && mine !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "Only owners can invite owners" });
    const normalized = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a valid email address" });
    const token = randomBytes(24).toString("base64url");
    await this.db.insert(workspaceInvite).values({
      id: randomUUID(), workspaceId, email: normalized, role, tokenHash: hash(token), invitedBy: userId,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
    return { token };
  }

  async revokeInvite(userId: string, workspaceId: string, inviteId: string) {
    await this.require(userId, workspaceId, "admin");
    await this.db.delete(workspaceInvite).where(and(eq(workspaceInvite.id, inviteId), eq(workspaceInvite.workspaceId, workspaceId)));
    return { ok: true };
  }

  /** Public details of an invite so the accept page can show what it is. */
  async previewInvite(token: string) {
    const [inv] = await this.db
      .select({ email: workspaceInvite.email, role: workspaceInvite.role, workspaceName: workspace.name, expiresAt: workspaceInvite.expiresAt, acceptedAt: workspaceInvite.acceptedAt })
      .from(workspaceInvite)
      .innerJoin(workspace, eq(workspace.id, workspaceInvite.workspaceId))
      .where(eq(workspaceInvite.tokenHash, hash(token)))
      .limit(1);
    if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) return null;
    return { email: inv.email, role: inv.role, workspaceName: inv.workspaceName };
  }

  /** Accept an invitation. Only the invited email address can accept it. */
  async acceptInvite(userId: string, userEmail: string, token: string) {
    const [inv] = await this.db.select().from(workspaceInvite).where(eq(workspaceInvite.tokenHash, hash(token))).limit(1);
    if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw new TRPCError({ code: "NOT_FOUND", message: "This invitation is invalid or has expired" });
    await this.assertNotPersonal(inv.workspaceId, "shared");
    if (inv.email !== userEmail.trim().toLowerCase()) throw new TRPCError({ code: "FORBIDDEN", message: `This invitation is for ${inv.email}. Sign in with that address to accept it.` });
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: workspaceMember.id, role: workspaceMember.role }).from(workspaceMember).where(and(eq(workspaceMember.workspaceId, inv.workspaceId), eq(workspaceMember.userId, userId))).limit(1);
      if (!existing) await tx.insert(workspaceMember).values({ id: randomUUID(), workspaceId: inv.workspaceId, userId, role: inv.role });
      else if (RANK[inv.role] > RANK[existing.role]) await tx.update(workspaceMember).set({ role: inv.role }).where(eq(workspaceMember.id, existing.id));
      await tx.update(workspaceInvite).set({ acceptedAt: new Date() }).where(eq(workspaceInvite.id, inv.id));
    });
    return { workspaceId: inv.workspaceId };
  }

  private async ownerCount(workspaceId: string) {
    const [r] = await this.db.select({ n: count() }).from(workspaceMember).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.role, "owner")));
    return r?.n ?? 0;
  }

  async setRole(userId: string, workspaceId: string, memberId: string, role: WorkspaceRole) {
    if (!WORKSPACE_ROLES.includes(role)) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown role" });
    const mine = await this.require(userId, workspaceId, "admin");
    await this.assertNotPersonal(workspaceId, "shared");
    const theirs = await workspaceRole(this.db, memberId, workspaceId);
    if (!theirs) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
    if ((role === "owner" || theirs === "owner") && mine !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "Only owners can change owners" });
    if (theirs === "owner" && role !== "owner" && (await this.ownerCount(workspaceId)) <= 1) throw new TRPCError({ code: "BAD_REQUEST", message: "A workspace needs at least one owner" });
    await this.db.update(workspaceMember).set({ role }).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, memberId)));
    return { ok: true };
  }

  /** Remove a member (admins), or leave (anyone, for themselves). */
  async removeMember(userId: string, workspaceId: string, memberId: string) {
    const mine = await this.require(userId, workspaceId, memberId === userId ? "viewer" : "admin");
    await this.assertNotPersonal(workspaceId, memberId === userId ? "left" : "modified");
    const theirs = await workspaceRole(this.db, memberId, workspaceId);
    if (!theirs) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
    if (theirs === "owner" && memberId !== userId && mine !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "Only owners can remove owners" });
    if (theirs === "owner" && (await this.ownerCount(workspaceId)) <= 1) throw new TRPCError({ code: "BAD_REQUEST", message: "Make someone else an owner first" });
    await this.db.delete(workspaceMember).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, memberId)));
    return { ok: true };
  }

  /** Delete a workspace. Its catalogs go back to their creators' Personal workspaces. */
  async remove(userId: string, workspaceId: string) {
    await this.require(userId, workspaceId, "owner");
    await this.assertNotPersonal(workspaceId, "deleted");
    const owners = await this.db
      .selectDistinct({ userId: catalog.ownerId })
      .from(catalog)
      .where(eq(catalog.workspaceId, workspaceId));
    const personalWorkspaces = await Promise.all(owners.map(({ userId: ownerId }) => ensurePersonalWorkspace(this.db, ownerId)));
    const personalByOwner = new Map(owners.map(({ userId: ownerId }, index) => [ownerId, personalWorkspaces[index]!.id]));
    const keysToDelete = await this.db.transaction(async (tx) => {
      // Asset, publish and transfer paths lock workspace rows before catalog
      // rows. Use the same order, with stable ids, while returning catalogs to
      // their owners' Personal workspaces.
      const workspaceIds = [...new Set([workspaceId, ...personalByOwner.values()])].sort();
      for (const id of workspaceIds) {
        const [locked] = await tx.select({ id: workspace.id, personalOwnerId: workspace.personalOwnerId })
          .from(workspace).where(eq(workspace.id, id)).for("update");
        if (!locked) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
        if (id === workspaceId && locked.personalOwnerId) throw new TRPCError({ code: "BAD_REQUEST", message: "The Personal workspace is protected and can't be deleted" });
      }

      const [activeUpload] = await tx.select({ id: catalogUpload.id }).from(catalogUpload)
        .where(and(eq(catalogUpload.workspaceId, workspaceId), gt(catalogUpload.expiresAt, new Date()))).limit(1);
      if (activeUpload) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A signed asset upload is still active. Wait a few minutes for its upload link to expire, then delete this workspace." });

      const transactionalDb = tx as unknown as Database;
      if (await workspaceRole(transactionalDb, userId, workspaceId) !== "owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners can delete a workspace" });
      }
      const catalogs = await tx.select({ id: catalog.id, ownerId: catalog.ownerId })
        .from(catalog).where(eq(catalog.workspaceId, workspaceId)).orderBy(catalog.id).for("update");
      for (const item of catalogs) {
        const targetWorkspaceId = personalByOwner.get(item.ownerId);
        if (!targetWorkspaceId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "A catalog owner has no Personal workspace" });
        await quotaFor({ db: transactionalDb, platform: this.platform }).assertCanMoveCatalog(userId, item.id, targetWorkspaceId);
        await tx.update(catalog).set({ workspaceId: targetWorkspaceId, ownerId: item.ownerId }).where(eq(catalog.id, item.id));
      }

      const [uploads, jobs] = await Promise.all([
        tx.select({ key: catalogUpload.storageKey }).from(catalogUpload).where(eq(catalogUpload.workspaceId, workspaceId)),
        tx.select({ storageKey: mediaJob.storageKey, posterStorageKey: mediaJob.posterStorageKey, gifStorageKey: mediaJob.gifStorageKey })
          .from(mediaJob).where(eq(mediaJob.workspaceId, workspaceId)),
      ]);
      await tx.delete(workspace).where(eq(workspace.id, workspaceId));
      return [...uploads.map(({ key }) => key), ...jobs.flatMap((job) => [job.storageKey, job.posterStorageKey, job.gifStorageKey])]
        .filter((key): key is string => !!key);
    });
    if (keysToDelete.length && this.deleteObjects) await this.deleteObjects(keysToDelete).catch(() => undefined);
    return { ok: true };
  }
}
