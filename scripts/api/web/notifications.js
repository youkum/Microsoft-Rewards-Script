import { h, icon, fmtInt, pageGuard, pageTitle, setBusy } from './ui.js'

// Never copy the redacted config into a write. An empty password means preserve;
// deleting a stored token is a separate, explicit action.
export function buildNotificationBody(fields) {
    const rawTarget = fields.targetPoints.value.trim()
    const targetPoints = rawTarget === '' ? null : Number(rawTarget)
    if (rawTarget !== '' && (!/^\d+$/.test(rawTarget) || !Number.isSafeInteger(targetPoints) || targetPoints < 1))
        throw new Error('目标积分必须是正整数；暂不设置请留空。')

    const name = fields.goalName.value.trim()
    if (!name) throw new Error('请输入兑换目标名称。')
    const pushplus = { enabled: fields.enabled.checked }
    if (fields.clearToken.checked) pushplus.token = ''
    else if (fields.token.value.trim()) {
        const token = fields.token.value.trim()
        if (token.includes('REDACTED')) throw new Error('不能使用打码占位符作为 Token；留空可保留原值。')
        pushplus.token = token
    }
    for (const key of ['title', 'template', 'channel']) {
        const value = fields[key].value.trim()
        if (value) pushplus[key] = value
    }
    return {
        webhook: { pushplus },
        rewardGoal: { name, faceValue: 100, targetPoints }
    }
}

