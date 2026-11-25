import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  IndexedEvent,
  MerchantMetrics,
  MetricsResponse,
  NetworkMetrics,
  PlanMetrics,
  TokenAmount,
} from "@substream/sdk";

const MAX_TRACKED_MERCHANTS = 1_000;
const MAX_TRACKED_PLANS = 10_000;
const MAX_TRACKED_SUBSCRIPTIONS = 20_000;
const MAX_TOKENS_PER_SCOPE = 100;
const MAX_PLANS_IN_SUMMARY = 100;
const UNKNOWN_TOKEN = "unknown";

export interface IndexerState {
  cursor?: string;
  startLedger?: number;
  lastLedger: number | null;
  events: IndexedEvent[];
  metrics?: MetricsState;
}

export interface EventQuery {
  subscriber?: string;
  subscriptionId?: string;
  limit: number;
}

type CounterBag = Record<string, number>;
type TokenTotals = Record<string, string>;

interface PlanRef {
  merchant: string | null;
  token: string | null;
}

interface SubscriptionRef extends PlanRef {
  planId: string | null;
}

interface PlanAggregate {
  counters: CounterBag;
  charged: TokenTotals;
  refunded: TokenTotals;
}

interface MerchantAggregate {
  merchant: string;
  counters: CounterBag;
  charged: TokenTotals;
  refunded: TokenTotals;
  plans: Record<string, PlanAggregate>;
}

interface NetworkAggregate {
  counters: CounterBag;
  charged: TokenTotals;
  refunded: TokenTotals;
}

interface MetricsState {
  network: NetworkAggregate;
  merchants: Record<string, MerchantAggregate>;
  plans: Record<string, PlanRef>;
  subscriptions: Record<string, SubscriptionRef>;
  /** Highest event already folded into metrics, even if trimmed from cache. */
  highWaterLedger: number | null;
  highWaterEventId: string | null;
}

const COUNTER_KEYS = [
  "plansCreated",
  "planUpdates",
  "subscriptions",
  "topUps",
  "charges",
  "failedCharges",
  "cancellations",
] as const;

function isIndexedEvent(value: unknown): value is IndexedEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<IndexedEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.kind === "string" &&
    typeof event.txHash === "string" &&
    typeof event.ledger === "number" &&
    typeof event.timestamp === "number"
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asCounterBag(value: unknown, fallback?: CounterBag): CounterBag {
  const source = asRecord(value) ?? {};
  const bag: CounterBag = {};
  for (const key of COUNTER_KEYS) {
    const raw = source[key] ?? fallback?.[key];
    bag[key] =
      typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
        ? raw
        : 0;
  }
  return bag;
}

function asAmount(value: unknown): bigint | null {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "bigint"
  ) {
    return null;
  }
  try {
    const amount = BigInt(value);
    return amount >= 0n ? amount : null;
  } catch {
    return null;
  }
}

