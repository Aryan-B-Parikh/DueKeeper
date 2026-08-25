import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError, RateLimitError } from '../lib/errors';
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

/**
 * Recognises the client-side errors express's body parsers throw.
 *
 * They are plain `Error`s with a numeric `status` and `expose: true`, not
 * HttpErrors, so they used to fall through to the generic branch: an oversized
 * or malformed request body was reported to the client as `500 INTERNAL_ERROR`
 * and logged as an unhandled server fault. Both are wrong — the request was bad,
 * and the noise buries real 500s.
 */
function asClientRequestError(err: unknown): { status: number; code: string; message: string } | null {
  if (!err || typeof err !== 'object') return null;
  const candidate = err as { status?: unknown; statusCode?: unknown; type?: unknown; expose?: unknown };
  const raw = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  if (typeof raw !== 'number' || raw < 400 || raw >= 500) return null;
  // `expose` is body-parser's own signal that the error is safe to surface.
  if (candidate.expose !== true) return null;
  const type = typeof candidate.type === 'string' ? candidate.type : '';
  if (type === 'entity.too.large') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' };
  }
  if (type === 'entity.parse.failed') {
    return { status: 400, code: 'MALFORMED_BODY', message: 'Request body could not be parsed' };
  }
  if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
    return { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported request encoding' };
  }
  // Keep our own wording rather than echoing the library's message back.
  return { status: raw, code: 'BAD_REQUEST', message: 'Request could not be processed' };
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
  const clientError = err instanceof HttpError ? null : asClientRequestError(err);

  if (err instanceof HttpError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
    // A 5xx is a server failure whether or not someone wrapped it in an
    // HttpError first. ExternalServiceError was the common case: the client got
    // a 502 and nothing anywhere recorded which upstream broke or why.
    if (status >= 500) {
      log.error(`${code} on ${req.method} ${req.path}`, err);
    } else if (status === 429) {
      log.warn(`Rate limited ${req.method} ${req.path}`, { requestId: req.requestId });
    }
    // Tell the client when to come back instead of making it guess.
    if (err instanceof RateLimitError) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
    }
  } else if (err instanceof ZodError) {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = zodDetails(err);
  } else if (clientError) {
    status = clientError.status;
    code = clientError.code;
    message = clientError.message;
  } else {
    log.error(`Unhandled error on ${req.method} ${req.path}`, err as Error);
  }

  const body: ErrorBody = { error: { code, message }, requestId: req.requestId };
  if (details !== undefined) body.error.details = details;

  res.status(status).json(body);
}
