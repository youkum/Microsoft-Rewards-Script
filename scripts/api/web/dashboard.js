import { h, fmtInt, fmtTime, pageTitle, icon, emptyState } from './ui.js'
import { createRefreshController } from './refresh.js'

export function createDashboard({ api, state, startRun, stopRun, onUnauthorized, updateSseBadge }) {
    const controller = createRefreshController({
        load: async signal => {
            const [run, status] = await Promise.all([
                api('/points', { signal }),
                state.sseReady ? null : api('/status', { signal })
            ])
            return { run, status }
        },
        render: ({ run, status }) => {
            renderDashboardStatus(state.sseReady ? state.currentRun || status || run : status || run)
            renderPoints(run)
            updateSseBadge()
        },
        onError: error => {
            if (error.status === 401) return onUnauthorized()
            const cards = document.getElementById('dash-cards')
            if (cards)
                cards.replaceChildren(
                    h(
                        'div',
                        { class: 'inline-error', role: 'alert' },
                        '总览暂时无法刷新：' + error.message,
                        h('button', { class: 'btn small', onclick: controller.refresh }, '重试')
                    )
                )
        }
    })

    async function mount() {
        const main = document.getElementById('main')
        main.innerHTML = ''
        main.append(
            pageTitle(
                '运行总览',
                '欢迎回来。这里是您的 Rewards 运行概况。',
                h(
                    'button',
                    { class: 'btn', id: 'btn-restart', onclick: () => startRun({ restart: true }) },
                    icon('refresh'),
                    '重启'
                ),
                h('button', { class: 'btn danger', id: 'btn-stop', onclick: stopRun }, icon('stop'), '停止'),
                h(
                    'button',
                    { class: 'btn primary', id: 'btn-start', onclick: () => startRun({}) },
                    icon('play'),
                    '启动全部账号'
                )
            ),
            h(
                'div',
                { class: 'overview-banner' },
                h(
                    'div',
                    {},
                    h('span', { class: 'eyebrow' }, 'YOUR REWARDS, AT A GLANCE'),
                    h('h2', {}, '清晰掌握每一份进展'),
                    h('p', {}, '运行状态与积分数据实时同步，让日常管理井然有序。')
                ),
                h(
                    'div',
                    { class: 'overview-art', 'aria-hidden': 'true' },
                    icon('chart'),
                    h('span', { class: 'art-dot one' }),
                    h('span', { class: 'art-dot two' })
                )
            ),
            h('div', { class: 'grid cols-4', id: 'dash-cards' }),
            h(
                'div',
                { class: 'section-heading' },
                h(
                    'div',
                    {},
                    h('h2', {}, '账号运行明细'),
                    h('p', { class: 'section-description' }, '本次运行中，各账号的积分与任务进度。')
                ),
                h('a', { class: 'text-link', href: '#/points' }, '查看积分历史', icon('arrow'))
            ),
            h(
                'div',
                { class: 'table-wrap', id: 'dash-accounts' },
                h('p', { style: { padding: '14px', color: 'var(--text-dim)' } }, '加载中…')
            )
        )
        renderDashboardStatus(state.currentRun)
        await controller.activate()
    }

    function renderDashboardStatus(status) {
        const startBtn = document.getElementById('btn-start')
        const stopBtn = document.getElementById('btn-stop')
        if (!startBtn && !stopBtn) return
        const running = Boolean(status && status.state !== 'idle')
        if (startBtn) startBtn.disabled = running || Boolean(state.runBusy)
        if (stopBtn) stopBtn.disabled = !running || Boolean(state.runBusy)
        const restartBtn = document.getElementById('btn-restart')
        if (restartBtn) restartBtn.disabled = Boolean(state.runBusy)
        for (const button of [startBtn, stopBtn, restartBtn])
            button?.setAttribute('aria-busy', String(Boolean(state.runBusy)))
    }

    function renderPoints(run) {
        const cards = [
            [
                '运行状态',
                run.running ? '运行中' : run.finished ? '已完成' : '空闲',
                run.running ? 'green' : run.finished ? 'blue' : 'gray',
                run.startedAt ? `开始于 ${fmtTime(run.startedAt)}` : '通过 ▶ 启动任务'
            ],
            [
                '当前账号',
                run.currentAccount || '—',
                run.currentAccount ? 'yellow' : 'gray',
                run.updatedAt ? `更新于 ${fmtTime(run.updatedAt)}` : ''
            ],
            [
                '本次已获得',
                fmtInt(run.collected ?? 0),
                'green',
                `完成 ${run.accountsSeen ?? 0}/${run.accountsTotal ?? 0} 个账号`
            ],
            ['当前余额', run.balance != null ? fmtInt(run.balance) : '—', 'blue', run.finished ? '本轮运行已结束' : '']
        ]
        const cardsEl = document.getElementById('dash-cards')
        if (cardsEl) {
            cardsEl.innerHTML = ''
            for (const [title, value, color, dim] of cards) {
                cardsEl.append(
                    h(
                        'div',
                        { class: 'card metric-card' },
                        h(
                            'div',
                            { class: 'metric-label' },
                            h('h3', {}, title),
                            h(
                                'span',
                                { class: `metric-icon ${color}` },
                                icon(
                                    title === '运行状态'
                                        ? 'play'
                                        : title === '当前账号'
                                          ? 'users'
                                          : title === '本次已获得'
                                            ? 'chart'
                                            : 'spark'
                                )
                            )
                        ),
                        h('div', { class: 'big' }, h('span', { class: `dot ${color}` }), String(value)),
                        h('div', { class: 'dim' }, dim)
                    )
                )
            }
        }

        const wrap = document.getElementById('dash-accounts')
        if (wrap) {
            wrap.innerHTML = ''
            const accounts = run.accounts || []
            if (!accounts.length) {
                wrap.append(emptyState('等待首次运行', '启动任务后，这里将展示各账号的实时积分与运行状态。', 'users'))
            } else {
                const table = h(
                    'table',
                    {},
                    h('caption', { class: 'sr-only' }, '各账号本次积分获取与运行状态'),
                    h(
                        'thead',
                        {},
                        h(
                            'tr',
                            {},
                            ['账号', '本次获得', '当前余额', '初始积分', '状态', '连击保护', 'Edge 浏览'].map(x =>
                                h('th', { scope: 'col' }, x)
                            )
                        )
                    ),
                    h(
                        'tbody',
                        {},
                        accounts.map(account =>
                            h(
                                'tr',
                                {},
                                h('td', { class: 'wrap' }, account.email),
                                h('td', {}, fmtInt(account.collected ?? 0)),
                                h('td', {}, account.balance != null ? fmtInt(account.balance) : '—'),
                                h('td', {}, account.initialPoints != null ? fmtInt(account.initialPoints) : '—'),
                                h(
                                    'td',
                                    {},
                                    account.done
                                        ? account.success
                                            ? h('span', { class: 'badge green' }, '成功')
                                            : h('span', { class: 'badge red', title: account.error || '' }, '失败')
                                        : account.inProgress
                                          ? h('span', { class: 'badge yellow' }, '进行中')
                                          : h('span', { class: 'badge gray' }, '等待')
                                ),
                                h('td', {}, account.streakProtection == null ? '—' : account.streakProtection),
                                h('td', {}, account.edgeBrowsing == null ? '—' : account.edgeBrowsing)
                            )
                        )
                    )
                )
                wrap.append(table)
            }
        }
    }

    return { mount, dispose: controller.deactivate, refresh: controller.refresh, updateStatus: renderDashboardStatus }
}
