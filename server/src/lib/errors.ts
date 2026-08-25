export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class BadRequestError extends HttpError {
  constructor(message = 'Bad request', details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'You do not have access to this resource') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends HttpError {
  constructor(resource = 'Resource') {
    super(404, 'NOT_FOUND', `${resource} not found`);
  }
}

export class ConflictError extends HttpError {
  constructor(message = 'Resource already exists') {
    super(409, 'CONFLICT', message);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(message = 'Payload too large') {
    super(413, 'PAYLOAD_TOO_LARGE', message);
  }
}

export class UnsupportedMediaTypeError extends HttpError {
  constructor(message = 'Unsupported media type') {
    super(415, 'UNSUPPORTED_MEDIA_TYPE', message);
  }
}

export class ValidationError extends HttpError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(422, 'VALIDATION_ERROR', message, details);
  }
}

export class RateLimitError extends HttpError {
  /**
   * Exposed as a field, not just inside `details`, so the error handler can put
   * it in the `Retry-After` header. A 429 without that header leaves every
   * client to guess how long to wait, and the well-behaved ones guess short.
   */
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message = 'Rate limit exceeded') {
    const seconds = Number.isFinite(retryAfterSeconds) ? Math.max(1, Math.ceil(retryAfterSeconds)) : 1;
    super(429, 'RATE_LIMITED', message, { retryAfterSeconds: seconds });
    this.retryAfterSeconds = seconds;
  }
}

export class ExternalServiceError extends HttpError {
  constructor(service: string, message?: string) {
    super(502, 'EXTERNAL_SERVICE_ERROR', message ?? `${service} is unavailable`);
  }
}
