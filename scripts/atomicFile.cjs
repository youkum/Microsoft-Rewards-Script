'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

// Resolve the file itself before renaming: rename over a symlink replaces the
// link, leaving Docker's bind-mounted config unchanged. Also handle dangling links.
function resolveWriteTarget(filePath) {
    let target = path.resolve(filePath)
    for (let hops = 0; hops < 40; hops++) {
        try {
            const stat = fs.lstatSync(target)
            if (!stat.isSymbolicLink()) return fs.realpathSync(target)
            target = path.resolve(path.dirname(target), fs.readlinkSync(target))
        } catch (error) {
            if (error.code !== 'ENOENT') throw error
            return target
        }
    }
    throw new Error('Too many config symlinks')
}

function writeJsonAtomic(filePath, value, { backup = true } = {}) {
    const target = resolveWriteTarget(filePath)
    let backupPath
    if (backup && fs.existsSync(target)) {
        try {
            backupPath = `${target}.bak`
            fs.copyFileSync(target, backupPath)
            fs.chmodSync(backupPath, 0o600)
        } catch {
            backupPath = undefined
        }
    }
    const tmp = `${target}.${randomUUID()}.tmp`
    let fd
    try {
        fd = fs.openSync(tmp, 'wx', 0o600)
        fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n')
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fd = undefined
        fs.renameSync(tmp, target)
        // Windows doesn't support opening directories for fsync.
        if (process.platform !== 'win32') {
            const dir = fs.openSync(path.dirname(target), 'r')
            try {
                fs.fsyncSync(dir)
            } finally {
                fs.closeSync(dir)
            }
        }
    } finally {
        if (fd !== undefined) fs.closeSync(fd)
        fs.rmSync(tmp, { force: true })
    }
    return { target, backupPath }
}

module.exports = { resolveWriteTarget, writeJsonAtomic }
