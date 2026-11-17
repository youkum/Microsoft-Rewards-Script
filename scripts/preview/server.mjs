import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const previewDir = path.dirname(fileURLToPath(import.meta.url))
const sourceScripts = path.dirname(previewDir)
export const DEMO_USERNAME = 'admin'
export const DEMO_PASSWORD = 'Preview2026!'

export function previewPort(value = process.env.PREVIEW_PORT) {
    if (value === undefined) return 4310
    if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        throw new Error('PREVIEW_PORT must be an integer from 1 to 65535.')
    }
    return Number(value)
}

export function isolatedEnv(root, port, inherited = process.env) {
    const env = {}
    const allowed = new Set(['systemroot', 'windir', 'comspec', 'pathext', 'lang', 'lc_all'])
    for (const [key, value] of Object.entries(inherited)) {
        if (allowed.has(key.toLowerCase())) env[key] = value
    }
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.systemroot
    return {
        ...env,
        HOME: root,
        USERPROFILE: root,
        APPDATA: path.join(root, 'appdata'),
        LOCALAPPDATA: path.join(root, 'appdata'),
        TMP: root,
        TEMP: root,
        TMPDIR: root,
        PATH: [
            path.dirname(process.execPath),
            ...(process.platform === 'win32' && systemRoot ? [path.join(systemRoot, 'System32')] : [])
        ].join(path.delimiter),
        TZ: 'UTC',
        NO_COLOR: '1',
        API_HOST: '127.0.0.1',
        API_PORT: String(port),
        API_CORS_ORIGIN: `http://127.0.0.1:${port}`,
        API_TOKEN: crypto.randomBytes(32).toString('hex'),
        DASHBOARD_USERNAME: DEMO_USERNAME,
        DASHBOARD_PASSWORD: DEMO_PASSWORD,
        DASHBOARD_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
        API_ALLOW_ACCOUNT_WRITE: 'true',
        API_ALLOW_CONFIG_WRITE: 'true',
        API_ALLOW_CONFIG_REVEAL: 'true',
        API_VALIDATOR_MODULE: path.join(root, 'preview-validator.mjs'),
        API_ALLOW_SCHEDULE_WRITE: 'true',
        API_ALLOW_ENV_OVERRIDES: 'false',
        API_STOP_TIMEOUT_MS: '1000',
        API_DIAGNOSTICS_DIR: path.join(root, 'diagnostics'),
        API_RUN_COMMAND: process.execPath,
        API_RUN_ARGS: JSON.stringify([path.join(root, 'mock-run.cjs')]),
        PREVIEW_DEMO: 'true'
    }
}

const proxyStub = `// Demo boundary: never opens a socket or resolves a proxy hostname.
export async function testProxy() {
    return {
        ok: true, demo: true, synthetic: true,
        ip: '192.0.2.42', country: 'DEMO — synthetic, not tested', countryCode: 'DEMO',
        timezone: 'Etc/UTC', latencyMs: 12, target: 'demo://local-synthetic-response',
        proxy: 'DEMO ONLY — no proxy connection was made',
        message: 'Demo result only. No external network request was made.'
    }
}
`

// The real API accepts per-request process arguments. Pin that boundary in the
// disposable copy too, so /start and /restart cannot turn Node into a real bot,
// a shell, or an arbitrary -e script. Account-selection env still works.
const processManagerStub = `import { ProcessManager as RuntimeProcessManager } from './processManager-runtime.js'
export class ProcessManager extends RuntimeProcessManager {
    start(overrides = {}) {
        return super.start({ ...overrides, args: this.defaultArgs })
    }
}
export default ProcessManager
`

// Keep production parsing, persistence and rollback behavior, but never cross
// the host scheduling boundary. Saving a demo schedule does not execute it.
const scheduleStoreStub = `import {
    readSchedule as readRuntimeSchedule,
    writeSchedule as writeRuntimeSchedule
} from './scheduleStore-runtime.js'
export { isValidCron, scheduleFilePath } from './scheduleStore-runtime.js'
export function applyCrontab() {} // Trusted demo-only no-op; no timer or host cron.
const describe = schedule => ({
    ...schedule, demo: true, application: 'demo-storage', hostScheduling: false,
    message: 'Demo schedule saved locally only. No host cron or automatic task is created.'
})
export const readSchedule = root => describe(readRuntimeSchedule(root))
export const writeSchedule = (root, patch) => describe(writeRuntimeSchedule(root, patch, applyCrontab))
`

