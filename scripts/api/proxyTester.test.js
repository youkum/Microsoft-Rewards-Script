import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { testProxy } from './proxyTester.js'
import { key, cert } from './fixtures/proxyCertificate.js'

const targets = [{ url: 'http://echo.invalid/', parse: JSON.parse }]
const connectivityUrl = 'http://bing.invalid/'

async function listen(t, server) {
    const sockets = new Set()
    server.on('connection', socket => {
        sockets.add(socket)
        socket.on('error', () => {})
        socket.on('close', () => sockets.delete(socket))
    })
    t.after(async () => {
        for (const socket of sockets) socket.destroy()
        await new Promise(resolve => server.close(resolve))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return server.address().port
}

function options(port, protocol = 'http') {
    return { url: `${protocol}://127.0.0.1`, port, timeoutMs: 500 }
}

function respond(socket, body) {
    const json = JSON.stringify(body)
    socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`
    )
}

test('HTTPS protocol aimed at a plain proxy returns failure without a late unhandled TLS error', async t => {
    const port = await listen(
        t,
        net.createServer(socket => socket.once('data', () => socket.end()))
    )
    const result = await testProxy(options(port, 'https'), { targets, connectivityUrl })
    assert.equal(result.ok, false)
    assert.match(result.error, /http:\/\//)
    assert.equal(result.error.split(' | ').length, 1)
    await new Promise(resolve => setTimeout(resolve, 100))
})

test('valid TLS proxy, CONNECT forwarding and special-character authentication return the actual echo IP', async t => {
    const requests = []
    const authorization = 'Basic ' + Buffer.from('user@:secret:$ #').toString('base64')
    const server = https.createServer({ key, cert })
    server.on('connect', (request, socket) => {
        requests.push(request.url)
        assert.equal(request.headers['proxy-authorization'], authorization)
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        socket.once('data', () => respond(socket, { ip: '203.0.113.7' }))
    })
    const port = await listen(t, server)
    const result = await testProxy(
        { ...options(port, 'https'), username: 'user@', password: 'secret:$ #' },
        { targets, connectivityUrl }
    )
    assert.equal(result.ok, true)
    assert.equal(result.ip, '203.0.113.7')
    assert.deepEqual(requests, ['echo.invalid:80'])
})

test('CONNECT authorization errors remain specific and deduplicated', async t => {
    const server = http.createServer()
    server.on('connect', (_, socket) =>
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
    )
    const port = await listen(t, server)
    const result = await testProxy(options(port), { targets, connectivityUrl })
    assert.equal(result.ok, false)
    assert.match(result.error, /认证/)
    assert.equal(result.error.split(' | ').length, 1)
})

test('silent proxy is cancelled at the deadline and its open sockets are closed', async t => {
    let open = 0
    const server = net.createServer(socket => {
        open++
        socket.resume()
        socket.on('close', () => open--)
    })
    const port = await listen(t, server)
    const result = await testProxy({ ...options(port), timeoutMs: 80 }, { targets, connectivityUrl })
    assert.equal(result.ok, false)
    assert.match(result.error, /超时/)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(open, 0)
    assert.ok(result.latencyMs < 1500)
})

test('CONNECT success followed by target TLS EOF returns failure safely', async t => {
    const server = http.createServer()
    server.on('connect', (_, socket) => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        socket.once('data', () => socket.end())
    })
    const port = await listen(t, server)
    const url = 'https://echo.invalid/'
    const result = await testProxy(options(port), { targets: [{ url, parse: JSON.parse }], connectivityUrl: url })
    assert.equal(result.ok, false)
    assert.match(result.error, /HTTPS.*断开|TLS|disconnected/)
})

test('blocked first echo falls back to the next service through the same proxy', async t => {
    const requested = []
    const server = http.createServer()
    server.on('connect', (request, socket) => {
        requested.push(request.url)
        if (request.url.startsWith('blocked.')) {
            socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
        } else {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            socket.once('data', () => respond(socket, { ip: '203.0.113.8' }))
        }
    })
    const port = await listen(t, server)
    const result = await testProxy(options(port), {
        targets: [{ url: 'http://blocked.invalid/', parse: JSON.parse }, ...targets],
        connectivityUrl
    })
    assert.equal(result.ip, '203.0.113.8')
    assert.deepEqual(requested, ['blocked.invalid:80', 'echo.invalid:80'])
})

test('Bing connectivity without a working echo reports connected with an unknown IP', async t => {
    const server = http.createServer()
    server.on('connect', (request, socket) => {
        if (request.url.startsWith('echo.')) socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        else {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            socket.once('data', () => respond(socket, {}))
        }
    })
    const port = await listen(t, server)
    const result = await testProxy(options(port), { targets, connectivityUrl })
    assert.equal(result.ok, false)
    assert.equal(result.connected, true)
    assert.equal(result.ip, null)
    assert.equal(result.code, 'IP_ECHO_UNAVAILABLE')
})

test('proxy input validation rejects unsupported schemes, invalid ports and authenticated SOCKS', async () => {
    assert.equal((await testProxy({ url: 'ftp://localhost' })).ok, false)
    assert.equal((await testProxy({ url: 'http://localhost', port: 0 })).ok, false)
    assert.match((await testProxy({ url: 'socks5://localhost', username: 'u', password: 'p' })).error, /SOCKS/)
})

test('HTTPS IPIP fallback parses the actual exit IP after the first service is rejected', async t => {
    const endpoint = https.createServer({ key, cert }, (_, response) => {
        response.end('当前 IP：203.0.113.11  来自于：中国 北京')
    })
    const endpointPort = await listen(t, endpoint)
    const requested = []
    const proxy = http.createServer()
    proxy.on('connect', (request, socket) => {
        requested.push(request.url)
        if (!request.url.startsWith('myip.ipip.net:')) {
            socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
            return
        }
        const upstream = net.connect({ host: '127.0.0.1', port: endpointPort }, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            socket.pipe(upstream).pipe(socket)
        })
        upstream.on('error', () => socket.destroy())
        socket.on('close', () => upstream.destroy())
    })
    const port = await listen(t, proxy)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-proxy-ipip-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const ca = path.join(directory, 'certificate.pem')
    fs.writeFileSync(ca, cert)
    // Trust only the public loopback test CA in this child and leave production TLS intact.
    const code = `const {testProxy}=await import(${JSON.stringify(new URL('./proxyTester.js', import.meta.url).href)}); console.log(JSON.stringify(await testProxy(${JSON.stringify(options(port))})))`
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: {
            SystemRoot: process.env.SystemRoot ?? '',
            PATH: path.dirname(process.execPath),
            NODE_EXTRA_CA_CERTS: ca
        },
        windowsHide: true
    })
    t.after(() => {
        if (child.exitCode === null) child.kill()
    })
    let output = '',
        errors = ''
    child.stdout.on('data', chunk => {
        output += chunk
    })
    child.stderr.on('data', chunk => {
        errors += chunk
    })
    const exit = await new Promise(resolve => child.once('close', resolve))
    assert.equal(exit, 0, errors)
    const result = JSON.parse(output)
    // This fixture's CA covers the target host below.
    assert.equal(result.target, 'https://myip.ipip.net/')
    assert.equal(result.ip, '203.0.113.11')
    assert.deepEqual(requested, ['api.ipify.org:443', 'myip.ipip.net:443'])
})

test('unauthenticated SOCKS5 proxy still tunnels requests to an echo service', async t => {
    const server = net.createServer(socket => {
        let phase = 'greeting'
        let buffer = Buffer.alloc(0)
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk])
            if (phase === 'greeting' && buffer.length >= 3) {
                buffer = buffer.subarray(3)
                phase = 'connect'
                socket.write(Buffer.from([5, 0]))
            }
            if (phase === 'connect' && buffer.length >= 7) {
                const length = buffer[3] === 1 ? 10 : 7 + buffer[4]
                if (buffer.length < length) return
                buffer = buffer.subarray(length)
                phase = 'http'
                socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
            }
            if (phase === 'http' && buffer.includes('\r\n\r\n')) respond(socket, { ip: '203.0.113.10' })
        })
    })
    const port = await listen(t, server)
    // Numeric target keeps the fixture free of DNS requests.
    const result = await testProxy(options(port, 'socks5'), {
        targets: [{ url: 'http://127.0.0.1/', parse: JSON.parse }],
        connectivityUrl
    })
    assert.equal(result.ok, true)
    assert.equal(result.ip, '203.0.113.10')
})

test('real CONNECT tunnel verifies target HTTPS certificates and returns echo JSON', async t => {
    const endpoint = https.createServer({ key, cert }, (_, response) =>
        response.end(JSON.stringify({ ip: '203.0.113.9' }))
    )
    const endpointPort = await listen(t, endpoint)
    const proxy = http.createServer()
    proxy.on('connect', (_, socket) => {
        const upstream = net.connect({ host: '127.0.0.1', port: endpointPort }, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            socket.pipe(upstream).pipe(socket)
        })
        upstream.on('error', () => socket.destroy())
        socket.on('close', () => upstream.destroy())
    })
    const port = await listen(t, proxy)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-proxy-ca-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const ca = path.join(directory, 'certificate.pem')
    fs.writeFileSync(ca, cert)
    const modulePath = fileURLToPath(new URL('./proxyTester.js', import.meta.url))
    const code = `const {testProxy}=await import(${JSON.stringify(new URL('./proxyTester.js', import.meta.url).href)}); console.log(JSON.stringify(await testProxy(${JSON.stringify(options(port))},{targets:[{url:'https://echo.invalid/',parse:JSON.parse}],connectivityUrl:'https://echo.invalid/'})))`
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        cwd: path.dirname(modulePath),
        env: {
            SystemRoot: process.env.SystemRoot ?? '',
            PATH: path.dirname(process.execPath),
            NODE_EXTRA_CA_CERTS: ca
        },
        windowsHide: true
    })
    t.after(() => {
        if (child.exitCode === null) child.kill()
    })
    let output = '',
        errors = ''
    child.stdout.on('data', chunk => {
        output += chunk
    })
    child.stderr.on('data', chunk => {
        errors += chunk
    })
    const exit = await new Promise(resolve => child.once('close', resolve))
    assert.equal(exit, 0, errors)
    assert.equal(JSON.parse(output).ip, '203.0.113.9')
})
