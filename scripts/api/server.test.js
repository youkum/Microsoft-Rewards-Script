import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const apiDir = path.dirname(fileURLToPath(import.meta.url))
const TOKEN = 'contract-test-api-token'
const USERNAME = 'contract-admin'
const PASSWORD = 'contract-test-dashboard-password'
const tokenHeaders = { Authorization: `Bearer ${TOKEN}` }
const testOptions = { timeout: 30_000 }

// Allow only OS essentials through. In particular, never inherit ACCOUNT_*, API_*,
// NODE_OPTIONS, NODE_PATH, proxy settings, npm hooks, or dashboard credentials.
function isolatedEnv(root) {
    const env = {}
    const allowed = new Set(['systemroot', 'windir', 'comspec', 'pathext', 'lang', 'lc_all', 'tz'])
    for (const [key, value] of Object.entries(process.env)) {
        if (allowed.has(key.toLowerCase())) env[key] = value
    }
    return {
        ...env,
        HOME: root,
        USERPROFILE: root,
        TMP: root,
        TEMP: root,
        TMPDIR: root,
        PATH: path.dirname(process.execPath),
        NO_COLOR: '1',
        API_HOST: '127.0.0.1',
        API_TOKEN: TOKEN,
        DASHBOARD_USERNAME: USERNAME,
        DASHBOARD_PASSWORD: PASSWORD,
        DASHBOARD_SESSION_SECRET: 'contract-test-only-session-secret',
        API_ALLOW_ACCOUNT_WRITE: 'true',
        API_ALLOW_CONFIG_WRITE: 'false',
        API_ALLOW_CONFIG_REVEAL: 'false',
        API_ALLOW_SCHEDULE_WRITE: 'false',
        API_ALLOW_ENV_OVERRIDES: 'false',
        API_STOP_TIMEOUT_MS: '500',
        API_DIAGNOSTICS_DIR: path.join(root, 'diagnostics'),
        // Even an unintended successful /start can only run this finite mock.
        API_RUN_COMMAND: process.execPath,
        API_RUN_ARGS: JSON.stringify([path.join(root, 'mock-run.cjs')])
    }
}

async function freeLoopbackPort() {
    const reservation = net.createServer()
    try {
        await new Promise((resolve, reject) => {
            reservation.once('error', reject)
            reservation.listen(0, '127.0.0.1', resolve)
        })
        return reservation.address().port
    } finally {
        if (reservation.listening) await new Promise(resolve => reservation.close(resolve))
    }
}

