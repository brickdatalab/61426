// Monotonic wall-clock 1s scheduler + gap policy.
// Gap policy: never double-tick, never fabricate/backfill rows, always record the real gap.

export function remFor(nowMs, barEndEpochSec) {
  return Math.max(0, barEndEpochSec - Math.floor(nowMs / 1000));
}

export function gapSeconds(prevSec, nowSec) {
  return nowSec - prevSec;
}

export class Scheduler {
  constructor({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._cb = null;
    this._lastSec = null;
    this._active = false;
    this._timer = null;
  }

  onSecond(cb) {
    this._cb = cb;
  }

  start() {
    this._active = true;
    this._lastSec = Math.floor(this._now() / 1000);
    this._arm();
  }

  // Cancel the pending tick and refuse to arm further ones. Idempotent.
  stop() {
    this._active = false;
    if (this._timer != null) {
      this._clearTimer(this._timer);
      this._timer = null;
    }
  }

  _arm() {
    if (!this._active) return;
    const nowMs = this._now();
    const nextBoundaryMs = (Math.floor(nowMs / 1000) + 1) * 1000;
    const delay = nextBoundaryMs - nowMs;
    this._timer = this._setTimer(() => this._fire(), delay);
  }

  _fire() {
    if (!this._active) return;
    let sec = Math.floor(this._now() / 1000);
    // The wall clock can step BACKWARD while NTP disciplines it (notably in the
    // minutes after a reboot, when timesyncd corrects a clock that drifted during
    // long uptime). Never emit a duplicate or backward second — that would
    // double-feed the engine (dup now_ms). Clamp forward by one. Genuine FORWARD
    // jumps (real downtime, e.g. a reboot gap) pass through unchanged so they are
    // still detected and marked.
    if (sec <= this._lastSec) sec = this._lastSec + 1;
    const gapSec = gapSeconds(this._lastSec, sec);
    this._lastSec = sec;
    if (this._cb) this._cb({ sec, gapSec });
    this._arm();
  }
}
