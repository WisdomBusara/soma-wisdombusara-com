import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../config/env';

const encoder = new TextEncoder();
const accessSecret = encoder.encode(env.JWT_ACCESS_SECRET);
const refreshSecret = encoder.encode(env.JWT_REFRESH_SECRET);

export type AccessTokenPayload = { sub: string; sid: string; typ: 'access' };
export type RefreshTokenPayload = { sub: string; sid: string; typ: 'refresh'; jti: string };

const AUDIENCE = 'admin';

export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
  return new SignJWT({ sid: payload.sid, typ: payload.typ })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(accessSecret);
}

export async function signRefreshToken(payload: RefreshTokenPayload): Promise<string> {
  return new SignJWT({ sid: payload.sid, typ: payload.typ, jti: payload.jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(refreshSecret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, accessSecret, { issuer: env.JWT_ISSUER, audience: AUDIENCE });
  return coerceAccessPayload(payload);
}

export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
  const { payload } = await jwtVerify(token, refreshSecret, { issuer: env.JWT_ISSUER, audience: AUDIENCE });
  return coerceRefreshPayload(payload);
}

function coerceAccessPayload(payload: JWTPayload): AccessTokenPayload {
  const sub = String(payload.sub ?? '');
  const sid = String((payload as any).sid ?? '');
  const typ = String((payload as any).typ ?? '');
  if (!sub || !sid || typ !== 'access') throw Object.assign(new Error('Invalid access token'), { status: 401 });
  return { sub, sid, typ: 'access' };
}

function coerceRefreshPayload(payload: JWTPayload): RefreshTokenPayload {
  const sub = String(payload.sub ?? '');
  const sid = String((payload as any).sid ?? '');
  const typ = String((payload as any).typ ?? '');
  const jti = String((payload as any).jti ?? '');
  if (!sub || !sid || !jti || typ !== 'refresh') throw Object.assign(new Error('Invalid refresh token'), { status: 401 });
  return { sub, sid, jti, typ: 'refresh' };
}
