declare namespace Cloudflare {
  interface Env {
    /** backend/drizzle, read in vitest.config.ts; tests that use D1 apply it first. */
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
  }
}
