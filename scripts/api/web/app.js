/* Microsoft Rewards 控制面板 — 内嵌单页应用(无依赖,原生 JS) */
(() => {
    'use strict'

    // ────────────────────────── 基础工具 ──────────────────────────
    const app = document.getElementById('app')

    function h(tag, props = {}, ...children) {
        const el = document.createElement(tag)
        for (const [key, value] of Object.entries(props)) {
            if (value == null) continue
            if (key === 'class') el.className = value
            else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value)
            else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value)
            else if (key in el && key !== 'type' && key !== 'value' && key !== 'checked' && key !== 'selected') {
                try { el[key] = value } catch { el.setAttribute(key, value) }
            } else el.setAttribute(key, value)
        }
        for (const child of children.flat()) {
            if (child == null) continue
            el.append(child.nodeType ? child : document.createTextNode(String(child)))
        }
        return el
    }

    function toast(message, type = 'info') {
        const box = document.getElementById('toasts')
        const item = h('div', { class: `toast ${type}` }, String(message))
        box.append(item)
        setTimeout(() => item.remove(), type === 'error' ? 8000 : 4000)
    }

    async function api(path, { method = 'GET', body } = {}) {
        const res = await fetch(path, {
            method,
            headers: {
                'content-type': 'application/json',
                'x-requested-with': 'XMLHttpRequest'
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        })
        let data = null
        try { data = await res.json() } catch { /* non-json */ }
        if (!res.ok) {
            const err = new Error(data?.error || `HTTP ${res.status}`)
            err.status = res.status
            err.code = data?.code
            err.data = data
            throw err
        }
        return data
    }

    const fmtInt = value => (value == null ? '—' : Number(value).toLocaleString('zh-CN'))
    const fmtTime = iso => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—')
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

    // ────────────────────────── 全局状态 ──────────────────────────
    const state = {
        me: null,
        es: null,
        sseReady: false,
        logs: [],
        logFilter: 'all',
        logAutoScroll: true,
        dashTimer: null,
        currentRun: null
    }

    // ────────────────────────── 登录 ──────────────────────────
    function renderLogin() {
        disconnectSse()
        app.innerHTML = ''
        app.append(
            h('div', { class: 'login-wrap' },
                h('form', { class: 'login-box', onsubmit: onLogin },
                    h('div', { class: 'brand' }, '🥇 Microsoft Rewards 控制面板',
                        h('small', {}, '内嵌 WebUI · 登录后管理账号 / 代理 / 积分 / 调度')),
                    h('label', { class: 'f' }, '用户名', h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'admin' })),
                    h('label', { class: 'f' }, '密码', h('input', { type: 'password', name: 'password', autocomplete: 'current-password' })),
                    h('div', { style: { marginTop: '18px' } },
                        h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', justifyContent: 'center' } }, '登 录')),
                    h('p', { class: 'hint', style: { textAlign: 'center', marginTop: '12px' } },
                        '账号在 .env 中通过 DASHBOARD_USERNAME / DASHBOARD_PASSWORD 配置')
                )
            )
        )
    }

    async function onLogin(event) {
        event.preventDefault()
        const form = event.target
        const button = form.querySelector('button[type=submit]')
        button.disabled = true
        try {
            await api('/auth/login', {
                method: 'POST',
                body: { username: form.username.value.trim(), password: form.password.value }
            })
            await loadMe()
        } catch (err) {
            toast(err.message, 'error')
        } finally {
            button.disabled = false
        }
    }

    async function loadMe() {
        try {
            state.me = await api('/auth/me')
        } catch {
            state.me = { authenticated: false }
        }
        if (state.me.authenticated) renderApp()
        else renderLogin()
    }

    // ────────────────────────── SSE ──────────────────────────
    function connectSse() {
        if (state.es) return
        const es = new EventSource('/events')
        state.es = es
        es.onopen = () => { state.sseReady = true; updateSseBadge() }
        es.onerror = () => { state.sseReady = false; updateSseBadge() }
        const handleStatus = event => {
            try {
                const data = JSON.parse(event.data)
                state.currentRun = data
                state.prompt = data.prompt || null
                renderPromptBanner()
            } catch { /* ignore */ }
            if (location.hash.startsWith('#/dashboard') || location.hash === '') refreshDashboard()
        }
        es.addEventListener('status', handleStatus)
        es.addEventListener('hello', handleStatus)
        es.addEventListener('log', event => {
            try {
                const entry = JSON.parse(event.data)
                state.logs.push(entry)
                if (state.logs.length > 2000) state.logs.splice(0, state.logs.length - 2000)
                if (location.hash.startsWith('#/logs')) appendLogLine(entry)
            } catch { /* ignore */ }
        })
    }

    function disconnectSse() {
        if (state.es) { state.es.close(); state.es = null }
        state.sseReady = false
        state.logs = []
    }

    // ────────────────────────── 布局 ──────────────────────────
    const NAV = [
        ['#/dashboard', '📊 总览'],
        ['#/accounts', '👤 账号管理'],
        ['#/points', '💰 积分历史'],
        ['#/logs', '📜 实时日志'],
        ['#/schedule', '⏰ 运行调度'],
        ['#/config', '⚙️ 行为配置'],
        ['#/tools', '🧰 会话与诊断']
    ]

    function updateConsolePlaceholder() {
        const inp = document.querySelector('#console-input-form input')
        if (inp) {
            inp.placeholder = state.prompt
                ? `【等待验证输入】${state.prompt.question}（输入后按 Enter 发送）`
                : '向运行中的脚本控制台输入内容(验证码、安全邮箱等)，按 Enter 发送…'
        }
    }

    function renderPromptBanner() {
        updateConsolePlaceholder()
        const slot = document.getElementById('global-prompt-slot')
        if (!slot) return
        slot.innerHTML = ''
        const prompt = state.prompt
        if (!prompt) return

        const card = h('div', { class: 'prompt-banner-card' },
            h('div', { class: 'prompt-banner-header' },
                h('div', { class: 'prompt-banner-title' },
                    h('span', { class: 'prompt-pulse' }, '🔐'),
                    h('strong', {}, '登录安全验证交互请求'),
                    h('span', { class: 'badge yellow', style: { marginLeft: '8px' } }, '等待人工交互输入')
                )
            ),
            h('div', { class: 'prompt-banner-question' }, prompt.question),
            h('form', {
                class: 'prompt-banner-form',
                onsubmit: async event => {
                    event.preventDefault()
                    const form = event.target
                    const inputEl = form.querySelector('input[name="input"]')
                    const btn = form.querySelector('button')
                    const val = inputEl ? inputEl.value.trim() : ''
                    if (!val) {
                        toast('请输入有效内容后再提交', 'warn')
                        return
                    }
                    btn.disabled = true
                    btn.textContent = '正在提交…'
                    try {
                        await api('/input', { method: 'POST', body: { input: val } })
                        toast('验证信息已成功提交至机器人进程！', 'ok')
                        state.prompt = null
                        slot.innerHTML = ''
                        updateConsolePlaceholder()
                    } catch (err) {
                        toast(`提交失败: ${err.message}`, 'error')
                        btn.disabled = false
                        btn.textContent = '提交输入'
                    }
                }
            },
                h('input', {
                    type: 'text',
                    name: 'input',
                    class: 'prompt-banner-input',
                    placeholder: '请输入用于接收验证码的安全邮箱或 6 位验证码…',
                    autofocus: true,
                    autocomplete: 'off'
                }),
                h('button', { type: 'submit', class: 'btn primary' }, '提交输入')
            )
        )
        slot.append(card)
    }

    function renderApp() {
        connectSse()
        if (!location.hash) location.hash = '#/dashboard'
        app.innerHTML = ''
        app.append(
            h('div', { class: 'layout' },
                h('nav', { class: 'sidebar' },
                    h('div', { class: 'brand' }, '🥇 Rewards 控制面板',
                        h('small', {}, `v${state.me.version ?? '?'} · 内嵌 WebUI`)),
                    NAV.map(([hash, label]) => h('a', { class: 'nav-item', 'data-nav': hash, href: hash }, label)),
                    h('div', { class: 'spacer' }),
                    h('div', { class: 'footer' },
                        h('span', { id: 'sse-badge', class: 'badge gray' }, 'SSE 连接中…'),
                        h('div', { style: { marginTop: '8px' } },
                            h('a', { href: '#', onclick: onLogout }, '退出登录')))
                ),
                h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100vh', overflowY: 'auto' } },
                    h('div', { id: 'global-prompt-slot', style: { padding: '16px 24px 0' } }),
                    h('main', { class: 'main', id: 'main' })
                )
            )
        )
        window.onhashchange = route
        route()
    }

    async function onLogout(event) {
        event.preventDefault()
        try { await api('/auth/logout', { method: 'POST' }) } catch { /* ignore */ }
        state.me = null
        renderLogin()
    }

    function updateSseBadge() {
        const badge = document.getElementById('sse-badge')
        if (!badge) return
        badge.className = `badge ${state.sseReady ? 'green' : 'red'}`
        badge.textContent = state.sseReady ? 'SSE 已连接' : 'SSE 断开'
    }

    function setActiveNav() {
        const hash = location.hash || '#/dashboard'
        for (const el of document.querySelectorAll('[data-nav]')) {
            el.classList.toggle('active', el.getAttribute('data-nav') === hash)
        }
    }

    function route() {
        setActiveNav()
        renderPromptBanner()
        if (state.dashTimer) { clearInterval(state.dashTimer); state.dashTimer = null }
        const main = document.getElementById('main')
        if (!main) return
        const hash = (location.hash || '#/dashboard').split('?')[0]
        const views = {
            '#/dashboard': viewDashboard,
            '#/accounts': viewAccounts,
            '#/points': viewPoints,
            '#/logs': viewLogs,
            '#/schedule': viewSchedule,
            '#/config': viewConfig,
            '#/tools': viewTools
        }
        ;(views[hash] || viewDashboard)().catch(err => {
            main.innerHTML = ''
            main.append(h('div', { class: 'card' }, `页面加载失败:${esc(err.message)}`, h('pre', { style: { fontSize: '11px', color: 'var(--text-dim)', whiteSpace: 'pre-wrap' } }, String(err.stack || ''))))
            if (err.status === 401) renderLogin()
        })
    }

    // ────────────────────────── 总览 ──────────────────────────
    async function viewDashboard() {
        const main = document.getElementById('main')
        main.innerHTML = ''
        main.append(
            h('div', { class: 'page-title' }, '总览',
                h('button', { class: 'btn primary', id: 'btn-start', onclick: () => startRun({}) }, '▶ 启动(全部账号)'),
                h('button', { class: 'btn danger', id: 'btn-stop', onclick: stopRun }, '⏹ 停止'),
                h('button', { class: 'btn', onclick: () => startRun({ restart: true }) }, '↻ 重启')),
            h('div', { class: 'grid cols-4', id: 'dash-cards' }),
            h('h3', { style: { margin: '18px 0 10px', color: 'var(--text-dim)' } }, '各账号实时积分'),
            h('div', { class: 'table-wrap', id: 'dash-accounts' }, h('p', { style: { padding: '14px', color: 'var(--text-dim)' } }, '加载中…'))
        )
        await refreshDashboard()
        state.dashTimer = setInterval(refreshDashboard, 5000)
    }

    async function refreshDashboard() {
        const startBtn = document.getElementById('btn-start')
        const stopBtn = document.getElementById('btn-stop')
        try {
            const [status, points] = await Promise.all([api('/status'), api('/points')])
            const running = status.state !== 'idle'
            if (startBtn) startBtn.disabled = running
            if (stopBtn) stopBtn.disabled = !running

            const run = points || {}
            const cards = [
                ['运行状态', run.running ? '运行中' : run.finished ? '已完成' : '空闲',
                    run.running ? 'green' : run.finished ? 'blue' : 'gray',
                    run.startedAt ? `开始于 ${fmtTime(run.startedAt)}` : '通过 ▶ 启动任务'],
                ['当前账号', run.currentAccount || '—', run.currentAccount ? 'yellow' : 'gray',
                    run.updatedAt ? `更新于 ${fmtTime(run.updatedAt)}` : ''],
                ['本次已获得', fmtInt(run.collected ?? 0), 'green',
                    `完成 ${run.accountsSeen ?? 0}/${run.accountsTotal ?? 0} 个账号`],
                ['当前余额', run.balance != null ? fmtInt(run.balance) : '—', 'blue',
                    run.finished ? '本轮运行已结束' : '']
            ]
            const cardsEl = document.getElementById('dash-cards')
            if (cardsEl) {
                cardsEl.innerHTML = ''
                for (const [title, value, color, dim] of cards) {
                    cardsEl.append(h('div', { class: 'card' },
                        h('h3', {}, title),
                        h('div', { class: `big` },
                            h('span', { class: `dot ${color}` }), String(value)),
                        h('div', { class: 'dim' }, dim)))
                }
            }

            const wrap = document.getElementById('dash-accounts')
            if (wrap) {
                wrap.innerHTML = ''
                const accounts = run.accounts || []
                if (!accounts.length) {
                    wrap.append(h('p', { style: { padding: '14px', color: 'var(--text-dim)' } },
                        '暂无账号数据。运行一次后这里会显示每个账号的实时积分。'))
                } else {
                    const table = h('table', {},
                        h('thead', {}, h('tr', {},
                            ['账号', '本次获得', '当前余额', '初始积分', '状态', '连击保护', 'Edge 浏览'].map(x => h('th', {}, x)))),
                        h('tbody', {}, accounts.map(account => h('tr', {},
                            h('td', { class: 'wrap' }, account.email),
                            h('td', {}, fmtInt(account.collected ?? 0)),
                            h('td', {}, account.balance != null ? fmtInt(account.balance) : '—'),
                            h('td', {}, account.initialPoints != null ? fmtInt(account.initialPoints) : '—'),
                            h('td', {}, account.done
                                ? (account.success ? h('span', { class: 'badge green' }, '成功') : h('span', { class: 'badge red', title: account.error || '' }, '失败'))
                                : (account.inProgress ? h('span', { class: 'badge yellow' }, '进行中') : h('span', { class: 'badge gray' }, '等待'))),
                            h('td', {}, account.streakProtection == null ? '—' : account.streakProtection),
                            h('td', {}, account.edgeBrowsing == null ? '—' : account.edgeBrowsing)))))
                    wrap.append(table)
                }
            }
        } catch (err) {
            if (err.status === 401) { renderLogin(); return }
            // 静默重试,避免轮询刷屏
        }
        updateSseBadge()
    }

    async function startRun({ restart = false } = {}) {
        try {
            const path = restart ? '/restart' : '/start'
            const body = restart ? {} : {}
            await api(path, { method: 'POST', body })
            toast(restart ? '重启指令已发送' : '启动指令已发送', 'success')
            setTimeout(refreshDashboard, 800)
        } catch (err) {
            if (err.code === 'ALREADY_RUNNING') toast('已有任务在运行中', 'error')
            else toast(err.message, 'error')
        }
    }

    async function stopRun() {
        try {
            await api('/stop', { method: 'POST', body: {} })
            toast('停止指令已发送', 'success')
        } catch (err) {
            toast(err.message, 'error')
        }
    }

    // ────────────────────────── 账号管理 ──────────────────────────
    async function viewAccounts() {
        const main = document.getElementById('main')
        main.innerHTML = ''
        const writable = state.me.capabilities?.accountWrite
        main.append(
            h('div', { class: 'page-title' }, '账号管理',
                h('button', { class: 'btn primary', disabled: !writable, onclick: () => openAccountModal(null) }, '＋ 新增账号'),
                h('span', { class: 'hint' }, writable ? '新增/修改写入 config/accounts.env,下次运行生效' : '账号写入已被禁用(API_ALLOW_ACCOUNT_WRITE=false)')),
            h('div', { class: 'table-wrap', id: 'acc-table' }, h('p', { style: { padding: '14px', color: 'var(--text-dim)' } }, '加载中…')),
            h('p', { class: 'hint', style: { marginTop: '10px' } },
                '💡 防封建议:每个账号固定使用独立代理 IP(推荐住宅/ISP 静态代理),避免多账号共用同一出口 IP;SOCKS 代理不支持账号密码认证。')
        )
        await refreshAccounts()
    }

    async function refreshAccounts() {
        const wrap = document.getElementById('acc-table')
        if (!wrap) return
        let data
        try { data = await api('/accounts') } catch (err) { wrap.innerHTML = ''; wrap.append(h('p', { style: { padding: '14px', color: 'var(--red)' } }, esc(err.message))); return }

        wrap.innerHTML = ''
        if (!data.accounts.length) {
            wrap.append(h('p', { style: { padding: '14px', color: 'var(--text-dim)' } },
                '还没有任何账号。点击右上角「新增账号」添加,或在 .env 中手工配置。'))
            return
        }

        wrap.append(h('table', {},
            h('thead', {}, h('tr', {},
                ['#', '邮箱', '配置', '语言/地区', '代理', '来源', '近期战绩', '操作'].map(x => h('th', {}, x)))),
            h('tbody', {}, data.accounts.map(account => {
                const proxyBadge = account.proxy
                    ? h('span', { class: 'badge blue', title: account.proxy.url + (account.proxy.port ? ':' + account.proxy.port : '') },
                        `${account.proxy.url.split(':')[0]}://${account.proxy.port ?? ''}${account.proxy.hasCredentials ? ' 🔑' : ''}`)
                    : h('span', { class: 'badge gray' }, '直连')
                return h('tr', {},
                    h('td', {}, `ACCOUNT_${account.index}`),
                    h('td', { class: 'wrap' }, account.email),
                    h('td', {},
                        account.hasPassword ? h('span', { class: 'badge gray' }, '密码') : h('span', { class: 'badge yellow' }, '无密码'),
                        account.hasTotp ? h('span', { class: 'badge green' }, '2FA') : '',
                        account.saveFingerprint?.mobile || account.saveFingerprint?.desktop ? h('span', { class: 'badge gray' }, '指纹保存') : ''),
                    h('td', {}, `${account.langCode} / ${account.geoLocale}`),
                    h('td', {}, proxyBadge),
                    h('td', {}, account.source === 'web' ? h('span', { class: 'badge green' }, 'WebUI') : h('span', { class: 'badge gray', title: '来自 .env,仅可在文件中修改' }, '.env')),
                    h('td', {},
                        h('span', { title: `成功连击 ${account.successStreak ?? 0}` }, `runs ${account.runs ?? 0} · 累计 ${fmtInt(account.totalCollected ?? 0)} 分`),
                        account.lastRunAt ? h('div', { class: 'hint' }, `最近 ${fmtTime(account.lastRunAt)}:${account.lastSuccess === true ? '✅' : account.lastSuccess === false ? '❌' : '—'} +${fmtInt(account.lastCollected ?? 0)}`) : ''),
                    h('td', {},
                        h('button', { class: 'btn small', onclick: () => testProxy(account) }, '测代理'),
                        ' ',
                        h('button', { class: 'btn small primary', onclick: () => startRunSingle(account.index) }, '只跑此号'),
                        ' ',
                        account.webManaged
                            ? h('button', { class: 'btn small', onclick: () => openAccountModal(account) }, '编辑')
                            : h('button', { class: 'btn small', disabled: true, title: '.env 账号请在文件中修改' }, '编辑'),
                        ' ',
                        account.webManaged
                            ? h('button', { class: 'btn small danger', onclick: () => deleteAccount(account) }, '删除')
                            : h('button', { class: 'btn small danger', disabled: true, title: '.env 账号请在文件中删除' }, '删除'))
                )
            }))))
    }

    async function startRunSingle(index) {
        try {
            await api('/start', { method: 'POST', body: { accountIndex: index } })
            toast(`已启动 ACCOUNT_${index}`, 'success')
            location.hash = '#/dashboard'
        } catch (err) {
            toast(err.message, 'error')
        }
    }

    async function testProxy(account) {
        toast(`正在测试 ${account.email} 的代理…`)
        try {
            const result = await api(`/accounts/${account.index}/proxy-test`, { method: 'POST', body: {} })
            if (result.ok) {
                toast(`✅ 代理连通:出口 IP ${result.ip}${result.country ? `(${result.country})` : ''},延迟 ${result.latencyMs}ms`, 'success')
            } else {
                toast(`❌ 代理测试失败:${result.error}`, 'error')
            }
        } catch (err) {
            toast(`❌ ${err.message}`, 'error')
        }
    }

    function openAccountModal(account) {
        const isEdit = Boolean(account)
        const proxy = account?.proxy || {}
        const mask = h('div', { class: 'modal-mask', onclick: event => { if (event.target === mask) mask.remove() } })
        const form = h('form', {
            onsubmit: async event => {
                event.preventDefault()
                const fd = form.elements
                const body = {
                    email: fd.email.value.trim(),
                    password: fd.password.value,
                    totpSecret: fd.totp.value.trim(),
                    recoveryEmail: fd.recovery.value.trim(),
                    langCode: fd.lang.value.trim(),
                    geoLocale: fd.geo.value.trim(),
                    proxy: {
                        url: fd.proxyUrl.value.trim(),
                        port: fd.proxyPort.value.trim(),
                        username: fd.proxyUser.value.trim(),
                        password: fd.proxyPass.value,
                        http: fd.proxyHttp.checked
                    },
                    saveFingerprint: { mobile: fd.fpMobile.checked, desktop: fd.fpDesktop.checked }
                }
                try {
                    if (isEdit) {
                        await api(`/accounts/${account.index}`, { method: 'PATCH', body })
                        toast(`ACCOUNT_${account.index} 已更新,下次运行生效`, 'success')
                    } else {
                        await api('/accounts', { method: 'POST', body })
                        toast('账号已添加,下次运行生效', 'success')
                    }
                    mask.remove()
                    await refreshAccounts()
                } catch (err) {
                    toast(err.message, 'error')
                }
            }
        },
            h('h2', {}, isEdit ? `编辑账号 ACCOUNT_${account.index}` : '新增账号'),
            h('label', { class: 'f' }, '邮箱 *', h('input', { type: 'text', name: 'email', required: true, value: account?.email ?? '' })),
            h('div', { class: 'form-row' },
                h('label', { class: 'f' }, '密码', h('input', { type: 'password', name: 'password', autocomplete: 'new-password', placeholder: isEdit ? '留空则保持不变' : '无密码账号可留空' })),
                h('label', { class: 'f' }, '2FA 密钥(TOTP Base32)', h('input', { type: 'text', name: 'totp', placeholder: '如 JBSWY3DPEHPK3PXP', value: '' }))),
            h('div', { class: 'form-row' },
                h('label', { class: 'f' }, '语言(BCP 47)', h('input', { type: 'text', name: 'lang', placeholder: 'zh-CN', value: account?.langCode === 'en' ? '' : account?.langCode ?? 'zh-CN' })),
                h('label', { class: 'f' }, '国家/地区', h('input', { type: 'text', name: 'geo', placeholder: 'CN 或 auto', value: account?.geoLocale === 'AUTO' ? 'auto' : account?.geoLocale === 'auto' ? 'auto' : account?.geoLocale ?? 'CN' }))),
            h('label', { class: 'f' }, '备用邮箱', h('input', { type: 'text', name: 'recovery', value: '' })),
            h('fieldset', {},
                h('legend', {}, '代理设置(防封:建议每账号独立静态 IP)'),
                h('label', { class: 'f' }, '代理地址', h('input', { type: 'text', name: 'proxyUrl', placeholder: 'http://1.2.3.4 或 socks5://host', value: proxy.url ?? '' })),
                h('div', { class: 'form-row' },
                    h('label', { class: 'f' }, '端口', h('input', { type: 'number', name: 'proxyPort', min: 1, max: 65535, placeholder: '8080', value: proxy.port ?? '' })),
                    h('label', { class: 'f' }, '用户名(HTTP 代理)', h('input', { type: 'text', name: 'proxyUser', value: '' }))),
                h('label', { class: 'f' }, '密码(HTTP 代理)', h('input', { type: 'password', name: 'proxyPass', autocomplete: 'new-password', value: '' })),
                h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'proxyHttp', checked: Boolean(proxy.http) }), '查询源 HTTP 请求也走此代理'),
                h('p', { class: 'hint' }, '支持 http/https/socks4/socks5;SOCKS 不支持账号认证。编辑时留空密码 = 保持原密码。')),
            h('div', { class: 'form-row' },
                h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'fpMobile', checked: account ? account.saveFingerprint?.mobile !== false : true }), '保存移动端指纹'),
                h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'fpDesktop', checked: account ? account.saveFingerprint?.desktop !== false : true }), '保存桌面端指纹')),
            h('div', { class: 'actions' },
                h('button', { class: 'btn ghost', type: 'button', onclick: () => mask.remove() }, '取消'),
                h('button', { class: 'btn primary', type: 'submit' }, isEdit ? '保存修改' : '添加账号')))
        mask.append(form)
        document.body.append(mask)
    }

    async function deleteAccount(account) {
        if (!confirm(`确定删除账号 ${account.email}(ACCOUNT_${account.index})?\n注意:这只是移除配置,不会删除已保存的登录会话。`)) return
        try {
            await api(`/accounts/${account.index}`, { method: 'DELETE' })
            toast('账号已删除', 'success')
            await refreshAccounts()
        } catch (err) {
            toast(err.message, 'error')
        }
    }

    // ────────────────────────── 积分历史 ──────────────────────────
    async function viewPoints() {
        const main = document.getElementById('main')
        main.innerHTML = ''
        main.append(
            h('div', { class: 'page-title' }, '积分历史',
                h('select', { id: 'points-days', onchange: () => refreshPoints() },
                    [7, 30, 90, 365].map(days => h('option', { value: days, selected: days === 30 }, `最近 ${days} 天`)))),
            h('div', { class: 'grid cols-3', id: 'points-cards' }),
            h('div', { class: 'card chart-box', id: 'points-chart', style: { marginBottom: '16px' } }, h('h3', {}, '每日获得积分')),
            h('h3', { style: { margin: '18px 0 10px', color: 'var(--text-dim)' } }, '分账号累计'),
            h('div', { class: 'table-wrap', id: 'points-accounts' }),
            h('h3', { style: { margin: '18px 0 10px', color: 'var(--text-dim)' } }, '运行记录'),
            h('div', { class: 'table-wrap', id: 'points-runs' })
        )
        await refreshPoints()
    }

    async function refreshPoints() {
        const days = Number(document.getElementById('points-days')?.value ?? 30)
        let data
        try { data = await api(`/points/history?days=${days}&limit=500`) } catch (err) { toast(err.message, 'error'); return }

        const cardsEl = document.getElementById('points-cards')
        cardsEl.innerHTML = ''
        for (const [title, value, color] of [
            ['运行次数', fmtInt(data.totals.runs), 'blue'],
            ['累计获得', fmtInt(data.totals.collected) + ' 分', 'green'],
            ['成功运行', fmtInt(data.totals.successes), 'orange']
        ]) {
            cardsEl.append(h('div', { class: 'card' }, h('h3', {}, title), h('div', { class: 'big' }, String(value)), h('div', { class: 'dim' }, '')))
        }

        // SVG 柱状图:每日 collected
        const chartEl = document.getElementById('points-chart')
        chartEl.innerHTML = ''
        chartEl.append(h('h3', {}, `每日获得积分(${data.daily.length} 天)`))
        chartEl.append(renderDailyChart(data.daily))
        chartEl.append(h('div', { class: 'chart-legend' },
            h('span', {}, h('i', { class: 'k', style: { background: 'var(--green)' } }), '当日积分'),
            h('span', {}, h('i', { class: 'k', style: { background: 'var(--accent)' } }), '运行次数(右轴)')))

        const accEl = document.getElementById('points-accounts')
        accEl.innerHTML = ''
        if (!data.perAccount.length) accEl.append(h('p', { style: { padding: '14px', color: 'var(--text-dim)' } }, '该时间段内暂无运行记录。'))
        else accEl.append(h('table', {},
            h('thead', {}, h('tr', {}, ['账号', '运行次数', '累计获得', '成功次数', '最近获得', '最近余额', '最近运行'].map(x => h('th', {}, x)))),
            h('tbody', {}, data.perAccount.map(account => h('tr', {},
                h('td', { class: 'wrap' }, account.email),
                h('td', {}, String(account.runs)),
                h('td', {}, fmtInt(account.totalCollected)),
                h('td', {}, String(account.successes)),
                h('td', {}, fmtInt(account.lastCollected ?? 0)),
                h('td', {}, account.lastBalance != null ? fmtInt(account.lastBalance) : '—'),
                h('td', {}, fmtTime(account.lastRunAt)))))))

        const runsEl = document.getElementById('points-runs')
        runsEl.innerHTML = ''
        if (!data.records.length) runsEl.append(h('p', { style: { padding: '14px', color: 'var(--text-dim)' } }, '无记录'))
        else runsEl.append(h('table', {},
            h('thead', {}, h('tr', {}, ['结束时间', '本次获得', '结果', '各账号'].map(x => h('th', {}, x)))),
            h('tbody', {}, data.records.slice(0, 60).map(record => h('tr', {},
                h('td', {}, fmtTime(record.endedAt || record.startedAt)),
                h('td', {}, fmtInt(record.collected ?? 0)),
                h('td', {}, record.exit?.code === 0
                    ? h('span', { class: 'badge green' }, 'exit 0')
                    : h('span', { class: 'badge red', title: record.exit?.error || `exit ${record.exit?.code}` }, `exit ${record.exit?.code ?? '?'}`)),
                h('td', { class: 'wrap' }, (record.accounts || []).map(account =>
                    `${account.email.split('@')[0]}${account.success === true ? '✅' : account.success === false ? '❌' : ''}+${account.collected ?? 0}`).join(', ') || '—'))))))
    }

    function renderDailyChart(daily) {
        if (!daily.length) return h('p', { class: 'hint' }, '暂无数据')
        const width = Math.max(daily.length * 46, 320)
        const height = 200
        const padding = { top: 20, right: 10, bottom: 26, left: 46 }
        const maxPoints = Math.max(...daily.map(day => day.collected), 1)
        const maxRuns = Math.max(...daily.map(day => day.runs), 1)
        const innerW = width - padding.left - padding.right
        const innerH = height - padding.top - padding.bottom
        const barW = Math.min(Math.floor(innerW / daily.length) - 6, 34)

        const svgNS = 'http://www.w3.org/2000/svg'
        const svg = document.createElementNS(svgNS, 'svg')
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
        const mk = (tag, attrs = {}) => { const el = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el }

        // y 轴刻度(积分)
        for (let i = 0; i <= 4; i++) {
            const value = Math.round((maxPoints / 4) * i)
            const y = padding.top + innerH - (innerH * i) / 4
            svg.append(mk('line', { x1: padding.left, y1: y, x2: width - padding.right, y2: y, stroke: '#2d3644', 'stroke-width': 1 }))
            svg.append(mk('text', { x: padding.left - 6, y: y + 4, fill: '#8b949e', 'font-size': 10, 'text-anchor': 'end' }, fmtInt(value)))
        }

        daily.forEach((day, index) => {
            const x = padding.left + (index * innerW) / daily.length + 3
            const barH = (day.collected / maxPoints) * innerH
            const y = padding.top + innerH - barH
            const rect = mk('rect', {
                x, y, width: barW, height: Math.max(barH, day.collected > 0 ? 2 : 0),
                fill: '#3fb950', rx: 3, opacity: 0.85
            })
            const title = mk('title')
            title.textContent = `${day.date}:+${day.collected} 分 / ${day.runs} 次运行`
            rect.append(title)
            svg.append(rect)
            if (daily.length <= 20 || index % Math.ceil(daily.length / 12) === 0) {
                svg.append(mk('text', { x: x + barW / 2, y: height - 8, fill: '#8b949e', 'font-size': 10, 'text-anchor': 'middle' }, day.date.slice(5)))
            }
        })
        return svg
    }

    // ────────────────────────── 实时日志 ──────────────────────────
    async function viewLogs() {
        const main = document.getElementById('main')
        main.innerHTML = ''
        main.append(
            h('div', { class: 'page-title' }, '实时日志'),
            h('div', { class: 'log-toolbar' },
                h('select', { onchange: event => { state.logFilter = event.target.value; redrawLogs() } },
                    [['all', '全部级别'], ['debug', 'DEBUG+'], ['info', 'INFO+'], ['warn', 'WARN+'], ['error', '仅 ERROR']].map(([value, label]) => h('option', { value }, label))),
                h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.logAutoScroll, onchange: event => { state.logAutoScroll = event.target.checked } }), '自动滚动'),
                h('button', { class: 'btn small', onclick: () => { state.logs = []; redrawLogs() } }, '清空显示')),
            h('div', { class: 'log-view', id: 'log-view' }),
            h('form', {
                class: 'console-input-bar',
                id: 'console-input-form',
                onsubmit: async event => {
                    event.preventDefault()
                    const form = event.target
                    const inputEl = form.querySelector('input')
                    const btn = form.querySelector('button')
                    const val = inputEl ? inputEl.value.trim() : ''
                    if (!val) return
                    btn.disabled = true
                    try {
                        await api('/input', { method: 'POST', body: { input: val } })
                        toast('已发送输入至脚本控制台', 'success')
                        inputEl.value = ''
                        if (state.prompt) {
                            state.prompt = null
                            renderPromptBanner()
                        }
                    } catch (err) {
                        toast(`发送失败: ${err.message}`, 'error')
                    } finally {
                        btn.disabled = false
                        inputEl.focus()
                    }
                }
            },
                h('span', { class: 'console-prompt-sym' }, '❯'),
                h('input', {
                    type: 'text',
                    placeholder: state.prompt
                        ? `【等待验证输入】${state.prompt.question}（输入后按 Enter 发送）`
                        : '向运行中的脚本控制台输入内容(验证码、安全邮箱等)，按 Enter 发送…',
                    autocomplete: 'off'
                }),
                h('button', { type: 'submit', class: 'btn small primary' }, '发送')
            )
        )
        // 回放最近日志
        try {
            const data = await api('/logs?limit=300')
            state.logs = data.logs.slice(-300)
        } catch { /* ignore */ }
        redrawLogs()
    }

    const levelRank = { debug: 0, info: 1, warn: 2, error: 3 }

    function redrawLogs() {
        const view = document.getElementById('log-view')
        if (!view) return
        view.innerHTML = ''
        const floor = state.logFilter === 'all' ? 0 : levelRank[state.logFilter]
        for (const entry of state.logs) {
            if ((levelRank[entry.level] ?? 1) >= floor) appendLogLine(entry, view)
        }
        view.scrollTop = view.scrollHeight
    }

    function appendLogLine(entry, viewEl) {
        const view = viewEl || document.getElementById('log-view')
        if (!view) return
        const floor = state.logFilter === 'all' ? 0 : levelRank[state.logFilter]
        if ((levelRank[entry.level] ?? 1) < floor) return
        const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40
        const time = entry.ts ? new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false }) : ''
        view.append(h('div', { class: 'log-line' },
            h('span', { class: 't' }, time),
            h('span', { class: `lv ${entry.level}` }, (entry.level || 'info').toUpperCase().slice(0, 5)),
            entry.user && entry.user !== 'API' ? h('span', { class: 'tag' }, `${entry.user}${entry.platform ? '·' + entry.platform : ''}`) : '',
            entry.title ? h('span', { class: 'tag' }, `[${entry.title}]`) : '',
            h('span', { class: 'msg' }, entry.raw && !entry.parsed ? entry.raw : entry.message)))
        while (view.childNodes.length > 2000) view.removeChild(view.firstChild)
        if (state.logAutoScroll && atBottom) view.scrollTop = view.scrollHeight
    }

    // ────────────────────────── 调度 ──────────────────────────
    async function viewSchedule() {
        const main = document.getElementById('main')
        main.innerHTML = ''
        let data
        try { data = await api('/schedule') } catch (err) { toast(err.message, 'error'); return }
        const writable = Boolean(data.writable) && (state.me.capabilities?.scheduleWrite ?? false)
        const accounts = await api('/accounts').catch(() => ({ accounts: [] }))

        const form = h('form', {
            onsubmit: async event => {
                event.preventDefault()
                const fd = form.elements
                const excluded = fd.excluded.value.split(',').map(str => Number(str.trim())).filter(Number.isSafeInteger).filter(n => n >= 1)
                try {
                    await api('/schedule', {
                        method: 'PUT',
                        body: { enabled: fd.enabled.checked, cron: fd.cron.value.trim(), excludedAccountIndexes: [...new Set(excluded)] }
                    })
                    toast('调度已保存', 'success')
                } catch (err) {
                    toast(err.message, 'error')
                }
            }
        },
            h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'enabled', checked: Boolean(data.enabled) }), '启用定时调度(Docker 内置 cron)'),
            h('label', { class: 'f' }, 'Cron 表达式(5 段)', h('input', { type: 'text', name: 'cron', value: data.cron ?? '0 7 * * *', placeholder: '0 7 * * *' }),
                h('p', { class: 'hint' }, `当前时区:${data.timezone ?? 'UTC'} · 语法见 crontab.guru · 示例「0 7,22 * * *」= 每天 7 点与 22 点`)),
            h('label', { class: 'f' }, '排除的账号槽位(逗号分隔,如 2,3)', h('input', { type: 'text', name: 'excluded', value: (data.excludedAccountIndexes || []).join(',') })),
            h('p', { class: 'hint' }, `调度来源:${data.source === 'override' ? '已保存的 schedule.json(优先)' : 'CRON_SCHEDULE 环境变量(默认)'} · 可用账号:${accounts.accounts.map(a => a.index).join(', ') || '无'}`),
            h('div', { style: { marginTop: '14px' } },
                h('button', { class: 'btn primary', type: 'submit', disabled: !writable }, '保存调度'),
                !writable ? h('span', { class: 'hint', style: { marginLeft: '10px' } }, '写入已禁用:设置 API_ALLOW_SCHEDULE_WRITE=true') : null))

        main.append(h('div', { class: 'page-title' }, '运行调度'),
            h('div', { class: 'card', style: { maxWidth: '620px' } }, form))
    }

    // ────────────────────────── 配置 ──────────────────────────
    async function viewConfig() {
        const main = document.getElementById('main')
        main.innerHTML = ''
        let data
        try { data = await api('/config') } catch (err) { toast(err.message, 'error'); return }
        const config = data.config || {}
        const writable = state.me.capabilities?.configWrite

        const TOGGLES = [
            ['workers.doDailySet', '每日集任务'],
            ['workers.doMorePromotions', '更多促销'],
            ['workers.doPunchCards', '打卡任务'],
            ['workers.doDailyCheckIn', '每日签到'],
            ['workers.doReadToEarn', '阅读赚取'],
            ['workers.doDesktopSearch', '桌面搜索'],
            ['workers.doMobileSearch', '移动搜索'],
            ['workers.doBonusSearches', '加成搜索'],
            ['workers.doClaimBonusPoints', '领取奖励积分'],
            ['workers.doActivateSearchPerk', '搜索加成 Perk'],
            ['workers.doAppPromotions', 'App 活动'],
            ['workers.doVisualSearch', '视觉搜索'],
            ['experimental.blockMedia', '拦截媒体(省流量)'],
            ['experimental.edgeBrowsing', 'Edge 浏览上报'],
            ['debugLogs', '调试日志']
        ]

        const toggleForm = h('form', {
            onsubmit: async event => {
                event.preventDefault()
                const patch = {}
                for (const [path] of TOGGLES) {
                    const input = toggleForm.elements[path]
                    if (!input || input.dataset.original === String(input.checked)) continue
                    const parts = path.split('.')
                    let node = patch
                    for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]] = node[parts[i]] || {}
                    node[parts[parts.length - 1]] = input.checked
                }
                if (!Object.keys(patch).length) { toast('没有改动', 'error'); return }
                try {
                    await api('/config', { method: 'PATCH', body: patch })
                    toast('配置已保存,下次运行生效', 'success')
                    viewConfig()
                } catch (err) {
                    toast(err.message, 'error')
                }
            }
        })
        const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '4px 16px' } })
        for (const [path, label] of TOGGLES) {
            const value = path.split('.').reduce((node, key) => node?.[key], config)
            const input = h('input', { type: 'checkbox', name: path })
            input.checked = Boolean(value)
            input.dataset.original = String(Boolean(value))
            grid.append(h('label', { class: 'check' }, input, label))
        }
        toggleForm.append(grid,
            h('div', { style: { marginTop: '14px' } },
                h('button', { class: 'btn primary', type: 'submit', disabled: !writable }, '保存开关'),
                !writable ? h('span', { class: 'hint', style: { marginLeft: '10px' } }, '写入已禁用:设置 API_ALLOW_CONFIG_WRITE=true') : null))

        // 原始 JSON(仅 reveal 可用时允许编辑,防止把打码值写回)
        const canEdit = state.me.capabilities?.revealConfig
        const jsonArea = h('textarea', { spellcheck: false })
        jsonArea.value = JSON.stringify(config, null, 4)
        jsonArea.readOnly = !canEdit
        const jsonCard = h('div', { class: 'card', style: { marginTop: '16px' } },
            h('h3', {}, '原始配置(config.json)'),
            jsonArea,
            h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px', alignItems: 'center' } },
                h('button', {
                    class: 'btn primary', disabled: !canEdit || !writable,
                    onclick: async () => {
                        if (!confirm('以「整体替换(PUT)」方式保存原始配置?\n请确认敏感字段(如 webhook token)不是打码占位符。')) return
                        try {
                            const parsed = JSON.parse(jsonArea.value)
                            await api('/config', { method: 'PUT', body: parsed })
                            toast('原始配置已保存', 'success')
                        } catch (err) {
                            toast(err.message, 'error')
                        }
                    }
                }, '保存 JSON'),
                h('span', { class: 'hint' },
                    canEdit ? 'GET ?reveal=1 已开启,可直接编辑' : '当前返回的是打码配置,编辑已禁用(设 API_ALLOW_CONFIG_REVEAL=true 后开启)。打码字段直接保存会覆盖真实值!')))

        main.append(
            h('div', { class: 'page-title' }, '行为配置', h('span', { class: 'hint' }, `路径:${data.path ?? 'config.json'}`)),
            h('div', { class: 'card' }, h('h3', {}, '任务开关(下次运行生效)'), toggleForm),
            jsonCard)
    }

    // ────────────────────────── 会话与诊断 ──────────────────────────
    async function viewTools() {
        const main = document.getElementById('main')
        main.innerHTML = ''
        main.append(h('div', { class: 'page-title' }, '会话与诊断'))
        const sessionsCard = h('div', { class: 'card', style: { marginBottom: '16px' } }, h('h3', {}, '登录会话(sessions/)'), h('p', { class: 'hint' }, '加载中…'))
        const diagCard = h('div', { class: 'card' }, h('h3', {}, '错误诊断(diagnostics/)'), h('p', { class: 'hint' }, '加载中…'))
        main.append(sessionsCard, diagCard)

        try {
            const data = await api('/sessions')
            const el = sessionsCard
            el.innerHTML = ''
            el.append(h('h3', {}, `登录会话(sessions/) · ${data.count} 条 / ${data.accounts} 个账号`))
            if (!data.count) el.append(h('p', { class: 'hint' }, '暂无会话。首次成功登录后会保存在这里。'))
            else {
                el.append(h('table', {},
                    h('thead', {}, h('tr', {}, ['邮箱', '平台', 'Cookies', '指纹', '更新时间', ''].map(x => h('th', {}, x)))),
                    h('tbody', {}, data.sessions.map(session => h('tr', {},
                        h('td', { class: 'wrap' }, session.email),
                        h('td', {}, session.platform),
                        h('td', {}, session.hasStorageState ? String(session.cookieCount ?? '?') : '—'),
                        h('td', {}, session.hasFingerprint ? '✓' : '—'),
                        h('td', {}, fmtTime(session.updatedAt)),
                        h('td', {}, h('button', {
                            class: 'btn small danger',
                            onclick: async () => {
                                if (!confirm(`删除 ${session.email} 的会话?下次运行需要重新登录。`)) return
                                try {
                                    await api(`/sessions/${encodeURIComponent(session.email)}`, { method: 'DELETE' })
                                    toast('会话已删除', 'success')
                                    viewTools()
                                } catch (err) { toast(err.message, 'error') }
                            }
                        }, '删除')))))))
            }
        } catch (err) {
            sessionsCard.innerHTML = ''
            sessionsCard.append(h('h3', {}, '登录会话'), h('p', { class: 'hint' }, `加载失败:${err.message}`))
        }

        try {
            const data = await api('/diagnostics')
            diagCard.innerHTML = ''
            diagCard.append(h('h3', {}, `错误诊断(diagnostics/) · ${data.count} 条`))
            if (!data.count) diagCard.append(h('p', { class: 'hint' }, '暂无诊断记录。开启 errorDiagnostics 后,出错时会保存截图与页面快照。'))
            else {
                diagCard.append(h('table', {},
                    h('thead', {}, h('tr', {}, ['名称', '时间', '资源', '错误摘要'].map(x => h('th', {}, x)))),
                    h('tbody', {}, data.entries.slice(0, 30).map(entry => h('tr', {},
                        h('td', {}, entry.name),
                        h('td', {}, fmtTime(entry.createdAt)),
                        h('td', {},
                            entry.hasScreenshot ? h('a', { href: `/diagnostics/${entry.name}/screenshot.png`, target: '_blank' }, '截图 ') : '',
                            entry.hasHtml ? h('a', { href: `/diagnostics/${entry.name}/dump.html`, target: '_blank' }, '页面 ') : '',
                            entry.hasError ? h('a', { href: `/diagnostics/${entry.name}/error.txt`, target: '_blank' }, '日志') : ''),
                        h('td', { class: 'wrap', style: { whiteSpace: 'normal', maxWidth: '420px', fontSize: '12px' } }, (entry.error || '').slice(0, 200)))))))
            }
        } catch (err) {
            diagCard.innerHTML = ''
            diagCard.append(h('h3', {}, '错误诊断'), h('p', { class: 'hint' }, `加载失败:${err.message}`))
        }
    }

    // ────────────────────────── 启动 ──────────────────────────
    loadMe()
})()
