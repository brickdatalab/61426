// TLS front for the control-API. Terminates https on :443 with the pinned
// self-signed server cert and reverse-proxies to the plaintext control-API on
// 127.0.0.1:8790 (which stays localhost-only). The ONLY client is our Vercel
// proxy, which trusts exactly our CA (cert pinning) — stronger than a public CA.
// No external deps: Node https + http only.
import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const CERT = process.env.TLS_CERT || '/home/vincent/61426-runner/tls/server.crt';
const KEY = process.env.TLS_KEY || '/home/vincent/61426-runner/tls/server.key';
const LISTEN = Number(process.env.TLS_PORT || 443);
const TARGET_PORT = Number(process.env.TARGET_PORT || 8790);

const server = https.createServer(
  { cert: readFileSync(CERT), key: readFileSync(KEY) },
  (req, res) => {
    const upstream = http.request(
      { host: '127.0.0.1', port: TARGET_PORT, method: req.method, path: req.url, headers: req.headers },
      (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); },
    );
    upstream.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'control-api unreachable' }));
    });
    req.pipe(upstream); // stream request body (POST /runs) through
  },
);
server.listen(LISTEN, () => console.error(`[tls-proxy] https :${LISTEN} -> 127.0.0.1:${TARGET_PORT}`));
