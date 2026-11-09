// Persistent run/points history for the WebUI points page.
//
// The in-memory run history in ProcessManager is capped (default 20 runs) and
// lost on restart, so every finished run is appended as one JSON line to
// config/points-history.jsonl (the config/ directory is volume-mounted in
// Docker, so history survives rebuilds). The file is rotated at ~5 MB to keep
// reads bounded.

import fs from 'node:fs'
import path from 'node:path'

const MAX_FILE_BYTES = 5 * 1024 * 1024

export function pointsHistoryFilePath(projectRoot) {
    return path.join(projectRoot, 'config', 'points-history.jsonl')
}

export function appendRunRecord(projectRoot, record) {
    const filePath = pointsHistoryFilePath(projectRoot)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    try {
        const stat = fs.statSync(filePath)
        if (stat.size > MAX_FILE_BYTES) {
            fs.renameSync(filePath, `${filePath}.1`)
        }
    } catch {
        // missing file is fine
    }
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8')
}

function readRecords(filePath) {
    let raw
    try {
        raw = fs.readFileSync(filePath, 'utf-8')
    } catch {
        return []
    }
    const records = []
    for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
            const parsed = JSON.parse(trimmed)
            if (parsed && typeof parsed === 'object') records.push(parsed)
        } catch {
            // skip corrupt lines
        }
    }
    return records
}

function toLocalDateStr(when) {
    if (!when) return 'unknown'
    const d = new Date(when)
    if (isNaN(d.getTime())) return String(when).slice(0, 10)
    const tz = process.env.TZ || 'Asia/Shanghai'
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
    } catch {
        return d.toISOString().slice(0, 10)
    }
}

// Returns {records (newest first), daily, perAccount, totals, path}
//   daily:      [{date, collected, runs, successes}]
//   perAccount: [{email, runs, totalCollected, successes, lastCollected, lastRunAt, lastBalance}]
export function readPointsHistory(projectRoot, { days = 30, limit = 200 } = {}) {
    const filePath = pointsHistoryFilePath(projectRoot)
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

    const records = readRecords(filePath)
        .filter(record => {
            const when = Date.parse(record.endedAt || record.startedAt || '')
            return Number.isFinite(when) ? when >= cutoff : true
        })
        .sort((a, b) => String(b.endedAt ?? b.startedAt ?? '').localeCompare(String(a.endedAt ?? a.startedAt ?? '')))
        .slice(0, limit)

    const daily = new Map()
    const perAccount = new Map()
    let totalCollected = 0
    let totalRuns = 0
    let totalSuccesses = 0

    for (const record of records) {
        const when = record.endedAt || record.startedAt
        const date = toLocalDateStr(when)
        const collected = Number(record.collected ?? 0) || 0
        const success = record.accounts?.some(account => account.success === true) ?? false

        totalRuns++
        totalCollected += collected
        if (success) totalSuccesses++

        const day = daily.get(date) ?? { date, collected: 0, runs: 0, successes: 0 }
        day.collected += collected
        day.runs++
        if (success) day.successes++
        daily.set(date, day)

        for (const account of record.accounts ?? []) {
            if (!account?.email) continue
            const entry =
                perAccount.get(account.email) ??
                { email: account.email, runs: 0, totalCollected: 0, successes: 0, lastCollected: null, lastRunAt: null, lastBalance: null }
            entry.runs++
            entry.totalCollected += Number(account.collected ?? 0) || 0
            if (account.success === true) entry.successes++
            if (!entry.lastRunAt) {
                entry.lastRunAt = when ?? null
                entry.lastCollected = Number(account.collected ?? 0) || 0
                entry.lastBalance = account.balance ?? null
            }
            perAccount.set(account.email, entry)
        }
    }

    return {
        path: filePath,
        days,
        totals: { runs: totalRuns, collected: totalCollected, successes: totalSuccesses },
        daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
        perAccount: [...perAccount.values()].sort((a, b) => b.totalCollected - a.totalCollected),
        records
    }
}
