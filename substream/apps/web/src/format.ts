export function parseAmount(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Enter a positive decimal amount.");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("Decimals must be an integer between 0 and 18.");
  }

  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new Error(`This token only supports ${decimals} decimals.`);
  }

  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export function formatAmount(value: bigint, decimals: number): string {
  if (decimals <= 0) return value.toString();
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function formatDuration(seconds: bigint): string {
  const value = Number(seconds);
  if (value <= 0) return "0m";
  if (value % 86_400 === 0) return `${value / 86_400}d`;
  if (value % 3_600 === 0) return `${value / 3_600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
}

export function formatDate(timestamp: bigint): string {
  if (timestamp <= 0n) return "—";
  return new Date(Number(timestamp) * 1_000).toLocaleString();
}

export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong. Check the console for details.";
}
