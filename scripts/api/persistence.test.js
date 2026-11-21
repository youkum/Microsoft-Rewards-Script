import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { writeConfigAtomic, readConfig } from './configEditor.js'
import { migrateLegacyConfig } from './migrateConfig.js'
import { RunHistoryStore } from './runHistory.js'
import { appendRunRecord } from './pointsHistory.js'
import { writeJsonAtomic } from '../atomicFile.cjs'

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-persistence-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
    fs.mkdirSync(path.join(root, 'config'))
    return root
}

const config = { sessionPath: 'sessions', clusters: 1, workers: { doDesktopSearch: true } }

test('API and compiled config sync preserve the Docker symlink, backups and settings after relinking', t => {
    const root = fixture(t)
    const mounted = path.join(root, 'config', 'config.json')
    const link = path.join(root, 'config.json')
    writeJsonAtomic(mounted, config)
    fs.symlinkSync(mounted, link)
    const saved = { ...config, webhook: { serverchan: { enabled: true, token: 'synthetic-token' } } }
    assert.equal(writeConfigAtomic(root, saved), mounted)
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    assert.deepEqual(JSON.parse(fs.readFileSync(`${mounted}.bak`, 'utf8')), config)
    const require = createRequire(import.meta.url)
    const sync = require('../../dist/util/ConfigSync.js')
    const next = { ...saved, workers: { doDesktopSearch: false } }
    sync.writeConfigAtomic(link, next)
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    fs.unlinkSync(link)
    fs.symlinkSync(mounted, link) // Same relinking as a container restart.
    assert.deepEqual(readConfig(root).data, next)
    assert.deepEqual(JSON.parse(fs.readFileSync(`${mounted}.bak`, 'utf8')), saved)
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(mounted).mode & 0o777, 0o600)
        assert.equal(fs.statSync(`${mounted}.bak`).mode & 0o777, 0o600)
    }
})

test('atomic config writer supports standalone files and dangling relative symlinks', t => {
    const root = fixture(t)
    assert.equal(writeConfigAtomic(root, config), path.join(root, 'config.json'))
    fs.unlinkSync(path.join(root, 'config.json'))
    fs.symlinkSync('config/config.json', path.join(root, 'config.json'))
    writeConfigAtomic(root, config)
    assert.ok(fs.lstatSync(path.join(root, 'config.json')).isSymbolicLink())
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config', 'config.json'), 'utf8')), config)
})

test('entrypoint migration preserves the newest legacy settings and both previous versions', async t => {
    const root = fixture(t)
    const mounted = path.join(root, 'config', 'config.json')
    writeJsonAtomic(mounted, config)
    fs.utimesSync(mounted, new Date(0), new Date(0))
    const latest = { ...config, workers: { doDesktopSearch: false } }
    writeJsonAtomic(path.join(root, 'config.json'), latest)
    assert.equal((await migrateLegacyConfig(root)).recovered, true)
    assert.deepEqual(JSON.parse(fs.readFileSync(mounted, 'utf8')), latest)
    assert.deepEqual(JSON.parse(fs.readFileSync(`${mounted}.pre-persistence-fix.bak`, 'utf8')), config)
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(root, 'config', 'config.container-recovery.json'), 'utf8')),
        latest
    )
    writeJsonAtomic(mounted, config)
    fs.utimesSync(mounted, new Date('2099-01-01'), new Date('2099-01-01'))
    assert.equal((await migrateLegacyConfig(root)).recovered, false)
    assert.deepEqual(JSON.parse(fs.readFileSync(mounted, 'utf8')), config)
})

function record(day, collected = 10, extra = {}) {
    const when = new Date(Date.UTC(2020, 0, day)).toISOString()
    return {
        startedAt: when,
        endedAt: when,
        collected,
        accounts: [{ email: 'account@example.invalid', collected, success: true, balance: 1000 + collected }],
        ...extra
    }
}

test('legacy migration deduplicates rotated history and preserves lifetime totals past the record cap and restarts', t => {
    const root = fixture(t)
    const old = [record(1), record(2, 20), record(3, 30)]
    const file = path.join(root, 'config', 'points-history.jsonl')
    fs.writeFileSync(`${file}.1`, old.slice(0, 2).map(JSON.stringify).join('\n') + '\n{corrupt\n')
    fs.writeFileSync(file, old.slice(1).map(JSON.stringify).join('\n') + '\n')
    let store = new RunHistoryStore(root, { limit: 2 })
    const accounts = [{ email: 'account@example.invalid', emailKey: 'account@example.invalid', index: 1 }]
    assert.equal(store.recoveredRuns, 3)
    assert.equal(store.getHistory().length, 2)
    assert.equal(store.getAccounts(accounts)[0].totalCollected, 60)
    assert.equal(store.append(old[0]), false) // Older than the retained list.
    const task = record(4, 40)
    store.append(task)
    appendRunRecord(root, task)
    store.append(record(5, 999, { mode: 'login' }))
    fs.unlinkSync(`${file}.1`) // Simulate points-report rotation discarding old data.
    fs.writeFileSync(file, JSON.stringify(task) + '\n')
    store = new RunHistoryStore(root, { limit: 2 })
    assert.equal(store.recoveredRuns, 0)
    assert.deepEqual(
        store.getHistory().map(run => run.mode),
        ['login', 'tasks']
    )
    const stats = store.getAccounts(accounts)[0]
    assert.equal(stats.totalCollected, 100)
    assert.equal(stats.runs, 4)
    assert.equal(stats.successStreak, 4)
    assert.equal(stats.lastCollected, 40)
    assert.equal(stats.lastRunAt, task.endedAt)
})

test('backup recovery reconciles newer point records without resetting or double-counting stats', t => {
    const root = fixture(t)
    let store = new RunHistoryStore(root)
    const first = record(1)
    const second = record(2, 20)
    store.append(first)
    appendRunRecord(root, first)
    store.append(second)
    appendRunRecord(root, second)
    fs.writeFileSync(store.file, '{corrupt')
    const warnings = []
    store = new RunHistoryStore(root, { warn: message => warnings.push(message) })
    assert.equal(
        store.getAccounts([{ email: 'account@example.invalid', emailKey: 'account@example.invalid' }])[0]
            .totalCollected,
        30
    )
    assert.equal(store.getHistory().length, 2)
    assert.equal(warnings.length, 2)
    store = new RunHistoryStore(root)
    assert.equal(store.recoveredRuns, 0)
    assert.equal(store.getHistory().length, 2)
    fs.writeFileSync(store.file, '{corrupt')
    fs.writeFileSync(`${store.file}.bak`, '{corrupt')
    assert.throws(() => new RunHistoryStore(root))
    assert.equal(fs.readFileSync(store.file, 'utf8'), '{corrupt')
})
