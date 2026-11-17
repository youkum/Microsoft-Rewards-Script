import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isValidCron, readSchedule, scheduleFilePath, writeSchedule } from './scheduleStore.js'

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-schedule-test-'))
    const previous = Object.fromEntries(['SCHEDULE_FILE', 'CRON_SCHEDULE', 'TZ'].map(key => [key, process.env[key]]))
    delete process.env.SCHEDULE_FILE
    delete process.env.CRON_SCHEDULE
    process.env.TZ = 'UTC'
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true })
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    })
    return root
}

function seed(root, data = { enabled: true, cron: '0 9 * * *', skipIfRunning: true, excludedAccountIndexes: [2] }) {
    const file = scheduleFilePath(root)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const contents = JSON.stringify(data, null, 4) + '\n'
    fs.writeFileSync(file, contents)
    return { file, contents }
}

test('cron validation accepts five numeric fields with ranges, lists and steps', () => {
    for (const cron of ['0 9 * * *', '*/15 8-18/2 * 1,6,12 0-7', ' 5 0 1 1 7 ', '0,30 0,12 1-31 1-12 0-6']) {
        assert.equal(isValidCron(cron), true, cron)
    }
    for (const cron of [
        null,
        42,
        '',
        '* * * *',
        '* * * * * *',
        '60 9 * * *',
        '0 24 * * *',
        '0 9 0 * *',
        '0 9 * 13 *',
        '0 9 * * 8',
        '*/0 * * * *',
        '10-1 * * * *',
        '0 9 * * MON',
        '0 9 * * *; touch example'
    ]) {
        assert.equal(isValidCron(cron), false, String(cron))
    }
})

test('schedule patches validate before saving or applying', t => {
    const root = fixture(t)
    let applies = 0
    const apply = () => applies++
    for (const patch of [
        null,
        [],
        'bad',
        { cron: '60 9 * * *' },
        { cron: null },
        { enabled: 'true' },
        { enabled: true },
        { skipIfRunning: 1 },
        { excludedAccountIndexes: '1' },
        { excludedAccountIndexes: [0] },
        { excludedAccountIndexes: [1.5] }
    ]) {
        assert.throws(() => writeSchedule(root, patch, apply), { code: 'BAD_REQUEST' })
    }
    assert.equal(applies, 0)
    assert.equal(fs.existsSync(scheduleFilePath(root)), false)
})

test('enable, edit and disable save normalized schedules and invoke trusted apply each time', t => {
    const root = fixture(t)
    const calls = []
    const apply = next => {
        calls.push(structuredClone(next))
        assert.equal(JSON.parse(fs.readFileSync(scheduleFilePath(root), 'utf8')).enabled, next.enabled)
    }
    const enabled = writeSchedule(
        root,
        {
            enabled: true,
            cron: ' 0 9 * * * ',
            skipIfRunning: false,
            excludedAccountIndexes: [3, 1, 3],
            skipApply: true // Untrusted request data cannot bypass the apply boundary.
        },
        apply
    )
    assert.equal(enabled.enabled, true)
    assert.equal(enabled.cron, '0 9 * * *')
    assert.equal(enabled.timezone, 'UTC')
    assert.equal(enabled.source, 'override')
    assert.deepEqual(enabled.excludedAccountIndexes, [1, 3])
    assert.ok(Number.isFinite(Date.parse(enabled.updatedAt)))
    assert.equal('skipApply' in enabled, false)
    assert.equal(calls.length, 1)
    const edited = writeSchedule(root, { cron: '30 8 * * 1-5' }, apply)
    assert.equal(edited.enabled, true)
    assert.equal(edited.skipIfRunning, false)
    const disabled = writeSchedule(root, { enabled: false }, apply)
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.cron, edited.cron)
    assert.deepEqual(readSchedule(root), disabled)
    assert.deepEqual(
        calls.map(call => call.enabled),
        [true, true, false]
    )
    assert.deepEqual(fs.readdirSync(path.dirname(scheduleFilePath(root))), ['schedule.json'])
})

test('apply failure restores exact previous file and reapplies prior effective schedule', t => {
    const root = fixture(t)
    const { file, contents } = seed(root)
    const previous = readSchedule(root)
    const calls = []
    const failure = new Error('crontab install failed')
    assert.throws(
        () =>
            writeSchedule(root, { cron: '0 10 * * *' }, next => {
                calls.push(structuredClone(next))
                if (calls.length === 1) throw failure
            }),
        error => {
            assert.equal(error.code, 'SCHEDULE_UPDATE_FAILED')
            assert.equal(error.cause, failure)
            assert.match(error.message, /crontab install failed.*Previous schedule restored/)
            return true
        }
    )
    assert.equal(calls[0].cron, '0 10 * * *')
    assert.deepEqual(calls[1], previous)
    assert.equal(fs.readFileSync(file, 'utf8'), contents)
    assert.deepEqual(readSchedule(root), previous)
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['schedule.json'])
})

test('failed first override removes the new file and restores the environment schedule', t => {
    const root = fixture(t)
    process.env.CRON_SCHEDULE = '15 7 * * *'
    const previous = readSchedule(root)
    const calls = []
    assert.throws(
        () =>
            writeSchedule(root, { enabled: false }, next => {
                calls.push(structuredClone(next))
                if (calls.length === 1) throw new Error('disable failed')
            }),
        /disable failed/
    )
    assert.equal(fs.existsSync(scheduleFilePath(root)), false)
    assert.deepEqual(calls[1], previous)
    assert.deepEqual(readSchedule(root), previous)
})

test('failed prior cron restoration is reported without hiding the apply error or losing old data', t => {
    const root = fixture(t)
    const { file, contents } = seed(root)
    let calls = 0
    assert.throws(
        () =>
            writeSchedule(root, { enabled: false }, () => {
                calls++
                throw new Error(calls === 1 ? 'install failure' : 'recovery failure')
            }),
        error => {
            assert.equal(error.code, 'SCHEDULE_UPDATE_FAILED')
            assert.match(
                error.message,
                /install failure.*Rollback incomplete: previous cron restore failed: recovery failure/
            )
            return true
        }
    )
    assert.equal(calls, 2)
    assert.equal(fs.readFileSync(file, 'utf8'), contents)
})

test('save failure leaves previous file intact and attempts to restore previous cron', t => {
    const root = fixture(t)
    const { file, contents } = seed(root)
    // A directory at the staging path deterministically prevents the save.
    const tmp = `${file}.${process.pid}.tmp`
    fs.mkdirSync(tmp)
    const calls = []
    assert.throws(() => writeSchedule(root, { enabled: false }, next => calls.push(next)), {
        code: 'SCHEDULE_UPDATE_FAILED'
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].enabled, true)
    assert.equal(fs.readFileSync(file, 'utf8'), contents)
})

test('corrupt saved schedules fail closed without applying', t => {
    const root = fixture(t)
    const { file } = seed(root, { enabled: true, cron: 'invalid' })
    const contents = fs.readFileSync(file, 'utf8')
    let calls = 0
    assert.throws(() => writeSchedule(root, { enabled: false }, () => calls++), { code: 'CORRUPT_SCHEDULE' })
    assert.equal(calls, 0)
    assert.equal(fs.readFileSync(file, 'utf8'), contents)
})
