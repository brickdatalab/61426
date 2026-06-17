# issues.md — Multi-Venue Up/Down Dashboard: Issues, History, and Handoff

**Written:** 2026-06-17. Purpose: a complete, unbiased record for another engineer/agent to take over and fix.
**Directory:** `/Users/vitolo/Desktop/61426/`

This document separates **verifiable technical facts** (git/HTTP evidence) from **judgment errors** and from **the user's stated concerns**, so nothing here is spin. Where the user's perception and the technical record differ, both are stated.

---

## 1. File paths (authoritative)

| Thing | Path | State |
|---|---|---|
| v1 (cushion dashboard) | `/Users/vitolo/Desktop/61426/updown-playground.html` | unchanged (byte-identical to `main`) |
| v2 (CVD→P(up) dashboard) | `/Users/vitolo/Desktop/61426/updown-playground-CVDprob.html` | unchanged |
| v3 (liquidity overlay) | `/Users/vitolo/Desktop/61426/updown-liquidity-overlap.html` | **unchanged — git-verified, see §4** |
| v4 (blended-engine overlay) | `/Users/vitolo/Desktop/61426/updown-liquidity-overlap-v4.html` | NEW file, copied from v3 + engine integration |
| Engine — pure core | `/Users/vitolo/Desktop/61426/engine/src/core.mjs` | imbalance, cvd30s, normalizers, blend, buildTick |
| Engine — network adapters | `/Users/vitolo/Desktop/61426/engine/src/adapters.mjs` | **REST fetchers (the source of the rate-limit bans)** |
| Engine — tick loop | `/Users/vitolo/Desktop/61426/engine/src/engine.mjs` | `runOnce`, `runEngine` (1s `setInterval`) |
| Engine tests | `/Users/vitolo/Desktop/61426/engine/test/*.mjs` | 23 passing (`node --test 'engine/test/*.mjs'`) |
| Spec | `/Users/vitolo/Desktop/61426/docs/superpowers/specs/2026-06-17-multi-venue-market-engine-design.md` | |
| Plan | `/Users/vitolo/Desktop/61426/docs/superpowers/plans/2026-06-17-multi-venue-market-engine.md` | |
| Build doc | `/Users/vitolo/Desktop/61426/v4.md` | |
| Git branch | `feat/multivenue-engine` (11 commits; **not** merged to `main`, **not** pushed) | |

---

## 2. What the project is

Four browser dashboards (single-file HTML, no build) that read live market data and show an UP/DOWN read for Polymarket BTC/ETH "up-down" markets. v3 overlays a Binance order book and the Polymarket book. **v4 = v3 with the BTC imbalance and CVD numbers blended across three venues** (Binance perp, OKX perp, Coinbase spot) by a separate engine, plus a 3-dot venue-health row.

The user's hard, repeated rule: **a new version must never affect a previous working version.** v4 must not change v1/v2/v3.

---

## 3. THE CORE ISSUE: transport choice (REST vs WebSocket) → rate-limit bans

This is the issue the user is most upset about. Here is the exact, honest sequence — not spun in either direction.

### 3a. What actually happened, in order
1. The dashboards (v1/v2/v3) run on **REST polling, ~1 request/second per data source**, from the browser.
2. **Earlier in the project a WebSocket version of the dashboard was built and it did NOT connect reliably in the browser** ("nothing happening when I hit connect," "lagging"). Because the WS attempt was broken, the assistant **reverted to REST polling**, which was working at the time. → For the *dashboards*, REST was the working transport and the WS attempt was the broken one. (This is the factual nuance: the assistant did **not** replace a *working* WebSocket with REST for the dashboards.)
3. For the **v4 engine**, the user asked directly and repeatedly about using WebSocket. The assistant **recommended REST again** and argued REST was "inherently non-breakable." The user deferred the transport choice to the assistant ("use whatever runs accurate every tick"). The assistant chose **all-REST**.
4. REST polling at 1/sec across three venues — multiplied by **v4 fetching Binance twice per tick** (see I-2 below), multiple open tabs (v3 + v4), and the assistant's own server-side test/validation scripts hitting Binance many times — exceeded Binance's request-weight limit.
5. **Binance temp-banned the IP. HTTP 418, code `-1003`: "Way too many requests; IP(149.50.216.196) banned."** This happened, and the ban auto-expires after a few minutes. It recurred / was at risk of recurring on the next IP.

