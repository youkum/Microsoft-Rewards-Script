import { h, fmtInt, fmtTime, pageGuard, pageTitle, emptyState } from './ui.js'

export function createPointsView({ api, state, toast }) {
    let requestVersion = 0
    // ────────────────────────── 积分历史 ──────────────────────────
    async function viewPoints() {
        const main = document.getElementById('main')
        main.innerHTML = ''
        main.append(
            pageTitle(
                '积分历史',
                '回顾积分增长，了解每个账号的运行表现。',
                h(
                    'select',
                    { id: 'points-days', 'aria-label': '历史时间范围', onchange: () => refreshPoints() },
                    [7, 30, 90, 365].map(days => h('option', { value: days, selected: days === 30 }, `最近 ${days} 天`))
                )
            ),
            h('div', { class: 'grid cols-3', id: 'points-cards' }),
            h(
                'div',
                { class: 'card chart-box', id: 'points-chart', style: { marginBottom: '16px' } },
                h('h3', {}, '每日获得积分')
            ),
            h('h3', { style: { margin: '18px 0 10px', color: 'var(--text-dim)' } }, '分账号累计'),
            h('div', { class: 'table-wrap', id: 'points-accounts' }),
            h('h3', { style: { margin: '18px 0 10px', color: 'var(--text-dim)' } }, '运行记录'),
            h('div', { class: 'table-wrap', id: 'points-runs' })
        )
        await refreshPoints()
    }

    async function refreshPoints() {
        const version = ++requestVersion
        const current = pageGuard(state)
        const target = document.getElementById('points-cards')
        const days = Number(document.getElementById('points-days')?.value ?? 30)
        let data
        try {
            data = await api(`/points/history?days=${days}&limit=500`)
        } catch (err) {
            if (current() && version === requestVersion) toast(err.message, 'error')
            return
        }

        const cardsEl = document.getElementById('points-cards')
        if (!current() || version !== requestVersion || !target || cardsEl !== target) return
        cardsEl.innerHTML = ''
        for (const [title, value] of [
            ['运行次数', fmtInt(data.totals.runs), 'blue'],
            ['累计获得', fmtInt(data.totals.collected) + ' 分', 'green'],
            ['成功运行', fmtInt(data.totals.successes), 'orange']
        ]) {
            cardsEl.append(
                h(
                    'div',
                    { class: 'card' },
                    h('h3', {}, title),
                    h('div', { class: 'big' }, String(value)),
                    h('div', { class: 'dim' }, '')
                )
            )
        }

        // SVG 柱状图:每日 collected
        const chartEl = document.getElementById('points-chart')
        chartEl.innerHTML = ''
        chartEl.append(h('h3', {}, `每日获得积分(${data.daily.length} 天)`))
        chartEl.append(renderDailyChart(data.daily))
        chartEl.append(
            h(
                'div',
                { class: 'chart-legend' },
                h('span', {}, h('i', { class: 'k', style: { background: 'var(--accent)' } }), '当日积分')
            )
        )

        const accEl = document.getElementById('points-accounts')
        accEl.innerHTML = ''
        if (!data.perAccount.length)
            accEl.append(h('p', { style: { padding: '14px', color: 'var(--text-dim)' } }, '该时间段内暂无运行记录。'))
        else
            accEl.append(
                h(
                    'table',
                    {},
                    h(
                        'thead',
                        {},
                        h(
                            'tr',
                            {},
                            ['账号', '运行次数', '累计获得', '成功次数', '最近获得', '最近余额', '最近运行'].map(x =>
                                h('th', {}, x)
                            )
                        )
                    ),
                    h(
                        'tbody',
                        {},
                        data.perAccount.map(account =>
                            h(
                                'tr',
                                {},
                                h('td', { class: 'wrap' }, account.email),
                                h('td', {}, String(account.runs)),
                                h('td', {}, fmtInt(account.totalCollected)),
                                h('td', {}, String(account.successes)),
                                h('td', {}, fmtInt(account.lastCollected ?? 0)),
                                h('td', {}, account.lastBalance != null ? fmtInt(account.lastBalance) : '—'),
                                h('td', {}, fmtTime(account.lastRunAt))
                            )
                        )
                    )
                )
            )

        const runsEl = document.getElementById('points-runs')
        runsEl.innerHTML = ''
        if (!data.records.length)
            runsEl.append(h('p', { style: { padding: '14px', color: 'var(--text-dim)' } }, '无记录'))
        else
            runsEl.append(
                h(
                    'table',
                    {},
                    h(
                        'thead',
                        {},
                        h(
                            'tr',
                            {},
                            ['结束时间', '本次获得', '结果', '各账号'].map(x => h('th', {}, x))
                        )
                    ),
                    h(
                        'tbody',
                        {},
                        data.records.slice(0, 60).map(record =>
                            h(
                                'tr',
                                {},
                                h('td', {}, fmtTime(record.endedAt || record.startedAt)),
                                h('td', {}, fmtInt(record.collected ?? 0)),
                                h(
                                    'td',
                                    {},
                                    record.exit?.code === 0
                                        ? h('span', { class: 'badge green' }, 'exit 0')
                                        : h(
                                              'span',
                                              {
                                                  class: 'badge red',
                                                  title: record.exit?.error || `exit ${record.exit?.code}`
                                              },
                                              `exit ${record.exit?.code ?? '?'}`
                                          )
                                ),
                                h(
                                    'td',
                                    { class: 'wrap' },
                                    (record.accounts || [])
                                        .map(
                                            account =>
                                                `${account.email.split('@')[0]}${account.success === true ? '✅' : account.success === false ? '❌' : ''}+${account.collected ?? 0}`
                                        )
                                        .join(', ') || '—'
                                )
                            )
                        )
                    )
                )
            )
    }

    function renderDailyChart(daily) {
        if (!daily.length) return emptyState('暂无积分趋势', '运行完成后，每日获得的积分会显示在这里。')
        const width = Math.max(daily.length * 46, 320)
        const height = 200
        const padding = { top: 20, right: 10, bottom: 26, left: 46 }
        const maxPoints = Math.max(...daily.map(day => day.collected), 1)
        const innerW = width - padding.left - padding.right
        const innerH = height - padding.top - padding.bottom
        const barW = Math.min(Math.floor(innerW / daily.length) - 6, 34)

        const svgNS = 'http://www.w3.org/2000/svg'
        const svg = document.createElementNS(svgNS, 'svg')
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
        const mk = (tag, attrs = {}, text) => {
            const el = document.createElementNS(svgNS, tag)
            for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
            if (text !== undefined) el.textContent = text
            return el
        }
        svg.setAttribute('role', 'img')
        svg.setAttribute('aria-label', '每日获得积分柱状图')

        // y 轴刻度(积分)
        for (let i = 0; i <= 4; i++) {
            const value = Math.round((maxPoints / 4) * i)
            const y = padding.top + innerH - (innerH * i) / 4
            svg.append(
                mk('line', {
                    x1: padding.left,
                    y1: y,
                    x2: width - padding.right,
                    y2: y,
                    stroke: '#e2e8f0',
                    'stroke-width': 1
                })
            )
            svg.append(
                mk(
                    'text',
                    { x: padding.left - 6, y: y + 4, fill: '#64748b', 'font-size': 10, 'text-anchor': 'end' },
                    fmtInt(value)
                )
            )
        }

        daily.forEach((day, index) => {
            const x = padding.left + (index * innerW) / daily.length + 3
            const barH = (day.collected / maxPoints) * innerH
            const y = padding.top + innerH - barH
            const rect = mk('rect', {
                x,
                y,
                width: barW,
                height: Math.max(barH, day.collected > 0 ? 2 : 0),
                fill: '#4f46e5',
                rx: 3,
                opacity: 0.85
            })
            const title = mk('title')
            title.textContent = `${day.date}:+${day.collected} 分 / ${day.runs} 次运行`
            rect.append(title)
            svg.append(rect)
            if (daily.length <= 20 || index % Math.ceil(daily.length / 12) === 0) {
                svg.append(
                    mk(
                        'text',
                        { x: x + barW / 2, y: height - 8, fill: '#64748b', 'font-size': 10, 'text-anchor': 'middle' },
                        day.date.slice(5)
                    )
                )
            }
        })
        return svg
    }

    return { viewPoints }
}
