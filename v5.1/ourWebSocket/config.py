"""ourWebSocket — tunables. Override via env (OWS_*)."""
import os

HOST = os.environ.get("OWS_HOST", "0.0.0.0")
PORT = int(os.environ.get("OWS_PORT", "8802"))

# Broadcast: poll this often and send ONLY if a trade arrived since the last send (on-change).
MIN_INTERVAL_S = float(os.environ.get("OWS_MIN_INTERVAL_S", "0.1"))

ALLOWED_SYMBOLS = {"BTCUSDT", "ETHUSDT"}
DEFAULT_SYMBOL = "BTCUSDT"

# Candle timeframe for cvd_candle_usd (the ONLY candle-dependent field).
ALLOWED_BARS = {"5m": 300_000, "15m": 900_000}
DEFAULT_BAR = "5m"

# Data sources: spot via WS (real-time). Perp via REST poll (continuous by fromId -> seam-free,
# accurate from tick 1; the divergence field is 5m-windowed so 1s lag is negligible). REST also
# used for startup backfills.
SPOT_WS_TEMPLATE = "wss://stream.binance.com:9443/ws/{sym}@aggTrade"
SPOT_REST_URL = "https://api.binance.com/api/v3/aggTrades"
PERP_REST_URL = "https://fapi.binance.com/fapi/v1/aggTrades"

PERP_POLL_S = float(os.environ.get("OWS_PERP_POLL_S", "1.0"))
LIMIT = 1000
PAGE_CAP = 10
BACKFILL_MS = 300_000
BACKFILL_PAGE_CAP = 60

LARGE_PRINT_USD = float(os.environ.get("OWS_LARGE_PRINT_USD", "100000"))
BAR_MS = 900_000

WS_BACKOFF_MAX = 30.0

LOG_DIR = os.environ.get("OWS_LOG_DIR", "/home/vincent/ourWebSocket/logs")
LOG_FILE = os.path.join(LOG_DIR, "service.log")

# v5.1 /log hardening
LOG_SECRET = os.environ.get("OWS_LOG_SECRET", "")          # required for /v51/log when non-empty
LOG_DIR_MAX_BYTES = int(os.environ.get("OWS_LOG_DIR_MAX_BYTES", str(500 * 1024 * 1024)))  # 500MB
LOG_DIR_MAX_FILES = int(os.environ.get("OWS_LOG_DIR_MAX_FILES", "5000"))
