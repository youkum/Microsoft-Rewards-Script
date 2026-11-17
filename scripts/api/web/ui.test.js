import assert from 'node:assert/strict'
import test from 'node:test'

import { createApi, esc, fmtInt, fmtTime, h, pageGuard } from './ui.js'
import { buildAccountBody } from './accounts.js'
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
