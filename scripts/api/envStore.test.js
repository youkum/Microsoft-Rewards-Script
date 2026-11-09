import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
    addAccount,
    deleteAccount,
    findFreeSlot,
    getMergedAccountEnv,
    getSlotSources,
    updateAccount,
    validateAccountInput,
    flattenAccountPayload,
    fieldsFromEnv
} from './envStore.js'

function makeRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-envstore-'))
}

function writeEnv(root, content) {
    fs.writeFileSync(path.join(root, '.env'), content, 'utf-8')
}

test('loadAccountPairs merges .env and accounts.env with block-level precedence', () => {
    const root = makeRoot()
    writeEnv(
        root,
        [
            '# base comment',
            'OTHER_KEY=1',
            'ACCOUNT_1_EMAIL=a@x.com',
            'ACCOUNT_1_PASSWORD=secret-a',
            'ACCOUNT_1_PROXY_URL=http://1.1.1.1:8080',
            'ACCOUNT_3_EMAIL=c@x.com'
        ].join('\n')
    )
    fs.mkdirSync(path.join(root, 'config'), { recursive: true })
    fs.writeFileSync(
        path.join(root, 'config', 'accounts.env'),
        ['# Account 1', 'ACCOUNT_1_EMAIL=b@x.com', 'ACCOUNT_2_EMAIL=new@x.com'].join('\n'),
        'utf-8'
    )

    const env = getMergedAccountEnv(root, {})

    // slot 1 fully replaced by web file
    assert.equal(env.ACCOUNT_1_EMAIL, 'b@x.com')
    assert.equal(env.ACCOUNT_1_PASSWORD, undefined)
    assert.equal(env.ACCOUNT_1_PROXY_URL, undefined)
    // slot 3 untouched from .env
    assert.equal(env.ACCOUNT_3_EMAIL, 'c@x.com')
    // new web slot present
    assert.equal(env.ACCOUNT_2_EMAIL, 'new@x.com')
    // non-account keys not leaked into merged account env
    assert.equal(env.OTHER_KEY, undefined)

    const sources = getSlotSources(root)
    assert.equal(sources.get('1'), 'web')
    assert.equal(sources.get('3'), 'env')
    assert.equal(sources.get('2'), 'web')
})

test('addAccount picks the lowest free slot and writes atomically', () => {
    const root = makeRoot()
    writeEnv(root, 'ACCOUNT_1_EMAIL=one@x.com\n')
    const baseEnv = { ACCOUNT_1_EMAIL: 'one@x.com' }

    const slot = addAccount(
        root,
        validateAccountInput(flattenAccountPayload({ email: 'Two@X.com', password: 'pw two', proxy: { url: 'http://10.0.0.1:3128', http: true } })),
        baseEnv
    )
    assert.equal(slot, 2)

    const content = fs.readFileSync(path.join(root, 'config', 'accounts.env'), 'utf-8')
    assert.match(content, /ACCOUNT_2_EMAIL=two@x\.com/) // normalized to lowercase
    assert.match(content, /ACCOUNT_2_PASSWORD="pw two"/) // quoted due to space
    assert.match(content, /ACCOUNT_2_PROXY_URL=http:\/\/10\.0\.0\.1/) // host only; port separate
    assert.match(content, /ACCOUNT_2_PROXY_PORT=3128/)
    assert.match(content, /ACCOUNT_2_PROXY_HTTP=true/)

    // backup created on first write? no: backup only when file pre-existed
    assert.ok(!fs.existsSync(path.join(root, 'config', 'accounts.env.bak')))

    // re-adding same email conflicts
    assert.throws(
        () => addAccount(root, validateAccountInput({ email: 'two@x.com' }), baseEnv),
        err => err.code === 'EMAIL_CONFLICT'
    )

    // next add takes slot 3
    assert.equal(addAccount(root, validateAccountInput({ email: 'three@x.com' }), baseEnv), 3)
})

test('updateAccount preserves unspecified fields and clears emptied proxy', () => {
    const root = makeRoot()
    fs.mkdirSync(path.join(root, 'config'), { recursive: true })
    fs.writeFileSync(
        path.join(root, 'config', 'accounts.env'),
        'ACCOUNT_1_EMAIL=u@x.com\nACCOUNT_1_PASSWORD=keepme\nACCOUNT_1_LANG_CODE=zh-CN\nACCOUNT_1_PROXY_URL=socks5://9.9.9.9:1080\n',
        'utf-8'
    )
    const baseEnv = {}

    updateAccount(root, 1, { geoLocale: 'CN' }, baseEnv)
    const merged = getMergedAccountEnv(root, baseEnv)
    assert.equal(merged.ACCOUNT_1_EMAIL, 'u@x.com')
    assert.equal(merged.ACCOUNT_1_PASSWORD, 'keepme')
    assert.equal(merged.ACCOUNT_1_LANG_CODE, 'zh-CN')
    assert.equal(merged.ACCOUNT_1_GEO_LOCALE, 'CN')

    // editing .env-backed slot is refused
    writeEnv(root, 'ACCOUNT_5_EMAIL=env5@x.com\n')
    assert.throws(
        () => updateAccount(root, 5, { geoLocale: 'US' }, baseEnv),
        err => err.code === 'NOT_WEB_MANAGED'
    )

    // clearing the proxy drops the whole proxy block
    updateAccount(root, 1, { proxyUrl: '' }, baseEnv)
    const afterClear = getMergedAccountEnv(root, baseEnv)
    assert.equal(afterClear.ACCOUNT_1_PROXY_URL, undefined)
    assert.ok(fs.existsSync(path.join(root, 'config', 'accounts.env.bak')))
})

