/**
 * Next loads instrumentation in Node and Edge builds. Keep the Edge entry free
 * of database, Redis and filesystem dependencies; those belong to Node only.
 */
export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    return require("./instrumentation.node").register();
  }
}
