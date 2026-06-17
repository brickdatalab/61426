# CLAUDE.md — last30days Research Workflow

This directory exists to run the `/last30days` skill and archive its raw source
data, one folder per question, then synthesize an answer from that data.

## The workflow (every run)

1. **User gives a question + a folder name.** The folder name comes from the
   user with each request — do NOT invent it.

2. **Create the folder** at `/Users/vitolo/Desktop/61426/<folder-name>/`.

3. **Run the `/last30days` skill** on the question.

4. **Save ALL raw source data** the skill returns into that folder:
   - Every source (Reddit, X, YouTube, TikTok, Hacker News, Polymarket,
     GitHub, web).
   - As many files and formats as are useful (`.md`, `.json`, `.txt`, `.csv`,
     etc.) — raw posts, results, metadata, engagement numbers, URLs.
   - Goal: nothing from the skill output is lost; it's all on disk.

   **Folder layout (consistent every run):**
   ```
   <folder-name>/
     manifest.json     # index of every source: platform, url, captured fields
     reddit.md
     x.md
     youtube.md
     tiktok.md
     hackernews.md
     polymarket.md
     github.md
     web.md
     prediction.md     # written in the synthesis phase (see below)
   ```
   Only create platform files that actually have data. `manifest.json` always
   indexes what was captured.

5. **Parallelize file writing with sub-agents.** Do NOT write every file
   serially from the main thread — that is too slow. Spawn general-purpose
   sub-agents to write files concurrently, split by platform/source batch, as
   data comes back. One agent per platform (or per batch) is the default split.

6. **Save the prediction.** In the high-effort synthesis phase, write the final
   prediction to `<folder-name>/prediction.md` so each run is a complete,
   self-contained record alongside its raw sources.

## Effort levels (set by the user, be aware of both)

- **LOWER effort** — during the skill run + file-creation phase. This is
  mechanical: source the data, write the files. Speed over depth.
- **HIGHER effort** — during synthesis. After the data is on disk, the user
  raises effort so the answer to the question is reasoned carefully from all
  the saved source data.

## Prediction mandate (high-effort synthesis phase)

Once data collection is complete AND it is confirmed the `/last30days`
research is done AND the user turns on high-effort reasoning:

- **Predict the outcome of the question** with the highest possible accuracy
  and conviction, derived strictly from all the data gathered.
- This applies to ANY question asked — the job is always: gather all data,
  then make the most accurate, conviction-backed prediction the data supports.
- Be specific. Commit to a call (and a probability/confidence where it fits).
  Don't hedge into vagueness, but don't manufacture certainty the data can't
  carry — conviction must be grounded in the collected sources.

## Rules

- One folder per run. Never reuse or overwrite a previous run's folder.
- The folder holds RAW source data, not just conclusions.
- **Unconfirmed until first run:** this workflow assumes `/last30days` returns
  raw, per-source data that can be captured and written to disk. If the skill
  instead emits only a synthesized summary, save the richest output it does
  provide and tell the user the raw-capture goal was partially limited — do not
  silently pretend full raw data was archived.
- `/last30days` measures what people are *saying* (discourse, sentiment,
  recent chatter) — not verified ground truth. Synthesis must reflect that.
- 30-day window: results are recent chatter, not full topic history.

## last30days tuning learnings (apply on future runs)

Config facts (this machine):
- **Perplexity is DEAD** — OpenRouter returns `401 invalid_api_key` with
  `is_byok:true`; the underlying Perplexity key is invalid. Do not rely on
  `--search=perplexity`; it fails silently. (Fix = valid Perplexity key.)
- Configured & working: Brave, Exa, Google, ScrapeCreators, XAI, yt-dlp, gh.
  Missing optional binaries: digg-pp-cli, xurl.

Run-tuning that helped / would help:
- `--polymarket-keywords "..."` — pin Polymarket to the right markets; kills
  name-collision junk (e.g. "Jong" → Kim Jong Un). High value for any topic
  whose name collides with politics/sports/celebs.
- `EXCLUDE_SOURCES=...` — drop sources that are pure noise for the topic
  (e.g. TikTok/Instagram/HN were 100% noise on a niche tennis match). Saves
  ScrapeCreators spend and tightens the corpus.
- `--x-related=<news/handle list>` — weight up the actual high-signal voices.
- Tighter `--days=N` is SITUATIONAL, not automatic: it trims noise but also
  drops older context (form runs, prior head-to-heads). Use only when the
  topic IS the same-day event and history doesn't matter.
- `--deep` amplifies noise on niche topics; prefer default or `--quick` there.
- For "X vs Y" outcome questions, consider comparison mode (`vs` topic +
  `--competitors-plan`) to force full per-entity targeting on both sides.

Tool nature caveat: last30days measures discourse, not structured/live data.
For sporting events the best inputs (live odds aggregation, surface Elo, live
score) live outside it; lean on Polymarket + books when present.
