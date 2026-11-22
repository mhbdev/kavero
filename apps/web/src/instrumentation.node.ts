/**
 * Runs once when the Node server starts, before it handles requests.
 * The desktop app sets KAVERO_AUTO_MIGRATE so its database (embedded PGlite or
 * configured Postgres) is current. Web deployments run migrations separately.
 */
export async function register() {
  await migrate();
  // Admin settings (Admin → System) are loaded once here and then refreshed as they're used.
  const { initPlatform } = await import("./platform");
  await initPlatform();
}

async function migrate() {
  if (process.env.KAVERO_AUTO_MIGRATE !== "1") return;
  const folder = process.env.KAVERO_MIGRATIONS_DIR;
  if (!folder) throw new Error("KAVERO_AUTO_MIGRATE needs KAVERO_MIGRATIONS_DIR");
  const { runMigrations } = await import("@Kavero/db");
  const { db } = await import("./services");
  const started = Date.now();
  await runMigrations(db, process.env.DATABASE_URL ?? "", folder);
  console.log(`[kavero] database ready (${Date.now() - started} ms)`);
}
