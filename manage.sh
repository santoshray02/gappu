#!/usr/bin/env bash
# Gappu host operations. Run with no arguments for the list.
#
#   ./manage.sh install        one-time host setup (Node, systemd unit, backup cron, data dir)
#   ./manage.sh deploy         pull, smoke-test, back up the DB, restart, health-check
#   ./manage.sh test           smoke test only (scratch server + mock Gemini, no network)
#   ./manage.sh status | logs | restart | backup
#   ./manage.sh admin <args>   gappu-admin (families, devices, usage) — see bin/gappu-admin.js
#
# Never edits .env: secrets are yours to manage.
set -euo pipefail
cd "$(dirname "$0")"
DIR=$(pwd)

NODE_VERSION=${NODE_VERSION:-v24.21.0}     # bump here to upgrade; install re-points the symlink
NODE_HOME=/opt/node-24
NODE=$NODE_HOME/bin/node
SERVICE=gappu
UNIT=/etc/systemd/system/$SERVICE.service
PUBLIC_URL=${PUBLIC_URL:-https://gappu.in1.xentovia.ai}
CRON_TAG="# gappu nightly backup"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
admin() { "$NODE" --disable-warning=ExperimentalWarning bin/gappu-admin.js "$@"; }

install_node() {
  if [ -x "$NODE" ] && [ "$("$NODE" --version)" = "$NODE_VERSION" ]; then
    say "Node $NODE_VERSION already at $NODE_HOME"; return
  fi
  say "Installing Node $NODE_VERSION to /opt/node-$NODE_VERSION (checksum-verified)"
  local f="node-$NODE_VERSION-linux-x64.tar.xz" tmp; tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$f" "https://nodejs.org/dist/$NODE_VERSION/$f"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " $f\$" | (cd "$tmp" && sha256sum -c -)
  sudo mkdir -p "/opt/node-$NODE_VERSION"
  sudo tar -xJf "$tmp/$f" -C "/opt/node-$NODE_VERSION" --strip-components=1
  sudo ln -sfn "/opt/node-$NODE_VERSION" "$NODE_HOME"
  rm -rf "$tmp"
  "$NODE" --version
}

check_env() {
  [ -f .env ] || die ".env missing. Create it (mode 600) with GEMINI_API_KEY, PORT, HOST, and optionally GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET."
  local missing=()
  for k in GEMINI_API_KEY PORT HOST; do grep -qE "^$k=.+" .env || missing+=("$k"); done
  [ ${#missing[@]} -eq 0 ] || die ".env lacks: ${missing[*]}"
  grep -qE '^GOOGLE_CLIENT_ID=.+' .env && grep -qE '^GOOGLE_CLIENT_SECRET=.+' .env \
    || echo "   note: GOOGLE_CLIENT_ID/SECRET not set, so Google sign-in is off (wizard falls back to tokens)"
  [ "$(stat -c %a .env)" = 600 ] || { chmod 600 .env; echo "   fixed .env permissions to 600"; }
}

install_unit() {
  say "Installing $UNIT"
  local rendered; rendered=$(sed -e "s#@USER@#$(id -un)#g" -e "s#@DIR@#$DIR#g" -e "s#@NODE@#$NODE#g" deploy/gappu.service)
  if [ -f "$UNIT" ] && diff -q <(echo "$rendered") "$UNIT" >/dev/null; then
    echo "   unchanged"
  else
    [ -f "$UNIT" ] && sudo cp "$UNIT" "$UNIT.bak.$(date +%Y%m%d%H%M%S)"
    echo "$rendered" | sudo tee "$UNIT" >/dev/null
    sudo systemctl daemon-reload
  fi
  sudo systemctl enable "$SERVICE" >/dev/null 2>&1
}

install_cron() {
  say "Nightly DB backup cron (21:15 UTC = 02:45 IST)"
  local line="15 21 * * * cd $DIR && $NODE --disable-warning=ExperimentalWarning bin/gappu-admin.js backup >> \$HOME/backups/gappu/.backup.log 2>&1 $CRON_TAG"
  mkdir -p "$HOME/backups/gappu" && chmod 700 "$HOME/backups/gappu"
  # Replace any earlier gappu backup line (tagged or from before this script existed).
  ( crontab -l 2>/dev/null | grep -v "$CRON_TAG" | grep -v 'gappu-admin.js backup' | grep -v '^# Gappu family DB backup'; echo "$line" ) | crontab -
  crontab -l | grep -F "$CRON_TAG"
}

health() {
  say "Health check"
  sleep 2
  systemctl is-active --quiet "$SERVICE" || { journalctl -u "$SERVICE" -n 30 --no-pager; die "$SERVICE is not running"; }
  local code; code=$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_URL/")
  [ "$code" = 200 ] || die "GET $PUBLIC_URL/ returned $code"
  echo "   GET / 200"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$PUBLIC_URL/api/chat" -H 'content-type: application/json' -d '{}')
  [ "$code" = 401 ] || die "unauthenticated /api/chat returned $code, expected 401"
  echo "   POST /api/chat without token 401"
  echo "   google sign-in: $(curl -s "$PUBLIC_URL/auth/google/status")"
  journalctl -u "$SERVICE" -n 1 --no-pager -q
}

case "${1:-}" in
  install)
    install_node
    check_env
    say "Data dir"; mkdir -p data && chmod 700 data && echo "   $DIR/data"
    install_unit
    install_cron
    say "Starting $SERVICE"; sudo systemctl restart "$SERVICE"
    health
    cat <<EOF

Reverse proxy is not managed here. Production uses the shared edx2_caddy container:
  ~/projects/edunodex/extra-sites/gappu.caddy  ->  reverse_proxy <HOST from .env>:<PORT from .env>
  docker exec edx2_caddy caddy validate --config /etc/caddy/Caddyfile && docker exec edx2_caddy caddy reload --config /etc/caddy/Caddyfile
Add families with:  ./manage.sh admin create --email parent@gmail.com --label "Family name"
EOF
    ;;
  deploy)
    [ -x "$NODE" ] || die "Node not installed at $NODE. Run ./manage.sh install first."
    if [ "${2:-}" != "--no-pull" ]; then
      say "git pull --ff-only"
      [ -z "$(git status --porcelain --untracked-files=no)" ] || die "uncommitted changes; commit them or use: ./manage.sh deploy --no-pull"
      git pull --ff-only
    fi
    check_env
    say "Smoke test"; NODE=$NODE tests/smoke.sh || die "smoke test failed; not deploying"
    say "Backing up the family DB"; admin backup
    install_unit
    say "Restarting $SERVICE"; sudo systemctl restart "$SERVICE"
    health
    say "Deployed $(git log --oneline -1)"
    ;;
  test)     NODE=$NODE tests/smoke.sh ;;
  status)   systemctl status "$SERVICE" --no-pager | head -12; echo; admin list ;;
  logs)     journalctl -u "$SERVICE" -f ;;
  restart)  sudo systemctl restart "$SERVICE"; health ;;
  backup)   admin backup ;;
  admin)    shift; admin "$@" ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 1 ;;
esac
