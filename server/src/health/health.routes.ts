import { Router } from 'express';
import { getDb } from '../db/database';

const startedAt = Date.now();

export const healthRouter = Router();

function basePayload() {
  return {
    ok: true,
    name: 'duekeeper-server',
    version: '1.0.0',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
  };
}

healthRouter.get('/', (_req, res) => {
  res.json(basePayload());
});

healthRouter.get('/liveness', (_req, res) => {
  res.status(200).json({ ok: true });
});

healthRouter.get('/readiness', (_req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    res.json({ ok: true, database: 'up' });
  } catch {
    res.status(503).json({ ok: false, database: 'down' });
  }
});
