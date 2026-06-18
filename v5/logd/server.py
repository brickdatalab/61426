#!/usr/bin/env python3
"""v5 logd — tiny standalone log receiver for the V5 dashboard.

POST /log   {slug, rows}  -> writes <V5_LOG_DIR>/<slug>.json
GET  /health             -> {ok, dir}
GET  /logs               -> {logs:[...], count}

Standalone. Does NOT touch ourWebSocket. No auth (it only stores the dashboard's own logs).
Run via the v5logd systemd unit (see v5logd.service) or: python server.py
"""
from __future__ import annotations
import json, os, pathlib, logging
from aiohttp import web

LOG_DIR = os.environ.get('V5_LOG_DIR', '/home/vincent/projects/61426/v5/logs')
PORT = int(os.environ.get('V5_LOG_PORT', '8803'))


def _safe(slug: str) -> str:
    return ''.join(c for c in str(slug) if c.isalnum() or c in '-_') or 'unknown'


async def post_log(request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return web.json_response({'ok': False, 'error': 'invalid json'}, status=400)
    slug = (data or {}).get('slug') or 'unknown'
    rows = (data or {}).get('rows', [])
    os.makedirs(LOG_DIR, exist_ok=True)
    path = pathlib.Path(LOG_DIR) / f'{_safe(slug)}.json'
    # atomic-ish write
    tmp = path.with_suffix('.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)
    logging.getLogger('logd').info('saved slug=%s rows=%d -> %s', slug, len(rows), path.name)
    return web.json_response({'ok': True, 'slug': slug, 'rows': len(rows), 'path': str(path)})


async def health(_): return web.json_response({'ok': True, 'dir': LOG_DIR})
async def list_logs(_):
    p = pathlib.Path(LOG_DIR)
    files = sorted(f.name for f in p.glob('*.json')) if p.exists() else []
    return web.json_response({'logs': files, 'count': len(files)})


def main():
    os.makedirs(LOG_DIR, exist_ok=True)
    log = logging.getLogger('logd'); log.setLevel(logging.INFO)
    log.addHandler(logging.StreamHandler())
    app = web.Application()
    app.router.add_post('/log', post_log)
    app.router.add_get('/health', health)
    app.router.add_get('/logs', list_logs)
    log.info('v5 logd on :%d -> %s', PORT, LOG_DIR)
    web.run_app(app, host='0.0.0.0', port=PORT, access_log=None)


if __name__ == '__main__':
    main()
