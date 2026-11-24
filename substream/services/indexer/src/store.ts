import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IndexedEvent } from "@substream/sdk";

export interface IndexerState {
  cursor?: string;
  startLedger?: number;
  lastLedger: number | null;
  events: IndexedEvent[];
}

export interface EventQuery {
  subscriber?: string;
  subscriptionId?: string;
  limit: number;
}

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

export class EventStore {
  private state: IndexerState = { lastLedger: null, events: [] };
  private counts: Record<string, number> = {};

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

  /** Restart scanning from a recent ledger while keeping already-seen events. */
  reanchor(startLedger: number): void {
    this.state.startLedger = startLedger;
    this.state.lastLedger = startLedger - 1;
    this.state.cursor = undefined;
  }

  add(events: IndexedEvent[], cursor: string, lastLedger: number): number {
    const seen = new Set(this.state.events.map((event) => event.id));
    let added = 0;
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      this.state.events.push(event);
      added += 1;
    }

    this.state.events = this.state.events
      .sort(compareEvents)
      .slice(0, this.maxEvents);
    this.rebuildCounts();
    this.state.cursor = cursor;
    this.state.lastLedger = lastLedger;
    return added;
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

  async persist(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
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
  }
}

function compareEvents(a: IndexedEvent, b: IndexedEvent): number {
  if (a.ledger !== b.ledger) return b.ledger - a.ledger;
  return b.id.localeCompare(a.id);
}
