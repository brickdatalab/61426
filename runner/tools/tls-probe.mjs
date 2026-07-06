// Proves the pinned-CA path in isolation, using the EXACT undici Agent code the
// Vercel proxy (web/lib/vm.ts) + /api/health will use. Run before building web/:
//   VM_CONTROL_URL=https://<ip> VM_CONTROL_SECRET=... VM_CA_CERT=<pem-or-base64> node runner/tools/tls-probe.mjs
// De-risks the one bespoke integration: a custom CA in a serverless fetch, with IP-SAN validation.
import { Agent } from 'undici';

// Shared with web/: accept the CA as literal PEM or base64 (base64 avoids env-UI newline mangling).
export function caFromEnv(v) {
  if (!v) return undefined;
  return v.includes('BEGIN CERTIFICATE') ? v : Buffer.from(v, 'base64').toString('utf8');
}

const base = process.env.VM_CONTROL_URL;
const secret = process.env.VM_CONTROL_SECRET;
const ca = caFromEnv(process.env.VM_CA_CERT);
if (!base || !secret || !ca) { console.error('need VM_CONTROL_URL, VM_CONTROL_SECRET, VM_CA_CERT'); process.exit(2); }

const agent = new Agent({ connect: { ca } });
const t0 = Date.now();
const r = await fetch(`${base}/runs`, { headers: { Authorization: `Bearer ${secret}` }, dispatcher: agent });
const body = await r.text();
console.log(`authed   /runs -> ${r.status} (${Date.now() - t0}ms) ${body.slice(0, 100)}`);
const r2 = await fetch(`${base}/runs`, { dispatcher: agent });
console.log(`unauthed /runs -> ${r2.status} (expect 401)`);
const ok = r.status === 200 && r2.status === 401;
console.log(ok ? 'PINNED-CA PATH OK (cert validated via IP SAN + our CA)' : 'PINNED-CA PATH FAILED');
process.exit(ok ? 0 : 1);
