import type { ErrorRequestHandler } from 'express';
import { logger } from '../config/logger';

export function errorHandler() {
  const handler: ErrorRequestHandler = (err, _req, res, _next) => {
    logger.error({ err }, 'Unhandled error');
    const status = typeof err?.status === 'number' ? err.status : 500;
    const message = status >= 500 ? 'Internal server error' : String(err?.message ?? 'Request failed');
    res.status(status).json({ error: message });
  };
  return handler;
}
