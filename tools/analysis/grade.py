"""Grade a logged artifact later: CLV (closing-line value) + resolution (Brier/hit),
then aggregate a cross-market scoreboard. Run after kickoff (CLV) and after
resolution (outcome).
"""

from __future__ import annotations

import json
import os


def clv(side: str, price_t0: float, close: float) -> float:
    """Closing-line value: did the price move toward our side by close?
    BUY: profit if price rose (close - entry). SELL: profit if price fell."""
    return (close - price_t0) if side.upper() == "BUY" else (price_t0 - close)


def brier(conf: float, outcome: int) -> float:
    """Brier score for a single edge: (confidence_prob - outcome)^2. Lower = better."""
    return (float(conf) - float(outcome)) ** 2


def grade_artifact(art: dict, closing_prices: dict, resolutions: dict) -> dict:
    """Fill close + resolved per edge, compute CLV/Brier/hit. closing_prices and
    resolutions are keyed by edge 'leg'. resolutions[leg] is 1 (won) or 0 (lost).
    Mutates and returns the artifact with graded=True."""
    for e in art["edges"]:
        leg = e.get("leg")
        close = closing_prices.get(leg)
        outcome = resolutions.get(leg)
        if close is not None:
            e["close"] = close
            e["clv"] = round(clv(e["side"], e["price_t0"], close), 4)
        if outcome is not None:
            e["resolved"] = int(outcome)
            conf = e.get("confidence_prob", _conf_to_prob(e.get("confidence")))
            e["brier"] = round(brier(conf, outcome), 4)
            e["hit"] = bool(
                (e["side"].upper() == "BUY" and outcome == 1)
                or (e["side"].upper() == "SELL" and outcome == 0)
            )
    art["graded"] = True
    return art


def _conf_to_prob(confidence) -> float:
    """Map a 1-10 confidence to a probability for Brier if no explicit prob set."""
    if confidence is None:
        return 0.5
    return min(0.99, max(0.01, float(confidence) / 10.0))


def update_scoreboard(ledger_path: str, graded_artifacts: list[dict]) -> dict:
    """Aggregate CLV win-rate, mean Brier (calibration) and hit-rate across all
    graded edges; write analysis/scoreboard.json next to the ledger."""
    clvs, briers, hits = [], [], []
    for art in graded_artifacts:
        for e in art.get("edges", []):
            if "clv" in e:
                clvs.append(e["clv"])
            if "brier" in e:
                briers.append(e["brier"])
            if "hit" in e:
                hits.append(1 if e["hit"] else 0)
    board = {
        "n_edges_graded": max(len(clvs), len(briers), len(hits)),
        "clv_win_rate": round(sum(1 for c in clvs if c > 0) / len(clvs), 3) if clvs else None,
        "mean_clv": round(sum(clvs) / len(clvs), 4) if clvs else None,
        "mean_brier": round(sum(briers) / len(briers), 4) if briers else None,
        "hit_rate": round(sum(hits) / len(hits), 3) if hits else None,
    }
    out_path = os.path.join(os.path.dirname(ledger_path), "scoreboard.json")
    with open(out_path, "w") as f:
        json.dump(board, f, indent=2)
    return board
