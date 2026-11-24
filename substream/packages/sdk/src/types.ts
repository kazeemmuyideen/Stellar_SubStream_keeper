export const SubscriptionStatus = {
  Active: 0,
  PastDue: 1,
  Cancelled: 2,
} as const;

export type SubscriptionStatusValue =
  (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export const ChargeOutcome = {
  Charged: 0,
  NotDue: 1,
  InsufficientBalance: 2,
  Cancelled: 3,
  PlanInactive: 4,
} as const;

export type ChargeOutcomeValue =
  (typeof ChargeOutcome)[keyof typeof ChargeOutcome];

/** Topics emitted by the contract's `#[contractevent]` declarations. */
export const EventKind = {
  PlanCreated: "plan_new",
  PlanUpdated: "plan_upd",
  Subscribed: "subscribe",
  ToppedUp: "topped_up",
  Charged: "charged",
  PaymentFailed: "pay_fail",
  Cancelled: "cancelled",
} as const;

export type EventKindValue = (typeof EventKind)[keyof typeof EventKind];

/** A decoded contract event as served by the indexer's HTTP API. */
export interface IndexedEvent {
  /** RPC event id; unique across the network. */
  id: string;
  kind: EventKindValue;
  subscriptionId: string | null;
  planId: string | null;
  subscriber: string | null;
  /** Base-unit amounts are strings so they survive JSON serialization. */
  amount: string | null;
  balance: string | null;
  nextCharge: string | null;
  reason: number | null;
  txHash: string;
  ledger: number;
  /** Unix seconds from the ledger close time. */
  timestamp: number;
}

export interface Plan {
  /** Client-side identifier (the contract stores plans by id). */
  id: bigint;
  merchant: string;
  token: string;
  amount: bigint;
  interval: bigint;
  gracePeriod: bigint;
  active: boolean;
  createdAt: bigint;
}

export interface Subscription {
  /** Client-side identifier (the contract stores subscriptions by id). */
  id: bigint;
  planId: bigint;
  /** Snapshotted token so refunds do not depend on the plan record. */
  token: string;
  subscriber: string;
  amount: bigint;
  interval: bigint;
  gracePeriod: bigint;
  balance: bigint;
  nextCharge: bigint;
  status: number;
  cyclesPaid: number;
  startedAt: bigint;
  lastChargedAt: bigint;
}

export function statusLabel(status: number): string {
  switch (status) {
    case SubscriptionStatus.Active:
      return "Active";
    case SubscriptionStatus.PastDue:
      return "Past due";
    case SubscriptionStatus.Cancelled:
      return "Cancelled";
    default:
      return "Unknown";
  }
}

export function outcomeLabel(outcome: number): string {
  switch (outcome) {
    case ChargeOutcome.Charged:
      return "Charged";
    case ChargeOutcome.NotDue:
      return "Not due";
    case ChargeOutcome.InsufficientBalance:
      return "Insufficient escrow";
    case ChargeOutcome.Cancelled:
      return "Cancelled";
    case ChargeOutcome.PlanInactive:
      return "Plan inactive";
    default:
      return "Unknown";
  }
}
