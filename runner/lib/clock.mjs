// Monotonic wall-clock 1s scheduler + gap policy.
// Gap policy: never double-tick, never fabricate/backfill rows, always record the real gap.

export function remFor(nowMs, barEndEpochSec) {
  return Math.max(0, barEndEpochSec - Math.floor(nowMs / 1000));
}

export function gapSeconds(prevSec, nowSec) {
  return nowSec - prevSec;
}

export class Scheduler {
  constructor({ now = Date.now, setTimer = setTimeout } = {}) {
    this._now = now;
    this._setTimer = setTimer;
    this._cb = null;
    this._lastSec = null;
  }

  onSecond(cb) {
    this._cb = cb;
  }

  start() {
    this._lastSec = Math.floor(this._now() / 1000);
    this._arm();
  }

  _arm() {
    const nowMs = this._now();
    const nextBoundaryMs = (Math.floor(nowMs / 1000) + 1) * 1000;
    const delay = nextBoundaryMs - nowMs;
    this._setTimer(() => this._fire(), delay);
  }

  _fire() {
    const sec = Math.floor(this._now() / 1000);
    const gapSec = gapSeconds(this._lastSec, sec);
    this._lastSec = sec;
    if (this._cb) this._cb({ sec, gapSec });
    this._arm();
  }
}