const validatorStub = `// Demo-only JSON editor validation and defaults. No production modules loaded.
import fs from 'node:fs'
import path from 'node:path'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export function validateConfig(config) {
    if (!object(config)) throw new Error('Demo config must be a JSON object.')
    if ('clusters' in config && (!Number.isSafeInteger(config.clusters) || config.clusters < 0)) throw new Error('clusters must be a non-negative integer')
    for (const key of ['headless', 'debugLogs', 'errorDiagnostics', 'ensureStreakProtection']) {
        if (key in config && typeof config[key] !== 'boolean') throw new Error(key + ' must be a boolean')
    }
    if ('rewardGoal' in config) {
        const goal = config.rewardGoal
        if (!object(goal)) throw new Error('rewardGoal must be an object')
        if ('name' in goal && (typeof goal.name !== 'string' || !goal.name.trim())) throw new Error('rewardGoal.name must be a non-empty string')
        if ('faceValue' in goal && (!Number.isFinite(goal.faceValue) || goal.faceValue <= 0)) throw new Error('rewardGoal.faceValue must be a positive number')
        if ('targetPoints' in goal && goal.targetPoints !== null && (!Number.isSafeInteger(goal.targetPoints) || goal.targetPoints <= 0)) throw new Error('rewardGoal.targetPoints must be null or a positive integer')
    }
    if (config.webhook?.pushplus !== undefined) {
        const pushplus = config.webhook.pushplus
        if (!object(pushplus)) throw new Error('webhook.pushplus must be an object')
        if ('enabled' in pushplus && typeof pushplus.enabled !== 'boolean') throw new Error('webhook.pushplus.enabled must be a boolean')
        if ('token' in pushplus && typeof pushplus.token !== 'string') throw new Error('webhook.pushplus.token must be a string')
    }
    // File-reading routes remain within the temporary fixture even after edits.
    if ('sessionPath' in config && config.sessionPath !== 'sessions') throw new Error('Demo sessionPath must remain sessions.')
    return config
}
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
export const resolveExamplePath = root => path.join(root, 'config.example.json')
export function diffKeyPaths(config, example, prefix = '') {
    const keys = []
    for (const [key, value] of Object.entries(example)) {
        const location = prefix ? prefix + '.' + key : key
        if (!Object.hasOwn(config, key)) keys.push(location)
        else if (object(value) && object(config[key])) keys.push(...diffKeyPaths(config[key], value, location))
    }
    return keys
}
export function mergeMissingDefaults(config, example) {
    const merged = structuredClone(config)
    const addedKeys = diffKeyPaths(config, example)
    function fill(target, defaults) {
        for (const [key, value] of Object.entries(defaults)) {
            if (!Object.hasOwn(target, key)) target[key] = structuredClone(value)
            else if (object(value) && object(target[key])) fill(target[key], value)
        }
    }
    fill(merged, example)
    return { merged, addedKeys }
}
`

