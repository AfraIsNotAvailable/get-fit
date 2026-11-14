#!/usr/bin/env bash
# get-fit — cut over from the Python dashboard to the Node API.
#
# Run this ON the Pi, as afra, from the checkout:
#
#   ./scripts/cutover.sh shadow     # install + run read-only on :8787, nothing public changes
#   ./scripts/cutover.sh live       # flip the tunnel and the unit, disable the Python service
#   ./scripts/cutover.sh rollback   # put Python back and stop the API
#
# `shadow` is safe to re-run and can sit there for days: it writes nothing to
# the live database (GETFIT_READ_ONLY=1, SCHEDULER=off) and only listens on
# loopback. `live` asks for confirmation unless you pass --yes.
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PHASE="${1:-}"
CONFIRM="${2:-}"
NODE="${GETFIT_NODE:-$HOME/.local/node24/bin/node}"
ENV_FILE=/etc/getfit/api.env
UNIT_SRC="$APP/deploy"

say() { printf '[cutover] %s\n' "$*"; }
die() { printf '[cutover] ERROR: %s\n' "$*" >&2; exit 1; }

need_node() {
  [ -x "$NODE" ] || die "no node >= 24 at $NODE — run scripts/install-node.sh first (Debian ships 20)"
  "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' \
    || die "$NODE is too old: $("$NODE" -v) (node:sqlite needs >= 22.5, we target 24)"
  say "node $("$NODE" -v) at $NODE"
}

install_units() {
  say "installing units"
  sudo install -o root -g root -m 644 "$UNIT_SRC/getfit-api.service" /etc/systemd/system/getfit-api.service
  sudo install -o root -g root -m 644 "$UNIT_SRC/getfit-api-restart.path" /etc/systemd/system/getfit-api-restart.path
  sudo install -o root -g root -m 644 "$UNIT_SRC/getfit-api-restart.service" /etc/systemd/system/getfit-api-restart.service
  sudo systemctl daemon-reload
  sudo systemctl enable getfit-api.service
  sudo systemctl enable --now getfit-api-restart.path
}

install_env() {
  if [ -f "$ENV_FILE" ]; then
    say "$ENV_FILE exists; leaving it alone"
    return
  fi
  say "writing $ENV_FILE (placeholders — fill in the Telegram values then restart)"
  sudo install -d -o root -g afra -m 750 /etc/getfit
  sudo install -o root -g afra -m 640 "$UNIT_SRC/api.env.example" "$ENV_FILE"
}

set_env() { # set_env KEY=value
  local kv="$1" key="${1%%=*}"
  if sudo grep -q "^${key}=" "$ENV_FILE"; then
    sudo sed -i "s|^${key}=.*|${kv}|" "$ENV_FILE"
  else
    echo "$kv" | sudo tee -a "$ENV_FILE" >/dev/null
  fi
}

wait_health() {
  for _ in $(seq 1 40); do
    curl -sf -m 1 -o /dev/null "http://127.0.0.1:8787/api/v1/health" && return 0
    sleep 0.5
  done
  return 1
}

tunnel_port() { # tunnel_port 8777|8787
  local port="$1" conf=/etc/cloudflared/config.yml
  sudo cp -a "$conf" "$conf.bak-$(date +%Y%m%d-%H%M%S)"
  sudo sed -i "/hostname: fit.afrasinei.dev/,/keepAliveTimeout/ s|http://localhost:[0-9]*|http://localhost:${port}|" "$conf"
  sudo cloudflared tunnel ingress validate --config "$conf" >/dev/null 2>&1 || true
  sudo systemctl restart cloudflared
  grep -A1 "hostname: fit.afrasinei.dev" "$conf" | tail -1
}

case "$PHASE" in
  shadow)
    need_node
    say "install, test, build"
    "$APP/scripts/ci.sh"
    install_units
    install_env
    set_env GETFIT_READ_ONLY=1
    set_env SCHEDULER=off
    sudo systemctl restart getfit-api.service
    if wait_health; then
      say "shadow API healthy on http://127.0.0.1:8787 (read-only, no scheduler)"
      say "compare it: python3 tools/parity.py /home/afra/get-fit/getfit.db"
      say "when you are happy: ./scripts/cutover.sh live"
    else
      sudo journalctl -u getfit-api -n 20 --no-pager || true
      die "shadow API did not come up"
    fi
    ;;

  live)
    need_node
    if [ "$CONFIRM" != "--yes" ]; then
      echo
      echo "This will:"
      echo "  - make the API the live service on :8787 (read-write, scheduler on)"
      echo "  - disable getfit.service (the Python dashboard)"
      echo "  - repoint the cloudflared rule for fit.afrasinei.dev to :8787"
      echo "  - create .use-api so deploys build and restart the API from now on"
      echo
      read -r -p "type 'cutover' to continue: " answer
      [ "$answer" = "cutover" ] || die "aborted"
    fi
    say "install, test, build"
    "$APP/scripts/ci.sh"
    install_units
    install_env
    set_env GETFIT_READ_ONLY=0
    set_env SCHEDULER=on
    sudo systemctl enable getfit-api.service
    sudo systemctl restart getfit-api.service
    wait_health || { sudo journalctl -u getfit-api -n 30 --no-pager; die "API did not come up"; }
    say "API healthy on :8787"

    say "stopping the Python dashboard"
    sudo systemctl disable --now getfit.service || true

    say "repointing the tunnel"
    tunnel_port 8787

    : > "$APP/.use-api"
    say "deploys now build and restart the API (marker .use-api)"
    say "still to do by hand: Cloudflare Access bypass for /api/* (so phones, not browsers, reach it)"
    say "rollback: ./scripts/cutover.sh rollback"
    ;;

  rollback)
    say "stopping the API"
    sudo systemctl disable --now getfit-api.service || true
    say "starting the Python dashboard"
    sudo systemctl enable --now getfit.service
    say "repointing the tunnel to 8777"
    tunnel_port 8777
    rm -f "$APP/.use-api"
    say "rolled back to Python"
    ;;

  *)
    echo "usage: $0 shadow|live|rollback [--yes]" >&2
    exit 2
    ;;
esac
