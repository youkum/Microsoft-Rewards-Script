import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import { z } from 'zod'
import { buildRewardForecast, formatRewardForecast } from '../rewardForecast.cjs'
import { readForecastHistory } from '../forecastHistory.cjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const now = '2026-08-10T12:00:00.000Z'
const goal = { name: '100元礼品卡', faceValue: 100, targetPoints: 1000 }
const record = (when, email = 'a@example.test', collected = 100, balance = 400) => ({
    endedAt: when,
    accounts: [{ email, collected, balance }]
})
const forecast = options => buildRewardForecast({ now, timeZone: 'Asia/Shanghai', rewardGoal: goal, ...options })

test('sums multiple runs per natural day, counts intervening zero days, excludes today from average', () => {
    const result = forecast({
        records: [
            record('2026-08-06T01:00:00Z', undefined, 100, 100),
            record('2026-08-06T04:00:00Z', undefined, 200, 300),
            record('2026-08-08T04:00:00Z', undefined, 100, 400),
            record('2026-08-10T01:00:00Z', undefined, 900, 1300)
        ],
        currentStats: [{ email: 'a@example.test', finalPoints: 600, collectedPoints: 200 }]
    })
    assert.deepEqual(result.window, { startDate: '2026-08-03', endDate: '2026-08-09', maxDays: 7, minDays: 3 })
    assert.deepEqual(result.accounts[0], {
        email: 'a@example.test',
        balance: 600,
        currentRunEarned: 200,
        remainingPoints: 400,
        averageDailyPoints: 100,
        observationDays: 4,
        estimatedDays: 4,
        reason: null,
        daily: [
            { date: '2026-08-06', earned: 300 },
            { date: '2026-08-07', earned: 0 },
            { date: '2026-08-08', earned: 100 },
            { date: '2026-08-09', earned: 0 }
        ]
    })
    assert.match(formatRewardForecast(result), /本次\/最近运行获得: \+200/)
})

test('caps at seven complete days, includes zero days since the first known old record', () => {
    const result = forecast({
        records: [record('2026-07-01T00:00:00Z', undefined, 5000), record('2026-08-09T00:00:00Z', undefined, 70)]
    })
    const account = result.accounts[0]
    assert.equal(account.observationDays, 7)
    assert.equal(account.averageDailyPoints, 10)
    assert.equal(account.estimatedDays, 60)
    assert.equal(account.daily[0].date, '2026-08-03')
    assert.equal(account.daily.at(-1).date, '2026-08-09')
})

test('requires three observation days per account and rounds estimated days up', () => {
    const result = forecast({
        records: [record('2026-08-07T00:00:00Z', undefined, 299), record('2026-08-09T00:00:00Z', 'b@example.test', 100)]
    })
    assert.equal(result.accounts[0].observationDays, 3)
    assert.equal(result.accounts[0].estimatedDays, 7)
    assert.equal(result.accounts[1].reason, 'insufficient_history')
    assert.equal(result.accounts[1].observationDays, 1)
    assert.equal(result.accounts[1].estimatedDays, null)
    assert.match(formatRewardForecast(result), /样本不足：1\/3/)
})

test('all-zero complete days do not produce an estimate; reaching the target needs no history', () => {
    const zero = forecast({ records: [record('2026-08-07T00:00:00Z', undefined, 0)] }).accounts[0]
    assert.equal(zero.averageDailyPoints, 0)
    assert.equal(zero.reason, 'zero_average')
    assert.equal(zero.estimatedDays, null)
    const reached = forecast({ currentStats: [{ email: 'a@example.test', balance: 1500, collected: 100 }] })
    assert.equal(reached.accounts[0].remainingPoints, 0)
    assert.equal(reached.accounts[0].estimatedDays, 0)
    assert.equal(reached.accounts[0].reason, 'reached')
    assert.match(formatRewardForecast(reached), /0 天（已达标）/)
})

test('unknown target is never inferred from cash face value; missing balance remains unknown', () => {
    const result = forecast({
        rewardGoal: { faceValue: 100 },
        currentStats: [{ email: 'a@example.test', balance: 500, collected: 100 }]
    })
    assert.deepEqual(result.goal, { name: '100元礼品卡', faceValue: 100, targetPoints: null })
    assert.equal(result.accounts[0].reason, 'unknown_target')
    assert.equal(result.accounts[0].remainingPoints, null)
    assert.equal(result.accounts[0].estimatedDays, null)
    assert.match(formatRewardForecast(result), /未设置实际所需积分/)
    const unknown = forecast({ accounts: ['a@example.test'] }).accounts[0]
    assert.equal(unknown.balance, null)
    assert.equal(unknown.reason, 'unknown_balance')
    assert.equal(unknown.estimatedDays, null)
})

