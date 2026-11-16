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
