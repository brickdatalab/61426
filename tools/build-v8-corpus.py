#!/usr/bin/env python3
"""build-v8-corpus.py — reproducible V8 log-ingestion & corpus-preparation pipeline.

Consumes ONLY the V6, V7s, and V8 session logs (V6/V7s payloads already rewritten
with current V8 engine logic; physical filenames kept as provenance). V5-and-earlier
files are excluded by filename+stat only (their bytes are never opened).

Builds the v8_corpus package in a staging directory, runs every verification there,
and only then atomically swaps it into place — an existing v8_corpus is never
deleted or overwritten before the new build passes validation.

Read-only consumption of AUTOPSY/logs and v8/src/signals.mjs. No source-log mutation.
Corpus construction + validation only — no signal-performance analysis.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import zstandard as zstd

ROOT = Path(__file__).resolve().parent.parent
LOGS_DIR = ROOT / "AUTOPSY" / "logs"
REPLAY_HELPER = ROOT / "tools" / "v8-corpus-replay.mjs"
FINAL_DIR = ROOT / "v8_corpus"
CORPUS_VERSION = "v8-1"

INCLUDE_RE = re.compile(r"^(?P<asset>btc|eth)-updown-(?P<interval>5m|15m)-(?P<epoch>\d{10})_(?P<version>v6|v7s|v8)\.json$")
PRE_V8_RE = re.compile(r"^(btc|eth)-updown-(5m|15m)-(\d{10})_(v51|v52|v53|v54)\.json$")
ANY_JSON_RE = re.compile(r".*\.json$")
CLOCK_RE = re.compile(r"^(\d{2}):(\d{2}):(\d{2})$")

INTERVAL_SECONDS = {"5m": 300, "15m": 900}
SYMBOL = {"btc": "BTCUSDT", "eth": "ETHUSDT"}
ASSET_UPPER = {"btc": "BTC", "eth": "ETH"}

# Boundary-ambiguity tolerance: 0.005 (cushion 2dp rounding) + 0.0025 (vol*0.5 2dp) = 0.0075.
BOUNDARY_EPS = 0.0075

LOG = lambda *a: print(*a, file=sys.stderr, flush=True)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def utc_mtime(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_finite(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))


# ---------------------------------------------------------------------------
# Timing reconstruction (audit stream — unmodified, no monotonic enforcement)
# ---------------------------------------------------------------------------

def reconstruct_ts(t_raw: str | None, epoch: int, bar_seconds: int, rem: int) -> int:
    """Nearest nominal UTC instant for the logged clock string (seconds since epoch)."""
    nominal = epoch + bar_seconds - rem
    m = CLOCK_RE.match(t_raw) if isinstance(t_raw, str) else None
    if not m:
        return nominal
    h, mi, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
    nd = datetime.fromtimestamp(nominal, tz=timezone.utc)
    best = None
    for off in (-1, 0, 1):
        d = nd + timedelta(days=off)
        cand = int(datetime(d.year, d.month, d.day, h, mi, s, tzinfo=timezone.utc).timestamp())
        if best is None or abs(cand - nominal) < abs(best - nominal):
            best = cand
    return best  # type: ignore[return-value]


def ts_to_utc(seconds: int | None) -> datetime | None:
    if seconds is None:
        return None
    return datetime.fromtimestamp(seconds, tz=timezone.utc)


# ---------------------------------------------------------------------------
# Pyarrow schema definitions
# ---------------------------------------------------------------------------

def F(name: str, typ: pa.DataType, nullable: bool = True, source: str = "", desc: str = ""):
    return {"name": name, "type": typ, "nullable": nullable, "source": source, "desc": desc}


I32 = pa.int32()
I8 = pa.int8()
F64 = pa.float64()
BOOL = pa.bool_()
STR = pa.string()
TS = pa.timestamp("ms", tz="UTC")
DATE = pa.date32()
DICT = lambda: pa.dictionary(I8, STR)

TICK_FIELDS = [
    F("corpus_version", STR, False, "", "Corpus build version tag"),
    F("market_id", STR, False, "", "asset-updown-interval-epoch"),
    F("session_id", STR, False, "", "SHA-256 of source identity + content"),
    F("source_path", STR, False, "", "Relative path to source log"),
    F("source_sha256", STR, False, "", "SHA-256 of original source bytes"),
    F("row_index_raw", I32, False, "", "0-based index in the source rows array"),
    F("tick_index", I32, False, "", "0-based index among tick rows only"),
    F("asset", DICT(), False, "", "BTC or ETH"),
    F("symbol", DICT(), False, "", "BTCUSDT or ETHUSDT"),
    F("interval", DICT(), False, "", "5m or 15m"),
    F("bar_seconds", I32, False, "", "Bar length in seconds"),
    F("bar_start_utc", TS, False, "", "Bar open instant"),
    F("bar_end_utc", TS, False, "", "Bar settle instant"),
    F("bar_date_utc", DATE, False, "", "UTC date of the bar"),
    # timing
    F("t_raw", STR, False, "t", "Logged clock string HH:MM:SS"),
    F("row_timestamp_utc", TS, False, "", "Reconstructed UTC write time (observed clock, unmodified)"),
    F("rem_s", I32, False, "rem", "Seconds remaining at capture (primary earliness measure)"),
    F("elapsed_s", I32, False, "", "bar_seconds - rem_s"),
    F("previous_rem_s", I32, True, "", "rem_s of the prior tick"),
    F("delta_rem_s", I32, True, "", "previous_rem_s - rem_s"),
    F("delta_row_time_s", F64, True, "", "Observed clock delta vs prior tick (s)"),
    F("duplicate_rem", BOOL, False, "", "rem unchanged from prior tick"),
    F("nonmonotonic_rem", BOOL, False, "", "rem increased vs prior tick"),
    F("gap_after_previous", BOOL, False, "", "Observed clock gap > 1s vs prior tick"),
    F("gap_size_s", I32, True, "", "Missing whole seconds in the gap"),
    F("clock_disagreement_s", F64, False, "", "|row_timestamp - rem-implied nominal|"),
    F("session_left_censored", BOOL, False, "", "Session did not observe bar open"),
    F("session_right_censored", BOOL, False, "", "Session ended before bar close"),
    # VM / market
    F("binance_imbalance", F64, True, "btc_imb", "Binance order-book imbalance"),
    F("polymarket_imbalance", F64, True, "poly_imb", "Polymarket order-book imbalance"),
    F("combined_imbalance_logged", F64, True, "comb", "Logged combined imbalance"),
    F("cushion_usd", F64, True, "cushion", "Price vs bar open ($)"),
    F("spot_cvd_1m_usd", F64, True, "cvd", "VM 1-minute CVD delta"),
    F("spot_cvd_since_open_usd", F64, True, "cvd_since_open", "CVD accumulated since bar open"),
    F("spot_cvd_delta_5s_usd", F64, True, "cvd_d5", "5s CVD delta"),
    F("spot_cvd_delta_10s_usd", F64, True, "cvd_d10", "10s CVD delta"),
    F("spot_cvd_delta_60s_usd", F64, True, "cvd_d60", "60s CVD delta"),
    F("cushion_delta_10s_usd", F64, True, "cush_d10", "10s cushion delta"),
    F("momentum_z", F64, True, "mom_z", "Flow-slope momentum z-score"),
    F("momentum_direction", DICT(), True, "mom_dir", "FLAT/UP/DOWN"),
    F("imbalance_ewma", F64, True, "imb_ewma", "EWMA of combined imbalance"),
    F("large_print_net_3m_usd", F64, True, "large_prints", "3m large-print net flow"),
    F("efficiency_3m", F64, True, "efficiency", "3m efficiency ratio"),
    F("perp_minus_spot_cvd_5m_usd", F64, True, "perp_spot_div", "Perp-spot CVD 5m divergence"),
    F("realized_vol_1m_usd", F64, True, "vol_1m", "Realized 1-minute volatility ($)"),
    # polymarket
    F("poly_up_mid", F64, True, "poly_mid", "UP-token midpoint"),
    F("poly_down_mid_proxy", F64, True, "", "1 - poly_up_mid (complement proxy)"),
    F("poly_price_available", BOOL, False, "", "poly_up_mid present"),
    F("poly_favorite_side", DICT(), True, "", "UP/DOWN by larger midpoint"),
    F("poly_favorite_mid", F64, True, "", "max(poly_up_mid, 1-poly_up_mid)"),
    F("poly_distance_from_50", F64, True, "", "|poly_up_mid - 0.5|"),
    F("signal_side_mid", F64, True, "", "Midpoint on the signal side"),
    F("signal_side_discount_to_one", F64, True, "", "1 - signal_side_mid"),
    # signal / context
    F("signal", DICT(), False, "signal", "Logged V8 signal UP/DOWN/MIXED"),
    F("conviction_tier", I8, True, "conv.tier", "V8 conviction tier 1-3"),
    F("conviction_points", I8, True, "conv.pts", "Conviction points 0-5"),
    F("conviction_reason", STR, True, "conv.why", "Conviction shortfall reason"),
    F("p_flip", F64, True, "p_flip", "Driftless flip probability"),
    F("flip_alert", STR, True, "flip_alert", "Flip alert label"),
    F("early_call_side", DICT(), True, "early_call", "Early-call side UP/DOWN"),
    F("early_tier", STR, True, "early_tier", "Early-call tier"),
    # deterministic V8 validation
    F("v8_floor_usd", F64, True, "", "max(10, 0.5*vol_1m) or engine fallback"),
    F("cushion_floor_ratio", F64, True, "", "|cushion| / v8_floor_usd"),
    F("expected_v8_signal", DICT(), False, "", "Engine-replayed expected signal"),
    F("signal_rule_match", BOOL, False, "", "Logged signal matches expected (or boundary-ambiguous)"),
    F("floor_boundary_ambiguous", BOOL, False, "", "Rounded values cannot resolve floor side"),
    # causal sequence
    F("previous_signal", DICT(), True, "", "Signal on the prior tick"),
    F("signal_changed", BOOL, False, "", "Signal differs from prior tick"),
    F("signal_run_id", I32, False, "", "Contiguous-same-signal run index"),
    F("signal_run_age_ticks", I32, False, "", "Ticks elapsed within current run"),
    F("signal_run_age_s", F64, False, "", "Seconds elapsed within current run"),
    F("first_directional_tick", BOOL, False, "", "First UP/DOWN of the session"),
    F("previous_directional_signal", DICT(), True, "", "Last directional signal before now"),
    F("directional_reversal_count_prior", I32, False, "", "Directional reversals before this tick"),
    F("directional_reversal_count_through_now", I32, False, "", "Directional reversals through this tick"),
    F("up_count_prior", I32, False, "", "UP ticks before this tick"),
    F("down_count_prior", I32, False, "", "DOWN ticks before this tick"),
    F("mixed_count_prior", I32, False, "", "MIXED ticks before this tick"),
    F("early_call_first_seen", BOOL, False, "", "First tick with a non-null early call"),
    F("early_call_age_ticks", I32, True, "", "Ticks since early call first seen"),
    F("early_call_age_s", F64, True, "", "Seconds since early call first seen"),
]

RUN_FIELDS = [
    F("market_id", STR, False), F("session_id", STR, False),
    F("signal_run_id", I32, False), F("signal", DICT(), False),
    F("start_tick_index", I32, False), F("start_row_timestamp_utc", TS, False),
    F("start_rem_s", I32, True), F("start_elapsed_s", I32, True),
    F("end_tick_index", I32, False), F("end_row_timestamp_utc", TS, False),
    F("end_rem_s", I32, True), F("end_elapsed_s", I32, True),
    F("observed_tick_count", I32, False), F("observed_duration_s", F64, False),
    F("left_censored", BOOL, False), F("right_censored", BOOL, False),
    F("contains_tick_gap", BOOL, False), F("max_tick_gap_s", I32, True),
    F("start_cushion_usd", F64, True), F("start_v8_floor_usd", F64, True),
    F("start_cushion_floor_ratio", F64, True), F("start_realized_vol_1m_usd", F64, True),
    F("start_poly_up_mid", F64, True), F("start_poly_favorite_side", DICT(), True),
    F("start_poly_favorite_mid", F64, True), F("start_signal_side_mid", F64, True),
    F("start_binance_imbalance", F64, True), F("start_polymarket_imbalance", F64, True),
    F("start_combined_imbalance_logged", F64, True), F("start_imbalance_ewma", F64, True),
    F("start_spot_cvd_since_open_usd", F64, True), F("start_spot_cvd_delta_5s_usd", F64, True),
    F("start_spot_cvd_delta_10s_usd", F64, True), F("start_spot_cvd_delta_60s_usd", F64, True),
    F("start_spot_cvd_delta_3m_usd", F64, True),
    F("start_momentum_z", F64, True), F("start_momentum_direction", DICT(), True),
    F("start_large_print_net_3m_usd", F64, True), F("start_efficiency_3m", F64, True),
    F("start_perp_minus_spot_cvd_5m_usd", F64, True),
    F("start_p_flip", F64, True), F("start_flip_alert", STR, True),
    F("start_conviction_tier", I8, True), F("start_conviction_points", I8, True),
    F("start_conviction_reason", STR, True),
    F("directional_reversal_count_prior", I32, False),
]

LABEL_FIELDS = [
    F("market_id", STR, False), F("canonical_session_id", STR, False),
    F("asset", DICT(), False), F("symbol", DICT(), False), F("interval", DICT(), False),
    F("bar_seconds", I32, False), F("bar_start_utc", TS, False), F("bar_end_utc", TS, False),
    F("settled_side", DICT(), False), F("label_up", BOOL, False),
    F("settlement_open_usd", F64, False), F("settlement_close_usd", F64, False),
    F("settlement_move_usd", F64, False), F("settlement_abs_move_usd", F64, False),
    F("settlement_timestamp_utc", TS, True),
    F("settlement_rule_consistent", BOOL, False),
    F("near_flat_outcome", BOOL, True),
]

QUALITY_FIELDS = [
    F("session_id", STR, False), F("market_id", STR, True), F("source_path", STR, False),
    F("source_sha256", STR, True), F("source_size_bytes", I32, True), F("source_mtime_utc", STR, True),
    F("ingest_status", STR, False), F("exclusion_reason", STR, True),
    F("canonical_for_market", BOOL, False), F("duplicate_type", STR, True), F("canonical_rank", I32, True),
    F("raw_row_count", I32, True), F("tick_row_count", I32, True), F("settlement_row_count", I32, True),
    F("first_rem_s", I32, True), F("last_rem_s", I32, True),
    F("first_elapsed_s", I32, True), F("last_elapsed_s", I32, True),
    F("observed_span_s", F64, True), F("distinct_rem_seconds", I32, True),
    F("duplicate_rem_count", I32, True), F("nonmonotonic_rem_count", I32, True),
    F("missing_seconds_within_observed_span", I32, True), F("largest_gap_s", I32, True),
    F("starts_before_45s_elapsed", BOOL, True), F("covers_45_to_90s_early_window", BOOL, True),
    F("reaches_final_5s", BOOL, True), F("left_censored", BOOL, True), F("right_censored", BOOL, True),
    F("cushion_null_fraction", F64, True), F("volatility_null_fraction", F64, True),
    F("poly_mid_null_fraction", F64, True), F("poly_imbalance_null_fraction", F64, True),
    F("binance_imbalance_null_fraction", F64, True), F("cvd_since_open_null_fraction", F64, True),
    F("signal_up_count_recomputed", I32, True), F("signal_down_count_recomputed", I32, True),
    F("signal_mixed_count_recomputed", I32, True),
    F("signal_up_count_raw_summary", I32, True), F("signal_down_count_raw_summary", I32, True),
    F("signal_mixed_count_raw_summary", I32, True), F("raw_summary_matches_recomputed", BOOL, True),
    F("nonboundary_signal_mismatch_count", I32, True), F("boundary_ambiguous_count", I32, True),
    F("engine_compatible", BOOL, True), F("early_call_validated_domain", BOOL, True),
]


def pa_schema(fields):
    return pa.schema([pa.field(f["name"], f["type"], nullable=f["nullable"]) for f in fields])


def make_table(rows: list[dict], fields) -> pa.Table:
    schema = pa_schema(fields)
    arrays = []
    for f in fields:
        vals = [r.get(f["name"]) for r in rows]
        typ = f["type"]
        if pa.types.is_timestamp(typ):
            vals = [None if v is None else v for v in vals]
        elif pa.types.is_date32(typ):
            vals = [None if v is None else v for v in vals]
        arrays.append(pa.array(vals, type=typ))
    return pa.Table.from_arrays(arrays, schema=schema)


def write_parquet(table: pa.Table, path: Path):
    pq.write_table(table, path, compression="zstd", use_dictionary=True, version="2.6")


# ---------------------------------------------------------------------------
# Phase 1 — inventory & classify
# ---------------------------------------------------------------------------

def phase_inventory():
    LOG("[1/14] inventory & classify")
    manifest, included, excluded = [], [], []
    for name in sorted(os.listdir(LOGS_DIR)):
        if not name.endswith(".json"):
            continue
        path = LOGS_DIR / name
        size = path.stat().st_size
        mtime = utc_mtime(path)
        mi = INCLUDE_RE.match(name)
        if mi:
            sha = sha256_file(path)
            entry = {
                "filename": name, "source_path": f"AUTOPSY/logs/{name}", "source_sha256": sha,
                "size_bytes": size, "mtime_utc": mtime, "ingest_status": "included",
                "exclusion_reason": "", "asset": mi.group("asset"), "interval": mi.group("interval"),
                "epoch": int(mi.group("epoch")), "version": mi.group("version"),
            }
            included.append(entry)
            manifest.append(entry)
            continue
        reason = "pre_v8" if PRE_V8_RE.match(name) else "unrecognized_filename"
        entry = {
            "filename": name, "source_path": f"AUTOPSY/logs/{name}", "source_sha256": "",
            "size_bytes": size, "mtime_utc": mtime, "ingest_status": "excluded",
            "exclusion_reason": reason, "asset": "", "interval": "", "epoch": None, "version": "",
        }
        excluded.append(entry)
        manifest.append(entry)
    LOG(f"      classified {len(manifest)} files: {len(included)} included, {len(excluded)} excluded")
    return manifest, included, excluded


# ---------------------------------------------------------------------------
# Phase 2 — parse & validate structure
# ---------------------------------------------------------------------------

def phase_parse(included):
    LOG("[2/14] parse & validate structure")
    parsed, dropped = [], []
    for e in included:
        raw = (LOGS_DIR / e["filename"]).read_bytes()
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            e.update(ingest_status="excluded", exclusion_reason=f"malformed_json:{exc}")
            dropped.append(e)
            continue
        rows = payload.get("rows") if isinstance(payload, dict) else None
        if not isinstance(rows, list) or not rows:
            e.update(ingest_status="excluded", exclusion_reason="no_rows_array")
            dropped.append(e)
            continue
        settlements = [i for i, r in enumerate(rows) if isinstance(r, dict) and "settled" in r]
        if len(settlements) != 1 or settlements[0] != len(rows) - 1:
            e.update(ingest_status="excluded", exclusion_reason="settlement_not_unique_or_final")
            dropped.append(e)
            continue
        st = rows[settlements[0]]
        if not (is_finite(st.get("open")) and is_finite(st.get("close"))):
            e.update(ingest_status="excluded", exclusion_reason="settlement_missing_open_close")
            dropped.append(e)
            continue
        ticks = rows[:-1]
        if not ticks or any(not isinstance(r, dict) or "settled" in r for r in ticks):
            e.update(ingest_status="excluded", exclusion_reason="no_usable_ticks")
            dropped.append(e)
            continue
        rule_side = "UP" if st["close"] >= st["open"] else "DOWN"
        consistent = st.get("settled") == rule_side
        if not consistent:
            e.update(ingest_status="excluded", exclusion_reason="settlement_conflict")
            dropped.append(e)
            continue
        parsed.append({**e, "payload": payload, "ticks": ticks, "settlement": st, "raw_bytes": raw,
                       "settlement_rule_consistent": consistent})
    LOG(f"      parsed {len(parsed)} valid; dropped {len(dropped)}")
    return parsed, dropped


# ---------------------------------------------------------------------------
# Phase 3 — normalize identity
# ---------------------------------------------------------------------------

def phase_identity(parsed):
    LOG("[3/14] normalize identity")
    for s in parsed:
        s["market_id"] = f"{s['asset']}-updown-{s['interval']}-{s['epoch']}"
        s["session_id"] = sha256_bytes(f"{s['filename']}|{s['source_sha256']}".encode("utf-8"))
        s["bar_seconds"] = INTERVAL_SECONDS[s["interval"]]
        s["symbol"] = SYMBOL[s["asset"]]
        s["bar_start_utc"] = ts_to_utc(s["epoch"])
        s["bar_end_utc"] = ts_to_utc(s["epoch"] + s["bar_seconds"])
        s["bar_date"] = datetime.fromtimestamp(s["epoch"], tz=timezone.utc).date()
    return parsed


# ---------------------------------------------------------------------------
# Phase 5 — authoritative V8 replay (runs before flatten so ticks carry results)
# ---------------------------------------------------------------------------

def phase_replay(parsed):
    LOG("[4/14] authoritative V8 replay (signals.mjs, full corpus)")
    tmp = ROOT / f".v8-replay-{os.getpid()}.jsonl"
    proc = subprocess.run(
        ["node", str(REPLAY_HELPER), "--logs-dir", str(LOGS_DIR), "--out", str(tmp)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        LOG(proc.stderr)
        tmp.unlink(missing_ok=True)
        raise SystemExit("replay helper failed")
    LOG("      " + proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else "      replay done")
    by_file = {}
    for line in tmp.open():
        e = json.loads(line)
        by_file[e["filename"]] = e
    tmp.unlink()
    n_ok = 0
    for s in parsed:
        rec = by_file[s["filename"]]
        assert rec["source_sha256"] == s["source_sha256"], f"sha drift {s['filename']}"
        if "error" in rec:
            raise SystemExit(f"replay error for {s['filename']}: {rec['error']}")
        assert rec["tick_count"] == len(s["ticks"]), f"tick count mismatch {s['filename']}"
        s["replay_results"] = rec["results"]
        n_ok += 1
    LOG(f"      replay validated {n_ok} sessions")
    return parsed


# ---------------------------------------------------------------------------
# Phase 6+7 — flatten ticks, timing, validation, causal sequence (single pass)
# ---------------------------------------------------------------------------

def phase_flatten(parsed):
    LOG("[5/14] flatten ticks + timing + validation + causal sequence")
    rows = []
    for s in parsed:
        bar_seconds = s["bar_seconds"]
        epoch = s["epoch"]
        asset = ASSET_UPPER[s["asset"]]
        # first pass: compute timestamps + observed timing to derive session censor flags
        rems = []
        tss = []
        for t in s["ticks"]:
            rem = int(round(t["rem"])) if is_finite(t.get("rem")) else None
            rems.append(rem)
            ts = reconstruct_ts(t.get("t"), epoch, bar_seconds, rem if rem is not None else 0)
            tss.append(ts)
        first_rem = rems[0]
        last_rem = rems[-1]
        first_elapsed = (bar_seconds - first_rem) if first_rem is not None else None
        last_elapsed = (bar_seconds - last_rem) if last_rem is not None else None
        s["first_rem_s"] = first_rem
        s["last_rem_s"] = last_rem
        s["first_elapsed_s"] = first_elapsed
        s["last_elapsed_s"] = last_elapsed
        left_censored = (first_elapsed is not None and first_elapsed > 5)
        right_censored = (last_rem is not None and last_rem > 5)
        s["_left_censored"] = left_censored
        s["_right_censored"] = right_censored

        prev_signal = None
        run_id = -1
        run_start_ts = None
        run_age = 0
        up_c = down_c = mixed_c = 0
        prev_dir = None
        rev_count = 0
        first_dir_seen = False
        early_first_ts = None
        early_first_idx = None

        replay = s["replay_results"]
        for i, t in enumerate(s["ticks"]):
            rem = rems[i]
            ts = tss[i]
            elapsed = (bar_seconds - rem) if rem is not None else None
            nominal = epoch + bar_seconds - (rem if rem is not None else 0)
            clock_disagree = abs(ts - nominal)
            if i == 0:
                prev_rem = None
                delta_rem = None
                delta_rt = None
                dup = False
                nonmon = False
                gap = False
                gap_size = None
            else:
                prev_rem = rems[i - 1]
                delta_rem = (prev_rem - rem) if (prev_rem is not None and rem is not None) else None
                delta_rt = (ts - tss[i - 1]) if tss[i - 1] is not None else None
                dup = (rem is not None and prev_rem is not None and rem == prev_rem)
                nonmon = (rem is not None and prev_rem is not None and rem > prev_rem)
                gap = (delta_rt is not None and delta_rt > 1.0)
                gap_size = (int(round(delta_rt)) - 1) if gap else 0

            signal = t.get("signal") or "MIXED"
            rr = replay[i]
            exp_sig = rr["expected_signal"]
            floor = rr["v8_floor"]
            cushion = t.get("cushion")
            ratio = (abs(cushion) / floor) if (is_finite(cushion) and is_finite(floor) and floor) else None
            ambig = bool(is_finite(cushion) and is_finite(floor) and abs(abs(cushion) - floor) <= BOUNDARY_EPS)
            rule_match = bool(exp_sig == signal or ambig)

            # causal sequence
            dir_before = prev_dir  # directional signal held before this tick
            changed = (signal != prev_signal)
            if i == 0 or changed:
                run_id += 1
                run_age = 0
                run_start_ts = ts
            else:
                run_age += 1
            run_age_s = (ts - run_start_ts) if run_start_ts is not None else 0.0
            is_dir = signal in ("UP", "DOWN")
            first_dir = is_dir and not first_dir_seen
            if is_dir:
                first_dir_seen = True
            rev_prior = rev_count
            if is_dir:
                if prev_dir is not None and signal != prev_dir:
                    rev_count += 1
                prev_dir = signal
            rev_through = rev_count

            ec = t.get("early_call")
            ec_first = False
            ec_age_t = None
            ec_age_s = None
            if ec is not None:
                if early_first_ts is None:
                    early_first_ts = ts
                    early_first_idx = i
                    ec_first = True
                ec_age_t = i - early_first_idx
                ec_age_s = (ts - early_first_ts)
            else:
                if early_first_ts is not None:
                    ec_age_t = i - early_first_idx
                    ec_age_s = (ts - early_first_ts)

            conv = t.get("conv")
            poly_mid = t.get("poly_mid")
            poly_avail = poly_mid is not None
            fav_side = None
            fav_mid = None
            dist50 = None
            down_proxy = None
            if poly_avail:
                down_proxy = 1.0 - poly_mid
                fav_side = "UP" if poly_mid >= 0.5 else "DOWN"
                fav_mid = max(poly_mid, down_proxy)
                dist50 = abs(poly_mid - 0.5)
            ssm = None
            ssd = None
            if is_dir and poly_avail:
                ssm = poly_mid if signal == "UP" else (1.0 - poly_mid)
                ssd = 1.0 - ssm

            row = {
                "corpus_version": CORPUS_VERSION, "market_id": s["market_id"],
                "session_id": s["session_id"], "source_path": s["source_path"],
                "source_sha256": s["source_sha256"], "row_index_raw": i, "tick_index": i,
                "asset": asset, "symbol": s["symbol"], "interval": s["interval"],
                "bar_seconds": bar_seconds, "bar_start_utc": s["bar_start_utc"],
                "bar_end_utc": s["bar_end_utc"], "bar_date_utc": s["bar_date"],
                "t_raw": t.get("t"), "row_timestamp_utc": ts_to_utc(ts), "rem_s": rem,
                "elapsed_s": elapsed, "previous_rem_s": prev_rem, "delta_rem_s": delta_rem,
                "delta_row_time_s": delta_rt, "duplicate_rem": dup, "nonmonotonic_rem": nonmon,
                "gap_after_previous": gap, "gap_size_s": gap_size, "clock_disagreement_s": clock_disagree,
                "session_left_censored": left_censored, "session_right_censored": right_censored,
                "binance_imbalance": t.get("btc_imb"), "polymarket_imbalance": t.get("poly_imb"),
                "combined_imbalance_logged": t.get("comb"), "cushion_usd": cushion,
                "spot_cvd_1m_usd": t.get("cvd"), "spot_cvd_since_open_usd": t.get("cvd_since_open"),
                "spot_cvd_delta_5s_usd": t.get("cvd_d5"), "spot_cvd_delta_10s_usd": t.get("cvd_d10"),
                "spot_cvd_delta_60s_usd": t.get("cvd_d60"), "cushion_delta_10s_usd": t.get("cush_d10"),
                "momentum_z": t.get("mom_z"), "momentum_direction": t.get("mom_dir"),
                "imbalance_ewma": t.get("imb_ewma"), "large_print_net_3m_usd": t.get("large_prints"),
                "efficiency_3m": t.get("efficiency"), "perp_minus_spot_cvd_5m_usd": t.get("perp_spot_div"),
                "realized_vol_1m_usd": t.get("vol_1m"),
                "poly_up_mid": poly_mid, "poly_down_mid_proxy": down_proxy,
                "poly_price_available": poly_avail, "poly_favorite_side": fav_side,
                "poly_favorite_mid": fav_mid, "poly_distance_from_50": dist50,
                "signal_side_mid": ssm, "signal_side_discount_to_one": ssd,
                "signal": signal,
                "conviction_tier": (conv.get("tier") if isinstance(conv, dict) else None),
                "conviction_points": (conv.get("pts") if isinstance(conv, dict) else None),
                "conviction_reason": (conv.get("why") if isinstance(conv, dict) else None),
                "p_flip": t.get("p_flip"), "flip_alert": t.get("flip_alert"),
                "early_call_side": ec, "early_tier": t.get("early_tier"),
                "v8_floor_usd": floor, "cushion_floor_ratio": ratio,
                "expected_v8_signal": exp_sig, "signal_rule_match": rule_match,
                "floor_boundary_ambiguous": ambig,
                "previous_signal": prev_signal, "signal_changed": changed,
                "signal_run_id": run_id, "signal_run_age_ticks": run_age,
                "signal_run_age_s": run_age_s,                 "first_directional_tick": first_dir,
                "previous_directional_signal": dir_before,
                "directional_reversal_count_prior": rev_prior,
                "directional_reversal_count_through_now": rev_through,
                "up_count_prior": up_c, "down_count_prior": down_c, "mixed_count_prior": mixed_c,
                "early_call_first_seen": ec_first, "early_call_age_ticks": ec_age_t,
                "early_call_age_s": ec_age_s,
            }
            rows.append(row)
            prev_signal = signal
            if signal == "UP":
                up_c += 1
            elif signal == "DOWN":
                down_c += 1
            else:
                mixed_c += 1
    LOG(f"      {len(rows)} tick rows across {len(parsed)} sessions")
    return rows


# ---------------------------------------------------------------------------
# Phase 8 — canonical-session selection (correctness-blind)
# ---------------------------------------------------------------------------

def phase_canonical(parsed):
    LOG("[6/14] canonical-session selection")
    by_market: dict[str, list] = {}
    for s in parsed:
        by_market.setdefault(s["market_id"], []).append(s)
    dup_rows = []
    for s in parsed:
        s["canonical_for_market"] = False
        s["canonical_rank"] = -1
        s["duplicate_type"] = ""
    for mid, group in by_market.items():
        def null_rate(s):
            ticks = s["ticks"]
            crit = sum(1 for t in ticks if t.get("cushion") is None or t.get("vol_1m") is None or t.get("poly_mid") is None)
            return crit / max(1, len(ticks))
        def rank_key(s):
            span = (s["last_elapsed_s"] or 0) - (s["first_elapsed_s"] or 0)
            distinct = len({int(round(t["rem"])) for t in s["ticks"] if is_finite(t.get("rem"))})
            return (
                1 if s["settlement_rule_consistent"] else 0,
                0 if _engine_ok(s) else 1,
                -span,
                -distinct,
                null_rate(s),
                s["source_sha256"],
            )
        ordered = sorted(group, key=rank_key)
        for rnk, s in enumerate(ordered):
            s["canonical_rank"] = rnk
            if rnk == 0:
                s["canonical_for_market"] = True
            else:
                s["duplicate_type"] = "nonidentical_same_market"
                dup_rows.append({
                    "market_id": mid, "session_id": s["session_id"], "source_path": s["source_path"],
                    "canonical_rank": rnk, "canonical_session_id": ordered[0]["session_id"],
                    "reason": "lower_ranked_duplicate",
                })
    n_canon = sum(1 for s in parsed if s["canonical_for_market"])
    LOG(f"      {n_canon} canonical sessions across {len(by_market)} markets; {len(dup_rows)} duplicates")
    return parsed, dup_rows


def _engine_ok(s):
    return s.get("_engine_compatible", True)


# ---------------------------------------------------------------------------
# Phase 9 — signal runs
# ---------------------------------------------------------------------------

def phase_runs(canonical_rows):
    LOG("[7/14] signal runs")
    runs = []
    # group canonical tick rows by session in tick order
    by_sess: dict[str, list] = {}
    for r in canonical_rows:
        by_sess.setdefault(r["session_id"], []).append(r)
    for sid, ticks in by_sess.items():
        ticks.sort(key=lambda r: r["tick_index"])
        session_last_idx = ticks[-1]["tick_index"]
        session_left = ticks[0]["session_left_censored"]
        session_right = ticks[0]["session_right_censored"]
        cur = None
        for r in ticks:
            sig = r["signal"]
            if cur is None or cur["signal"] != sig or cur["session_id"] != r["session_id"]:
                if cur is not None:
                    runs.append(_finalize_run(cur, session_last_idx, session_left, session_right))
                cur = {
                    "market_id": r["market_id"], "session_id": r["session_id"],
                    "signal": sig, "signal_run_id": r["signal_run_id"],
                    "start": r, "end": r, "ticks": [r],
                }
            else:
                cur["end"] = r
                cur["ticks"].append(r)
        if cur is not None:
            runs.append(_finalize_run(cur, session_last_idx, session_left, session_right))
    LOG(f"      {len(runs)} signal runs")
    return runs


def _finalize_run(cur, session_last_idx, session_left, session_right):
    s0, s1 = cur["start"], cur["end"]
    gaps = [t["gap_size_s"] for t in cur["ticks"][1:] if t["gap_size_s"]]
    contains_gap = any(t["gap_after_previous"] for t in cur["ticks"][1:])
    row = {
        "market_id": cur["market_id"], "session_id": cur["session_id"],
        "signal_run_id": cur["signal_run_id"], "signal": cur["signal"],
        "start_tick_index": s0["tick_index"], "start_row_timestamp_utc": s0["row_timestamp_utc"],
        "start_rem_s": s0["rem_s"], "start_elapsed_s": s0["elapsed_s"],
        "end_tick_index": s1["tick_index"], "end_row_timestamp_utc": s1["row_timestamp_utc"],
        "end_rem_s": s1["rem_s"], "end_elapsed_s": s1["elapsed_s"],
        "observed_tick_count": len(cur["ticks"]),
        "observed_duration_s": float(s1["row_timestamp_utc"].timestamp() - s0["row_timestamp_utc"].timestamp()),
        "left_censored": bool(s0["tick_index"] == 0 and session_left),
        "right_censored": bool(s1["tick_index"] == session_last_idx and session_right),
        "contains_tick_gap": bool(contains_gap), "max_tick_gap_s": (max(gaps) if gaps else None),
        "directional_reversal_count_prior": s0["directional_reversal_count_prior"],
    }
    for k in ("cushion_usd", "v8_floor_usd", "cushion_floor_ratio", "realized_vol_1m_usd",
              "poly_up_mid", "poly_favorite_side", "poly_favorite_mid", "signal_side_mid",
              "binance_imbalance", "polymarket_imbalance", "combined_imbalance_logged", "imbalance_ewma",
              "spot_cvd_since_open_usd", "spot_cvd_delta_5s_usd", "spot_cvd_delta_10s_usd",
              "spot_cvd_delta_60s_usd", "spot_cvd_delta_3m_usd", "momentum_z", "momentum_direction",
              "large_print_net_3m_usd", "efficiency_3m", "perp_minus_spot_cvd_5m_usd",
              "p_flip", "flip_alert", "conviction_tier", "conviction_points", "conviction_reason"):
        row[f"start_{k}"] = s0.get(k)
    return row


# ---------------------------------------------------------------------------
# Phase 10 — labels
# ---------------------------------------------------------------------------

def phase_labels(parsed):
    LOG("[8/14] market labels")
    labels = []
    canonical = [s for s in parsed if s["canonical_for_market"]]
    for s in canonical:
        st = s["settlement"]
        op, cl = st["open"], st["close"]
        move = cl - op
        side = "UP" if cl >= op else "DOWN"
        st_ts = reconstruct_ts(st.get("t"), s["epoch"], s["bar_seconds"], 0)
        labels.append({
            "market_id": s["market_id"], "canonical_session_id": s["session_id"],
            "asset": ASSET_UPPER[s["asset"]], "symbol": s["symbol"], "interval": s["interval"],
            "bar_seconds": s["bar_seconds"], "bar_start_utc": s["bar_start_utc"], "bar_end_utc": s["bar_end_utc"],
            "settled_side": side, "label_up": side == "UP",
            "settlement_open_usd": op, "settlement_close_usd": cl,
            "settlement_move_usd": move, "settlement_abs_move_usd": abs(move),
            "settlement_timestamp_utc": ts_to_utc(st_ts),
            "settlement_rule_consistent": s["settlement_rule_consistent"],
            "near_flat_outcome": None,
        })
    LOG(f"      {len(labels)} market labels")
    return labels


# ---------------------------------------------------------------------------
# Phase 11 — session quality
# ---------------------------------------------------------------------------

def phase_quality(parsed, dropped, excluded, tick_rows):
    LOG("[9/14] session quality")
    # precompute per-session stats from tick_rows
    by_sess: dict[str, list] = {}
    for r in tick_rows:
        by_sess.setdefault(r["session_id"], []).append(r)
    quality = []
    # excluded files (pre-v8 + unrecognized): minimal rows
    for e in excluded:
        quality.append({
            "session_id": sha256_bytes(e["filename"].encode()), "market_id": "",
            "source_path": e["source_path"], "source_sha256": "", "source_size_bytes": e["size_bytes"],
            "source_mtime_utc": e["mtime_utc"], "ingest_status": "excluded",
            "exclusion_reason": e["exclusion_reason"], "canonical_for_market": False,
            "duplicate_type": "", "canonical_rank": None, "raw_row_count": None,
            "tick_row_count": None, "settlement_row_count": None, "first_rem_s": None,
            "last_rem_s": None, "first_elapsed_s": None, "last_elapsed_s": None,
            "observed_span_s": None, "distinct_rem_seconds": None, "duplicate_rem_count": None,
            "nonmonotonic_rem_count": None, "missing_seconds_within_observed_span": None,
            "largest_gap_s": None, "starts_before_45s_elapsed": None,
            "covers_45_to_90s_early_window": None, "reaches_final_5s": None,
            "left_censored": None, "right_censored": None, "cushion_null_fraction": None,
            "volatility_null_fraction": None, "poly_mid_null_fraction": None,
            "poly_imbalance_null_fraction": None, "binance_imbalance_null_fraction": None,
            "cvd_since_open_null_fraction": None, "signal_up_count_recomputed": None,
            "signal_down_count_recomputed": None, "signal_mixed_count_recomputed": None,
            "signal_up_count_raw_summary": None, "signal_down_count_raw_summary": None,
            "signal_mixed_count_raw_summary": None, "raw_summary_matches_recomputed": None,
            "nonboundary_signal_mismatch_count": None, "boundary_ambiguous_count": None,
            "engine_compatible": None, "early_call_validated_domain": None,
        })
    # dropped (included but failed structural validation)
    for e in dropped:
        quality.append({
            "session_id": sha256_bytes(e["filename"].encode()), "market_id": "",
            "source_path": e["source_path"], "source_sha256": e.get("source_sha256", ""),
            "source_size_bytes": e["size_bytes"], "source_mtime_utc": e["mtime_utc"],
            "ingest_status": "excluded", "exclusion_reason": e["exclusion_reason"],
            "canonical_for_market": False, "duplicate_type": "", "canonical_rank": None,
            "raw_row_count": None, "tick_row_count": None, "settlement_row_count": None,
            "first_rem_s": None, "last_rem_s": None, "first_elapsed_s": None, "last_elapsed_s": None,
            "observed_span_s": None, "distinct_rem_seconds": None, "duplicate_rem_count": None,
            "nonmonotonic_rem_count": None, "missing_seconds_within_observed_span": None,
            "largest_gap_s": None, "starts_before_45s_elapsed": None,
            "covers_45_to_90s_early_window": None, "reaches_final_5s": None,
            "left_censored": None, "right_censored": None, "cushion_null_fraction": None,
            "volatility_null_fraction": None, "poly_mid_null_fraction": None,
            "poly_imbalance_null_fraction": None, "binance_imbalance_null_fraction": None,
            "cvd_since_open_null_fraction": None, "signal_up_count_recomputed": None,
            "signal_down_count_recomputed": None, "signal_mixed_count_recomputed": None,
            "signal_up_count_raw_summary": None, "signal_down_count_raw_summary": None,
            "signal_mixed_count_raw_summary": None, "raw_summary_matches_recomputed": None,
            "nonboundary_signal_mismatch_count": None, "boundary_ambiguous_count": None,
            "engine_compatible": None, "early_call_validated_domain": None,
        })
    # included sessions
    for s in parsed:
        ticks = by_sess.get(s["session_id"], [])
        n = len(ticks)
        rems = [t["rem_s"] for t in ticks]
        elapsed = [t["elapsed_s"] for t in ticks]
        first_rem = s["first_rem_s"]
        last_rem = s["last_rem_s"]
        first_el = s["first_elapsed_s"]
        last_el = s["last_elapsed_s"]
        span = (ticks[-1]["row_timestamp_utc"].timestamp() - ticks[0]["row_timestamp_utc"].timestamp()) if n else 0.0
        distinct_rem = len({r for r in rems if r is not None})
        dup_rem = sum(1 for t in ticks if t["duplicate_rem"])
        nonmon = sum(1 for t in ticks if t["nonmonotonic_rem"])
        gaps = [t["gap_size_s"] for t in ticks if t["gap_size_s"]]
        largest_gap = max(gaps) if gaps else 0
        span_int = int(round(span)) + 1
        missing = max(0, span_int - distinct_rem)
        st = s["settlement"]
        raw_up = int(st["signal_up_sum"]) if str(st.get("signal_up_sum", "")).strip().lstrip("-").isdigit() else None
        raw_down = int(st["signal_down_sum"]) if str(st.get("signal_down_sum", "")).strip().lstrip("-").isdigit() else None
        raw_mixed = int(st["signal_mixed_sum"]) if str(st.get("signal_mixed_sum", "")).strip().lstrip("-").isdigit() else None
        rec_up = sum(1 for t in ticks if t["signal"] == "UP")
        rec_down = sum(1 for t in ticks if t["signal"] == "DOWN")
        rec_mixed = sum(1 for t in ticks if t["signal"] == "MIXED")
        summary_match = None
        if raw_up is not None and raw_down is not None and raw_mixed is not None:
            summary_match = (raw_up == rec_up and raw_down == rec_down and raw_mixed == rec_mixed)
        mismatch = sum(1 for t in ticks if not t["signal_rule_match"] and not t["floor_boundary_ambiguous"])
        ambig = sum(1 for t in ticks if t["floor_boundary_ambiguous"])
        engine_ok = (mismatch == 0)
        s["_engine_compatible"] = engine_ok

        def frac(col):
            if not n:
                return None
            return sum(1 for t in ticks if t.get(col) is None) / n

        validated_domain = (s["asset"] == "btc" and s["interval"] == "5m")
        quality.append({
            "session_id": s["session_id"], "market_id": s["market_id"], "source_path": s["source_path"],
            "source_sha256": s["source_sha256"], "source_size_bytes": s["size_bytes"],
            "source_mtime_utc": s["mtime_utc"], "ingest_status": ("included_canonical" if s["canonical_for_market"] else "included_duplicate"),
            "exclusion_reason": "", "canonical_for_market": s["canonical_for_market"],
            "duplicate_type": s.get("duplicate_type", ""), "canonical_rank": s.get("canonical_rank"),
            "raw_row_count": n + 1, "tick_row_count": n, "settlement_row_count": 1,
            "first_rem_s": first_rem, "last_rem_s": last_rem, "first_elapsed_s": first_el,
            "last_elapsed_s": last_el, "observed_span_s": span, "distinct_rem_seconds": distinct_rem,
            "duplicate_rem_count": dup_rem, "nonmonotonic_rem_count": nonmon,
            "missing_seconds_within_observed_span": missing, "largest_gap_s": largest_gap,
            "starts_before_45s_elapsed": bool(first_el is not None and first_el < 45),
            "covers_45_to_90s_early_window": bool(first_el is not None and first_el <= 45 and last_el is not None and last_el >= 90),
            "reaches_final_5s": bool(last_rem is not None and last_rem <= 5),
            "left_censored": s["_left_censored"], "right_censored": s["_right_censored"],
            "cushion_null_fraction": frac("cushion_usd"), "volatility_null_fraction": frac("realized_vol_1m_usd"),
            "poly_mid_null_fraction": frac("poly_up_mid"), "poly_imbalance_null_fraction": frac("polymarket_imbalance"),
            "binance_imbalance_null_fraction": frac("binance_imbalance"), "cvd_since_open_null_fraction": frac("spot_cvd_since_open_usd"),
            "signal_up_count_recomputed": rec_up, "signal_down_count_recomputed": rec_down,
            "signal_mixed_count_recomputed": rec_mixed,
            "signal_up_count_raw_summary": raw_up, "signal_down_count_raw_summary": raw_down,
            "signal_mixed_count_raw_summary": raw_mixed, "raw_summary_matches_recomputed": summary_match,
            "nonboundary_signal_mismatch_count": mismatch, "boundary_ambiguous_count": ambig,
            "engine_compatible": engine_ok, "early_call_validated_domain": validated_domain,
        })
    LOG(f"      {len(quality)} quality rows ({len(excluded)} excluded + {len(dropped)} dropped + {len(parsed)} included)")
    return quality


# ---------------------------------------------------------------------------
# Phase 12 — emit
# ---------------------------------------------------------------------------

def write_raw_jsonl_zst(parsed, path: Path):
    LOG("      writing raw/v8_sessions_raw.jsonl.zst")
    cctx = zstd.ZstdCompressor(level=19)
    with path.open("wb") as fh:
        with cctx.stream_writer(fh) as cw:
            for s in parsed:
                obj = {
                    "source_path": s["source_path"], "source_sha256": s["source_sha256"],
                    "source_size_bytes": s["size_bytes"], "source_mtime_utc": s["mtime_utc"],
                    "ingest_status": ("included_canonical" if s["canonical_for_market"] else "included_duplicate"),
                    "raw_payload_text": s["raw_bytes"].decode("utf-8"),
                }
                cw.write((json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))


def write_csv(rows: list[dict], path: Path, cols):
    import csv
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)


def collection_windows(canonical_parsed):
    windows = []
    epochs = sorted(s["epoch"] for s in canonical_parsed)
    step = 300
    cur = []
    for e in epochs:
        if cur and e != cur[-1] + step:
            windows.append(cur)
            cur = []
        cur.append(e)
    if cur:
        windows.append(cur)
    rows = []
    for w in windows:
        asset = "BTC"
        rows.append({
            "start_utc": datetime.fromtimestamp(w[0], tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "end_utc": datetime.fromtimestamp(w[-1] + step, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "asset": asset, "interval": "5m",
            "collection_mode": "continuous" if len(w) > 1 else "isolated",
            "notes": f"{len(w)} bar(s)",
        })
    return rows


def write_schema_json(path: Path):
    def ser(fields):
        out = []
        for f in fields:
            t = f["type"]
            tn = str(t)
            out.append({"name": f["name"], "type": tn, "nullable": f["nullable"],
                        "source": f.get("source", ""), "description": f.get("desc", "")})
        return out
    obj = {
        "corpus_version": CORPUS_VERSION,
        "description": "V8 log-ingestion corpus: point-in-time ticks, signal runs, market labels, session quality.",
        "source_map_note": "tick fields map logged source keys to canonical names; see per-field 'source'.",
        "tables": {
            "v8_ticks": ser(TICK_FIELDS),
            "v8_signal_runs": ser(RUN_FIELDS),
            "v8_market_labels": ser(LABEL_FIELDS),
            "v8_session_quality": ser(QUALITY_FIELDS),
        },
        "timestamp_precision": "second (UTC); parquet stores as timestamp[ms, tz=UTC] (ms component always 000) since the parquet format has no native seconds unit",
        "boundary_ambiguity_epsilon": BOUNDARY_EPS,
    }
    path.write_text(json.dumps(obj, indent=2) + "\n")


# ---------------------------------------------------------------------------
# Phase 13 — verify
# ---------------------------------------------------------------------------

def phase_verify(staging: Path, parsed, tick_rows, run_rows, label_rows, quality_rows, raw_tick_total):
    LOG("[12/14] verification")
    v = {"checks": [], "passed": False}
    fails = []

    def check(name, cond, detail=""):
        v["checks"].append({"name": name, "passed": bool(cond), "detail": detail})
        if not cond:
            fails.append(f"{name}: {detail}")

    ticks_tbl = pq.read_table(staging / "derived" / "v8_ticks.parquet")
    runs_tbl = pq.read_table(staging / "derived" / "v8_signal_runs.parquet")
    labels_tbl = pq.read_table(staging / "derived" / "v8_market_labels.parquet")
    qual_tbl = pq.read_table(staging / "derived" / "v8_session_quality.parquet")

    check("raw_tick_total_equals_parquet", raw_tick_total == ticks_tbl.num_rows, f"{raw_tick_total} vs {ticks_tbl.num_rows}")
    canonical = [s for s in parsed if s["canonical_for_market"]]
    canon_tick_total = sum(len(s["ticks"]) for s in canonical)
    check("canonical_tick_rows_match", canon_tick_total == ticks_tbl.num_rows, f"{canon_tick_total} vs {ticks_tbl.num_rows}")
    check("labels_one_per_market", labels_tbl.num_rows == len({s["market_id"] for s in canonical}), f"{labels_tbl.num_rows}")
    check("quality_all_files", qual_tbl.num_rows == len(parsed) + len(qual_rows_excluded(quality_rows)), f"{qual_tbl.num_rows}")

    # schema/type round-trip
    for fname, fields, tbl in [("v8_ticks", TICK_FIELDS, ticks_tbl), ("v8_signal_runs", RUN_FIELDS, runs_tbl),
                               ("v8_market_labels", LABEL_FIELDS, labels_tbl), ("v8_session_quality", QUALITY_FIELDS, qual_tbl)]:
        exp_names = [f["name"] for f in fields]
        got_names = tbl.schema.names
        check(f"{fname}_columns", exp_names == got_names, f"missing/exp order")
        for f in fields:
            if f["name"] in tbl.schema.names:
                check(f"{fname}_{f['name']}_type", tbl.schema.field(f["name"]).type == f["type"], f"{f['name']}: {tbl.schema.field(f['name']).type} != {f['type']}")

    # non-nullable check
    for f in TICK_FIELDS:
        if not f["nullable"] and f["name"] in ticks_tbl.column_names:
            col = ticks_tbl.column(f["name"])
            check(f"tick_{f['name']}_no_nulls", col.null_count == 0, f"{f['name']}: {col.null_count} nulls")

    # leakage: no settlement columns in ticks
    leak_cols = {"settled", "settlement_open_usd", "settlement_close_usd", "next_poly_mid", "signal_up_count_total"}
    check("no_leakage_cols_in_ticks", not (leak_cols & set(ticks_tbl.column_names)), str(leak_cols & set(ticks_tbl.column_names)))

    # file order preserved (row_index_raw monotonic per session)
    import pyarrow.compute as pc
    tid = ticks_tbl.column("session_id").to_pylist()
    rir = ticks_tbl.column("row_index_raw").to_pylist()
    order_ok = True
    last_sid = None
    last_idx = -1
    for sid, idx in zip(tid, rir):
        if sid != last_sid:
            last_sid, last_idx = sid, idx
        else:
            if idx != last_idx + 1:
                order_ok = False
                break
            last_idx = idx
    check("file_order_preserved", order_ok)

    # referential: market_id in ticks subset of labels
    tick_markets = set(ticks_tbl.column("market_id").to_pylist())
    label_markets = set(labels_tbl.column("market_id").to_pylist())
    check("tick_markets_in_labels", tick_markets <= label_markets, str(tick_markets - label_markets))
    # canonical_session_id matches ticks session_id
    canon_sid = set(labels_tbl.column("canonical_session_id").to_pylist())
    tick_sid = set(ticks_tbl.column("session_id").to_pylist())
    check("canonical_session_ids_in_ticks", canon_sid <= tick_sid, str(canon_sid - tick_sid))

    # raw archive byte-regeneration check (sample 20 sessions)
    raw_path = staging / "raw" / "v8_sessions_raw.jsonl.zst"
    dctx = zstd.ZstdDecompressor()
    regen_ok = True
    checked = 0
    target = {s["filename"]: s["source_sha256"] for s in parsed[:25]}
    with raw_path.open("rb") as fh:
        with dctx.stream_reader(fh) as dr:
            text = io.TextIOWrapper(dr, encoding="utf-8")
            for line in text:
                obj = json.loads(line)
                fn = obj["source_path"].split("/")[-1]
                if fn in target:
                    regen = sha256_bytes(obj["raw_payload_text"].encode("utf-8"))
                    if regen != target[fn]:
                        regen_ok = False
                    checked += 1
    check("raw_byte_regeneration", regen_ok and checked > 0, f"checked {checked}")

    v["passed"] = len(fails) == 0
    v["failures"] = fails
    (staging / "audit" / "verification_report.json").write_text(json.dumps(v, indent=2) + "\n")
    if fails:
        LOG("      VERIFICATION FAILED:")
        for f in fails[:40]:
            LOG("        - " + f)
    else:
        LOG("      all checks passed")
    return v


def qual_rows_excluded(quality_rows):
    return [r for r in quality_rows if r["ingest_status"] == "excluded"]


# ---------------------------------------------------------------------------
# Phase 14 — reports
# ---------------------------------------------------------------------------

def write_reports(staging, parsed, tick_rows, run_rows, label_rows, quality_rows, excluded, dropped, manifest, verify):
    LOG("[13/14] reports")
    n_inc = len(parsed)
    n_canon = sum(1 for s in parsed if s["canonical_for_market"])
    n_pre_v8 = len(excluded)
    n_settle_conflict = len(dropped)
    n_exc = n_pre_v8 + n_settle_conflict
    assets = sorted({s["asset"] for s in parsed})
    intervals = sorted({s["interval"] for s in parsed})
    epochs = sorted(s["epoch"] for s in parsed)
    first_utc = datetime.fromtimestamp(epochs[0], tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    last_utc = datetime.fromtimestamp(epochs[-1], tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    engine_ok = sum(1 for s in parsed if s.get("_engine_compatible"))
    ambig_total = sum(1 for r in tick_rows if r["floor_boundary_ambiguous"])

    report = f"""# V8 Corpus Preparation Report

