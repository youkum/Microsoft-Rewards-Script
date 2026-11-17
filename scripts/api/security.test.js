import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseEnvContent, quoteEnvValue, envStrFrom } from '../env.js'
import { addAccount, updateAccount, getMergedAccountEnv, flattenAccountPayload } from './envStore.js'
import { redactSecrets, assertNoRedactionPlaceholders } from './lib.js'
import { appendRunRecord, readPointsHistory } from './pointsHistory.js'
import { ProcessManager } from './processManager.js'

function root(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-security-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
    return dir
}

test('shared data-only env parser roundtrips quotes, slashes, whitespace, newlines and shell literals', () => {
    for (const value of [
        'quote"slash\\',
        '  spaces  ',
        'line\nACCOUNT_2_EMAIL=not-a-key\r\n',
        '$(touch nope)`literal`#value',
        '',
        'C:\\path\\legacy',
        "single'quote"
    ]) {
        const pairs = parseEnvContent(`ACCOUNT_1_PASSWORD=${quoteEnvValue(value)}\n`)
        assert.deepEqual(pairs, [{ key: 'ACCOUNT_1_PASSWORD', value }])
        assert.equal(
            envStrFrom(Object.fromEntries(pairs.map(p => [p.key, p.value])), 'ACCOUNT_1_PASSWORD'),
            value || undefined
        )
    }
    assert.deepEqual(parseEnvContent('# legacy\nPLAIN=x\nSINGLE=\'literal\\path\'\nDOUBLE="C:\\path"\n'), [
        { key: 'PLAIN', value: 'x' },
        { key: 'SINGLE', value: 'literal\\path' },
        { key: 'DOUBLE', value: 'C:\\path' }
    ])
})

test('web slots replace inherited secrets; merged PATCH validation and blank preservation', t => {
    const dir = root(t)
    const original = {
        email: 'safe@example.invalid',
        password: '  quote"slash\\  ',
        recoveryEmail: 'recover@example.invalid',
        totpSecret: 'ABCDEFGHIJKLMNOP',
        proxyUrl: 'http://proxy.invalid',
        proxyUsername: 'user',
        proxyPassword: 'pass'
    }
    addAccount(dir, original, {})
    const inherited = {
        ACCOUNT_1_EMAIL: 'stale@example.invalid',
        ACCOUNT_1_PASSWORD: 'stale',
        ACCOUNT_1_PROXY_AXIOS: 'true'
    }
    assert.equal(getMergedAccountEnv(dir, inherited).ACCOUNT_1_PROXY_AXIOS, undefined)
    const file = path.join(dir, 'config', 'accounts.env')
    const before = fs.readFileSync(file, 'utf8')
    for (const patch of [
        { email: 'bad' },
        { password: 'x\nACCOUNT_9_EMAIL=evil@example.invalid' },
        { password: 'x\0bad' },
        { proxyPort: 70000 },
        { proxyUrl: 'ftp://proxy.invalid' },
        { proxyUrl: 'socks5://proxy.invalid' },
        { proxyUrl: 'http://user:pass@proxy.invalid' },
        { totpSecret: 'bad' },
        { langCode: 'bad_#' }
    ]) {
        assert.throws(
            () => updateAccount(dir, 1, patch, inherited),
            err => err.code === 'VALIDATION_FAILED'
        )
        assert.equal(fs.readFileSync(file, 'utf8'), before)
    }
    for (const clears of [null, 'password', ['unknown'], ['proxy', 'proxy.password'], ['password', 'password']]) {
        assert.throws(
            () => updateAccount(dir, 1, {}, inherited, clears),
            err => err.code === 'BAD_REQUEST'
        )
    }
    assert.throws(
        () => updateAccount(dir, 1, { password: 'set' }, inherited, ['password']),
        err => err.code === 'BAD_REQUEST'
    )
    for (const body of [{ password: {} }, { proxy: [] }, { proxy: { port: true } }, { proxy: { http: 'invalid' } }]) {
        assert.throws(
            () => flattenAccountPayload(body),
            err => err.code === 'BAD_REQUEST'
        )
    }
    updateAccount(
        dir,
        1,
        { password: '', totpSecret: '', recoveryEmail: '', proxyUrl: '', proxyUsername: '', proxyPassword: '' },
        inherited
    )
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    updateAccount(dir, 1, {}, inherited, ['password', 'totpSecret', 'recoveryEmail', 'proxy'])
    const merged = getMergedAccountEnv(dir, inherited)
    assert.equal(merged.ACCOUNT_1_PASSWORD, undefined)
    assert.equal(merged.ACCOUNT_1_RECOVERY_EMAIL, undefined)
    assert.equal(merged.ACCOUNT_1_PROXY_PASSWORD, undefined)
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), before)
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600)
        assert.equal(fs.statSync(`${file}.bak`).mode & 0o777, 0o600)
    }
    assert.equal(
        fs.readdirSync(path.dirname(file)).some(name => name.includes('.tmp-')),
        false
    )
})

