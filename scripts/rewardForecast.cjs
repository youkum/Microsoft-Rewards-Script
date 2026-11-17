'use strict'

const DEFAULT_GOAL = Object.freeze({ name: '100元礼品卡', faceValue: 100, targetPoints: null })
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_DAYS = 7
const MIN_DAYS = 3

function points(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
        ? value
        : null
}

function normalizeGoal(value) {
    const goal = value && typeof value === 'object' ? value : {}
    return {
        name: typeof goal.name === 'string' && goal.name.trim() ? goal.name.trim() : DEFAULT_GOAL.name,
        faceValue: points(goal.faceValue) > 0 ? goal.faceValue : DEFAULT_GOAL.faceValue,
        // A cash face value never implies a points conversion rate.
        targetPoints: Number.isSafeInteger(goal.targetPoints) && goal.targetPoints > 0 ? goal.targetPoints : null
    }
}

function emailOf(value) {
    const email = typeof value === 'string' ? value : value?.email
    return typeof email === 'string' && email.trim() ? email.trim() : null
}

function timestamp(value) {
    if (typeof value !== 'string') return null
    // History uses ISO dates. Do not accept JS's permissive parsing of garbage,
    // numeric strings, or impossible calendar dates (e.g. February 30).
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))?$/.exec(value)
    if (!match) return null
    const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`)
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) return null
    const time = Date.parse(value)
    return Number.isFinite(time) ? time : null
}

function dayNumber(date) {
    return Math.floor(Date.parse(`${date}T00:00:00.000Z`) / DAY_MS)
}

function dateString(day) {
    return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

function dateFormatter(timeZone) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    })
}

function localDate(formatter, time) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(time)).map(part => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}`
}

/** Build a forecast without IO. Today is never part of the historical mean. */
function buildRewardForecast({
    records = [],
    accounts,
    currentStats = [],
    rewardGoal,
    now = Date.now(),
    timeZone = process.env.TZ || 'Asia/Shanghai'
} = {}) {
    const nowMs = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : now
    if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime()))
        throw new RangeError('Invalid forecast time')
    let formatter
    try {
        formatter = dateFormatter(timeZone)
    } catch {
        timeZone = 'Asia/Shanghai'
        formatter = dateFormatter(timeZone)
    }
    const today = dayNumber(localDate(formatter, nowMs))
    const yesterday = today - 1
    const windowStart = today - MAX_DAYS
    const goal = normalizeGoal(rewardGoal)
    const entries = new Map()
    const selected = Array.isArray(accounts) ? new Set(accounts.map(emailOf).filter(Boolean)) : null

    function entryFor(email) {
        if (!email || (selected && !selected.has(email))) return null
        if (!entries.has(email)) {
            entries.set(email, {
                email,
                balance: null,
                currentRunEarned: null,
                balanceAt: -Infinity,
                earnedAt: -Infinity,
                firstDay: Infinity,
                earnedByDay: new Map()
            })
        }
        return entries.get(email)
    }
    if (selected) for (const email of selected) entryFor(email)

    const seenRuns = new Set()
    for (const record of Array.isArray(records) ? records : []) {
        if (!record || typeof record !== 'object' || !Array.isArray(record.accounts)) continue
        const when = timestamp(record.endedAt || record.startedAt)
        if (when === null || when > nowMs) continue
        // Rotation/re-import can repeat a finished run. Only deduplicate stable
        // identity, never just the calendar date: separate daily runs must sum.
        const started = timestamp(record.startedAt)
        const ended = timestamp(record.endedAt)
        const runKey =
            typeof record.runId === 'string' && record.runId
                ? `id:${record.runId}`
                : started !== null && ended !== null
                  ? `time:${started}:${ended}`
                  : null
        if (runKey !== null) {
            if (seenRuns.has(runKey)) continue
            seenRuns.add(runKey)
        }
        const day = dayNumber(localDate(formatter, when))
        for (const account of record.accounts) {
            const balance = points(account?.balance)
            const earned = points(account?.collected)
            if (balance === null && earned === null) continue
            const entry = entryFor(emailOf(account))
            if (!entry) continue
            if (balance !== null && when >= entry.balanceAt) {
                entry.balance = balance
                entry.balanceAt = when
            }
            if (earned !== null && when >= entry.earnedAt) {
                entry.currentRunEarned = earned
                entry.earnedAt = when
            }
            if (earned === null || day >= today) continue
            entry.firstDay = Math.min(entry.firstDay, day)
            if (day >= windowStart) {
                const total = (entry.earnedByDay.get(day) ?? 0) + earned
                // Invalid arithmetic is not useful evidence for an estimate.
                if (points(total) !== null) entry.earnedByDay.set(day, total)
            }
        }
    }

    // Current run stats carry no historical weight, even if they include dates.
    for (const stat of Array.isArray(currentStats) ? currentStats : []) {
        const entry = entryFor(emailOf(stat))
        if (!entry) continue
        const balance = points(stat?.finalPoints ?? stat?.balance)
        const earned = points(stat?.collectedPoints ?? stat?.collected)
        if (balance !== null) entry.balance = balance
        if (earned !== null) entry.currentRunEarned = earned
    }

    const result = []
    for (const entry of entries.values()) {
        const start = Math.max(windowStart, entry.firstDay)
        const daily = []
        for (let day = start; day <= yesterday; day++) {
            daily.push({ date: dateString(day), earned: entry.earnedByDay.get(day) ?? 0 })
        }
        const observationDays = daily.length
        const total = daily.reduce((sum, day) => sum + day.earned, 0)
        const averageDailyPoints = observationDays && Number.isFinite(total) ? total / observationDays : null
        const remainingPoints =
            goal.targetPoints !== null && entry.balance !== null ? Math.max(0, goal.targetPoints - entry.balance) : null
        let reason = null
        let estimatedDays = null
        if (goal.targetPoints === null) reason = 'unknown_target'
        else if (entry.balance === null) reason = 'unknown_balance'
        else if (remainingPoints === 0) {
            reason = 'reached'
            estimatedDays = 0
        } else if (observationDays < MIN_DAYS) reason = 'insufficient_history'
        else if (averageDailyPoints === null || averageDailyPoints <= 0) reason = 'zero_average'
        else estimatedDays = Math.ceil(remainingPoints / averageDailyPoints)
        result.push({
            email: entry.email,
            balance: entry.balance,
            currentRunEarned: entry.currentRunEarned,
            remainingPoints,
            averageDailyPoints,
            observationDays,
            estimatedDays,
            reason,
            daily
        })
    }

    return {
        generatedAt: new Date(nowMs).toISOString(),
        timeZone,
        goal,
        window: {
            startDate: dateString(windowStart),
            endDate: dateString(yesterday),
            maxDays: MAX_DAYS,
            minDays: MIN_DAYS
        },
        accounts: result
    }
}

