const BASE = process.argv[2] ?? 'http://localhost:8080';
const PATH = process.argv[3] ?? '/api/health';
const DURATION_MS = Number(process.argv[4] ?? 10_000);
const CONCURRENCY = Number(process.argv[5] ?? 50);
const TOKEN = process.argv[6] ?? '';

let stop = false;
const latencies = [];
let errors = 0;
let requests = 0;

async function worker() {
  const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
  while (!stop) {
    const start = performance.now();
    try {
      const res = await fetch(`${BASE}${PATH}`, { headers });
      if (!res.ok) errors += 1;
      const body = await res.arrayBuffer();
      void body;
    } catch {
      errors += 1;
    }
    latencies.push(performance.now() - start);
    requests += 1;
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  console.log(`Benchmarking GET ${BASE}${PATH}`);
  console.log(`concurrency=${CONCURRENCY} duration=${DURATION_MS / 1000}s\n`);

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  setTimeout(() => {
    stop = true;
  }, DURATION_MS);
  await Promise.allSettled(workers);

  latencies.sort((a, b) => a - b);
  const elapsedS = DURATION_MS / 1000;
  const rps = (requests / elapsedS).toFixed(0);
  const avg = (latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length)).toFixed(1);

  console.log(`requests      : ${requests}`);
  console.log(`errors        : ${errors}`);
  console.log(`throughput    : ${rps} req/s`);
  console.log(`latency avg   : ${avg} ms`);
  console.log(`latency p50   : ${percentile(latencies, 50).toFixed(1)} ms`);
  console.log(`latency p95   : ${percentile(latencies, 95).toFixed(1)} ms`);
  console.log(`latency p99   : ${percentile(latencies, 99).toFixed(1)} ms`);
}

main().catch((err) => {
  console.error('benchmark failed:', err.message);
  process.exit(1);
});
