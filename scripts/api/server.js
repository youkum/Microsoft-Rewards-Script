import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { ProcessManager } from './processManager.js'
import { buildExcludedAccountsEnv, buildSingleAccountEnv, loadAccounts, mergeAccountStats } from './accounts.js'
import {
    validateConfig,
    deepMerge,
    readConfig,
    writeConfigAtomic,
    diffConfig,
    syncMissingDefaults
} from './configEditor.js'
import { readSchedule, writeSchedule } from './scheduleStore.js'
import { deleteStoredSessions, listStoredSessions } from './sessionStore.js'
import { resolveRunCommand } from './runCommand.js'
import {
    addAccount as storeAddAccount,
    deleteAccount as storeDeleteAccount,
    flattenAccountPayload,
    getMergedAccountEnv,
    getSlotSources,
    updateAccount as storeUpdateAccount,
    validateAccountInput
} from './envStore.js'
import { envStrFrom } from '../env.js'
import { appendRunRecord, readPointsHistory } from './pointsHistory.js'
import { testProxy } from './proxyTester.js'
import {
    log,
    parseArgs,
    findUnknownOptions,
    getProjectRoot,
    loadEnvFile,
    loadConfigSafe,
    redactSecrets,
    envStr,
    envBool
} from './lib.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = getProjectRoot(__dirname)

loadEnvFile(projectRoot)

const cliArgs = parseArgs(process.argv.slice(2), { boolean: ['help', 'h'] })

function printHelp() {
    console.log(`
Microsoft Rewards control API

Usage:
  npm run api
  npm run api -- [--host <address>] [--port <number>] [--token <token>]

Options:
  --host        Listen address. Defaults to API_HOST or 127.0.0.1.
  --port        Listen port from 1 to 65535. Defaults to API_PORT or 3010.
  --token       One-time API token. API_TOKEN from .env takes precedence.
  --help        Show this help.

Examples:
  npm run api
  npm run api -- --port 3010
  npm run api -- --host 0.0.0.0 --port 3010 --token "YOUR_API_TOKEN"
`)
}

function failUsage(message) {
    log('ERROR', message)
    printHelp()
    process.exit(1)
}

if (cliArgs.help || cliArgs.h) {
    printHelp()
    process.exit(0)
}

const unknownOptions = findUnknownOptions(cliArgs, ['host', 'port', 'token', 'help', 'h'])
if (unknownOptions.length) {
    failUsage(
        `Unknown option${unknownOptions.length === 1 ? '' : 's'}: ${unknownOptions.map(v => `--${v}`).join(', ')}`
    )
}
if (cliArgs._.length) {
    failUsage(`Unexpected positional argument${cliArgs._.length === 1 ? '' : 's'}: ${cliArgs._.join(' ')}`)
}
for (const option of ['host', 'port', 'token']) {
    if (cliArgs[option] === true || cliArgs[option] === '') {
        failUsage(`--${option} requires a value after it.`)
    }
}

function integerSetting(name, value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (value === undefined) return fallback
    const parsed = Number(value)
    if (typeof value === 'boolean' || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        log('ERROR', `${name} must be an integer between ${min} and ${max}.`)
        process.exit(1)
    }
    return parsed
}

let pkgVersion = '0.0.0'
let pkgName = 'microsoft-rewards-script'
try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    pkgVersion = pkg.version ?? pkgVersion
    pkgName = pkg.name ?? pkgName
} catch {}

const HOST = envStr('API_HOST') ?? (typeof cliArgs.host === 'string' ? cliArgs.host : '127.0.0.1')
const PORT =
    cliArgs.port !== undefined
        ? integerSetting('--port', cliArgs.port, 3010, { max: 65535 })
        : integerSetting('API_PORT', envStr('API_PORT'), 3010, { max: 65535 })
const TOKEN = envStr('API_TOKEN') ?? (typeof cliArgs.token === 'string' ? cliArgs.token : undefined)
const CORS_ORIGIN = envStr('API_CORS_ORIGIN') ?? '*'
const LOG_BUFFER = integerSetting('API_LOG_BUFFER', envStr('API_LOG_BUFFER'), 2000)
const STOP_TIMEOUT_MS = integerSetting('API_STOP_TIMEOUT_MS', envStr('API_STOP_TIMEOUT_MS'), 15000)
const ALLOW_ENV_OVERRIDES = envBool('API_ALLOW_ENV_OVERRIDES', false)
const REVEAL_ENABLED = envBool('API_ALLOW_CONFIG_REVEAL', false)
const ALLOW_CONFIG_WRITE = envBool('API_ALLOW_CONFIG_WRITE', false)
const ALLOW_SCHEDULE_WRITE = envBool('API_ALLOW_SCHEDULE_WRITE', false)

const RUN_HISTORY = integerSetting('API_RUN_HISTORY', envStr('API_RUN_HISTORY'), 20)
const DIAG_DIR = envStr('API_DIAGNOSTICS_DIR') ?? path.join(projectRoot, 'diagnostics')

