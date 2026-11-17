import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createPreviewFixture, isolatedEnv, launchPreview, previewPort, requestJson } from './server.mjs'
import { applyLogToRunState, createRunState, parseLogLine, summarizeRunState } from '../api/logParser.js'

const options = { timeout: 30000 }

test('preview port is fixed by default and rejects invalid input', () => {
    assert.equal(previewPort('4310'), 4310)
    assert.equal(previewPort('65535'), 65535)
    for (const value of ['', '0', '-1', '65536', '4310.5', ' 4310 ', '4310junk', 'NaN', '1e3']) {
        assert.throws(() => previewPort(value), /PREVIEW_PORT/)
    }
})

test('preview child environment excludes inherited credentials, hooks, proxies and account filters', () => {
    const env = isolatedEnv('isolated-preview-root', 4310, {
        SystemRoot: 'C:\\Windows',
        ACCOUNT_1_EMAIL: 'real@example.com',
        API_TOKEN: 'real-token',
        DASHBOARD_PASSWORD: 'real-password',
        NODE_OPTIONS: '--require injected.cjs',
        NODE_PATH: 'secret-deps',
        HTTPS_PROXY: 'http://real-proxy',
        ACCOUNTS_FILTERED: 'true',
        SCHEDULE_FILE: 'real-schedule',
        npm_execpath: 'real-npm',
        PREVIEW_PORT: '8080',
        PATH: 'real-path',
        TZ: 'real-timezone'
    })
    assert.equal(env.API_HOST, '127.0.0.1')
    assert.equal(env.API_PORT, '4310')
    assert.equal(env.DASHBOARD_USERNAME, 'admin')
    assert.equal(env.DASHBOARD_PASSWORD, 'Preview2026!')
    assert.equal(env.API_ALLOW_ACCOUNT_WRITE, 'true')
    assert.equal(env.API_ALLOW_SCHEDULE_WRITE, 'true')
    assert.equal(env.API_ALLOW_ENV_OVERRIDES, 'false')
    assert.match(env.API_TOKEN, /^[a-f0-9]{64}$/)
    assert.match(env.DASHBOARD_SESSION_SECRET, /^[a-f0-9]{64}$/)
    assert.notEqual(env.API_TOKEN, env.DASHBOARD_SESSION_SECRET)
    for (const key of [
        'ACCOUNT_1_EMAIL',
        'NODE_OPTIONS',
        'NODE_PATH',
        'HTTPS_PROXY',
        'ACCOUNTS_FILTERED',
        'SCHEDULE_FILE',
        'npm_execpath',
        'PREVIEW_PORT'
    ])
        assert.equal(key in env, false, key)
    assert.notEqual(env.API_TOKEN, isolatedEnv('another-root', 4310, {}).API_TOKEN)
})

