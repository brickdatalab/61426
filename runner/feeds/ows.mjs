// ourWebSocket feed client: auto-reconnect (exponential backoff) + staleness reporting.
// No DOM, no browser globals — importable from a node runner and unit-testable via
// injected wsFactory/now seams (no network needed in tests).
import WebSocket from 'ws';

export function _backoffMs(n) {
  return Math.min(1000 * 2 ** n, 30000);
}

export class OwsFeed {
  constructor(symbol, interval, opts = {}) {
    this.symbol = symbol;
    this.interval = interval;
    this._wsFactory = opts.wsFactory || (() => this._defaultWs());
    this._now = opts.now || (() => Date.now());
    this._setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._tape = null;
    this._lastMsgTs = null;
    this._backoffN = 0;
    this._ws = null;
    this._stopped = false;
  }

  _defaultWs() {
    const url = `ws://34.89.159.108/ws/v5/tape?symbol=${this.symbol}&bar=${this.interval}`;
    return new WebSocket(url);
  }

  _backoffMs(n) {
    return _backoffMs(n);
  }

  start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._ws) {
      try { this._ws.close(); } catch {}
      try { this._ws.terminate?.(); } catch {}
    }
  }

  _connect() {
    let ws;
    try {
      ws = this._wsFactory();
    } catch {
      this._scheduleReconnect();
      return;
    }
    if (this._stopped) return;
    this._ws = ws;
    ws.on('message', (data) => this._onMessage(data));
    ws.on('close', () => this._scheduleReconnect());
    ws.on('error', () => this._scheduleReconnect());
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // malformed message — ignore, don't throw
    }
    const tape = { ...(msg.tape || {}) };
    if (msg.perp_spot_divergence && msg.perp_spot_divergence.perp_cvd_minus_spot_cvd_5m_usd != null) {
      tape.perp_cvd_minus_spot_cvd_5m_usd = msg.perp_spot_divergence.perp_cvd_minus_spot_cvd_5m_usd;
    }
    this._tape = tape;
    this._lastMsgTs = this._now();
    this._backoffN = 0;
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    const delay = this._backoffMs(this._backoffN);
    this._backoffN += 1;
    this._setTimer(() => this._connect(), delay);
  }

  latest() {
    return {
      tape: this._tape,
      ageMs: this._lastMsgTs == null ? null : this._now() - this._lastMsgTs,
    };
  }
}
