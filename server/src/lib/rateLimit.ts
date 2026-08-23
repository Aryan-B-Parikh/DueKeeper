interface Bucket {
  hits: number[];
}

export interface RateLimiter {
  take(key: string): { allowed: boolean; retryAfterSeconds: number };
}

export function createRateLimiter(options: { windowMs: number; max: number }): RateLimiter {
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  function sweep(now: number): void {
    if (now - lastSweep < 60_000) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      bucket.hits = bucket.hits.filter((t) => now - t < options.windowMs);
      if (bucket.hits.length === 0) buckets.delete(key);
    }
  }

  return {
    take(key: string): { allowed: boolean; retryAfterSeconds: number } {
      const now = Date.now();
      sweep(now);
      let bucket = buckets.get(key);
      if (!bucket) {
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
