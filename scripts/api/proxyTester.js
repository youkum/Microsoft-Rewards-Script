// Connectivity test for per-account browser proxies (WebUI "测试连接" button).
//
// Sends a small request through the proxy to an IP-echo service and reports
// the exit IP, country and latency. Supports the same protocols the bot uses
// for browser proxies: http / https / socks4 / socks5 (see src/util/Proxy.ts).
// SOCKS authentication is intentionally rejected (Patchright cannot
// authenticate SOCKS proxies), matching the bot's own limitation.

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

const IP_ECHO_TARGETS = [
    {
        url: 'https://api.ipify.org/?format=json',
        parse: body => {
            const data = JSON.parse(body)
            if (!net.isIP(data.ip)) throw new Error('回显服务未返回有效 IP。')
            return { ip: data.ip, country: null, countryCode: null, timezone: null }
        }
    },
    {
        url: 'https://myip.ipip.net/',
        parse: body => {
            const ip = /当前 IP[：:]\s*((?:\d{1,3}\.){3}\d{1,3})/.exec(body)?.[1]
            if (!net.isIP(ip)) throw new Error('回显服务未返回有效 IP。')
            return { ip, country: null, countryCode: null, timezone: null }
        }
    },
    {
        url: 'https://4.ipw.cn/',
        parse: body => {
            const ip = body.trim()
            if (!net.isIP(ip)) throw new Error('回显服务未返回有效 IP。')
            return { ip, country: null, countryCode: null, timezone: null }
        }
    },
    {
        url: 'http://ip-api.com/json/?fields=query,country,countryCode,timezone',
        // 国内可直连的回显服务(经代理访问),返回 IP + 国家。
        parse: body => {
            const data = JSON.parse(body)
            if (!net.isIP(data.query)) throw new Error('回显服务未返回有效 IP。')
            return {
                ip: data.query,
                country: data.country ?? null,
                countryCode: data.countryCode ?? null,
                timezone: data.timezone ?? null
            }
        }
    }
]

function proxyError(code, message) {
    return Object.assign(new Error(message), { code })
}

// The installed agent can remove its socket error handler on EOF before a TLS
// handshake completes. Own the CONNECT lifecycle so a failed proxy rejects the
// request, including late TLS errors and cancellation, instead of crashing Node.
class SafeHttpsProxyAgent extends HttpsProxyAgent {
    connect(req, opts) {
        return new Promise((resolve, reject) => {
            const sockets = new Set()
            let completed = false
            const fail = error => {
                if (!completed) {
                    completed = true
                    reject(error)
                } else req.destroy(error)
                for (const socket of sockets) socket.destroy()
            }
            const track = socket => {
                sockets.add(socket)
                socket.on('error', fail)
                return socket
            }
            const proxyTls = this.proxy.protocol === 'https:'
            const socket = track(proxyTls ? tls.connect(this.connectOpts) : net.connect(this.connectOpts))
            const cancel = error => fail(error)
            req.once('proxyCancel', cancel)
            socket.once('end', () => {
                if (!completed) fail(proxyError('PROXY_CONNECT_CLOSED', '代理在 CONNECT 或 TLS 握手完成前断开连接。'))
            })
            req.once('close', () => {
                req.removeListener('proxyCancel', cancel)
                if (!completed) fail(proxyError('PROXY_CANCELLED', '代理请求已取消。'))
                for (const connection of sockets) connection.destroy()
            })
            socket.once(proxyTls ? 'secureConnect' : 'connect', () => {
                const host = net.isIPv6(opts.host) ? `[${opts.host}]` : opts.host
                const headers = { Host: `${host}:${opts.port}`, 'Proxy-Connection': 'close' }
                if (this.proxy.username || this.proxy.password) {
                    const auth = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`
                    headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`
                }
                const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`)
                socket.write(`CONNECT ${host}:${opts.port} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
            })
            let buffered = Buffer.alloc(0)
            const receive = chunk => {
                buffered = Buffer.concat([buffered, chunk])
                const end = buffered.indexOf('\r\n\r\n')
                if (end < 0) {
                    if (buffered.length > 16 * 1024) fail(proxyError('PROXY_BAD_RESPONSE', '代理 CONNECT 响应过大。'))
                    return
                }
                socket.removeListener('data', receive)
                const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buffered.toString('ascii'))?.[1])
                req.emit('proxyConnect', { statusCode: status })
                if (status !== 200) {
                    fail(
                        proxyError(
                            `PROXY_CONNECT_${status || 'INVALID'}`,
                            `代理 CONNECT 返回 ${status || '无效响应'}。`
                        )
                    )
                    return
                }
                socket.pause()
                const remaining = buffered.subarray(end + 4)
                if (remaining.length) socket.unshift(remaining)
                req.once('socket', connection => connection.resume())
                if (opts.secureEndpoint) {
                    const secure = track(
                        tls.connect({ socket, servername: net.isIP(opts.host) ? undefined : opts.host })
                    )
                    secure.once('end', () => {
                        if (!completed)
                            fail(proxyError('PROXY_TARGET_TLS_CLOSED', 'CONNECT 已建立，但目标 HTTPS 握手被断开。'))
                    })
                    secure.once('secureConnect', () => {
                        completed = true
                        resolve(secure)
                    })
                } else {
                    completed = true
                    resolve(socket)
                }
            }
            socket.on('data', receive)
        })
    }
}

