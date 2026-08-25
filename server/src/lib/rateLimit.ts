interface Bucket {
  hits: number[];
}

export interface RateLimiter {
  take(key: string): { allowed: boolean; retryAfterSeconds: number };
}

export function createRateLimiter(options: { windowMs: number; max: number; maxKeys?: number }): RateLimiter {
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();
  const maxKeys = options.maxKeys ?? 10000;

  function sweep(now: number): void {
    if (now - lastSweep < 60_000) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      bucket.hits = bucket.hits.filter((t) => now - t < options.windowMs);
      if (bucket.hits.length === 0) buckets.delete(key);
    }
  }

  /**
   * Caps the map to bound memory: keys are partly attacker-influenced (a login
   * key contains the submitted email), so an unbounded map is a memory-growth
   * primitive.
   *
   * This runs on every insertion rather than only inside `sweep`, because
   * `sweep` short-circuits for a full minute at a time — a burst of unique keys
   * could push the map arbitrarily far past `maxKeys` before it next ran, which
   * is precisely the traffic shape the cap exists to survive. Eviction is
   * oldest-first, which `Map`'s insertion order gives for free.
   *
   * Evicting an entry forgives whatever hits it had recorded. That is the right
   * trade at this size: the alternative is refusing to track new keys at all,
   * which would let an attacker fill the map and then rate-limit every genuine
   * user out of the system.
   */
  function enforceKeyCap(): void {
    if (buckets.size < maxKeys) return;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (buckets.size < maxKeys) break;
    }
  }

  return {
    take(key: string): { allowed: boolean; retryAfterSeconds: number } {
      const now = Date.now();
      sweep(now);
      let bucket = buckets.get(key);
      if (!bucket) {
        enforceKeyCap();
        bucket = { hits: [] };
        buckets.set(key, bucket);
      }
      bucket.hits = bucket.hits.filter((t) => now - t < options.windowMs);
      if (bucket.hits.length >= options.max) {
        const oldest = bucket.hits[0];
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + options.windowMs - now) / 1000))
        };
      }
      bucket.hits.push(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }
  };
}
