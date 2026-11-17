import { createSettingsViews } from './settings.js'
import { createLogsView } from './logs.js'
import { createPointsView } from './points.js'
import { createAccountsView } from './accounts.js'
import { createNotificationsView } from './notifications.js'
import { createApi, h, icon, setBusy } from './ui.js'
import { createDashboard } from './dashboard.js'

;(() => {
    const app = document.getElementById('app')
    const api = createApi()
    let authGeneration = 0
    let runBusy = false
    const state = {
        me: null,
        es: null,
        sseReady: false,
        logs: [],
        logFilter: 'all',
        logAutoScroll: true,
        routeGeneration: 0,
        currentRun: null
    }
    function toast(message, type = 'info') {
        const box = document.getElementById('toasts')
        const item = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, String(message))
        box.append(item)
        setTimeout(() => item.remove(), type === 'error' ? 8000 : 4000)
    }
    const dashboard = createDashboard({ api, state, startRun, stopRun, onUnauthorized: renderLogin, updateSseBadge })
    const accounts = createAccountsView({ api, state, toast })
    const { viewPoints } = createPointsView({ api, state, toast })
    const logs = createLogsView({ api, state, toast, renderPromptBanner })
    const { viewSchedule, viewConfig, viewTools } = createSettingsViews({ api, state, toast })
    const { viewNotifications } = createNotificationsView({ api, state, toast })
    function disposeViews() {
        dashboard.dispose()
        accounts.dispose()
        logs.dispose()
    }

    function brand() {
        return h(
            'div',
            { class: 'brand' },
            h('span', { class: 'brand-mark' }, icon('spark')),
            h('div', {}, 'Rewards', h('small', {}, '管理控制台'))
        )
    }
    function renderLogin() {
        authGeneration++
        disposeViews()
        state.routeGeneration++
        state.me = null
        window.onhashchange = null
        disconnectSse()
        app.replaceChildren(
            h(
                'div',
                { class: 'login-wrap' },
                h(
                    'section',
                    { class: 'login-story' },
                    brand(),
                    h(
                        'div',
                        { class: 'login-story-content' },
                        h('span', { class: 'eyebrow' }, 'MICROSOFT REWARDS'),
                        h('h1', {}, '每一次运行，', h('br'), '尽在掌握。'),
                        h('p', {}, '账号、积分与运行状态，一个清晰有序的工作空间。'),
                        h(
                            'div',
                            { class: 'login-features' },
                            [
                                ['users', '账号集中管理'],
                                ['chart', '积分趋势一览'],
                                ['shield', '运行状态实时可见']
                            ].map(([name, text]) => h('div', {}, icon(name), text))
                        )
                    ),
                    h('div', { class: 'login-story-footer' }, 'REWARDS CONTROL CENTER')
                ),
                h(
                    'div',
                    { class: 'login-form-panel' },
                    h(
                        'form',
                        { class: 'login-box', onsubmit: onLogin },
                        h('div', { class: 'login-mobile-brand' }, brand()),
                        h('span', { class: 'eyebrow' }, '欢迎回来'),
                        h('h2', {}, '登录管理控制台'),
                        h('p', { class: 'login-description' }, '使用管理员凭据，继续管理您的 Rewards。'),
                        h(
                            'label',
                            { class: 'f' },
                            '用户名',
                            h('input', {
                                type: 'text',
                                name: 'username',
                                autocomplete: 'username',
                                value: 'admin',
                                required: true
                            })
                        ),
                        h(
                            'label',
                            { class: 'f' },
                            '密码',
                            h('input', {
                                type: 'password',
                                name: 'password',
                                autocomplete: 'current-password',
                                placeholder: '请输入管理员密码',
                                required: true
                            })
                        ),
                        h('button', { class: 'btn primary login-submit', type: 'submit' }, '登录控制台', icon('arrow')),
                        h('p', { class: 'login-note' }, icon('shield'), '凭据由服务器环境配置管理'),
                        h(
                            'details',
                            { class: 'login-help' },
                            h('summary', {}, '登录凭据配置说明'),
                            h('p', { class: 'hint' }, '在 .env 中配置 DASHBOARD_USERNAME 与 DASHBOARD_PASSWORD。')
                        )
                    )
                )
            )
        )
    }
    async function onLogin(event) {
        event.preventDefault()
        const form = event.target
        const button = form.querySelector('button[type=submit]')
        if (button.disabled) return
        const generation = authGeneration
        setBusy(button, true, '正在登录…')
        try {
            await api('/auth/login', {
                method: 'POST',
                body: { username: form.elements.username.value.trim(), password: form.elements.password.value }
            })
            if (generation === authGeneration) await loadMe()
        } catch (err) {
            if (generation === authGeneration) toast(err.message, 'error')
        } finally {
            setBusy(button, false, '登录控制台')
        }
    }
    async function loadMe() {
        const generation = authGeneration
        let me
        try {
            me = await api('/auth/me')
        } catch {
            me = { authenticated: false }
        }
        if (generation !== authGeneration) return
        state.me = me
        if (me.authenticated) renderApp()
        else renderLogin()
    }

    function connectSse() {
        if (state.es) return
        const generation = authGeneration
        const es = new EventSource('/events')
        state.es = es
        const current = () => state.es === es && generation === authGeneration && state.me?.authenticated
        es.onopen = () => {
            if (current()) {
                state.sseReady = true
                updateSseBadge()
            }
        }
        es.onerror = () => {
            if (current()) {
                state.sseReady = false
                updateSseBadge()
            }
        }
        const handleStatus = event => {
            if (!current()) return
            try {
                const data = JSON.parse(event.data)
                state.currentRun = data
                state.prompt = data.prompt || null
                renderPromptBanner()
                if ((location.hash || '#/dashboard').split('?')[0] === '#/dashboard') dashboard.updateStatus(data)
            } catch {
                /* invalid event */
            }
        }
        es.addEventListener('status', handleStatus)
        es.addEventListener('hello', handleStatus)
        es.addEventListener('log', event => {
            if (!current()) return
            try {
                logs.receiveLog(JSON.parse(event.data))
            } catch {
                /* invalid event */
            }
        })
    }
    function disconnectSse() {
        state.es?.close()
        state.es = null
        state.sseReady = false
        state.currentRun = null
        state.prompt = null
        state.logs = []
    }
    const NAV = [
        ['#/dashboard', 'grid', '运行总览', '实时掌握运行状态与账号积分'],
        ['#/accounts', 'users', '账号管理', '管理账号与网络配置'],
        ['#/points', 'chart', '积分历史', '回顾积分增长与运行表现'],
        ['#/logs', 'terminal', '实时日志', '跟踪运行过程与控制台交互'],
        ['#/schedule', 'clock', '运行调度', '配置自动运行时间'],
        ['#/notifications', 'bell', '通知', '配置推送与兑换目标，预览通知内容'],
        ['#/config', 'sliders', '行为配置', '按需调整任务与行为'],
        ['#/tools', 'shield', '会话与诊断', '管理登录会话与错误记录']
    ]
    function renderPromptBanner() {
        const consoleInput = document.querySelector('#console-input-form input')
        if (consoleInput)
            consoleInput.placeholder = state.prompt
                ? `等待验证：${state.prompt.question}`
                : '输入验证码、安全邮箱等内容，按 Enter 发送…'
        const slot = document.getElementById('global-prompt-slot')
        if (!slot) return
        const prompt = state.prompt
        const key = prompt ? String(prompt.id ?? prompt.requestedAt ?? prompt.question) : ''
        if (slot.dataset.promptKey === key) return
        slot.dataset.promptKey = key
        slot.replaceChildren()
        if (!prompt) return
        const generation = authGeneration
        let submitting = false
        slot.append(
            h(
                'div',
                { class: 'prompt-banner-card' },
                h(
                    'div',
                    { class: 'prompt-banner-title' },
                    icon('shield'),
                    h('strong', {}, '需要完成安全验证'),
                    h('span', { class: 'badge yellow' }, '等待输入')
                ),
                h('p', { class: 'prompt-banner-question' }, prompt.question),
                h(
                    'form',
                    {
                        class: 'prompt-banner-form',
                        onsubmit: async event => {
                            event.preventDefault()
                            if (submitting || generation !== authGeneration) return
                            const form = event.target
                            const input = form.querySelector('input')
                            const button = form.querySelector('button')
                            const value = input.value.trim()
                            if (!value) return toast('请输入有效内容后再提交', 'warn')
                            submitting = true
                            setBusy(button, true, '正在提交…')
                            try {
                                await api('/input', { method: 'POST', body: { input: value } })
                                if (generation !== authGeneration) return
                                toast('验证信息已提交', 'success')
                                if (state.prompt === prompt) {
                                    state.prompt = null
                                    renderPromptBanner()
                                }
                            } catch (err) {
                                if (generation === authGeneration) toast(`提交失败：${err.message}`, 'error')
                            } finally {
                                submitting = false
                                setBusy(button, false, '提交验证')
                            }
                        }
                    },
                    h('input', {
                        type: 'text',
                        name: 'input',
                        'aria-label': '安全验证信息',
                        placeholder: '请输入安全邮箱或验证码…',
                        autocomplete: 'off'
                    }),
                    h('button', { type: 'submit', class: 'btn primary' }, '提交验证')
                )
            )
        )
    }
    function renderApp() {
        disposeViews()
        if (!location.hash) history.replaceState(null, '', '#/dashboard')
        app.replaceChildren(
            h(
                'div',
                { class: 'layout' },
                h(
                    'aside',
                    { class: 'sidebar' },
                    brand(),
                    h('div', { class: 'nav-label' }, '工作空间'),
                    h(
                        'nav',
                        { class: 'nav-list', 'aria-label': '主导航' },
                        NAV.map(([hash, name, label]) =>
                            h(
                                'a',
                                { class: 'nav-item', 'data-nav': hash, href: hash },
                                icon(name),
                                h('span', {}, label)
                            )
                        )
                    ),
                    h('div', { class: 'spacer' }),
                    h(
                        'div',
                        { class: 'sidebar-note' },
                        icon('shield'),
                        h('div', {}, '专属管理空间', h('small', {}, `版本 ${state.me.version ?? '—'}`))
                    ),
                    h(
                        'div',
                        { class: 'sidebar-footer' },
                        h(
                            'div',
                            { class: 'avatar' },
                            String(state.me.username || 'A')
                                .slice(0, 1)
                                .toUpperCase()
                        ),
                        h(
                            'div',
                            { class: 'admin-info' },
                            h('strong', {}, state.me.username || '管理员'),
                            h('small', {}, '管理员')
                        ),
                        h(
                            'button',
                            {
                                class: 'btn icon-btn ghost',
                                type: 'button',
                                title: '退出登录',
                                'aria-label': '退出登录',
                                onclick: onLogout
                            },
                            icon('logout')
                        )
                    )
                ),
                h(
                    'div',
                    { class: 'workspace' },
                    h(
                        'header',
                        { class: 'topbar' },
                        h(
                            'div',
                            { class: 'breadcrumb' },
                            h('span', {}, '工作空间'),
                            h('span', { 'aria-hidden': 'true' }, '/'),
                            h('strong', { id: 'route-label' }, '运行总览')
                        ),
                        h(
                            'div',
                            { class: 'topbar-right' },
                            h('span', { id: 'sse-badge', class: 'connection-status' }, '实时连接中'),
                            h('span', { class: 'topbar-product' }, 'Rewards Console')
                        )
                    ),
                    state.me.demo
                        ? h(
                              'div',
                              { class: 'demo-banner', role: 'status' },
                              '演示预览 · 当前展示的是示例数据，操作不会影响真实账号。'
                          )
                        : null,
                    h('div', { id: 'global-prompt-slot' }),
                    h('main', { class: 'main', id: 'main', tabIndex: -1 })
                )
            )
        )
        connectSse()
        updateSseBadge()
        window.onhashchange = route
        route()
    }
    async function onLogout(event) {
        event.preventDefault()
        // Close dialogs and invalidate outstanding requests before the network response.
        renderLogin()
        const generation = authGeneration
        const loginButton = app.querySelector('button[type="submit"]')
        setBusy(loginButton, true, '正在退出…')
        try {
            await api('/auth/logout', { method: 'POST' })
        } catch (err) {
            if (generation === authGeneration) toast(`退出请求失败：${err.message}`, 'error')
        } finally {
            if (generation === authGeneration) setBusy(loginButton, false, '登录控制台')
        }
    }
    function updateSseBadge() {
        const badge = document.getElementById('sse-badge')
        if (!badge) return
        badge.className = `connection-status ${state.sseReady ? 'connected' : 'disconnected'}`
        badge.textContent = state.sseReady ? '实时连接正常' : '实时连接中断'
    }
    function route() {
        if (!state.me?.authenticated) return
        disposeViews()
        const generation = ++state.routeGeneration
        const main = document.getElementById('main')
        if (!main) return
        const hash = (location.hash || '#/dashboard').split('?')[0]
        const nav = NAV.find(([path]) => path === hash) || NAV[0]
        for (const el of document.querySelectorAll('[data-nav]')) {
            const active = el.getAttribute('data-nav') === nav[0]
            el.classList.toggle('active', active)
            if (active) el.setAttribute('aria-current', 'page')
            else el.removeAttribute('aria-current')
        }
        document.getElementById('route-label').textContent = nav[2]
        document.title = `${nav[2]} · Rewards 控制台`
        renderPromptBanner()
        const views = {
            '#/dashboard': dashboard.mount,
            '#/accounts': accounts.viewAccounts,
            '#/points': viewPoints,
            '#/logs': logs.viewLogs,
            '#/schedule': viewSchedule,
            '#/notifications': viewNotifications,
            '#/config': viewConfig,
            '#/tools': viewTools
        }
        ;(views[hash] || dashboard.mount)().catch(err => {
            if (generation !== state.routeGeneration || !state.me?.authenticated) return
            if (err.status === 401) {
                renderLogin()
                return
            }
            main.replaceChildren(
                h(
                    'div',
                    { class: 'card inline-error', role: 'alert' },
                    h('h2', {}, '页面暂时无法加载'),
                    h('p', {}, err.message),
                    h('button', { class: 'btn', onclick: route }, '重新加载')
                )
            )
        })
    }
    async function runAction(path, body, message) {
        if (runBusy || !state.me?.authenticated) return
        const generation = authGeneration
        runBusy = true
        state.runBusy = true
        dashboard.updateStatus(state.currentRun)
        try {
            await api(path, { method: 'POST', body })
            if (generation !== authGeneration) return
            toast(message, 'success')
            dashboard.refresh()
        } catch (err) {
            if (generation === authGeneration)
                toast(err.code === 'ALREADY_RUNNING' ? '已有任务正在运行' : err.message, 'error')
        } finally {
            runBusy = false
            state.runBusy = false
            if (generation === authGeneration) dashboard.updateStatus(state.currentRun)
        }
    }
    function startRun({ restart = false } = {}) {
        return runAction(restart ? '/restart' : '/start', {}, restart ? '重启指令已发送' : '启动指令已发送')
    }
    function stopRun() {
        return runAction('/stop', {}, '停止指令已发送')
    }
    loadMe()
})()
