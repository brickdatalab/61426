"""Internal no-arbitrage / coherence checks across one event's own markets.

Model-free: relies only on the fact that a complete, mutually-exclusive set of
outcomes must price to ~1 after de-vig. Gaps reveal relative mispricing without
any external model. The fan-out agent feeds normalized Yes-probabilities in.
"""

from __future__ import annotations

# A gap larger than this (in probability) is worth flagging; smaller is noise/vig.
DEFAULT_TOLERANCE = 0.03


def triplet_gap(probs: list[float]) -> float:
    """Result triplet (win/draw/loss; HT lead/draw/lead; 2H win/draw/win) Yes-probs
    should sum to ~1. Returns sum-1 (positive = overpriced set, negative = cheap set)."""
    return sum(probs) - 1.0


def distribution_gap(listed: list[float], field: float) -> float:
    """Exact-score listed Yes-probs + 'Any Other Score' (field) should sum to ~1.
    Negative => total < 1 => field/blowout UNDERpriced; positive => OVERpriced."""
    return (sum(listed) + field) - 1.0


def winner_from_scores(win_scores: list[float], draw_scores: list[float], loss_scores: list[float]) -> dict:
    """Derive P(win/draw/loss) from the exact-score market, for cross-check vs the 1X2 market."""
    return {"win": sum(win_scores), "draw": sum(draw_scores), "loss": sum(loss_scores)}


def _reading(gap: float, kind: str) -> str:
    if abs(gap) < DEFAULT_TOLERANCE:
        return "coherent"
    if kind == "distribution":
        return "field/blowout underpriced" if gap < 0 else "field/blowout overpriced"
    return "set underpriced (cheap)" if gap < 0 else "set overpriced (rich)"


def report(checks: list[dict]) -> list[dict]:
    """Run a batch of coherence checks.

    Each check dict: {"name", "kind": "triplet"|"distribution", "legs": [...],
    and for triplet "probs":[...]; for distribution "listed":[...], "field":float}.
    Returns a list of {check, kind, legs, gap, reading} sorted by |gap| desc.
    """
    out = []
    for c in checks:
        kind = c["kind"]
        if kind == "triplet":
            gap = triplet_gap(c["probs"])
        elif kind == "distribution":
            gap = distribution_gap(c["listed"], c["field"])
        else:
            continue
        out.append({
            "check": c.get("name", kind),
            "kind": kind,
            "legs": c.get("legs", []),
            "gap": round(gap, 4),
            "reading": _reading(gap, kind),
        })
    out.sort(key=lambda x: abs(x["gap"]), reverse=True)
    return out