// ── Embedded WebUI ──────────────────────────────────────────────────────────
const WEB_DIR = path.join(__dirname, 'web')
const DASHBOARD_USERNAME = envStr('DASHBOARD_USERNAME') ?? 'admin'
const DASHBOARD_PASSWORD = envStr('DASHBOARD_PASSWORD')
const SESSION_COOKIE = 'mrs_dashboard'
const SESSION_TTL_MS = integerSetting('API_SESSION_TTL_HOURS', envStr('API_SESSION_TTL_HOURS'), 168, { min: 1 }) * 3_600_000
const ALLOW_ACCOUNT_WRITE = envBool('API_ALLOW_ACCOUNT_WRITE', true)
const PROXY_TEST_TIMEOUT_MS = integerSetting('API_PROXY_TEST_TIMEOUT_MS', envStr('API_PROXY_TEST_TIMEOUT_MS'), 10_000, { min: 1000 })
const STATIC_FILES = new Map([
    ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
    ['/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
    ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml' }]
])

// Session secret: explicit env > API_TOKEN > persisted random value.
function getSessionSecret() {
    const explicit = envStr('DASHBOARD_SESSION_SECRET')
    if (explicit) return explicit
    if (TOKEN) return TOKEN
    const secretFile = path.join(projectRoot, 'config', '.session-secret')
    try {
        const existing = fs.readFileSync(secretFile, 'utf8').trim()
        if (existing) return existing
    } catch {}
    const generated = crypto.randomBytes(32).toString('hex')
    fs.mkdirSync(path.dirname(secretFile), { recursive: true })
    fs.writeFileSync(secretFile, generated + '\n', { encoding: 'utf8', mode: 0o600 })
    return generated
}
const SESSION_SECRET = getSessionSecret()

function sign(payload) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')
}

function createSessionToken(username) {
    const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS })).toString('base64url')
    return `${payload}.${sign(payload)}`
}

function verifySessionToken(token) {
    if (typeof token !== 'string') return null
    const dot = token.indexOf('.')
    if (dot <= 0) return null
    const payload = token.slice(0, dot)
    const expected = sign(payload)
    const provided = token.slice(dot + 1)
    const bufA = Buffer.from(provided)
    const bufB = Buffer.from(expected)
    if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) return null
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        if (typeof data.u !== 'string' || typeof data.exp !== 'number' || data.exp < Date.now()) return null
        return data
    } catch {
        return null
    }
}

function sessionFromReq(req) {
    const header = req.headers['cookie']
    if (typeof header !== 'string') return null
    for (const part of header.split(';')) {
        const eq = part.indexOf('=')
        if (eq === -1) continue
        if (part.slice(0, eq).trim() === SESSION_COOKIE) {
            return verifySessionToken(decodeURIComponent(part.slice(eq + 1).trim()))
        }
    }
    return null
}

function sessionCookieHeader(token, maxAgeSeconds) {
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

// Simple in-memory login throttle: 10 failures per IP per 15 minutes.
const loginAttempts = new Map()
function loginThrottled(ip) {
    const entry = loginAttempts.get(ip)
    if (!entry || entry.resetAt < Date.now()) return false
    return entry.count >= 10
}
function recordLoginFailure(ip) {
    const entry = loginAttempts.get(ip)
    if (!entry || entry.resetAt < Date.now()) {
        loginAttempts.set(ip, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 })
    } else {
        entry.count++
    }
    if (loginAttempts.size > 1000) loginAttempts.clear()
}

// 'token' | 'session' | 'open' — how this request is authorized.
function authVia(req, url) {
    if (TOKEN) {
        const provided = tokenFromReq(req, url)
        if (provided && safeEqual(provided, TOKEN)) return 'token'
    }
    if (sessionFromReq(req)) return 'session'
    if (!TOKEN && !DASHBOARD_PASSWORD) return 'open'
    return null
}

const { command, args } = resolveRunCommand({ projectRoot })

const pm = new ProcessManager({
    command,
    args,
    cwd: projectRoot,
    stopTimeoutMs: STOP_TIMEOUT_MS,
    logBufferSize: LOG_BUFFER,
    historySize: RUN_HISTORY,
    name: pkgName,
    version: pkgVersion
})

const startedAt = Date.now()

function containsControlCharacters(value) {
    return [...value].some(character => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
    })
}

if (containsControlCharacters(HOST) || containsControlCharacters(CORS_ORIGIN)) {
    log('ERROR', 'API_HOST and API_CORS_ORIGIN must not contain control characters.')
    process.exit(1)
}

pm.on('log', entry => {
    const line = (entry.raw ?? entry.message ?? '') + '\n'
    if (entry.source === 'stderr') process.stderr.write(line)
    else process.stdout.write(line)
})

// Persist every finished run to config/points-history.jsonl (WebUI 积分历史).
pm.on('exit', () => {
    try {
        const run = pm.getHistory()[0]
        if (run) appendRunRecord(projectRoot, toHistoryRecord(run))
    } catch (err) {
        log('WARN', 'Could not append points history:', err instanceof Error ? err.message : err)
    }
})

function toHistoryRecord(entry) {
    return {
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        exit: entry.exit,
        version: entry.run?.version ?? null,
        collected: entry.run?.collected ?? 0,
        totals: entry.run?.totals ?? null,
        accounts: (entry.run?.accounts ?? []).map(a => ({
            email: a.email,
            collected: a.collectedPoints ?? a.live?.gained ?? 0,
            balance: a.balance ?? a.live?.balance ?? null,
            success: a.success,
            error: a.error,
            streakProtection: a.streakProtection ?? null,
            edgeBrowsing: a.edgeBrowsing ?? null
        }))
    }
}

// loadAccounts() enriched with the config source of each slot ('env' | 'web').
function accountsView() {
    const sources = getSlotSources(projectRoot)
    return loadAccounts().map(account => {
        const source = sources.get(String(account.index)) ?? 'env'
        return { ...account, source, webManaged: source === 'web' }
    })
}

function applyCors(res) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key, X-Requested-With')
    res.setHeader('Access-Control-Max-Age', '86400')
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
}

function tokenFromReq(req, url) {
    const auth = req.headers['authorization']
    if (typeof auth === 'string') {
        const bearer = /^Bearer\s+(.+)$/i.exec(auth)
        if (bearer) return bearer[1].trim()
    }
    const apiKey = req.headers['x-api-key']
    if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim()
    const q = url.searchParams.get('token')
    if (q && url.pathname.replace(/\/+$/, '') === '/events') return q
    return null
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a))
    const bufB = Buffer.from(String(b))
    if (bufA.length !== bufB.length) return false
    return crypto.timingSafeEqual(bufA, bufB)
}

