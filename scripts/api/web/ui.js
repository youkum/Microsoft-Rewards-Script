export function h(tag, props = {}, ...children) {
    const el = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
        if (value == null) continue
        if (key === 'class') el.className = value
        else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value)
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value)
        else if (key === 'checked' || key === 'selected') el[key] = Boolean(value)
        else if (key in el && key !== 'type' && key !== 'value') {
            try {
                el[key] = value
            } catch {
                el.setAttribute(key, value)
            }
        } else el.setAttribute(key, value)
    }
    for (const child of children.flat()) {
        if (child == null) continue
        el.append(child.nodeType ? child : document.createTextNode(String(child)))
    }
    return el
}

export function createApi(fetchImpl = globalThis.fetch) {
    return async function api(path, { method = 'GET', body, signal } = {}) {
        const res = await fetchImpl(path, {
            method,
            signal,
            headers: {
                'content-type': 'application/json',
                'x-requested-with': 'XMLHttpRequest'
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        })
        let data = null
        try {
            data = await res.json()
        } catch {
            /* non-json */
        }
        if (!res.ok) {
            const err = new Error(data?.error || `HTTP ${res.status}`)
            err.status = res.status
            err.code = data?.code
            err.data = data
            throw err
        }
        return data
    }
}

// Capture a page's identity before awaiting work. A route change or logout invalidates it.
export function pageGuard(state, main = document.getElementById('main')) {
    const generation = state.routeGeneration
    return () =>
        Boolean(
            state.me?.authenticated && state.routeGeneration === generation && document.getElementById('main') === main
        )
}

export function setBusy(element, busy, label) {
    if (!element) return
    element.disabled = busy
    element.setAttribute('aria-busy', String(busy))
    if (label !== undefined) element.textContent = label
}

export function icon(name, className = '') {
    const paths = {
        grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
        users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
        chart: 'M4 3v17h17 M8 15v-4 M13 15V7 M18 15V4',
        terminal: 'm4 6 6 6-6 6 M13 18h7',
        clock: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M12 6v6l4 2',
        bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4',
        sliders: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
        shield: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z m-4 9 3 3 5-6',
        arrow: 'M5 12h14 m-6-6 6 6-6 6',
        play: 'm8 4 12 8-12 8z',
        stop: 'M5 5h14v14H5z',
        refresh: 'M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-1l2 3 M4 15l2 3a7 7 0 0 0 12-1',
        logout: 'M9 4H4v16h5 M10 12h12 m-5-5 5 5-5 5',
        plus: 'M12 5v14 M5 12h14',
        spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z'
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    for (const [key, value] of Object.entries({
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.7,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
        class: `icon ${className}`
    }))
        svg.setAttribute(key, value)
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', paths[name] || paths.grid)
    svg.append(path)
    return svg
}

export function pageTitle(title, subtitle, ...actions) {
    return h(
        'div',
        { class: 'page-title' },
        h('div', { class: 'page-heading' }, h('h1', {}, title), h('p', {}, subtitle)),
        h('div', { class: 'page-actions' }, ...actions)
    )
}

export function emptyState(title, description, iconName = 'chart') {
    return h(
        'div',
        { class: 'empty-state' },
        h('div', { class: 'empty-icon' }, icon(iconName)),
        h('strong', {}, title),
        h('p', {}, description)
    )
}

export const fmtInt = value => (value == null ? '—' : Number(value).toLocaleString('zh-CN'))
export const fmtTime = iso => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—')
export const esc = s =>
    String(s ?? '').replace(
        /[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    )
