#!/usr/bin/env bash
# Harmless fixtures: only rewritten copies in a temporary directory are executed.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
FIXTURE=$(mktemp -d)
pids=()
cleanup() {
    for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
    rm -rf "$FIXTURE"
}
trap cleanup EXIT
mkdir -p "$FIXTURE/bin" "$FIXTURE/app/config" "$FIXTURE/etc"
export FIXTURE
export PATH="$FIXTURE/bin:$PATH"
unset CRON_SCHEDULE SCHEDULE_FILE ACCOUNT_1_EMAIL || true
export RUN_ON_START=false API_MODE=true SKIP_RANDOM_SLEEP=true

cat > "$FIXTURE/bin/node" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FIXTURE/node-calls"
case "$1" in
  *server.js)
    printf '%s\n' "$BASHPID" > "$FIXTURE/api-pid"
    trap 'exit 0' TERM INT
    while :; do sleep 0.1; done ;;
  *ConfigSync.js) printf '{}\n' > "$FIXTURE/app/config/config.json" ;;
esac
STUB
cat > "$FIXTURE/bin/cron" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$BASHPID" > "$FIXTURE/cron-pid"
trap 'exit 0' TERM INT
while :; do sleep 0.1; done
STUB
cat > "$FIXTURE/bin/dpkg-reconfigure" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cp "$FIXTURE/bin/dpkg-reconfigure" "$FIXTURE/bin/ln"
cat > "$FIXTURE/bin/npm" <<'STUB'
#!/usr/bin/env bash
printf 'task\n' >> "$FIXTURE/task-calls"
[ "${FIXTURE_HOLD:-false}" = true ] || exit "${FIXTURE_TASK_STATUS:-0}"
trap 'exit 0' TERM INT
while [ ! -f "$FIXTURE/release-task" ]; do sleep 0.1; done
STUB
chmod +x "$FIXTURE/bin/"*
printf '{}\n' > "$FIXTURE/app/config.example.json"
# Deliberately executable shell text must remain inert during startup.
printf 'touch "%s/credential-executed"\n' "$FIXTURE" > "$FIXTURE/app/config/accounts.env"
entry=$(cat "$ROOT/scripts/docker/entrypoint.sh")
entry=${entry//\/usr\/src\/microsoft-rewards-script/$FIXTURE\/app}
entry=${entry//\/etc\//$FIXTURE\/etc\/}
printf '%s\n' "$entry" > "$FIXTURE/entrypoint.sh"
runner=$(cat "$ROOT/scripts/docker/run_daily.sh")
runner=${runner//\/usr\/src\/microsoft-rewards-script/$FIXTURE\/app}
runner=${runner//\/etc\/container_env/$FIXTURE\/no-container-env}
runner=${runner//\/tmp\/run_daily.lock/$FIXTURE\/run.lock}
printf '%s\n' "$runner" > "$FIXTURE/runner.sh"

await_file() {
    for ((i=0; i<100; i++)); do [ ! -s "$1" ] || return 0; sleep 0.05; done
    printf 'FAIL: timed out waiting for %s\n' "$1" >&2
    for log in "$FIXTURE/"*.log; do [ ! -f "$log" ] || cat "$log" >&2; done
    return 1
}

bash "$FIXTURE/entrypoint.sh" > "$FIXTURE/startup.log" 2>&1 &
entry_pid=$!
pids+=("$entry_pid")
await_file "$FIXTURE/api-pid"
await_file "$FIXTURE/cron-pid"
[ ! -e "$FIXTURE/credential-executed" ]
[ ! -e "$FIXTURE/task-calls" ]
kill -0 "$entry_pid"
# Cron death must bring the API/container down, even with no initial schedule.
kill -TERM "$(cat "$FIXTURE/cron-pid")"
status=0
wait "$entry_pid" || status=$?
[ "$status" -ne 0 ]
if kill -0 "$(cat "$FIXTURE/api-pid")" 2>/dev/null; then
    printf 'FAIL: API survived cron failure\n' >&2
    exit 1
fi
printf 'PASS: manual-first startup, inert account file, cron supervision\n'

rm -f "$FIXTURE/api-pid" "$FIXTURE/cron-pid"
bash "$FIXTURE/entrypoint.sh" > "$FIXTURE/stop.log" 2>&1 &
entry_pid=$!
pids+=("$entry_pid")
await_file "$FIXTURE/api-pid"
await_file "$FIXTURE/cron-pid"
kill -TERM "$entry_pid"
status=0
wait "$entry_pid" || status=$?
[ "$status" -eq 143 ]
for file in api-pid cron-pid; do
    if kill -0 "$(cat "$FIXTURE/$file")" 2>/dev/null; then exit 1; fi
done
printf 'PASS: termination stops both child services\n'

# Scheduler accepts only file presence here; all account parsing belongs to app.
API_MODE=false CRON_SCHEDULE='0 7 * * *' bash "$FIXTURE/entrypoint.sh" > "$FIXTURE/scheduler.log" 2>&1 &
entry_pid=$!
pids+=("$entry_pid")
sleep 0.3
kill -0 "$entry_pid"
kill -TERM "$entry_pid"
wait "$entry_pid" || true
[ ! -e "$FIXTURE/credential-executed" ]
printf 'PASS: scheduler account-file presence without evaluation\n'

# Native flock is absent in Git Bash. Validate error/contended branches there;
# Linux CI additionally runs actual concurrent owners against the kernel lock.
if command -v flock >/dev/null 2>&1; then
    export API_MODE=false
    for content in '' corrupt 99999999 "$$"; do
        printf '%s' "$content" > "$FIXTURE/run.lock"
        bash "$FIXTURE/runner.sh" > "$FIXTURE/run.log" 2>&1
    done
    [ "$(wc -l < "$FIXTURE/task-calls")" -eq 4 ]
    rm "$FIXTURE/task-calls"
    FIXTURE_HOLD=true bash "$FIXTURE/runner.sh" > "$FIXTURE/owner.log" 2>&1 &
    owner=$!
    pids+=("$owner")
    await_file "$FIXTURE/task-calls"
    contenders=()
    for ((i=0; i<8; i++)); do
        bash "$FIXTURE/runner.sh" > "$FIXTURE/contender-$i.log" 2>&1 &
        contenders+=("$!")
    done
    for pid in "${contenders[@]}"; do wait "$pid"; done
    [ "$(wc -l < "$FIXTURE/task-calls")" -eq 1 ]
    touch "$FIXTURE/release-task"
    wait "$owner"
    bash "$FIXTURE/runner.sh" > "$FIXTURE/next.log" 2>&1
    [ "$(wc -l < "$FIXTURE/task-calls")" -eq 2 ]
    printf 'PASS: stale/empty/corrupt/unrelated PID data, concurrent exclusion, reacquisition\n'
else
    cat > "$FIXTURE/bin/flock" <<'STUB'
#!/usr/bin/env bash
exit "${FIXTURE_FLOCK_STATUS:-0}"
STUB
    chmod +x "$FIXTURE/bin/flock"
    API_MODE=false FIXTURE_FLOCK_STATUS=75 bash "$FIXTURE/runner.sh" > "$FIXTURE/contended.log" 2>&1
    [ ! -e "$FIXTURE/task-calls" ]
    status=0
    API_MODE=false FIXTURE_FLOCK_STATUS=2 bash "$FIXTURE/runner.sh" > "$FIXTURE/lock-error.log" 2>&1 || status=$?
    [ "$status" -eq 2 ]
    printf 'PASS: lock contention and lock-error handling (stub)\n'
    printf 'SKIP: native kernel lock concurrency requires Linux flock; enforced in CI\n'
fi
status=0
API_MODE=false FIXTURE_TASK_STATUS=7 bash "$FIXTURE/runner.sh" > "$FIXTURE/failure.log" 2>&1 || status=$?
[ "$status" -eq 7 ]
printf 'PASS: task exit status propagated\n'