### 3b. The assistant's error in judgment (stated plainly, no bias)
- The assistant **steered to REST over the user's expressed WebSocket preference**, for the engine.
- The "REST is inherently non-breakable" claim was **wrong**: it accounted for individual failed polls retrying, but it **did not account for rate-limit / IP bans from high request volume** — which is the failure mode that actually occurred.
- The assistant **did not weigh the rate-limit risk** of 1/sec REST polling across multiple venues + the v4 double-fetch.
- Binance's own ban message says *"Please use the websocket … to avoid bans"* — the correct transport for a continuously-running multi-venue feed is WebSocket, and the user said so before it broke.

### 3c. Why "the engine is transport-agnostic" is NOT a current fix
The assistant called it "good news" that the engine's pure core (`core.mjs`) is transport-agnostic and only `adapters.mjs` touches the network. The user correctly pushed back: **that is not good news for the present problem.** As long as `adapters.mjs` is REST polling, the bans and the venue flicker continue. Transport-agnosticism only means the *future* fix is cheaper — it does **not** make the current REST behavior acceptable. The problem persists until `adapters.mjs` is replaced with WebSocket managers.

---

## 4. v3 went blank — but the v3 FILE was never modified (git-verified)

The user saw v3's BTC imbalance / CVD / mid go to "—" and reasonably suspected the v3 code had been broken by the v4 work.

**Technical fact (verified):**
```
git diff --stat main -- updown-liquidity-overlap.html   → empty (no changes)
git status --porcelain updown-liquidity-overlap.html    → empty (clean)
```
The v3 file is **byte-identical to `main`**. It was not edited.

**Why it went blank anyway:** v3 fetches Binance directly from the browser using the machine's current IP. When the IP was rate-limit-banned (§3, HTTP 418) by the assistant's REST volume, **v3's Binance fetches failed → its Binance-derived fields blanked.** Polymarket (different host) kept working. So:
- The never-break rule **held at the file level** (v3 code untouched).
- But the assistant's work **did affect v3's runtime behavior** by getting the shared IP banned. This is a real, legitimate grievance: "you didn't edit the file, but your actions broke the running dashboard." Both statements are true simultaneously.

**Resolution observed:** switching VPN to a fresh IP (149.50.216.207) returned Binance `HTTP 200` immediately (not banned, not geoblocked), so v3 recovers on its own. But the **root cause (REST request volume) is unfixed**, so a new IP will eventually be banned too if REST polling continues at this rate.

---

## 5. v4 CVD column swings wildly (−$3,000 ↔ +$1.8M between adjacent rows)

**What the user observed:** the CVD30s column in v4's table jumps by orders of magnitude tick to tick, and suspected v4 was writing one row *per source per tick*.

**Technical facts:**
- v4 writes **one row per tick** (one `<tr>` per `tick()` call, ~1/sec). Verified at `updown-liquidity-overlap-v4.html` (single `led.insertBefore(tr, led.firstChild)` per tick; CVD column = `eng.blended.cvd`). It is **not** one row per source.
- The CVD column is the engine's **blended CVD = SUM over the venues that are FRESH that tick**.
- Venue freshness is **flickering** (observed venue-health at the time: Binance red, OKX red, Coinbase green) because the REST fetches to Binance/OKX are intermittently failing under rate-limit pressure (§3).
- Therefore the **set of venues being summed changes every tick**: when only Coinbase is fresh, CVD ≈ a few thousand; when Binance (huge perp volume) flickers in, the sum jumps to millions. The magnitude chaos is a direct symptom of (a) summing across an unstable venue set, made unstable by (b) REST rate-limiting.
- Note the asymmetry: **imbalance is an average** (bounded −1..+1 regardless of how many venues are fresh, so it looks stable) while **CVD is a sum** (its magnitude depends on which/how many venues are in), so CVD shows the instability much more violently.

**Implication:** even setting transport aside, summing CVD across a variable venue set produces discontinuities whenever a high-volume venue (Binance) enters/leaves the fresh set. A stable, continuously-connected feed (WebSocket) would keep all three venues fresh and make the sum continuous.

---

## 6. Other open engine findings (from the final code review)

