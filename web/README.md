# 61426 web — Vercel control app

Password-gated Next.js (App Router) control panel + viewer for the VM engine runner.
It never runs the engine; it drives the VM control-API over a **pinned self-signed TLS**
endpoint (the browser never sees the VM URL/secret/CA — all server-side).

## Import to Vercel
1. Import the `brickdatalab/61426` repo.
2. **Root Directory = `web`**, Framework preset = **Next.js**, all other settings **default**.
3. Set these Environment Variables (values handed over separately — never in the repo):
   - `APP_PASSWORD` — the login password (rotate any previously-shared value)
   - `SESSION_SECRET` — `openssl rand -hex 32`
   - `VM_CONTROL_URL` — `https://<vm-static-ip>`
   - `VM_CONTROL_SECRET` — the VM control-API bearer secret
   - `VM_CA_CERT` — the VM's CA (base64 recommended, or literal PEM)
4. Deploy. First check: open `/api/health` (after logging in) — it does the real pinned-CA
   fetch to the VM and returns `{ ok, latencyMs }`, turning any TLS/env misconfig into a
   readable error instead of a blank viewer.

## Architecture
- `middleware.ts` — Edge runtime; guards every route; verifies the session cookie via WebCrypto (no node:crypto on Edge).
- `app/api/login` — Node runtime; constant-time password check (`crypto.timingSafeEqual`) + in-memory rate limit; sets a signed httpOnly cookie.
- `app/api/vm/[...path]` — Node runtime; server-side proxy to the VM control-API using an undici `Agent` with the pinned CA; injects the bearer secret; path allowlist.
- `app/api/health` — Node runtime; proves the pinned-CA path inside Vercel's serverless runtime.
- `app/page.tsx` + `components/*` — minimal Phase-1 viewer (live signal, early call, rem, tick-health, staleness) + per-version log sidebar; visibility-aware polling.

## Local dev
```
cp .env.example .env.local   # fill in real values
npm install
npm run dev                  # http://localhost:3000
```
