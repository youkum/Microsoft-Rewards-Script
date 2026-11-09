// Connectivity test for per-account browser proxies (WebUI "测试连接" button).
//
// Sends a small request through the proxy to an IP-echo service and reports
// the exit IP, country and latency. Supports the same protocols the bot uses
// for browser proxies: http / https / socks4 / socks5 (see src/util/Proxy.ts).
// SOCKS authentication is intentionally rejected (Patchright cannot
// authenticate SOCKS proxies), matching the bot's own limitation.

import http from 'node:http'
import https from 'node:https'

import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

const IP_ECHO_TARGETS = [
    {
        url: 'http://ip-api.com/json/?fields=query,country,countryCode,timezone',
        // 国内可直连的回显服务(经代理访问),返回 IP + 国家。
        parse: body => {
            const data = JSON.parse(body)
            if (!data.query) throw new Error('unexpected payload')
            return { ip: data.query, country: data.country ?? null, countryCode: data.countryCode ?? null, timezone: data.timezone ?? null }
        }
    },
    {
        url: 'https://api.ipify.org/?format=json',
        parse: body => {
            const data = JSON.parse(body)
            if (!data.ip) throw new Error('unexpected payload')
            return { ip: data.ip, country: null, countryCode: null, timezone: null }
        }
    }
]

function buildAgent(proxy) {
    const scheme = proxy.protocol.toLowerCase()
    const credentials =
        proxy.username && proxy.password ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@` : ''

    if (scheme === 'socks4:' || scheme === 'socks5:') {
        if (credentials) {
            const err = new Error('SOCKS 代理不支持账号认证(浏览器/Patchright 限制),请改用免认证 SOCKS 或 HTTP(S) 代理。')
            err.code = 'SOCKS_AUTH_UNSUPPORTED'
            throw err
        }
        return new SocksProxyAgent(`${scheme}//${proxy.hostname}:${proxy.port}`)
    }

    // http/https 代理;目标 https 走 CONNECT 隧道,目标 http 走绝对地址转发。
    return new HttpsProxyAgent(`${scheme}//${credentials}${proxy.hostname}:${proxy.port}`, {
        rejectUnauthorized: false
    })
}

function requestVia(agent, targetUrl, timeoutMs) {
    return new Promise((resolve, reject) => {
        const mod = targetUrl.startsWith('https:') ? https : http
        const req = mod.request(
            targetUrl,
            { agent, method: 'GET', timeout: timeoutMs, headers: { 'user-agent': 'mrs-proxy-tester/1.0', accept: 'application/json' } },
            res => {
                const chunks = []
                res.on('data', chunk => {
                    chunks.push(chunk)
                    if (chunks.reduce((sum, c) => sum + c.length, 0) > 64 * 1024) {
                        res.destroy()
                        reject(new Error('回显服务响应过大。'))
                    }
                })
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
            }
        )
        req.on('timeout', () => {
            req.destroy()
            reject(new Error(`连接超时(${timeoutMs}ms)。`))
        })
        req.on('error', reject)
        req.end()
    })
}

// OS-level connect timeouts can exceed the request timeout; enforce a hard cap.
function withHardTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} 超时(${timeoutMs}ms)。`)), timeoutMs + 2000)
        promise.then(
            value => { clearTimeout(timer); resolve(value) },
            err => { clearTimeout(timer); reject(err) }
        )
    })
}

// proxy: {url (protocol//host[:port]), port?, username?, password?}
// Returns {ok, ip?, country?, countryCode?, timezone?, latencyMs, target, error?}
export async function testProxy({ url, port, username, password, timeoutMs = 10_000 }) {
    const started = Date.now()
    let parsed
    try {
        parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `http://${url}`)
    } catch {
        return { ok: false, latencyMs: 0, error: '代理地址无法解析。' }
    }
    if (!parsed.hostname) return { ok: false, latencyMs: 0, error: '代理地址缺少主机名。' }
    if (parsed.port) parsed.port = String(port ?? parsed.port)

    const proxy = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: port ?? (parsed.port || (parsed.protocol === 'https:' ? 443 : parsed.protocol.startsWith('socks') ? 1080 : 80)),
        username: username ?? '',
        password: password ?? ''
    }

    let agent
    try {
        agent = buildAgent(proxy)
    } catch (err) {
        return { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) }
    }
    const failures = []
    for (const target of IP_ECHO_TARGETS) {
        try {
            const { status, body } = await withHardTimeout(
                requestVia(agent, target.url, timeoutMs),
                timeoutMs,
                '代理连接'
            )
            if (status !== 200) throw new Error(`回显服务返回 HTTP ${status}。`)
            const info = target.parse(body)
            return {
                ok: true,
                ...info,
                latencyMs: Date.now() - started,
                target: target.url,
                proxy: `${parsed.protocol}//${parsed.hostname}:${proxy.port}`
            }
        } catch (err) {
            failures.push(err instanceof Error ? err.message : String(err))
        }
    }
    return {
        ok: false,
        latencyMs: Date.now() - started,
        error: failures.join(' | ') || '代理连接失败。'
    }
}
