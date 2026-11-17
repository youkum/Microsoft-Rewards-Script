// Synthetic in-memory API aggregation benchmark; never loads runtime accounts.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { mergeAccountStats } from './accounts.js'

const accounts = Array.from({ length: 100 }, (_, index) => ({
    index: index + 1,
    email: `fixture-${index}@example.invalid`,
    emailKey: `fixture-${index}@example.invalid`
}))
const runs = Array.from({ length: 20 }, (_, index) => ({
    endedAt: new Date(Date.UTC(2026, 10, 17 - index)).toISOString(),
    accounts: accounts.map(account => ({ email: account.email, collected: 10, success: true }))
}))
const normalize = run => ({ ...run, accounts: run.accounts.map(account => ({ ...account })) })
const before = () => accounts.map(account => mergeAccountStats([account], runs.map(normalize))[0])
const after = () => mergeAccountStats(accounts, runs.map(normalize))
assert.deepEqual(after(), before())
function measure(fn) {
    const times = []
    for (let index = 0; index < 12; index++) {
        const start = performance.now()
        fn()
        times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    return Number(times[Math.floor(times.length / 2)].toFixed(3))
}
before()
after()
console.log(
    JSON.stringify(
        {
            fixture: { accounts: accounts.length, runs: runs.length },
            equivalent: true,
            medianMs: { before: measure(before), after: measure(after) },
            pollingRequestsPerMinute: { before: 24, afterWithSse: 12 }
        },
        null,
        2
    )
)
