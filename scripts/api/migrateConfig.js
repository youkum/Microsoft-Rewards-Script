import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeJsonAtomic } from '../atomicFile.cjs'
import { validateConfig } from './configEditor.js'

// Older API saves could replace the entrypoint symlink with a regular file in
// the container layer. Recover it BEFORE relinking, if it is newer than the mount.
export async function migrateLegacyConfig(projectRoot) {
    const rootFile = path.join(projectRoot, 'config.json')
    const mounted = path.join(projectRoot, 'config', 'config.json')
    let stat
    try {
        stat = fs.lstatSync(rootFile)
    } catch (error) {
        if (error.code === 'ENOENT') return { recovered: false }
        throw error
    }
    if (!stat.isFile()) return { recovered: false }
    const config = JSON.parse(fs.readFileSync(rootFile, 'utf8'))
    const validation = await validateConfig(config, { projectRoot })
    if (!validation.ok) throw new Error('Legacy container config is invalid; preserve and inspect it before restarting')
    fs.mkdirSync(path.dirname(mounted), { recursive: true })
    writeJsonAtomic(path.join(projectRoot, 'config', 'config.container-recovery.json'), config)
    if (fs.existsSync(mounted) && fs.statSync(mounted).mtimeMs > stat.mtimeMs) return { recovered: false }
    if (fs.existsSync(mounted)) {
        const backup = `${mounted}.pre-persistence-fix.bak`
        fs.copyFileSync(mounted, backup)
        fs.chmodSync(backup, 0o600)
    }
    writeJsonAtomic(mounted, config)
    return { recovered: true }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = await migrateLegacyConfig(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
    if (result.recovered)
        console.log('[entrypoint] Recovered newer container config into persistent config/config.json.')
}
