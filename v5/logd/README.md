# v5 logd — log receiver

Tiny standalone service that stores the V5 dashboard's session logs on the VM.
**Not** part of `ourWebSocket` — separate process, separate port (8803).

## Endpoints
- `POST /log`  body `{"slug":"...", "rows":[...]}` → writes `v5/logs/<slug>.json`
- `GET /health` → `{ok, dir}`
- `GET /logs`  → `{logs:[...], count}`

## Run (systemd)
```
sudo cp v5logd.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now v5logd
```
Log dir: `/home/vincent/projects/61426/v5/logs` (override via `V5_LOG_DIR`). Port `8803` (`V5_LOG_PORT`).

## Firewall
GCP must allow tcp:8803 (8802 is already open for ourWebSocket):
```
gcloud compute firewall-rules create allow-v5-logd \
  --allow tcp:8803 --source-ranges 0.0.0.0/0 --project <project>
```

Note: once V5 is served over HTTPS (Vercel), posting to `http://vm:8803` becomes mixed
content → needs TLS on the VM (same item as the wss work for ourWebSocket).