function asTokenTotals(value: unknown): TokenTotals {
  const source = asRecord(value);
  const totals: TokenTotals = {};
  if (!source) return totals;
  for (const [token, raw] of Object.entries(source)) {
    if (!token || Object.keys(totals).length >= MAX_TOKENS_PER_SCOPE) continue;
    const amount = asAmount(raw);
    if (amount !== null) totals[token] = amount.toString();
  }
  return totals;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function emptyCounters(): CounterBag {
  const bag: CounterBag = {};
  for (const key of COUNTER_KEYS) bag[key] = 0;
  return bag;
}

function emptyPlan(): PlanAggregate {
  return { counters: emptyCounters(), charged: {}, refunded: {} };
}

function emptyMerchant(merchant: string): MerchantAggregate {
  return {
    merchant,
    counters: emptyCounters(),
    charged: {},
    refunded: {},
    plans: {},
  };
}

function emptyMetrics(): MetricsState {
  return {
    network: {
      counters: emptyCounters(),
      charged: {},
      refunded: {},
    },
    merchants: {},
    plans: {},
    subscriptions: {},
    highWaterLedger: null,
    highWaterEventId: null,
  };
}

function hasMetricsShape(value: unknown): boolean {
  const source = asRecord(value);
  return Boolean(
    source &&
      asRecord(source.network) &&
      asRecord(source.merchants) &&
      asRecord(source.plans) &&
      asRecord(source.subscriptions),
  );
}

function normalizePlanAggregate(value: unknown): PlanAggregate {
  const source = asRecord(value);
  return {
    counters: asCounterBag(source?.counters),
    charged: asTokenTotals(source?.charged),
    refunded: asTokenTotals(source?.refunded),
  };
}

function normalizeMetrics(value: unknown): MetricsState {
  const metrics = emptyMetrics();
  const source = asRecord(value);
  if (!source || !hasMetricsShape(value)) return metrics;

  const network = asRecord(source.network)!;
  metrics.network = {
    counters: asCounterBag(network.counters),
    charged: asTokenTotals(network.charged),
    refunded: asTokenTotals(network.refunded),
  };

  for (const [id, raw] of Object.entries(asRecord(source.plans)!)) {
    if (!id || Object.keys(metrics.plans).length >= MAX_TRACKED_PLANS) continue;
    const ref = asRecord(raw);
    metrics.plans[id] = {
      merchant: asStringOrNull(ref?.merchant),
      token: asStringOrNull(ref?.token),
    };
  }

  for (const [id, raw] of Object.entries(asRecord(source.subscriptions)!)) {
    if (
      !id ||
      Object.keys(metrics.subscriptions).length >= MAX_TRACKED_SUBSCRIPTIONS
    ) {
      continue;
    }
    const ref = asRecord(raw);
    metrics.subscriptions[id] = {
      planId: asStringOrNull(ref?.planId),
      merchant: asStringOrNull(ref?.merchant),
      token: asStringOrNull(ref?.token),
    };
  }

  for (const [address, raw] of Object.entries(asRecord(source.merchants)!)) {
    if (
      !address ||
      Object.keys(metrics.merchants).length >= MAX_TRACKED_MERCHANTS
    ) {
      continue;
    }
    const record = asRecord(raw);
    const plans: Record<string, PlanAggregate> = {};
    for (const [planId, plan] of Object.entries(asRecord(record?.plans) ?? {})) {
      if (!planId || Object.keys(plans).length >= MAX_TRACKED_PLANS) continue;
      plans[planId] = normalizePlanAggregate(plan);
    }
    metrics.merchants[address] = {
      merchant: address,
      counters: asCounterBag(record?.counters),
      charged: asTokenTotals(record?.charged),
      refunded: asTokenTotals(record?.refunded),
      plans,
    };
  }

  const highLedger = source.highWaterLedger;
  metrics.highWaterLedger =
    typeof highLedger === "number" &&
    Number.isSafeInteger(highLedger) &&
    highLedger >= 0
      ? highLedger
      : null;
  metrics.highWaterEventId =
    typeof source.highWaterEventId === "string" && source.highWaterEventId
      ? source.highWaterEventId
      : null;

  return metrics;
}

function bump(counters: CounterBag, key: string): void {
  const current = counters[key] ?? 0;
  counters[key] =
    current >= Number.MAX_SAFE_INTEGER ? current : current + 1;
}

function addAmount(
  totals: TokenTotals,
  token: string | null,
  raw: string | null,
): void {
  const amount = asAmount(raw);
  if (amount === null) return;
  const key = token || UNKNOWN_TOKEN;
  if (!(key in totals) && Object.keys(totals).length >= MAX_TOKENS_PER_SCOPE) {
    return;
  }
  totals[key] = ((asAmount(totals[key]) ?? 0n) + amount).toString();
}

function rememberPlan(
  metrics: MetricsState,
  planId: string | null,
  merchant: string | null,
  token: string | null,
): void {
  if (!planId) return;
  const existing = metrics.plans[planId];
  if (!existing) {
    if (Object.keys(metrics.plans).length >= MAX_TRACKED_PLANS) return;
    metrics.plans[planId] = { merchant, token };
  } else {
    existing.merchant ??= merchant;
    existing.token ??= token;
  }
  if (merchant) rememberMerchantPlan(metrics, merchant, planId);
}

function rememberMerchant(
  metrics: MetricsState,
  merchant: string | null,
): MerchantAggregate | null {
  if (!merchant) return null;
  if (!metrics.merchants[merchant]) {
    if (Object.keys(metrics.merchants).length >= MAX_TRACKED_MERCHANTS) {
      return null;
    }
    metrics.merchants[merchant] = emptyMerchant(merchant);
  }
  return metrics.merchants[merchant];
}

function rememberMerchantPlan(
  metrics: MetricsState,
  merchant: string | null,
  planId: string | null,
): PlanAggregate | null {
  const record = rememberMerchant(metrics, merchant);
  if (!record || !planId) return null;
  record.plans[planId] ??= emptyPlan();
  return record.plans[planId];
}

function rememberSubscription(
  metrics: MetricsState,
  id: string | null,
  planId: string | null,
  merchant: string | null,
  token: string | null,
): void {
  if (!id) return;
  const existing = metrics.subscriptions[id];
  if (!existing) {
    if (Object.keys(metrics.subscriptions).length >= MAX_TRACKED_SUBSCRIPTIONS) {
      return;
    }
    metrics.subscriptions[id] = { planId, merchant, token };
  } else {
    existing.planId ??= planId;
    existing.merchant ??= merchant;
    existing.token ??= token;
  }
}

interface EventContext {
  planId: string | null;
  subscriptionId: string | null;
  merchant: string | null;
  token: string | null;
}

function resolveContext(
  event: IndexedEvent,
  metrics: MetricsState,
): EventContext {
  const subscriptionId = event.subscriptionId ?? null;
  const subscriptionRef = subscriptionId
    ? metrics.subscriptions[subscriptionId]
    : undefined;
  // Top-up and cancellation events carry only a subscription id, so recover
  // their plan from the subscription recorded at subscribe time.
  const planId =
    event.planId ?? subscriptionRef?.planId ?? null;
  const planRef = planId ? metrics.plans[planId] : undefined;
  return {
    planId,
    subscriptionId,
    merchant:
      event.merchant ?? planRef?.merchant ?? subscriptionRef?.merchant ?? null,
    token: event.token ?? planRef?.token ?? subscriptionRef?.token ?? null,
  };
}

function applyEvent(metrics: MetricsState, event: IndexedEvent): void {
  const context = resolveContext(event, metrics);
  const merchantRecord = rememberMerchant(metrics, context.merchant);
  const planRecord = rememberMerchantPlan(
    metrics,
    context.merchant,
    context.planId,
  );

  switch (event.kind) {
    case "plan_new": {
      bump(metrics.network.counters, "plansCreated");
      rememberPlan(
        metrics,
        context.planId,
        event.merchant ?? event.subscriber,
        event.token,
      );
      break;
    }
    case "plan_upd":
      bump(metrics.network.counters, "planUpdates");
      break;
    case "subscribe": {
      bump(metrics.network.counters, "subscriptions");
      rememberSubscription(
        metrics,
        context.subscriptionId,
        context.planId,
        context.merchant,
        context.token,
      );
      if (merchantRecord) bump(merchantRecord.counters, "subscriptions");
      if (planRecord) bump(planRecord.counters, "subscriptions");
      break;
    }
    case "topped_up": {
      bump(metrics.network.counters, "topUps");
      if (merchantRecord) bump(merchantRecord.counters, "topUps");
      if (planRecord) bump(planRecord.counters, "topUps");
      break;
    }
    case "charged": {
      bump(metrics.network.counters, "charges");
      addAmount(metrics.network.charged, context.token, event.amount);
      if (merchantRecord) {
        bump(merchantRecord.counters, "charges");
        addAmount(merchantRecord.charged, context.token, event.amount);
      }
      if (planRecord) {
        bump(planRecord.counters, "charges");
        addAmount(planRecord.charged, context.token, event.amount);
      }
      break;
    }
    case "pay_fail": {
      bump(metrics.network.counters, "failedCharges");
      if (merchantRecord) bump(merchantRecord.counters, "failedCharges");
      if (planRecord) bump(planRecord.counters, "failedCharges");
      break;
    }
    case "cancelled": {
      bump(metrics.network.counters, "cancellations");
      addAmount(metrics.network.refunded, context.token, event.amount);
      if (merchantRecord) {
        bump(merchantRecord.counters, "cancellations");
        addAmount(merchantRecord.refunded, context.token, event.amount);
      }
      if (planRecord) {
        bump(planRecord.counters, "cancellations");
        addAmount(planRecord.refunded, context.token, event.amount);
      }
      break;
    }
  }
}

function countEvent(metrics: MetricsState, event: IndexedEvent): void {
  applyEvent(metrics, event);
  const ledger = metrics.highWaterLedger;
  const id = metrics.highWaterEventId;
  const advances =
    ledger === null ||
    event.ledger > ledger ||
    (event.ledger === ledger && (id === null || event.id.localeCompare(id) > 0));
  if (advances) {
    metrics.highWaterLedger = event.ledger;
    metrics.highWaterEventId = event.id;
  }
}

function isCountedBefore(
  event: IndexedEvent,
  ledger: number | null,
  id: string | null,
): boolean {
  if (ledger === null) return false;
  if (event.ledger < ledger) return true;
  if (event.ledger > ledger) return false;
  return id !== null && event.id.localeCompare(id) <= 0;
}

function replay(events: IndexedEvent[]): MetricsState {
  const metrics = emptyMetrics();
  for (const event of [...events].sort(compareEventsAscending)) {
    countEvent(metrics, event);
  }
  return metrics;
}

function tokenAmounts(totals: TokenTotals): TokenAmount[] {
  return Object.entries(totals)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([token, amount]) => ({ token, amount }));
}

