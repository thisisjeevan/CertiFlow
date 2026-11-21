import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';

export interface FieldIssue {
  row: number;
  field: string;
  message: string;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly issues?: readonly FieldIssue[],
  ) {
    super(message);
  }
}

export function requireSameOriginType(origin: string, contentType: string): RequestHandler {
  return (req, _res, next) => {
    const requestOrigin = req.get('Origin');
    if (requestOrigin && requestOrigin !== origin) {
      throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'The request origin is not allowed.');
    }
    if (!req.is(contentType)) {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use ' + contentType + '.');
    }
    next();
  };
}

export const requestId: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Request-Id', randomUUID());
  next();
};

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, 'NOT_FOUND', 'The requested resource was not found.'));
};

export const handleError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message, issues: error.issues } });
    return;
  }

  if (typeof error === 'object' && error !== null && 'type' in error) {
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must contain valid JSON.' } });
      return;
    }
    if (error.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Request body is too large.' } });
      return;
    }
    if (error.type === 'charset.unsupported' || error.type === 'encoding.unsupported') {
      res.status(415).json({ error: { code: 'UNSUPPORTED_ENCODING', message: 'Request encoding is unsupported.' } });
      return;
    }
  }

  console.error(JSON.stringify({
    event: 'request_failed',
    requestId: res.getHeader('X-Request-Id'),
    error: error instanceof Error ? error.name : 'UnknownError',
  }));
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
};
