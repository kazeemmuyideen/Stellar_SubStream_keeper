import type { MetricsResponse, TokenAmount } from "@substream/sdk";

export interface TokenShare extends TokenAmount {
  /** Basis points of the total, rounded down (10,000 = 100%). */
  shareBps: number;
}

/** Converts a base-unit amount string into a percentage share of a total. */
export function shareBps(amount: string, total: bigint): number {
  try {
    const value = BigInt(amount);
    if (value <= 0n || total <= 0n) return 0;
    return Number((value * 10_000n) / total);
  } catch {
    return 0;
  }
}

export function tokenShares(amounts: TokenAmount[]): TokenShare[] {
  const total = amounts.reduce((sum, item) => {
    try {
      return sum + BigInt(item.amount);
    } catch {
      return sum;
    }
  }, 0n);

  return amounts.map((item) => ({ ...item, shareBps: shareBps(item.amount, total) }));
}

/** Returns basis points, or null when no charge has been attempted. */
export function successRateBps(succeeded: number, failed: number): number | null {
  const attempts = succeeded + failed;
  if (attempts <= 0) return null;
  return Math.round((succeeded / attempts) * 10_000);
}

export function formatBps(value: number | null): string {
  if (value === null) return "—";
  return `${(value / 100).toFixed(2)}%`;
}

function csvCell(value: string | number | bigint | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  // Neutralize spreadsheet formula injection from indexer-derived addresses.
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

function csvRow(...values: Array<string | number | bigint | null | undefined>): string {
  return values.map(csvCell).join(",");
}

/** Flattens a bounded metrics response into a spreadsheet-safe CSV export. */
export function metricsToCsv(payload: MetricsResponse): string {
  const rows: string[] = [csvRow("scope", "group", "key", "value")];
  const row = (
    scope: string,
    group: string,
    key: string,
    value: string | number | bigint | null | undefined,
  ) => rows.push(csvRow(scope, group, key, value));

  row("network", "context", "indexedEvents", payload.indexedEvents);
  row("network", "context", "lastLedger", payload.lastLedger);
  row("network", "context", "firstIndexedLedger", payload.firstIndexedLedger);

  const network = payload.network;
  for (const [key, value] of Object.entries(network)) {
    if (Array.isArray(value)) continue;
    row("network", "counters", key, value);
  }
  for (const item of network.charged) {
    row("network", "charged", item.token, item.amount);
  }
  for (const item of network.refunded) {
    row("network", "refunded", item.token, item.amount);
  }

  const merchant = payload.merchant;
  if (merchant) {
    row("merchant", "context", "merchant", merchant.merchant);
    for (const [key, value] of Object.entries(merchant)) {
      if (key === "merchant" || Array.isArray(value)) continue;
      row("merchant", "counters", key, value);
    }
    for (const item of merchant.charged) {
      row("merchant", "charged", item.token, item.amount);
    }
    for (const item of merchant.refunded) {
      row("merchant", "refunded", item.token, item.amount);
    }
    for (const plan of merchant.plans) {
      for (const [key, value] of Object.entries(plan)) {
        if (Array.isArray(value)) continue;
        row("merchant", `plan:${plan.planId}`, key, value);
      }
      for (const item of plan.charged) {
        row("merchant", `plan:${plan.planId}:charged`, item.token, item.amount);
      }
      for (const item of plan.refunded) {
        row("merchant", `plan:${plan.planId}:refunded`, item.token, item.amount);
      }
    }
  }

  return `${rows.join("\r\n")}\r\n`;
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
