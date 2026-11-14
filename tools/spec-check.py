"""Validate the running API against docs/openapi.yaml — both directions.

    python3 tools/spec-check.py [base-url]        # default http://127.0.0.1:8787

Direction 1: the response must satisfy the documented schema (types, required keys).
Direction 2: the response must not carry keys the schema never mentions — that is how a
client ends up with undocumented fields and how a docs pass silently rots.

Needs the server running with auth off (GETFIT_REQUIRE_TOKEN=0) or a token in TOKEN.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

import jsonschema
import yaml

REPO = Path(__file__).resolve().parent.parent
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787").rstrip("/")
TOKEN = os.environ.get("TOKEN", "")

SPEC = yaml.safe_load((REPO / "docs/openapi.yaml").read_text())


def resolve(node, seen=None):
    """Inline $ref: this spec only points at #/components/..."""
    seen = seen or set()
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/"):
            if ref in seen:
                return {}
            target = SPEC
            for part in ref[2:].split("/"):
                target = target[part]
            return resolve(target, seen | {ref})
        return {k: resolve(v, seen) for k, v in node.items()}
    if isinstance(node, list):
        return [resolve(v, seen) for v in node]
    return node


def fetch(path: str):
    req = urllib.request.Request(f"{BASE}{path}")
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    with urllib.request.urlopen(req, timeout=10) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def undocumented(value, schema, trail="$", found=None):
    """Keys the response has and the schema does not describe."""
    found = found if found is not None else []
    if isinstance(value, dict) and isinstance(schema, dict):
        props = schema.get("properties") or {}
        extra = schema.get("additionalProperties")
        for key, item in value.items():
            if key in props:
                undocumented(item, props[key], f"{trail}.{key}", found)
            elif isinstance(extra, dict):
                undocumented(item, extra, f"{trail}.{key}", found)
            elif extra is not True and props:
                found.append(f"{trail}.{key}")
    elif isinstance(value, list) and isinstance(schema, dict):
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value[:3]):
                undocumented(item, item_schema, f"{trail}[{index}]", found)
    elif isinstance(schema, dict):
        for combiner in ("allOf", "oneOf", "anyOf"):
            if combiner in schema:
                for part in schema[combiner]:
                    undocumented(value, part, trail, found)
                break
    return found


def find_operation(path: str, method: str):
    for spec_path, item in SPEC["paths"].items():
        if spec_path == path:
            return item.get(method)
    raise KeyError(f"{method.upper()} {path} is not in the spec")


CASES = [
    ("/dashboard", "/api/v1/dashboard"),
    ("/meta", "/api/v1/meta"),
    ("/now", "/api/v1/now"),
    ("/muscles", "/api/v1/muscles"),
    ("/muscles/{slug}", "/api/v1/muscles/chest"),
    ("/library", "/api/v1/library"),
    ("/profile", "/api/v1/profile"),
    ("/profile/history", "/api/v1/profile/history"),
    ("/checkins", "/api/v1/checkins?limit=3"),
    ("/checkins/todo", "/api/v1/checkins/todo"),
    ("/calendar", "/api/v1/calendar"),
    ("/settings", "/api/v1/settings"),
    ("/rounds", "/api/v1/rounds?limit=2"),
]

failures = 0
for spec_path, url in CASES:
    operation = find_operation(spec_path, "get")
    schema = resolve(operation["responses"]["200"]["content"]["application/json"]["schema"])
    body = fetch(url)
    validator = jsonschema.Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(body), key=lambda e: list(e.absolute_path))
    missing = undocumented(body, schema)
    status = "ok  " if not errors and not missing else "FAIL"
    if errors or missing:
        failures += 1
    print(f"  {status} GET {spec_path:22} {len(errors)} schema errors, {len(missing)} undocumented keys")
    for error in errors[:4]:
        print(f"        schema: {'/'.join(str(p) for p in error.absolute_path) or '(root)'}: {error.message[:110]}")
    for key in missing[:6]:
        print(f"        undocumented: {key}")

# the round detail needs a key from the page
page = fetch("/api/v1/rounds?limit=1")
key = page["items"][0]["key"]
operation = find_operation("/rounds/{key}", "get")
schema = resolve(operation["responses"]["200"]["content"]["application/json"]["schema"])
body = fetch(f"/api/v1/rounds/{key}")
errors = list(jsonschema.Draft202012Validator(schema).iter_errors(body))
missing = undocumented(body, schema)
print(f"  {'ok  ' if not errors and not missing else 'FAIL'} GET /rounds/{{key}}        "
      f"{len(errors)} schema errors, {len(missing)} undocumented keys")
failures += 1 if errors or missing else 0
for error in errors[:4]:
    print(f"        schema: {'/'.join(str(p) for p in error.absolute_path) or '(root)'}: {error.message[:110]}")
for name in missing[:6]:
    print(f"        undocumented: {name}")

print(f"\n{len(CASES) + 1 - failures}/{len(CASES) + 1} endpoints conform")
sys.exit(1 if failures else 0)
