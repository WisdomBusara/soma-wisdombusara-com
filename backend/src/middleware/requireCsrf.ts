import type { RequestHandler } from 'express';
import { CSRF_COOKIE } from '../utils/cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireCsrf(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const csrfCookie = String(req.cookies?.[CSRF_COOKIE] ?? '');
    const csrfHeader = String(req.header('x-csrf-token') ?? '');
    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
      return res.status(403).json({ error: 'CSRF validation failed' });
    }
    return next();
  };
}