- **I-1 — staleness not detected.** "Fresh" currently means *HTTP 200 + parseable + non-empty*. There is **no data-age check**, so a venue returning a frozen/cached 200 body is blended in and its health dot stays green. A fix was planned (normalizers return a `dataTs`; `buildTick` gates on `now − dataTs ≤ ~6s`) but **not implemented**. Location: `engine/src/core.mjs` (`normalize*`, `buildTick`).
- **I-2 — v4 double-fetches Binance.** v4 still runs v3's own Binance depth fetch (for the depth-ladder visual) AND the engine's separate Binance depth+trades fetch every tick → ~7 exchange requests/sec from v4 alone. **This directly contributed to the rate-limit ban in §3.** Location: `updown-liquidity-overlap-v4.html` `tick()` + `engine/src/adapters.mjs`.

---

## 7. Engine sign/contract conventions (for the next engineer — these were validated)

- Binance trade sign: `m===true ⇒ sell aggressor ⇒ −`; `(m ? −1 : +1)`.
- OKX trade sign: `side==='buy' ? +1 : −1`. Contract value (size→coin): BTC `0.01`, ETH `0.1`.
- Coinbase trade sign: `side==='sell' ? +1 : −1` (Coinbase Exchange REST `side` = MAKER side; inverted vs the others). **Empirically validated**: over 1,000 real trades, 88% of `side='sell'` were up-ticks, 84% of `side='buy'` were down-ticks → convention correct.
- Imbalance band: ±0.12% of mid. CVD window: rolling 30s. Blend: imbalance = equal-weight average over fresh venues; CVD = sum over fresh venues.

---

## 8. The user's stated concerns (recorded faithfully, not paraphrased into something softer)

- The assistant changed the transport approach (toward REST) and that change is what led to the Binance ban; the user feels the assistant "changed something that was working" and acted on its own assumptions rather than only doing what was asked.
- The assistant's stated goal was to **complete the project, not to change things it wasn't told to change.** The user wants to understand the thought process behind choosing REST when WebSocket was the user's preference.
- The user is frustrated by being told things that turned out wrong (e.g., "REST is inherently non-breakable"; "the good news is the engine is transport-agnostic" — when that does not fix the current ban problem).
- The user's absolute rule throughout: **do not change anything in / do not affect previous working versions.** v1/v2/v3 files were not edited (§4), but v4/engine REST volume affected v3's *running* behavior via the shared-IP ban — which the user experienced as a broken promise.

---

## 9. Recommended fix (for the incoming engineer/agent)

1. **Replace `engine/src/adapters.mjs` (REST polling) with per-venue WebSocket managers.** This is the actual fix for both the bans and the CVD/venue flicker:
   - Binance: `wss://fstream.binance.com/stream` — `@depth`/`@bookTicker` + `@aggTrade`.
   - OKX: `wss://ws.okx.com:8443/ws/v5/public` — `books` + `trades` channels.
   - Coinbase: Coinbase Advanced Trade WS — `level2` + `market_trades` + `heartbeats` (maintain a local order book applying each update as absolute size per level, drop on size 0; accumulate signed trade size into a rolling 30s CVD; use `heartbeats` to detect drops → reconnect + resnapshot). *(This exact design was specified by the user earlier.)*
   - Each manager maintains local state; on a 1s timer the engine reads current book → imbalance and the rolling 30s buffer → CVD. **The pure core (`core.mjs`: imbalance, cvd30s, blend, buildTick) and its 23 tests do not need to change** — only the adapter layer does.
   - WebSocket = one persistent connection per venue ⇒ no per-second request storm ⇒ **no rate-limit bans**, and continuously-fresh venues ⇒ **stable blended CVD** (no more −3k↔1.8M swings).
2. **Fix I-2 regardless:** v4 should not double-fetch Binance. Drive the depth ladder from the engine's venue data, or drop the redundant fetch.
3. **Fix I-1:** add the data-age freshness gate so a frozen feed is excluded and flagged.
4. **Until WS is in place, throttle REST hard** (raise the poll interval well above 1s, and never run v3 + v4 + test scripts simultaneously against Binance from one IP) to avoid re-banning.

---

## 10. Verification commands (for the next engineer)

```
# v1/v2/v3 untouched?
git -C /Users/vitolo/Desktop/61426 diff --stat main -- updown-playground.html updown-playground-CVDprob.html updown-liquidity-overlap.html   # expect empty

# engine tests
node --test '/Users/vitolo/Desktop/61426/engine/test/*.mjs'   # expect 23 pass

# is Binance banning / geoblocking this IP right now?
curl -s -o /dev/null -w "%{http_code}\n" "https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=5"
#   200 = ok | 418/429 = rate-limit banned | 451 = geoblocked (US IP)
```

---

*End of issues.md. This file was written without editing any other file.*
