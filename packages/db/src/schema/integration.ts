import { defineRelationsPart, sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./auth";
import { workspace } from "./workspace";

export type ModelCapabilities = {
  inputModalities: ("text" | "image" | "audio" | "video" | "file")[] | null;
  outputModalities: ("text" | "image" | "audio" | "video")[] | null;
  toolCalling: boolean | null;
  structuredOutput: boolean | null;
  maxInputTokens: number | null;
  source: "provider" | "curated" | "unknown";
  /** Exact ratios reported by a provider's media model catalog. */
  aspectRatios?: string[];
};

export const AUDIT_AREAS = ["catalogs", "assets", "exports", "publication", "workspace", "ai", "api_keys", "integrations", "admin", "auth", "account"] as const;
export type AuditArea = (typeof AUDIT_AREAS)[number];
export const AUDIT_CHANNELS = ["web", "mcp", "admin", "system"] as const;
export type AuditChannel = (typeof AUDIT_CHANNELS)[number];

/** Security and activity record for API/MCP actions. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    apiKeyId: text("api_key_id"),
    area: text("area").$type<AuditArea>().notNull().default("account"),
    channel: text("channel").$type<AuditChannel>().notNull().default("web"),
    action: text("action").notNull(),
    target: text("target"),
    outcome: text("outcome", { enum: ["ok", "denied", "error"] }).notNull(),
    details: jsonb("details"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("audit_log_user_created_idx").on(t.userId, t.createdAt),
    index("audit_log_area_created_idx").on(t.area, t.createdAt),
    index("audit_log_action_created_idx").on(t.action, t.createdAt),
  ],
);

/** External MCP servers a user connected (e.g. a store's product server). */
export const mcpConnection = pgTable(
  "mcp_connection",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    transport: text("transport", { enum: ["streamable-http", "sse"] }).notNull().default("streamable-http"),
    url: text("url").notNull(),
    authType: text("auth_type", { enum: ["none", "bearer", "header"] }).notNull().default("none"),
    /** Header name for authType "header". */
    authHeader: text("auth_header"),
    /** AES-256-GCM encrypted secret (never returned to clients). */
    encryptedSecret: text("encrypted_secret"),
    status: text("status", { enum: ["unknown", "ok", "error"] }).notNull().default("unknown"),
    lastError: text("last_error"),
    /** Tools and resources the server advertised at the last check. */
    capabilities: jsonb("capabilities"),
    lastCheckedAt: timestamp("last_checked_at"),
    lastSyncAt: timestamp("last_sync_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("mcp_connection_user_idx").on(t.userId)],
);

export const integrationRelations = defineRelationsPart({ user, mcpConnection }, (r) => ({
  mcpConnection: { user: r.one.user({ from: r.mcpConnection.userId, to: r.user.id }) },
}));

/** AI generation and edit requests (history, cost tracking, debugging). */
export const aiJob = pgTable(
  "ai_job",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["generate", "edit"] }).notNull(),
    prompt: text("prompt").notNull(),
    status: text("status", { enum: ["ok", "error"] }).notNull(),
    source: text("source"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    summary: text("summary"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("ai_job_user_created_idx").on(t.userId, t.createdAt)],
);

/** Durable image/video work. Queue messages contain only this row's id; keys stay encrypted in ai_credential. */
export const mediaJob = pgTable(
  "media_job",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull().references(() => workspace.id, { onDelete: "cascade" }),
    purpose: text("purpose", { enum: ["image", "video"] }).notNull(),
    prompt: text("prompt").notNull(),
    aspectRatio: text("aspect_ratio").notNull(),
    provider: text("provider", { enum: ["anthropic", "openrouter", "openai", "openai-compatible", "google", "ai-gateway"] }).notNull(),
    model: text("model").notNull(),
    status: text("status", { enum: ["queued", "generating", "done", "error"] }).notNull().default("queued"),
    storageKey: text("storage_key"),
    posterStorageKey: text("poster_storage_key"),
    gifStorageKey: text("gif_storage_key"),
    mimeType: text("mime_type"),
    bytes: integer("bytes"),
    /** Actual persisted bytes, or a bounded reservation while queued/generating. */
    storageBytes: integer("storage_bytes").notNull().default(0),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    startedAt: timestamp("started_at"),
    leaseUntil: timestamp("lease_until"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => [
    index("media_job_user_created_idx").on(t.userId, t.createdAt),
    index("media_job_workspace_status_idx").on(t.workspaceId, t.status),
    index("media_job_expiry_idx").on(t.expiresAt),
    check("media_job_purpose_check", sql`${t.purpose} in ('image', 'video')`),
    check("media_job_status_check", sql`${t.status} in ('queued', 'generating', 'done', 'error')`),
    check("media_job_provider_check", sql`${t.provider} in ('anthropic', 'openrouter', 'openai', 'openai-compatible', 'google', 'ai-gateway')`),
    check("media_job_bytes_check", sql`${t.bytes} is null or ${t.bytes} between 0 and 26214400`),
    check("media_job_storage_bytes_check", sql`${t.storageBytes} between 0 and 78643200`),
    check("media_job_attempts_check", sql`${t.attempts} between 0 and 3`),
  ],
);

/** A user's encrypted provider connection. Model choices live in aiModelAssignment. */
export const aiCredential = pgTable(
  "ai_credential",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["anthropic", "openrouter", "openai", "openai-compatible", "google", "ai-gateway"] }).notNull(),
    baseUrl: text("base_url"),
    encryptedKey: text("encrypted_key"),
    keyHint: text("key_hint"),
    updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.provider] })],
);

/** One provider/model selection per user and generation concern. */
export const aiModelAssignment = pgTable(
  "ai_model_assignment",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    purpose: text("purpose", { enum: ["text", "image", "video"] }).notNull(),
    provider: text("provider", { enum: ["anthropic", "openrouter", "openai", "openai-compatible", "google", "ai-gateway"] }).notNull(),
    model: text("model").notNull(),
    modelCapabilities: jsonb("model_capabilities").$type<ModelCapabilities>().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.purpose] }),
    index("ai_model_assignment_provider_idx").on(t.userId, t.provider),
    foreignKey({ name: "ai_model_assignment_provider_fk", columns: [t.userId, t.provider], foreignColumns: [aiCredential.userId, aiCredential.provider] }).onDelete("cascade"),
  ],
);

/** Server-wide settings managed by admins (Admin → Settings). One row per key. */
export const appSetting = pgTable("app_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});
