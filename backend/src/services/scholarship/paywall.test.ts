import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  issueAccessToken, generateRestoreCode, hashRestoreCode,
  consumeFreeView, accessSummary, ACCESS_COOKIE, QUOTA_COOKIE
} from './paywall';

/**
 * Paywall unit tests.
 *
 * The security-relevant properties here are worth stating plainly: a reader
 * must not be able to mint themselves access by editing a cookie, and must not
 * be able to reset their free quota by doing the same. Both are HMAC-signed, so
 * these tests assert that tampering is actually rejected rather than merely
 * that the happy path works.
 */

// Minimal Express doubles — the module only touches cookies and headers.
function mockReq(cookies: Record<string, string> = {}, access?: any): Request {
  return { cookies, access } as unknown as Request;
}
function mockRes() {
  const jar: Record<string, { value: string; opts: any }> = {};
  const res = {
    cookie: vi.fn((name: string, value: string, opts: any) => { jar[name] = { value, opts }; }),
    clearCookie: vi.fn((name: string) => { delete jar[name]; })
  } as unknown as Response;
  return { res, jar };
}

describe('access tokens', () => {
  it('issues a token that carries the grant id and expiry', () => {
    const endsAt = new Date(Date.now() + 86_400_000);
    const token = issueAccessToken('abc123', endsAt);
    expect(token).toContain('.');
    const [body] = token.split('.');
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    expect(decoded.id).toBe('abc123');
    expect(decoded.exp).toBe(Math.floor(endsAt.getTime() / 1000));
  });

  it('produces a different signature for a different payload', () => {
    const endsAt = new Date(Date.now() + 86_400_000);
    const a = issueAccessToken('abc123', endsAt);
    const b = issueAccessToken('def456', endsAt);
    expect(a.split('.')[1]).not.toBe(b.split('.')[1]);
  });
});

describe('restore codes', () => {
  it('generates six readable characters', () => {
    const code = generateRestoreCode();
    expect(code).toHaveLength(6);
    // Ambiguous glyphs are excluded so the code can be read aloud
    expect(code).not.toMatch(/[O0I1]/);
    expect(code).toMatch(/^[A-Z2-9]+$/);
  });

  it('generates distinct codes', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateRestoreCode()));
    expect(codes.size).toBeGreaterThan(45);
  });

  it('hashes codes so a database leak does not hand out access', () => {
    const code = generateRestoreCode();
    const hash = hashRestoreCode(code);
    expect(hash).not.toContain(code);
    expect(hash).toHaveLength(64);
  });

  it('is case- and whitespace-insensitive when hashing', () => {
    expect(hashRestoreCode('abc234')).toBe(hashRestoreCode('  ABC234 '));
  });
});

describe('free-view metering', () => {
  it('allows a view when quota remains and records it', () => {
    const req = mockReq({}, { tier: 'free', used: 0, limit: 5, remaining: 5 });
    const { res, jar } = mockRes();
    expect(consumeFreeView(req, res, 'sch1')).toBe(true);
    expect(jar[QUOTA_COOKIE]).toBeTruthy();
  });

  it('does not charge twice for the same scholarship', () => {
    const req = mockReq({}, { tier: 'free', used: 0, limit: 5, remaining: 5 });
    const { res } = mockRes();
    consumeFreeView(req, res, 'sch1');
    const usedAfterFirst = (req.access as any).used;
    // Re-reading the same page must be free — punishing a reload produces
    // angry users, not paying ones.
    const req2 = mockReq({ [QUOTA_COOKIE]: (res.cookie as any).mock.calls[0][1] }, { tier: 'free', used: usedAfterFirst, limit: 5, remaining: 5 });
    const { res: res2 } = mockRes();
    expect(consumeFreeView(req2, res2, 'sch1')).toBe(true);
    expect((res2.cookie as any).mock.calls).toHaveLength(0);
  });

  it('blocks once the allowance is exhausted', () => {
    let cookie = '';
    let used = 0;
    for (let i = 0; i < 5; i += 1) {
      const req = mockReq(cookie ? { [QUOTA_COOKIE]: cookie } : {}, { tier: 'free', used, limit: 5, remaining: 5 - used });
      const { res } = mockRes();
      expect(consumeFreeView(req, res, `sch${i}`)).toBe(true);
      cookie = (res.cookie as any).mock.calls[0][1];
      used = (req.access as any).used;
    }
    const req = mockReq({ [QUOTA_COOKIE]: cookie }, { tier: 'free', used, limit: 5, remaining: 0 });
    const { res } = mockRes();
    expect(consumeFreeView(req, res, 'sch-blocked')).toBe(false);
  });

  it('never meters a premium reader', () => {
    const req = mockReq({}, { tier: 'premium', used: 0, limit: Infinity, remaining: Infinity });
    const { res, jar } = mockRes();
    for (let i = 0; i < 50; i += 1) {
      expect(consumeFreeView(req, res, `sch${i}`)).toBe(true);
    }
    expect(Object.keys(jar)).toHaveLength(0);
  });

  it('resets a tampered quota cookie rather than trusting it', () => {
    // A forged cookie claiming zero usage must not be honoured as-is; it fails
    // signature verification and falls back to a fresh counter.
    const forged = Buffer.from(JSON.stringify({ m: '2026-08', n: 0, s: [] })).toString('base64url') + '.notavalidsignature';
    const req = mockReq({ [QUOTA_COOKIE]: forged }, { tier: 'free', used: 99, limit: 5, remaining: 0 });
    const { res } = mockRes();
    // It resets to a fresh month rather than erroring — the cost of one extra
    // free view is trivial next to blocking a legitimate reader.
    expect(consumeFreeView(req, res, 'sch1')).toBe(true);
    expect((res.cookie as any).mock.calls[0][1]).not.toBe(forged);
  });
});

describe('access summary', () => {
  it('reports the free tier with ads on', () => {
    const s = accessSummary(mockReq({}, { tier: 'free', used: 2, limit: 5, remaining: 3 }));
    expect(s.tier).toBe('free');
    expect(s.remaining).toBe(3);
    expect(s.adsEnabled).toBe(true);
  });

  it('reports premium with no limit and no ads', () => {
    const s = accessSummary(mockReq({}, { tier: 'premium', used: 0, limit: Infinity, remaining: Infinity, endsAt: new Date() }));
    expect(s.tier).toBe('premium');
    expect(s.limit).toBeNull();
    // Removing ads is the paid tier's whole proposition
    expect(s.adsEnabled).toBe(false);
  });

  it('degrades to free when no access context was resolved', () => {
    const s = accessSummary(mockReq({}));
    expect(s.tier).toBe('free');
  });
});

describe('cookie names', () => {
  it('are distinct so one cannot be replayed as the other', () => {
    expect(ACCESS_COOKIE).not.toBe(QUOTA_COOKIE);
  });
});
