import { h, fmtInt, fmtTime, pageGuard, pageTitle, emptyState, icon, setBusy } from './ui.js'

export function buildAccountBody(fd, isEdit) {
    const body = {
        email: fd.email.value.trim(),
        langCode: fd.lang.value.trim(),
        geoLocale: fd.geo.value.trim(),
        saveFingerprint: { mobile: fd.fpMobile.checked, desktop: fd.fpDesktop.checked }
    }
    const clearFields = []
    for (const [field, name] of [
        ['password', 'password'],
        ['totpSecret', 'totp'],
        ['recoveryEmail', 'recovery']
    ]) {
        const value = field === 'password' ? fd[name].value : fd[name].value.trim()
        if (isEdit && fd[`clear-${field}`]?.checked) clearFields.push(field)
        else if (!isEdit || value !== '') body[field] = value
    }
    if (isEdit && fd['clear-proxy']?.checked) clearFields.push('proxy')
    else {
        const proxy = {}
        for (const [field, name] of [
            ['url', 'proxyUrl'],
            ['port', 'proxyPort'],
            ['username', 'proxyUser'],
            ['password', 'proxyPass']
        ]) {
            const value = field === 'password' ? fd[name].value : fd[name].value.trim()
            if (isEdit && fd[`clear-proxy.${field}`]?.checked) clearFields.push(`proxy.${field}`)
            else if (!isEdit || value !== '') proxy[field] = value
        }
        // An empty proxy address on edit preserves the entire proxy configuration.
        if (!isEdit || Object.keys(proxy).length) {
            proxy.http = fd.proxyHttp.checked
            body.proxy = proxy
        }
    }
    if (clearFields.length) body.clearFields = clearFields
    return body
}

export function formatProxyAddress(proxy) {
    const value = String(proxy?.url ?? '').trim()
    if (!value) return ''
    try {
        const address = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`)
        const port = String(proxy.port ?? '').trim() || address.port
        return `${address.protocol}//${address.hostname}${port ? `:${port}` : ''}`
    } catch {
        return '代理地址无效'
    }
}

