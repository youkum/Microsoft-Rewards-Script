import assert from 'node:assert/strict'
import test from 'node:test'

import { createApi, esc, fmtInt, fmtTime, h, pageGuard } from './ui.js'
import { buildAccountBody, createAccountsView, formatProxyAddress } from './accounts.js'
import { mergeLogs, createLogsView } from './logs.js'

test('createApi sends JSON headers and returns parsed success payloads', async () => {
    let request
    const api = createApi(async (url, options) => {
        request = { url, options }
        return { ok: true, json: async () => ({ ok: true }) }
    })

    assert.deepEqual(await api('/status', { method: 'POST', body: { start: true } }), { ok: true })
    assert.equal(request.url, '/status')
    assert.equal(request.options.method, 'POST')
    assert.equal(request.options.headers['x-requested-with'], 'XMLHttpRequest')
    assert.equal(request.options.body, '{"start":true}')
})

test('createApi preserves response details on errors', async () => {
    const api = createApi(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: 'Already running', code: 'ALREADY_RUNNING' })
    }))

    await assert.rejects(api('/start'), error => {
        assert.equal(error.status, 409)
        assert.equal(error.code, 'ALREADY_RUNNING')
        assert.equal(error.message, 'Already running')
        return true
    })
})

test('format helpers handle empty values and escape HTML text', () => {
    assert.equal(fmtInt(null), '—')
    assert.equal(fmtInt(1200), '1,200')
    assert.equal(fmtTime(null), '—')
    assert.equal(esc('<script>'), '&lt;script&gt;')
})

test('h creates elements and appends markup as text', () => {
    const children = []
    const element = {
        nodeType: 1,
        append: (...values) => children.push(...values),
        setAttribute() {}
    }
    const originalDocument = globalThis.document
    globalThis.document = {
        createElement: () => element,
        createTextNode: text => ({ textContent: text })
    }
    try {
        const result = h('div', {}, '<b>text</b>')
        assert.equal(result, element)
        assert.deepEqual(children, [{ textContent: '<b>text</b>' }])
    } finally {
        if (originalDocument === undefined) delete globalThis.document
        else globalThis.document = originalDocument
    }
})

// Model native presence-based boolean attributes: setAttribute('checked', false) still checks.
class NativeElement {
    constructor(tag) {
        this.tagName = tag.toUpperCase()
        this.nodeType = 1
        this.children = []
        this.attributes = new Map()
        this.style = {}
        this.dataset = {}
        this.checked = false
        this.selected = false
        this.disabled = false
        this.value = ''
        this.className = ''
        this.events = new Map()
    }
    setAttribute(key, value) {
        this.attributes.set(key, String(value))
        if (key === 'checked' || key === 'selected' || key === 'disabled') this[key] = true
        if (key === 'value') this.value = String(value)
        if (key === 'id') this.id = String(value)
    }
    addEventListener(key, fn) {
        this.events.set(key, fn)
    }
    append(...nodes) {
        this.children.push(...nodes)
    }
    replaceChildren(...nodes) {
        this.children = nodes
    }
    set innerHTML(value) {
        this.children = []
    }
    get childNodes() {
        return this.children
    }
    querySelector() {
        return null
    }
}
function withNativeDocument(run) {
    const previous = globalThis.document
    const main = new NativeElement('main')
    main.id = 'main'
    const document = {
        createElement: tag => new NativeElement(tag),
        createElementNS: (_, tag) => new NativeElement(tag),
        createTextNode: text => ({ nodeType: 3, textContent: text }),
        getElementById: id => (id === 'main' ? main : find(main, node => node.id === id)),
        activeElement: null
    }
    globalThis.document = document
    return Promise.resolve()
        .then(() => run({ document, main }))
        .finally(() => {
            if (previous === undefined) delete globalThis.document
            else globalThis.document = previous
        })
}
function find(node, predicate) {
    if (predicate(node)) return node
    for (const child of node.children || []) {
        const result = find(child, predicate)
        if (result) return result
    }
    return null
}