function buildAgent(proxy, timeoutMs) {
    const scheme = proxy.protocol.toLowerCase()
    const credentials =
        proxy.username && proxy.password
            ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
            : ''

    if (scheme === 'socks4:' || scheme === 'socks5:') {
        if (credentials) {
            const err = new Error(
                'SOCKS 代理不支持账号认证(浏览器/Patchright 限制),请改用免认证 SOCKS 或 HTTP(S) 代理。'
            )
            err.code = 'SOCKS_AUTH_UNSUPPORTED'
            throw err
        }
        return new SocksProxyAgent(`${scheme}//${proxy.hostname}:${proxy.port}`, { timeout: timeoutMs })
    }

    // Test CONNECT for both HTTP and HTTPS targets, as the browser needs tunnels.
    return new SafeHttpsProxyAgent(`${scheme}//${credentials}${proxy.hostname}:${proxy.port}`, {
        rejectUnauthorized: false
    })
}

function requestVia(agent, targetUrl, timeoutMs, { headersOnly = false } = {}) {
    return new Promise((resolve, reject) => {
        const mod = targetUrl.startsWith('https:') ? https : http
        const req = mod.request(
            targetUrl,
            {
                agent,
                method: 'GET',
                headers: { 'user-agent': 'mrs-proxy-tester/1.0', accept: 'application/json' }
            },
            res => {
                res.on('error', reject)
                res.on('aborted', () => reject(proxyError('PROXY_RESPONSE_ABORTED', '目标响应在完成前断开。')))
                if (headersOnly) {
                    resolve({ status: res.statusCode, body: '' })
                    res.destroy()
                    return
                }
                const chunks = []
                let bytes = 0
                res.on('data', chunk => {
                    chunks.push(chunk)
                    bytes += chunk.length
                    if (bytes > 64 * 1024) {
                        res.destroy(proxyError('PROXY_RESPONSE_TOO_LARGE', '回显服务响应过大。'))
                    }
                })
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
            }
        )
        const timer = setTimeout(() => {
            const error = proxyError('PROXY_TIMEOUT', `代理请求超时(${timeoutMs}ms)。`)
            reject(error)
            req.emit('proxyCancel', error)
            req.destroy(error)
        }, timeoutMs)
        req.once('close', () => clearTimeout(timer))
        req.on('error', reject)
        req.end()
    })
}

function describeFailure(error, protocol) {
    if (error.code === 'PROXY_CONNECT_407') return '代理要求认证，请检查代理用户名、密码或 IP 白名单。'
    if (error.code === 'PROXY_CONNECT_403') return '代理拒绝 CONNECT，请检查套餐权限、目标限制及 IP 白名单。'
    if (protocol === 'https:' && ['PROXY_CONNECT_CLOSED', 'ECONNRESET', 'EPROTO'].includes(error.code)) {
        return 'HTTPS 代理握手被断开。若套餐提供 HTTP CONNECT，请将代理地址填为 http://；https:// 要求代理入口本身支持 TLS。'
    }
    return error.message || '代理连接失败。'
}

// proxy: {url (protocol//host[:port]), port?, username?, password?}
// Returns {ok, ip?, country?, countryCode?, timezone?, latencyMs, target, error?}
export async function testProxy(
    { url, port, username, password, timeoutMs = 10_000 },
    { targets = IP_ECHO_TARGETS, connectivityUrl = 'https://cn.bing.com/' } = {}
) {
    const started = Date.now()
    let parsed
    try {
        parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `http://${url}`)
    } catch {
        return { ok: false, latencyMs: 0, error: '代理地址无法解析。' }
    }
    if (!parsed.hostname) return { ok: false, latencyMs: 0, error: '代理地址缺少主机名。' }
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
        return { ok: false, latencyMs: 0, error: '代理协议必须是 http/https/socks4/socks5。' }
    }
    const proxy = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port:
            port ??
            (parsed.port || (parsed.protocol === 'https:' ? 443 : parsed.protocol.startsWith('socks') ? 1080 : 80)),
        username: username ?? '',
        password: password ?? ''
    }
    if (!Number.isInteger(Number(proxy.port)) || Number(proxy.port) < 1 || Number(proxy.port) > 65535) {
        return { ok: false, latencyMs: 0, error: '代理端口必须是 1-65535 的整数。' }
    }

    let agent
    try {
        agent = buildAgent(proxy, timeoutMs)
    } catch (err) {
        return { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) }
    }
    const failures = []
    try {
        for (const target of targets) {
            try {
                const { status, body } = await requestVia(agent, target.url, timeoutMs)
                if (status !== 200) throw new Error(`回显服务返回 HTTP ${status}。`)
                const info = target.parse(body)
                return {
                    ok: true,
                    connected: true,
                    ...info,
                    latencyMs: Date.now() - started,
                    target: target.url,
                    proxy: `${parsed.protocol}//${parsed.hostname}:${proxy.port}`
                }
            } catch (err) {
                failures.push(describeFailure(err, parsed.protocol))
            }
        }
        try {
            const { status } = await requestVia(agent, connectivityUrl, timeoutMs, { headersOnly: true })
            if (status >= 200 && status < 400) {
                return {
                    ok: false,
                    connected: true,
                    ip: null,
                    code: 'IP_ECHO_UNAVAILABLE',
                    latencyMs: Date.now() - started,
                    target: connectivityUrl,
                    error: '代理已能访问 Bing HTTPS，但出口 IP 回显服务不可用。请稍后重试或检查代理的目标限制。'
                }
            }
            failures.push(`Bing 连通性检查返回 HTTP ${status}。`)
        } catch (error) {
            failures.push(describeFailure(error, parsed.protocol))
        }
        return {
            ok: false,
            connected: false,
            latencyMs: Date.now() - started,
            error: [...new Set(failures)].join(' | ') || '代理连接失败。'
        }
    } finally {
        agent.destroy()
    }
}
