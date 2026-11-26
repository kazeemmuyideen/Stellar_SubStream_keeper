import { expect, test } from "@playwright/test";
import { connectFixture, createAndSubscribe, mockIndexer } from "./helpers";

test("guided demo completes create, subscribe, charge, and cancel", async ({
  page,
}) => {
  await mockIndexer(page);
  await connectFixture(page);
  await createAndSubscribe(page);

  await page.getByRole("button", { name: "Open subscription manager" }).click();
  await expect(page.getByText(/Subscription #1 · plan #1/).first()).toBeVisible();

  await page.getByRole("button", { name: "Guided demo", exact: true }).click();
  const charge = page.getByRole("button", { name: "Charge now" });
  await expect(charge).toBeEnabled({ timeout: 15_000 });
  await charge.click();
  await expect(page.getByText(/Subscription #1: Charged/)).toBeVisible();

  await page.getByRole("button", { name: "Subscriptions" }).click();
  await page.getByRole("button", { name: "Cancel & refund" }).click();
  await expect(page.getByText(/Subscription #1 cancelled/)).toBeVisible();

  await page.getByRole("button", { name: "Guided demo", exact: true }).click();
  await expect(
    page.getByText("Close the subscription and watch unused escrow return.").first(),
  ).toBeVisible();
});
