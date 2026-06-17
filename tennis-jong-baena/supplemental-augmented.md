# Supplemental augmented pull (2026-06-14, pre-result)

Second data pass requested before high-effort synthesis. Goal: add predictive
signal WITHOUT looking up the live/final score. No score was retrieved.

## Live Polymarket re-check (Gamma API, gamma-api.polymarket.com)

Main moneyline market — STILL OPEN (closed: false, active: true), i.e. not resolved:

- **Cattolica: Jesper de Jong vs Roberto Carballes Baena**
  - Jesper de Jong: price 0.78 | lastTradePrice 0.81 | bestBid 0.77 / bestAsk 0.79
  - Roberto Carballes Baena: 0.22
  - Read: market midpoint ~0.78, last trade 0.81 — firmed slightly toward De Jong
    vs the earlier 0.78 snapshot. Market remains unresolved.

Note: derivative markets (set winners, games O/U) exist; some Set-1 markets showed
umaResolutionStatus "proposed". NOT mined here — that edges into live match state
(the score), which was explicitly out of scope for this pull.

## Multi-book pre-match odds

- Tennis Tonic / aggregator: De Jong 1.50 (~67% implied) | Carballes Baena 2.375 (~42% implied; reflects bookmaker overround).
- Tennis Tonic pick: De Jong in 3 sets.
- No additional sportsbook prices (Pinnacle, bet365, Oddspedia, Forebet) were
  surfaced via search beyond the above.

## Source-availability finding (answers "is anything lacking?")

- **Perplexity is a dead source in this config.** OpenRouter returned
  `401 invalid_api_key`, `is_byok: true` — Perplexity is wired as bring-your-own-key
  and the underlying Perplexity key is invalid. The skill will silently fail on
  Perplexity. Fix: add a valid Perplexity API key, or route a non-BYOK model.
- The standalone OpenRouter MCP tool also returned 401 (its own unrelated key).
- Missing optional binaries: digg-pp-cli (Digg), xurl (official X API). Not relevant here.
- Everything else (Brave, Exa, Google, ScrapeCreators, XAI, yt-dlp, gh) is configured.

## Net signal going into synthesis

- Market (money-backed): De Jong ~78-81% (Polymarket, live, unresolved).
- Books: De Jong ~67% implied.
- Ranking: De Jong #83 vs Carballes Baena #191.
- H2H: 1-0 Carballes Baena (only meeting, Murcia SF, clay, Mar 2026, 2-6 6-4 6-4).
- Counterweights: De Jong's weak 2026 ATP-tour record outside Roland Garros;
  Carballes Baena is an ex-top-50 clay specialist and won the lone H2H on clay.
