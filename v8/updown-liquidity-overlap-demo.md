# `updown-liquidity-overlap-demo.html` — Lock-in + Reversal Warning Demo

## Summary

A feature-augmented variant of the v8 production dashboard that adds real-time **lock-in detection** and **reversal warnings** to the Score panel. The underlying v8 signal engine (`src/signals.mjs`) is untouched — this is a display-layer addition only. All logging, VM posting, and continuous-run behavior is preserved identically to the production dashboard.

## Why This Feature Exists

### The Problem

The v8 signal engine's per-tick count of UP / DOWN / MIXED signals is a strong post-hoc predictor of settlement direction. Across 167 v8 bars (2026-07-09 pooled):

| Running leader at end-of-bar | Settles in agreement |
|---|---|
| UP dominant | 96.6% |
| DOWN dominant | 89.2% |
| MIXED dominant | 68.6% UP / 31.4% DOWN |

However, ~6% of direction-dominant bars **disagree** with settlement. Analysis of all 10 disagreement bars (the "reversal bars") revealed a single common pattern:

1. The cushion drives one way for 50–80% of the bar, accumulating a large tally lead
2. The cushion reverses direction late (mean: 70 REM remaining, range 0–99)
3. The running tally is already **mathematically locked** — the lead exceeds remaining ticks
4. The signal engine emits the new direction, but the tally cannot catch up
5. The final dominant count disagrees with settlement

The tally is a lagging indicator. It tracks accumulated history — not current price direction. When price reverses late, the tally stays wrong.

### The Solution

Two simple arithmetic checks, run every tick with zero performance cost:

1. **Lock-in check**: `abs(up - down) > remaining_ticks` — is the tally leader unflippable?
2. **Direction-flip check**: did the per-tick signal change direction (UP→DOWN or DOWN→UP, ignoring MIXED) while the tally was locked?

When both conditions are true, the dashboard flags a **REVERSAL WARNING**. This means: "the bar's final dominant count will disagree with where price is heading."

### Empirical Validation

Across all 167 v8 bars:

- **85 of 167 bars** (51%) have at least one signal direction flip
- **25 bars** have a locked last-flip (tally was locked when the flip happened)
  - 8 of these 25 are reversal bars (true positives — precision 32%)
  - 12 of the 17 false positives are MIXED-dominant bars (no directional settlement to be wrong about)
  - Filtering to direction-dominant bars only: **8/14 = 57% precision**
- **Recall**: 8 of 10 reversal bars caught (80%)
- The 2 missed reversals: one had zero signal flips (UP=0 → no direction to flip FROM), one flipped while NOT locked

## How It Works — Code Architecture

### Six Change Zones

Every change is additive, inside the demo file only. No changes to `src/signals.mjs` or any other file.

---

### Zone 1: CSS (before `</style>`)

```css
.lockbadge  { display:none; ... yellow bg, yellow border }
.lockbadge.show  { display:block }
.revbadge   { display:none; ... red bg, red border, pulsing animation }
.revbadge.show   { display:block; animation:revpulse 2s infinite }
@keyframes revpulse { 0%,100%{opacity:1} 50%{opacity:.55} }
```

Both badges are `display:none` by default. JS adds/removes the `.show` class.

---

### Zone 2: HTML (below Score panel)

```html
<div class="lockbadge" id="lockBadge">LOCKED — tally leader cannot be overtaken</div>
<div class="revbadge" id="revBadge">REVERSAL: direction flipped while tally was locked</div>
```

Placed below the Score panel's three-number grid. Hidden until JS activates them.

---

### Zone 3: State Initialization (in `start()`, inside `st={...}`)

```
upCount: 0,
downCount: 0,
mixedCount: 0,
lastDirSig: null,         // last non-MIXED signal emitted
locked: false,            // is tally mathematically locked?
reversalWarning: false,   // did a direction flip happen while locked?
reversalWarningRem: null, // REM value at which the warning fired
```

All counters and flags reset to zero/null on every bar start.

---

### Zone 4: Per-Tick Logic (in `tickBody()`, after `const sig = dr.sig`)

```javascript
// 1. Increment running tally
if (sig === 'UP') st.upCount++;
else if (sig === 'DOWN') st.downCount++;
else st.mixedCount++;

// 2. Lock-in check
const lead = Math.abs(st.upCount - st.downCount);
const remainingTicks = Math.round(rem);
st.locked = lead > remainingTicks;

// 3. Direction-flip detector (fires once per bar)
if (!st.reversalWarning &&                       // already warned? skip
    (sig === 'UP' || sig === 'DOWN') &&           // current tick is directional
    st.lastDirSig &&                              // we have a prior direction
    sig !== st.lastDirSig &&                      // direction changed
    st.locked) {                                  // tally is locked
  st.reversalWarning = true;
  st.reversalWarningRem = remainingTicks;
}

// 4. Update last-direction tracker
if (sig === 'UP' || sig === 'DOWN') st.lastDirSig = sig;
```

