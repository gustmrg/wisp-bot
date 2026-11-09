#!/bin/sh
# Checks a server archive on a machine without Node.js or npm, as a clean
# container is: extracts it, runs its runtime check, installs it with setup
# (without the service), starts the server with fake agents, and calls its
# API, browser app, and command line. The release workflow runs it on each
# supported distribution; run it the same way by hand:
#
#   docker run --rm -v "$PWD/release:/release:ro" -v "$PWD/scripts:/scripts:ro" \
#     debian:bookworm-slim sh /scripts/smoke-server-archive.sh /release/wisp-server-<v>-linux-<arch>.tar.gz
set -eu

archive=$1
if command -v node >/dev/null 2>&1 || command -v npm >/dev/null 2>&1; then
  echo "Run this where Node.js and npm are not installed." >&2
  exit 1
fi

work=$(mktemp -d)
export HOME="$work/home"
mkdir -p "$HOME"
tar -xzf "$archive" -C "$work"
top=$(find "$work" -mindepth 1 -maxdepth 1 -type d -name 'wisp-server-*')

echo "== Runtime check"
"$top/bin/wispctl" version --check

echo "== Setup without the service"
"$top/bin/wispctl" setup --no-service --no-pair --port 18787 --web
installed="$HOME/.local/lib/wisp-server/current"
test -x "$installed/runtime/node"
"$HOME/.local/bin/wispctl" version --check --json

echo "== Server"
data="$HOME/.local/share/wisp"
mkdir -p "$data"
chmod 700 "$data"
WISP_DATA_DIR="$data" WISP_MASTER_KEY_FILE="$HOME/.config/wisp/master.key" WISP_PORT=18787 WISP_WEB=1 \
  WISP_AGENT_MODE=fake "$installed/runtime/node" "$installed/app/server/main.js" >"$work/server.log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT

# Requests go through the bundled Node.js: the container has no curl.
get() {
  "$installed/runtime/node" -e '
    fetch(process.argv[1]).then(async (response) => {
      const body = await response.text();
      if (!response.ok) throw new Error(`${process.argv[1]} answered ${response.status}`);
      process.stdout.write(body.slice(0, 200));
    }).catch((error) => { console.error(error.message); process.exit(1); });' "$1"
}

ready=""
for _ in $(seq 1 60); do
  if get http://127.0.0.1:18787/health >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  cat "$work/server.log" >&2
  echo "The server did not answer." >&2
  exit 1
fi
get http://127.0.0.1:18787/health
echo
get http://127.0.0.1:18787/ | grep -qi "<!doctype html" || {
  echo "The browser app is not served." >&2
  exit 1
}

echo "== Command line"
"$HOME/.local/bin/wispctl" status --json --data-dir "$data"
"$HOME/.local/bin/wispctl" pair --json --data-dir "$data" | grep -q '"code"'
echo "The server archive works without Node.js."
