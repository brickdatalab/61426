// Control API: authed HTTP surface the Vercel app proxies to. No framework —
// node:http + a tiny path router. Every route requires
// `Authorization: Bearer <secret>`, compared with crypto.timingSafeEqual
// (length-guarded first so mismatched lengths never throw or leak timing).
//
// createApp() returns both a testable `inject(method, path, {auth, body})` seam
// and a real `listen(port)` for production. Additive only.

import http from 'node:http';
import crypto from 'node:crypto';

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkAuth(secret, authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice('Bearer '.length);
  return timingSafeEqualStr(token, secret);
}

// Route table: [method, regex, handler(match, body, query)]
function buildRoutes(orchestrator) {
  return [
    ['POST', /^\/runs$/, async (_m, body) => {
      const { version, slug, continuous, ab } = body || {};
      if (!version || !slug) return { status: 400, json: { error: 'version and slug are required' } };
      const runId = await orchestrator.start({ version, slug, continuous: continuous ?? 0, ab: !!ab });
      return { status: 200, json: { runId } };
    }],
    ['DELETE', /^\/runs\/([^/]+)$/, async (m) => {
      const ok = orchestrator.stop(m[1]);
      if (!ok) return { status: 404, json: { error: 'not found' } };
      return { status: 200, json: { ok: true } };
    }],
    ['GET', /^\/runs$/, async () => ({ status: 200, json: orchestrator.list() })],
    ['GET', /^\/runs\/([^/]+)\/rows$/, async (m, _body, query) => {
      const rows = orchestrator.rows(m[1], Number(query.since ?? 0));
      if (rows === null) return { status: 404, json: { error: 'not found' } };
      return { status: 200, json: rows };
    }],
    ['GET', /^\/logs$/, async () => ({ status: 200, json: orchestrator.logs() })],
    ['GET', /^\/logs\/([^/]+)$/, async (m) => {
      const log = orchestrator.readLog(m[1]);
      if (!log) return { status: 404, json: { error: 'not found' } };
      return { status: 200, json: log };
    }],
  ];
}

export function createApp({ secret, orchestrator }) {
  const routes = buildRoutes(orchestrator);

  async function handle(method, urlStr, authHeader, body) {
    if (!checkAuth(secret, authHeader)) {
      return { status: 401, json: { error: 'unauthorized' } };
    }
    const url = new URL(urlStr, 'http://internal');
    const query = Object.fromEntries(url.searchParams);
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const match = url.pathname.match(re);
      if (match) return fn(match, body, query);
    }
    return { status: 404, json: { error: 'not found' } };
  }

  // Test seam: no sockets, no serialization round-trip beyond JSON body/response.
  async function inject(method, path, { auth, body } = {}) {
    const authHeader = auth != null ? `Bearer ${auth}` : undefined;
    try {
      const result = await handle(method, path, authHeader, body);
      return { status: result.status, json: result.json };
    } catch (err) {
      // Match the server() path: a throwing orchestrator method is a clean 500,
      // not an unhandled rejection.
      return { status: 500, json: { error: String((err && err.message) || err) } };
    }
  }

  function server() {
    return http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        let body;
        if (chunks.length) {
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = undefined; }
        }
        try {
          const result = await handle(req.method, req.url, req.headers.authorization, body);
          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.json));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err && err.message || err) }));
        }
      });
    });
  }

  let _server = null;
  function listen(port, host, cb) {
    if (typeof host === 'function') { cb = host; host = undefined; } // back-compat: listen(port, cb)
    _server = server();
    return _server.listen(port, host, cb); // host='127.0.0.1' binds localhost only (never 0.0.0.0)
  }
  function close(cb) {
    if (_server) _server.close(cb);
    else if (cb) cb();
  }

  return { inject, listen, close };
}
