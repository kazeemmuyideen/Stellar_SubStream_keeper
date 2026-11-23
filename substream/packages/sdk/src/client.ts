import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { addressToScVal, boolToScVal, i128ToScVal, u32ToScVal, u64ToScVal } from "./scval";
import {
  ChargeOutcomeValue,
  Plan,
  Subscription,
  SubscriptionStatus,
} from "./types";

export type SubStreamSigner = (
  tx: Transaction,
) => Promise<Transaction | void> | Transaction | void;

export interface SubStreamConfig {
  contractId: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  allowHttp?: boolean;
}

export interface CreatePlanParams {
  merchant: string;
  token: string;
  amount: bigint;
  interval: bigint;
  gracePeriod: bigint;
  signer: SubStreamSigner;
}

export interface UpdatePlanParams {
  merchant: string;
  planId: bigint;
  amount: bigint;
  interval: bigint;
  gracePeriod: bigint;
  active: boolean;
  signer: SubStreamSigner;
}

export interface SubscribeParams {
  subscriber: string;
  planId: bigint;
  cycles: number;
  signer: SubStreamSigner;
}

export interface TopUpParams {
  subscriber: string;
  subscriptionId: bigint;
  cycles: number;
  signer: SubStreamSigner;
}

export interface ChargeParams {
  subscriptionId: bigint;
  /** Any funded account can submit a charge; a keeper usually does. */
  source: string;
  signer: SubStreamSigner;
}

export interface CancelParams {
  subscriber: string;
  subscriptionId: bigint;
  signer: SubStreamSigner;
}

export interface MerchantCancelParams {
  merchant: string;
  subscriptionId: bigint;
  signer: SubStreamSigner;
}

export interface WriteResult {
  hash: string;
  value: unknown;
}

const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  throw new Error(`SubStream: expected an integer, got ${String(value)}`);
}

function normalizePlan(raw: Record<string, unknown>, id: bigint): Plan {
  return {
    id,
    merchant: raw.merchant as string,
    token: raw.token as string,
    amount: toBigInt(raw.amount),
    interval: toBigInt(raw.interval),
    gracePeriod: toBigInt(raw.grace_period),
    active: Boolean(raw.active),
    createdAt: toBigInt(raw.created_at),
  };
}

function normalizeSubscription(
  raw: Record<string, unknown>,
  id: bigint,
): Subscription {
  return {
    id,
    planId: toBigInt(raw.plan_id),
    subscriber: raw.subscriber as string,
    amount: toBigInt(raw.amount),
    interval: toBigInt(raw.interval),
    gracePeriod: toBigInt(raw.grace_period),
    balance: toBigInt(raw.balance),
    nextCharge: toBigInt(raw.next_charge),
    status: Number(raw.status),
    cyclesPaid: Number(raw.cycles_paid),
    startedAt: toBigInt(raw.started_at),
    lastChargedAt: toBigInt(raw.last_charged_at),
  };
}

export class SubStreamClient {
  readonly contractId: string;
  readonly networkPassphrase: string;
  readonly server: rpc.Server;

  private readonly contract: Contract;

  constructor(config: SubStreamConfig) {
    if (!config.contractId) {
      throw new Error("SubStream: contractId is required");
    }
    this.contractId = config.contractId;
    this.networkPassphrase = config.networkPassphrase ?? Networks.TESTNET;
    this.server = new rpc.Server(config.rpcUrl ?? DEFAULT_RPC_URL, {
      allowHttp: config.allowHttp ?? false,
    });
    this.contract = new Contract(this.contractId);
  }

  private async account(source: string): Promise<Account> {
    try {
      return await this.server.getAccount(source);
    } catch {
      return new Account(source, "0");
    }
  }

  private async build(
    source: string,
    method: string,
    args: xdr.ScVal[],
    signer?: SubStreamSigner,
  ): Promise<Transaction> {
    const account = await this.account(source);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(60)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    if (!signer) return prepared;

    const signed = await signer(prepared);
    return (signed ?? prepared) as Transaction;
  }

