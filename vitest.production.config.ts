import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.json" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "production",
          GATEWAY_MODE: "live",
          GATEWAY_PRECEDENCE_BASE: "1000",
          GATEWAY_DOH_ENDPOINT: "https://clearbrowse-test.cloudflare-gateway.com/dns-query",
          CLOUDFLARE_ACCOUNT_ID: "account-id",
          CLOUDFLARE_API_TOKEN: "test-token-value",
          ACCESS_TEAM_DOMAIN: "https://clearbrowse-test.cloudflareaccess.com",
          ACCESS_AUD: "test-audience-tag",
          OWNER_EMAIL: "owner@example.com",
          LOCAL_AUTH_ENABLED: "false",
          LOCAL_AUTH_EMAIL: "",
        },
      },
    }),
  ],
  test: {
    include: ["tests/worker-production/**/*.test.ts"],
  },
});
