import { expect, type Page } from "@playwright/test";
import type { MetricsResponse } from "@substream/sdk";

export const E2E_ADDRESS =
  "GBZZVBFJTX23YRYGYID6P4YHESDHYZFWKOBPMQSFKHLBHJZMHTXDIFPB";
export const E2E_TOKEN =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const tokenAmount = { token: E2E_TOKEN, amount: "40000000" };
const refundAmount = { token: E2E_TOKEN, amount: "10000000" };

export const networkMetrics: MetricsResponse = {
  network: {
    plansCreated: 2,
    planUpdates: 1,
    subscriptions: 5,
    topUps: 1,
    charges: 4,
    failedCharges: 1,
    cancellations: 2,
    charged: [tokenAmount],
    refunded: [refundAmount],
  },
  merchant: {
    merchant: E2E_ADDRESS,
    subscriptions: 3,
    topUps: 1,
    charges: 4,
    failedCharges: 1,
    cancellations: 2,
    charged: [tokenAmount],
    refunded: [refundAmount],
    plans: [
      {
        planId: "1",
        subscriptions: 3,
        topUps: 1,
        charges: 4,
        failedCharges: 1,
        cancellations: 2,
        charged: [tokenAmount],
        refunded: [refundAmount],
      },
    ],
  },
  indexedEvents: 12,
  lastLedger: 5_936_155,
  firstIndexedLedger: 5_936_100,
};

function jsonHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  };
}

export async function mockIndexer(
  page: Page,
  options: { metrics?: boolean } = {},
): Promise<void> {
  await page.route("https://indexer.e2e.local/events*", (route) =>
    route.fulfill({
      status: 200,
      headers: jsonHeaders(),
      body: JSON.stringify({ events: [] }),
    }),
  );

  await page.route("https://indexer.e2e.local/metrics*", (route) => {
    if (options.metrics === false) return route.abort();
    const includeMerchant = new URL(route.request().url()).searchParams.has(
      "merchant",
    );
    const payload = includeMerchant
      ? networkMetrics
      : { ...networkMetrics, merchant: undefined };
    return route.fulfill({
      status: 200,
      headers: jsonHeaders(),
      body: JSON.stringify(payload),
    });
  });
}

export async function connectFixture(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Connect Freighter" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Connect Freighter" }).first().click();
  await expect(page.getByRole("heading", { name: "Guided demo" })).toBeVisible();
}

export async function createAndSubscribe(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Create demo plan" }).click();
  await expect(page.getByRole("button", { name: "Subscribe now" })).toBeVisible();
  await page.getByRole("button", { name: "Subscribe now" }).click();
  await expect(page.getByRole("button", { name: "Open subscription manager" })).toBeVisible();
}
