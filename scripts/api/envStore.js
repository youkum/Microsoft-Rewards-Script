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

// Mirrors BROWSER_PROXY_PROTOCOLS in src/util/Proxy.ts (scripts/ cannot import TS).
export const BROWSER_PROXY_PROTOCOLS = ['http:', 'https:', 'socks4:', 'socks5:']

const ACCOUNT_KEY_RE = /^ACCOUNT_(\d+)_([A-Z0-9_]+)$/

// ---------------------------------------------------------------------------
// Parsing / serialization (format-compatible with lib.js loadEnvFile / Load.ts)
// ---------------------------------------------------------------------------

function parseEnvContent(raw) {
    const pairs = []
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        if (key) pairs.push({ key, value })
    }
    return pairs
}

function quoteValue(value) {
    const str = String(value)
    if (str === '' || /^[\w.@:/\-+,.;~()[\]]+$/.test(str)) return str
    return `"${str.replace(/(["\\])/g, '\\$1')}"`
}

function serializePairs(pairs, header) {
    const lines = header ? [header, ''] : []
    let lastSlot = null
    for (const { key, value } of pairs) {
        const slot = ACCOUNT_KEY_RE.exec(key)?.[1] ?? null
        if (slot !== lastSlot) {
            if (slot) lines.push(`# Account ${slot}`)
            lastSlot = slot
        }
        lines.push(`${key}=${quoteValue(value)}`)
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
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    if (fs.existsSync(filePath)) {
        const backup = `${filePath}.bak`
        if (!fs.existsSync(backup)) fs.copyFileSync(filePath, backup)
    }
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, content, 'utf-8')
    fs.renameSync(tmp, filePath)
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
    for (const { key, value } of loadAccountPairs(projectRoot)) env[key] = value
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
        value = String(value).trim()
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
export function updateAccount(projectRoot, slot, fields, baseEnv = process.env) {
    const prefix = `ACCOUNT_${slot}_`
    writeAccountPairs(projectRoot, current => {
        if (!current.some(pair => pair.key === `${prefix}EMAIL`)) {
            const err = new Error(`ACCOUNT_${slot} 不在 Web 管理的账号文件中,无法编辑。`)
            err.code = 'NOT_WEB_MANAGED'
            throw err
        }
        const merged = getMergedAccountEnv(projectRoot, baseEnv)
        const currentFields = fieldsFromEnv(merged, slot)
        const full = { ...currentFields, ...fields }
        const email = String(full.email ?? '').trim().toLowerCase()
        if (!email) {
            const err = new Error('email 字段不能为空。')
            err.code = 'BAD_REQUEST'
            throw err
        }
        for (const [key, value] of Object.entries(merged)) {
            const match = ACCOUNT_KEY_RE.exec(key)
            if (key.endsWith('_EMAIL') && match && match[1] !== String(slot) && String(value).trim().toLowerCase() === email) {
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
        if (value !== undefined && String(value).trim() !== '') fields[field] = String(value).trim()
    }
    return fields
}

// Flattens the WebUI JSON payload (nested proxy/saveFingerprint) into the
// flat field shape used for validation and storage.
export function flattenAccountPayload(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw Object.assign(new Error('账号数据必须是 JSON 对象。'), { code: 'BAD_REQUEST' })
    }
    const flat = {}
    for (const key of ['email', 'password', 'totpSecret', 'recoveryEmail', 'langCode', 'geoLocale']) {
        if (input[key] !== undefined) flat[key] = input[key] === null ? '' : String(input[key])
    }
    const proxy = input.proxy && typeof input.proxy === 'object' ? input.proxy : {}
    for (const [key, name] of [
        ['url', 'proxyUrl'],
        ['username', 'proxyUsername'],
        ['password', 'proxyPassword']
    ]) {
        if (proxy[key] !== undefined) flat[name] = proxy[key] === null ? '' : String(proxy[key])
    }
    if (proxy.port !== undefined) flat.proxyPort = proxy.port === null || proxy.port === '' ? '' : proxy.port
    if (proxy.http !== undefined) flat.proxyHttp = boolString(proxy.http) ?? ''
    const fingerprint = input.saveFingerprint && typeof input.saveFingerprint === 'object' ? input.saveFingerprint : {}
    if (fingerprint.mobile !== undefined) flat.saveFingerprintMobile = boolString(fingerprint.mobile) ?? ''
    if (fingerprint.desktop !== undefined) flat.saveFingerprintDesktop = boolString(fingerprint.desktop) ?? ''
    return flat
}

// Normalizes + validates flat account fields; throws Error with `code`.
export function validateAccountInput(fields) {
    const errors = []
    const out = {}

    const email = String(fields.email ?? '').trim().toLowerCase()
    if (!email || email.length > 320 || !EMAIL_RE.test(email) || email.includes('..')) {
        errors.push('email 必须是合法邮箱地址。')
    } else {
        out.email = email
    }

    const password = fields.password == null ? '' : String(fields.password)
    if (password.length > 512) errors.push('password 过长(最多 512 字符)。')
    else out.password = password

    const totp = String(fields.totpSecret ?? '').trim().replace(/\s+/g, '').toUpperCase()
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

    const geo = String(fields.geoLocale ?? '').trim().toLowerCase()
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
            } else if (!parsed.hostname) {
                errors.push('proxy.url 缺少主机名。')
            } else {
                out.proxyUrl = `${parsed.protocol}//${parsed.hostname}`
                const port = fields.proxyPort == null || fields.proxyPort === '' ? parsed.port : Number(fields.proxyPort)
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
        if (passwordP) out.proxyPassword = passwordP
        out.proxyHttp = boolString(fields.proxyHttp) ?? 'false'
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
