// Dependency/runtime smoke only: never import the app, load accounts, or start cron.
// Run in CI with the container entrypoint overridden and --network none.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = new URL('../../', import.meta.url)
const args = process.argv.slice(2)
assert(args.length <= 1 && (!args.length || args[0] === '--lock-only'), 'Usage: platform-smoke.mjs [--lock-only]')
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'))
const impitLock = lock.packages['node_modules/impit']
for (const arch of ['x64', 'arm64']) {
    const name = `impit-linux-${arch}-gnu`
    const native = lock.packages[`node_modules/${name}`]
    assert(native, `Missing locked native package: ${name}`)
    assert.equal(native.version, impitLock.optionalDependencies[name], `Native version mismatch: ${name}`)
    assert(native.optional && native.os.includes('linux') && native.cpu.includes(arch), `Invalid platform: ${name}`)
}
assert.equal(lock.packages['node_modules/patchright'].version, lock.packages['node_modules/patchright-core'].version)
console.log('Lockfile: Linux x64/arm64 glibc native packages and matching Patchright core present')

if (!args.includes('--lock-only')) {
    assert.equal(process.platform, 'linux', 'Runtime smoke requires a Linux container')
    assert(['x64', 'arm64'].includes(process.arch), `Unsupported architecture: ${process.arch}`)
    const expected = { amd64: 'x64', arm64: 'arm64' }[process.env.EXPECTED_ARCH]
    assert(expected, 'Set EXPECTED_ARCH to amd64 or arm64')
    assert.equal(process.arch, expected, 'Container architecture does not match the CI target')
    assert(process.report.getReport().header.glibcVersionRuntime, 'Runtime must use glibc')
    await readFile(new URL('dist/index.js', root))
    const nativeName = `impit-linux-${process.arch}-gnu`
    require.resolve(nativeName)
    const { Impit } = require('impit')
    const { chromium } = require('patchright')
    assert.equal(require('impit/package.json').version, impitLock.version)
    assert.equal(require('patchright/package.json').version, lock.packages['node_modules/patchright'].version)

    // Verify the browser executable's ELF machine, as well as Node's architecture.
    const assertElf = async executable => {
        const bytes = await readFile(executable)
        assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46', 'Browser is not an ELF executable')
        assert.equal(bytes[4], 2, 'Browser must be 64-bit')
        assert.equal(bytes[5], 1, 'Browser must use little-endian ELF')
        assert.equal(bytes.readUInt16LE(18), process.arch === 'x64' ? 62 : 183, 'Browser architecture mismatch')
    }
    const timer = setTimeout(() => {
        console.error('Platform smoke exceeded its 90 second deadline')
        process.exit(1)
    }, 90_000)
    const server = createServer((req, res) => {
        if (req.url !== '/platform-smoke') {
            res.writeHead(404).end()
            return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><title>Platform smoke</title><main>local runtime works</main>')
    })
    let browser
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', resolve)
        })
        const url = `http://127.0.0.1:${server.address().port}/platform-smoke`
        const client = new Impit({ timeout: 10_000 })
        const response = await client.fetch(url)
        assert.equal(response.status, 200)
        assert.match(await response.text(), /local runtime works/)

        browser = await chromium.launch({ headless: true, timeout: 30_000 })
        const context = await browser.newContext({ serviceWorkers: 'block' })
        await context.route('**/*', route => (route.request().url() === url ? route.continue() : route.abort()))
        const page = await context.newPage()
        const navigation = await page.goto(url, { waitUntil: 'load', timeout: 15_000 })
        assert.equal(navigation.status(), 200)
        assert.equal(await page.title(), 'Platform smoke')
        assert.equal(await page.locator('main').textContent(), 'local runtime works')
        // Resolve the actual headless-shell path selected by this Patchright version.
        // executablePath() describes the full Chromium build, which is deliberately omitted.
        const { readdir } = await import('node:fs/promises')
        const browsers = new URL('node_modules/patchright-core/.local-browsers/', root)
        const shells = (await readdir(browsers)).filter(name => name.startsWith('chromium_headless_shell-'))
        assert.equal(shells.length, 1, 'Expected exactly one installed Chromium headless shell')
        const shellRoot = new URL(`${shells[0]}/`, browsers)
        const directories = await readdir(shellRoot, { withFileTypes: true })
        const candidates = directories.filter(entry => entry.isDirectory() && /headless|chrome-linux/.test(entry.name))
        assert.equal(candidates.length, 1, 'Expected one headless-shell executable directory')
        const executableDir = new URL(`${candidates[0].name}/`, shellRoot)
        const executableNames = (await readdir(executableDir)).filter(name =>
            ['headless_shell', 'chrome-headless-shell'].includes(name)
        )
        assert.equal(executableNames.length, 1, 'Expected one Chromium headless-shell executable')
        await assertElf(fileURLToPath(new URL(executableNames[0], executableDir)))
        console.log(
            `Runtime smoke passed: linux/${process.arch}, impit ${impitLock.version}, Chromium ${browser.version()}`
        )
    } finally {
        try {
            await browser?.close()
        } finally {
            server.closeAllConnections()
            await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
            clearTimeout(timer)
        }
    }
}
