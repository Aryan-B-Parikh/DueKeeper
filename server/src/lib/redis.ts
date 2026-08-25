import Redis from 'ioredis';
import { Queue, Worker, type JobsOptions } from 'bullmq';
import { config } from '../config/env';
import { createLogger } from './logger';

const log = createLogger('redis');

let redis: Redis | null = null;
let queue: Queue | null = null;

export function isRedisEnabled(): boolean {
  return Boolean(config.redisUrl && config.redisUrl.trim() !== '');
}

export function getRedis(): Redis {
  if (!isRedisEnabled()) throw new Error('REDIS_URL not set');
  if (redis) return redis;
  redis = new Redis(config.redisUrl!, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false
  });
  redis.on('error', (err) => log.error('Redis error', err as Error));
  redis.on('connect', () => log.info('Redis connected'));
  return redis;
}

export function getQueue(): Queue {
  if (!isRedisEnabled()) throw new Error('REDIS_URL not set');
  if (queue) return queue;
  queue = new Queue('duekeeper-outbox', {
    connection: getRedis(),
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 100,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 }
    } as JobsOptions
  });
  return queue;
}

export async function closeRedis(): Promise<void> {
  if (queue) { const q = queue; queue = null; await q.close().catch(()=>{}); }
  if (redis) { const r = redis; redis = null; await r.quit().catch(()=>{}); }
}
