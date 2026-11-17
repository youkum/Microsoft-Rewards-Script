import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSingleAccountEnv, buildExcludedAccountsEnv, mergeAccountStats } from './accounts.js'

test('buildSingleAccountEnv isolates selected account to slot 1 and sets ACCOUNTS_FILTERED', () => {
    const mockEnv = {
        ACCOUNT_1_EMAIL: 'acc1@test.com',
        ACCOUNT_1_PASSWORD: 'pw1',
        ACCOUNT_2_EMAIL: 'acc2@test.com',
        ACCOUNT_2_PASSWORD: 'pw2',
        ACCOUNT_3_EMAIL: 'acc3@test.com',
        ACCOUNT_3_PASSWORD: 'pw3'
    }

    const res = buildSingleAccountEnv(2, mockEnv)
    assert.equal(res.account.email, 'acc2@test.com')
    assert.equal(res.account.index, 2)
    assert.equal(res.env.ACCOUNTS_FILTERED, 'true')
    assert.equal(res.env.ACCOUNT_1_EMAIL, 'acc2@test.com')
    assert.equal(res.env.ACCOUNT_1_PASSWORD, 'pw2')
    assert.equal(res.env.ACCOUNT_2_EMAIL, '')
    assert.equal(res.env.ACCOUNT_3_EMAIL, '')
})

test('mergeAccountStats aggregates history once per account and omits the internal email key', () => {
    const accounts = [
        { index: 1, email: 'acc1@test.com', emailKey: 'acc1@test.com' },
        { index: 2, email: 'acc2@test.com', emailKey: 'acc2@test.com' }
    ]
    const runs = [
        {
            startedAt: '2026-11-16T10:00:00.000Z',
            accounts: [
                { email: 'acc1@test.com', collected: 20, success: true, streakProtection: true },
                { email: 'acc2@test.com', collected: 5, success: true }
            ]
        },
        {
            startedAt: '2026-11-15T10:00:00.000Z',
            accounts: [
                { email: 'acc1@test.com', collected: 10, success: false },
                { email: 'acc2@test.com', collected: 7, success: true, edgeBrowsing: 3 }
            ]
        }
    ]

    const [first, second] = mergeAccountStats(accounts, runs)
    assert.equal(first.runs, 2)
    assert.equal(first.totalCollected, 30)
    assert.equal(first.successStreak, 1)
    assert.equal(first.streakProtection, true)
    assert.equal(first.lastCollected, 20)
    assert.equal('emailKey' in first, false)
    assert.equal(second.runs, 2)
    assert.equal(second.totalCollected, 12)
    assert.equal(second.successStreak, 2)
    assert.equal(second.edgeBrowsing, 3)
})

test('buildExcludedAccountsEnv filters accounts and sets ACCOUNTS_FILTERED', () => {
    const mockEnv = {
        ACCOUNT_1_EMAIL: 'acc1@test.com',
        ACCOUNT_1_PASSWORD: 'pw1',
        ACCOUNT_2_EMAIL: 'acc2@test.com',
        ACCOUNT_2_PASSWORD: 'pw2',
        ACCOUNT_3_EMAIL: 'acc3@test.com',
        ACCOUNT_3_PASSWORD: 'pw3'
    }

    const res = buildExcludedAccountsEnv([2], mockEnv)
    assert.equal(res.env.ACCOUNTS_FILTERED, 'true')
    assert.equal(res.env.ACCOUNT_1_EMAIL, 'acc1@test.com')
    assert.equal(res.env.ACCOUNT_2_EMAIL, 'acc3@test.com')
    assert.equal(res.env.ACCOUNT_3_EMAIL, '')
    assert.deepEqual(res.excludedAccounts, [{ index: 2, email: 'acc2@test.com' }])
    assert.deepEqual(res.includedAccounts, [
        { index: 1, email: 'acc1@test.com' },
        { index: 3, email: 'acc3@test.com' }
    ])
})
