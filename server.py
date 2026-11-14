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
import muscles  # noqa: E402

BASE = Path(__file__).resolve().parent


def _slug(name: str, taken: set[str]) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "exercise"
    base, i = slug, 2
    while slug in taken:
        slug = f"{base}-{i}"
        i += 1
    return slug


def _form_url(value, name: str) -> str | None:
    """A form article is a link or nothing — never a guess."""
    url = str(value or "").strip()[:500]
    if not url:
        return None
    if not re.fullmatch(r"https?://[^\s]+", url):
        raise ValueError(f"{name}: the form article must be an http(s) link")
    return url


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
        exercises.append({"id": ex_id, "name": name, "min": minimum, "max": maximum,
                          "form_url": _form_url(item.get("form_url"), name)})

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


def validate_checkin(raw: dict) -> dict:
    """Clamp a questionnaire into something the model can trust.

    Every field is optional except `kind`; the model degrades gracefully when
    an answer is missing, and a partial answer is better than no answer.
    """
    payload = dict(raw)
    kind = str(payload.get("kind") or "").strip()
    if kind not in ("gate", "post"):
        raise ValueError("kind must be 'gate' or 'post'")
    payload["kind"] = kind

    for key in ("stress", "fatigue", "soreness", "prs", "srpe", "rir", "reps"):
        value = payload.get(key)
        if value in (None, "", "null"):
            payload.pop(key, None)
            continue
        try:
            payload[key] = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{key} must be a number") from exc

    # sleep is hours, not a 1-5 rating
    sleep = payload.get("sleep")
    if sleep in (None, "", "null"):
        payload.pop("sleep", None)
    else:
        try:
            payload["sleep"] = round(float(sleep) * 2) / 2
        except (TypeError, ValueError) as exc:
            raise ValueError("sleep must be hours") from exc
        if not 0 <= payload["sleep"] <= 14:
            raise ValueError("sleep must be 0..14 hours")

    for key in ("stress", "fatigue", "soreness"):
        if payload.get(key) is not None and not 1 <= payload[key] <= 5:
            raise ValueError(f"{key} must be 1..5")
    if payload.get("prs") is not None and not 0 <= payload["prs"] <= 10:
        raise ValueError("prs must be 0..10")
    if payload.get("srpe") is not None and not 0 <= payload["srpe"] <= 10:
        raise ValueError("srpe must be 0..10")
    if payload.get("rir") is not None and not 0 <= payload["rir"] <= 3:
        raise ValueError("rir must be 0..3")

    stopper = payload.get("stopper")
    if stopper not in (None, "", "muscle", "breathing", "joints", "boredom"):
        raise ValueError("stopper must be muscle, breathing, joints or boredom")

    per_muscle = payload.get("muscle_soreness") or {}
    if not isinstance(per_muscle, dict):
        raise ValueError("muscle_soreness must be an object of slug: 1..5")
    clean = {}
    for slug, value in per_muscle.items():
        if str(slug) not in muscles.MUSCLE_NAME:
            raise ValueError(f"unknown muscle {slug!r}")
        try:
            n = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{slug}: soreness must be 1..5") from exc
        if not 1 <= n <= 5:
            raise ValueError(f"{slug}: soreness must be 1..5")
        clean[str(slug)] = n
    payload["muscle_soreness"] = clean

    if kind == "post" and not payload.get("round_key"):
        raise ValueError("a post-set check-in needs the round_key")
    if payload.get("pain_where") and payload["pain_where"] not in muscles.MUSCLE_NAME:
        raise ValueError("pain_where must be a muscle slug")
    return payload


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
            rc, receipt = getfit.confirm(source="web")
            return self._json({"ok": rc == 0, "receipt": receipt},
                              200 if rc == 0 else 409)

        if route == "/api/checkin":
            try:
                clean = validate_checkin(raw.get("checkin", raw))
            except (ValueError, TypeError) as exc:
                return self._json({"ok": False, "error": str(exc)}, 400)
            db = getfit.connect()
            try:
                getfit.init_db(db)
                settings = getfit.load_settings(db)
                result = muscles.record_checkin(
                    db, clean, window_minutes=int(settings.get("response_minutes", 10)),
                    tz=getfit.tz_of(settings))
            except ValueError as exc:
                return self._json({"ok": False, "error": str(exc)}, getattr(exc, "code", 400))
            finally:
                db.close()
            return self._json(result)

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
