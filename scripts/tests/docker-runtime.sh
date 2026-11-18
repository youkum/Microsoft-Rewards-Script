#!/usr/bin/env bash
# Exercise the actual image entrypoint/API/cron using loopback only and no accounts.
set -euo pipefail
IMAGE=${1:?Pass the locally built image name}
NAME="mrs-lifecycle-${RANDOM}-$$"
cleanup() {
    docker logs "$NAME" 2>/dev/null || true
    docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker run --detach --name "$NAME" --network none \
    --env API_MODE=true --env RUN_ON_START=false --env CRON_SCHEDULE= \
    --env API_TOKEN=fixture-only-token --env API_ALLOW_SCHEDULE_WRITE=true "$IMAGE"
ready=false
for ((i=0; i<45; i++)); do
    if docker exec "$NAME" scripts/docker/healthcheck.sh; then ready=true; break; fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$NAME")" != true ]; then
        docker inspect --format 'Startup failed: exit={{.State.ExitCode}} error={{.State.Error}}' "$NAME" >&2
        exit 1
    fi
    sleep 1
done
[ "$ready" = true ]
docker exec "$NAME" sh -c 'command -v pgrep && command -v flock && command -v timeout; test ! -e /tmp/run_daily.lock; pgrep -x cron'
# Enabling scheduling after manual-first startup must install a job into live cron.
docker exec --interactive --env API_ALLOW_SCHEDULE_WRITE=true "$NAME" node --input-type=module <<'NODE'
import http from 'node:http'
const body = JSON.stringify({ enabled: true, cron: '0 0 31 2 *' })
const req = http.request({ host: '127.0.0.1', port: 3010, path: '/schedule', method: 'PUT', headers: {
    Authorization: 'Bearer fixture-only-token', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
}}, res => {
    res.resume()
    res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 1))
})
req.on('error', () => process.exit(1))
req.end(body)
NODE
docker exec "$NAME" sh -c 'crontab -l | grep -F "0 0 31 2 *"; pgrep -x cron; test ! -e /tmp/run_daily.lock'
# No task is started. Loss of cron must fail health and terminate the API service.
docker exec "$NAME" pkill -TERM -x cron
for ((i=0; i<30; i++)); do
    [ "$(docker inspect --format '{{.State.Running}}' "$NAME")" = true ] || break
    sleep 0.2
done
test "$(docker inspect --format '{{.State.Running}}' "$NAME")" = false
test "$(docker inspect --format '{{.State.ExitCode}}' "$NAME")" != 0
printf 'PASS: actual runtime manual-first startup, live scheduling, health and cron lifecycle\n'
