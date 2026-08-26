import rateLimit from 'express-rate-limit';
import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { AdminUserModel } from '../models/AdminUser';
import { RefreshSessionModel } from '../models/RefreshSession';
import { requireAuth } from '../middleware/requireAuth';
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from '../utils/cookies';
import { createCsrfToken } from '../utils/csrf';
import { sha256Base64 } from '../utils/hash';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { verifyPassword } from '../utils/password';

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

export function authRouter() {
  const router = Router();

  router.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const body = loginBodySchema.parse(req.body);
      const email = body.email.toLowerCase();
      const user = await AdminUserModel.findOne({ email });
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      if (!user.isActive) return res.status(403).json({ error: 'Account is disabled' });
      const now = new Date();
      if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) return res.status(423).json({ error: 'Account temporarily locked' });
      const ok = await verifyPassword(user.passwordHash, body.password);
      if (!ok) {
        user.loginFailures += 1;
        if (user.loginFailures >= 5) user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
        await user.save();
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      user.loginFailures = 0;
      user.lockedUntil = undefined;
      user.lastLoginAt = now;
      await user.save();
      const sessionId = nanoid(24);
      const refreshJti = nanoid(24);
      const accessToken = await signAccessToken({ sub: String(user._id), sid: sessionId, typ: 'access' });
      const refreshToken = await signRefreshToken({ sub: String(user._id), sid: sessionId, typ: 'refresh', jti: refreshJti });
      const csrfToken = createCsrfToken();
      await RefreshSessionModel.create({ userId: user._id, sessionId, refreshTokenHash: sha256Base64(refreshToken), userAgent: String(req.get('user-agent') ?? ''), ip: String(req.ip ?? ''), lastUsedAt: now, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
      setAuthCookies(res, { accessToken, refreshToken, csrfToken });
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const refreshToken = String(req.cookies?.[REFRESH_COOKIE] ?? '');
      if (refreshToken) {
        try {
          const payload = await verifyRefreshToken(refreshToken);
          await RefreshSessionModel.updateOne({ sessionId: payload.sid, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
        } catch { }
      }
      clearAuthCookies(res);
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  router.get('/me', requireAuth(), async (req, res, next) => {
    try {
      const user = await AdminUserModel.findById(req.auth!.userId).lean();
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      return res.json({ id: String(user._id), email: user.email });
    } catch (err) { return next(err); }
  });

  router.post('/refresh', async (req, res, next) => {
    try {
      const refreshToken = String(req.cookies?.[REFRESH_COOKIE] ?? '');
      if (!refreshToken) return res.status(401).json({ error: 'Unauthorized' });
      const payload = await verifyRefreshToken(refreshToken);
      const session = await RefreshSessionModel.findOne({ sessionId: payload.sid });
      if (!session || session.revokedAt) return res.status(401).json({ error: 'Unauthorized' });
      const tokenHash = sha256Base64(refreshToken);
      if (session.refreshTokenHash !== tokenHash) {
        session.revokedAt = new Date();
        await session.save();
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const newJti = nanoid(24);
      const newRefreshToken = await signRefreshToken({ sub: payload.sub, sid: payload.sid, typ: 'refresh', jti: newJti });
      const newAccessToken = await signAccessToken({ sub: payload.sub, sid: payload.sid, typ: 'access' });
      const newCsrf = createCsrfToken();
      session.refreshTokenHash = sha256Base64(newRefreshToken);
      session.lastUsedAt = new Date();
      session.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await session.save();
      setAuthCookies(res, { accessToken: newAccessToken, refreshToken: newRefreshToken, csrfToken: newCsrf });
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  return router;
}