test('config redaction covers credential providers and placeholders cannot be saved', () => {
    const config = {
        webhook: {
            pushplus: { token: 'push' },
            serverchan: { sendKey: 'send' },
            ntfy: { url: 'url', topic: 'topic' },
            telegram: { botToken: 'bot', chatId: 'chat' }
        },
        searchSettings: { chinaApi: { appkey: 'key' } },
        account: { password: 'pw', recoveryEmail: 'recover', proxy: { username: 'u', password: 'p' } },
        headless: true
    }
    const masked = redactSecrets(config)
    for (const value of [
        masked.webhook.pushplus.token,
        masked.webhook.serverchan.sendKey,
        masked.webhook.ntfy.topic,
        masked.searchSettings.chinaApi.appkey,
        masked.account.proxy.password
    ])
        assert.equal(value, '***REDACTED***')
    assert.equal(config.webhook.pushplus.token, 'push')
    assert.throws(
        () => assertNoRedactionPlaceholders(masked),
        err => err.code === 'BAD_REQUEST'
    )
    assertNoRedactionPlaceholders({ headless: false })
})

test('rotated history contributes to retention and aggregates', t => {
    const dir = root(t)
    const file = path.join(dir, 'config', 'points-history.jsonl')
    const record = (age, collected) => ({
        endedAt: new Date(Date.now() - age * 86400000).toISOString(),
        collected,
        accounts: []
    })
    appendRunRecord(dir, record(2, 11))
    fs.appendFileSync(file, '\n' + ' '.repeat(5 * 1024 * 1024))
    appendRunRecord(dir, record(1, 22))
    assert.equal(readPointsHistory(dir).totals.collected, 33)
    assert.equal(readPointsHistory(dir, { days: 30, limit: 1 }).totals.collected, 22)
    fs.appendFileSync(file, '\n' + ' '.repeat(5 * 1024 * 1024))
    appendRunRecord(dir, record(0, 33))
    assert.equal(readPointsHistory(dir).totals.collected, 55)
    assert.equal(readPointsHistory(dir, { days: 0.5 }).totals.collected, 33)
})

test('disabled saved schedule invokes crontab cleanup using an isolated boundary stub', t => {
    const dir = root(t)
    fs.mkdirSync(path.join(dir, 'scripts', 'api'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mrs-schedule-fixture', type: 'module' }))
    const source = path.dirname(fileURLToPath(import.meta.url))
    fs.copyFileSync(path.join(source, 'apply-schedule.js'), path.join(dir, 'scripts', 'api', 'apply-schedule.js'))
    fs.writeFileSync(
        path.join(dir, 'scripts', 'api', 'lib.js'),
        'export function getProjectRoot() { return process.cwd() }'
    )
    fs.writeFileSync(
        path.join(dir, 'scripts', 'api', 'scheduleStore.js'),
        "import fs from 'node:fs'; export function readSchedule() { return {enabled:false,cron:'0 9 * * *'} }; export function applyCrontab(value) { fs.writeFileSync('applied.json',JSON.stringify(value)) }"
    )
    const result = spawnSync(process.execPath, [path.join(dir, 'scripts', 'api', 'apply-schedule.js')], {
        cwd: dir,
        encoding: 'utf8',
        env: { SystemRoot: process.env.SystemRoot ?? '', PATH: path.dirname(process.execPath) }
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'applied.json'), 'utf8')), {
        enabled: false,
        cron: '0 9 * * *'
    })
})

test('process history finalizes after close and includes unterminated trailing output', { timeout: 10000 }, async t => {
    const dir = root(t)
    const pm = new ProcessManager({
        command: process.execPath,
        args: ['-e', "process.stdout.write('final stdout'); process.stderr.write('final stderr')"],
        cwd: dir
    })
    const finished = once(pm, 'exit')
    pm.start()
    const child = pm.child
    assert.equal(child.listenerCount('exit'), 0)
    assert.equal(child.listenerCount('close'), 1)
    await finished
    const logs = pm.getLogs().logs.map(entry => entry.raw)
    assert.ok(logs.includes('final stdout'))
    assert.ok(logs.includes('final stderr'))
    assert.equal(pm.history.length, 1)
    assert.equal(pm.state, 'idle')
    assert.equal(pm.lastExit.code, 0)
})