export async function createPreviewFixture({ port = 4310, scriptsDir = sourceScripts } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mrs-local-preview-'))
    const dispose = () => fs.rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 })
    try {
        const apiSource = path.join(scriptsDir, 'api')
        const apiTarget = path.join(root, 'scripts', 'api')
        // Copy runtime source/assets only. Never copy the project root, follow
        // links, or bring across .env, config, dist, sessions or node_modules.
        await fs.cp(apiSource, apiTarget, {
            recursive: true,
            filter: async source => {
                const stat = await fs.lstat(source)
                if (stat.isSymbolicLink()) return false
                if (stat.isDirectory()) return source === apiSource || source === path.join(apiSource, 'web')
                return /\.(?:js|mjs|cjs|html|css|svg)$/.test(source) && !/\.test\.[cm]?js$/.test(source)
            }
        })
        for (const entry of await fs.readdir(scriptsDir, { withFileTypes: true })) {
            if (entry.isFile() && /\.(?:js|cjs)$/.test(entry.name) && !/\.test\.[cm]?js$/.test(entry.name)) {
                await fs.copyFile(path.join(scriptsDir, entry.name), path.join(root, 'scripts', entry.name))
            }
        }
        await fs.writeFile(path.join(apiTarget, 'proxyTester.js'), proxyStub)
        await fs.rename(path.join(apiTarget, 'processManager.js'), path.join(apiTarget, 'processManager-runtime.js'))
        await fs.writeFile(path.join(apiTarget, 'processManager.js'), processManagerStub)
        await fs.rename(path.join(apiTarget, 'scheduleStore.js'), path.join(apiTarget, 'scheduleStore-runtime.js'))
        await fs.writeFile(path.join(apiTarget, 'scheduleStore.js'), scheduleStoreStub)
        await fs.writeFile(path.join(root, 'preview-validator.mjs'), validatorStub)
        await fs.copyFile(path.join(previewDir, 'mock-run.cjs'), path.join(root, 'mock-run.cjs'))
        await fs.mkdir(path.join(root, 'config'))
        await fs.writeFile(
            path.join(root, 'package.json'),
            JSON.stringify({
                name: 'microsoft-rewards-script-demo',
                version: '0.0.0-demo',
                type: 'module',
                private: true
            })
        )
        const config = {
            sessionPath: 'sessions',
            headless: true,
            clusters: 1,
            errorDiagnostics: false,
            ensureStreakProtection: true,
            debugLogs: true,
            accountDelay: { min: '1sec', max: '2sec' },
            workers: {
                doDailySet: true,
                doDesktopSearch: true,
                doMobileSearch: true,
                doDailyCheckIn: true,
                doReadToEarn: true
            },
            activities: { urlReward: true, searchOnBing: true },
            experimental: { apiSearch: false, apiSearchOnBing: false, edgeBrowsing: false },
            rewardGoal: { name: '100元礼品卡', faceValue: 100, targetPoints: null },
            webhook: {
                pushplus: { enabled: false, token: '' },
                discord: { enabled: false, url: '' },
                ntfy: { enabled: false, url: '', token: '' },
                telegram: { enabled: false, botToken: '', chatId: '' }
            }
        }
        for (const name of ['config.json', 'config.example.json']) {
            await fs.writeFile(path.join(root, name), JSON.stringify(config, null, 2) + '\n')
        }
        const accounts = ['aurora', 'atlas', 'nova']
        await fs.writeFile(
            path.join(root, 'config', 'accounts.env'),
            [
                '# DEMO ONLY. Synthetic accounts; all runs and proxy tests are mocked.',
                ...accounts.flatMap((name, index) => [
                    `ACCOUNT_${index + 1}_EMAIL=${name}@example.invalid`,
                    `ACCOUNT_${index + 1}_PASSWORD=SyntheticDemoOnly2026!`,
                    `ACCOUNT_${index + 1}_GEO_LOCALE=${index === 1 ? 'GB' : 'US'}`,
                    `ACCOUNT_${index + 1}_LANG_CODE=${index === 1 ? 'en-GB' : 'en-US'}`,
                    ...(index === 0
                        ? [
                              `ACCOUNT_1_PROXY_URL=http://proxy.example.invalid`,
                              'ACCOUNT_1_PROXY_PORT=8080',
                              'ACCOUNT_1_PROXY_HTTP=true'
                          ]
                        : [])
                ]),
                ''
            ].join('\n'),
            { mode: 0o600 }
        )
        const now = Date.now()
        const records = Array.from({ length: 14 }, (_, index) => {
            const startedAt = new Date(now - (14 - index) * 86_400_000).toISOString()
            const endedAt = new Date(Date.parse(startedAt) + 120_000).toISOString()
            const entries = accounts.map((name, i) => ({
                email: `${name}@example.invalid`,
                collected: 180 + ((index * 17 + i * 29) % 140),
                balance: 12000 + i * 4000 + index * 250,
                success: true,
                error: null
            }))
            const collected = entries.reduce((sum, account) => sum + account.collected, 0)
            return {
                demo: true,
                startedAt,
                endedAt,
                exit: { code: 0, signal: null, at: endedAt },
                version: '0.0.0-demo',
                collected,
                accounts: entries
            }
        })
        await fs.writeFile(
            path.join(root, 'config', 'points-history.jsonl'),
            records.map(record => JSON.stringify(record)).join('\n') + '\n'
        )
        await fs.writeFile(
            path.join(root, 'config', 'schedule.json'),
            JSON.stringify({ enabled: false, cron: '0 9 * * *', timezone: 'UTC', excludedAccountIndexes: [] })
        )
        // Consumed by the first finite mock only; subsequent UI runs stream slowly.
        await fs.writeFile(path.join(root, '.preview-seed'), 'demo-only\n')
        return { root, env: isolatedEnv(root, port), dispose }
    } catch (error) {
        await dispose()
        throw error
    }
}

export function requestJson(port, token, route, { method = 'GET', body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body)
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path: route,
                method,
                agent: false,
                headers: {
                    Authorization: `Bearer ${token}`,
                    ...(payload === undefined
                        ? {}
                        : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
                }
            },
            res => {
                let text = ''
                res.setEncoding('utf8')
                res.on('data', chunk => {
                    text += chunk
                })
                res.on('error', reject)
                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300)
                        return reject(new Error(`${method} ${route}: HTTP ${res.statusCode} ${text}`))
                    try {
                        resolve(JSON.parse(text))
                    } catch {
                        reject(new Error(`Invalid JSON from ${route}`))
                    }
                })
            }
        )
        req.setTimeout(2500, () => req.destroy(new Error(`Preview request timed out: ${route}`)))
        req.on('error', reject)
        req.end(payload)
    })
}

async function waitUntil(check, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs
    do {
        const value = await check()
        if (value) return value
        await delay(50)
    } while (Date.now() < deadline)
    throw new Error(`Timed out waiting for ${label}.`)
}

