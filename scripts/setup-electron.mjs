// scripts/setup-electron.mjs
// ---------------------------------------------------------------------------
// 为什么需要这个脚本
// ------------------
//   本机**无法访问 GitHub**（TLS 握手失败，实测），而 `electron` 的 npm 安装脚本
//   要从 GitHub release 下载 246 MB 的二进制。旧工程 `F:\deepseek harness\AI女友\node_modules\electron\dist`
//   里已经有一份可用的 Electron 44.4.5，因此这里：
//     ① 若本工程已存在可用的 electron/dist/electron.exe ⇒ 直接用；
//     ② 否则从旧工程的 node_modules 复制过来（离线、零网络）；
//     ③ 两者都没有 ⇒ 落地 `.electron-path.json` 记录缺失原因，并在 `--preflight` 时以退出码 2 报"环境不可用"。
//   **绝不**去 github.com 下载，也**绝不**修改旧工程的任何文件（只读复制）。
// ---------------------------------------------------------------------------
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const WANT_MAJOR = 44

const CANDIDATES = [
  join(ROOT, 'node_modules', 'electron'),
  'F:\\deepseek harness\\AI女友\\node_modules\\electron',
  join(process.env.LOCALAPPDATA ?? '', 'deepseek-harness', 'node_modules', 'electron'),
]

const MARKER = join(ROOT, '.electron-path.json')

function readPkgVersion(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch { return null }
}

function usableDist(dir) {
  const exe = join(dir, 'dist', 'electron.exe')
  if (!existsSync(exe)) return null
  try {
    const st = statSync(exe)
    if (st.size < 100 * 1024 * 1024) return null   // 明显是半成品/占位
  } catch { return null }
  return exe
}

function writeMarker(obj) {
  writeFileSync(MARKER, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...obj }, null, 2)}\n`, 'utf8')
}

const preflight = process.argv.includes('--preflight')

// ① 本工程内已有
const selfDir = CANDIDATES[0]
let exe = usableDist(selfDir)
let source = exe ? 'self' : null

// ② 从其它候选离线复制
if (!exe) {
  for (const dir of CANDIDATES.slice(1)) {
    const found = usableDist(dir)
    if (!found) continue
    try {
      mkdirSync(join(selfDir, 'dist'), { recursive: true })
      cpSync(join(dir, 'dist'), join(selfDir, 'dist'), { recursive: true, force: false, errorOnExist: false })
      if (existsSync(join(dir, 'path.txt'))) cpSync(join(dir, 'path.txt'), join(selfDir, 'path.txt'))
      const version = readPkgVersion(dir)
      mkdirSync(selfDir, { recursive: true })
      writeFileSync(join(selfDir, 'package.json'), `${JSON.stringify({ name: 'electron', version: version ?? 'unknown', private: true }, null, 2)}\n`, 'utf8')
      exe = usableDist(selfDir)
      source = `copied-from:${dir}`
      break
    } catch (e) {
      process.stderr.write(`[setup-electron] 复制失败 ${dir}: ${e?.message ?? e}\n`)
    }
  }
}

if (!exe) {
  writeMarker({ ok: false, reason: 'electron-dist-not-found', candidates: CANDIDATES })
  process.stderr.write('[setup-electron] [环境不可用] 找不到可用的 Electron 二进制（不联网下载）。\n')
  process.stderr.write(`[setup-electron] 候选：\n${CANDIDATES.map(c => `  - ${c}`).join('\n')}\n`)
  process.exit(preflight ? 2 : 0)
}

const version = readPkgVersion(selfDir) ?? readPkgVersion(CANDIDATES[1]) ?? 'unknown'
const major = Number.parseInt(String(version).split('.')[0] ?? '0', 10)
if (Number.isFinite(major) && major !== WANT_MAJOR) {
  process.stderr.write(`[setup-electron] 警告：Electron 主版本 ${major}，期望 ${WANT_MAJOR}（不阻断，但需在验收记录中标注）\n`)
}

writeMarker({ ok: true, electronExe: exe, electronVersion: version, source })
process.stdout.write(`[setup-electron] OK  electron=${version}  exe=${exe}  source=${source}\n`)
