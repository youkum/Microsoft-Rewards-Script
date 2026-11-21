import fs from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from '../atomicFile.cjs'
import { readAllPointsRecords } from './pointsHistory.js'
import { mergeAccountStats } from './accounts.js'

function normalizeRecord(record) {
    if (!record || !Array.isArray(record.accounts)) return null
    const started = Date.parse(record.startedAt)
    const ended = Date.parse(record.endedAt)
    if (!Number.isFinite(started) || !Number.isFinite(ended)) return null
    return {
        ...record,
        mode: record.mode === 'login' ? 'login' : 'tasks',
        startedAt: new Date(started).toISOString(),
        endedAt: new Date(ended).toISOString()
    }
}

function key(record) {
    return JSON.stringify([record.mode, record.startedAt, record.endedAt])
}

function emptyState() {
    return { version: 1, runs: [], accountStats: [], taskWatermark: null, watermarkKeys: [] }
}

function readState(file) {
    if (!fs.existsSync(file)) return null
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (
        state?.version !== 1 ||
        !Array.isArray(state.runs) ||
        state.runs.some(record => !normalizeRecord(record)) ||
        !Array.isArray(state.accountStats) ||
        state.accountStats.some(
            stat =>
                typeof stat.email !== 'string' ||
                !Number.isSafeInteger(stat.runs) ||
                stat.runs < 0 ||
                !Number.isFinite(stat.totalCollected) ||
                !Number.isSafeInteger(stat.successStreak)
        ) ||
        !Array.isArray(state.watermarkKeys) ||
        (state.taskWatermark !== null && !Number.isFinite(Date.parse(state.taskWatermark)))
    )
        throw new Error('Invalid persisted run history')
    return state
}

// Recent records stay bounded; account totals/streaks are independent of that
// limit and of points-history.jsonl rotation. Only the API process writes here.
export class RunHistoryStore {
    constructor(projectRoot, { limit = 20, warn = () => {} } = {}) {
        this.file = path.join(projectRoot, 'config', 'run-history.json')
        this.limit = limit
        let restoredBackup = false
        let primaryError
        try {
            this.state = readState(this.file)
        } catch (error) {
            primaryError = error
            warn(`Could not read run history; trying backup: ${error.message}`)
        }
        if (!this.state) {
            this.state = readState(`${this.file}.bak`)
            if (!this.state && primaryError) throw primaryError
            restoredBackup = Boolean(this.state)
            if (restoredBackup) warn('Recovered run history from backup')
        }
        this.state ??= emptyState()
        this.state.runs = this.state.runs.slice(0, limit)
        // Import all available old records, without days/API limits. The task
        // watermark deduplicates both initial migration and backup recovery.
        const legacy = readAllPointsRecords(projectRoot)
            .map(normalizeRecord)
            .filter(Boolean)
            .sort((a, b) => a.endedAt.localeCompare(b.endedAt) || a.startedAt.localeCompare(b.startedAt))
        this.recoveredRuns = 0
        for (const record of legacy) {
            if (this._apply(this.state, record)) this.recoveredRuns++
        }
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        // Don't overwrite a good backup with a corrupt primary during recovery.
        writeJsonAtomic(this.file, this.state, { backup: !restoredBackup })
    }

    _apply(state, record) {
        const id = key(record)
        if (state.runs.some(run => key(run) === id)) return false
        if (record.mode !== 'login') {
            if (state.taskWatermark && record.endedAt < state.taskWatermark) return false
            if (record.endedAt === state.taskWatermark && state.watermarkKeys.includes(id)) return false
            const stats = new Map(state.accountStats.map(stat => [stat.email, stat]))
            // Reuse the account result contract for last/error/activity fields.
            const accounts = record.accounts.filter(account => typeof account?.email === 'string' && account.email)
            const latest = mergeAccountStats(
                accounts.map(account => ({ emailKey: account.email })),
                [record]
            )
            accounts.forEach((account, index) => {
                const previous = stats.get(account.email)
                stats.set(account.email, {
                    email: account.email,
                    ...latest[index],
                    runs: (previous?.runs ?? 0) + 1,
                    totalCollected: (previous?.totalCollected ?? 0) + (Number(account.collected) || 0),
                    successStreak: account.success === true ? (previous?.successStreak ?? 0) + 1 : 0,
                    streakProtection: account.streakProtection ?? previous?.streakProtection ?? null,
                    edgeBrowsing: account.edgeBrowsing ?? previous?.edgeBrowsing ?? null
                })
            })
            state.accountStats = [...stats.values()]
            if (state.taskWatermark !== record.endedAt) state.watermarkKeys = []
            state.taskWatermark = record.endedAt
            state.watermarkKeys.push(id)
        }
        state.runs.unshift(record)
        state.runs.sort((a, b) => b.endedAt.localeCompare(a.endedAt) || b.startedAt.localeCompare(a.startedAt))
        state.runs = state.runs.slice(0, this.limit)
        return true
    }

    append(input) {
        const record = normalizeRecord(input)
        if (!record) throw new Error('Cannot persist an invalid run record')
        const next = structuredClone(this.state)
        if (!this._apply(next, record)) return false
        writeJsonAtomic(this.file, next)
        this.state = next
        return true
    }

    getHistory() {
        return this.state.runs
    }

    getAccounts(accounts) {
        const stats = new Map(this.state.accountStats.map(stat => [stat.email, stat]))
        return mergeAccountStats(accounts, []).map(account => {
            const { email, ...values } = stats.get(account.email) ?? {}
            void email
            return { ...account, ...values }
        })
    }
}
