import type { FeedMode } from "./types";
import type { PriceProvider, ProviderQuote } from "./provider";
import { ProviderError } from "./provider";
import { createTwelveDataProvider } from "./twelvedata";
import { createYahooProvider } from "./yahoo";

export interface UpstreamFailure {
  message: string;
  /** Consecutive failures shared by every feed polling this upstream. */
  failures: number;
  /** An auth or rate-limit rejection: no point waiting for the next poll. */
  blocking: boolean;
}

export interface UpstreamHandlers {
  onQuotes(quotes: Map<string, ProviderQuote>): void;
  onFailure(failure: UpstreamFailure): void;
}

/** An upstream that answered with 401/403/429 is not recovering on its own. */
function blocking(message: string): boolean {
  return /^\s*(401|403|429)\b/.test(message);
}

/**
 * One poll loop per provider mode, shared by every feed that reads it
 * (design §1.3, §2.6-R7). `DEMO_FEED=yahoo` + `LIVE_FEED=yahoo` is one 2.5 s
 * loop against an unofficial host, not two. Feeds subscribe, keep their own
 * marks and their own state machine, and release the loop when they stop.
 */
export class Upstream {
  readonly mode: FeedMode;
  failures = 0;
  lastPollAt = 0;
  polls = 0;

  private readonly subscribers = new Set<UpstreamHandlers>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** `Retry-After` from the last rejection, in ms. */
  private retryAfterMs: number | null = null;

  constructor(
    readonly provider: PriceProvider,
    readonly pollMs: number,
    private readonly label: string,
    private readonly rand: () => number = Math.random,
    /** Design §6: never wait longer than a minute for a host that is merely busy. */
    readonly maxBackoffMs = 60_000,
  ) {
    this.mode = provider.mode;
  }

  subscribe(handlers: UpstreamHandlers): () => void {
    this.subscribers.add(handlers);
    this.schedule(this.nextDelayMs);
    return () => {
      this.subscribers.delete(handlers);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * The wait before the next poll (design §6). Healthy, it is the configured
   * cadence. Each consecutive failure doubles it — 2.5 s, 5, 10, 20, 40, capped
   * at `maxBackoffMs` — so a rate-limited host gets space instead of a retry
   * hammer, and jitter (±25 %) keeps two feeds that lost the same host from
   * reconnecting in lockstep. A `Retry-After` outranks the computed delay: the
   * provider knows, we don't.
   */
  get nextDelayMs(): number {
    if (this.failures === 0 && this.retryAfterMs === null) return this.pollMs;
    const grown = Math.min(this.pollMs * 2 ** Math.max(this.failures, 1), this.maxBackoffMs);
    const jittered = grown * (0.75 + this.rand() * 0.5);
    return Math.max(this.pollMs, Math.round(Math.max(jittered, this.retryAfterMs ?? 0)));
  }

  private schedule(delayMs: number) {
    if (this.subscribers.size === 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce().finally(() => {
        // Re-read the delay: this poll just changed `failures`, and the wait
        // until the next one follows from it.
        if (this.subscribers.size > 0 && !this.timer) this.schedule(this.nextDelayMs);
      });
    }, delayMs);
  }

  /** One round-trip, delivered to every subscriber. Shared by the timer and by tests. */
  async pollOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.deliver().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async deliver(): Promise<void> {
    try {
      const quotes = await this.provider.fetchQuotes();
      if (quotes.size === 0) throw new Error("provider returned no usable prices");
      this.failures = 0;
      this.retryAfterMs = null;
      this.polls += 1;
      this.lastPollAt = Date.now();
      for (const handlers of this.subscribers) handlers.onQuotes(quotes);
    } catch (err) {
      this.failures += 1;
      if (err instanceof ProviderError && err.retryAfterMs !== null) {
        this.retryAfterMs = err.retryAfterMs;
      }
      const message = `${this.mode} feed error: ${(err as Error).message}`;
      if (this.failures === 1 || this.failures % 20 === 0) {
        console.warn(`[prices:${this.label}] ${message}${this.retryAfterMs ? ` (retry after ${Math.round(this.retryAfterMs / 1000)}s)` : ""}`);
      }
      const failure: UpstreamFailure = { message, failures: this.failures, blocking: blocking((err as Error).message) };
      for (const handlers of this.subscribers) handlers.onFailure(failure);
    }
  }
}

export function providerForMode(mode: FeedMode): PriceProvider | null {
  if (mode === "yahoo") return createYahooProvider();
  if (mode === "twelvedata") return createTwelveDataProvider();
  return null;
}

const g = globalThis as unknown as { __feedUpstreams?: Map<string, Upstream> };

/**
 * Memoized per `(mode, pollMs)` and surviving module reloads, so dev-server HMR
 * cannot start a second loop against the same host.
 */
export function upstreamForMode(mode: FeedMode, pollMs: number): Upstream | null {
  const provider = providerForMode(mode);
  if (!provider) return null;
  const map = (g.__feedUpstreams ??= new Map<string, Upstream>());
  const key = `${mode}:${pollMs}`;
  const existing = map.get(key);
  if (existing) return existing;
  const created = new Upstream(provider, pollMs, mode);
  map.set(key, created);
  return created;
}

/** A private upstream: injected providers in tests must not be shared globals. */
export function dedicatedUpstream(provider: PriceProvider, pollMs: number, label = "test", rand?: () => number): Upstream {
  return new Upstream(provider, pollMs, label, rand);
}