function serveStatic(res, pathname) {
    const entry = STATIC_FILES.get(pathname)
    const full = path.join(WEB_DIR, entry.file)
    try {
        const body = fs.readFileSync(full)
        res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'no-cache' })
        return res.end(body)
    } catch {
        return sendJson(res, 500, { error: `Embedded WebUI file missing: ${entry.file}`, code: 'WEBUI_MISSING' })
    }
}

async function readJsonBody(req, limitBytes = 1_000_000) {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', chunk => {
            size += chunk.length
            if (size > limitBytes) {
                reject(Object.assign(new Error('Request body too large.'), { code: 'BODY_TOO_LARGE' }))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim()
            if (!raw) return resolve({})
            try {
                resolve(JSON.parse(raw))
            } catch {
                reject(Object.assign(new Error('Invalid JSON body.'), { code: 'BAD_JSON' }))
            }
        })
        req.on('error', reject)
    })
}

async function readJsonObject(req) {
    const body = await readJsonBody(req)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw Object.assign(new Error('Body must be a JSON object.'), { code: 'BAD_REQUEST' })
    }
    return body
}

function readForce(body) {
    if ('force' in body && typeof body.force !== 'boolean') {
        throw Object.assign(new Error('`force` must be a boolean.'), { code: 'BAD_REQUEST' })
    }
    return body.force ?? false
}

function handleEventStream(req, res, url) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()

    const write = frame => {
        if (!res.writableEnded) res.write(frame)
    }
    const sendEvent = (event, data, id) => {
        let frame = ''
        if (id != null) frame += `id: ${id}\n`
        frame += `event: ${event}\n`
        frame += `data: ${JSON.stringify(data)}\n\n`
        write(frame)
    }

    sendEvent('hello', pm.getStatus())

    const lastEventId = Number(req.headers['last-event-id'])
    if (Number.isFinite(lastEventId) && lastEventId > 0) {
        for (const entry of pm.getLogs({ afterId: lastEventId }).logs) {
            sendEvent('log', entry, entry.id)
        }
    } else {
        const replay = Math.max(0, Math.min(Number(url.searchParams.get('replay') ?? 100) || 0, LOG_BUFFER))
        if (replay > 0) {
            for (const entry of pm.getLogs({ limit: replay }).logs) {
                sendEvent('log', entry, entry.id)
            }
        }
    }

    const onLog = entry => sendEvent('log', entry, entry.id)
    const onStatus = status => sendEvent('status', status)
    pm.on('log', onLog)
    pm.on('status', onStatus)

    const keepAlive = setInterval(() => write(': ping\n\n'), 15000)
    if (typeof keepAlive.unref === 'function') keepAlive.unref()

    const cleanup = () => {
        clearInterval(keepAlive)
        pm.off('log', onLog)
        pm.off('status', onStatus)
        if (!res.writableEnded) res.end()
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
}

