#!/usr/bin/env python3
"""Tiny local server for the get-fit dashboard.

Serves index.html, the engine's view model at /api/state, and accepts the
config page's save at POST /api/settings. Writes settings.json, which
getfit.py reads on every cron tick.

    python3 server.py [--port 8777] [--host 0.0.0.0]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import getfit  # noqa: E402

BASE = Path(__file__).resolve().parent


def _slug(name: str, taken: set[str]) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "exercise"
    base, i = slug, 2
    while slug in taken:
        slug = f"{base}-{i}"
        i += 1
    return slug


def validate(raw: dict) -> dict:
    interval = int(raw.get("interval_minutes", 90))
    response = int(raw.get("response_minutes", 10))
    if not 1 <= interval <= 24 * 60:
        raise ValueError("interval must be 1..1440 minutes")
    if not 1 <= response <= 240:
        raise ValueError("response window must be 1..240 minutes")

    for key in ("quiet_start", "quiet_end"):
        value = str(raw.get(key, "00:00"))
        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", value):
            raise ValueError(f"{key} must look like HH:MM")

    tz_name = str(raw.get("timezone") or "UTC")
    try:
        ZoneInfo(tz_name)
    except Exception as exc:
        raise ValueError(f"unknown timezone {tz_name!r}") from exc

    exercises_raw = raw.get("exercises") or []
    if not exercises_raw:
        raise ValueError("keep at least one exercise")

    exercises, taken = [], set()
    for item in exercises_raw:
        name = str(item.get("name", "")).strip()[:40]
        if not name:
            raise ValueError("every exercise needs a name")
        ex_id = str(item.get("id") or "").strip()
        if not ex_id or ex_id in taken:
            ex_id = _slug(name, taken)
        taken.add(ex_id)
        minimum = int(item.get("min") or 0)
        if minimum < 0 or minimum > 500:
            raise ValueError(f"{name}: minimum must be 0..500")
        maximum = item.get("max")
        if maximum in (None, "", "null"):
            maximum = None
        else:
            maximum = int(maximum)
            if maximum < minimum:
                raise ValueError(f"{name}: maximum must be >= minimum")
        exercises.append({"id": ex_id, "name": name, "min": minimum, "max": maximum})

    # last exercise has no overflow target, so it is uncapped by definition
    exercises[-1]["max"] = None
    return {
        "timezone": tz_name,
        "interval_minutes": interval,
        "response_minutes": response,
        "quiet_start": raw.get("quiet_start", "00:00"),
        "quiet_end": raw.get("quiet_end", "07:00"),
        "exercises": exercises,
    }


class Handler(SimpleHTTPRequestHandler):
    server_version = "getfit/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE), **kwargs)

    def log_message(self, fmt, *args):  # keep the journal quiet
        sys.stderr.write("[getfit] " + (fmt % args) + "\n")

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] in ("/api/state", "/api/state/"):
            return self._json(getfit.view())
        if self.path.split("?")[0] in ("/settings", "/settings/"):
            self.path = "/settings.html"
        if self.path in ("/", ""):
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        route = self.path.split("?")[0]
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json({"ok": False, "error": "bad JSON body"}, 400)

        if route == "/api/settings":
            try:
                clean = validate(raw.get("settings", raw))
            except (ValueError, TypeError) as exc:
                return self._json({"ok": False, "error": str(exc)}, 400)
            db = getfit.connect()
            try:
                getfit.init_db(db)
                saved = getfit.save_settings(db, clean)
            finally:
                db.close()
            return self._json({"ok": True, "settings": saved, "saved_at":
                               datetime.now(timezone.utc).isoformat()})

        if route == "/api/confirm":
            rc = getfit.cmd_confirm(source="web")
            return self._json({"ok": rc == 0}, 200 if rc == 0 else 409)

        return self._json({"ok": False, "error": "not found"}, 404)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--tls-port", type=int, default=8443)
    ap.add_argument("--cert", default=str(BASE / "certs" / "getfit.crt"))
    ap.add_argument("--key", default=str(BASE / "certs" / "getfit.key"))
    args = ap.parse_args()
    os.chdir(BASE)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[getfit] http  {BASE} on http://{args.host}:{args.port}", flush=True)

    # Browsers only allow notification permissions on a secure context, so the
    # same app is also served over TLS on its own port when a cert is present.
    httpsd = None
    if Path(args.cert).exists() and Path(args.key).exists():
        httpsd = ThreadingHTTPServer((args.host, args.tls_port), Handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(args.cert, args.key)
        httpsd.socket = ctx.wrap_socket(httpsd.socket, server_side=True)
        print(f"[getfit] https {BASE} on https://{args.host}:{args.tls_port}", flush=True)

    if httpsd:
        threading.Thread(target=httpsd.serve_forever, daemon=True).start()
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
