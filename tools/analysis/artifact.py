"""Immutable gradeable artifact: per-run analysis.json + ledger.jsonl row.

`t0` is always passed in (never read the clock here) so runs are reproducible
and replayable in tests.
"""

from __future__ import annotations

import json
import os

REQUIRED_KEYS = ["t0", "slug", "price_vector", "edges", "scorecards", "anchors", "graded"]


def build_artifact(t0, slug, price_vector, edges, scorecards, anchors, coherence=None) -> dict:
    """Assemble the run artifact. Each edge should look like:
    {leg, condition_id, token_id, side, price_t0, fair_price, edge_cents,
     confidence, evidence:{fairvalue, coherence, smart_money, microstructure, refutation}}.
    """
    return {
        "t0": t0,
        "slug": slug,
        "price_vector": price_vector,   # {leg/condition_id: yes_price at T0}
        "edges": edges,
        "scorecards": scorecards,       # {wallet: scorecard dict}
        "anchors": anchors,             # {leg: {fair_prob, source}}
        "coherence": coherence or [],   # list of coherence-check results
        "graded": False,
    }


def write_artifact(base_dir: str, art: dict) -> dict:
    """Write analysis/markets/<slug>/analysis.json and append a ledger.jsonl row.
    Returns {"artifact_path", "ledger_path"}."""
    market_dir = os.path.join(base_dir, "markets", art["slug"])
    os.makedirs(market_dir, exist_ok=True)
    artifact_path = os.path.join(market_dir, "analysis.json")
    with open(artifact_path, "w") as f:
        json.dump(art, f, indent=2, default=str)

    ledger_path = os.path.join(base_dir, "ledger.jsonl")
    row = {
        "t0": art["t0"],
        "slug": art["slug"],
        "n_edges": len(art["edges"]),
        "edges": [
            {"leg": e.get("leg"), "side": e.get("side"), "price_t0": e.get("price_t0"),
             "fair_price": e.get("fair_price"), "confidence": e.get("confidence")}
            for e in art["edges"]
        ],
        "graded": art["graded"],
    }
    with open(ledger_path, "a") as f:
        f.write(json.dumps(row, default=str) + "\n")
    return {"artifact_path": artifact_path, "ledger_path": ledger_path}


def read_artifact(artifact_path: str) -> dict:
    with open(artifact_path) as f:
        return json.load(f)
