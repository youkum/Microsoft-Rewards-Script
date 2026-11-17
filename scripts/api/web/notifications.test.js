import assert from 'node:assert/strict'
import test from 'node:test'
import { buildNotificationBody, createNotificationsView } from './notifications.js'
import { createSettingsViews } from './settings.js'

function notificationFields(values = {}) {
    return {
        ...Object.fromEntries(
            Object.entries({
                token: '',
                title: '',
                template: '',
                channel: '',
                goalName: '100元礼品卡',
                targetPoints: '',
                ...values
            }).map(([name, value]) => [name, { value }])
        ),
        enabled: { checked: true },
        clearToken: { checked: false }
    }
}

test('notification patch preserves blank secrets, optional settings and unrelated configuration', () => {
    const body = buildNotificationBody(notificationFields())
    assert.deepEqual(body, {
        webhook: { pushplus: { enabled: true } },
        rewardGoal: { name: '100元礼品卡', faceValue: 100, targetPoints: null }
    })
    const existing = { token: 'stored-secret', title: 'existing title', template: 'markdown', channel: 'wechat' }
    assert.deepEqual({ ...existing, ...body.webhook.pushplus }, { ...existing, enabled: true })
    assert.equal(Object.hasOwn(body, 'workers'), false)
    assert.equal(Object.hasOwn(body.webhook, 'telegram'), false)
})

test('new token replacement and explicit clear are deliberate, independent operations', () => {
    const fields = notificationFields({ token: ' replacement ', title: ' Daily ', channel: 'wechat', template: 'txt' })
    assert.deepEqual(buildNotificationBody(fields).webhook.pushplus, {
        enabled: true,
        token: 'replacement',
        title: 'Daily',
        template: 'txt',
        channel: 'wechat'
    })
    fields.clearToken.checked = true
    assert.equal(buildNotificationBody(fields).webhook.pushplus.token, '')
    fields.enabled.checked = false
    assert.equal(buildNotificationBody(fields).webhook.pushplus.enabled, false)
})

test('goal has no invented threshold and accepts only positive safe integer user input', () => {
    for (const value of ['', '   ']) {
        assert.equal(buildNotificationBody(notificationFields({ targetPoints: value })).rewardGoal.targetPoints, null)
    }
    assert.equal(buildNotificationBody(notificationFields({ targetPoints: ' 12345 ' })).rewardGoal.targetPoints, 12345)
    assert.equal(buildNotificationBody(notificationFields({ targetPoints: '1' })).rewardGoal.targetPoints, 1)
    for (const value of ['0', '-1', '1.5', 'abc', 'NaN', 'Infinity', '1e3', '0x10', '9007199254740992']) {
        assert.throws(() => buildNotificationBody(notificationFields({ targetPoints: value })), /正整数/)
    }
})

test('editable goal name is preserved and redacted token placeholders cannot be saved', () => {
    assert.equal(
        buildNotificationBody(notificationFields({ goalName: ' 自定义礼品卡 ' })).rewardGoal.name,
        '自定义礼品卡'
    )
    assert.throws(() => buildNotificationBody(notificationFields({ goalName: '  ' })), /目标名称/)
    assert.throws(() => buildNotificationBody(notificationFields({ token: '***REDACTED***' })), /打码占位符/)
})

// Minimal DOM supporting the forms under test without a browser or third-party dependency.
class Element {
    constructor(tag) {
        this.tagName = tag
        this.nodeType = 1
        this.children = []
        this.events = {}
        this.style = {}
        this.checked = false
        this.disabled = false
        this.value = ''
    }
    append(...nodes) {
        this.children.push(...nodes)
    }
    replaceChildren(...nodes) {
        this.children = nodes
    }
    setAttribute(key, value) {
        this[key] = String(value)
    }
    addEventListener(name, handler) {
        this.events[name] = handler
    }
    querySelectorAll(tag) {
        return descendants(this).filter(node => node.tagName === tag)
    }
    get elements() {
        return Object.fromEntries(
            descendants(this)
                .filter(node => node.name)
                .map(node => [node.name, node])
        )
    }
}
function descendants(node) {
    return (node.children || []).flatMap(child => [child, ...descendants(child)])
}
async function withDocument(run) {
    const previous = globalThis.document
    const main = new Element('main')
    globalThis.document = {
        createElement: tag => new Element(tag),
        createElementNS: (_, tag) => new Element(tag),
        createTextNode: text => ({ nodeType: 3, textContent: text }),
        getElementById: () => main
    }
    try {
        await run(main)
    } finally {
        if (previous === undefined) delete globalThis.document
        else globalThis.document = previous
    }
}
const makeState = () => ({
    routeGeneration: 1,
    me: { authenticated: true, demo: true, capabilities: { configWrite: true, scheduleWrite: true } }
})
const submit = form => form.events.submit({ preventDefault() {} })

