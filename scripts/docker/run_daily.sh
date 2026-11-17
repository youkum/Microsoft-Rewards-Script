#!/usr/bin/env bash
set -euo pipefail

_SKIP_SLEEP_OVERRIDE="${SKIP_RANDOM_SLEEP:-}"

# Restore container environment (ACCOUNT_*, CONFIG_*, etc.) lost when cron spawns this job
if [ -f /etc/container_env ]; then
    # shellcheck source=/dev/null
    . /etc/container_env
fi

# Re-apply the caller's override so sourcing /etc/container_env can't reset it.
[ -n "$_SKIP_SLEEP_OVERRIDE" ] && SKIP_RANDOM_SLEEP="$_SKIP_SLEEP_OVERRIDE"
unset _SKIP_SLEEP_OVERRIDE

export PLAYWRIGHT_BROWSERS_PATH=0
export TZ="${TZ:-UTC}"

cd /usr/src/microsoft-rewards-script

# Keep a stable inode: unlinking an active flock file permits a second owner.
# PID text is diagnostic only; kernel ownership is released on process death.
LOCKFILE=/tmp/run_daily.lock

is_positive_integer() {
    [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_nonnegative_integer() {
    [[ "$1" =~ ^[0-9]+$ ]]
}

TIMEOUT_HOURS=${STUCK_PROCESS_TIMEOUT_HOURS:-8}
if ! is_positive_integer "$TIMEOUT_HOURS" || [ "${#TIMEOUT_HOURS}" -gt 4 ] || [ "$TIMEOUT_HOURS" -gt 8760 ]; then
    echo "[run_daily.sh] ERROR: STUCK_PROCESS_TIMEOUT_HOURS must be an integer from 1 to 8760." >&2
    exit 1
fi

exec 9>>"$LOCKFILE"
if flock -n -E 75 9; then
    printf '%s\n' "$$" > "$LOCKFILE"
else
    lock_status=$?
    if [ "$lock_status" -eq 75 ]; then
        existing_pid=$(cat "$LOCKFILE" 2>/dev/null || true)
        echo "[run_daily.sh] Another run owns the lock (PID: ${existing_pid:-initializing}); skipping."
        exit 0
    fi
    echo "[run_daily.sh] ERROR: Unable to acquire the run lock." >&2
    exit "$lock_status"
fi

child_pid=''
cleanup() {
    trap - EXIT INT TERM
    if [ -n "$child_pid" ]; then
        kill -TERM "$child_pid" 2>/dev/null || true
        wait "$child_pid" 2>/dev/null || true
    fi
    # Do not unlink or explicitly unlock: descendants retain the same lock until
    # the task is gone, even if this wrapper is killed before it can clean up.
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Random sleep between MIN and MAX to spread execution
MINWAIT=${MIN_SLEEP_MINUTES:-5}
MAXWAIT=${MAX_SLEEP_MINUTES:-50}

if ! is_nonnegative_integer "$MINWAIT" || ! is_nonnegative_integer "$MAXWAIT"; then
    echo "[$(date)] [run_daily.sh] ERROR: MIN_SLEEP_MINUTES and MAX_SLEEP_MINUTES must be non-negative integers." >&2
    exit 1
fi
if [ "$MAXWAIT" -lt "$MINWAIT" ]; then
    echo "[$(date)] [run_daily.sh] ERROR: MAX_SLEEP_MINUTES must be greater than or equal to MIN_SLEEP_MINUTES." >&2
    exit 1
fi

MINWAIT_SEC=$((MINWAIT*60))
MAXWAIT_SEC=$((MAXWAIT*60))

if [ "${SKIP_RANDOM_SLEEP:-false}" != "true" ]; then
    if [ "$MAXWAIT_SEC" -eq "$MINWAIT_SEC" ]; then
        SLEEPTIME=$MINWAIT_SEC
    else
        SLEEPTIME=$((MINWAIT_SEC + RANDOM % (MAXWAIT_SEC - MINWAIT_SEC + 1)))
    fi
    echo "[$(date)] [run_daily.sh] Sleeping for $((SLEEPTIME/60)) minutes ($SLEEPTIME seconds)"
    # Run sleep as a child so termination interrupts the wrapper promptly.
    sleep "$SLEEPTIME" &
    child_pid=$!
    wait "$child_pid"
    child_pid=''
else
    echo "[$(date)] [run_daily.sh] Skipping random sleep"
fi

# GNU timeout bounds the actual task's process group. Never kill a PID read
# from a stale file: that PID may have been reused by an unrelated process.
echo "[$(date)] [run_daily.sh] Starting script..."
if [ "${API_MODE:-false}" = "true" ]; then
    timeout --signal=TERM --kill-after=30s "${TIMEOUT_HOURS}h" node scripts/api/trigger.js &
else
    timeout --signal=TERM --kill-after=30s "${TIMEOUT_HOURS}h" npm start &
fi
child_pid=$!
run_status=0
wait "$child_pid" || run_status=$?
child_pid=''
echo "[$(date)] [run_daily.sh] Script finished (status: $run_status)"
exit "$run_status"