test('account session-save button starts only maintenance login and routes to code input logs', async () =>
    withNativeDocument(async ({ main }) => {
        const previousLocation = globalThis.location
        globalThis.location = { hash: '#/accounts' }
        const calls = [],
            toasts = []
        let finish
        const pending = new Promise(resolve => {
            finish = resolve
        })
        const view = createAccountsView({
            state: { routeGeneration: 1, me: { authenticated: true, capabilities: { accountWrite: false } } },
            toast: message => toasts.push(message),
            api: async (route, options) => {
                if (route === '/accounts')
                    return { accounts: [{ index: 7, email: 'beta@example.test', proxy: null, source: 'env' }] }
                calls.push({ route, options })
                await pending
                return { started: true }
            }
        })
        try {
            await view.viewAccounts()
            const button = find(
                main,
                node => node.tagName === 'BUTTON' && node.children.some(child => child.textContent === '保存登录会话')
            )
            assert.ok(button, 'login is available for file-managed and web-managed accounts')
            const click = button.events.get('click')
            const started = click({ currentTarget: button })
            await click({ currentTarget: button })
            assert.equal(calls.length, 1, 'double click cannot start another login')
            assert.equal(calls[0].route, '/accounts/7/login')
            assert.deepEqual(calls[0].options.body, { platform: 'both' })
            finish()
            await started
            assert.equal(globalThis.location.hash, '#/logs')
            assert.ok(toasts[0].includes('验证码'))
        } finally {
            view.dispose()
            if (previousLocation === undefined) delete globalThis.location
            else globalThis.location = previousLocation
        }
    }))

test('proxy addresses keep hostname and one effective port for bare, HTTP, HTTPS and IPv6 inputs', () => {
    for (const [proxy, expected] of [
        [{ url: '203.0.113.7', port: '19450' }, 'http://203.0.113.7:19450'],
        [{ url: 'http://203.0.113.8', port: '10809' }, 'http://203.0.113.8:10809'],
        [{ url: 'https://proxy.example.invalid', port: '443' }, 'https://proxy.example.invalid:443'],
        [{ url: 'http://proxy.example.invalid:8080' }, 'http://proxy.example.invalid:8080'],
        [{ url: 'http://proxy.example.invalid:8080', port: '10809' }, 'http://proxy.example.invalid:10809'],
        [{ url: 'socks5://[2001:db8::1]', port: '1080' }, 'socks5://[2001:db8::1]:1080'],
        [
            { url: 'http://synthetic-user:synthetic-secret@proxy.example.invalid:8080/path?token=private' },
            'http://proxy.example.invalid:8080'
        ],
        [{ url: 'http://proxy.example.invalid' }, 'http://proxy.example.invalid'],
        [{ url: 'http://' }, '代理地址无效'],
        [null, '']
    ])
        assert.equal(formatProxyAddress(proxy), expected)
})

test('account table renders full proxy host and port in badges and tooltips without credentials', async () =>
    withNativeDocument(async ({ main }) => {
        const accounts = [
            { index: 4, email: 'bare@example.invalid', proxy: { url: '203.0.113.7', port: '19450' } },
            { index: 6, email: 'http@example.invalid', proxy: { url: 'http://203.0.113.8', port: '10809' } },
            {
                index: 7,
                email: 'tls@example.invalid',
                proxy: {
                    url: 'https://synthetic-user:synthetic-secret@proxy.example.invalid:8080',
                    port: '443',
                    hasCredentials: true
                }
            }
        ]
        const view = createAccountsView({
            api: async () => ({ accounts }),
            state: { routeGeneration: 1, me: { authenticated: true, capabilities: { accountWrite: false } } },
            toast: () => {}
        })
        try {
            await view.viewAccounts()
            const texts = []
            const titles = []
            const visit = node => {
                if (node.className === 'badge blue') {
                    texts.push(node.children.map(child => child.textContent ?? '').join(''))
                    titles.push(node.attributes.get('title'))
                }
                for (const child of node.children ?? []) visit(child)
            }
            visit(main)
            assert.deepEqual(texts, [
                'http://203.0.113.7:19450',
                'http://203.0.113.8:10809',
                'https://proxy.example.invalid:443 🔑'
            ])
            assert.deepEqual(titles, [
                'http://203.0.113.7:19450',
                'http://203.0.113.8:10809',
                'https://proxy.example.invalid:443'
            ])
        } finally {
            view.dispose()
        }
    }))

test('proxy test shows a real exit IP and distinguishes unavailable echo from connection failure', async () =>
    withNativeDocument(async ({ main }) => {
        const results = [
            { ok: true, connected: true, ip: '203.0.113.8', latencyMs: 50 },
            { ok: false, connected: true, ip: null, code: 'IP_ECHO_UNAVAILABLE' },
            { ok: false, connected: false, error: '代理要求认证。' }
        ]
        const toasts = []
        const account = { index: 6, email: 'proxy@example.invalid', proxy: { url: 'http://proxy.invalid' } }
        const state = { routeGeneration: 1, me: { authenticated: true, capabilities: { accountWrite: false } } }
        const view = createAccountsView({
            api: async route => (route === '/accounts' ? { accounts: [account] } : results.shift()),
            state,
            toast: (message, type) => toasts.push({ message, type })
        })
        try {
            await view.viewAccounts()
            const button = find(
                main,
                node => node.tagName === 'BUTTON' && node.children.some(child => child.textContent === '测代理')
            )
            for (let attempt = 0; attempt < 3; attempt++) await button.events.get('click')()
            const messages = toasts.filter(item => item.type)
            assert.match(messages[0].message, /203\.0\.113\.8/)
            assert.equal(messages[0].type, 'success')
            assert.match(messages[1].message, /已连通.*IP 查询失败/)
            assert.equal(messages[1].type, 'warn')
            assert.equal(messages[1].message.includes('null'), false)
            assert.match(messages[2].message, /认证/)
            assert.equal(messages[2].type, 'error')
        } finally {
            view.dispose()
        }
    }))