test(
    'fixture contains runtime source and synthetic data; finite seed produces valid parser state',
    options,
    async t => {
        const fixture = await createPreviewFixture()
        t.after(fixture.dispose)
        for (const filename of [
            'scripts/env.js',
            'scripts/credentialEnv.cjs',
            'scripts/rewardForecast.cjs',
            'scripts/forecastHistory.cjs',
            'scripts/utils.js',
            'scripts/api/server.js',
            'scripts/api/web/index.html',
            'mock-run.cjs'
        ])
            await fs.access(path.join(fixture.root, filename))
        for (const filename of [
            '.env',
            'node_modules',
            'dist',
            'src',
            'sessions',
            'scripts/api/server.test.js',
            'scripts/credentialEnv.d.cts'
        ])
            await assert.rejects(fs.access(path.join(fixture.root, filename)), { code: 'ENOENT' })
        const accounts = await fs.readFile(path.join(fixture.root, 'config/accounts.env'), 'utf8')
        assert.match(accounts, /aurora@example\.invalid/)
        const history = (await fs.readFile(path.join(fixture.root, 'config/points-history.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map(JSON.parse)
        assert.equal(history.length, 14)
        assert.ok(history.every(record => record.demo && record.collected > 0))
        const proxy = await import(pathToFileURL(path.join(fixture.root, 'scripts/api/proxyTester.js')).href)
        const result = await proxy.testProxy({ url: 'http://never-resolve.example.invalid' })
        assert.equal(result.demo, true)
        assert.equal(result.target, 'demo://local-synthetic-response')
        const child = spawn(process.execPath, [path.join(fixture.root, 'mock-run.cjs')], {
            cwd: fixture.root,
            env: fixture.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        })
        t.after(() => {
            if (child.exitCode === null) child.kill('SIGKILL')
        })
        let output = ''
        let errors = ''
        child.stdout.setEncoding('utf8').on('data', chunk => {
            output += chunk
        })
        child.stderr.setEncoding('utf8').on('data', chunk => {
            errors += chunk
        })
        const exit = await new Promise((resolve, reject) => {
            child.once('error', reject)
            child.once('close', resolve)
        })
        assert.equal(exit, 0, errors)
        assert.match(output, /DEMO ONLY/)
        const state = createRunState()
        for (const line of output.trim().split('\n')) applyLogToRunState(state, parseLogLine(line))
        const run = summarizeRunState(state)
        assert.equal(run.finished, true)
        assert.equal(run.accountsTotal, 3)
        assert.equal(run.accounts.length, 3)
        assert.equal(run.collected, 835)
        assert.ok(run.accounts.every(account => account.success === true && account.live.balance > 0))
        await assert.rejects(fs.access(path.join(fixture.root, '.preview-seed')), { code: 'ENOENT' })
        await fixture.dispose()
        await assert.rejects(fs.access(fixture.root), { code: 'ENOENT' })
    }
)

test('preview schedule wrapper preserves store behavior but never invokes host apply', options, async t => {
    const fixture = await createPreviewFixture()
    t.after(fixture.dispose)
    const runtimeFile = path.join(fixture.root, 'scripts/api/scheduleStore-runtime.js')
    const runtime = await fs.readFile(runtimeFile, 'utf8')
    assert.match(runtime, /export function applyCrontab\(/)
    // Tripwire rather than observing or modifying the real host crontab.
    await fs.writeFile(
        runtimeFile,
        runtime.replace(
            'export function applyCrontab({ enabled, cron }) {',
            'export function applyCrontab({ enabled, cron }) { throw new Error("HOST APPLY MUST NOT RUN");'
        )
    )
    const store = await import(pathToFileURL(path.join(fixture.root, 'scripts/api/scheduleStore.js')).href)
    store.applyCrontab({ enabled: true, cron: '* * * * *' })
    const enabled = store.writeSchedule(fixture.root, { enabled: true, cron: '0 9 * * *' })
    assert.equal(enabled.application, 'demo-storage')
    assert.equal(enabled.hostScheduling, false)
    assert.deepEqual(store.readSchedule(fixture.root), enabled)
    const contents = await fs.readFile(path.join(fixture.root, 'config/schedule.json'), 'utf8')
    assert.throws(() => store.writeSchedule(fixture.root, { cron: 'invalid' }), { code: 'BAD_REQUEST' })
    assert.equal(await fs.readFile(path.join(fixture.root, 'config/schedule.json'), 'utf8'), contents)
    assert.equal(store.writeSchedule(fixture.root, { enabled: false }).enabled, false)
})

test(
    'preview API seeds its dashboard, persists account CRUD, pins mock arguments and cleans up on shutdown',
    options,
    async t => {
        const reservation = net.createServer()
        await new Promise((resolve, reject) => {
            reservation.once('error', reject)
            reservation.listen(0, '127.0.0.1', resolve)
        })
        const port = reservation.address().port
        await new Promise(resolve => reservation.close(resolve))
        let output = ''
        const sink = {
            write(chunk) {
                output += chunk
            }
        }
        const preview = await launchPreview({ port, output: sink, errorOutput: sink })
        t.after(preview.stop)
        const json = (route, options) => requestJson(port, preview.apiToken, route, options)
        assert.match(output, /__PREVIEW_READY__ /)
        assert.equal(preview.url, `http://127.0.0.1:${port}/`)
        const status = await json('/status')
        assert.equal(status.state, 'idle')
        assert.equal(status.run.finished, true)
        assert.equal(status.run.collected, 835)
        assert.equal((await json('/accounts')).count, 3)
        assert.ok((await json('/points/history')).daily.length >= 14)
        const capabilities = (await json('/auth/me')).capabilities
        assert.equal(capabilities.configWrite, true)
        assert.equal(capabilities.revealConfig, true)
        assert.equal(capabilities.scheduleWrite, true)
        assert.match(preview.boundaries, /no host cron, timer or automatic runs/)
        const initialSchedule = await json('/schedule')
        assert.equal(initialSchedule.enabled, false)
        assert.equal(initialSchedule.writable, true)
        assert.equal(initialSchedule.application, 'demo-storage')
        assert.equal(initialSchedule.hostScheduling, false)
        const enabledSchedule = await json('/schedule', {
            method: 'PUT',
            body: { enabled: true, cron: '*/5 * * * *', skipIfRunning: true, excludedAccountIndexes: [3, 1] }
        })
        assert.equal(enabledSchedule.enabled, true)
        assert.equal(enabledSchedule.demo, true)
        assert.equal(enabledSchedule.hostScheduling, false)
        assert.deepEqual(enabledSchedule.excludedAccountIndexes, [1, 3])
        assert.deepEqual(await json('/schedule'), enabledSchedule)
        const editedSchedule = await json('/schedule', {
            method: 'PATCH',
            body: { cron: '30 8 * * 1-5', skipIfRunning: false, excludedAccountIndexes: [2] }
        })
        assert.equal(editedSchedule.enabled, true)
        assert.equal(editedSchedule.cron, '30 8 * * 1-5')
        assert.equal(editedSchedule.skipIfRunning, false)
        assert.deepEqual(await json('/schedule'), editedSchedule)
        const scheduleFile = path.join(preview.root, 'config', 'schedule.json')
        const beforeInvalid = await fs.readFile(scheduleFile, 'utf8')
        await assert.rejects(
            json('/schedule', { method: 'PATCH', body: { cron: '60 9 * * *' } }),
            /HTTP 400.*Invalid cron/
        )
        assert.equal(await fs.readFile(scheduleFile, 'utf8'), beforeInvalid)
        assert.deepEqual(await json('/schedule'), editedSchedule)
        const disabledSchedule = await json('/schedule', { method: 'PATCH', body: { enabled: false } })
        assert.equal(disabledSchedule.enabled, false)
        assert.equal(disabledSchedule.cron, editedSchedule.cron)
        assert.deepEqual(await json('/schedule'), disabledSchedule)
        assert.equal(JSON.parse(await fs.readFile(scheduleFile, 'utf8')).enabled, false)
        assert.equal((await json('/status')).state, 'idle')
        const notification = await json('/notifications/preview')
        assert.equal(notification.demo, true)
        assert.equal(notification.sendsNotification, false)
        assert.equal(notification.timeZone, 'UTC')
        assert.deepEqual(notification.goal, { name: '100元礼品卡', faceValue: 100, targetPoints: null })
        assert.equal(notification.accounts.length, 3)
        assert.ok(
            notification.accounts.every(account => account.observationDays === 7 && account.averageDailyPoints > 0)
        )
        assert.ok(
            notification.accounts.every(
                account => account.reason === 'unknown_target' && account.estimatedDays === null
            )
        )
        assert.match(notification.content, /aurora@example\.invalid/)
        assert.match(notification.content, /未设置实际所需积分/)
        const demoToken = 'synthetic-preview-token-not-real'
        await json('/config', {
            method: 'PATCH',
            body: {
                webhook: { pushplus: { enabled: true, token: demoToken } },
                rewardGoal: { targetPoints: 30000 }
            }
        })
        const withTarget = await json('/notifications/preview')
        assert.equal(withTarget.sendsNotification, false)
        assert.equal(withTarget.goal.targetPoints, 30000)
        assert.ok(withTarget.accounts.every(account => account.remainingPoints > 0 && account.estimatedDays > 0))
        assert.equal(JSON.stringify(withTarget).includes(demoToken), false)
        assert.equal(JSON.stringify(await json('/config')).includes(demoToken), false)
        await json('/config', { method: 'PATCH', body: { webhook: { pushplus: { title: 'Demo summary' } } } })
        const configFile = path.join(preview.root, 'config.json')
        const beforeInvalidGoal = await fs.readFile(configFile, 'utf8')
        assert.equal(JSON.parse(beforeInvalidGoal).webhook.pushplus.token, demoToken)
        for (const rewardGoal of [
            { targetPoints: -1 },
            { targetPoints: 1.5 },
            { targetPoints: '30000' },
            { faceValue: 0 },
            { name: '' }
        ]) {
            await assert.rejects(json('/config', { method: 'PATCH', body: { rewardGoal } }), /HTTP 422/)
            assert.equal(await fs.readFile(configFile, 'utf8'), beforeInvalidGoal)
        }
        await json('/config', { method: 'PATCH', body: { headless: false, workers: { doMobileSearch: false } } })
        const config = (await json('/config?reveal=true')).config
        assert.equal(config.headless, false)
        assert.equal(config.workers.doMobileSearch, false)
        assert.equal((await json('/config/diff')).upToDate, true)
        await json('/config/sync', { method: 'POST', body: {} })
        await assert.rejects(json('/config', { method: 'PATCH', body: { sessionPath: '../outside' } }), /HTTP 422/)
        const added = await json('/accounts', {
            method: 'POST',
            body: { email: 'editable@example.invalid', password: ' Synthetic! "quoted" \\ demo ' }
        })
        assert.equal(added.created, true)
        let account = (await json('/accounts')).accounts.find(entry => entry.email === 'editable@example.invalid')
        assert.ok(account?.webManaged)
        await json(`/accounts/${account.index}`, { method: 'PATCH', body: { geoLocale: 'GB' } })
        account = (await json('/accounts')).accounts.find(entry => entry.index === account.index)
        assert.equal(account.geoLocale, 'GB')
        await json(`/accounts/${account.index}`, { method: 'DELETE' })
        assert.equal((await json('/accounts')).count, 3)
        const proxy = await json('/accounts/1/proxy-test', { method: 'POST', body: {} })
        assert.equal(proxy.demo, true)
        const started = await json('/start', {
            method: 'POST',
            body: { accountIndex: 1, args: ['-e', 'throw new Error("ARGUMENT OVERRIDE RAN")'] }
        })
        assert.deepEqual(started.args, [path.join(preview.root, 'mock-run.cjs')])
        await delay(150)
        assert.equal((await json('/status')).state, 'running')
        await json('/stop', { method: 'POST', body: { force: true } })
        await preview.stop()
        await preview.closed
        await assert.rejects(fs.access(preview.root), { code: 'ENOENT' })
    }
)
