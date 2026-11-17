// Shared data-only .env format. Double-quoted values use JSON escaping;
// single-quoted and unquoted legacy values retain their literal contents.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function parseEnvContent(raw) {
    const pairs = []
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        if (!ENV_KEY_RE.test(key)) continue
        let value = trimmed.slice(eq + 1).trim()
        if (value.startsWith('"') && value.endsWith('"')) {
            try {
                value = JSON.parse(value)
            } catch {
                // Existing files sometimes contain literal backslashes that
                // are not JSON escapes (for example Windows paths).
                value = value.slice(1, -1)
            }
        } else if (value.startsWith("'") && value.endsWith("'")) {
            value = value.slice(1, -1)
        }
        pairs.push({ key, value })
    }
    return pairs
}

function quoteEnvValue(value) {
    const str = String(value)
    return str === '' || /^[\w.@:/\-+,.;~()[\]]+$/.test(str) ? str : JSON.stringify(str)
}

function isSecretEnvKey(key) {
    return /(?:^|_)(?:PASSWORD|SECRET|TOKEN|API_KEY|APPKEY)$/.test(key)
}

module.exports = { parseEnvContent, quoteEnvValue, isSecretEnvKey }