This runs after the signal engine produces `sig` but before any display updates. Zero network calls, zero DOM queries, pure arithmetic.

Key design decisions:
- `remainingTicks` uses `Math.round(rem)` (REM seconds) — each tick maps ~1:1 to remaining seconds
- `st.locked` can change from false to true (as lead grows), but once true it stays true for the remainder of the bar (lead grows while remaining shrinks)
- `st.reversalWarning` fires **once** per bar (the `!st.reversalWarning` guard). Only the FIRST direction flip while locked is flagged

---

### Zone 5: Score Panel Rendering (`renderScore()`)

Two changes from the original:

**a) Live counts instead of Array.filter():**
```javascript
// OLD: const up = rows.filter(r => r.signal === 'UP').length;
// NEW: const up = st.upCount || 0;
```
The old version re-scanned `st.log` on every tick. The new version uses the live counters — faster and simpler.

**b) Badge show/hide:**
```javascript
const lb = $('#lockBadge'), rb = $('#revBadge');
if (lb) {
  if (st.locked) {
    lb.textContent = 'LOCKED — lead X > Y remaining';
    lb.classList.add('show');
  } else {
    lb.classList.remove('show');
  }
}
if (rb) {
  if (st.reversalWarning) {
    rb.textContent = 'REVERSAL: prevDir→currDir at REM ' + st.reversalWarningRem + ' while locked';
    rb.classList.add('show');
  } else {
    rb.classList.remove('show');
  }
}
```

---

### Zone 6: Settle Reset (in `settle()`)

```javascript
if (st) {
  st.upCount = st.downCount = st.mixedCount = 0;
  st.lastDirSig = null;
  st.locked = false;
  st.reversalWarning = false;
  st.reversalWarningRem = null;
}
```

Resets all lock-in state before the continuous-run auto-advance starts the next bar. Without this, the badges could persist across bars.

---

## What Is NOT Changed

The following systems work identically to the production dashboard:

- **Signal engine** (`src/signals.mjs`) — no imports, CFG, or function changed
- **WebSocket connections** — Binance fstream + ourWebSocket VM unchanged
- **Log persistence** — `saveLog()` writes to localStorage every tick
- **VM log posting** — `postLogToVM()` fires on settle
- **Log download** — `downloadLog()` exports full JSON with all tick fields
- **Continuous runs** — auto-advance to next bar identical
- **Charts** — CVD, flow, imbalance, cushion all unchanged
- **Prompt box** — copy-to-Claude feature unchanged
- **Session threads** — sidebar history unchanged
- **Web Worker ticker** — background-proof 1s loop unchanged

## Visual Behavior

### Before any condition is met
No badges visible. Score panel shows UP / DOWN / MIXED counts normally.

### When tally is locked (LOCKED badge — yellow)
- Appears under the Score panel
- Text: "LOCKED — lead X > Y remaining"
- Stays visible until bar ends (once locked, always locked)
- Appears on average at REM ≈ 106 (64.3% through the bar)
- Earliest lock-in observed: REM 148 (50.3% through)

### When reversal is detected (REVERSAL badge — red, pulsing)
- Appears under the LOCKED badge
- Text: "REVERSAL: UP→DOWN at REM 42 while locked"
- Pulses red: 1s on, 1s dim (CSS keyframe `revpulse`)
- Fires once per bar, stays until settle
- Indicates: the bar's final dominant direction will likely disagree with settlement

## File Relationship

```
v8/
├── updown-liquidity-overlap.html          ← Production dashboard (original)
├── updown-liquidity-overlap-demo.html     ← Demo with lock-in warnings (this file)
├── updown-liquidity-overlap-demo.md      ← This document
├── src/signals.mjs                        ← Signal engine (shared, untouched)
├── test/signals.test.mjs                  ← Node tests
├── analysis/                              ← Replay/compare tooling
└── README.md                              ← v8 version README
```

## Promotion Path

To promote the demo to production:

```bash
# Option A: swap (replace production)
cd v8
cp updown-liquidity-overlap.html updown-liquidity-overlap-original.html
cp updown-liquidity-overlap-demo.html updown-liquidity-overlap.html

# Option B: run both as variants
# No file changes needed — just use different URLs:
#   http://localhost:XXXX/v8/updown-liquidity-overlap.html       (original)
#   http://localhost:XXXX/v8/updown-liquidity-overlap-demo.html  (with warnings)
```

## Running

```bash
python3 -m http.server 5173
# or any port you prefer

# Open: http://localhost:<port>/v8/updown-liquidity-overlap-demo.html
```

Connect to any BTC/ETH 5m or 15m market. The badges will activate during the bar as counts accumulate and conditions are met.
