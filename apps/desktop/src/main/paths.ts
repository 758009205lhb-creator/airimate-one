/**
 * apps/desktop/src/main/paths.ts —— 主进程全部落盘路径的唯一真源
 *
 * 纪律：任何模块不得自行拼路径（避免出现"某个模块把密钥写到了工作目录"这类事故）。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 稳定的应用数据目录名（不用 npm 包名，避免 `@airimate/desktop` 这种带 @ 的路径） */
export const APP_DIR_NAME = 'AiriMateOne'

export interface AppPaths {  userData: string
  settingsFile: string
  secretsDir: string
  logsDir: string
  runDir: string
  lockFile: string
  migrationDir: string
  /**
   * TTS 临时正文目录（受限 userData 下）。
   * 为什么单独开一个目录：语音合成需要"把待朗读文本交给子进程"的通道，
   * 命令行对其他进程可见（会被日志/EDR 采集），因此只允许经 stdin 或**此目录下**的临时文件，
   * 且用完即删。集中在此也便于审计"有没有正文漏到别处"。
   */
  ttsDir: string
  /** 工作区根（含 assets/、tools/）：打包后为只读资源目录 */
  workspaceRoot: string
  /** renderer 构建产物目录 */
  rendererDist: string
  /** 本地动作资产目录（**不进分发包**） */
  motionDir: string
  motionManifestDir: string
  /** 资产清单（只含路径引用） */
  catalogFile: string
}

let cached: AppPaths | null = null

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

export function workspaceRoot(): string {
  /**
   * ① 显式覆盖（**安装形态**走这一条）：环境变量 `AIRIMATE_WORKSPACE`。
   *
   * 为什么不靠 `app.isPackaged` 猜：它的依据是"可执行文件是否叫 electron"，
   * 而安装形态里我们只是把 `electron.exe` 改名成 `AiriMateOne.exe`
   * ⇒ 它**不会**变成 true，下面 ② 那条分支根本走不到，`rendererDist` / `motionDir`
   * 会全部指错。安装器知道自己把 `workspace` 放在哪，让它直接告诉应用最可靠，
   * 也让"安装形态能否启动"这件事可以在**不真的安装**的前提下演练。
   */
  const override = process.env.AIRIMATE_WORKSPACE
  if (override && existsSync(override)) return resolve(override)
  // ② 打包形态（真用打包工具产出时才会命中）
  if (app.isPackaged) return resolve(process.resourcesPath, 'workspace')
  // ③ 开发形态：apps/desktop/dist/main → 上溯到工程根
  return resolve(app.getAppPath(), '..', '..')
}

export function appPaths(): AppPaths {
  if (cached) return cached
  const userData = app.getPath('userData')
  const ws = workspaceRoot()
  cached = {
    userData,
    settingsFile: join(userData, 'settings.json'),
    secretsDir: join(userData, 'secrets'),
    logsDir: join(userData, 'logs'),
    runDir: join(userData, 'run'),
    lockFile: join(userData, 'run', 'instance.lock'),
    migrationDir: join(userData, 'migration'),
    ttsDir: join(userData, 'tts'),
    workspaceRoot: ws,
    rendererDist: join(ws, 'apps', 'renderer', 'dist'),
    motionDir: join(ws, 'assets', 'motion'),
    motionManifestDir: join(ws, 'assets', 'motion', 'manifests'),
    catalogFile: join(ws, 'assets', 'models', 'catalog.json'),
  }
  return cached
}

export function ensureRuntimeDirs(): AppPaths {
  const p = appPaths()
  for (const d of [p.userData, p.secretsDir, p.logsDir, p.runDir, p.migrationDir, p.ttsDir]) ensureDir(d)
  /**
   * TTS 临时正文目录：正常路径下每次朗读结束即删（`removeTempUtterance`）。
   * 这里再兜底清理 1 小时前的残留 —— 进程被杀时来不及删的那些文件
   * 不该在磁盘上长期留存（它们含用户对话正文）。
   */
  pruneOldFiles(p.ttsDir, 3600 * 1000)
  // 崩溃转储限制在受限目录内，并在启动时清理 7 天前的转储（Tech-Spec §7.3）
  const crashDir = join(p.userData, 'crashDumps')
  ensureDir(crashDir)
  app.setPath('crashDumps', crashDir)
  pruneOldFiles(crashDir, 7 * 24 * 3600 * 1000)
  return p
}

export function pruneOldFiles(dir: string, maxAgeMs: number): number {
  let removed = 0
  try {
    for (const name of readdirSync(dir)) {
      const f = join(dir, name)
      try {
        const st = statSync(f)
        if (!st.isFile()) continue
        if (Date.now() - st.mtimeMs > maxAgeMs) { rmSync(f, { force: true }); removed++ }
      } catch { /* 单个文件失败不影响整体 */ }
    }
  } catch { /* 目录不存在等情况忽略 */ }
  return removed
}
