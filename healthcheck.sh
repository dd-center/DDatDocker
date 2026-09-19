#!/bin/sh
case "${HEALTH_HOST:-0.0.0.0}" in
  0.0.0.0) host=127.0.0.1 ;;
  ::) host='[::1]' ;;
  *) host="$HEALTH_HOST" ;;
esac
exec wget -q -T 3 -O /dev/null "http://$host:${HEALTH_PORT:-9464}${1:-/healthz}" 2>/dev/null