test('notification page never fills a returned token and saves only PATCH then GET preview', async () =>
    withDocument(async main => {
        const requests = []
        const api = async (path, options) => {
            requests.push({ path, options })
            if (path === '/config' && !options)
                return { config: { webhook: { pushplus: { token: 'must-not-display', enabled: true } } } }
            if (path === '/config') return { ok: true }
            return { content: '<b>account sample</b>', accounts: [{}], goal: { targetPoints: null } }
        }
        const { viewNotifications } = createNotificationsView({ api, state: makeState(), toast() {} })
        await viewNotifications()
        const form = main.querySelectorAll('form')[0]
        assert.equal(form.elements.token.value, '')
        assert.equal(main.querySelectorAll('pre')[0].textContent, '<b>account sample</b>')
        await submit(form)
        assert.deepEqual(
            requests.map(r => [r.path, r.options?.method || 'GET']),
            [
                ['/config', 'GET'],
                ['/notifications/preview', 'GET'],
                ['/config', 'PATCH'],
                ['/notifications/preview', 'GET']
            ]
        )
        assert.equal(Object.hasOwn(requests[2].options.body.webhook.pushplus, 'token'), false)
    }))

test('failed notification save reports error without success or refreshing preview', async () =>
    withDocument(async main => {
        const toasts = []
        let previews = 0
        const api = async (path, options) => {
            if (options) throw new Error('permission denied')
            if (path === '/config') return { config: {} }
            previews++
            return { content: 'sample', accounts: [], goal: {} }
        }
        await createNotificationsView({
            api,
            state: makeState(),
            toast: (...args) => toasts.push(args)
        }).viewNotifications()
        await submit(main.querySelectorAll('form')[0])
        assert.equal(previews, 1)
        assert.deepEqual(toasts, [['保存失败：permission denied', 'error']])
    }))

test('notification loading after route change cannot mount stale content', async () =>
    withDocument(async main => {
        const state = makeState()
        let resolve
        const pending = new Promise(done => {
            resolve = done
        })
        const mounting = createNotificationsView({ api: () => pending, state, toast() {} }).viewNotifications()
        state.routeGeneration++
        resolve({ config: {} })
        await mounting
        assert.equal(main.querySelectorAll('form').length, 0)
    }))

test('schedule demo save uses returned server configuration and never claims cron applied', async () =>
    withDocument(async main => {
        const toasts = []
        const requests = []
        const api = async (path, options) => {
            requests.push({ path, options })
            if (path === '/accounts') return { accounts: [{ index: 1 }, { index: 2 }] }
            if (options)
                return {
                    enabled: false,
                    cron: '0 9 * * *',
                    timezone: 'UTC',
                    excludedAccountIndexes: [2],
                    updatedAt: '2026-01-01T00:00:00Z'
                }
            return { writable: true, enabled: true, cron: '0 7 * * *', excludedAccountIndexes: [] }
        }
        await createSettingsViews({ api, state: makeState(), toast: (...args) => toasts.push(args) }).viewSchedule()
        const form = main.querySelectorAll('form')[0]
        form.elements.excluded.value = '2,2'
        await submit(form)
        assert.deepEqual(requests.at(-1).options.body.excludedAccountIndexes, [2])
        assert.equal(form.elements.enabled.checked, false)
        assert.equal(form.elements.cron.value, '0 9 * * *')
        assert.equal(form.elements.excluded.value, '2')
        assert.match(toasts[0][0], /不会执行真实 cron/)
        assert.equal(toasts[0][1], 'success')
    }))

test('schedule apply failure preserves edit inputs and reports no success', async () =>
    withDocument(async main => {
        const toasts = []
        const api = async (path, options) => {
            if (options) throw new Error('cron apply failed; previous schedule restored')
            if (path === '/accounts') return { accounts: [] }
            return { writable: true, enabled: true, cron: '0 7 * * *', excludedAccountIndexes: [] }
        }
        const state = makeState()
        state.me.demo = false
        await createSettingsViews({ api, state, toast: (...args) => toasts.push(args) }).viewSchedule()
        const form = main.querySelectorAll('form')[0]
        form.elements.cron.value = '0 8 * * *'
        await submit(form)
        assert.equal(form.elements.cron.value, '0 8 * * *')
        assert.equal(form.elements.cron.disabled, false)
        assert.equal(toasts.length, 1)
        assert.equal(toasts[0][1], 'error')
        assert.match(toasts[0][0], /cron apply failed/)
    }))