export async function launchPreview({
    port = previewPort(),
    output = process.stdout,
    errorOutput = process.stderr
} = {}) {
    const fixture = await createPreviewFixture({ port })
    let child
    let closed
    let exited = false
    let stopping
    let apiReady = null
    let startupError
    let recentOutput = ''
    const handlers = new Map()
    const stop = () =>
        (stopping ??= (async () => {
            try {
                if (child && !exited) {
                    if (apiReady)
                        await requestJson(port, fixture.env.API_TOKEN, '/shutdown', {
                            method: 'POST',
                            body: { force: true }
                        }).catch(() => {})
                    const deadline = delay(4000).then(() => false)
                    if (!(await Promise.race([closed.then(() => true), deadline]))) {
                        child.kill('SIGKILL')
                        await Promise.race([closed, delay(3000)])
                    }
                }
            } finally {
                for (const [signal, handler] of handlers) process.off(signal, handler)
                child?.stdout?.destroy()
                child?.stderr?.destroy()
                await fixture.dispose()
            }
        })())
    for (const signal of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) {
        const handler = () =>
            void stop().catch(error => errorOutput.write(`[preview] Cleanup failed: ${error.message}\n`))
        handlers.set(signal, handler)
        process.on(signal, handler)
    }
    try {
        child = spawn(process.execPath, [path.join(fixture.root, 'scripts', 'api', 'server.js')], {
            cwd: fixture.root,
            env: fixture.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        })
        closed = new Promise(resolve =>
            child.once('close', (code, signal) => {
                exited = true
                resolve({ code, signal })
            })
        )
        child.once('error', error => {
            startupError = error
        })
        let stdoutBuffer = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', chunk => {
            recentOutput = (recentOutput + chunk).slice(-12000)
            output.write(chunk)
            stdoutBuffer += chunk
            let newline
            while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
                const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '')
                stdoutBuffer = stdoutBuffer.slice(newline + 1)
                if (line.startsWith('__API_READY__ ')) {
                    try {
                        apiReady = JSON.parse(line.slice('__API_READY__ '.length))
                    } catch {}
                }
            }
        })
        child.stderr.on('data', chunk => {
            recentOutput = (recentOutput + chunk).slice(-12000)
            errorOutput.write(chunk)
        })
        await waitUntil(
            () => {
                if (startupError) throw startupError
                if (exited) throw new Error(`Preview API exited during startup.\n${recentOutput}`)
                if (stopping) throw new Error('Preview startup was cancelled.')
                return apiReady
            },
            15000,
            'API readiness'
        )
        if (apiReady.host !== '127.0.0.1' || apiReady.port !== port)
            throw new Error('Preview did not bind the expected loopback address.')
        await requestJson(port, fixture.env.API_TOKEN, '/start', { method: 'POST', body: {} })
        await waitUntil(
            async () => {
                if (exited || stopping) throw new Error('Preview exited while seeding the demo snapshot.')
                const status = await requestJson(port, fixture.env.API_TOKEN, '/status')
                if (status.state !== 'idle') return false
                if (!status.run.finished || status.lastExit?.code !== 0)
                    throw new Error('Finite demo seed did not finish successfully.')
                return true
            },
            15000,
            'finite demo seed'
        )
        const info = {
            url: `http://127.0.0.1:${port}/`,
            host: '127.0.0.1',
            port,
            username: DEMO_USERNAME,
            password: DEMO_PASSWORD,
            apiToken: fixture.env.API_TOKEN,
            pid: child.pid,
            launcherPid: process.pid,
            root: fixture.root,
            demo: true,
            seeded: true,
            boundaries:
                'Synthetic accounts/history; finite local mock runs; synthetic proxy tests; demo config writes/reveal enabled; schedules editable and persisted in the temporary fixture only (no host cron, timer or automatic runs); no real bot or external network.'
        }
        output.write(`[preview] DEMO ONLY — isolated local UI. Login: ${DEMO_USERNAME} / ${DEMO_PASSWORD}\n`)
        output.write(
            `[preview] ${info.url} — Ctrl+C or authenticated POST /shutdown stops and removes the temporary fixture.\n`
        )
        output.write(`__PREVIEW_READY__ ${JSON.stringify(info)}\n`)
        // No runtime deadline: the UI stays available until explicitly stopped.
        void closed
            .then(async result => {
                await stop()
                if (result.code && !process.exitCode) process.exitCode = result.code
            })
            .catch(error => {
                errorOutput.write(`[preview] Cleanup failed: ${error.message}\n`)
                process.exitCode = 1
            })
        return { ...info, stop, closed }
    } catch (error) {
        await stop()
        throw error
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    launchPreview().catch(error => {
        process.stderr.write(`[preview] ${error.message}\n`)
        process.exitCode = 1
    })
}