Generated: {datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
Corpus version: {CORPUS_VERSION}

## Inventory (runtime-derived, not hard-coded)

| metric | value |
|---|---|
| classified files | {len(manifest)} |
| included sessions | {n_inc} |
| canonical sessions (unique markets) | {n_canon} |
| excluded files | {n_exc} (V5-and-earlier {n_pre_v8} + settlement-conflict {n_settle_conflict}) |
| included tick rows | {len(tick_rows)} |
| signal runs | {len(run_rows)} |
| market labels | {len(label_rows)} |
| session-quality rows | {len(quality_rows)} |

### Exclusion breakdown

- V5-and-earlier (filename/stat only, never opened): {n_pre_v8}
- Settlement conflict (logged `settled` disagrees with close>=open rule): {n_settle_conflict}

## Coverage

- assets: {", ".join(assets)}
- intervals: {", ".join(intervals)}
- first bar: {first_utc}
- last bar: {last_utc}

## Engine validation

- sessions engine-compatible: {engine_ok}/{n_inc}
- boundary-ambiguous ticks: {ambig_total}
- non-boundary signal mismatches: {sum(1 for r in tick_rows if not r['signal_rule_match'] and not r['floor_boundary_ambiguous'])}

The V8 directional rule was replayed for every included session through the real
`v8/src/signals.mjs` engine (monotonic replay time). Boundary-ambiguous ticks
(cushion within {BOUNDARY_EPS} of the floor) are never counted as mismatches.

## Verification

- result: {"PASS" if verify["passed"] else "FAIL"}
- checks run: {len(verify["checks"])}

This report contains corpus construction and validation only — no signal-performance analysis.
"""
    (staging / "PREPARATION_REPORT.md").write_text(report)

    readme = f"""# v8_corpus

Reproducible V8 log-ingestion & corpus-preparation package. **Corpus construction and
validation only — no signal-performance analysis, no entry-rule testing, no engine changes.**

## Reproduce

```
python3 tools/build-v8-corpus.py
```

The build runs in a staging directory, verifies everything in place, then atomically swaps
the result into `v8_corpus/`. An existing package is never overwritten before the new build
passes validation.

## Source

- Consumes ONLY `_v6`, `_v7s`, `_v8` session logs from `AUTOPSY/logs/`.
- V6/V7s payloads were already rewritten with current V8 engine logic; physical filenames
  are preserved as provenance.
- V5-and-earlier files are excluded by filename + filesystem stat only — their bytes are
  never opened or hashed.

## Layout

```
raw/v8_sessions_raw.jsonl.zst      395+ included sessions, one per line (verbatim payload text)
derived/v8_ticks.parquet           point-in-time observed ticks (no future/label leakage)
derived/v8_signal_runs.parquet     contiguous signal runs
derived/v8_market_labels.parquet   one row per market bar (outcome — join AFTER defining entry)
derived/v8_session_quality.parquet every supplied file incl. excluded
audit/                             manifests, exclusions, duplicates, schema, verification
```

## Leakage safeguards (enforced)

1. Original file order preserved (no timestamp sorting).
2. No interpolation or forward-fill — nulls stay null.
3. Causal forward-pass only for running counts / run age / reversals / lags.
4. Settlement labels live in a separate file, joined only after an entry is frozen.
5. Cushion used directly as a feature; tick price is never reconstructed from settlement.
6. Downstream signal summaries recomputed for validation only, never used as predictors.
7. Completed run length never defines a run-start entry (use `signal_run_age_ticks`).
8. Canonical duplicate selection is correctness-blind.
9. No losing/reversal bars dropped during ingestion.
10. No row classified from future Polymarket prices. No `next_poly_mid` in the tick table.

## Walk-forward discipline (for later analysis)

All ticks of one market stay in one fold. Splits are chronological by bar, never random by
tick. BTC/ETH and 5m/15m remain identifiable and must not be implicitly pooled. Aggregate
or cluster uncertainty by market.

## Raw payload byte fidelity

Each raw line stores the exact original UTF-8 file content in `raw_payload_text` plus
`source_sha256`. Regeneration = write `raw_payload_text`, verify sha256 equals
`source_sha256`. A parsed/reserialized object is deliberately NOT used as the canonical
payload because it would not be byte-identical to the source.

## Known limitations

- `poly_down_mid_proxy` is a complement proxy (1 - poly_up_mid), not a separately observed
  DOWN book. `signal_side_mid` measures how priced-in the direction appeared — not a
  guaranteed fill price.
- `early_call_validated_domain` is TRUE only for BTC 5-minute sessions; ETH / 15-minute
  logs remain in the corpus but must not be pooled into BTC-5m-calibrated claims.
- `near_flat_outcome` is intentionally NULL; store `settlement_abs_move_usd` and define any
  threshold only in later approved analysis.

See `audit/schema.json` for the full field/type/source map and `PREPARATION_REPORT.md` for
the runtime inventory and validation summary.
"""
    (staging / "README.md").write_text(readme)


# ---------------------------------------------------------------------------
# Atomic swap
# ---------------------------------------------------------------------------

def atomic_swap(staging: Path, final: Path):
    LOG("[14/14] atomic swap")
    backup = None
    if final.exists():
        backup = final.with_name(final.name + f".bak.{int(time.time())}")
        os.rename(final, backup)
        LOG(f"      moved existing {final.name} -> {backup.name}")
    try:
        os.rename(staging, final)
    except OSError:
        if backup is not None:
            os.rename(backup, final)
            LOG(f"      restored previous {final.name}")
        raise
    if backup is not None:
        shutil.rmtree(backup)
        LOG(f"      removed backup {backup.name}")
    LOG(f"      -> {final}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if not LOGS_DIR.is_dir():
        raise SystemExit(f"logs dir not found: {LOGS_DIR}")
    staging = ROOT / f"v8_corpus.staging.{os.getpid()}"
    if staging.exists():
        shutil.rmtree(staging)
    (staging / "raw").mkdir(parents=True)
    (staging / "derived").mkdir(parents=True)
    (staging / "audit").mkdir(parents=True)

    manifest, included, excluded = phase_inventory()
    parsed, dropped = phase_parse(included)
    parsed = phase_identity(parsed)
    parsed = phase_replay(parsed)
    tick_rows = phase_flatten(parsed)
    parsed, dup_rows = phase_canonical(parsed)
    canon_sids = {s["session_id"] for s in parsed if s["canonical_for_market"]}
    canonical_rows = [r for r in tick_rows if r["session_id"] in canon_sids]
    run_rows = phase_runs(canonical_rows)
    label_rows = phase_labels(parsed)
    quality_rows = phase_quality(parsed, dropped, excluded, tick_rows)

    LOG("[10/14] emit outputs")
    write_parquet(make_table(canonical_rows, TICK_FIELDS), staging / "derived" / "v8_ticks.parquet")
    write_parquet(make_table(run_rows, RUN_FIELDS), staging / "derived" / "v8_signal_runs.parquet")
    write_parquet(make_table(label_rows, LABEL_FIELDS), staging / "derived" / "v8_market_labels.parquet")
    write_parquet(make_table(quality_rows, QUALITY_FIELDS), staging / "derived" / "v8_session_quality.parquet")
    write_raw_jsonl_zst(parsed, staging / "raw" / "v8_sessions_raw.jsonl.zst")

    write_csv(manifest, staging / "audit" / "source_manifest.csv",
              ["filename", "source_path", "source_sha256", "size_bytes", "mtime_utc", "ingest_status", "exclusion_reason", "asset", "interval", "epoch", "version"])
    write_csv([e for e in (excluded + dropped)], staging / "audit" / "exclusions.csv",
              ["filename", "source_path", "size_bytes", "mtime_utc", "ingest_status", "exclusion_reason"])
    write_csv(dup_rows, staging / "audit" / "duplicate_sessions.csv",
              ["market_id", "session_id", "source_path", "canonical_rank", "canonical_session_id", "reason"])
    write_csv(collection_windows(parsed), staging / "audit" / "collection_windows.csv",
              ["start_utc", "end_utc", "asset", "interval", "collection_mode", "notes"])
    write_schema_json(staging / "audit" / "schema.json")

    raw_tick_total = sum(len(s["ticks"]) for s in parsed)
    verify = phase_verify(staging, parsed, canonical_rows, run_rows, label_rows, quality_rows, raw_tick_total)

    write_reports(staging, parsed, canonical_rows, run_rows, label_rows, quality_rows, excluded, dropped, manifest, verify)

    if not verify["passed"]:
        LOG(f"\nVERIFICATION FAILED — staging left at {staging} for inspection; existing v8_corpus untouched.")
        raise SystemExit(1)

    atomic_swap(staging, FINAL_DIR)
    LOG("\nDONE.")


if __name__ == "__main__":
    main()
