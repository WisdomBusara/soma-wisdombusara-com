import type { Response } from 'express';
import { env } from '../config/env';

export const ACCESS_COOKIE = 'wraith_access';
export const REFRESH_COOKIE = 'wraith_refresh';
export const CSRF_COOKIE = 'wraith_csrf';

function sameSite(): 'lax' | 'strict' | 'none' {
  switch (env.COOKIE_SAMESITE) {
    case 'STRICT': return 'strict';
    case 'NONE': return 'none';
    default: return 'lax';
  }
}

export function setAuthCookies(res: Response, opts: { accessToken: string; refreshToken: string; csrfToken: string }) {
  const common = { secure: env.COOKIE_SECURE, sameSite: sameSite() as any, path: '/', domain: undefined as string | undefined };
  res.cookie(ACCESS_COOKIE, opts.accessToken, { ...common, httpOnly: true, maxAge: 15 * 60 * 1000 });
  res.cookie(REFRESH_COOKIE, opts.refreshToken, { ...common, httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
  res.cookie(CSRF_COOKIE, opts.csrfToken, { ...common, httpOnly: false, maxAge: 7 * 24 * 60 * 60 * 1000 });
}

export function clearAuthCookies(res: Response) {
  const common = { secure: env.COOKIE_SECURE, sameSite: sameSite() as any, path: '/' };
  res.clearCookie(ACCESS_COOKIE, { ...common, httpOnly: true });
  res.clearCookie(REFRESH_COOKIE, { ...common, httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...common, httpOnly: false });
}
