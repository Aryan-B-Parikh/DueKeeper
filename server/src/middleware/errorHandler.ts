import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors';
import { createLogger } from '../lib/logger';
import { zodDetails } from './validate';

const log = createLogger('http');

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
  requestId?: string;
}

export function notFoundHandler(req: Request, res: Response): void {
  const body: ErrorBody = {
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
    requestId: req.requestId
  };
  res.status(404).json(body);
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (res.headersSent) {
    log.warn('Headers already sent; delegating to default handler', { path: req.path });
    return;
  }

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong on our side';
  let details: unknown;

  if (err instanceof HttpError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = zodDetails(err);
  } else {
    log.error(`Unhandled error on ${req.method} ${req.path}`, err as Error);
  }

  const body: ErrorBody = { error: { code, message }, requestId: req.requestId };
  if (details !== undefined) body.error.details = details;

  res.status(status).json(body);
}
