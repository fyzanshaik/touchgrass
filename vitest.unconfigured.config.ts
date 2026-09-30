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
          GATEWAY_PRECEDENCE_BASE: "",
          GATEWAY_DOH_ENDPOINT: "",
          CLOUDFLARE_ACCOUNT_ID: "",
          CLOUDFLARE_API_TOKEN: "",
          ACCESS_TEAM_DOMAIN: "",
          ACCESS_AUD: "",
          OWNER_EMAIL: "",
          LOCAL_AUTH_ENABLED: "false",
          LOCAL_AUTH_EMAIL: "",
        },
      },
    }),
  ],
  test: {
    include: ["tests/worker-unconfigured/**/*.test.ts"],
  },
});
