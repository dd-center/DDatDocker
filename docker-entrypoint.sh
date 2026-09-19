#!/bin/sh
set -u

# BusyBox supervises one Node process; no second resident JS runtime.
node index.js --worker &
worker=$!
sleeper=''
stop() {
  trap - TERM INT
  kill -TERM "$worker" 2>/dev/null || true
  [ -z "$sleeper" ] || kill "$sleeper" 2>/dev/null || true
  (sleep 5; kill -KILL "$worker" 2>/dev/null) &
  killer=$!
  wait "$worker" 2>/dev/null || true
  kill "$killer" 2>/dev/null || true
  wait "$killer" 2>/dev/null || true
  exit 0
}
trap stop TERM INT

last_ok=$(date +%s)
# JS validates the same setting; shell arithmetic stays integer-only.
timeout_ms=${WATCHDOG_TIMEOUT_MS:-45000}
case "$timeout_ms" in ''|*[!0-9]*) timeout_ms=45000 ;; esac
timeout_seconds=$(( (timeout_ms + 999) / 1000 ))
while kill -0 "$worker" 2>/dev/null; do
  if sh /app/healthcheck.sh /livez; then
    last_ok=$(date +%s)
  elif [ $(( $(date +%s) - last_ok )) -ge "$timeout_seconds" ]; then
    echo '{"level":"error","event":"watchdog_timeout"}'
    kill -KILL "$worker" 2>/dev/null || true
    wait "$worker" 2>/dev/null || true
    exit 1
  fi
  sleep 5 &
  sleeper=$!
  wait "$sleeper" 2>/dev/null || true
done
wait "$worker"
exit $?