async function fixture(t, { env = {}, accounts = {}, webAccounts = '' } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mrs-http-contract-'))
    const requests = new Set()
    let child
    let closed
    let ready = false
    let output = ''
    let spawnError
    let port

    // Register before setup/spawn so partial setup and failed assertions clean up too.
    t.after(async () => {
        for (const req of requests) req.destroy()
        try {
            if (child && child.exitCode === null && child.signalCode === null && !spawnError) {
                if (ready) {
                    await request('/shutdown', {
                        method: 'POST',
                        headers: tokenHeaders,
                        body: { force: true }
                    }).catch(() => {})
                }
                if (!(await waitForClose(3000))) {
                    child.kill('SIGKILL') // Supported for direct children on Windows and POSIX.
                    assert.ok(await waitForClose(3000), `API child did not exit:\n${output}`)
                }
            }
        } finally {
            for (const req of requests) req.destroy()
            child?.stdout?.destroy()
            child?.stderr?.destroy()
            await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        }
    })

    async function waitForClose(ms) {
        let timer
        try {
            return await Promise.race([
                closed.then(() => true),
                new Promise(resolve => {
                    timer = setTimeout(() => resolve(false), ms)
                })
            ])
        } finally {
            clearTimeout(timer)
        }
    }

    const copiedApi = path.join(root, 'scripts', 'api')
    // Never copy the project root: it may contain real .env, config, sessions,
    // dependencies, build output, or bot entry points. Do not follow symlinks.
    await fs.cp(apiDir, copiedApi, {
        recursive: true,
        filter: async source => {
            const stat = await fs.lstat(source)
            if (stat.isSymbolicLink()) return false
            if (stat.isDirectory()) return source === apiDir || source === path.join(apiDir, 'web')
            return /\.(?:js|html|css|svg)$/.test(source) && !source.endsWith('.test.js')
        }
    })
    // Proxy connectivity is outside this contract. Stub only this boundary in
    // the disposable copy: no third-party agents or external network can run.
    await fs.writeFile(
        path.join(copiedApi, 'proxyTester.js'),
        "export function testProxy() { throw new Error('Unexpected proxy/network task in HTTP contract test') }\n"
    )
    await fs.copyFile(path.join(apiDir, '..', 'env.js'), path.join(root, 'scripts', 'env.js'))
    await fs.copyFile(path.join(apiDir, '..', 'credentialEnv.cjs'), path.join(root, 'scripts', 'credentialEnv.cjs'))
    for (const file of ['rewardForecast.cjs', 'forecastHistory.cjs']) {
        await fs.copyFile(path.join(apiDir, '..', file), path.join(root, 'scripts', file))
    }
    await fs.mkdir(path.join(root, 'config'))
    await fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
            name: 'mrs-http-contract-fixture',
            version: '0.0.1',
            type: 'module'
        })
    )
    const config = { sessionPath: 'sessions', clusters: 1, headless: true, workers: { mobile: true, desktop: false } }
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config))
    await fs.writeFile(path.join(root, 'config.example.json'), JSON.stringify(config))
    await fs.writeFile(path.join(root, 'config', 'accounts.env'), webAccounts)
    await fs.writeFile(path.join(root, 'mock-lines.json'), '[]')
    await fs.writeFile(
        path.join(root, 'mock-run.cjs'),
        [
            "const fs = require('node:fs')",
            "const path = require('node:path')",
            "const lines = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-lines.json'), 'utf8'))",
            "process.stdout.write(lines.join('\\n') + '\\n')"
        ].join('\n')
    )
    await assert.rejects(fs.access(path.join(root, '.env')), { code: 'ENOENT' })
    await assert.rejects(fs.access(path.join(root, 'sessions')), { code: 'ENOENT' })

    port = await freeLoopbackPort()
    child = spawn(process.execPath, [path.join(copiedApi, 'server.js'), '--port', String(port)], {
        cwd: root,
        env: { ...isolatedEnv(root), ...accounts, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    })
    child.on('error', err => {
        spawnError = err
    })
    closed = new Promise(resolve => child.once('close', resolve))
    for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding('utf8')
        stream.on('data', chunk => {
            output = (output + chunk).slice(-100_000)
        })
    }
    await until(
        () => {
            if (spawnError) throw spawnError
            if (child.exitCode !== null || child.signalCode !== null)
                throw new Error(`API exited during startup:\n${output}`)
            const line = output.split(/\r?\n/).find(value => value.startsWith('__API_READY__ '))
            if (!line) return false
            try {
                return JSON.parse(line.slice('__API_READY__ '.length))
            } catch {
                return false
            }
        },
        'API readiness',
        10_000
    )
    ready = true

    // node:http avoids fetch's pooled keep-alive sockets; every request has a
    // deadline, and SSE resolves on its first frame then destroys both streams.
    function request(route, { method = 'GET', headers = {}, body, raw, sse = false } = {}) {
        return new Promise((resolve, reject) => {
            const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body))
            let res
            let text = ''
            let settled = false
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: route,
                method,
                agent: false,
                headers: {
                    ...(payload === undefined
                        ? {}
                        : {
                              'Content-Type': 'application/json',
                              'Content-Length': Buffer.byteLength(payload)
                          }),
                    ...headers
                }
            })
            requests.add(req)
            const timer = setTimeout(() => finish(new Error(`HTTP deadline: ${method} ${route}`)), 3000)
            function finish(error) {
                if (settled) return
                settled = true
                clearTimeout(timer)
                requests.delete(req)
                if (error) reject(error)
                else resolve({ status: res.statusCode, headers: res.headers, text })
                res?.destroy()
                req.destroy()
            }
            req.on('error', finish)
            req.on('response', incoming => {
                res = incoming
                res.setEncoding('utf8')
                res.on('error', finish)
                res.on('aborted', () => finish(new Error(`Response aborted: ${route}`)))
                res.on('data', chunk => {
                    text += chunk
                    if (sse && res.statusCode === 200 && text.includes('\n\n')) finish()
                })
                res.on('end', () => finish())
            })
            req.end(payload)
        })
    }
    async function json(route, options, status = 200) {
        const response = await request(route, options)
        assert.equal(response.status, status, `${route}: ${response.text}`)
        assert.match(response.headers['content-type'], /^application\/json; charset=utf-8$/)
        return JSON.parse(response.text)
    }
    return { root, request, json, config }
}

