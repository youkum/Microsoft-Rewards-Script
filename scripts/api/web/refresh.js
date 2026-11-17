// Own one view's requests and polling timer; obsolete responses never reach the view.
export function createRefreshController({
    load,
    render,
    onError,
    interval = 5000,
    setTimer = setTimeout,
    clearTimer = clearTimeout
}) {
    let session = null

    function clearPoll(current) {
        if (current.timer !== null) clearTimer(current.timer)
        current.timer = null
    }

    function refresh() {
        const current = session
        if (!current) return Promise.resolve()
        clearPoll(current)
        if (current.inFlight) {
            current.pending = true
            return current.inFlight
        }
        current.inFlight = Promise.resolve()
            .then(async () => {
                do {
                    current.pending = false
                    try {
                        const data = await load(current.controller.signal)
                        if (session === current) render(data)
                    } catch (error) {
                        if (session === current && error.name !== 'AbortError') onError(error)
                    }
                } while (session === current && current.pending)
            })
            .finally(() => {
                current.inFlight = null
                if (session === current) current.timer = setTimer(refresh, interval)
            })
        return current.inFlight
    }

    function deactivate() {
        if (!session) return
        const previous = session
        session = null
        clearPoll(previous)
        previous.controller.abort()
    }

    function activate() {
        deactivate()
        session = { controller: new AbortController(), inFlight: null, pending: false, timer: null }
        return refresh()
    }

    return { activate, deactivate, refresh }
}
