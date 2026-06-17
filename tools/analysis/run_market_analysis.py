"""Deterministic spine of the analysis harness.

Phase 0: snapshot every sub-market of a game at T0 (via the game_id grouping).
Phase 3: assemble + write the artifact. The PARALLEL fan-out (Lanes A/B/C +
skeptics) is driven by the orchestrating model with the Agent tool and the
polymarket_tools handlers; this spine only provides reproducible data + logging.

See METHODOLOGY.md (next to this file) for the full standing playbook.
"""

from __future__ import annotations

from polymarket_tools.client import GAMMA_BASE
from polymarket_tools.normalize import parse_token_ids, to_float

from .artifact import build_artifact, write_artifact


def build_snapshot(events: list, t0: int) -> dict:
    """Pure transform: gamma events (same game_id) -> immutable T0 snapshot.

    Returns {slug, t0, markets:[{event_slug, question, condition_id,
    clob_token_ids, yes_price}], price_vector:{condition_id: yes_price}}.
    """
    markets = []
    price_vector = {}
    for ev in events:
        ev_slug = ev.get("slug")
        for m in ev.get("markets") or []:
            prices = [to_float(x) for x in _as_list(m.get("outcomePrices"))]
            yes = prices[0] if prices else None
            cid = m.get("conditionId")
            markets.append({
                "event_slug": ev_slug,
                "question": m.get("question"),
                "condition_id": cid,
                "clob_token_ids": parse_token_ids(m.get("clobTokenIds")),
                "yes_price": yes,
            })
            if cid is not None:
                price_vector[cid] = yes
    slug = events[0].get("slug") if events else "unknown"
    return {"slug": slug, "t0": t0, "markets": markets, "price_vector": price_vector}


def _as_list(v):
    return parse_token_ids(v)  # same flexible list-or-json-string handling


async def scope_event(client, game_id, t0: int) -> dict:
    """Fetch all child events for a game_id and build the T0 snapshot."""
    events = await client.get(GAMMA_BASE, "/events", {"game_id": game_id, "limit": 50})
    return build_snapshot(events if isinstance(events, list) else [], t0)


def assemble_and_log(base_dir, snapshot, edges, scorecards, anchors, coherence=None) -> dict:
    """Phase 3: build the artifact from lane outputs and write it to disk."""
    art = build_artifact(
        t0=snapshot["t0"],
        slug=snapshot["slug"],
        price_vector=snapshot["price_vector"],
        edges=edges,
        scorecards=scorecards,
        anchors=anchors,
        coherence=coherence,
    )
    paths = write_artifact(base_dir, art)
    return {"artifact": art, **paths}
