import { h, fmtTime, pageGuard, pageTitle, emptyState, setBusy } from './ui.js'

export function createSettingsViews({ api, state, toast }) {
    async function viewSchedule() {
        const main = document.getElementById('main')
        const current = pageGuard(state, main)
        main.replaceChildren(pageTitle('运行调度', '设置自动运行时间，让日常管理更从容。'))
        const data = await api('/schedule')
        if (!current()) return
        const accounts = await api('/accounts').catch(() => ({ accounts: [] }))
        if (!current()) return
        const writable = data.writable === true && state.me?.capabilities?.scheduleWrite === true
        let saving = false
        const demo = Boolean(state.me?.demo)
        const saveStatus = h('span', { class: 'hint', role: 'status' }, '尚未修改调度。')
        const savedSummary = h('p', { class: 'hint', role: 'status' })
        function showSavedSchedule(saved) {
            savedSummary.textContent = `服务器配置：${saved.enabled ? '已启用' : '已停用'} · ${saved.cron || '未设置 Cron'} · 时区 ${saved.timezone || 'UTC'} · 排除槽位 ${(saved.excludedAccountIndexes || []).join(', ') || '无'}${saved.updatedAt ? ` · 保存于 ${fmtTime(saved.updatedAt)}` : ''}`
        }
        showSavedSchedule(data)
        const button = h('button', { class: 'btn primary', type: 'submit', disabled: !writable }, '保存调度')
        const form = h(
            'form',
            {
                onsubmit: async event => {
                    event.preventDefault()
                    if (saving || !writable || !current()) return
                    const fd = form.elements
                    const excluded = fd.excluded.value
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean)
                        .map(Number)
                    if (excluded.some(n => !Number.isSafeInteger(n) || n < 1))
                        return toast('请输入有效的账号槽位，例如 2,3。', 'error')
                    saving = true
                    for (const input of form.querySelectorAll('input')) input.disabled = true
                    setBusy(button, true, '正在保存…')
                    saveStatus.textContent = demo ? '正在保存演示配置…' : '正在保存并应用 cron…'
                    try {
                        const saved = await api('/schedule', {
                            method: 'PUT',
                            body: {
                                enabled: fd.enabled.checked,
                                cron: fd.cron.value.trim(),
                                excludedAccountIndexes: [...new Set(excluded)]
                            }
                        })
                        if (!current()) return
                        fd.enabled.checked = Boolean(saved.enabled)
                        fd.cron.value = saved.cron ?? ''
                        fd.excluded.value = (saved.excludedAccountIndexes || []).join(',')
                        showSavedSchedule(saved)
                        saveStatus.textContent = demo
                            ? '演示调度已保存，仅保存在演示环境，不会执行真实 cron。'
                            : saved.enabled
                              ? '调度已保存并应用到 cron。'
                              : '调度已保存，cron 定时运行已停用。'
                        toast(saveStatus.textContent, 'success')
                    } catch (err) {
                        if (current()) {
                            saveStatus.textContent = `调度保存失败：${err.message}`
                            toast(saveStatus.textContent, 'error')
                        }
                    } finally {
                        saving = false
                        if (current()) {
                            for (const input of form.querySelectorAll('input')) input.disabled = !writable
                            setBusy(button, !writable, '保存调度')
                        }
                    }
                }
            },
            h(
                'label',
                { class: 'check switch-row' },
                h('input', { type: 'checkbox', name: 'enabled', checked: Boolean(data.enabled), disabled: !writable }),
                '启用定时调度'
            ),
            h(
                'label',
                { class: 'f' },
                'Cron 表达式（5 段）',
                h('input', { type: 'text', name: 'cron', value: data.cron ?? '0 7 * * *', disabled: !writable }),
                h(
                    'p',
                    { class: 'hint' },
                    `时区：${data.timezone ?? 'UTC'} · 例如 0 7,22 * * * 表示每天 7:00 和 22:00。`
                )
            ),
            h(
                'label',
                { class: 'f' },
                '排除的账号槽位',
                h('input', {
                    type: 'text',
                    name: 'excluded',
                    value: (data.excludedAccountIndexes || []).join(','),
                    placeholder: '例如 2,3',
                    disabled: !writable
                })
            ),
            h(
                'p',
                { class: 'hint' },
                `来源：${data.source === 'override' ? '已保存的调度配置' : '默认环境配置'} · 可用槽位：${accounts.accounts.map(a => a.index).join(', ') || '暂无'}`
            ),
            h(
                'div',
                { class: 'form-footer' },
                button,
                !writable ? h('span', { class: 'hint' }, '当前为只读模式，调度写入权限未开启。') : saveStatus
            )
        )
        main.append(
            h(
                'div',
                { class: 'card settings-card' },
                h('h2', {}, '定时运行'),
                h(
                    'p',
                    { class: 'section-description' },
                    demo
                        ? '演示环境仅保存调度配置，不安装或运行真实 cron。'
                        : '保存成功后立即应用容器内置 cron，按服务器时区执行。'
                ),
                savedSummary,
                form
            )
        )
    }

    async function viewConfig() {
        const main = document.getElementById('main')
        const current = pageGuard(state, main)
        main.replaceChildren(pageTitle('行为配置', '按需调整任务开关，保存后在下次运行时生效。'))
        const data = await api('/config')
        if (!current()) return
        const config = data.config || {}
        const writable = state.me?.capabilities?.configWrite === true && data.writable !== false
        const revealAllowed = state.me?.capabilities?.revealConfig === true
        const toggles = [
            ['workers.doDailySet', '每日集任务'],
            ['workers.doMorePromotions', '更多促销'],
            ['workers.doPunchCards', '打卡任务'],
            ['workers.doDailyCheckIn', '每日签到'],
            ['workers.doReadToEarn', '阅读赚取'],
            ['workers.doDesktopSearch', '桌面搜索'],
            ['workers.doMobileSearch', '移动搜索'],
            ['workers.doBonusSearches', '加成搜索'],
            ['workers.doClaimBonusPoints', '领取奖励积分'],
            ['workers.doActivateSearchPerk', '搜索加成'],
            ['workers.doAppPromotions', 'App 活动'],
            ['workers.doVisualSearch', '视觉搜索'],
            ['experimental.blockMedia', '拦截媒体，节省流量'],
            ['experimental.edgeBrowsing', 'Edge 浏览上报'],
            ['debugLogs', '调试日志']
        ]
        let savingToggles = false
        const toggleButton = h('button', { class: 'btn primary', type: 'submit', disabled: !writable }, '保存开关')
        const toggleForm = h('form', {
            onsubmit: async event => {
                event.preventDefault()
                if (!current() || !writable || savingToggles) return
                const patch = {}
                const changed = []
                for (const [path] of toggles) {
                    const input = toggleForm.elements[path]
                    if (input.dataset.original === String(input.checked)) continue
                    const parts = path.split('.')
                    let node = patch
                    for (const key of parts.slice(0, -1)) node = node[key] = node[key] || {}
                    node[parts.at(-1)] = input.checked
                    changed.push([input, String(input.checked)])
                }
                if (!changed.length) return toast('没有需要保存的改动')
                savingToggles = true
                setBusy(toggleButton, true, '正在保存…')
                try {
                    await api('/config', { method: 'PATCH', body: patch })
                    if (!current()) return
                    changed.forEach(([input, value]) => {
                        input.dataset.original = value
                    })
                    toast('任务开关已保存，下次运行生效', 'success')
                    // A revealed full document is now stale; hide it before another JSON replacement.
                    hideJson()
                } catch (err) {
                    if (current()) toast(err.message, 'error')
                } finally {
                    savingToggles = false
                    setBusy(toggleButton, !writable, '保存开关')
                }
            }
        })
        const grid = h('div', { class: 'toggle-grid' })
        for (const [path, label] of toggles) {
            const value = Boolean(path.split('.').reduce((node, key) => node?.[key], config))
            const input = h('input', { type: 'checkbox', name: path, checked: value, disabled: !writable })
            input.dataset.original = String(value)
            grid.append(h('label', { class: 'check toggle-item' }, input, label))
        }
        toggleForm.append(
            grid,
            h(
                'div',
                { class: 'form-footer' },
                toggleButton,
                !writable ? h('span', { class: 'hint' }, '配置写入权限未开启。') : null
            )
        )

        let revealed = false
        let jsonWritable = false
        let revealing = false
        let savingJson = false
        let revealVersion = 0
        const jsonArea = h('textarea', { spellcheck: false, readOnly: true, 'aria-label': '原始配置 JSON' })
        jsonArea.value = JSON.stringify(config, null, 4)
        const jsonHint = h('span', { class: 'hint' }, '当前为打码预览。点击「显示完整配置」后，才会读取敏感字段。')
        const saveButton = h(
            'button',
            {
                type: 'button',
                class: 'btn primary',
                disabled: true,
                onclick: async () => {
                    if (!current() || !revealed || !jsonWritable || !writable || savingJson) return
                    let parsed
                    try {
                        parsed = JSON.parse(jsonArea.value)
                        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
                            throw new Error('配置必须是 JSON 对象')
                    } catch (err) {
                        return toast(`JSON 格式有误：${err.message}`, 'error')
                    }
                    if (!confirm('保存将整体替换原始配置，是否继续？')) return
                    savingJson = true
                    setBusy(saveButton, true, '正在保存…')
                    try {
                        await api('/config', { method: 'PUT', body: parsed })
                        if (current()) {
                            toast('原始配置已保存', 'success')
                            await viewConfig()
                        }
                    } catch (err) {
                        if (current()) toast(err.message, 'error')
                    } finally {
                        savingJson = false
                        setBusy(saveButton, !(revealed && jsonWritable && writable), '保存 JSON')
                    }
                }
            },
            '保存 JSON'
        )
        function hideJson() {
            revealVersion++
            revealed = false
            jsonWritable = false
            revealing = false
            jsonArea.readOnly = true
            jsonArea.value = JSON.stringify(config, null, 4)
            saveButton.disabled = true
            setBusy(revealButton, !revealAllowed, '显示完整配置')
            jsonHint.textContent = '当前为打码预览。保存 JSON 需要先读取未打码的完整配置。'
        }
        const revealButton = h(
            'button',
            {
                class: 'btn',
                type: 'button',
                disabled: !revealAllowed,
                onclick: async () => {
                    if (!current() || revealing || !revealAllowed) return
                    if (revealed) {
                        hideJson()
                        return
                    }
                    const version = ++revealVersion
                    revealing = true
                    setBusy(revealButton, true, '正在读取…')
                    try {
                        const full = await api('/config?reveal=1')
                        if (!current() || version !== revealVersion) return
                        revealed = full.redacted === false
                        jsonWritable = full.writable !== false
                        if (revealed) jsonArea.value = JSON.stringify(full.config || {}, null, 4)
                        jsonArea.readOnly = !(revealed && writable && jsonWritable)
                        saveButton.disabled = !(revealed && writable && jsonWritable)
                        jsonHint.textContent = revealed
                            ? writable && jsonWritable
                                ? '完整配置已显示，包含敏感字段。保存将整体替换文件。'
                                : '完整配置已显示；当前没有写入权限。'
                            : '服务器仍返回打码配置，编辑和保存已禁用。'
                    } catch (err) {
                        if (current()) toast(err.message, 'error')
                    } finally {
                        if (current() && version === revealVersion) {
                            revealing = false
                            setBusy(revealButton, false, revealed ? '隐藏敏感内容' : '显示完整配置')
                        }
                    }
                }
            },
            '显示完整配置'
        )
        if (!revealAllowed) jsonHint.textContent = '当前为打码预览，完整配置查看权限未开启。'
        main.append(
            h(
                'div',
                { class: 'card' },
                h('h2', {}, '任务开关'),
                h('p', { class: 'section-description' }, '只保存有改动的开关，其他配置保持原值。'),
                toggleForm
            ),
            h(
                'div',
                { class: 'card json-card' },
                h(
                    'div',
                    { class: 'section-heading' },
                    h(
                        'div',
                        {},
                        h('h2', {}, '原始配置'),
                        h('p', { class: 'section-description' }, data.path ?? 'config.json')
                    ),
                    revealButton
                ),
                jsonArea,
                h('div', { class: 'form-footer' }, saveButton, jsonHint)
            )
        )
    }

    async function viewTools() {
        const main = document.getElementById('main')
        const current = pageGuard(state, main)
        main.replaceChildren(pageTitle('会话与诊断', '查看已保存的登录状态，快速定位运行异常。'))
        const sessionsCard = h(
            'div',
            { class: 'card' },
            h('h2', {}, '登录会话'),
            h('p', { class: 'hint' }, '正在加载…')
        )
        const diagCard = h('div', { class: 'card' }, h('h2', {}, '错误诊断'), h('p', { class: 'hint' }, '正在加载…'))
        main.append(h('div', { class: 'stack' }, sessionsCard, diagCard))
        await Promise.all([
            (async () => {
                try {
                    const data = await api('/sessions')
                    if (!current()) return
                    sessionsCard.replaceChildren(
                        h(
                            'div',
                            { class: 'section-heading' },
                            h('h2', {}, '登录会话'),
                            h('span', { class: 'badge gray' }, `${data.count} 条 · ${data.accounts} 个账号`)
                        )
                    )
                    if (!data.count)
                        return sessionsCard.append(
                            emptyState('暂无登录会话', '首次成功登录后，会话将自动保存在这里。', 'shield')
                        )
                    sessionsCard.append(
                        h(
                            'div',
                            { class: 'table-wrap' },
                            h(
                                'table',
                                {},
                                h(
                                    'thead',
                                    {},
                                    h(
                                        'tr',
                                        {},
                                        ['邮箱', '平台', 'Cookies', '指纹', '更新时间', '操作'].map(x =>
                                            h('th', { scope: 'col' }, x)
                                        )
                                    )
                                ),
                                h(
                                    'tbody',
                                    {},
                                    data.sessions.map(session =>
                                        h(
                                            'tr',
                                            {},
                                            h('td', { class: 'wrap' }, session.email),
                                            h('td', {}, session.platform),
                                            h(
                                                'td',
                                                {},
                                                session.hasStorageState ? String(session.cookieCount ?? '—') : '—'
                                            ),
                                            h('td', {}, session.hasFingerprint ? '已保存' : '—'),
                                            h('td', {}, fmtTime(session.updatedAt)),
                                            h(
                                                'td',
                                                {},
                                                h(
                                                    'button',
                                                    {
                                                        class: 'btn small danger',
                                                        onclick: async event => {
                                                            const button = event.currentTarget
                                                            if (
                                                                button.disabled ||
                                                                !current() ||
                                                                !confirm(
                                                                    `删除 ${session.email} 的会话？下次运行需要重新登录。`
                                                                )
                                                            )
                                                                return
                                                            setBusy(button, true, '正在删除…')
                                                            try {
                                                                await api(
                                                                    `/sessions/${encodeURIComponent(session.email)}`,
                                                                    { method: 'DELETE' }
                                                                )
                                                                if (current()) {
                                                                    toast('会话已删除', 'success')
                                                                    await viewTools()
                                                                }
                                                            } catch (err) {
                                                                if (current()) toast(err.message, 'error')
                                                            } finally {
                                                                setBusy(button, false, '删除')
                                                            }
                                                        }
                                                    },
                                                    '删除'
                                                )
                                            )
                                        )
                                    )
                                )
                            )
                        )
                    )
                } catch (err) {
                    if (current())
                        sessionsCard.replaceChildren(
                            h('h2', {}, '登录会话'),
                            h('p', { class: 'inline-error' }, `加载失败：${err.message}`)
                        )
                }
            })(),
            (async () => {
                try {
                    const data = await api('/diagnostics')
                    if (!current()) return
                    diagCard.replaceChildren(
                        h(
                            'div',
                            { class: 'section-heading' },
                            h('h2', {}, '错误诊断'),
                            h('span', { class: 'badge gray' }, `${data.count} 条`)
                        )
                    )
                    if (!data.count)
                        return diagCard.append(
                            emptyState('暂无诊断记录', '开启错误诊断后，运行异常时会保存截图与页面快照。', 'shield')
                        )
                    diagCard.append(
                        h(
                            'div',
                            { class: 'table-wrap' },
                            h(
                                'table',
                                {},
                                h(
                                    'thead',
                                    {},
                                    h(
                                        'tr',
                                        {},
                                        ['名称', '时间', '资源', '错误摘要'].map(x => h('th', { scope: 'col' }, x))
                                    )
                                ),
                                h(
                                    'tbody',
                                    {},
                                    data.entries.slice(0, 30).map(entry =>
                                        h(
                                            'tr',
                                            {},
                                            h('td', {}, entry.name),
                                            h('td', {}, fmtTime(entry.createdAt)),
                                            h(
                                                'td',
                                                { class: 'resource-links' },
                                                [
                                                    ['hasScreenshot', 'screenshot.png', '截图'],
                                                    ['hasHtml', 'dump.html', '页面'],
                                                    ['hasError', 'error.txt', '日志']
                                                ].map(([key, file, label]) =>
                                                    entry[key]
                                                        ? h(
                                                              'a',
                                                              {
                                                                  href: `/diagnostics/${encodeURIComponent(entry.name)}/${file}`,
                                                                  target: '_blank',
                                                                  rel: 'noopener noreferrer'
                                                              },
                                                              label
                                                          )
                                                        : null
                                                )
                                            ),
                                            h('td', { class: 'wrap error-summary' }, (entry.error || '').slice(0, 200))
                                        )
                                    )
                                )
                            )
                        )
                    )
                } catch (err) {
                    if (current())
                        diagCard.replaceChildren(
                            h('h2', {}, '错误诊断'),
                            h('p', { class: 'inline-error' }, `加载失败：${err.message}`)
                        )
                }
            })()
        ])
    }
    return { viewSchedule, viewConfig, viewTools }
}