test('history is ordered by timestamps, not input order, and only selected accounts appear', () => {
    const result = forecast({
        accounts: [{ email: 'a@example.test' }, 'missing@example.test'],
        records: [
            record('2026-08-09T00:00:00Z', undefined, 20, 600),
            record('2026-08-07T00:00:00Z', undefined, 100, 400),
            record('2026-08-08T00:00:00Z', 'other@example.test')
        ]
    })
    assert.equal(result.accounts[0].balance, 600)
    assert.equal(result.accounts[0].currentRunEarned, 20)
    assert.deepEqual(
        result.accounts.map(account => account.email),
        ['a@example.test', 'missing@example.test']
    )
    assert.equal(forecast({ accounts: [], records: [record('2026-08-07T00:00:00Z')] }).accounts.length, 0)
})

test('ignores malformed/future records and nonfinite/string/negative numeric fields without polluting valid balances', () => {
    const result = forecast({
        records: [
            null,
            { accounts: {} },
            record('not-a-date'),
            record('2026-02-30T00:00:00Z'),
            record('2026-08-11T00:00:00Z', undefined, 999, 99999),
            record('2026-08-07T00:00:00Z', undefined, 90, 400),
            record('2026-08-08T00:00:00Z', undefined, Infinity, NaN),
            record('2026-08-08T00:00:00Z', undefined, '900', '999'),
            record('2026-08-08T00:00:00Z', undefined, -100, -10)
        ],
        currentStats: [{ email: 'a@example.test', balance: Infinity, collected: NaN }]
    })
    assert.equal(result.accounts.length, 1)
    assert.equal(result.accounts[0].averageDailyPoints, 30)
    assert.equal(result.accounts[0].balance, 400)
    assert.equal(result.accounts[0].currentRunEarned, 90)
    assert.equal(result.accounts[0].estimatedDays, 20)
    assert.throws(() => forecast({ now: 'bad' }), /Invalid forecast time/)
})

test('uses configured timezone natural boundaries and excludes the in-progress local day', () => {
    const records = [record('2026-08-09T15:59:59Z', undefined, 100), record('2026-08-09T16:00:00Z', undefined, 900)]
    const shanghai = forecast({ records })
    const utc = forecast({ records, timeZone: 'UTC' })
    assert.equal(shanghai.accounts[0].daily[0].earned, 100)
    assert.equal(utc.accounts[0].daily[0].earned, 1000)
    assert.equal(shanghai.accounts[0].balance, 400)
    assert.equal(shanghai.accounts[0].currentRunEarned, 900)
    assert.equal(forecast({ timeZone: 'invalid-zone' }).timeZone, 'Asia/Shanghai')
})

test('DST days count as calendar days, not 24-hour elapsed durations', () => {
    const result = forecast({
        now: '2026-03-10T12:00:00Z',
        timeZone: 'America/New_York',
        records: [record('2026-03-07T17:00:00Z', undefined, 300)]
    })
    assert.deepEqual(
        result.accounts[0].daily.map(day => day.date),
        ['2026-03-07', '2026-03-08', '2026-03-09']
    )
    assert.equal(result.accounts[0].averageDailyPoints, 100)
})

test('deduplicates stable run identities without collapsing different runs on the same day', () => {
    const first = { ...record('2026-08-07T04:00:00Z'), startedAt: '2026-08-07T03:00:00Z' }
    const second = { ...record('2026-08-07T06:00:00Z'), startedAt: '2026-08-07T05:00:00Z' }
    const third = { ...record('2026-08-07T08:00:00Z'), runId: 'unique-run' }
    const result = forecast({ records: [first, structuredClone(first), second, third, structuredClone(third)] })
    assert.equal(result.accounts[0].daily[0].earned, 300)
    assert.equal(result.accounts[0].averageDailyPoints, 100)
})

test('current stats alone never manufacture historical observation days', () => {
    const result = forecast({ currentStats: [{ email: 'a@example.test', balance: 500, collected: 100 }] })
    assert.equal(result.accounts[0].observationDays, 0)
    assert.equal(result.accounts[0].averageDailyPoints, null)
    assert.equal(result.accounts[0].reason, 'insufficient_history')
    assert.match(formatRewardForecast(forecast({ accounts: [] })), /暂无账户积分数据/)
})

test('history reader reads current and one rotation, skips corruption and never writes files', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reward-forecast-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    assert.deepEqual(readForecastHistory(dir), [])
    fs.mkdirSync(path.join(dir, 'config'))
    const file = path.join(dir, 'config', 'points-history.jsonl')
    const previous = record('2026-08-07T00:00:00Z')
    const current = record('2026-08-09T00:00:00Z')
    fs.writeFileSync(`${file}.1`, `${JSON.stringify(previous)}\n{bad\nnull\n[]\n`)
    fs.writeFileSync(file, `\n${JSON.stringify(current)}\n{truncated`)
    fs.writeFileSync(`${file}.2`, JSON.stringify(record('2026-08-05T00:00:00Z')))
    const original = fs.readFileSync(file, 'utf8')
    assert.deepEqual(readForecastHistory(dir), [previous, current])
    assert.equal(fs.readFileSync(file, 'utf8'), original)
    fs.rmSync(file)
    fs.mkdirSync(file)
    assert.deepEqual(readForecastHistory(dir), [previous])
})

