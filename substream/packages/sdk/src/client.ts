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
  ChargeOutcome,
  ChargeOutcomeValue,
  Plan,
  Subscription,
  SubscriptionStatus,
} from "./types";

export type SubStreamSigner = (
  tx: Transaction,
) => Promise<Transaction> | Transaction;

export interface SubStreamConfig {
  contractId: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  allowHttp?: boolean;
  /** Per-request RPC timeout. Set to 0 to disable (not recommended). */
  rpcTimeoutMs?: number;
  /** Maximum transaction fee accepted from an RPC-prepared transaction. */
  maxFee?: number;
  /** Maximum time to wait for transaction confirmation. */
  confirmTimeoutMs?: number;
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
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_FEE = 1_000_000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;
const MAX_SCAN_LIMIT = 500;
const SCAN_CONCURRENCY = 8;

function positiveInt(
  name: string,
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`SubStream: ${name} must be an integer between 0 and ${max}`);
  }
  return value;
}

export function scanEnd(count: bigint, limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("SubStream: scan limit must be a positive integer");
  }
  const bounded = Math.min(limit, MAX_SCAN_LIMIT);
  if (count <= 0n) return 0;
  return count > BigInt(bounded) ? bounded : Number(count);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export function toChargeOutcome(value: unknown): ChargeOutcomeValue {
  const isNumber =
    typeof value === "number" || typeof value === "bigint";
  const isIntegerString =
    typeof value === "string" && /^-?\d+$/.test(value.trim());
  if (!isNumber && !isIntegerString) {
    throw new Error(`SubStream: unknown charge outcome ${String(value)}`);
  }

  const outcome = Number(value);
  if (
    !Number.isSafeInteger(outcome) ||
    !Object.values(ChargeOutcome).includes(outcome as ChargeOutcomeValue)
  ) {
    throw new Error(`SubStream: unknown charge outcome ${String(value)}`);
  }
  return outcome as ChargeOutcomeValue;
}

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
    token: raw.token as string,
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
  private readonly maxFee: number;
  private readonly confirmTimeoutMs: number;

  constructor(config: SubStreamConfig) {
    if (!config.contractId) {
      throw new Error("SubStream: contractId is required");
    }
    this.contractId = config.contractId;
    this.networkPassphrase = config.networkPassphrase ?? Networks.TESTNET;
    this.maxFee = positiveInt("maxFee", config.maxFee, DEFAULT_MAX_FEE, Number.MAX_SAFE_INTEGER);
    this.confirmTimeoutMs = positiveInt(
      "confirmTimeoutMs",
      config.confirmTimeoutMs,
      DEFAULT_CONFIRM_TIMEOUT_MS,
      3_600_000,
    );
    if (this.confirmTimeoutMs === 0 || this.maxFee === 0) {
      throw new Error("SubStream: maxFee and confirmTimeoutMs must be positive");
    }
    const rpcTimeoutMs = positiveInt(
      "rpcTimeoutMs",
      config.rpcTimeoutMs,
      DEFAULT_RPC_TIMEOUT_MS,
      2_147_483_647,
    );
    this.server = new rpc.Server(config.rpcUrl ?? DEFAULT_RPC_URL, {
      allowHttp: config.allowHttp ?? false,
      timeout: rpcTimeoutMs,
    });
    this.contract = new Contract(this.contractId);
  }

  private async account(source: string): Promise<Account> {
    try {
      return await this.server.getAccount(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A simulated read can use an unfunded source, but real RPC failures
      // must not be hidden as an empty account.
      if (/not found|404|account.*(?:does not exist|not exist)/i.test(message)) {
        return new Account(source, "0");
      }
      throw error;
    }
  }

  private async transaction(
    source: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<Transaction> {
    const account = await this.account(source);
    return new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(60)
      .build();
  }

  private async prepare(
    source: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<Transaction> {
    const tx = await this.transaction(source, method, args);
    const prepared = await this.server.prepareTransaction(tx);
    if (Number(prepared.fee) > this.maxFee) {
      throw new Error(
        `SubStream: prepared fee ${prepared.fee} exceeds the configured maximum ${this.maxFee}`,
      );
    }
    return prepared;
  }

  private async build(
    source: string,
    method: string,
    args: xdr.ScVal[],
    signer?: SubStreamSigner,
  ): Promise<Transaction> {
    const prepared = await this.prepare(source, method, args);
    if (!signer) return prepared;

    const signed = await signer(prepared);
    if (!signed) {
      throw new Error("SubStream: signer did not return a signed transaction");
    }
    if (!sameHash(signed.hash(), prepared.hash())) {
      throw new Error("SubStream: signer returned a different transaction");
    }
    if (signed.signatures.length === 0) {
      throw new Error("SubStream: signer returned an unsigned transaction");
    }
    return signed;
  }

  private async read<T>(
    source: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<T> {
    // A read needs one simulation, not prepareTransaction plus a second
    // simulation. This halves RPC calls for every SDK read.
    const tx = await this.transaction(source, method, args);
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
    const deadline = Date.now() + this.confirmTimeoutMs;
    let delayMs = 1_000;

    for (;;) {
      const result = await this.server.getTransaction(hash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return result;
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`SubStream: transaction ${hash} failed`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `SubStream: transaction ${hash} was not confirmed in ${this.confirmTimeoutMs}ms; check it before retrying`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 5_000);
    }
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
      outcome: toChargeOutcome(result.value),
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
    const end = scanEnd(await this.getPlanCount(source), limit);
    const ids = Array.from({ length: end }, (_, index) => BigInt(index + 1));
    return mapWithConcurrency(ids, SCAN_CONCURRENCY, (id) =>
      this.getPlan(source, id),
    );
  }

  async getAllSubscriptions(
    source: string,
    limit = 100,
  ): Promise<Subscription[]> {
    const end = scanEnd(await this.getSubscriptionCount(source), limit);
    const ids = Array.from({ length: end }, (_, index) => BigInt(index + 1));
    return mapWithConcurrency(ids, SCAN_CONCURRENCY, (id) =>
      this.getSubscription(source, id),
    );
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
