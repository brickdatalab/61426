# Git, Deployment, and Data Workflow

## Git connection

The local repository’s `origin` fetch and push URLs are both:

```text
https://github.com/brickdatalab/61426.git
```

The local branch is `main`. At ingestion the local checkout was `f44b039`, while fetched `origin/main` was `5f97993`. The local-only commit adds `v8/analysis/90_conviction_tiers.py`. The remote-only history consists of 101 automated autopsy synchronization commits. This means a normal “local main equals GitHub main” assumption is false; the remote is actively receiving data-log commits.

The GitHub repository is public, has a `main` branch, and contains the version ladder, runner, collector, tools, web app, and autopsy directories. GitHub reports HTML, JavaScript, Python, and TypeScript as the main languages.

## Deployment relationship

The documented deployment model is:

- the VM hosts `ourWebSocket`, the headless runner, log storage, and autopsy synchronization;
- the runner uses a Git checkout and imports `vX/src/signals.mjs` directly;
- the Vercel app points server-side at the VM control API over pinned TLS;
- the browser dashboard and VM runner are intended to execute the same engine source;
- autopsy sync verifies completed bars against Polymarket Gamma and commits corrected logs to GitHub.

The key consequence is that Git is both source distribution and an append-only-ish data transport for settled logs. Engine code changes and log commits share the same `main` history but are operationally different kinds of change.

## Collector path

`collector/collector.mjs` runs four streams: BTC/ETH × 5m/15m. It consumes OWS, resolves Polymarket tokens, polls CLOB books, runs copied v5.3 and v5.4 engines, builds dashboard-compatible rows, and batches ticks/bars into BigQuery dataset `raw_d`. Failed BigQuery inserts are written to local NDJSON spool files and retried on the next flush (`collector/collector.mjs:108-129`).

The collector is not the v8 runner. It is a parallel historical/data-collection path whose engine copies are tested byte-identical to `v5.3/src/signals.mjs` and `v5.4/src/signals.mjs`.

## Evidence and validation

The project treats replay gates and continuous 24/7 evidence as the authority for signal changes. `v8/README.md`, `CONTEXT.md`, and `CLAUDE.md` document the current rule, the v7 out-of-sample collapse, the v8 frontier result, and the hard rule that strategy changes must be discussion-first and shipped as new version forks.

