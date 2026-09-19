'use strict';

/**
 * Payment Router — the single shared Paystack webhook entry point for every
 * project using this live account. Paystack only allows one Webhook URL per
 * key, so this exists to fan events back out: verify the signature once,
 * read `data.metadata.project` from the event, and forward the untouched
 * raw request to that project's own webhook handler.
 *
 * Deliberately dependency-free (built-ins only) so deployment is "drop this
 * file, no npm install." Each downstream project keeps doing its own
 * signature verification and business logic — this process never parses
 * more of the event than the project tag, and never calls Paystack's verify
 * API itself.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8099);
const SECRET = process.env.PAYSTACK_SECRET_KEY;
if (!SECRET) {
  console.error('PAYSTACK_SECRET_KEY is required');
  process.exit(1);
}

const ROUTES_FILE = process.env.ROUTES_FILE || path.join(__dirname, 'routes.json');

function loadRoutes() {
  try {
    const raw = fs.readFileSync(ROUTES_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to load routes file at ${ROUTES_FILE}: ${err.message}`);
    return {};
  }
}

let routes = loadRoutes();

// ── Rate limiting ────────────────────────────────────────────────────────
// Fixed-window counter per client IP. Generous by design — the only expected
// caller is Paystack (including its own retries), plus occasional manual
// tests — this exists to blunt abuse, not to police legitimate traffic.
// Checked before the body is even read, so an abusive caller costs almost
// nothing per rejected request.
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10_000);

const hitCounts = new Map(); // ip -> { count, windowStart }

function clientIp(req) {
  // Behind the Cloudflare Tunnel, the real client IP arrives in this header
  // (cloudflared sets it from Cloudflare's edge) — the raw socket address is
  // always cloudflared's own loopback connection, never the actual visitor.
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf);
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const entry = hitCounts.get(ip);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    hitCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

// Periodic cleanup so the map never grows unbounded from one-off callers.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
  for (const [ip, entry] of hitCounts) {
    if (entry.windowStart < cutoff) hitCounts.delete(ip);
  }
}, 60_000).unref();

// SIGHUP reloads the routing table without a restart — adding a new
// downstream project is "edit routes.json, kill -HUP <pid>", no dropped requests.
process.on('SIGHUP', () => {
  routes = loadRoutes();
  console.log(JSON.stringify({ msg: 'routes reloaded', projects: Object.keys(routes) }));
});

function forward(targetUrl, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': headers['content-type'] || 'application/json',
          'x-paystack-signature': headers['x-paystack-signature'],
          'content-length': Buffer.byteLength(body)
        }
      },
      (res) => {
        // Drain the response body so the socket is freed even though we
        // only care about the status code.
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end('method not allowed');
    return;
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    console.warn(JSON.stringify({ msg: 'rate limited', ip }));
    res.writeHead(429, { 'Retry-After': String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) }).end('too many requests');
    req.resume(); // drain and discard the body without processing it
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    const signature = String(req.headers['x-paystack-signature'] || '').toLowerCase();
    const computed = crypto.createHmac('sha512', SECRET).update(raw).digest('hex');

    const sigBuf = Buffer.from(signature);
    const cmpBuf = Buffer.from(computed);
    const valid = sigBuf.length === cmpBuf.length && crypto.timingSafeEqual(sigBuf, cmpBuf);
    if (!valid) {
      console.warn(JSON.stringify({ msg: 'invalid signature, rejected' }));
      res.writeHead(401).end('invalid signature');
      return;
    }

    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      res.writeHead(400).end('invalid json');
      return;
    }

    const project = event && event.data && event.data.metadata && event.data.metadata.project;
    const reference = event && event.data && event.data.reference;

    if (!project) {
      console.warn(JSON.stringify({ msg: 'no project tag in metadata, dropping', reference }));
      res.writeHead(200).end(JSON.stringify({ ok: true }));
      return;
    }

    const target = routes[project];
    if (!target) {
      console.warn(JSON.stringify({ msg: 'no route configured for project', project, reference }));
      res.writeHead(200).end(JSON.stringify({ ok: true }));
      return;
    }

    try {
      const status = await forward(target, raw, req.headers);
      console.log(JSON.stringify({ msg: 'forwarded', project, reference, target, status }));
      res.writeHead(status || 200).end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error(JSON.stringify({ msg: 'forward failed', project, reference, target, error: err.message }));
      // 502 lets Paystack's own retry/backoff pick this up if the downstream
      // was just briefly unavailable, rather than swallowing it silently.
      res.writeHead(502).end(JSON.stringify({ ok: false }));
    }
  });
});

// Loopback-only — reached via the Cloudflare Tunnel's ingress rule, never
// exposed directly, same pattern as the other internal services on this host.
server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ msg: 'payment-router listening', port: PORT, projects: Object.keys(routes) }));
});
