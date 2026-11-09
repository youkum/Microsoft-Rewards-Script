import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { appendRunRecord, readPointsHistory } from './pointsHistory.js'

function makeRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-points-'))
}

function record(endedAt, collected, accounts) {
    return { startedAt: endedAt, endedAt, exit: { code: 0, signal: null, at: endedAt }, collected, accounts }
}

test('appendRunRecord appends JSONL and readPointsHistory aggregates', () => {
    const root = makeRoot()
    const now = Date.now()
    const iso = offset => new Date(now - offset * 24 * 60 * 60 * 1000).toISOString()

    appendRunRecord(root, record(iso(0), 100, [{ email: 'a@x.com', collected: 100, success: true, balance: 9000 }]))
    appendRunRecord(root, record(iso(1), 150, [{ email: 'a@x.com', collected: 70, success: true, balance: 8900 }, { email: 'b@x.com', collected: 80, success: false }]))
    appendRunRecord(root, record(iso(10), 30, [{ email: 'b@x.com', collected: 30, success: true }]))
    // corrupt line must be skipped gracefully
    fs.appendFileSync(path.join(root, 'config', 'points-history.jsonl'), '{corrupt\n', 'utf-8')

    const all = readPointsHistory(root, { days: 30, limit: 100 })
    assert.equal(all.records.length, 3)
    assert.equal(all.totals.runs, 3)
    assert.equal(all.totals.collected, 280)
    assert.equal(all.totals.successes, 3) // run counts as success if any account succeeded

    // newest first
    assert.equal(all.records[0].collected, 100)

    // daily buckets ascending by date
    assert.equal(all.daily.length, 3)
    assert.ok(all.daily[0].date <= all.daily[all.daily.length - 1].date)
    assert.deepEqual(
        all.daily.map(day => day.collected),
        [30, 150, 100]
    )

    // per-account totals
    const a = all.perAccount.find(entry => entry.email === 'a@x.com')
    assert.equal(a.runs, 2)
    assert.equal(a.totalCollected, 170)
    assert.equal(a.lastBalance, 9000)
    const b = all.perAccount.find(entry => entry.email === 'b@x.com')
    assert.equal(b.totalCollected, 110)

    // day filter excludes the 10-day-old record
    const recent = readPointsHistory(root, { days: 5, limit: 100 })
    assert.equal(recent.records.length, 2)
    assert.equal(recent.totals.collected, 250)
})

test('readPointsHistory on a missing file returns empty aggregates', () => {
    const root = makeRoot()
    const data = readPointsHistory(root, { days: 30 })
    assert.deepEqual(data.records, [])
    assert.deepEqual(data.daily, [])
    assert.deepEqual(data.totals, { runs: 0, collected: 0, successes: 0 })
})

test('appendRunRecord rotates oversized files', () => {
    const root = makeRoot()
    const filePath = path.join(root, 'config', 'points-history.jsonl')
    fs.mkdirSync(path.join(root, 'config'), { recursive: true })
    fs.writeFileSync(filePath, 'x'.repeat(5 * 1024 * 1024 + 1), 'utf-8')
    appendRunRecord(root, record(new Date().toISOString(), 1, []))
    assert.ok(fs.existsSync(`${filePath}.1`))
    const data = readPointsHistory(root, { days: 1 })
    assert.equal(data.records.length, 1)
})