test('h sets false native checked/selected properties without present boolean attributes', async () =>
    withNativeDocument(() => {
        for (const [tag, property] of [
            ['input', 'checked'],
            ['option', 'selected']
        ]) {
            for (const value of [false, true]) {
                const element = h(tag, { [property]: value })
                assert.equal(element[property], value)
                assert.equal(element.attributes.has(property), false)
            }
        }
        const option = h('option', { value: 30, selected: false }, '30 days')
        assert.equal(option.value, '30')
        assert.equal(option.selected, false)
    }))

test('page guard rejects route changes, logout, and replaced main nodes', async () =>
    withNativeDocument(({ document, main }) => {
        const state = { routeGeneration: 1, me: { authenticated: true } }
        const current = pageGuard(state, main)
        assert.equal(current(), true)
        state.routeGeneration++
        assert.equal(current(), false)
        state.routeGeneration--
        state.me = null
        assert.equal(current(), false)
        state.me = { authenticated: true }
        document.getElementById = () => new NativeElement('main')
        assert.equal(current(), false)
    }))

function accountFields() {
    const values = {
        email: ' a@example.test ',
        lang: 'zh-CN',
        geo: 'CN',
        password: '',
        totp: '',
        recovery: '',
        proxyUrl: '',
        proxyPort: '',
        proxyUser: '',
        proxyPass: ''
    }
    return {
        ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])),
        fpMobile: { checked: false },
        fpDesktop: { checked: true },
        proxyHttp: { checked: false }
    }
}
test('account edit preserves all blank credentials and blank proxy instead of clearing stored secrets', () => {
    const body = buildAccountBody(accountFields(), true)
    assert.deepEqual(body, {
        email: 'a@example.test',
        langCode: 'zh-CN',
        geoLocale: 'CN',
        saveFingerprint: { mobile: false, desktop: true }
    })
})
test('account edit sends only explicit clearFields and nonblank replacements', () => {
    const fields = accountFields()
    fields.password.value = 'new password'
    fields.proxyUrl.value = 'http://proxy.test'
    fields['clear-recoveryEmail'] = { checked: true }
    fields['clear-proxy.username'] = { checked: true }
    fields['clear-proxy.password'] = { checked: true }
    const body = buildAccountBody(fields, true)
    assert.equal(body.password, 'new password')
    assert.deepEqual(body.proxy, { url: 'http://proxy.test', http: false })
    assert.deepEqual(body.clearFields, ['recoveryEmail', 'proxy.username', 'proxy.password'])
    fields['clear-proxy'] = { checked: true }
    const clear = buildAccountBody(fields, true)
    assert.equal('proxy' in clear, false)
    assert.deepEqual(clear.clearFields, ['recoveryEmail', 'proxy'])
})
test('log replay merges overlapping IDs in order and preserves newly streamed entries', () => {
    const live = { id: 3, message: 'live' }
    assert.deepEqual(mergeLogs([{ id: 1 }, { id: 2 }, { id: 3, message: 'old' }], [live, { id: 4 }]), [
        { id: 1 },
        { id: 2 },
        live,
        { id: 4 }
    ])
    assert.deepEqual(mergeLogs([{ id: 1 }, { id: 2 }], [{ id: 3 }], 2), [{ id: 2 }, { id: 3 }])
})
test('logging out during replay cannot repopulate cleared logs', async () =>
    withNativeDocument(async () => {
        let resolve
        const pending = new Promise(done => {
            resolve = done
        })
        const state = {
            routeGeneration: 1,
            me: { authenticated: true },
            logs: [],
            logFilter: 'all',
            logAutoScroll: true
        }
        const logs = createLogsView({ api: () => pending, state, toast: () => {}, renderPromptBanner: () => {} })
        const mounting = logs.viewLogs()
        state.me = null
        state.routeGeneration++
        logs.dispose()
        resolve({ logs: [{ id: 1, message: 'sensitive old session' }] })
        await mounting
        assert.deepEqual(state.logs, [])
    }))
