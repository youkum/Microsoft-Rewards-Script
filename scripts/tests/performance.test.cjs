const assert = require('node:assert/strict')
const { test, afterEach } = require('node:test')
const { Performance, PERFORMANCE_STAGES } = require('../../dist/util/Performance.js')

const originalFlag = process.env.MRS_PERFORMANCE
afterEach(() => {
    if (originalFlag === undefined) delete process.env.MRS_PERFORMANCE
    else process.env.MRS_PERFORMANCE = originalFlag
})

function parse(message) {
    const match = /^stage=([a-z.-]+) count=(\d+) durationMs=(\d+\.\d{3}) error=(true|false)$/.exec(message)
    assert.ok(match, `Unexpected performance record: ${message}`)
    return { stage: match[1], count: Number(match[2]), durationMs: Number(match[3]), error: match[4] === 'true' }
}

test('disabled flags execute operations directly without records or promise replacement', async () => {
    const records = []
    const observer = new Performance(message => records.push(message))
    for (const flag of [undefined, '', 'false', '1', 'TRUE']) {
        if (flag === undefined) delete process.env.MRS_PERFORMANCE
        else process.env.MRS_PERFORMANCE = flag
        const promise = Promise.resolve({ value: 42 })
        let called = 0
        assert.equal(
            observer.measure('navigation', () => {
                called++
                return promise
            }),
            promise
        )
        assert.equal(
            observer.measureSync('session.save', () => 42),
            42
        )
        observer.start('overall')(true)
        assert.equal(called, 1)
    }
    assert.deepEqual(records, [])
})

test('enabled asynchronous and synchronous operations retain results and emit metadata', async () => {
    process.env.MRS_PERFORMANCE = 'true'
    const records = []
    const observer = new Performance(message => records.push(parse(message)))
    const value = { result: 'private result' }
    assert.equal(await observer.measure('browser.launch', async () => value), value)
    assert.equal(
        observer.measureSync('session.save', () => value),
        value
    )
    assert.deepEqual(
        records.map(record => [record.stage, record.count, record.error]),
        [
            ['browser.launch', 1, false],
            ['session.save', 1, false]
        ]
    )
    assert.ok(records.every(record => Number.isFinite(record.durationMs) && record.durationMs >= 0))
})

test('failed operations keep the original rejection or throw and record failure once', async () => {
    process.env.MRS_PERFORMANCE = 'true'
    const records = []
    const observer = new Performance(message => records.push(parse(message)))
    const error = new Error('account@example.com https://secret.example/?query=private token=secret')
    await assert.rejects(
        observer.measure('login.mobile', async () => {
            throw error
        }),
        candidate => candidate === error
    )
    await assert.rejects(
        observer.measure('search.query', () => {
            throw error
        }),
        candidate => candidate === error
    )
    assert.throws(
        () =>
            observer.measureSync('session.save', () => {
                throw error
            }),
        candidate => candidate === error
    )
    assert.equal(records.length, 3)
    assert.ok(records.every(record => record.error && record.count === 1))
})

test('nested and concurrent spans complete independently with no active account state', async () => {
    process.env.MRS_PERFORMANCE = 'true'
    const records = []
    const observer = new Performance(message => records.push(parse(message)))
    let release
    const blocked = new Promise(resolve => {
        release = resolve
    })
    const slow = observer.measure('search.mobile', () => blocked)
    const fast = observer.measure('search.desktop', async () => observer.measure('progress.read', async () => 7))
    assert.equal(await fast, 7)
    assert.deepEqual(
        records.map(record => record.stage),
        ['progress.read', 'search.desktop']
    )
    release(9)
    assert.equal(await slow, 9)
    assert.deepEqual(
        records.map(record => record.stage),
        ['progress.read', 'search.desktop', 'search.mobile']
    )
})

test('explicit spans finish once even if completion paths race', () => {
    process.env.MRS_PERFORMANCE = 'true'
    const records = []
    const observer = new Performance(message => records.push(parse(message)))
    const finish = observer.start('overall')
    finish(true)
    finish(false)
    assert.equal(records.length, 1)
    assert.equal(records[0].error, true)
})

test('sink exceptions never alter successful results or original failures', async () => {
    process.env.MRS_PERFORMANCE = 'true'
    const observer = new Performance(() => {
        throw new Error('logger unavailable')
    })
    assert.equal(await observer.measure('navigation', async () => 12), 12)
    assert.equal(
        observer.measureSync('session.save', () => 13),
        13
    )
    const error = new Error('original')
    await assert.rejects(
        observer.measure('login.desktop', async () => {
            throw error
        }),
        candidate => candidate === error
    )
    assert.throws(
        () =>
            observer.measureSync('session.save', () => {
                throw error
            }),
        candidate => candidate === error
    )
})

test('records accept only static stages and never serialize operation data or errors', async () => {
    process.env.MRS_PERFORMANCE = 'true'
    const records = []
    const observer = new Performance(message => records.push(message))
    const secret = 'account@example.com https://secret.example/?query=private token=secret'
    assert.equal(await observer.measure(secret, async () => secret), secret)
    observer.start(secret)(true)
    observer.measureSync(secret, () => secret)
    assert.deepEqual(records, [])
    assert.equal(await observer.measure('http.request', async () => secret), secret)
    await assert.rejects(
        observer.measure('http.attempt', async () => {
            throw new Error(secret)
        })
    )
    assert.equal(records.length, 2)
    for (const message of records) {
        assert.ok(PERFORMANCE_STAGES.includes(parse(message).stage))
        assert.equal(message.includes(secret), false)
        assert.equal(/account@|https:|private|token=|stack=/.test(message), false)
    }
})

test('observers have independent sinks and missing sink stays disabled', async () => {
    process.env.MRS_PERFORMANCE = 'true'
    const first = []
    const second = []
    await Promise.all([
        new Performance(message => first.push(parse(message))).measure('search.mobile', async () => 1),
        new Performance(message => second.push(parse(message))).measure('search.desktop', async () => 2)
    ])
    assert.deepEqual(
        first.map(record => record.stage),
        ['search.mobile']
    )
    assert.deepEqual(
        second.map(record => record.stage),
        ['search.desktop']
    )
    const unobserved = new Performance()
    assert.equal(unobserved.enabled, false)
    const promise = Promise.resolve(3)
    assert.equal(
        unobserved.measure('http.request', () => promise),
        promise
    )
})