test('deleteAccount removes only the given web slot', () => {
    const root = makeRoot()
    fs.mkdirSync(path.join(root, 'config'), { recursive: true })
    fs.writeFileSync(
        path.join(root, 'config', 'accounts.env'),
        'ACCOUNT_1_EMAIL=a@x.com\nACCOUNT_2_EMAIL=b@x.com\nACCOUNT_2_PASSWORD=p\n',
        'utf-8'
    )
    writeEnv(root, 'ACCOUNT_9_EMAIL=env@x.com\n')

    const removed = deleteAccount(root, 2)
    assert.equal(removed, 2)
    const merged = getMergedAccountEnv(root, {})
    assert.equal(merged.ACCOUNT_1_EMAIL, 'a@x.com')
    assert.equal(merged.ACCOUNT_2_EMAIL, undefined)
    assert.equal(merged.ACCOUNT_9_EMAIL, 'env@x.com')

    assert.throws(() => deleteAccount(root, 9), err => err.code === 'NOT_WEB_MANAGED')
})

test('findFreeSlot skips used slots from both sources', () => {
    const root = makeRoot()
    writeEnv(root, 'ACCOUNT_1_EMAIL=a@x.com\nACCOUNT_3_EMAIL=c@x.com\n')
    fs.mkdirSync(path.join(root, 'config'), { recursive: true })
    fs.writeFileSync(path.join(root, 'config', 'accounts.env'), 'ACCOUNT_2_EMAIL=b@x.com\n')
    assert.equal(findFreeSlot(root, { ACCOUNT_1_EMAIL: 'a@x.com', ACCOUNT_3_EMAIL: 'c@x.com' }), 4)
})

test('validateAccountInput normalizes and rejects bad input', () => {
    const good = validateAccountInput(
        flattenAccountPayload({
            email: 'User@Example.COM',
            langCode: 'zh-cn',
            geoLocale: 'cn',
            proxy: { url: '10.0.0.1:8080', port: '8080', username: 'u', password: 'p' },
            saveFingerprint: { mobile: true, desktop: 'false' }
        })
    )
    assert.equal(good.email, 'user@example.com')
    assert.equal(good.langCode, new Intl.Locale('zh-cn').toString())
    assert.equal(good.geoLocale, 'CN')
    assert.equal(good.proxyUrl, 'http://10.0.0.1')
    assert.equal(good.proxyPort, 8080)
    assert.equal(good.proxyUsername, 'u')
    assert.equal(good.saveFingerprintDesktop, 'false')

    assert.throws(() => validateAccountInput({ email: 'not-an-email' }), err => err.code === 'VALIDATION_FAILED')
    assert.throws(
        () => validateAccountInput({ email: 'a@b.com', totpSecret: 'abc123' }),
        err => err.code === 'VALIDATION_FAILED'
    )
    assert.throws(
        () => validateAccountInput({ email: 'a@b.com', proxyUrl: 'ftp://1.2.3.4' }),
        err => err.code === 'VALIDATION_FAILED'
    )
    assert.throws(
        () => validateAccountInput({ email: 'a@b.com', proxyUrl: 'socks5://1.2.3.4', proxyUsername: 'u' }),
        err => err.code === 'VALIDATION_FAILED'
    )
})

test('fieldsFromEnv reads the flat field set for a slot', () => {
    const merged = {
        ACCOUNT_2_EMAIL: 'x@y.com',
        ACCOUNT_2_PASSWORD: 'pw',
        ACCOUNT_2_PROXY_URL: 'http://1.1.1.1',
        ACCOUNT_2_PROXY_PORT: '8080',
        ACCOUNT_3_EMAIL: ''
    }
    const fields = fieldsFromEnv(merged, 2)
    assert.deepEqual(fields, { email: 'x@y.com', password: 'pw', proxyUrl: 'http://1.1.1.1', proxyPort: '8080' })
    assert.deepEqual(fieldsFromEnv(merged, 3), {})
})
