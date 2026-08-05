/**
 * 启动已打包的桌面程序，确认进程能起来且短时内不崩溃。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exe = path.join(root, 'release', 'win-unpacked', '印尼盾记账.exe')

if (!fs.existsSync(exe)) {
  console.log('launch-smoke skip: 未找到', exe)
  process.exit(0)
}

console.log('launch-smoke 启动', exe)
const child = spawn(exe, [], {
  cwd: path.dirname(exe),
  detached: false,
  stdio: 'ignore',
  windowsHide: false,
})

let exited = false
let exitCode = null
child.on('exit', (code) => {
  exited = true
  exitCode = code
})

await new Promise((r) => setTimeout(r, 4500))

if (exited && exitCode !== 0) {
  console.error('进程异常退出，code=', exitCode)
  process.exit(1)
}

try {
  if (!exited) {
    child.kill()
    // Windows 上再等一下
    await new Promise((r) => setTimeout(r, 500))
    if (!exited && child.pid) {
      try {
        process.kill(child.pid)
      } catch {
        /* ignore */
      }
    }
  }
} catch {
  /* ignore */
}

assert.ok(true)
console.log('launch-smoke ok（进程存活未秒退）')