const requestHandler = async (req, res) => {
    let url
    try {
        url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    } catch {
        applyCors(res)
        return sendJson(res, 400, { error: 'Invalid request URL.', code: 'BAD_REQUEST' })
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'

    applyCors(res)

    if (method === 'OPTIONS') {
        res.writeHead(204)
        return res.end()
    }

    // Embedded WebUI shell is reachable for web clients; JSON API index is preserved for API clients.
    if ((method === 'GET' || method === 'HEAD') && STATIC_FILES.has(pathname)) {
        const accept = String(req.headers['accept'] || '')
        if (pathname === '/' && accept.includes('application/json') && !accept.includes('text/html')) {
            // pass through to JSON API index on /
        } else {
            return serveStatic(res, pathname)
        }
    }

    const isPublicEndpoint =
        pathname === '/health' ||
        (pathname === '/auth/login' && method === 'POST') ||
        (pathname === '/auth/me' && method === 'GET')
    if (!isPublicEndpoint) {
        const via = authVia(req, url)
        if (!via) {
            return sendJson(res, 401, {
                error: 'Unauthorized',
                hint: 'Log in at / with DASHBOARD_USERNAME/DASHBOARD_PASSWORD (session cookie), or provide API_TOKEN via Authorization: Bearer / X-API-Key.'
            })
        }
        // Cookie-authenticated state changes require a custom header (CSRF defense).
        if (via === 'session' && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !req.headers['x-requested-with']) {
            return sendJson(res, 403, { error: 'Missing X-Requested-With header for cookie-authenticated write.', code: 'CSRF' })
        }
    }

    try {
        // index
        if (method === 'GET' && pathname === '/') {
            return sendJson(res, 200, {
                name: pkgName,
                version: pkgVersion,
                message: 'Control API + embedded WebUI (open / in a browser)',
                authRequired: Boolean(TOKEN || DASHBOARD_PASSWORD),
                webui: true,
                endpoints: [
                    'GET /health',
                    'GET /status',
                    'GET /points',
                    'GET /points/history',
                    'GET /logs',
                    'GET /errors',
                    'GET /history',
                    'GET /accounts',
                    'POST /accounts',
                    'PATCH|DELETE /accounts/:index',
                    'POST /accounts/:index/proxy-test',
                    'GET /sessions',
                    'GET /diagnostics',
                    'GET /events',
                    'GET /config',
                    'GET /config/diff',
                    'POST /config/sync',
                    'GET /schedule',
                    'POST /start',
                    'POST /stop',
                    'POST /restart',
                    'POST /shutdown',
                    'DELETE /sessions/:email',
                    'PUT|PATCH /config',
                    'PUT|PATCH /schedule',
                    'POST /auth/login',
                    'POST /auth/logout',
                    'GET /auth/me'
                ]
            })
        }

        // health
        if (method === 'GET' && pathname === '/health') {
            return sendJson(res, 200, {
                ok: true,
                name: pkgName,
                version: pkgVersion,
                state: pm.getStatus().state,
                uptimeSec: Math.round((Date.now() - startedAt) / 1000),
                authRequired: Boolean(TOKEN || DASHBOARD_PASSWORD)
            })
        }

        // ── Embedded WebUI auth ────────────────────────────────────────────
        if (method === 'POST' && pathname === '/auth/login') {
            if (!DASHBOARD_PASSWORD) {
                return sendJson(res, 400, {
                    error: 'Dashboard login is not configured. Set DASHBOARD_PASSWORD (and optionally DASHBOARD_USERNAME) in .env and restart the API.',
                    code: 'AUTH_NOT_CONFIGURED'
                })
            }
            const ip = req.socket.remoteAddress ?? 'unknown'
            if (loginThrottled(ip)) {
                return sendJson(res, 429, { error: '尝试次数过多,请 15 分钟后再试。', code: 'RATE_LIMITED' })
            }
            const body = await readJsonObject(req)
            const username = typeof body.username === 'string' ? body.username : ''
            const password = typeof body.password === 'string' ? body.password : ''
            const userOk = safeEqual(username, DASHBOARD_USERNAME)
            const passOk = safeEqual(password, DASHBOARD_PASSWORD)
            if (!(userOk && passOk)) {
                recordLoginFailure(ip)
                return sendJson(res, 401, { error: '用户名或密码错误。', code: 'BAD_CREDENTIALS' })
            }
            const token = createSessionToken(DASHBOARD_USERNAME)
            res.setHeader('Set-Cookie', sessionCookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)))
            pm.note('info', `Dashboard login for ${DASHBOARD_USERNAME} (${ip}).`)
            return sendJson(res, 200, { ok: true, username: DASHBOARD_USERNAME })
        }

        if (method === 'POST' && pathname === '/auth/logout') {
            res.setHeader('Set-Cookie', sessionCookieHeader('', 0))
            return sendJson(res, 200, { ok: true })
        }

        if (method === 'GET' && pathname === '/auth/me') {
            const via = authVia(req, url)
            return sendJson(res, 200, {
                authenticated: Boolean(via),
                via,
                version: pkgVersion,
                username: via === 'session' || via === 'token' ? (via === 'session' ? sessionFromReq(req)?.u : null) : null,
                dashboardLoginConfigured: Boolean(DASHBOARD_PASSWORD),
                tokenConfigured: Boolean(TOKEN),
                capabilities: {
                    accountWrite: ALLOW_ACCOUNT_WRITE,
                    configWrite: ALLOW_CONFIG_WRITE,
                    scheduleWrite: ALLOW_SCHEDULE_WRITE,
                    envOverrides: ALLOW_ENV_OVERRIDES,
                    revealConfig: REVEAL_ENABLED
                }
            })
        }

        // status
        if (method === 'GET' && pathname === '/status') {
            return sendJson(res, 200, pm.getStatus())
        }

        // point read live
        if (method === 'GET' && pathname === '/points') {
            return sendJson(res, 200, pm.getPoints())
        }

        // persistent points history (survives API restarts; recorded on run exit)
        if (method === 'GET' && pathname === '/points/history') {
            const days = clampInt(url.searchParams.get('days'), 1, 3650, 30)
            const limit = clampInt(url.searchParams.get('limit'), 1, 5000, 500)
            return sendJson(res, 200, readPointsHistory(projectRoot, { days, limit }))
        }

        // log read
        if (method === 'GET' && pathname === '/logs') {
            const limit = clampInt(url.searchParams.get('limit'), 1, LOG_BUFFER, 200)
            const afterId = url.searchParams.has('afterId') ? Number(url.searchParams.get('afterId')) : null
            const minLevel = url.searchParams.get('level') || null
            if (minLevel && !['debug', 'info', 'warn', 'error'].includes(minLevel)) {
                return sendJson(res, 400, {
                    error: '`level` must be one of: debug, info, warn, error.',
                    code: 'BAD_REQUEST'
                })
            }
            return sendJson(
                res,
                200,
                pm.getLogs({ limit, afterId: Number.isFinite(afterId) ? afterId : null, minLevel })
            )
        }

        // error read
        if (method === 'GET' && pathname === '/errors') {
            const limit = clampInt(url.searchParams.get('limit'), 1, LOG_BUFFER, 100)
            const includeWarnings = url.searchParams.get('warnings') !== 'false'
            return sendJson(res, 200, pm.getErrors({ limit, includeWarnings }))
        }

        // history
        if (method === 'GET' && pathname === '/history') {
            const limit = clampInt(url.searchParams.get('limit'), 1, RUN_HISTORY, RUN_HISTORY)
            const runs = pm.getHistory().slice(0, limit).map(toHistoryRecord)
            return sendJson(res, 200, { runs, count: runs.length, inMemoryOnly: true })
        }

        // account overview
        if (method === 'GET' && pathname === '/accounts') {
            const accounts = accountsView().map(account => {
                const { emailKey, ...safe } = mergeAccountStats([account], pm.getHistory().map(toHistoryRecord))[0]
                void emailKey
                return safe
            })
            return sendJson(res, 200, { accounts, count: accounts.length, accountsEnvPath: path.join(projectRoot, 'config', 'accounts.env') })
        }

        // ── Account CRUD (writes config/accounts.env; .env accounts are read-only here) ──
        if (method === 'POST' && pathname === '/accounts') {
            if (!ALLOW_ACCOUNT_WRITE) {
                return sendJson(res, 403, { error: 'Account writes are disabled. Set API_ALLOW_ACCOUNT_WRITE=false to disable / true to enable.' })
            }
            const body = await readJsonObject(req)
            try {
                const fields = validateAccountInput(flattenAccountPayload(body))
                const slot = storeAddAccount(projectRoot, fields)
                pm.note('info', `Account ${fields.email} added as ACCOUNT_${slot} via WebUI.`)
                return sendJson(res, 201, {
                    created: true,
                    slot,
                    account: accountsView().find(account => account.index === slot) ?? null,
                    appliesOnNextRun: true
                })
            } catch (err) {
                if (err.code === 'EMAIL_CONFLICT' || err.code === 'VALIDATION_FAILED') {
                    return sendJson(res, err.code === 'EMAIL_CONFLICT' ? 409 : 422, { error: err.message, code: err.code, errors: err.errors })
                }
                if (err.code === 'BAD_REQUEST') return sendJson(res, 400, { error: err.message, code: err.code })
                return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
            }
        }

        if ((method === 'PATCH' || method === 'PUT') && /^\/accounts\/\d+$/.test(pathname)) {
            if (!ALLOW_ACCOUNT_WRITE) {
                return sendJson(res, 403, { error: 'Account writes are disabled. Set API_ALLOW_ACCOUNT_WRITE=true to enable.' })
            }
            const slot = Number(pathname.split('/')[2])
            const existing = accountsView().find(account => account.index === slot)
            if (!existing) return sendJson(res, 404, { error: `ACCOUNT_${slot} 不存在。`, code: 'ACCOUNT_NOT_FOUND' })
            if (existing.source !== 'web') {
                return sendJson(res, 409, {
                    error: `ACCOUNT_${slot} 来自 .env(基础文件配置),当前 WebUI 仅管理 config/accounts.env。请直接在 .env 中编辑该账号，或在 WebUI 中添加新账号。`,
                    code: 'NOT_WEB_MANAGED'
                })
            }
            const body = await readJsonObject(req)
            try {
                const flat = flattenAccountPayload(body)
                if ('password' in flat && flat.password === '') {
                    // Empty password field on edit = keep existing password.
                    delete flat.password
                }
                storeUpdateAccount(projectRoot, slot, flat)
                pm.note('info', `ACCOUNT_${slot} (${existing.email}) updated via WebUI.`)
                return sendJson(res, 200, {
                    updated: true,
                    slot,
                    account: accountsView().find(account => account.index === slot) ?? null,
                    appliesOnNextRun: true
                })
            } catch (err) {
                if (err.code === 'VALIDATION_FAILED') return sendJson(res, 422, { error: err.message, code: err.code, errors: err.errors })
                if (err.code === 'NOT_WEB_MANAGED' || err.code === 'BAD_REQUEST') return sendJson(res, err.code === 'BAD_REQUEST' ? 400 : 409, { error: err.message, code: err.code })
                return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
            }
        }

        if (method === 'DELETE' && /^\/accounts\/\d+$/.test(pathname)) {
            if (!ALLOW_ACCOUNT_WRITE) {
                return sendJson(res, 403, { error: 'Account writes are disabled. Set API_ALLOW_ACCOUNT_WRITE=true to enable.' })
            }
            const slot = Number(pathname.split('/')[2])
            const existing = accountsView().find(account => account.index === slot)
            if (!existing) return sendJson(res, 404, { error: `ACCOUNT_${slot} 不存在。`, code: 'ACCOUNT_NOT_FOUND' })
            if (existing.source !== 'web') {
                return sendJson(res, 409, {
                    error: `ACCOUNT_${slot} 来自 .env(手工配置),请在 .env 中删除,WebUI 仅管理 config/accounts.env。`,
                    code: 'NOT_WEB_MANAGED'
                })
            }
            try {
                const removed = storeDeleteAccount(projectRoot, slot)
                pm.note('info', `ACCOUNT_${slot} (${existing.email}) removed via WebUI (${removed} env line(s)).`)
                return sendJson(res, 200, { deleted: true, slot, removed, appliesOnNextRun: true })
            } catch (err) {
                if (err.code === 'NOT_WEB_MANAGED') return sendJson(res, 409, { error: err.message, code: err.code })
                return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
            }
        }

        // Proxy connectivity test for one account (uses the account's proxy settings).
        if (method === 'POST' && /^\/accounts\/\d+\/proxy-test$/.test(pathname)) {
            const slot = Number(pathname.split('/')[2])
            const account = accountsView().find(item => item.index === slot)
            if (!account) return sendJson(res, 404, { error: `ACCOUNT_${slot} 不存在。`, code: 'ACCOUNT_NOT_FOUND' })
            if (!account.proxy?.url) {
                return sendJson(res, 400, { error: `ACCOUNT_${slot} 未配置代理。`, code: 'NO_PROXY' })
            }
            const merged = getMergedAccountEnv(projectRoot)
            const result = await testProxy({
                url: account.proxy.url,
                port: account.proxy.port ?? undefined,
                username: envStrFrom(merged, `ACCOUNT_${slot}_PROXY_USERNAME`),
                password: envStrFrom(merged, `ACCOUNT_${slot}_PROXY_PASSWORD`),
                timeoutMs: PROXY_TEST_TIMEOUT_MS
            })
            pm.note(result.ok ? 'info' : 'warn', `Proxy test for ACCOUNT_${slot}: ${result.ok ? `exit ${result.ip} (${result.latencyMs}ms)` : result.error}`)
            return sendJson(res, 200, { slot, email: account.email, ...result })
        }

        // session list
        if (method === 'GET' && pathname === '/sessions') {
            const loaded = loadConfigSafe(projectRoot)
            if (!loaded) return sendJson(res, 404, { error: 'config.json not found' })
            if (loaded.data == null)
                return sendJson(res, 500, { error: 'config.json is invalid', detail: loaded.error })

            const sessionPath = typeof loaded.data.sessionPath === 'string' ? loaded.data.sessionPath : 'sessions'
            return sendJson(res, 200, listStoredSessions(projectRoot, sessionPath))
        }

        // account-specific session delete; intentionally no delete-all route
        if (method === 'DELETE' && pathname === '/sessions') {
            return sendJson(res, 400, {
                error: 'An account email is required. Use DELETE /sessions/:email.',
                code: 'EMAIL_REQUIRED'
            })
        }

        if (method === 'DELETE' && pathname.startsWith('/sessions/')) {
            if (pm.getStatus().state !== 'idle') {
                return sendJson(res, 409, {
                    error: 'Cannot delete sessions while a bot run is active. Stop the run first.',
                    code: 'RUN_ACTIVE'
                })
            }

            let email
            try {
                email = decodeURIComponent(pathname.slice('/sessions/'.length)).trim()
            } catch {
                return sendJson(res, 400, { error: 'The session email path is not valid URL encoding.' })
            }
            if (!email || email.length > 320 || !email.includes('@') || containsControlCharacters(email)) {
                return sendJson(res, 400, {
                    error: 'A valid account email is required in DELETE /sessions/:email.',
                    code: 'INVALID_EMAIL'
                })
            }

            const loaded = loadConfigSafe(projectRoot)
            if (!loaded) return sendJson(res, 404, { error: 'config.json not found' })
            if (loaded.data == null)
                return sendJson(res, 500, { error: 'config.json is invalid', detail: loaded.error })

            const sessionPath = typeof loaded.data.sessionPath === 'string' ? loaded.data.sessionPath : 'sessions'
            const result = deleteStoredSessions(projectRoot, sessionPath, email)
            if (!result.found) {
                return sendJson(res, 404, {
                    error: `No stored sessions found for ${email}.`,
                    code: 'SESSION_NOT_FOUND'
                })
            }

            pm.note('info', `Deleted ${result.removed} stored session row(s) for ${result.email} via API.`)
            return sendJson(res, 200, { deleted: true, ...result })
        }

        // diag list
        if (method === 'GET' && pathname === '/diagnostics') {
            return sendJson(res, 200, listDiagnostics())
        }

        // diag read
        if (method === 'GET' && pathname.startsWith('/diagnostics/')) {
            return serveDiagnosticFile(res, pathname)
        }

        // conf read
        if (method === 'GET' && pathname === '/config') {
            const loaded = loadConfigSafe(projectRoot)
            if (!loaded) return sendJson(res, 404, { error: 'config.json not found' })
            if (loaded.data == null)
                return sendJson(res, 500, { error: 'config.json is invalid', detail: loaded.error })
            const reveal = REVEAL_ENABLED && Boolean(TOKEN) && url.searchParams.get('reveal') === '1'
            const data = reveal ? loaded.data : redactSecrets(loaded.data)
            return sendJson(res, 200, { path: loaded.path, redacted: !reveal, config: data })
        }

        if (method === 'GET' && pathname === '/config/diff') {
            try {
                const { addedKeys } = await diffConfig(projectRoot, {
                    validatorModule: envStr('API_VALIDATOR_MODULE')
                })
                return sendJson(res, 200, { addedKeys, upToDate: addedKeys.length === 0 })
            } catch (err) {
                return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
            }
        }

        if (method === 'POST' && pathname === '/config/sync') {
            if (!ALLOW_CONFIG_WRITE) {
                return sendJson(res, 403, {
                    error: 'Config writes are disabled. Set API_ALLOW_CONFIG_WRITE=true to enable.'
                })
            }
            try {
                const result = await syncMissingDefaults(projectRoot, {
                    validatorModule: envStr('API_VALIDATOR_MODULE')
                })
                if (result.patched) {
                    pm.note(
                        'info',
                        `config.json patched with ${result.addedKeys.length} missing key(s) via API /config/sync.`
                    )
                }
                return sendJson(res, 200, { ...result, appliesOnNextRun: true })
            } catch (err) {
                return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
            }
        }

        // sched read
        if (method === 'GET' && pathname === '/schedule') {
            try {
                return sendJson(res, 200, { ...readSchedule(projectRoot), writable: ALLOW_SCHEDULE_WRITE })
            } catch (err) {
                return sendJson(res, 500, { error: err.message, code: err.code })
            }
        }

        // sched write
        if ((method === 'PUT' || method === 'PATCH') && pathname === '/schedule') {
            if (!ALLOW_SCHEDULE_WRITE) {
                return sendJson(res, 403, {
                    error: 'Schedule writes are disabled. Set API_ALLOW_SCHEDULE_WRITE=true to enable.'
                })
            }
            const body = await readJsonBody(req)
            if (typeof body !== 'object' || body === null || Array.isArray(body)) {
                return sendJson(res, 400, { error: 'Body must be a JSON object.' })
            }
            try {
                const updated = writeSchedule(projectRoot, body)
                pm.note(
                    'info',
                    `Schedule updated via API (${method}): ${updated.enabled ? `${updated.cron} (TZ ${updated.timezone})` : 'disabled'}.`
                )
                return sendJson(res, 200, { ...updated, writable: true })
            } catch (err) {
                const status = err.code === 'BAD_REQUEST' ? 400 : 500
                return sendJson(res, status, { error: err.message, code: err.code })
            }
        }

        // sse
        if (method === 'GET' && pathname === '/events') {
            return handleEventStream(req, res, url)
        }

        // start
        if (method === 'POST' && pathname === '/start') {
            const body = await readJsonObject(req)
            const overrides = {}
            let selectedAccount = null
            let excludedAccounts = []
            if (body.args != null) overrides.args = body.args
            if (body.env != null) {
                if (!ALLOW_ENV_OVERRIDES) {
                    return sendJson(res, 403, {
                        error: 'Per-request env overrides are disabled. Set API_ALLOW_ENV_OVERRIDES=true to enable.'
                    })
                }
                overrides.env = body.env
            }
            try {
                if (body.accountIndex != null && body.excludedAccountIndexes != null) {
                    return sendJson(res, 400, {
                        error: '`accountIndex` and `excludedAccountIndexes` cannot be used together.',
                        code: 'BAD_REQUEST'
                    })
                }
                if (body.accountIndex != null) {
                    const selection = buildSingleAccountEnv(body.accountIndex)
                    overrides.env = { ...(overrides.env || {}), ...selection.env }
                    selectedAccount = selection.account
                } else if (body.excludedAccountIndexes != null) {
                    const selection = buildExcludedAccountsEnv(body.excludedAccountIndexes)
                    overrides.env = { ...(overrides.env || {}), ...selection.env }
                    excludedAccounts = selection.excludedAccounts
                }
                const info = pm.start(overrides)
                return sendJson(res, 202, { started: true, selectedAccount, excludedAccounts, ...info })
            } catch (err) {
                if (err.code === 'ALREADY_RUNNING') return sendJson(res, 409, { error: err.message, code: err.code })
                if (err.code === 'BAD_REQUEST') return sendJson(res, 400, { error: err.message, code: err.code })
                return sendJson(res, 500, { error: err.message })
            }
        }

        // kill proc
        if (method === 'POST' && pathname === '/stop') {
            const body = await readJsonObject(req)
            const force = readForce(body)
            try {
                const stopping = pm.stop({ force })
                stopping.catch(() => {})
                return sendJson(res, 202, { stopping: true, force })
            } catch (err) {
                if (err.code === 'NOT_RUNNING') return sendJson(res, 409, { error: err.message, code: err.code })
                return sendJson(res, 500, { error: err.message })
            }
        }

        // restart
        if (method === 'POST' && pathname === '/restart') {
            const body = await readJsonObject(req)
            const overrides = { force: readForce(body) }
            let selectedAccount = null
            let excludedAccounts = []
            if (body.args != null) overrides.args = body.args
            if (body.env != null) {
                if (!ALLOW_ENV_OVERRIDES) {
                    return sendJson(res, 403, {
                        error: 'Per-request env overrides are disabled. Set API_ALLOW_ENV_OVERRIDES=true to enable.'
                    })
                }
                overrides.env = body.env
            }
            try {
                if (body.accountIndex != null && body.excludedAccountIndexes != null) {
                    return sendJson(res, 400, {
                        error: '`accountIndex` and `excludedAccountIndexes` cannot be used together.',
                        code: 'BAD_REQUEST'
                    })
                }
                if (body.accountIndex != null) {
                    const selection = buildSingleAccountEnv(body.accountIndex)
                    overrides.env = { ...(overrides.env || {}), ...selection.env }
                    selectedAccount = selection.account
                } else if (body.excludedAccountIndexes != null) {
                    const selection = buildExcludedAccountsEnv(body.excludedAccountIndexes)
                    overrides.env = { ...(overrides.env || {}), ...selection.env }
                    excludedAccounts = selection.excludedAccounts
                }
                const info = await pm.restart(overrides)
                return sendJson(res, 202, { restarted: true, selectedAccount, excludedAccounts, ...info })
            } catch (err) {
                if (err.code === 'BAD_REQUEST') return sendJson(res, 400, { error: err.message, code: err.code })
                return sendJson(res, 500, { error: err.message })
            }
        }

        // conf
        if ((method === 'PUT' || method === 'PATCH') && pathname === '/config') {
            if (!ALLOW_CONFIG_WRITE) {
                return sendJson(res, 403, {
                    error: 'Config writes are disabled. Set API_ALLOW_CONFIG_WRITE=true to enable.'
                })
            }
            const body = await readJsonBody(req)
            if (typeof body !== 'object' || body === null || Array.isArray(body)) {
                return sendJson(res, 400, { error: 'Body must be a JSON object.' })
            }
            let candidate
            try {
                candidate = method === 'PATCH' ? deepMerge(readConfig(projectRoot).data, body) : body
            } catch (err) {
                return sendJson(res, err.code === 'BAD_REQUEST' ? 400 : 500, {
                    error: `Could not prepare config update: ${err instanceof Error ? err.message : err}`
                })
            }
            const result = await validateConfig(candidate, {
                projectRoot,
                validatorModule: envStr('API_VALIDATOR_MODULE')
            })
            if (!result.ok) {
                return sendJson(res, 422, { error: 'Config validation failed', via: result.via, errors: result.errors })
            }
            try {
                const written = writeConfigAtomic(projectRoot, result.value ?? candidate)
                pm.note('info', `config.json updated via API (${method}); applies on the next run.`)
                return sendJson(res, 200, { ok: true, path: written, via: result.via, appliesOnNextRun: true })
            } catch (err) {
                return sendJson(res, 500, {
                    error: `Could not write config: ${err instanceof Error ? err.message : err}`
                })
            }
        }

        // stop api
        if (method === 'POST' && pathname === '/shutdown') {
            const body = await readJsonObject(req)
            const force = readForce(body)
            sendJson(res, 202, { shuttingDown: true, stoppingBot: pm.getStatus().state !== 'idle' })
            setTimeout(() => void shutdown('API /shutdown', { force }), 50)
            return
        }

        return sendJson(res, 404, { error: 'Not found', path: pathname })
    } catch (err) {
        if (err && (err.code === 'BAD_JSON' || err.code === 'BODY_TOO_LARGE' || err.code === 'BAD_REQUEST')) {
            return sendJson(res, 400, { error: err.message, code: err.code })
        }
        log('ERROR', 'Unhandled request error:', err instanceof Error ? err.stack : err)
        if (!res.headersSent) return sendJson(res, 500, { error: 'Internal server error' })
    }
}

