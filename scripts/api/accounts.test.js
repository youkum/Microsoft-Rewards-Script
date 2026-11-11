import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSingleAccountEnv, buildExcludedAccountsEnv } from './accounts.js'

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
