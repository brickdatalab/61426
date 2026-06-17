"""resolve_token — map a CLOB token id to its parent market + outcome.

Verified live (2026-06-14): the documented Gamma path /markets-by-token/{id}
404s (no such route). The working resolution is the Gamma /markets filter
GET /markets?clob_token_ids={tokenId}, which returns a LIST; the first match is
the parent market. From it we read clobTokenIds (JSON-encoded string of all
sibling token ids) and outcomes (JSON-encoded string of labels), then locate the
queried token's index to derive outcome + outcome_index.
"""

from __future__ import annotations

from ..client import GAMMA_BASE, PolyError
from ..normalize import parse_str_list, parse_token_ids
from ..registry import tool
from ..schema import err, err_from_exc, ok

_INPUT = {
    "type": "object",
    "properties": {
        "token_id": {
            "type": "string",
            "description": "CLOB token/asset id to resolve.",
        },
    },
    "required": ["token_id"],
    "additionalProperties": False,
}


@tool(
    name="resolve_token",
    description=(
        "Resolve a CLOB token id to its parent market: condition_id, the token's "
        "outcome + index, and all sibling token ids / outcome labels."
    ),
    input_schema=_INPUT,
)
async def resolve_token(ctx, args: dict) -> dict:
    token_id = args["token_id"]
    try:
        raw = await ctx.client.get(
            GAMMA_BASE, "/markets", {"clob_token_ids": token_id}
        )
    except PolyError as e:
        if e.status == 404:
            return err("not_found", f"token not found: {token_id}", e.status, e.endpoint)
        return err_from_exc(e)

    if not isinstance(raw, list) or not raw:
        return err("not_found", f"token not found: {token_id}", 404, f"{GAMMA_BASE}/markets")
    market = raw[0]

    token_ids = parse_token_ids(market.get("clobTokenIds"))
    outcomes = parse_str_list(market.get("outcomes"))

    outcome_index = token_ids.index(token_id) if token_id in token_ids else None
    outcome = (
        outcomes[outcome_index]
        if outcome_index is not None and outcome_index < len(outcomes)
        else None
    )

    data = {
        "token_id": token_id,
        "condition_id": market.get("conditionId"),
        "outcome": outcome,
        "outcome_index": outcome_index,
        "token_ids": token_ids,
        "outcomes": outcomes,
    }
    return ok(data)