function toPlanMetrics(planId: string, plan: PlanAggregate): PlanMetrics {
  return {
    planId,
    subscriptions: plan.counters.subscriptions ?? 0,
    topUps: plan.counters.topUps ?? 0,
    charges: plan.counters.charges ?? 0,
    failedCharges: plan.counters.failedCharges ?? 0,
    cancellations: plan.counters.cancellations ?? 0,
    charged: tokenAmounts(plan.charged),
    refunded: tokenAmounts(plan.refunded),
  };
}

function toMerchantMetrics(record: MerchantAggregate): MerchantMetrics {
  const plans = Object.entries(record.plans)
    .map(([planId, plan]) => toPlanMetrics(planId, plan))
    .sort(
      (left, right) =>
        right.charges - left.charges || left.planId.localeCompare(right.planId),
    )
    .slice(0, MAX_PLANS_IN_SUMMARY);

  return {
    merchant: record.merchant,
    subscriptions: record.counters.subscriptions ?? 0,
    topUps: record.counters.topUps ?? 0,
    charges: record.counters.charges ?? 0,
    failedCharges: record.counters.failedCharges ?? 0,
    cancellations: record.counters.cancellations ?? 0,
    charged: tokenAmounts(record.charged),
    refunded: tokenAmounts(record.refunded),
    plans,
  };
}

