export interface KeeperSnapshot {
  startedAt: number;
  lastTickAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  ticks: number;
  tickFailures: number;
  consecutiveFailures: number;
  dueFound: number;
  chargeAttempts: number;
  chargeFailures: number;
  dryRuns: number;
  outcomes: Record<string, number>;
}

function outcomeKey(label: string): string {
  const key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || "unknown";
}

export class KeeperMetrics {
  private readonly startedAt: number;
  private lastTickAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private ticks = 0;
  private tickFailures = 0;
  private consecutiveFailures = 0;
  private dueFound = 0;
  private chargeAttempts = 0;
  private chargeFailures = 0;
  private dryRuns = 0;
  private readonly outcomes: Record<string, number> = {};

  constructor(now = Date.now()) {
    this.startedAt = now;
  }

  tickStarted(now = Date.now()): void {
    this.ticks += 1;
    this.lastTickAt = now;
  }

  tickSucceeded(due: number, now = Date.now()): void {
    this.consecutiveFailures = 0;
    this.lastSuccessAt = now;
    this.dueFound += due;
  }

  tickFailed(now = Date.now()): void {
    this.tickFailures += 1;
    this.consecutiveFailures += 1;
    this.lastFailureAt = now;
  }

  chargeAttempted(): void {
    this.chargeAttempts += 1;
  }

  chargeSucceeded(label: string): void {
    const key = outcomeKey(label);
    this.outcomes[key] = (this.outcomes[key] ?? 0) + 1;
  }

  chargeFailed(): void {
    this.chargeFailures += 1;
  }

  dryRun(): void {
    this.dryRuns += 1;
  }

  snapshot(): KeeperSnapshot {
    return {
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      ticks: this.ticks,
      tickFailures: this.tickFailures,
      consecutiveFailures: this.consecutiveFailures,
      dueFound: this.dueFound,
      chargeAttempts: this.chargeAttempts,
      chargeFailures: this.chargeFailures,
      dryRuns: this.dryRuns,
      outcomes: { ...this.outcomes },
    };
  }

  summaryLine(): string {
    const s = this.snapshot();
    return (
      `ticks=${s.ticks} failures=${s.tickFailures} due=${s.dueFound} ` +
      `attempts=${s.chargeAttempts} settled=${s.chargeAttempts - s.chargeFailures}`
    );
  }
}

/** Exponential backoff, bounded and jittered to avoid keeper thundering herds. */
export function backoffDelay(
  consecutiveFailures: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(baseMs) || !Number.isFinite(maxMs)) {
    throw new Error("backoff bounds must be finite");
  }
  if (baseMs <= 0 || maxMs < baseMs) {
    throw new Error("backoff bounds must satisfy 0 < baseMs <= maxMs");
  }
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 1) {
    throw new Error("consecutiveFailures must be a positive integer");
  }

  const exponent = Math.min(consecutiveFailures - 1, 30);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  const jitter = Math.min(1, Math.max(0, random()));
  return Math.max(1, Math.round(ceiling * (0.5 + jitter / 2)));
}

function gauge(name: string, value: number | null, help: string): string {
  // 0 means "never"; Prometheus alerts stay evaluable instead of comparing NaN.
  const suffix = value === null ? "0" : String(value);
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${suffix}\n`;
}

function counter(name: string, value: number, help: string): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${value}\n`;
}

export function renderPrometheus(snapshot: KeeperSnapshot): string {
  const lines: string[] = [];
  const startedSeconds = Math.floor(snapshot.startedAt / 1000);
  lines.push(gauge("keeper_start_time_seconds", startedSeconds, "Keeper start time."));
  for (const [name, value] of [
    ["keeper_last_tick_time_seconds", snapshot.lastTickAt],
    ["keeper_last_success_time_seconds", snapshot.lastSuccessAt],
    ["keeper_last_failure_time_seconds", snapshot.lastFailureAt],
  ] as const) {
    lines.push(
      gauge(
        name,
        value === null ? null : Math.floor(value / 1000),
        `Unix time of the last keeper event for ${name}.`,
      ),
    );
  }
  lines.push(
    counter("keeper_ticks_total", snapshot.ticks, "Completed keeper ticks."),
    counter("keeper_tick_failures_total", snapshot.tickFailures, "Failed keeper ticks."),
    gauge(
      "keeper_consecutive_failures",
      snapshot.consecutiveFailures,
      "Consecutive tick failures used to compute retry backoff.",
    ),
    counter(
      "keeper_due_found_total",
      snapshot.dueFound,
      "Due subscriptions observed by the keeper.",
    ),
    counter(
      "keeper_charge_attempts_total",
      snapshot.chargeAttempts,
      "Charge transactions attempted by the keeper.",
    ),
    counter(
      "keeper_charge_failures_total",
      snapshot.chargeFailures,
      "Charge attempts that threw before returning an outcome.",
    ),
    counter(
      "keeper_dry_runs_total",
      snapshot.dryRuns,
      "Charges skipped in dry-run mode.",
    ),
  );
  lines.push(
    "# HELP keeper_charge_outcomes_total Charge outcomes returned by the contract.",
    "# TYPE keeper_charge_outcomes_total counter",
  );
  for (const [outcome, count] of Object.entries(snapshot.outcomes).sort()) {
    lines.push(`keeper_charge_outcomes_total{outcome="${outcome}"} ${count}`);
  }
  return lines.join("");
}