export function createAccountsView({ api, state, toast }) {
    let closeActiveModal = null
    let active = () => false
    let refreshVersion = 0
    function dispose() {
        closeActiveModal?.(false)
        active = () => false
        refreshVersion++
    }
    // ────────────────────────── 账号管理 ──────────────────────────
    async function viewAccounts() {
        const main = document.getElementById('main')
        main.innerHTML = ''
        active = pageGuard(state, main)
        const writable = Boolean(state.me?.capabilities?.accountWrite)
        main.append(
            pageTitle(
                '账号管理',
                writable ? '集中管理账号与网络配置，修改在下次运行时生效。' : '当前为只读模式，账号写入权限未开启。',
                h(
                    'button',
                    { class: 'btn primary', disabled: !writable, onclick: () => openAccountModal(null) },
                    icon('plus'),
                    '新增账号'
                )
            ),
            h(
                'div',
                { class: 'table-wrap', id: 'acc-table' },
                h('p', { style: { padding: '14px', color: 'var(--text-dim)' } }, '加载中…')
            ),
            h(
                'p',
                { class: 'hint', style: { marginTop: '10px' } },
                '代理用于配置网络出口；连通性测试仅验证连接情况。SOCKS 代理不支持账号密码认证。'
            )
        )
        await refreshAccounts()
    }

    async function refreshAccounts() {
        const isCurrent = active
        const version = ++refreshVersion
        const wrap = document.getElementById('acc-table')
        if (!wrap || !isCurrent()) return
        let data
        try {
            data = await api('/accounts')
        } catch (err) {
            if (!isCurrent() || version !== refreshVersion) return
            wrap.innerHTML = ''
            wrap.append(h('p', { class: 'inline-error' }, err.message))
            return
        }

        if (!isCurrent() || version !== refreshVersion || document.getElementById('acc-table') !== wrap) return
        wrap.innerHTML = ''
        if (!data.accounts.length) {
            wrap.append(
                emptyState('还没有添加账号', '点击「新增账号」开始配置，也可以继续使用环境文件中的账号。', 'users')
            )
            return
        }

        wrap.append(
            h(
                'table',
                {},
                h(
                    'thead',
                    {},
                    h(
                        'tr',
                        {},
                        ['#', '邮箱', '配置', '语言/地区', '代理', '来源', '近期战绩', '操作'].map(x => h('th', {}, x))
                    )
                ),
                h(
                    'tbody',
                    {},
                    data.accounts.map(account => {
                        const proxyAddress = formatProxyAddress(account.proxy)
                        const proxyBadge = account.proxy
                            ? h(
                                  'span',
                                  {
                                      class: 'badge blue',
                                      title: proxyAddress
                                  },
                                  `${proxyAddress}${account.proxy.hasCredentials ? ' 🔑' : ''}`
                              )
                            : h('span', { class: 'badge gray' }, '直连')
                        return h(
                            'tr',
                            {},
                            h('td', {}, `ACCOUNT_${account.index}`),
                            h('td', { class: 'wrap' }, account.email),
                            h(
                                'td',
                                {},
                                account.hasPassword
                                    ? h('span', { class: 'badge gray' }, '密码')
                                    : h('span', { class: 'badge yellow' }, '无密码'),
                                account.hasTotp ? h('span', { class: 'badge green' }, '2FA') : '',
                                account.saveFingerprint?.mobile || account.saveFingerprint?.desktop
                                    ? h('span', { class: 'badge gray' }, '指纹保存')
                                    : ''
                            ),
                            h('td', {}, `${account.langCode} / ${account.geoLocale}`),
                            h('td', {}, proxyBadge),
                            h(
                                'td',
                                {},
                                account.source === 'web'
                                    ? h('span', { class: 'badge green' }, 'WebUI')
                                    : h('span', { class: 'badge gray', title: '来自 .env,仅可在文件中修改' }, '.env')
                            ),
                            h(
                                'td',
                                {},
                                h(
                                    'span',
                                    { title: `成功连击 ${account.successStreak ?? 0}` },
                                    `runs ${account.runs ?? 0} · 累计 ${fmtInt(account.totalCollected ?? 0)} 分`
                                ),
                                account.lastRunAt
                                    ? h(
                                          'div',
                                          { class: 'hint' },
                                          `最近 ${fmtTime(account.lastRunAt)}:${account.lastSuccess === true ? '✅' : account.lastSuccess === false ? '❌' : '—'} +${fmtInt(account.lastCollected ?? 0)}`
                                      )
                                    : ''
                            ),
                            h(
                                'td',
                                {},
                                h('button', { class: 'btn small', onclick: () => testProxy(account) }, '测代理'),
                                ' ',
                                h(
                                    'button',
                                    { class: 'btn small primary', onclick: () => startRunSingle(account.index) },
                                    '只跑此号'
                                ),
                                ' ',
                                h(
                                    'button',
                                    {
                                        class: 'btn small',
                                        onclick: event => saveLoginSingle(account, event.currentTarget)
                                    },
                                    '保存登录会话'
                                ),
                                ' ',
                                account.webManaged
                                    ? h(
                                          'button',
                                          { class: 'btn small', onclick: () => openAccountModal(account) },
                                          '编辑'
                                      )
                                    : h(
                                          'button',
                                          { class: 'btn small', disabled: true, title: '.env 账号请在文件中修改' },
                                          '编辑'
                                      ),
                                ' ',
                                account.webManaged
                                    ? h(
                                          'button',
                                          { class: 'btn small danger', onclick: () => deleteAccount(account) },
                                          '删除'
                                      )
                                    : h(
                                          'button',
                                          {
                                              class: 'btn small danger',
                                              disabled: true,
                                              title: '.env 账号请在文件中删除'
                                          },
                                          '删除'
                                      )
                            )
                        )
                    })
                )
            )
        )
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

    async function saveLoginSingle(account, button) {
        if (button.disabled || !active()) return
        setBusy(button, true, '正在启动…')
        try {
            await api(`/accounts/${account.index}/login`, { method: 'POST', body: { platform: 'both' } })
            toast(`${account.email}：仅登录并保存手机与电脑会话，请在日志页处理验证码。`, 'success')
            location.hash = '#/logs'
        } catch (err) {
            toast(err.message, 'error')
        } finally {
            setBusy(button, false, '保存登录会话')
        }
    }

    async function testProxy(account) {
        toast(`正在测试 ${account.email} 的代理…`)
        try {
            const result = await api(`/accounts/${account.index}/proxy-test`, { method: 'POST', body: {} })
            if (result.ok && result.ip) {
                toast(
                    `✅ 代理连通:出口 IP ${result.ip}${result.country ? `(${result.country})` : ''},延迟 ${result.latencyMs}ms`,
                    'success'
                )
            } else if (result.connected) {
                toast('代理已连通，但出口 IP 查询失败。请稍后重试或检查代理的目标限制。', 'warn')
            } else {
                toast(`❌ 代理测试失败:${result.error}`, 'error')
            }
        } catch (err) {
            toast(`❌ ${err.message}`, 'error')
        }
    }

    function openAccountModal(account) {
        if (!active() || !state.me?.capabilities?.accountWrite) return
        closeActiveModal?.()
        const isCurrent = active
        let closed = false
        let submitting = false
        const isEdit = Boolean(account)
        const clearControl = (field, label, names) =>
            isEdit
                ? h(
                      'label',
                      { class: 'check clear-field' },
                      h('input', {
                          type: 'checkbox',
                          name: `clear-${field}`,
                          onchange: event => {
                              for (const name of names) {
                                  const input = form.elements[name]
                                  input.disabled =
                                      event.target.checked ||
                                      (form.elements['clear-proxy']?.checked && name.startsWith('proxy'))
                              }
                          }
                      }),
                      label
                  )
                : null
        const proxy = account?.proxy || {}
        const mask = h('div', {
            class: 'modal-mask',
            onclick: event => {
                if (event.target === mask) closeModal()
            }
        })
        const previousFocus = document.activeElement
        const closeModal = (restoreFocus = true) => {
            if (closed) return
            closed = true
            mask.remove()
            document.removeEventListener('keydown', onModalKeydown)
            closeActiveModal = null
            if (restoreFocus && previousFocus?.isConnected) previousFocus.focus?.()
        }
        closeActiveModal = closeModal
        const onModalKeydown = event => {
            if (event.key === 'Escape') closeModal()
            if (event.key !== 'Tab') return
            const fields = [
                ...form.querySelectorAll('input:not(:disabled), button:not(:disabled), select:not(:disabled)')
            ]
            const first = fields[0]
            const last = fields[fields.length - 1]
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault()
                last?.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first?.focus()
            }
        }
        const form = h(
            'form',
            {
                class: 'modal',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-labelledby': 'account-modal-title',
                onsubmit: async event => {
                    event.preventDefault()
                    if (submitting || closed || !isCurrent()) return
                    const body = buildAccountBody(form.elements, isEdit)
                    const button = form.querySelector('button[type="submit"]')
                    submitting = true
                    setBusy(button, true, '正在保存…')
                    try {
                        await api(isEdit ? `/accounts/${account.index}` : '/accounts', {
                            method: isEdit ? 'PATCH' : 'POST',
                            body
                        })
                        if (closed || !isCurrent()) return
                        toast(
                            isEdit ? `ACCOUNT_${account.index} 已更新，下次运行生效` : '账号已添加，下次运行生效',
                            'success'
                        )
                        closeModal()
                        await refreshAccounts()
                    } catch (err) {
                        if (!closed && isCurrent()) toast(err.message, 'error')
                    } finally {
                        submitting = false
                        setBusy(button, false, isEdit ? '保存修改' : '添加账号')
                    }
                }
            },
            h('h2', { id: 'account-modal-title' }, isEdit ? `编辑账号 ACCOUNT_${account.index}` : '新增账号'),
            h(
                'label',
                { class: 'f' },
                '邮箱 *',
                h('input', { type: 'text', name: 'email', required: true, value: account?.email ?? '' })
            ),
            h(
                'div',
                { class: 'form-row' },
                h(
                    'label',
                    { class: 'f' },
                    '密码',
                    h('input', {
                        type: 'password',
                        name: 'password',
                        autocomplete: 'new-password',
                        placeholder: isEdit ? '留空则保持不变' : '无密码账号可留空'
                    }),
                    clearControl('password', '清除已保存的密码', ['password'])
                ),
                h(
                    'label',
                    { class: 'f' },
                    '2FA 密钥(TOTP Base32)',
                    h('input', {
                        type: 'text',
                        name: 'totp',
                        placeholder: isEdit && account?.hasTotp ? '已配置（留空保持不变）' : '如 JBSWY3DPEHPK3PXP',
                        value: ''
                    }),
                    clearControl('totpSecret', '清除 2FA 密钥', ['totp'])
                )
            ),
            h(
                'div',
                { class: 'form-row' },
                h(
                    'label',
                    { class: 'f' },
                    '语言(BCP 47)',
                    h('input', {
                        type: 'text',
                        name: 'lang',
                        placeholder: 'zh-CN',
                        value: account?.langCode === 'en' ? '' : (account?.langCode ?? 'zh-CN')
                    })
                ),
                h(
                    'label',
                    { class: 'f' },
                    '国家/地区',
                    h('input', {
                        type: 'text',
                        name: 'geo',
                        placeholder: 'CN 或 auto',
                        value:
                            account?.geoLocale === 'AUTO'
                                ? 'auto'
                                : account?.geoLocale === 'auto'
                                  ? 'auto'
                                  : (account?.geoLocale ?? 'CN')
                    })
                )
            ),
            h(
                'label',
                { class: 'f' },
                '备用邮箱',
                h('input', {
                    type: 'text',
                    name: 'recovery',
                    value: '',
                    placeholder: isEdit ? '留空保持已保存的备用邮箱' : '选填'
                })
            ),
            clearControl('recoveryEmail', '清除备用邮箱', ['recovery']),
            h(
                'fieldset',
                {},
                h('legend', {}, '网络代理设置'),
                isEdit
                    ? h(
                          'label',
                          { class: 'check clear-field' },
                          h('input', {
                              type: 'checkbox',
                              name: 'clear-proxy',
                              onchange: event => {
                                  for (const name of [
                                      'proxyUrl',
                                      'proxyPort',
                                      'proxyUser',
                                      'proxyPass',
                                      'proxyHttp',
                                      'clear-proxy.username',
                                      'clear-proxy.password'
                                  ]) {
                                      const input = form.elements[name]
                                      if (input)
                                          input.disabled =
                                              event.target.checked ||
                                              (name === 'proxyUser' &&
                                                  form.elements['clear-proxy.username']?.checked) ||
                                              (name === 'proxyPass' && form.elements['clear-proxy.password']?.checked)
                                  }
                              }
                          }),
                          '移除代理，改为直连'
                      )
                    : null,
                h(
                    'label',
                    { class: 'f' },
                    '代理地址',
                    h('input', {
                        type: 'text',
                        name: 'proxyUrl',
                        placeholder: 'http://1.2.3.4 或 socks5://host',
                        value: proxy.url ?? ''
                    })
                ),
                h(
                    'div',
                    { class: 'form-row' },
                    h(
                        'label',
                        { class: 'f' },
                        '端口',
                        h('input', {
                            type: 'number',
                            name: 'proxyPort',
                            min: 1,
                            max: 65535,
                            placeholder: '8080',
                            value: proxy.port ?? ''
                        })
                    ),
                    h(
                        'label',
                        { class: 'f' },
                        '用户名(HTTP 代理)',
                        h('input', {
                            type: 'text',
                            name: 'proxyUser',
                            value: '',
                            placeholder: isEdit ? '留空保持不变' : '选填'
                        }),
                        clearControl('proxy.username', '清除代理用户名', ['proxyUser'])
                    )
                ),
                h(
                    'label',
                    { class: 'f' },
                    '密码(HTTP 代理)',
                    h('input', {
                        type: 'password',
                        name: 'proxyPass',
                        autocomplete: 'new-password',
                        value: '',
                        placeholder: isEdit ? '留空保持不变' : '选填'
                    }),
                    clearControl('proxy.password', '清除代理密码', ['proxyPass'])
                ),
                h(
                    'label',
                    { class: 'check' },
                    h('input', { type: 'checkbox', name: 'proxyHttp', checked: Boolean(proxy.http) }),
                    '查询源 HTTP 请求也走此代理'
                ),
                h(
                    'p',
                    { class: 'hint' },
                    'HTTP CONNECT 可访问 HTTPS 网站，地址通常填 http://。https:// 要求代理入口本身支持 TLS。SOCKS 不支持账号认证。编辑时留空密码保留原值。'
                )
            ),
            h(
                'div',
                { class: 'form-row' },
                h(
                    'label',
                    { class: 'check' },
                    h('input', {
                        type: 'checkbox',
                        name: 'fpMobile',
                        checked: account ? account.saveFingerprint?.mobile !== false : true
                    }),
                    '保存移动端指纹'
                ),
                h(
                    'label',
                    { class: 'check' },
                    h('input', {
                        type: 'checkbox',
                        name: 'fpDesktop',
                        checked: account ? account.saveFingerprint?.desktop !== false : true
                    }),
                    '保存桌面端指纹'
                )
            ),
            h(
                'div',
                { class: 'actions' },
                h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, '取消'),
                h('button', { class: 'btn primary', type: 'submit' }, isEdit ? '保存修改' : '添加账号')
            )
        )
        mask.append(form)
        document.body.append(mask)
        document.addEventListener('keydown', onModalKeydown)
        form.querySelector('input[name="email"]')?.focus()
    }

    async function deleteAccount(account) {
        if (
            !confirm(
                `确定删除账号 ${account.email}(ACCOUNT_${account.index})?\n注意:这只是移除配置,不会删除已保存的登录会话。`
            )
        )
            return
        try {
            await api(`/accounts/${account.index}`, { method: 'DELETE' })
            toast('账号已删除', 'success')
            await refreshAccounts()
        } catch (err) {
            toast(err.message, 'error')
        }
    }

    return { viewAccounts, dispose }
}
