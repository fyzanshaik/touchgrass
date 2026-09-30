import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.json" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "local",
          GATEWAY_MODE: "simulated",
          GATEWAY_PRECEDENCE_BASE: "1000",
          GATEWAY_DOH_ENDPOINT: "https://local.cloudflare-gateway.com/dns-query",
          ACCESS_TEAM_DOMAIN: "",
          ACCESS_AUD: "",
          OWNER_EMAIL: "owner@example.com",
          LOCAL_AUTH_ENABLED: "true",
          LOCAL_AUTH_EMAIL: "owner@example.com",
          CLOUDFLARE_ACCOUNT_ID: "",
          CLOUDFLARE_API_TOKEN: "",
        },
      },
    }),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts"],
  },
});
