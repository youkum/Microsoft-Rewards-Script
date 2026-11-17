import assert from 'node:assert/strict'
import test from 'node:test'
import { createRefreshController } from './refresh.js'

function deferred() {
    let resolve
    const promise = new Promise(done => {
        resolve = done
    })
    return { promise, resolve }
}

function fixture(
    load,
    onError = error => {
        throw error
    }
) {
    const timers = new Map()
    const rendered = []
    let nextId = 0
    const controller = createRefreshController({
        load,
        render: value => rendered.push(value),
        onError,
        setTimer: callback => {
            const id = ++nextId
            timers.set(id, callback)
            return id
        },
        clearTimer: id => timers.delete(id)
    })
    return { controller, rendered, timers }
}

test('overlapping refreshes coalesce into one trailing load without parallel requests', async () => {
    const first = deferred()
    let calls = 0
    const { controller, rendered, timers } = fixture(() => (++calls === 1 ? first.promise : Promise.resolve(2)))
    const running = controller.activate()
    await Promise.resolve()
    controller.refresh()
    controller.refresh()
    assert.equal(calls, 1)
    first.resolve(1)
    await running
    assert.equal(calls, 2)
    assert.deepEqual(rendered, [1, 2])
    assert.equal(timers.size, 1)
    controller.deactivate()
    assert.equal(timers.size, 0)
})

test('leaving during a request aborts and suppresses stale responses and timers', async () => {
    const pending = deferred()
    let signal
    const { controller, rendered, timers } = fixture(value => {
        signal = value
        return pending.promise
    })
    const running = controller.activate()
    await Promise.resolve()
    controller.deactivate()
    assert.equal(signal.aborted, true)
    pending.resolve('old view')
    await running
    assert.deepEqual(rendered, [])
    assert.equal(timers.size, 0)
})

test('rapid re-entry keeps only the current view and one polling timer', async () => {
    const old = deferred()
    let calls = 0
    const { controller, rendered, timers } = fixture(() => (++calls === 1 ? old.promise : Promise.resolve('current')))
    const first = controller.activate()
    await Promise.resolve()
    await controller.activate()
    old.resolve('obsolete')
    await first
    assert.deepEqual(rendered, ['current'])
    assert.equal(timers.size, 1)
    controller.deactivate()
})

test('authentication failure can deactivate before a new timer is scheduled', async () => {
    let controller
    const errors = []
    const context = fixture(
        async () => {
            throw Object.assign(new Error('Unauthorized'), { status: 401 })
        },
        error => {
            errors.push(error.status)
            controller.deactivate()
        }
    )
    controller = context.controller
    await controller.activate()
    assert.deepEqual(errors, [401])
    assert.equal(context.timers.size, 0)
})