function toNetworkMetrics(network: NetworkAggregate): NetworkMetrics {
  return {
    plansCreated: network.counters.plansCreated ?? 0,
    planUpdates: network.counters.planUpdates ?? 0,
    subscriptions: network.counters.subscriptions ?? 0,
    topUps: network.counters.topUps ?? 0,
    charges: network.counters.charges ?? 0,
    failedCharges: network.counters.failedCharges ?? 0,
    cancellations: network.counters.cancellations ?? 0,
    charged: tokenAmounts(network.charged),
    refunded: tokenAmounts(network.refunded),
  };
}

export class EventStore {
  private state: IndexerState = { lastLedger: null, events: [] };
  private counts: Record<string, number> = {};
  private metrics: MetricsState = emptyMetrics();

  constructor(
    private readonly stateFile: string,
    private readonly maxEvents: number,
  ) {}

  /** Returns true when a corrupt state file was quarantined. */
  async load(): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(this.stateFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<IndexerState>;
      if (!Array.isArray(parsed.events)) {
        throw new Error("events must be an array");
      }

      this.state = {
        cursor: typeof parsed.cursor === "string" ? parsed.cursor : undefined,
        startLedger:
          typeof parsed.startLedger === "number" ? parsed.startLedger : undefined,
        lastLedger:
          typeof parsed.lastLedger === "number" ? parsed.lastLedger : null,
        events: parsed.events.filter(isIndexedEvent),
      };
      this.metrics = hasMetricsShape(parsed.metrics)
        ? normalizeMetrics(parsed.metrics)
        : replay(this.state.events);
      this.rebuildCounts();
      return false;
    } catch {
      await this.quarantine();
      return true;
    }
  }

  get cursor(): string | undefined {
    return this.state.cursor;
  }

  get startLedger(): number | undefined {
    return this.state.startLedger;
  }

  get lastLedger(): number | null {
    return this.state.lastLedger;
  }

  get size(): number {
    return this.state.events.length;
  }

  get eventCounts(): Readonly<Record<string, number>> {
    return { ...this.counts };
  }

  initialize(startLedger: number): void {
    if (this.state.startLedger === undefined) {
      this.state.startLedger = startLedger;
    }
    if (this.state.lastLedger === null) {
      this.state.lastLedger = startLedger - 1;
    }
  }

  /** Restart scanning from a recent ledger while keeping collected events. */
  reanchor(startLedger: number): void {
    const newestRetained = this.state.events[0]?.ledger ?? startLedger - 1;
    this.state.startLedger = startLedger;
    // Retained events can be newer than the new scan point; keep the reported
    // last ledger at or above the retained window.
    this.state.lastLedger = Math.max(startLedger - 1, newestRetained);
    this.state.cursor = undefined;
  }

  add(events: IndexedEvent[], cursor: string, lastLedger: number): number {
    const seen = new Set(this.state.events.map((event) => event.id));
    const fresh = events.filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });

    let applied = 0;
    for (const event of [...fresh].sort(compareEventsAscending)) {
      // A re-anchor can rescan events that were counted before they aged out
      // of the retained cache. The high-water mark prevents double-counting.
      if (
        isCountedBefore(
          event,
          this.metrics.highWaterLedger,
          this.metrics.highWaterEventId,
        )
      ) {
        continue;
      }
      countEvent(this.metrics, event);
      applied += 1;
    }

    this.state.events.push(...fresh);
    this.state.events = this.state.events
      .sort(compareEvents)
      .slice(0, this.maxEvents);
    this.rebuildCounts();
    this.state.cursor = cursor;
    this.state.lastLedger = lastLedger;
    return applied;
  }

  query({ subscriber, subscriptionId, limit }: EventQuery): IndexedEvent[] {
    const bounded =
      Number.isFinite(limit) && limit > 0
        ? Math.min(Math.floor(limit), 500)
        : 100;
    return this.state.events
      .filter((event) => {
        if (subscriber && event.subscriber !== subscriber) return false;
        if (subscriptionId && event.subscriptionId !== subscriptionId) {
          return false;
        }
        return true;
      })
      .slice(0, bounded);
  }

  /** Cumulative metrics plus the bounds of the retained event window. */
  summary(merchant?: string): MetricsResponse {
    const record = merchant ? this.metrics.merchants[merchant] : undefined;
    return {
      network: toNetworkMetrics(this.metrics.network),
      merchant: record ? toMerchantMetrics(record) : undefined,
      indexedEvents: this.state.events.length,
      lastLedger: this.state.lastLedger,
      firstIndexedLedger: this.state.events.length
        ? this.state.events[this.state.events.length - 1]!.ledger
        : null,
    };
  }

  async persist(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    this.state.metrics = this.metrics;
    const temporary = `${this.stateFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`);
    await rename(temporary, this.stateFile);
  }

  private rebuildCounts(): void {
    const counts: Record<string, number> = {};
    for (const event of this.state.events) {
      counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    }
    this.counts = counts;
  }

  private async quarantine(): Promise<void> {
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    await rename(this.stateFile, `${this.stateFile}.corrupt-${suffix}`).catch(
      () => undefined,
    );
    this.state = { lastLedger: null, events: [] };
    this.counts = {};
    this.metrics = emptyMetrics();
  }
}

function compareEvents(a: IndexedEvent, b: IndexedEvent): number {
  if (a.ledger !== b.ledger) return b.ledger - a.ledger;
  return b.id.localeCompare(a.id);
}

function compareEventsAscending(a: IndexedEvent, b: IndexedEvent): number {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  return a.id.localeCompare(b.id);
}
