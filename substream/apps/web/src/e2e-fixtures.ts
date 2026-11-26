import {
  ChargeOutcome,
  SubscriptionStatus,
  type CancelParams,
  type ChargeParams,
  type CreatePlanParams,
  type Plan,
  type SubscribeParams,
  type Subscription,
  type TopUpParams,
  type UpdatePlanParams,
} from "@substream/sdk";

/**
 * Deterministic in-memory client used only by Playwright in Vite dev mode.
 * `VITE_E2E_FIXTURES=1` is required, so production builds never use it.
 */
export const E2E_ADDRESS =
  "GBZZVBFJTX23YRYGYID6P4YHESDHYZFWKOBPMQSFKHLBHJZMHTXDIFPB";
export const E2E_TOKEN =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function clonePlan(plan: Plan): Plan {
  return { ...plan };
}

function cloneSubscription(subscription: Subscription): Subscription {
  return { ...subscription };
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1_000));
}

export class E2EClient {
  private plans: Plan[] = [];
  private subscriptions: Subscription[] = [];
  private planCounter = 0;
  private subscriptionCounter = 0;
  private txCounter = 0;

  private hash(kind: string): string {
    this.txCounter += 1;
    return `e2e-${this.txCounter.toString().padStart(4, "0")}-${kind}`;
  }

  private findSubscription(id: bigint): Subscription {
    const found = this.subscriptions.find((item) => item.id === id);
    if (!found) throw new Error(`E2E subscription ${id} not found`);
    return found;
  }

  async createPlan(params: CreatePlanParams): Promise<{
    hash: string;
    planId: bigint;
  }> {
    this.planCounter += 1;
    const id = BigInt(this.planCounter);
    this.plans.push({
      id,
      merchant: params.merchant,
      token: params.token,
      amount: params.amount,
      interval: params.interval,
      gracePeriod: params.gracePeriod,
      active: true,
      createdAt: nowSeconds(),
    });
    return { hash: this.hash("create-plan"), planId: id };
  }

  async updatePlan(params: UpdatePlanParams): Promise<{ hash: string }> {
    const plan = this.plans.find((item) => item.id === params.planId);
    if (!plan) throw new Error(`E2E plan ${params.planId} not found`);
    plan.amount = params.amount;
    plan.interval = params.interval;
    plan.gracePeriod = params.gracePeriod;
    plan.active = params.active;
    return { hash: this.hash("update-plan") };
  }

  async subscribe(params: SubscribeParams): Promise<{
    hash: string;
    subscriptionId: bigint;
  }> {
    const plan = this.plans.find((item) => item.id === params.planId);
    if (!plan) throw new Error(`E2E plan ${params.planId} not found`);
    if (!Number.isInteger(params.cycles) || params.cycles < 1) {
      throw new Error("E2E subscription needs at least one cycle");
    }

    this.subscriptionCounter += 1;
    const id = BigInt(this.subscriptionCounter);
    const startedAt = nowSeconds();
    this.subscriptions.push({
      id,
      planId: plan.id,
      token: plan.token,
      subscriber: params.subscriber,
      amount: plan.amount,
      interval: plan.interval,
      gracePeriod: plan.gracePeriod,
      balance: plan.amount * BigInt(params.cycles),
      // Short enough for a browser test, long enough to observe the wait stage.
      nextCharge: startedAt + 3n,
      status: SubscriptionStatus.Active,
      cyclesPaid: 0,
      startedAt,
      lastChargedAt: 0n,
    });
    return { hash: this.hash("subscribe"), subscriptionId: id };
  }

  async topUp(params: TopUpParams): Promise<{
    hash: string;
    balance: bigint;
  }> {
    const subscription = this.findSubscription(params.subscriptionId);
    subscription.balance += subscription.amount * BigInt(params.cycles);
    return {
      hash: this.hash("top-up"),
      balance: subscription.balance,
    };
  }

  async charge(params: ChargeParams): Promise<{
    hash: string;
    outcome: number;
  }> {
    const subscription = this.findSubscription(params.subscriptionId);
    if (subscription.status === SubscriptionStatus.Cancelled) {
      return { hash: this.hash("charge"), outcome: ChargeOutcome.Cancelled };
    }
    if (subscription.nextCharge > nowSeconds()) {
      return { hash: this.hash("charge"), outcome: ChargeOutcome.NotDue };
    }
    if (subscription.balance < subscription.amount) {
      return {
        hash: this.hash("charge"),
        outcome: ChargeOutcome.InsufficientBalance,
      };
    }

    subscription.balance -= subscription.amount;
    subscription.cyclesPaid += 1;
    subscription.lastChargedAt = nowSeconds();
    subscription.nextCharge = subscription.lastChargedAt + subscription.interval;
    return { hash: this.hash("charge"), outcome: ChargeOutcome.Charged };
  }

  async cancel(params: CancelParams): Promise<{
    hash: string;
    refund: bigint;
  }> {
    const subscription = this.findSubscription(params.subscriptionId);
    const refund = subscription.balance;
    subscription.balance = 0n;
    subscription.status = SubscriptionStatus.Cancelled;
    return { hash: this.hash("cancel"), refund };
  }

  async getAllPlans(_source: string, limit = 100): Promise<Plan[]> {
    return this.plans.slice(0, limit).map(clonePlan);
  }

  async getAllSubscriptions(_source: string, limit = 100): Promise<Subscription[]> {
    return this.subscriptions.slice(0, limit).map(cloneSubscription);
  }

  async getSubscriberSubscriptions(
    _source: string,
    subscriber: string,
  ): Promise<bigint[]> {
    return this.subscriptions
      .filter((item) => item.subscriber === subscriber)
      .map((item) => item.id);
  }

  async getSubscriptions(
    _source: string,
    ids: bigint[],
  ): Promise<Subscription[]> {
    return ids
      .map((id) => this.subscriptions.find((item) => item.id === id))
      .filter((item): item is Subscription => Boolean(item))
      .map(cloneSubscription);
  }

  async isDue(source: string, subscriptionId: bigint): Promise<boolean> {
    void source;
    return this.findSubscription(subscriptionId).nextCharge <= nowSeconds();
  }

  async quote(_source: string, planId: bigint, cycles: number): Promise<bigint> {
    const plan = this.plans.find((item) => item.id === planId);
    if (!plan) throw new Error(`E2E plan ${planId} not found`);
    return plan.amount * BigInt(cycles);
  }
}