test('history reader bounds oversized file tails and skips oversized or split records', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reward-forecast-bounded-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    fs.mkdirSync(path.join(dir, 'config'))
    const file = path.join(dir, 'config', 'points-history.jsonl')
    const old = record('2026-08-01T00:00:00Z')
    const latest = record('2026-08-09T00:00:00Z')
    fs.writeFileSync(file, `${JSON.stringify(old)}\n${'x'.repeat(7 * 1024 * 1024)}\n${JSON.stringify(latest)}\n`)
    assert.deepEqual(readForecastHistory(dir), [latest])
})

// Isolate transport without constructing browsers, loading account/config files,
// or invoking a real HTTP client. TypeScript is transpiled in memory only.
function pushPlusModule(httpRequest) {
    const source = fs.readFileSync(path.join(root, 'src/logging/PushPlus.ts'), 'utf8')
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText
    const exports = {}
    class Queue {
        add(fn) {
            return Promise.resolve().then(fn)
        }
    }
    vm.runInNewContext(compiled, {
        exports,
        require(name) {
            if (name === '../util/Http') return { httpRequest }
            if (name === 'p-queue') return Queue
            if (name === './Queue') return { flushQueue: async () => {} }
            throw new Error(`Unexpected dependency: ${name}`)
        }
    })
    return exports
}

test('PushPlus accepts only numeric body.code 200 and sends unchanged fields exactly once', async () => {
    const requests = []
    const { sendPushPlus } = pushPlusModule(async request => {
        requests.push(request)
        return { status: 200, data: { code: 200 } }
    })
    const config = { token: 'fake-test-token', title: 'title', template: 'txt', channel: 'wechat' }
    await sendPushPlus(config, 'safe test content')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].retries, 0)
    assert.deepEqual(JSON.parse(JSON.stringify(requests[0].data)), { ...config, content: 'safe test content' })
    await sendPushPlus({ token: '' }, 'not sent')
    assert.equal(requests.length, 1)
    for (const body of [{ code: 500 }, { code: '200' }, {}, null, '<html>error</html>']) {
        const module = pushPlusModule(async () => ({ status: 200, data: body }))
        await assert.rejects(module.sendPushPlus(config, 'content'), /rejected.*invalid response/)
    }
})

test('PushPlus propagates HTTP/network failures as safe errors, including rate limits', async () => {
    for (const status of [401, 429, 500, undefined]) {
        const module = pushPlusModule(async () => {
            throw Object.assign(new Error('secret-token in remote error'), {
                response: { status },
                config: { token: 'secret-token' }
            })
        })
        await assert.rejects(module.sendPushPlus({ token: 'fake-test-token' }, 'content'), error => {
            assert.match(error.message, /PushPlus request failed/)
            assert.equal(JSON.stringify(error).includes('secret-token'), false)
            assert.equal(String(error).includes('secret-token'), false)
            assert.equal(error.cause, undefined)
            return true
        })
    }
    const module = pushPlusModule(async () => ({ status: 500, data: { code: 200 } }))
    await assert.rejects(module.sendPushPlus({ token: 'fake-test-token' }, 'content'), /HTTP 500/)
})

test('reward goal validator adds defaults to old config and rejects invalid redemption goals', () => {
    const exports = {}
    const source = fs.readFileSync(path.join(root, 'src/util/Validator.ts'), 'utf8')
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText
    // Use real Zod but only stub unrelated validation dependencies.
    vm.runInNewContext(compiled, {
        exports,
        process,
        require(name) {
            if (name === 'zod') return { z }
            if (name === 'semver') return {}
            if (name === 'ms') return value => (/^\d+(?:sec|min)$/.test(value) ? 1000 : undefined)
            if (name === '../../package.json') return { engines: { node: '>=24' } }
            if (name === './Locale') return { normalizeCountry: x => x, normalizeLanguageTag: x => x }
            if (name === './Proxy') return { parseBrowserProxyUrl: x => new URL(x) }
            throw new Error(`Unexpected dependency: ${name}`)
        }
    })
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'))
    delete config.rewardGoal
    const old = exports.ConfigSchema.parse(config)
    assert.deepEqual(JSON.parse(JSON.stringify(old.rewardGoal)), {
        name: '100元礼品卡',
        faceValue: 100,
        targetPoints: null
    })
    for (const targetPoints of [0, -1, 1.5, Infinity, '1000', Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(
            exports.ConfigSchema.safeParse({ ...config, rewardGoal: { ...goal, targetPoints } }).success,
            false
        )
    }
    assert.equal(exports.ConfigSchema.safeParse({ ...config, rewardGoal: goal }).success, true)
    assert.equal(exports.ConfigSchema.safeParse({ ...config, rewardGoal: { ...goal, name: '' } }).success, false)
})