async function until(check, description, timeout = 5000) {
    const deadline = Date.now() + timeout
    do {
        const value = await check()
        if (value) return value
        await delay(25)
    } while (Date.now() < deadline)
    assert.fail(`Timed out waiting for ${description}`)
}

test(
    'public health, auth discovery, preflight, and static ES modules work without credentials',
    testOptions,
    async t => {
        const api = await fixture(t)
        const health = await api.json('/health')
        assert.deepEqual(
            { ...health, uptimeSec: 0 },
            {
                ok: true,
                name: 'mrs-http-contract-fixture',
                version: '0.0.1',
                state: 'idle',
                uptimeSec: 0,
                authRequired: true
            }
        )
        assert.ok(Number.isInteger(health.uptimeSec) && health.uptimeSec >= 0)
        assert.deepEqual(await api.json('/auth/me'), {
            authenticated: false,
            via: null,
            version: '0.0.1',
            username: null,
            dashboardLoginConfigured: true,
            tokenConfigured: true,
            demo: false,
            capabilities: {
                accountWrite: true,
                configWrite: false,
                scheduleWrite: false,
                envOverrides: false,
                revealConfig: false
            }
        })
        const shell = await api.request('/')
        assert.equal(shell.status, 200)
        assert.match(shell.headers['content-type'], /^text\/html/)
        assert.match(shell.text, /<script type="module" src="\/app\.js"><\/script>/)
        for (const asset of [
            '/app.js',
            '/ui.js',
            '/dashboard.js',
            '/refresh.js',
            '/accounts.js',
            '/points.js',
            '/logs.js',
            '/settings.js',
            '/notifications.js'
        ]) {
            const response = await api.request(asset)
            assert.equal(response.status, 200)
            assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8')
            assert.equal(response.headers['cache-control'], 'no-cache')
            assert.equal(
                response.text,
                await fs.readFile(path.join(api.root, 'scripts', 'api', 'web', asset.slice(1)), 'utf8')
            )
        }
        const app = await api.request('/app.js')
        assert.match(app.text, /import\s+\{[^}]+\}\s+from ['"]\.\/ui\.js['"]/)
        const head = await api.request('/ui.js', { method: 'HEAD' })
        assert.equal(head.status, 200)
        assert.equal(head.text, '')
        const preflight = await api.request('/start', { method: 'OPTIONS' })
        assert.equal(preflight.status, 204)
        assert.equal(preflight.text, '')
        assert.match(preflight.headers['access-control-allow-headers'], /X-Requested-With/)
        await api.json('/', { headers: { Accept: 'application/json' } }, 401)
        const index = await api.json('/', { headers: { ...tokenHeaders, Accept: 'application/json' } })
        assert.equal(index.authRequired, true)
        assert.ok(index.endpoints.includes('GET /accounts'))
    }
)

test('token auth protects reads and writes; query tokens are restricted to SSE', testOptions, async t => {
    const api = await fixture(t)
    for (const headers of [{}, { Authorization: 'Bearer wrong' }, { 'X-API-Key': 'wrong' }]) {
        const denied = await api.json('/status', { headers }, 401)
        assert.equal(denied.error, 'Unauthorized')
    }
    await api.json('/start', { method: 'POST', body: {} }, 401)
    for (const headers of [tokenHeaders, { 'X-API-Key': TOKEN }, { Authorization: `bEaReR ${TOKEN}` }]) {
        assert.equal((await api.json('/status', { headers })).state, 'idle')
        const me = await api.json('/auth/me', { headers })
        assert.equal(me.authenticated, true)
        assert.equal(me.via, 'token')
        assert.equal(me.username, null)
    }
    await api.json('/status', { headers: { Authorization: 'Bearer wrong', 'X-API-Key': TOKEN } }, 401)
    await api.json(`/status?token=${TOKEN}`, undefined, 401)
    await api.json(`/start?token=${TOKEN}`, { method: 'POST', body: {} }, 401)
    await api.json('/events?token=wrong', undefined, 401)
    for (const route of [`/events?token=${TOKEN}&replay=0`, `/events/?token=${TOKEN}&replay=0`]) {
        const response = await api.request(route, { sse: true })
        assert.equal(response.status, 200)
        assert.match(response.headers['content-type'], /^text\/event-stream/)
        const frame = /^event: hello\ndata: (.+)\n\n/.exec(response.text)
        assert.ok(frame, response.text)
        assert.equal(JSON.parse(frame[1]).state, 'idle')
    }
    // Token writes do not need the cookie-only CSRF header.
    assert.equal(
        (await api.json('/stop', { method: 'POST', headers: tokenHeaders, body: {} }, 409)).code,
        'NOT_RUNNING'
    )
})

test('dashboard login issues a signed cookie and requires CSRF header for cookie writes', testOptions, async t => {
    const api = await fixture(t)
    assert.equal(
        (
            await api.json(
                '/auth/login',
                {
                    method: 'POST',
                    body: { username: USERNAME, password: 'incorrect' }
                },
                401
            )
        ).code,
        'BAD_CREDENTIALS'
    )
    const login = await api.request('/auth/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } })
    assert.equal(login.status, 200)
    assert.deepEqual(JSON.parse(login.text), { ok: true, username: USERNAME })
    const setCookie = login.headers['set-cookie'][0]
    assert.match(setCookie, /^mrs_dashboard=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/)
    const cookie = setCookie.split(';')[0]
    const headers = { Cookie: cookie }
    const me = await api.json('/auth/me', { headers })
    assert.equal(me.authenticated, true)
    assert.equal(me.via, 'session')
    assert.equal(me.username, USERNAME)
    assert.equal((await api.json('/status', { headers })).state, 'idle')
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith('a') ? 'b' : 'a'}`
    assert.equal((await api.json('/auth/me', { headers: { Cookie: tampered } })).authenticated, false)
    await api.json('/status', { headers: { Cookie: tampered } }, 401)
    for (const route of ['/auth/logout', '/stop']) {
        assert.equal((await api.json(route, { method: 'POST', headers, body: {} }, 403)).code, 'CSRF')
    }
    const csrfHeaders = { ...headers, 'X-Requested-With': 'XMLHttpRequest' }
    assert.equal((await api.json('/stop', { method: 'POST', headers: csrfHeaders, body: {} }, 409)).code, 'NOT_RUNNING')
    const logout = await api.request('/auth/logout', { method: 'POST', headers: csrfHeaders, body: {} })
    assert.equal(logout.status, 200)
    assert.deepEqual(JSON.parse(logout.text), { ok: true })
    assert.match(logout.headers['set-cookie'][0], /^mrs_dashboard=;.*Max-Age=0$/)
    assert.equal((await api.json('/auth/me')).authenticated, false)
})

test('malformed JSON and non-object control bodies return 400 without starting a process', testOptions, async t => {
    const api = await fixture(t, { env: { API_ALLOW_CONFIG_WRITE: 'true' } })
    for (const [route, method] of [
        ['/auth/login', 'POST'],
        ['/start', 'POST'],
        ['/restart', 'POST'],
        ['/stop', 'POST'],
        ['/input', 'POST'],
        ['/shutdown', 'POST'],
        ['/accounts', 'POST'],
        ['/config', 'PATCH']
    ]) {
        assert.deepEqual(await api.json(route, { method, headers: tokenHeaders, raw: '{"broken":' }, 400), {
            error: 'Invalid JSON body.',
            code: 'BAD_JSON'
        })
    }
    for (const raw of ['null', '[]', '42', '"text"']) {
        assert.deepEqual(await api.json('/start', { method: 'POST', headers: tokenHeaders, raw }, 400), {
            error: 'Body must be a JSON object.',
            code: 'BAD_REQUEST'
        })
    }
    for (const route of ['/stop', '/restart', '/shutdown']) {
        assert.equal(
            (
                await api.json(
                    route,
                    {
                        method: 'POST',
                        headers: tokenHeaders,
                        body: { force: 'true' }
                    },
                    400
                )
            ).code,
            'BAD_REQUEST'
        )
    }
    const status = await api.json('/status', { headers: tokenHeaders })
    assert.equal(status.state, 'idle')
    assert.equal(status.pid, null)
    assert.equal(status.lastExit, null)
    assert.equal((await api.json('/history', { headers: tokenHeaders })).count, 0)
})

function logLine(user, title, message) {
    return `[11/17/2026, 10:00:00 AM] [${user}] [INFO] MAIN [${title}] ${message}`
}

async function mockRun(api, lines, expectedRuns) {
    await fs.writeFile(path.join(api.root, 'mock-lines.json'), JSON.stringify(lines))
    const started = await api.json('/start', { method: 'POST', headers: tokenHeaders, body: {} }, 202)
    assert.equal(started.started, true)
    assert.equal(started.command, process.execPath)
    assert.deepEqual(started.args, [path.join(api.root, 'mock-run.cjs')])
    assert.ok(Number.isInteger(started.pid) && started.pid > 0)
    const history = await until(async () => {
        const result = await api.json('/history', { headers: tokenHeaders })
        return result.count === expectedRuns ? result : false
    }, 'finite mock run completion')
    assert.equal(history.runs[0].exit.code, 0)
    assert.equal((await api.json('/status', { headers: tokenHeaders })).state, 'idle')
    return history
}

test(
    'accounts HTTP response joins real mock-run history, aggregates stats, and omits credentials/internal keys',
    testOptions,
    async t => {
        const api = await fixture(t, {
            accounts: {
                ACCOUNT_2_EMAIL: 'alpha@example.invalid',
                ACCOUNT_2_PASSWORD: 'synthetic-password',
                ACCOUNT_2_RECOVERY_EMAIL: 'recovery@example.invalid',
                ACCOUNT_2_TOTP_SECRET: 'SYNTHETICTOTPSECRET',
                ACCOUNT_2_GEO_LOCALE: 'us',
                ACCOUNT_2_LANG_CODE: 'en-us',
                ACCOUNT_2_PROXY_URL: 'http://inline-user:inline-secret@proxy.invalid:8080',
                ACCOUNT_2_PROXY_USERNAME: 'synthetic-proxy-user',
                ACCOUNT_2_PROXY_PASSWORD: 'synthetic-proxy-secret',
                ACCOUNT_11_EMAIL: 'unused@example.invalid'
            },
            webAccounts: 'ACCOUNT_7_EMAIL=beta@example.invalid\nACCOUNT_7_PASSWORD=synthetic-web-password\n'
        })
        const before = await api.json('/accounts', { headers: tokenHeaders })
        assert.equal(before.count, 3)
        assert.deepEqual(
            before.accounts.map(a => a.index),
            [2, 7, 11]
        )
        assert.ok(before.accounts.every(a => a.runs === 0 && a.totalCollected === 0 && a.lastRunAt === null))
        await mockRun(
            api,
            [
                logLine(
                    'alpha',
                    'ACCOUNT-START',
                    'Starting account: alpha@example.invalid | geoLocale: US | locale: en-US'
                ),
                logLine(
                    'alpha',
                    'REACT-PARSE',
                    'Snapshot completed | offers=1 | reportable=1 | streaks=1 | streakProtectionEnabled=true | streakProtectionRemainingDays=2 | streakCounter=9 | level=2 | account=alpha@example.invalid'
                ),
                logLine(
                    'alpha',
                    'EDGE-BROWSING',
                    'Finished background Edge browsing activity | reports=1 | scheduledMinutesCovered=5/5 | accepted=1 | duplicates=0 | failed=0 | elapsedMinutes=5 | estimatedRemainingMinutes=0'
                ),
                logLine(
                    'alpha',
                    'FLOW',
                    'Points collected | pointsGained=5 | currentBalance=1005 | account=alpha@example.invalid'
                ),
                logLine('alpha', 'ACCOUNT-ERROR', 'alpha@example.invalid | error=synthetic failure'),
                logLine(
                    'beta',
                    'ACCOUNT-END',
                    'Account completed: beta@example.invalid | pointsGained=7 | originalBalance=2000 | currentBalance=2007 | durationSeconds=1'
                )
            ],
            1
        )
        const history = await mockRun(
            api,
            [
                logLine(
                    'alpha',
                    'ACCOUNT-END',
                    'Account completed: alpha@example.invalid | pointsGained=20 | originalBalance=1005 | currentBalance=1025 | durationSeconds=1'
                ),
                logLine(
                    'beta',
                    'ACCOUNT-END',
                    'Account completed: beta@example.invalid | pointsGained=3 | originalBalance=2007 | currentBalance=2010 | durationSeconds=1'
                )
            ],
            2
        )
        const response = await api.request('/accounts', { headers: tokenHeaders })
        assert.equal(response.status, 200)
        const { accounts, count, accountsEnvPath } = JSON.parse(response.text)
        assert.equal(count, 3)
        assert.equal(accountsEnvPath, path.join(api.root, 'config', 'accounts.env'))
        const [alpha, beta, unused] = accounts
        assert.deepEqual(
            accounts.map(({ runs, totalCollected, successStreak, lastCollected, lastSuccess, lastError }) => ({
                runs,
                totalCollected,
                successStreak,
                lastCollected,
                lastSuccess,
                lastError
            })),
            [
                {
                    runs: 2,
                    totalCollected: 25,
                    successStreak: 1,
                    lastCollected: 20,
                    lastSuccess: true,
                    lastError: null
                },
                { runs: 2, totalCollected: 10, successStreak: 2, lastCollected: 3, lastSuccess: true, lastError: null },
                {
                    runs: 0,
                    totalCollected: 0,
                    successStreak: 0,
                    lastCollected: null,
                    lastSuccess: null,
                    lastError: null
                }
            ]
        )
        assert.equal(alpha.lastRunAt, history.runs[0].endedAt)
        assert.equal(beta.lastRunAt, history.runs[0].endedAt)
        assert.equal(unused.lastRunAt, null)
        assert.equal(alpha.source, 'env')
        assert.equal(alpha.webManaged, false)
        assert.equal(beta.source, 'web')
        assert.equal(beta.webManaged, true)
        assert.equal(alpha.geoLocale, 'US')
        assert.equal(alpha.langCode, 'en-US')
        assert.equal(alpha.hasPassword, true)
        assert.equal(alpha.hasRecoveryEmail, true)
        assert.equal(alpha.hasTotp, true)
        assert.equal(alpha.proxy.url, 'http://proxy.invalid:8080')
        assert.equal(alpha.proxy.hasCredentials, true)
        assert.equal(alpha.streakProtection.enabled, true)
        assert.equal(alpha.streakProtection.remainingDays, 2)
        assert.equal(alpha.edgeBrowsing.status, 'complete')
        assert.equal(beta.streakProtection, null)
        for (const account of accounts) {
            for (const key of ['emailKey', 'password', 'totpSecret', 'recoveryEmail'])
                assert.equal(key in account, false)
        }
        for (const secret of [
            'synthetic-password',
            'SYNTHETICTOTPSECRET',
            'recovery@example.invalid',
            'inline-user',
            'inline-secret',
            'synthetic-proxy-user',
            'synthetic-proxy-secret',
            'synthetic-web-password'
        ]) {
            assert.equal(response.text.includes(secret), false, `leaked ${secret}`)
        }
        await assert.rejects(fs.access(path.join(api.root, 'sessions')), { code: 'ENOENT' })
    }
)

test('config-write gate rejects PUT, PATCH, and sync without touching the fixture config', testOptions, async t => {
    const api = await fixture(t)
    const configPath = path.join(api.root, 'config.json')
    const original = await fs.readFile(configPath, 'utf8')
    const read = await api.json('/config', { headers: tokenHeaders })
    assert.equal(read.path, configPath)
    assert.equal(read.redacted, true)
    assert.deepEqual(read.config, api.config)
    for (const [route, method] of [
        ['/config', 'PUT'],
        ['/config', 'PATCH'],
        ['/config/sync', 'POST']
    ]) {
        const denied = await api.json(route, { method, headers: tokenHeaders, body: { clusters: 9 } }, 403)
        assert.match(denied.error, /Config writes are disabled/)
        assert.equal(await fs.readFile(configPath, 'utf8'), original)
    }
    await assert.rejects(fs.access(`${configPath}.bak`), { code: 'ENOENT' })
    assert.equal((await api.json('/auth/me', { headers: tokenHeaders })).capabilities.configWrite, false)
})

test(
    'enabled config writes validate, merge PATCH, replace PUT, and persist only inside the fixture',
    testOptions,
    async t => {
        const api = await fixture(t, { env: { API_ALLOW_CONFIG_WRITE: 'true' } })
        const configPath = path.join(api.root, 'config.json')
        assert.equal((await api.json('/auth/me', { headers: tokenHeaders })).capabilities.configWrite, true)
        const patched = await api.json('/config', {
            method: 'PATCH',
            headers: tokenHeaders,
            body: { clusters: 2, workers: { desktop: true } }
        })
        assert.deepEqual(patched, { ok: true, path: configPath, via: 'structural-fallback', appliesOnNextRun: true })
        const expected = { ...api.config, clusters: 2, workers: { mobile: true, desktop: true } }
        assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), expected)
        assert.deepEqual(JSON.parse(await fs.readFile(`${configPath}.bak`, 'utf8')), api.config)
        const invalid = await api.json(
            '/config',
            {
                method: 'PATCH',
                headers: tokenHeaders,
                body: { clusters: -1 }
            },
            422
        )
        assert.equal(invalid.error, 'Config validation failed')
        assert.equal(invalid.via, 'structural-fallback')
        assert.ok(invalid.errors.includes('clusters must be a non-negative integer'))
        assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), expected)
        const replacement = { sessionPath: 'isolated-sessions', clusters: 0 }
        await api.json('/config', { method: 'PUT', headers: tokenHeaders, body: replacement })
        assert.deepEqual((await api.json('/config', { headers: tokenHeaders })).config, replacement)
        assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), replacement)
        assert.deepEqual(JSON.parse(await fs.readFile(`${configPath}.bak`, 'utf8')), expected)
    }
)

test('malformed cookies do not crash auth or protected requests', testOptions, async t => {
    const api = await fixture(t)
    for (const Cookie of ['mrs_dashboard=%', 'mrs_dashboard=%E0%A4%A', 'mrs_dashboard=%FF']) {
        assert.equal((await api.json('/auth/me', { headers: { Cookie } })).authenticated, false)
        await api.json('/status', { headers: { Cookie } }, 401)
    }
    assert.equal((await api.json('/status', { headers: tokenHeaders })).state, 'idle')
})

test(
    'HTTP account edits validate merged state, preserve blank secrets and require explicit clears',
    testOptions,
    async t => {
        const api = await fixture(t)
        const created = await api.json(
            '/accounts',
            {
                method: 'POST',
                headers: tokenHeaders,
                body: {
                    email: 'write@example.invalid',
                    password: 'keep',
                    recoveryEmail: 'recover@example.invalid',
                    totpSecret: 'ABCDEFGHIJKLMNOP',
                    proxy: { url: 'http://proxy.invalid', username: 'user', password: 'proxy-pass' }
                }
            },
            201
        )
        const route = `/accounts/${created.slot}`
        const file = path.join(api.root, 'config', 'accounts.env')
        const before = await fs.readFile(file, 'utf8')
        for (const body of [
            { email: 'bad' },
            { password: 'x\nACCOUNT_99_EMAIL=injected@example.invalid' },
            { proxy: { port: 70000 } },
            { proxy: { url: 'ftp://proxy.invalid' } },
            { totpSecret: 'bad' }
        ]) {
            await api.json(route, { method: 'PATCH', headers: tokenHeaders, body }, 422)
            assert.equal(await fs.readFile(file, 'utf8'), before)
        }
        for (const clearFields of [null, 'password', ['bad'], ['proxy', 'proxy.password']]) {
            await api.json(route, { method: 'PATCH', headers: tokenHeaders, body: { clearFields } }, 400)
        }
        await api.json(route, {
            method: 'PATCH',
            headers: tokenHeaders,
            body: { password: '', totpSecret: '', recoveryEmail: '', proxy: { username: '', password: '' } }
        })
        assert.equal(await fs.readFile(file, 'utf8'), before)
        await api.json(route, {
            method: 'PATCH',
            headers: tokenHeaders,
            body: { clearFields: ['password', 'totpSecret', 'recoveryEmail', 'proxy'] }
        })
        assert.doesNotMatch(await fs.readFile(file, 'utf8'), /PASSWORD|TOTP_SECRET|RECOVERY_EMAIL|PROXY_/)
    }
)

test('config rejects redaction placeholders and preserves omitted PATCH credentials', testOptions, async t => {
    const api = await fixture(t, { env: { API_ALLOW_CONFIG_WRITE: 'true' } })
    const file = path.join(api.root, 'config.json')
    const config = {
        ...api.config,
        webhook: { pushplus: { token: 'push-secret' }, serverchan: { sendKey: 'send-secret' } },
        searchSettings: { chinaApi: { appkey: 'app-secret' } }
    }
    await fs.writeFile(file, JSON.stringify(config))
    const redacted = (await api.json('/config', { headers: tokenHeaders })).config
    for (const secret of ['push-secret', 'send-secret', 'app-secret'])
        assert.equal(JSON.stringify(redacted).includes(secret), false)
    for (const method of ['PUT', 'PATCH']) {
        await api.json('/config', { method, headers: tokenHeaders, body: redacted }, 400)
        assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), config)
    }
    await api.json('/config', { method: 'PATCH', headers: tokenHeaders, body: { clusters: 2 } })
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).webhook, config.webhook)
})

test(
    'notification settings preserve tokens and preview reports per-account progress without sending',
    testOptions,
    async t => {
        const api = await fixture(t, {
            env: { API_ALLOW_CONFIG_WRITE: 'true', TZ: 'Asia/Shanghai' },
            accounts: { ACCOUNT_1_EMAIL: 'notify@example.invalid' }
        })
        const settings = {
            webhook: {
                pushplus: {
                    enabled: true,
                    token: 'fixture-notification-secret',
                    title: '摘要',
                    template: 'txt',
                    channel: ''
                }
            },
            rewardGoal: { name: '100元礼品卡', faceValue: 100, targetPoints: 20000 }
        }
        await api.json('/config', { method: 'PATCH', headers: tokenHeaders, body: settings })
        const record = {
            startedAt: new Date(Date.now() - 60000).toISOString(),
            endedAt: new Date().toISOString(),
            accounts: [{ email: 'notify@example.invalid', collected: 285, balance: 15535, success: true }]
        }
        await fs.writeFile(path.join(api.root, 'config', 'points-history.jsonl'), JSON.stringify(record) + '\n')
        await api.json('/notifications/preview', undefined, 401)
        const preview = await api.json('/notifications/preview', { headers: tokenHeaders })
        assert.equal(preview.sendsNotification, false)
        assert.equal(preview.accounts.length, 1)
        assert.equal(preview.accounts[0].balance, 15535)
        assert.equal(preview.accounts[0].currentRunEarned, 285)
        assert.equal(preview.accounts[0].remainingPoints, 4465)
        assert.equal(preview.accounts[0].reason, 'insufficient_history')
        assert.equal(JSON.stringify(preview).includes('fixture-notification-secret'), false)
        assert.match(preview.content, /notify@example\.invalid/)
        await api.json('/config', {
            method: 'PATCH',
            headers: tokenHeaders,
            body: { webhook: { pushplus: { title: '新标题' } } }
        })
        let saved = JSON.parse(await fs.readFile(path.join(api.root, 'config.json'), 'utf8'))
        assert.equal(saved.webhook.pushplus.token, 'fixture-notification-secret')
        for (const rewardGoal of [
            { targetPoints: -1 },
            { targetPoints: 1.5 },
            { targetPoints: '20000' },
            { faceValue: 0 }
        ]) {
            await api.json('/config', { method: 'PATCH', headers: tokenHeaders, body: { rewardGoal } }, 422)
        }
        await api.json(
            '/config',
            { method: 'PATCH', headers: tokenHeaders, body: { webhook: { pushplus: { template: 'bad' } } } },
            422
        )
        await api.json('/config', {
            method: 'PATCH',
            headers: tokenHeaders,
            body: { webhook: { pushplus: { token: '' } } }
        })
        saved = JSON.parse(await fs.readFile(path.join(api.root, 'config.json'), 'utf8'))
        assert.equal(saved.webhook.pushplus.token, '')
    }
)