export function createNotificationsView({ api, state, toast }) {
    async function viewNotifications() {
        const main = document.getElementById('main')
        const current = pageGuard(state, main)
        main.replaceChildren(pageTitle('通知', '配置 PushPlus 与兑换目标，先预览，再安心保存。'))
        const data = await api('/config')
        if (!current()) return
        const config = data.config || {}
        const pushplus = config.webhook?.pushplus || {}
        const writable = state.me?.capabilities?.configWrite === true && data.writable !== false
        const demo = Boolean(state.me?.demo)
        let saving = false
        let previewing = false

        const previewStatus = h('span', { class: 'hint', role: 'status' }, '正在读取预览…')
        const previewText = h('pre', { class: 'notification-preview', tabIndex: 0, 'aria-label': '逐账号通知内容预览' })
        const previewSummary = h('p', { class: 'hint' })
        const saveStatus = h('span', { class: 'hint', role: 'status' }, '仅修改本页字段，其他配置与通知渠道保持不变。')
        const saveButton = h('button', { class: 'btn primary', type: 'submit', disabled: !writable }, '保存并刷新预览')
        const refreshButton = h(
            'button',
            {
                class: 'btn',
                type: 'button',
                onclick: () => {
                    if (current() && !saving && !previewing) refreshPreview()
                }
            },
            icon('refresh'),
            '刷新预览'
        )
        const token = h('input', {
            type: 'password',
            name: 'token',
            value: '',
            autocomplete: 'new-password',
            placeholder: '留空保留已保存的 Token',
            disabled: !writable
        })
        const clearToken = h('input', {
            type: 'checkbox',
            name: 'clearToken',
            disabled: !writable,
            onchange: () => {
                token.disabled = clearToken.checked || !writable
                if (clearToken.checked) token.value = ''
            }
        })
        const fields = h(
            'fieldset',
            { class: 'notification-fields', disabled: !writable },
            h('legend', { class: 'sr-only' }, '通知与兑换目标设置'),
            h(
                'label',
                { class: 'check switch-row' },
                h('input', { type: 'checkbox', name: 'enabled', checked: Boolean(pushplus.enabled) }),
                '启用 PushPlus 通知'
            ),
            h(
                'label',
                { class: 'f' },
                'PushPlus Token',
                token,
                h('span', { class: 'hint' }, '已保存的 Token 不会回填或显示；填写新值将替换，留空则保留。')
            ),
            h('label', { class: 'check clear-field' }, clearToken, '明确清除已保存的 Token'),
            h(
                'div',
                { class: 'form-row' },
                h(
                    'label',
                    { class: 'f' },
                    '通知标题（可选）',
                    h('input', {
                        type: 'text',
                        name: 'title',
                        value: pushplus.title || '',
                        placeholder: '留空保留现有配置'
                    })
                ),
                h(
                    'label',
                    { class: 'f' },
                    '推送渠道（可选）',
                    h('input', {
                        type: 'text',
                        name: 'channel',
                        value: pushplus.channel || '',
                        placeholder: '例如 wechat；留空保留'
                    })
                )
            ),
            h(
                'label',
                { class: 'f' },
                '内容模板（可选）',
                h(
                    'select',
                    { name: 'template' },
                    [
                        ['', '使用默认 / 保留现有配置'],
                        ['txt', '纯文本'],
                        ['html', 'HTML'],
                        ['markdown', 'Markdown']
                    ].map(([value, label]) =>
                        h('option', { value, selected: value === (pushplus.template || '') }, label)
                    )
                )
            ),
            h(
                'div',
                { class: 'notification-goal' },
                h(
                    'div',
                    { class: 'section-heading' },
                    h(
                        'div',
                        {},
                        h('h2', {}, '兑换目标'),
                        h('p', { class: 'section-description' }, '面值 ¥100 · 默认目标为 100元礼品卡')
                    ),
                    h('span', { class: 'badge gray' }, '手动设置门槛')
                ),
                h(
                    'label',
                    { class: 'f' },
                    '目标名称',
                    h('input', {
                        type: 'text',
                        name: 'goalName',
                        value: config.rewardGoal?.name || '100元礼品卡',
                        required: true
                    })
                ),
                h(
                    'label',
                    { class: 'f' },
                    '目标积分（可选）',
                    h('input', {
                        type: 'number',
                        name: 'targetPoints',
                        min: 1,
                        step: 1,
                        value: config.rewardGoal?.targetPoints ?? '',
                        placeholder: '请输入兑换页面显示的实际所需积分'
                    }),
                    h(
                        'span',
                        { class: 'hint' },
                        '兑换门槛以您的 Rewards 兑换页面为准。留空即未设置，不会推测所需积分或达成时间。'
                    )
                )
            )
        )
        const form = h(
            'form',
            {
                onsubmit: async event => {
                    event.preventDefault()
                    if (!current() || !writable || saving || previewing) return
                    let body
                    try {
                        body = buildNotificationBody(form.elements)
                    } catch (err) {
                        return toast(err.message, 'error')
                    }
                    saving = true
                    fields.disabled = true
                    setBusy(saveButton, true, '正在保存…')
                    setBusy(refreshButton, true, '刷新预览')
                    saveStatus.textContent = '正在保存通知设置…'
                    try {
                        await api('/config', { method: 'PATCH', body })
                        if (!current()) return
                        token.value = ''
                        clearToken.checked = false
                        token.disabled = !writable
                        saveStatus.textContent = demo
                            ? '演示配置已保存，不会发送真实通知。'
                            : '通知配置已保存，下次运行生效。'
                        toast(saveStatus.textContent, 'success')
                        await refreshPreview()
                    } catch (err) {
                        if (current()) {
                            saveStatus.textContent = `保存失败：${err.message}`
                            toast(saveStatus.textContent, 'error')
                        }
                    } finally {
                        saving = false
                        if (current()) {
                            fields.disabled = !writable
                            setBusy(saveButton, !writable, '保存并刷新预览')
                            setBusy(refreshButton, false, '刷新预览')
                        }
                    }
                }
            },
            fields,
            h(
                'div',
                { class: 'form-footer' },
                saveButton,
                writable ? saveStatus : h('span', { class: 'hint' }, '当前为只读模式，配置写入权限未开启。')
            )
        )

        async function refreshPreview() {
            previewing = true
            setBusy(refreshButton, true, '正在读取…')
            setBusy(saveButton, true, saving ? '正在保存…' : '保存并刷新预览')
            previewStatus.textContent = '正在读取已保存配置的预览…'
            try {
                const preview = await api('/notifications/preview')
                if (!current()) return
                previewText.textContent = typeof preview.content === 'string' ? preview.content : '暂无可预览内容。'
                const count = Array.isArray(preview.accounts) ? preview.accounts.length : 0
                const goal = preview.goal || {}
                previewSummary.textContent = `${count} 个账号 · ${goal.name || '100元礼品卡'} · ${goal.targetPoints == null ? '未设置目标积分' : `目标 ${fmtInt(goal.targetPoints)} 积分`}`
                previewStatus.textContent = demo ? '示例数据 · 仅预览，不发送' : '基于已保存配置与积分记录 · 不发送通知'
            } catch (err) {
                if (current()) {
                    previewText.textContent = ''
                    previewSummary.textContent = ''
                    previewStatus.textContent = `预览读取失败：${err.message}。可点击「刷新预览」重试。`
                }
            } finally {
                previewing = false
                if (current()) {
                    setBusy(refreshButton, saving, '刷新预览')
                    setBusy(saveButton, saving || !writable, saving ? '正在保存…' : '保存并刷新预览')
                }
            }
        }

        main.append(
            h(
                'div',
                { class: 'notification-layout' },
                h(
                    'section',
                    { class: 'card' },
                    h(
                        'div',
                        { class: 'section-heading' },
                        h(
                            'div',
                            {},
                            h('h2', {}, '推送设置'),
                            h('p', { class: 'section-description' }, '每日运行摘要，按账号清晰呈现。')
                        ),
                        h('span', { class: 'badge gray' }, 'PushPlus')
                    ),
                    form
                ),
                h(
                    'section',
                    { class: 'card notification-preview-card', 'aria-label': '通知预览' },
                    h(
                        'div',
                        { class: 'section-heading' },
                        h(
                            'div',
                            {},
                            h('h2', {}, '通知内容预览'),
                            h('p', { class: 'section-description' }, '仅查看样例，不会向 PushPlus 发出请求。')
                        ),
                        refreshButton
                    ),
                    previewStatus,
                    previewSummary,
                    previewText,
                    h(
                        'p',
                        { class: 'hint' },
                        '预览使用服务器已保存的配置。修改后请「保存并刷新预览」，本页不提供真实试推送。'
                    )
                )
            )
        )
        await refreshPreview()
    }
    return { viewNotifications }
}