/** Text shared by the end-of-run PushPlus summary and authenticated preview. */
function formatRewardForecast(forecast) {
    const { goal, window, accounts, timeZone } = forecast
    const target = goal.targetPoints === null ? '未设置实际所需积分' : `${goal.targetPoints} 积分`
    const lines = [
        `兑换进度 | ${goal.name}（面值 ${goal.faceValue} 元）`,
        `兑换目标: ${target}`,
        `日均窗口: ${window.startDate} 至 ${window.endDate}（${timeZone}，不含今天；最多 ${window.maxDays} 天，至少 ${window.minDays} 个完整观察日，缺失日计 0）`
    ]
    if (!accounts.length) lines.push('暂无账户积分数据')
    for (const account of accounts) {
        const balance = account.balance === null ? '未知' : `${account.balance}`
        const earned = account.currentRunEarned === null ? '未知' : `+${account.currentRunEarned}`
        const remaining = account.remainingPoints === null ? '未知' : `${account.remainingPoints}`
        const average = account.averageDailyPoints === null ? '未知' : account.averageDailyPoints.toFixed(1)
        let estimate
        switch (account.reason) {
            case 'unknown_target':
                estimate = '未知（请填写实际所需积分；不按面值推算）'
                break
            case 'unknown_balance':
                estimate = '未知（缺少有效余额）'
                break
            case 'insufficient_history':
                estimate = `未知（样本不足：${account.observationDays}/${window.minDays} 个完整观察日）`
                break
            case 'zero_average':
                estimate = '未知（日均积分为 0）'
                break
            case 'reached':
                estimate = '0 天（已达标）'
                break
            default:
                estimate = `约 ${account.estimatedDays} 天`
        }
        lines.push(
            `${account.email} | 当前余额: ${balance} | 本次/最近运行获得: ${earned} | 还需: ${remaining}`,
            `近 ${account.observationDays} 个完整观察日日均: ${average} 积分 | 预计还需: ${estimate}`
        )
    }
    lines.push('仅按历史日均估算，各账户独立计算；实际积分、兑换门槛和库存可能变化。')
    return lines.join('\n')
}

module.exports = { buildRewardForecast, formatRewardForecast }
