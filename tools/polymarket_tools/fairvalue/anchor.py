"""De-vig external sportsbook odds into fair probabilities.

The fan-out agent scrapes consensus/sharp book odds (via WebSearch) and passes
them here as a dict. This module only removes the bookmaker margin (overround)
by normalizing implied probabilities. It does NOT fetch anything.
"""

from __future__ import annotations


def american_to_decimal(american: float) -> float:
    a = float(american)
    return 1.0 + (a / 100.0 if a > 0 else 100.0 / abs(a))


def devig_decimal(odds: dict[str, float]) -> dict[str, float]:
    """Decimal odds per outcome -> de-vigged fair probabilities (sum to 1).

    Multiplicative (normalization) method: implied = 1/odds, fair = implied/sum.
    """
    implied = {k: 1.0 / float(v) for k, v in odds.items() if v and float(v) > 0}
    total = sum(implied.values())
    if total <= 0:
        return {k: 0.0 for k in odds}
    return {k: implied[k] / total for k in implied}


def devig_american(odds: dict[str, float]) -> dict[str, float]:
    """American odds per outcome -> de-vigged fair probabilities."""
    return devig_decimal({k: american_to_decimal(v) for k, v in odds.items()})


def overround(odds_decimal: dict[str, float]) -> float:
    """Bookmaker margin: sum of implied probs minus 1 (e.g. 0.05 = 5% vig)."""
    return sum(1.0 / float(v) for v in odds_decimal.values() if v and float(v) > 0) - 1.0
