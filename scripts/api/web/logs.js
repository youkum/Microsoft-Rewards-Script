import { h, pageGuard, pageTitle, setBusy } from './ui.js'

// Replay and live events overlap. IDs are authoritative; prefer the live copy.
export function mergeLogs(replay, live, limit = 2000) {
    const byId = new Map()
    const unkeyed = []
    for (const entry of [...replay, ...live]) {
        if (entry.id != null) byId.set(String(entry.id), entry)
        else if (!unkeyed.includes(entry)) unkeyed.push(entry)
    }
    return [...byId.values(), ...unkeyed]
        .sort((a, b) => {
            if (a.id != null && b.id != null && Number.isFinite(Number(a.id)) && Number.isFinite(Number(b.id)))
                return Number(a.id) - Number(b.id)
            return (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0)
        })
        .slice(-limit)
}

export function createLogsView({ api, state, toast, renderPromptBanner }) {
    let version = 0
    let current = () => false
    const levelRank = { debug: 0, info: 1, warn: 2, error: 3 }
    function dispose() {
        version++
        current = () => false
    }
    async function viewLogs() {
        const main = document.getElementById('main')
        const isCurrent = pageGuard(state, main)
        current = isCurrent
        const request = ++version
        let submitting = false
        main.replaceChildren(
            pageTitle('实时日志', '实时跟踪运行过程，并在需要时安全提交验证信息。'),
            h(
                'div',
                { class: 'log-toolbar' },
                h(
                    'select',
                    {
                        'aria-label': '日志级别',
                        onchange: event => {
                            state.logFilter = event.target.value
                            redrawLogs()
                        }
                    },
                    [
                        ['all', '全部级别'],
                        ['debug', '调试及以上'],
                        ['info', '信息及以上'],
                        ['warn', '警告及以上'],
                        ['error', '仅错误']
                    ].map(([value, label]) => h('option', { value, selected: value === state.logFilter }, label))
                ),
                h(
                    'label',
                    { class: 'check' },
                    h('input', {
                        type: 'checkbox',
                        checked: state.logAutoScroll,
                        onchange: event => {
                            state.logAutoScroll = event.target.checked
                        }
                    }),
                    '自动滚动'
                ),
                h(
                    'button',
                    {
                        class: 'btn small',
                        onclick: () => {
                            version++
                            state.logs = []
                            redrawLogs()
                        }
                    },
                    '清空显示'
                ),
                h('span', { class: 'hint' }, '仅清空当前显示，不删除服务器日志')
            ),
            h('div', { class: 'log-view', id: 'log-view', role: 'log', 'aria-label': '运行日志', 'aria-live': 'off' }),
            h(
                'form',
                {
                    class: 'console-input-bar',
                    id: 'console-input-form',
                    onsubmit: async event => {
                        event.preventDefault()
                        if (submitting || !isCurrent()) return
                        const form = event.target
                        const input = form.querySelector('input')
                        const button = form.querySelector('button')
                        const value = input.value.trim()
                        if (!value) return
                        const prompt = state.prompt
                        submitting = true
                        setBusy(button, true, '发送中…')
                        try {
                            await api('/input', { method: 'POST', body: { input: value } })
                            if (!isCurrent()) return
                            toast('已发送至脚本控制台', 'success')
                            input.value = ''
                            if (state.prompt === prompt) {
                                state.prompt = null
                                renderPromptBanner()
                            }
                        } catch (err) {
                            if (isCurrent()) toast(`发送失败：${err.message}`, 'error')
                        } finally {
                            submitting = false
                            setBusy(button, false, '发送')
                            if (isCurrent() && input.isConnected) input.focus()
                        }
                    }
                },
                h('span', { class: 'console-prompt-sym', 'aria-hidden': 'true' }, '›'),
                h('input', {
                    type: 'text',
                    'aria-label': '控制台输入',
                    placeholder: state.prompt
                        ? `等待验证：${state.prompt.question}`
                        : '输入验证码、安全邮箱等内容，按 Enter 发送…',
                    autocomplete: 'off'
                }),
                h('button', { type: 'submit', class: 'btn small primary' }, '发送')
            )
        )
        redrawLogs()
        try {
            const data = await api('/logs?limit=300')
            if (!isCurrent() || request !== version) return
            state.logs = mergeLogs(data.logs || [], state.logs)
            redrawLogs()
        } catch (err) {
            if (isCurrent() && request === version) toast(`日志回放加载失败：${err.message}`, 'error')
        }
    }
    function receiveLog(entry) {
        const exists = entry.id != null && state.logs.some(log => String(log.id) === String(entry.id))
        state.logs = mergeLogs([], [...state.logs, entry])
        if (current()) {
            if (exists) redrawLogs()
            else appendLogLine(entry)
        }
    }
    function redrawLogs() {
        const view = document.getElementById('log-view')
        if (!view || !current()) return
        view.replaceChildren()
        for (const entry of state.logs) appendLogLine(entry, view)
        if (state.logAutoScroll) view.scrollTop = view.scrollHeight
    }
    function appendLogLine(entry, viewEl) {
        const view = viewEl || document.getElementById('log-view')
        if (!view || !current()) return
        const floor = state.logFilter === 'all' ? 0 : (levelRank[state.logFilter] ?? 0)
        if ((levelRank[entry.level] ?? 1) < floor) return
        const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40
        const time = entry.ts ? new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false }) : ''
        view.append(
            h(
                'div',
                { class: 'log-line' },
                h('span', { class: 't' }, time),
                h('span', { class: `lv ${entry.level || 'info'}` }, (entry.level || 'info').toUpperCase().slice(0, 5)),
                entry.user && entry.user !== 'API'
                    ? h('span', { class: 'tag' }, `${entry.user}${entry.platform ? '·' + entry.platform : ''}`)
                    : null,
                entry.title ? h('span', { class: 'tag' }, `[${entry.title}]`) : null,
                h('span', { class: 'msg' }, entry.raw && !entry.parsed ? entry.raw : entry.message)
            )
        )
        while (view.childNodes.length > 2000) view.removeChild(view.firstChild)
        if (state.logAutoScroll && atBottom) view.scrollTop = view.scrollHeight
    }
    return { viewLogs, appendLogLine, receiveLog, dispose }
}