  private async read<T>(
    source: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<T> {
    const tx = await this.build(source, method, args);
    const simulation = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(simulation.error);
    }
    if (!simulation.result?.retval) {
      throw new Error(`SubStream: ${method} returned no value`);
    }
    return scValToNative(simulation.result.retval) as T;
  }

  private async write(
    source: string,
    method: string,
    args: xdr.ScVal[],
    signer: SubStreamSigner,
  ): Promise<WriteResult> {
    const tx = await this.build(source, method, args, signer);
    const sent = await this.server.sendTransaction(tx);

    if (sent.status === "ERROR") {
      throw new Error(
        `SubStream: send failed ${JSON.stringify(sent.errorResult)}`,
      );
    }

    const result = await this.wait(sent.hash);
    return {
      hash: sent.hash,
      value: result.returnValue ? scValToNative(result.returnValue) : undefined,
    };
  }

  private async wait(
    hash: string,
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await this.server.getTransaction(hash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return result;
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`SubStream: transaction ${hash} failed`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`SubStream: transaction ${hash} was not confirmed in 30s`);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async createPlan(
    params: CreatePlanParams,
  ): Promise<{ hash: string; planId: bigint }> {
    const result = await this.write(
      params.merchant,
      "create_plan",
      [
        addressToScVal(params.merchant),
        addressToScVal(params.token),
        i128ToScVal(params.amount),
        u64ToScVal(params.interval),
        u64ToScVal(params.gracePeriod),
      ],
      params.signer,
    );
    return { hash: result.hash, planId: toBigInt(result.value) };
  }

  async updatePlan(params: UpdatePlanParams): Promise<{ hash: string }> {
    const result = await this.write(
      params.merchant,
      "update_plan",
      [
        addressToScVal(params.merchant),
        u64ToScVal(params.planId),
        i128ToScVal(params.amount),
        u64ToScVal(params.interval),
        u64ToScVal(params.gracePeriod),
        boolToScVal(params.active),
      ],
      params.signer,
    );
    return { hash: result.hash };
  }

  async subscribe(
    params: SubscribeParams,
  ): Promise<{ hash: string; subscriptionId: bigint }> {
    const result = await this.write(
      params.subscriber,
      "subscribe",
      [
        addressToScVal(params.subscriber),
        u64ToScVal(params.planId),
        u32ToScVal(params.cycles),
      ],
      params.signer,
    );
    return {
      hash: result.hash,
      subscriptionId: toBigInt(result.value),
    };
  }

  // A zero balance means the grace period had already expired: the contract
  // cancelled the subscription and refunded the remainder instead of depositing.
  async topUp(
    params: TopUpParams,
  ): Promise<{ hash: string; balance: bigint }> {
    const result = await this.write(
      params.subscriber,
      "top_up",
      [
        addressToScVal(params.subscriber),
        u64ToScVal(params.subscriptionId),
        u32ToScVal(params.cycles),
      ],
      params.signer,
    );
    return { hash: result.hash, balance: toBigInt(result.value) };
  }

  async charge(
    params: ChargeParams,
  ): Promise<{ hash: string; outcome: ChargeOutcomeValue }> {
    const result = await this.write(
      params.source,
      "charge",
      [u64ToScVal(params.subscriptionId)],
      params.signer,
    );
    return {
      hash: result.hash,
      outcome: Number(result.value) as ChargeOutcomeValue,
    };
  }

  async cancel(
    params: CancelParams,
  ): Promise<{ hash: string; refund: bigint }> {
    const result = await this.write(
      params.subscriber,
      "cancel",
      [
        addressToScVal(params.subscriber),
        u64ToScVal(params.subscriptionId),
      ],
      params.signer,
    );
    return { hash: result.hash, refund: toBigInt(result.value) };
  }

  async cancelByMerchant(
    params: MerchantCancelParams,
  ): Promise<{ hash: string; refund: bigint }> {
    const result = await this.write(
      params.merchant,
      "cancel_by_merchant",
      [
        addressToScVal(params.merchant),
        u64ToScVal(params.subscriptionId),
      ],
      params.signer,
    );
    return { hash: result.hash, refund: toBigInt(result.value) };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getPlan(source: string, planId: bigint): Promise<Plan> {
    const raw = await this.read<Record<string, unknown>>(source, "get_plan", [
      u64ToScVal(planId),
    ]);
    return normalizePlan(raw, planId);
  }

  async getSubscription(
    source: string,
    subscriptionId: bigint,
  ): Promise<Subscription> {
    const raw = await this.read<Record<string, unknown>>(
      source,
      "get_subscription",
      [u64ToScVal(subscriptionId)],
    );
    return normalizeSubscription(raw, subscriptionId);
  }

  async getPlanCount(source: string): Promise<bigint> {
    return toBigInt(
      await this.read<bigint>(source, "get_plan_count", []),
    );
  }

  async getSubscriptionCount(source: string): Promise<bigint> {
    return toBigInt(
      await this.read<bigint>(source, "get_subscription_count", []),
    );
  }

  async getMerchantPlans(
    source: string,
    merchant: string,
  ): Promise<bigint[]> {
    const raw = await this.read<bigint[]>(source, "get_merchant_plans", [
      addressToScVal(merchant),
    ]);
    return raw.map(toBigInt);
  }

  async getPlans(
    source: string,
    planIds: bigint[],
  ): Promise<Plan[]> {
    return Promise.all(planIds.map((id) => this.getPlan(source, id)));
  }

  async getSubscriptions(
    source: string,
    subscriptionIds: bigint[],
  ): Promise<Subscription[]> {
    return Promise.all(
      subscriptionIds.map((id) => this.getSubscription(source, id)),
    );
  }

  async getSubscriberSubscriptions(
    source: string,
    subscriber: string,
  ): Promise<bigint[]> {
    const raw = await this.read<bigint[]>(
      source,
      "get_subscriber_subscriptions",
      [addressToScVal(subscriber)],
    );
    return raw.map(toBigInt);
  }

  async isDue(source: string, subscriptionId: bigint): Promise<boolean> {
    return Boolean(
      await this.read<boolean>(source, "is_due", [
        u64ToScVal(subscriptionId),
      ]),
    );
  }

  async quote(
    source: string,
    planId: bigint,
    cycles: number,
  ): Promise<bigint> {
    return toBigInt(
      await this.read<bigint>(source, "quote", [
        u64ToScVal(planId),
        u32ToScVal(cycles),
      ]),
    );
  }

  async getAllPlans(source: string, limit = 100): Promise<Plan[]> {
    const count = Number(await this.getPlanCount(source));
    const end = Math.min(count, limit);
    const plans: Plan[] = [];
    for (let id = 1; id <= end; id += 1) {
      plans.push(await this.getPlan(source, BigInt(id)));
    }
    return plans;
  }

  async getAllSubscriptions(
    source: string,
    limit = 100,
  ): Promise<Subscription[]> {
    const count = Number(await this.getSubscriptionCount(source));
    const end = Math.min(count, limit);
    const subscriptions: Subscription[] = [];
    for (let id = 1; id <= end; id += 1) {
      subscriptions.push(await this.getSubscription(source, BigInt(id)));
    }
    return subscriptions;
  }

  async getDueSubscriptions(
    source: string,
    limit = 100,
  ): Promise<Subscription[]> {
    const now = BigInt(Math.floor(Date.now() / 1_000));
    const subscriptions = await this.getAllSubscriptions(source, limit);
    return subscriptions.filter(
      (subscription) =>
        subscription.status !== SubscriptionStatus.Cancelled &&
        subscription.nextCharge <= now,
    );
  }
}

export function keypairSigner(keypair: Keypair): SubStreamSigner {
  return (tx: Transaction) => {
    tx.sign(keypair);
    return tx;
  };
}
