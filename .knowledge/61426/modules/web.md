# Web Control Plane

The `web/` directory is a Next.js 14 App Router application deployed independently to Vercel. It does not run the engine and does not consume Binance directly. It is a password-gated viewer/control surface for the VM runner.

## Authentication

`web/app/api/login/route.ts` performs a constant-time password comparison, applies an in-memory per-IP attempt limit, and issues a seven-day secure HTTP-only `session` cookie. `web/lib/session.ts` signs and verifies `v1.<expiry>.<HMAC>` tokens using WebCrypto. `web/middleware.ts` runs in the Edge runtime and protects all non-login paths, returning JSON 401s for API calls and redirecting browser requests to `/login`.

## VM proxy

`web/app/api/vm/[...path]/route.ts` exposes only the runner paths listed in its allowlist: runs, run rows, and logs. It calls `web/lib/vm.ts`, which performs the server-side request to the VM control URL, injects the bearer secret, and uses the pinned CA certificate for TLS. The browser therefore never receives the VM endpoint, bearer secret, or CA.

The health route calls the same server-side path and reports status plus latency (`web/app/api/health/route.ts`).

## UI relay behavior

The dashboard uses polling rather than a browser WebSocket to the VM. Run controls POST/DELETE through `/api/vm/...`; live run views poll rows; the log sidebar polls the allowlisted logs endpoint. This keeps VM credentials and TLS details server-side and makes the UI a thin viewer/control layer.

