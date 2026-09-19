#!/bin/sh
set -eu
image=${TEST_IMAGE:-ddathome:test}
suffix="$$"
network="dd-test-$suffix"
mock="dd-mock-$suffix"
worker="dd-worker-$suffix"
volume="dd-identity-$suffix"
cleanup() {
  docker logs "$worker" 2>/dev/null || true
  docker rm -f "$worker" "$mock" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker build -t "$image" .
docker network create "$network" >/dev/null
docker volume create "$volume" >/dev/null
docker run -d --name "$mock" --network "$network" --network-alias mock \
  -v "$(pwd)/scripts/mock-cluster.js:/app/mock-cluster.js:ro" "$image" node /app/mock-cluster.js >/dev/null
start_worker() {
  docker run -d --name "$worker" --network "$network" --restart unless-stopped \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 192m --pids-limit 64 \
    -v "$volume:/data" -e URL=ws://mock:18080 -e ALLOWED_TASK_HOSTS=mock \
    -e INTERVAL=100 -e LIMIT=0 -e WATCHDOG_TIMEOUT_MS=5000 -e STATUS_INTERVAL_MS=1000 \
    -e RECONNECT_MIN_MS=100 -e NODE_OPTIONS=--max-old-space-size=96 "$image" >/dev/null
}
wait_ready() {
  count=0
  until docker exec "$worker" sh /app/healthcheck.sh; do
    count=$((count + 1))
    [ "$count" -lt 60 ] || { echo 'Worker readiness timed out'; exit 1; }
    sleep 1
  done
}
start_worker
wait_ready
docker exec "$worker" node -e 'fetch("http://127.0.0.1:9464/status").then(r=>r.json()).then(s=>{if(!s.identity.uuid||!s.identity.nickname||s.valid<1)process.exit(1);console.log(s.identity)})'
identity=$(docker exec "$worker" cat /data/identity.json)
docker exec "$mock" node -e 'fetch("http://127.0.0.1:18081/disconnect").then(r=>r.text())'
sleep 2
wait_ready
docker exec "$mock" node -e 'fetch("http://127.0.0.1:18081/").then(r=>r.json()).then(s=>{if(s.connections<2||s.valid<2)process.exit(1);console.log(s)})'

# Freeze only Node, leaving the independent BusyBox watchdog alive.
docker exec "$worker" sh -c 'kill -STOP $(pidof node)'
count=0
until [ "$(docker inspect -f '{{.RestartCount}}' "$worker")" -ge 1 ]; do
  count=$((count + 1))
  [ "$count" -lt 40 ] || { echo 'Watchdog failed to trigger restart'; exit 1; }
  sleep 1
done
wait_ready
[ "$identity" = "$(docker exec "$worker" cat /data/identity.json)" ]
docker stats --no-stream "$worker"
docker image inspect "$image" --format 'Image bytes: {{.Size}}'
docker stop -t 8 "$worker" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$worker")" = 0 ]
docker rm "$worker" >/dev/null
start_worker
wait_ready
[ "$identity" = "$(docker exec "$worker" cat /data/identity.json)" ]
echo 'Docker reconnect, watchdog restart, identity persistence and shutdown passed.'
