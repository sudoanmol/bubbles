import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      // Tests that use D1 apply these first (`applyD1Migrations`).
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(`${import.meta.dirname}/drizzle`),
          // Tests run like local dev, which skips rate limits.
          BETTER_AUTH_URL: 'http://localhost:3100',
        },
      },
    })),
  ],
})
