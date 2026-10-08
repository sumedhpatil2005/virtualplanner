export const DEFAULT_OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  // Not overpass.osm.ch: it holds Switzerland only and answers "nothing here" for everywhere else
  'https://overpass.private.coffee/api/interpreter',
];

export class OverpassCancelledError extends Error {
  constructor() {
    super('Import cancelled.');
    this.name = 'OverpassCancelledError';
  }
}

export interface OverpassClientOptions {
  endpoints?: string[];
  /** Per-request timeout. Queries ask the server for [timeout:50], so allow a little more. */
  requestTimeoutMs?: number;
  /** Base delay before trying the next mirror; doubles each attempt (with jitter). */
  backoffBaseMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new OverpassCancelledError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new OverpassCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Overpass API client that is polite to the public mirrors (item 33):
 * - every request has a timeout, so a hung mirror can't hang the UI forever;
 * - HTTP 429/503/504 put that mirror in a cooldown (honouring Retry-After) with
 *   exponential growth on repeat offences, so we don't hammer mirrors back to back;
 * - attempts are spaced by exponential backoff with jitter;
 * - callers can cancel through an AbortSignal.
 */
export class OverpassClient {
  private endpoints: string[];
  private requestTimeoutMs: number;
  private backoffBaseMs: number;
  private fetchImpl: typeof fetch;
  private now: () => number;
  private sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private cooldownUntil = new Map<string, number>();
  private strikes = new Map<string, number>();

  constructor(opts: OverpassClientOptions = {}) {
    this.endpoints = opts.endpoints ?? DEFAULT_OVERPASS_ENDPOINTS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1_000;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? abortableSleep;
  }

  /** Seconds until the soonest mirror leaves cooldown (0 if one is available now). */
  public secondsUntilAvailable(): number {
    const now = this.now();
    const waits = this.endpoints.map(e => Math.max(0, (this.cooldownUntil.get(e) ?? 0) - now));
    return Math.ceil(Math.min(...waits) / 1000);
  }

  public async query(query: string, signal?: AbortSignal): Promise<any> {
    const available = this.endpoints.filter(e => (this.cooldownUntil.get(e) ?? 0) <= this.now());
    if (available.length === 0) {
      throw new Error(`All Overpass mirrors are rate-limiting this connection. Try again in ${this.secondsUntilAvailable()} s.`);
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < available.length; attempt++) {
      if (signal?.aborted) throw new OverpassCancelledError();
      if (attempt > 0) {
        const delay = this.backoffBaseMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
        await this.sleep(delay, signal);
      }

      const endpoint = available[attempt];
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.requestTimeoutMs);

      try {
        const res = await this.fetchImpl(`${endpoint}?data=${encodeURIComponent(query)}`, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });

        if (res.status === 429 || res.status === 503 || res.status === 504) {
          this.coolDown(endpoint, res.headers.get('Retry-After'));
          lastError = new Error(`${new URL(endpoint).host} is busy (HTTP ${res.status}).`);
          continue;
        }
        if (res.status === 400) {
          // A malformed query fails the same way everywhere — don't spread it across mirrors
          throw Object.assign(new Error(`Overpass rejected the query (HTTP 400): ${(await res.text()).slice(0, 200)}`), { fatal: true });
        }
        if (!res.ok) {
          lastError = new Error(`${new URL(endpoint).host} returned HTTP ${res.status}.`);
          continue;
        }

        const data = await res.json();
        if (typeof data?.remark === 'string' && /timeout|runtime error|out of memory/i.test(data.remark)) {
          this.coolDown(endpoint, null);
          lastError = new Error(`${new URL(endpoint).host} gave up on the query: ${data.remark}`);
          continue;
        }
        this.strikes.delete(endpoint);
        return data;
      } catch (err: any) {
        if (signal?.aborted) throw new OverpassCancelledError();
        if (err?.fatal) throw err;
        if (timedOut) {
          this.coolDown(endpoint, null);
          lastError = new Error(`${new URL(endpoint).host} did not respond within ${Math.round(this.requestTimeoutMs / 1000)} s.`);
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
    throw lastError ?? new Error('All Overpass API endpoints failed.');
  }

  private coolDown(endpoint: string, retryAfter: string | null) {
    const strikes = (this.strikes.get(endpoint) ?? 0) + 1;
    this.strikes.set(endpoint, strikes);
    const retrySeconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : null;
    // 30 s, 60 s, 120 s … capped at 10 min, unless the server told us exactly
    const ms = retrySeconds !== null ? retrySeconds * 1000 : Math.min(30_000 * 2 ** (strikes - 1), 600_000);
    this.cooldownUntil.set(endpoint, this.now() + ms);
  }
}
