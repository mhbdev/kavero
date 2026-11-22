import type { LlmProvider } from "@Kavero/ai";
import {
  Platform,
  RuntimeConfig,
  cloudPlansModule,
  databaseSettingsStore,
  detectEdition,
  providerFromSettings,
} from "@Kavero/api/platform/index";
import { SecretBox } from "@Kavero/api/services/secret-box";

import { ENV } from "./env.server";
import { db } from "./services";

/**
 * Server-side platform singletons shared by tRPC, route handlers and MCP:
 * the edition, admin-managed runtime settings, and the credential SecretBox.
 * Kept on globalThis so dev hot reloads don't create duplicates.
 */
type Singletons = { platform: Platform; runtimeConfig: RuntimeConfig; secretBox: SecretBox };
const g = globalThis as unknown as { __kaveroPlatform?: Singletons };

function create(): Singletons {
  const secretBox = new SecretBox(ENV.BETTER_AUTH_SECRET, process.env.KAVERO_ENCRYPTION_KEY);
  const edition = detectEdition();
  const runtimeConfig = new RuntimeConfig(databaseSettingsStore(db), secretBox, edition);
  const platform = new Platform(edition);
  // Edition modules: each only registers in the editions it lists.
  platform.use(cloudPlansModule(runtimeConfig));
  // Settings that live in long-lived objects are pushed to them when they change (here or on another instance).
  runtimeConfig.onChange((sections) => {
    if (sections.includes("exports")) void applyExportSettings(runtimeConfig);
  });
  return { platform, runtimeConfig, secretBox };
}

const singletons = (g.__kaveroPlatform ??= create());
export const { platform, runtimeConfig, secretBox } = singletons;

let ai: { signature: string; provider: LlmProvider | null } | null = null;

/** The server-wide AI model from Admin → System (or AI_* environment variables); null = built-in planner only. */
export async function serverAiProvider(): Promise<LlmProvider | null> {
  // Cloud is BYOK-only until provider-funded plans and spend controls ship.
  if (platform.edition === "cloud") return null;
  const values = await runtimeConfig.values("ai");
  const signature = JSON.stringify(values);
  if (ai?.signature !== signature) ai = { signature, provider: providerFromSettings(values) };
  return ai.provider;
}

/** Whether server-side requests may reach localhost/LAN addresses (MCP servers, local models, imports). */
export async function allowPrivateUrls(): Promise<boolean> {
  return (await runtimeConfig.values("network")).allowPrivateUrls === true;
}

async function applyExportSettings(config: RuntimeConfig) {
  const n = (await config.values("exports")).maxBrowsers;
  if (typeof n !== "number") return;
  const { setMaxBrowsers } = await import("@Kavero/export-chromium");
  setMaxBrowsers(n);
}

/** Loads admin settings at startup and applies the ones that configure long-lived objects. */
export async function initPlatform(options: { runtime?: "web" | "worker" } = {}) {
  if (platform.edition === "cloud") {
    const missing: string[] = [];
    if (!ENV.REDIS_URL) missing.push("REDIS_URL (shared rate limits and auth state)");
    if (!process.env.KAVERO_ENCRYPTION_KEY || process.env.KAVERO_ENCRYPTION_KEY.length < 32) missing.push("KAVERO_ENCRYPTION_KEY (at least 32 characters)");
    const storage = await runtimeConfig.values("storage");
    if (storage.driver !== "s3" || typeof storage.bucket !== "string" || !storage.bucket) missing.push("S3 storage (STORAGE_DRIVER=s3 and S3_BUCKET)");
    if ((options.runtime ?? "web") === "web") {
      if (!process.env.KAVERO_BOOTSTRAP_ADMIN_EMAIL) missing.push("KAVERO_BOOTSTRAP_ADMIN_EMAIL (initial operator account)");
      if (!process.env.RESEND_API_KEY) missing.push("RESEND_API_KEY (transactional email)");
      if (!process.env.EMAIL_FROM) missing.push("EMAIL_FROM (verified sender address)");
    }
    if (missing.length) throw new Error(`[kavero] Cloud deployment is missing required configuration: ${missing.join(", ")}`);
  }
  await runtimeConfig.refresh(true);
  await applyExportSettings(runtimeConfig);
  const box = secretBox.keyId.startsWith("v1") ? " (set KAVERO_ENCRYPTION_KEY to encrypt credentials with a dedicated key)" : "";
  console.log(`[kavero] ${platform.edition} edition${platform.moduleIds.length ? ` with ${platform.moduleIds.join(", ")}` : ""}${box}`);
}