function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10)
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, n))
}

// diagn
const DIAG_FILES = {
    'screenshot.png': 'image/png',
    'error.txt': 'text/plain; charset=utf-8',
    'dump.html': 'application/octet-stream'
}

function listDiagnostics() {
    let dirents
    try {
        dirents = fs
            .readdirSync(DIAG_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory() && d.name.startsWith('error-'))
    } catch {
        return { dir: DIAG_DIR, count: 0, entries: [] }
    }
    const entries = dirents
        .map(d => {
            const full = path.join(DIAG_DIR, d.name)
            let files = []
            let createdAt = null
            let error = null
            try {
                files = fs.readdirSync(full)
            } catch {}
            try {
                createdAt = fs.statSync(full).mtime.toISOString()
            } catch {}
            if (files.includes('error.txt')) {
                try {
                    error = fs.readFileSync(path.join(full, 'error.txt'), 'utf8').slice(0, 2000)
                } catch {}
            }
            return {
                name: d.name,
                createdAt,
                hasScreenshot: files.includes('screenshot.png'),
                hasHtml: files.includes('dump.html'),
                hasError: files.includes('error.txt'),
                error
            }
        })
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    return { dir: DIAG_DIR, count: entries.length, entries }
}

function serveDiagnosticFile(res, pathname) {
    let parts
    try {
        parts = pathname.slice('/diagnostics/'.length).split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
        return sendJson(res, 400, { error: 'Invalid diagnostics path encoding' })
    }
    if (parts.length !== 2) return sendJson(res, 404, { error: 'Not found' })
    const [name, file] = parts
    if (!/^error-[A-Za-z0-9._:-]+$/.test(name) || !(file in DIAG_FILES)) {
        return sendJson(res, 400, { error: 'Invalid diagnostics path' })
    }
    const full = path.join(DIAG_DIR, name, file)
    if (!path.resolve(full).startsWith(path.resolve(DIAG_DIR) + path.sep)) {
        return sendJson(res, 400, { error: 'Invalid diagnostics path' })
    }
    if (!fs.existsSync(full)) return sendJson(res, 404, { error: 'Not found' })
    const headers = { 'Content-Type': DIAG_FILES[file] }
    if (file === 'dump.html') headers['Content-Disposition'] = `attachment; filename="${name}-dump.html"`
    res.writeHead(200, headers)
    fs.createReadStream(full).pipe(res)
}

