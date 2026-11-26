import { expect, test } from "@playwright/test";
import { connectFixture, createAndSubscribe, mockIndexer } from "./helpers";

test("subscription manager filters, searches, and reflects cancellation", async ({
  page,
}) => {
  await mockIndexer(page);
  await connectFixture(page);
  await createAndSubscribe(page);
  await page.getByRole("button", { name: "Subscriptions" }).click();

  await expect(page.getByText(/Subscription #1 · plan #1/).first()).toBeVisible();
  await expect(page.getByText(/1 on-chain subscription/)).toBeVisible();

  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(page.getByText(/Subscription #1 · plan #1/).first()).toBeVisible();

  await page.getByLabel("Search subscriptions").fill("does-not-match");
  await expect(page.getByText("No matching subscriptions")).toBeVisible();
  await page.getByLabel("Search subscriptions").fill("");

  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "Cancel & refund" }).click();
  await expect(page.getByText(/Subscription #1 cancelled/)).toBeVisible();

  await page.getByRole("button", { name: "Cancelled", exact: true }).click();
  await expect(page.getByText(/Subscription #1 · plan #1/).first()).toBeVisible();
  await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
});
