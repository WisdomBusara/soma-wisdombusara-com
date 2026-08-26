import type { RequestHandler } from 'express';
import { ACCESS_COOKIE } from '../utils/cookies';
import { verifyAccessToken } from '../utils/jwt';

export function requireAuth(): RequestHandler {
  return async (req, res, next) => {
    try {
      const token = String(req.cookies?.[ACCESS_COOKIE] ?? '');
      if (!token) return res.status(401).json({ error: 'Unauthorized' });
      const payload = await verifyAccessToken(token);
      req.auth = { userId: payload.sub, sessionId: payload.sid };
      return next();
    } catch {
      return next(Object.assign(new Error('Unauthorized'), { status: 401 }));
    }
  };
}
