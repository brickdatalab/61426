// NODE-ONLY VM client. Talks to the control-API over the pinned self-signed TLS
// endpoint using an undici Agent that trusts exactly our CA (cert pinning). Holds
// the URL + bearer secret server-side; the browser never sees them.
import { Agent, fetch as undiciFetch } from 'undici';

// Accept the CA as literal PEM or base64 (base64 avoids env-UI newline mangling).
function caFromEnv(v?: string): string | undefined {
  if (!v) return undefined;
  return v.includes('BEGIN CERTIFICATE') ? v : Buffer.from(v, 'base64').toString('utf8');
}

let agent: Agent | null = null;
function getAgent(): Agent {
  if (!agent) {
    agent = new Agent({ connect: { ca: caFromEnv(process.env.VM_CA_CERT) } });
  }
  return agent;
}

export type VmResult = { status: number; body: string; contentType: string };

export async function vmRequest(
  path: string,
  opts: { method?: string; body?: string } = {},
): Promise<VmResult> {
  const base = process.env.VM_CONTROL_URL;
  const secret = process.env.VM_CONTROL_SECRET;
  if (!base || !secret) throw new Error('VM_CONTROL_URL / VM_CONTROL_SECRET not configured');
  const headers: Record<string, string> = { Authorization: `Bearer ${secret}` };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await undiciFetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
    dispatcher: getAgent(),
  });
  const body = await res.text();
  return { status: res.status, body, contentType: res.headers.get('content-type') || 'application/json' };
}
