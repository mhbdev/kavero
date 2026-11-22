import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import type { Database } from "@Kavero/db";
import { ensurePersonalWorkspace } from "@Kavero/db/personal-workspace";
import * as schema from "@Kavero/db/schema/auth";
import { appSetting } from "@Kavero/db/schema/integration";
import { workspaceInvite } from "@Kavero/db/schema/workspace";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { createBetterAuthRateLimitStorage, createBetterAuthSecondaryStorage } from "@Kavero/redis";

export type AuthConfig = {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  REDIS_URL?: string;
  KAVERO_EDITION?: string;
  KAVERO_BOOTSTRAP_ADMIN_EMAIL?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
};

async function sendTransactionalEmail(env: AuthConfig, input: { to: string; subject: string; text: string }) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error("Transactional email is not configured (RESEND_API_KEY and EMAIL_FROM are required).");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [input.to], subject: input.subject, text: input.text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Transactional email provider returned HTTP ${response.status}.`);
}

/** Who may create an account (Admin → Settings). */
export type SignupPolicy = "open" | "invite-only" | "closed";
export const SIGNUP_POLICY_KEY = "signup_policy";

export async function getSignupPolicy(database: Database, defaultPolicy: SignupPolicy = "open"): Promise<SignupPolicy> {
  const [row] = await database.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, SIGNUP_POLICY_KEY)).limit(1);
  const v = row?.value;
  return v === "open" || v === "invite-only" || v === "closed" ? v : defaultPolicy;
}

export function createAuth(env: AuthConfig, database: Database) {
  const strictRedis = env.KAVERO_EDITION?.trim().toLowerCase() === "cloud";
  const fallbackMode = strictRedis ? "error" : "local";
  const secondaryStorage = createBetterAuthSecondaryStorage("better-auth", env.REDIS_URL, fallbackMode);
  return betterAuth({
    database: drizzleAdapter(database, {
      provider: "pg",
      schema,
    }),
    trustedOrigins: [env.BETTER_AUTH_URL],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: strictRedis,
      sendResetPassword: async ({ user, url }) => sendTransactionalEmail(env, {
        to: user.email,
        subject: "Reset your Kavero password",
        text: `Use this link to reset your Kavero password. It expires shortly.\n\n${url}\n\nIf you didn't request this, you can ignore this email.`,
      }),
    },
    emailVerification: {
      sendOnSignUp: strictRedis,
      sendOnSignIn: strictRedis,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => sendTransactionalEmail(env, {
        to: user.email,
        subject: "Verify your Kavero email address",
        text: `Use this link to verify your Kavero email address.\n\n${url}\n\nIf you didn't create this account, you can ignore this email.`,
      }),
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    secondaryStorage,
    session: { storeSessionInDatabase: true },
    verification: { storeInDatabase: true },
    rateLimit: {
      enabled: true,
      timeWindow: 60_000,
      maxRequests: 120,
      customStorage: createBetterAuthRateLimitStorage("better-auth", env.REDIS_URL, fallbackMode),
    },
    databaseHooks: {
      user: {
        create: {
          // Only an explicitly configured operator email can receive the initial admin role.
          before: async (user) => {
            const bootstrapEmail = env.KAVERO_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
            if (bootstrapEmail && user.email.trim().toLowerCase() === bootstrapEmail) {
              const [{ n } = { n: 0 }] = await database.select({ n: count() }).from(schema.user).where(eq(schema.user.role, "admin"));
              if (n === 0) return { data: { ...user, role: "admin" } };
            }
            const policy = await getSignupPolicy(database, strictRedis ? "closed" : "open");
            if (policy === "closed") {
              throw new APIError("FORBIDDEN", { message: "Sign-ups are closed on this server. Ask an admin for an account." });
            }
            if (policy === "invite-only") {
              const [invite] = await database
                .select({ id: workspaceInvite.id })
                .from(workspaceInvite)
                .where(and(sql`lower(${workspaceInvite.email}) = lower(${user.email})`, isNull(workspaceInvite.acceptedAt), gt(workspaceInvite.expiresAt, new Date())))
                .limit(1);
              if (!invite) throw new APIError("FORBIDDEN", { message: "This server is invite-only. Ask a workspace admin to invite this email address." });
            }
            return { data: { ...user, role: "user" } };
          },
          after: async (user) => {
            await ensurePersonalWorkspace(database, user.id);
          },
        },
      },
    },
    plugins: [
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
        bannedUserMessage: "This account has been suspended. Contact the server admin.",
      }),
      apiKey({
        defaultPrefix: "kv_",
        disableKeyHashing: false,
        requireName: true,
        maximumNameLength: 80,
        references: "user",
        keyExpiration: {
          defaultExpiresIn: 90 * 24 * 60 * 60 * 1000,
          minExpiresIn: 1,
          maxExpiresIn: 365,
        },
        // Off here (this also covers keys created earlier, which store their own limit):
        // /api/mcp applies its own per-key limit from Admin → System → MCP (agents).
        rateLimit: { enabled: false, timeWindow: 60_000, maxRequests: 600 },
        permissions: { defaultPermissions: { catalogs: ["read"] } },
      }),
      // Must stay last so cookies set by earlier plugins reach Next.js.
      nextCookies(),
    ],
  });
}

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];
export type Auth = ReturnType<typeof createAuth>;
