import { SubscriptionStatus, type Subscription } from "@substream/sdk";

export type SubscriptionFilter = "all" | "active" | "past-due" | "cancelled";

export type DemoStage =
  | "connect"
  | "create-plan"
  | "subscribe"
  | "charge"
  | "wait"
  | "complete";

export function isDue(subscription: Subscription, now: bigint): boolean {
  return (
    subscription.status !== SubscriptionStatus.Cancelled &&
    subscription.nextCharge <= now
  );
}

export function filterSubscriptions(
  subscriptions: Subscription[],
  filter: SubscriptionFilter,
  query: string,
): Subscription[] {
  const needle = query.trim().toLowerCase();
  return subscriptions.filter((subscription) => {
    const matchesFilter =
      filter === "all" ||
      (filter === "active" &&
        subscription.status === SubscriptionStatus.Active) ||
      (filter === "past-due" &&
        subscription.status === SubscriptionStatus.PastDue) ||
      (filter === "cancelled" &&
        subscription.status === SubscriptionStatus.Cancelled);
    if (!matchesFilter) return false;
    if (!needle) return true;

    return [
      subscription.id.toString(),
      subscription.planId.toString(),
      subscription.subscriber,
      subscription.token,
    ].some((value) => value.toLowerCase().includes(needle));
  });
}

export interface DemoState {
  connected: boolean;
  hasPlan: boolean;
  hasSubscription: boolean;
  hasDueSubscription: boolean;
  hasCancelledSubscription: boolean;
}

export function demoStage(state: DemoState): DemoStage {
  if (!state.connected) return "connect";
  if (!state.hasPlan) return "create-plan";
  if (!state.hasSubscription) return "subscribe";
  if (state.hasCancelledSubscription) return "complete";
  return state.hasDueSubscription ? "charge" : "wait";
}
