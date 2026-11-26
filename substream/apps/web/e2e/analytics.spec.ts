import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { connectFixture, mockIndexer } from "./helpers";

test("public metrics render charts and export a safe CSV", async ({ page }) => {
  await mockIndexer(page);
  await connectFixture(page);
  await page.getByRole("button", { name: "Public metrics" }).click();

  await expect(
    page.getByRole("heading", { name: "SubStream activity across all plans" }),
  ).toBeVisible();
  await expect(page.getByText("Charge success rate")).toBeVisible();
  await expect(page.getByText("80.00%").first()).toBeVisible();
  await expect(page.getByText("Charges by plan")).toHaveCount(0);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^substream-network-metrics-\d{4}-\d{2}-\d{2}\.csv$/,
  );
  const path = await download.path();
  expect(path).not.toBeNull();
  const csv = readFileSync(path!, "utf8");
  expect(csv).toContain('"network","counters","charges","4"');
  expect(csv).toContain('"network","context","lastLedger","5936155"');
});

test("dApp degrades gracefully when the indexer is offline", async ({
  page,
}) => {
  await mockIndexer(page, { metrics: false });
  await connectFixture(page);
  await page.getByRole("button", { name: "Public metrics" }).click();

  await expect(
    page.getByRole("heading", { name: "Public indexer offline" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Contract reads and wallet actions continue to work from RPC/),
  ).toBeVisible();
});
