// .env / config/accounts.env management for the control API WebUI.
//
// Two account sources are merged with block-level precedence:
//   .env (manual/base)  ->  config/accounts.env (WebUI-managed) overrides
// A slot (ACCOUNT_<N>_*) present in accounts.env fully replaces the same slot
// from .env, so fields never get mixed between sources.
//
// Writes from the WebUI only ever touch config/accounts.env; .env stays
// hand-edited. All writes are atomic (tmp file + rename) with a one-time
// .bak backup, and preserve unrelated lines/comments byte-for-byte.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseEnvContent, quoteEnvValue } from '../env.js'

// Mirrors BROWSER_PROXY_PROTOCOLS in src/util/Proxy.ts (scripts/ cannot import TS).
export const BROWSER_PROXY_PROTOCOLS = ['http:', 'https:', 'socks4:', 'socks5:']

const ACCOUNT_KEY_RE = /^ACCOUNT_(\d+)_([A-Z0-9_]+)$/

// ---------------------------------------------------------------------------
// Parsing / serialization (format-compatible with lib.js loadEnvFile / Load.ts)
// ---------------------------------------------------------------------------

function serializePairs(pairs, header) {
    const lines = header ? [header, ''] : []
    let lastSlot = null
    for (const { key, value } of pairs) {
        const slot = ACCOUNT_KEY_RE.exec(key)?.[1] ?? null
        if (slot !== lastSlot) {
            if (slot) lines.push(`# Account ${slot}`)
            lastSlot = slot
        }
        lines.push(`${key}=${quoteEnvValue(value)}`)
    }
    return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// File IO (atomic write + one-time backup)
// ---------------------------------------------------------------------------

export function readEnvFile(filePath) {
    try {
        return parseEnvContent(fs.readFileSync(filePath, 'utf-8'))
    } catch (err) {
        if (err && err.code === 'ENOENT') return null
        throw err
    }
}

function writeEnvFileAtomic(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    const backup = `${filePath}.bak`
    for (const target of [filePath, backup]) {
        try {
            if (!fs.lstatSync(target).isFile()) throw new Error('Credential target must be a regular file.')
            fs.chmodSync(target, 0o600)
        } catch (err) {
            if (err.code !== 'ENOENT') throw err
        }
    }
    if (fs.existsSync(filePath) && !fs.existsSync(backup)) {
        // Create with restrictive permissions before copying any secret bytes.
        const fd = fs.openSync(backup, 'wx', 0o600)
        try {
            fs.writeFileSync(fd, fs.readFileSync(filePath))
        } finally {
            fs.closeSync(fd)
        }
    }
    const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(12).toString('hex')}`
    try {
        fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
        fs.renameSync(tmp, filePath)
    } finally {
        fs.rmSync(tmp, { force: true })
    }
}

// ---------------------------------------------------------------------------
// Merged account env (.env -> config/accounts.env block-level override)
// ---------------------------------------------------------------------------

// .env lookup anchored to projectRoot first, then the current working directory
// (identical in every real deployment where cwd === projectRoot, and keeps
// tests isolated from the developer's own .env).
function findEnvFile(projectRoot) {
    const candidates = [
        path.join(projectRoot, '.env'),
        path.join(projectRoot, 'dist', '.env'),
        path.join(process.cwd(), '.env')
    ]
    return candidates.find(p => fs.existsSync(p)) ?? null
}

export function accountsEnvFilePath(projectRoot) {
    return path.join(projectRoot, 'config', 'accounts.env')
}

// Returns [{key, value, source: 'env'|'web'}] for every ACCOUNT_* definition,
// with accounts.env slots fully replacing matching .env slots.
export function loadAccountPairs(projectRoot) {
    const base = []
    const envFile = findEnvFile(projectRoot)
    if (envFile) {
        for (const pair of readEnvFile(envFile) ?? []) {
            if (ACCOUNT_KEY_RE.test(pair.key)) base.push({ ...pair, source: 'env' })
        }
    }

    const webFile = accountsEnvFilePath(projectRoot)
    const webPairs = (readEnvFile(webFile) ?? []).filter(pair => ACCOUNT_KEY_RE.test(pair.key))
    const webSlots = new Set(webPairs.map(pair => ACCOUNT_KEY_RE.exec(pair.key)[1]))

    const merged = base.filter(pair => !webSlots.has(ACCOUNT_KEY_RE.exec(pair.key)[1]))
    for (const pair of webPairs) merged.push({ ...pair, source: 'web' })
    return merged
}

// Merged ACCOUNT_* env object, ready to be used as `sourceEnv` by accounts.js.
export function getMergedAccountEnv(projectRoot, baseEnv = process.env) {
    const env = {}
    for (const [key, value] of Object.entries(baseEnv)) {
        if (ACCOUNT_KEY_RE.test(key)) env[key] = value
    }
    const pairs = loadAccountPairs(projectRoot)
    const webSlots = new Set(pairs.filter(pair => pair.source === 'web').map(pair => ACCOUNT_KEY_RE.exec(pair.key)[1]))
    for (const key of Object.keys(env)) {
        if (webSlots.has(ACCOUNT_KEY_RE.exec(key)[1])) delete env[key]
    }
    for (const { key, value } of pairs) env[key] = value
    return env
}

// Slot numbers that have an EMAIL in the file-based sources, mapped to 'env'|'web'.
// Slots that exist only in the process environment (e.g. Docker env_file) are not
// listed here; callers treat missing entries as 'env'.
export function getSlotSources(projectRoot) {
    const sources = new Map()
    for (const { key, source } of loadAccountPairs(projectRoot)) {
        if (!key.endsWith('_EMAIL')) continue
        const slot = ACCOUNT_KEY_RE.exec(key)?.[1]
        if (slot && !sources.has(slot)) sources.set(slot, source)
    }
    return sources
}

// Lowest positive slot number not yet used by any account in the merged view.
export function findFreeSlot(projectRoot, baseEnv = process.env) {
    const used = new Set()
    for (const key of Object.keys(baseEnv)) {
        const match = ACCOUNT_KEY_RE.exec(key)
        if (match && String(baseEnv[key] ?? '').trim()) used.add(match[1])
    }
    for (const { key, value } of loadAccountPairs(projectRoot)) {
        const match = ACCOUNT_KEY_RE.exec(key)
        if (match && value.trim()) used.add(match[1])
    }
    let slot = 1
    while (used.has(String(slot))) slot++
    return slot
}

// ---------------------------------------------------------------------------
// Account field mapping
// ---------------------------------------------------------------------------

const FIELD_TO_KEY = {
    email: 'EMAIL',
    password: 'PASSWORD',
    totpSecret: 'TOTP_SECRET',
    recoveryEmail: 'RECOVERY_EMAIL',
    langCode: 'LANG_CODE',
    geoLocale: 'GEO_LOCALE',
    proxyHttp: 'PROXY_HTTP',
    proxyUrl: 'PROXY_URL',
    proxyPort: 'PROXY_PORT',
    proxyUsername: 'PROXY_USERNAME',
    proxyPassword: 'PROXY_PASSWORD',
    saveFingerprintMobile: 'SAVE_FINGERPRINT_MOBILE',
    saveFingerprintDesktop: 'SAVE_FINGERPRINT_DESKTOP'
}

function accountFieldsToPairs(slot, fields) {
    const pairs = []
    // Proxy is stored as a block: an account without a proxy gets no proxy keys.
    const hasProxy = Boolean(fields.proxyUrl && fields.proxyUrl.trim())
    for (const [field, suffix] of Object.entries(FIELD_TO_KEY)) {
        if (field.startsWith('proxy') && !hasProxy) continue
        let value = fields[field]
        if (value === undefined) continue
        if (value === null) continue
        if (typeof value === 'boolean') value = value ? 'true' : 'false'
        value = ['password', 'proxyPassword'].includes(field) ? String(value) : String(value).trim()
        if (value === '') continue
        pairs.push({ key: `ACCOUNT_${slot}_${suffix}`, value })
    }
    return pairs
}

function writeAccountPairs(projectRoot, mutate) {
    const filePath = accountsEnvFilePath(projectRoot)
    const existing = readEnvFile(filePath) ?? []
    const others = existing.filter(pair => !ACCOUNT_KEY_RE.test(pair.key)) // future-proof: keep non-account lines
    const next = mutate(existing.filter(pair => ACCOUNT_KEY_RE.test(pair.key)))
    writeEnvFileAtomic(filePath, serializePairs([...next, ...others]))
    return filePath
}

// Add a new account in the lowest free slot. Returns the slot used.
export function addAccount(projectRoot, fields, baseEnv = process.env) {
    fields = validateAccountInput(fields)
    const email = fields.email.trim().toLowerCase()
    const merged = getMergedAccountEnv(projectRoot, baseEnv)
    for (const [key, value] of Object.entries(merged)) {
        if (key.endsWith('_EMAIL') && String(value).trim().toLowerCase() === email) {
            const err = new Error(`该邮箱已存在(账号槽位 ACCOUNT_${ACCOUNT_KEY_RE.exec(key)[1]})。`)
            err.code = 'EMAIL_CONFLICT'
            throw err
        }
    }
    const slot = findFreeSlot(projectRoot, baseEnv)
    const pairs = accountFieldsToPairs(slot, fields)
    if (!pairs.length) {
        const err = new Error('没有可写入的账号字段。')
        err.code = 'BAD_REQUEST'
        throw err
    }
    writeAccountPairs(projectRoot, current => [...current, ...pairs])
    return slot
}

// Replace every field of an existing WebUI-managed slot. Fields not present
// in `fields` are preserved from the current merged env; empty strings clear.
export function updateAccount(projectRoot, slot, fields, baseEnv = process.env, clearFields = []) {
    const prefix = `ACCOUNT_${slot}_`
    writeAccountPairs(projectRoot, current => {
        if (!current.some(pair => pair.key === `${prefix}EMAIL`)) {
            const err = new Error(`ACCOUNT_${slot} 不在 Web 管理的账号文件中,无法编辑。`)
            err.code = 'NOT_WEB_MANAGED'
            throw err
        }
        const merged = getMergedAccountEnv(projectRoot, baseEnv)
        const currentFields = fieldsFromEnv(merged, slot)
        const full = validateAccountInput(mergeAccountUpdate(currentFields, fields, clearFields))
        const email = String(full.email ?? '')
            .trim()
            .toLowerCase()
        if (!email) {
            const err = new Error('email 字段不能为空。')
            err.code = 'BAD_REQUEST'
            throw err
        }
        for (const [key, value] of Object.entries(merged)) {
            const match = ACCOUNT_KEY_RE.exec(key)
            if (
                key.endsWith('_EMAIL') &&
                match &&
                match[1] !== String(slot) &&
                String(value).trim().toLowerCase() === email
            ) {
                const err = new Error(`该邮箱已存在于账号槽位 ACCOUNT_${match[1]}。`)
                err.code = 'EMAIL_CONFLICT'
                throw err
            }
        }
        const replaced = accountFieldsToPairs(slot, full)
        return [...current.filter(pair => !pair.key.startsWith(prefix)), ...replaced]
    })
    return `ACCOUNT_${slot}`
}

export function deleteAccount(projectRoot, slot) {
    const prefix = `ACCOUNT_${slot}_`
    let removed = 0
    writeAccountPairs(projectRoot, current => {
        const remaining = current.filter(pair => !pair.key.startsWith(prefix))
        removed = current.length - remaining.length
        if (!removed) {
            const err = new Error(`ACCOUNT_${slot} 不在 Web 管理的账号文件中,无法删除。`)
            err.code = 'NOT_WEB_MANAGED'
            throw err
        }
        return remaining
    })
    return removed
}

// ---------------------------------------------------------------------------
// Validation (used by the /accounts write endpoints)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const BASE32_RE = /^[A-Z2-7]+=*$/

function boolString(value) {
    if (value === true || value === 'true' || value === 1 || value === '1') return 'true'
    if (value === false || value === 'false' || value === 0 || value === '0') return 'false'
    return undefined
}

// Reads the flat account field set of a slot from a merged env object.
export function fieldsFromEnv(sourceEnv, slot) {
    const fields = {}
    for (const [field, suffix] of Object.entries(FIELD_TO_KEY)) {
        const value = sourceEnv[`ACCOUNT_${slot}_${suffix}`]
        if (value !== undefined && String(value) !== '') {
            fields[field] = ['password', 'proxyPassword'].includes(field) ? String(value) : String(value).trim()
        }
    }
    return fields
}

// Flattens the WebUI JSON payload (nested proxy/saveFingerprint) into the
// flat field shape used for validation and storage.
function badRequest(message) {
    return Object.assign(new Error(message), { code: 'BAD_REQUEST' })
}

export function flattenAccountPayload(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw badRequest('账号数据必须是 JSON 对象。')
    }
    const flat = {}
    function text(source, key, name = key) {
        if (source[key] === undefined) return
        if (source[key] !== null && typeof source[key] !== 'string') throw badRequest(`${name} must be a string.`)
        flat[name] = source[key] ?? ''
    }
    for (const key of ['email', 'password', 'totpSecret', 'recoveryEmail', 'langCode', 'geoLocale']) text(input, key)
    for (const key of ['proxy', 'saveFingerprint']) {
        if (
            input[key] !== undefined &&
            (input[key] === null || typeof input[key] !== 'object' || Array.isArray(input[key]))
        ) {
            throw badRequest(`${key} must be an object.`)
        }
    }
    const proxy = input.proxy ?? {}
    for (const [key, name] of [
        ['url', 'proxyUrl'],
        ['username', 'proxyUsername'],
        ['password', 'proxyPassword']
    ]) {
        text(proxy, key, name)
    }
    if (proxy.port !== undefined) {
        if (proxy.port !== null && !['string', 'number'].includes(typeof proxy.port))
            throw badRequest('proxy.port must be a number or string.')
        flat.proxyPort = proxy.port ?? ''
    }
    function boolean(source, key, name) {
        if (source[key] === undefined) return
        const value = boolString(source[key])
        if (value === undefined) throw badRequest(`${name} must be a boolean.`)
        flat[name] = value
    }
    boolean(proxy, 'http', 'proxyHttp')
    const fingerprint = input.saveFingerprint ?? {}
    boolean(fingerprint, 'mobile', 'saveFingerprintMobile')
    boolean(fingerprint, 'desktop', 'saveFingerprintDesktop')
    return flat
}

const CLEAR_FIELDS = {
    password: ['password'],
    totpSecret: ['totpSecret'],
    recoveryEmail: ['recoveryEmail'],
    proxy: ['proxyUrl', 'proxyPort', 'proxyHttp', 'proxyUsername', 'proxyPassword'],
    'proxy.username': ['proxyUsername'],
    'proxy.password': ['proxyPassword']
}

export function mergeAccountUpdate(current, fields, clearFields = []) {
    if (
        !Array.isArray(clearFields) ||
        clearFields.some(key => typeof key !== 'string' || !Object.hasOwn(CLEAR_FIELDS, key))
    ) {
        throw badRequest('clearFields must be an array of supported field names.')
    }
    if (
        new Set(clearFields).size !== clearFields.length ||
        (clearFields.includes('proxy') && clearFields.some(key => key.startsWith('proxy.')))
    ) {
        throw badRequest('clearFields contains conflicting fields.')
    }
    const patch = { ...fields }
    const preserved = ['password', 'totpSecret', 'recoveryEmail', 'proxyUrl', 'proxyUsername', 'proxyPassword']
    for (const field of preserved) {
        if (patch[field] === '') delete patch[field]
    }
    const full = { ...current, ...patch }
    for (const key of clearFields) {
        for (const field of CLEAR_FIELDS[key]) {
            if (Object.hasOwn(fields, field) && fields[field] !== '' && fields[field] !== null) {
                throw badRequest(`Cannot set and clear ${key} in the same request.`)
            }
            full[field] = ''
        }
    }
    return full
}

// Normalizes + validates flat account fields; throws Error with `code`.
export function validateAccountInput(fields) {
    const errors = []
    const out = {}
    for (const [key, value] of Object.entries(fields)) {
        if (typeof value === 'string' && (/[\r\n]/.test(value) || value.includes('\0')))
            errors.push(`${key} must not contain newline or NUL characters.`)
    }

    const email = String(fields.email ?? '')
        .trim()
        .toLowerCase()
    if (!email || email.length > 320 || !EMAIL_RE.test(email) || email.includes('..')) {
        errors.push('email 必须是合法邮箱地址。')
    } else {
        out.email = email
    }

    const password = fields.password == null ? '' : String(fields.password)
    if (password.length > 512) errors.push('password 过长(最多 512 字符)。')
    else out.password = password

    const totp = String(fields.totpSecret ?? '')
        .trim()
        .replace(/\s+/g, '')
        .toUpperCase()
    if (totp) {
        if (!BASE32_RE.test(totp) || totp.length < 16) errors.push('totpSecret 必须是 Base32 密钥(≥16 位 A-Z2-7)。')
        else out.totpSecret = totp
    } else if ('totpSecret' in fields) {
        out.totpSecret = '' // explicit clear
    }

    const recovery = String(fields.recoveryEmail ?? '').trim()
    if (recovery) {
        if (recovery.length > 320 || !EMAIL_RE.test(recovery)) errors.push('recoveryEmail 必须是合法邮箱。')
        else out.recoveryEmail = recovery
    } else if ('recoveryEmail' in fields) {
        out.recoveryEmail = ''
    }

    const lang = String(fields.langCode ?? '').trim()
    if (lang) {
        try {
            out.langCode = new Intl.Locale(lang).toString()
        } catch {
            errors.push('langCode 必须是合法的 BCP 47 语言标签(如 zh-CN)。')
        }
    } else if ('langCode' in fields) {
        out.langCode = ''
    }

    const geo = String(fields.geoLocale ?? '')
        .trim()
        .toLowerCase()
    if (geo) {
        if (geo === 'auto') out.geoLocale = 'auto'
        else if (!/^[a-z]{2}$/.test(geo)) errors.push('geoLocale 必须是两位国家代码或 auto。')
        else out.geoLocale = geo.toUpperCase()
    } else if ('geoLocale' in fields) {
        out.geoLocale = ''
    }

    const proxyUrl = String(fields.proxyUrl ?? '').trim()
    if (proxyUrl) {
        let parsed = null
        try {
            parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`)
        } catch {
            errors.push('proxy.url 不是合法地址。')
        }
        if (parsed) {
            if (!BROWSER_PROXY_PROTOCOLS.includes(parsed.protocol)) {
                errors.push(
                    `proxy.url 协议必须是 ${BROWSER_PROXY_PROTOCOLS.map(p => p.slice(0, -1)).join('/')}(裸主机名按 http 处理)。`
                )
            } else if (parsed.username || parsed.password) {
                errors.push('proxy.url must not contain embedded credentials; use username/password fields.')
            } else if (!parsed.hostname) {
                errors.push('proxy.url 缺少主机名。')
            } else {
                out.proxyUrl = `${parsed.protocol}//${parsed.hostname}`
                const port =
                    fields.proxyPort == null || fields.proxyPort === '' ? parsed.port : Number(fields.proxyPort)
                if (port === '' || port == null) {
                    // no explicit port and none in URL
                } else if (!Number.isSafeInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
                    errors.push('proxy.port 必须是 1-65535 的整数。')
                } else {
                    out.proxyPort = Number(port)
                }
            }
        }

        const username = String(fields.proxyUsername ?? '').trim()
        const passwordP = String(fields.proxyPassword ?? '')
        if (username) {
            if (/^socks/i.test(out.proxyUrl ?? '')) {
                errors.push('SOCKS 代理不支持账号认证(浏览器限制),请改用 HTTP(S) 代理或免认证 SOCKS。')
            } else out.proxyUsername = username
        }
        if (Boolean(username) !== Boolean(passwordP))
            errors.push('Proxy username and password must be configured together.')
        if (passwordP) out.proxyPassword = passwordP
        out.proxyHttp = boolString(fields.proxyHttp) ?? 'false'
    } else if (fields.proxyUsername || fields.proxyPassword || fields.proxyPort || fields.proxyHttp === 'true') {
        errors.push('Proxy options require proxy.url.')
    } else if ('proxyUrl' in fields) {
        // explicit clear: drop the whole proxy block
        out.proxyUrl = ''
        out.proxyPort = ''
        out.proxyUsername = ''
        out.proxyPassword = ''
        out.proxyHttp = ''
    }

    for (const [field, key] of [
        ['saveFingerprintMobile', 'saveFingerprintMobile'],
        ['saveFingerprintDesktop', 'saveFingerprintDesktop']
    ]) {
        if (fields[key] === undefined) continue
        const value = boolString(fields[key])
        out[field] = value ?? ''
    }

    if (errors.length) {
        const err = new Error(errors.join(' '))
        err.code = 'VALIDATION_FAILED'
        err.errors = errors
        throw err
    }
    return out
}
