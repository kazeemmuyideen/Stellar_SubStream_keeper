import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port 4173`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_CONTRACT_ID:
        "CBLX5BM4OUDH47QBBAJLCRF5YSBTEWBVDQISJL2LQQGA3CPWKMQOYVMS",
      VITE_RPC_URL: "https://soroban-testnet.stellar.org",
      VITE_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      VITE_TOKEN_ADDRESS:
        "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      VITE_INDEXER_URL: "https://indexer.e2e.local",
      VITE_MAX_FEE: "20000000",
      VITE_E2E_FIXTURES: "1",
    },
  },
});