// startup
const server = http.createServer(requestHandler)

server.on('error', err => {
    if (err && err.code === 'EADDRINUSE') {
        log('ERROR', `Port ${PORT} is already in use on ${HOST}. Set API_PORT to a free port.`)
        process.exit(1)
    }
    log('ERROR', 'Server error:', err instanceof Error ? err.message : err)
    process.exit(1)
})

server.listen(PORT, HOST, () => {
    log('INFO', `${pkgName} control API listening on http://${HOST}:${PORT} (WebUI: http://${HOST === '0.0.0.0' ? '<server-ip>' : HOST}:${PORT}/)`)
    log('INFO', `Launch command: ${command} ${args.join(' ')}`.trim())
    log(
        'INFO',
        `Auth: ${TOKEN ? 'API token' : 'no'}${DASHBOARD_PASSWORD ? ' + dashboard login' : ''}${!TOKEN && !DASHBOARD_PASSWORD ? ' DISABLED (no API_TOKEN / DASHBOARD_PASSWORD set)' : ''} | CORS origin: ${CORS_ORIGIN}`
    )
    log(
        'INFO',
        `Runtime state: points history persisted | config writes: ${ALLOW_CONFIG_WRITE ? 'on' : 'off'} | schedule writes: ${ALLOW_SCHEDULE_WRITE ? 'on' : 'off'} | account writes: ${ALLOW_ACCOUNT_WRITE ? 'on' : 'off'} | session deletion: account-scoped`
    )
    if (!TOKEN && !DASHBOARD_PASSWORD) {
        const loopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1'
        log(
            loopback ? 'WARN' : 'ERROR',
            loopback
                ? 'No API_TOKEN and no DASHBOARD_PASSWORD set - the API/WebUI is open to anything on this machine. Set DASHBOARD_PASSWORD in .env to protect it.'
                : 'API/WebUI is bound to a non-loopback address WITHOUT credentials - anyone who can reach this port can start/stop the bot, edit accounts and read your logs. Set DASHBOARD_PASSWORD or API_TOKEN.'
        )
    }

    const ready = {
        host: HOST,
        port: PORT,
        pid: process.pid,
        name: pkgName,
        version: pkgVersion,
        auth: Boolean(TOKEN || DASHBOARD_PASSWORD),
        webui: true
    }
    process.stdout.write(`__API_READY__ ${JSON.stringify(ready)}\n`)
})

let shuttingDown = false
async function shutdown(signal, { force = false } = {}) {
    if (shuttingDown) return
    shuttingDown = true
    log('INFO', `${signal} received - shutting down.`)
    server.close()
    try {
        if (pm.getStatus().state !== 'idle') {
            log('INFO', `Stopping active bot run${force ? ' (force)' : ''}…`)
            await pm.stop({ force })
        }
    } catch {
        // ignore
    }
    process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
