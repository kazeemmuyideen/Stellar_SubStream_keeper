const CURSOR_RANGE_PATTERNS: RegExp[] = [
  /invalid\s+cursor/i,
  /cursor.+(?:out of range|outside|before|after|expired|retention|historical|window)/i,
];

export interface Page<T> {
  events: T[];
  cursor?: string;
}

export interface CollectOptions {
  startCursor?: string;
  pageSize: number;
  maxPages: number;
  onStalled?: () => void;
}

/** Return a new cursor only when the RPC actually advances it. */
export function advanceCursor(
  previous: string | undefined,
  returned: string | undefined,
): string | undefined {
  const next = returned?.trim();
  if (!next || next === previous) return undefined;
  return next;
}

/**
 * Collect bounded pages without ever regressing to a stale cursor. A short
 * final page can still carry a newer cursor, so it must be saved before the
 * loop stops.
 */
export async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  { startCursor, pageSize, maxPages, onStalled }: CollectOptions,
): Promise<Page<T>> {
  const events: T[] = [];
  let cursor = startCursor;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await fetchPage(cursor);
    events.push(...response.events);

    const next = advanceCursor(cursor, response.cursor);
    if (next) cursor = next;

    if (response.events.length < pageSize || !next) {
      if (response.events.length >= pageSize && !next) onStalled?.();
      break;
    }
  }

  return { events, cursor };
}

/**
 * Only a cursor-specific RPC failure is safe to re-anchor on. Retrying a
 * transient error with the old cursor preserves events; re-anchoring would
 * silently drop them.
 */
export function isCursorOutOfRangeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return CURSOR_RANGE_PATTERNS.some((pattern) => pattern.test(message));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  attempts: number,
  onRetry?: (attempt: number, message: string) => void,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || isCursorOutOfRangeError(error)) {
        throw error;
      }
      onRetry?.(
        attempt,
        error instanceof Error ? error.message : String(error),
      );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 5_000)),
      );
    }
  }
  throw lastError;
}
