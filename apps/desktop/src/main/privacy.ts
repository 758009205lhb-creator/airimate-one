/**
 * apps/desktop/src/main/privacy.ts —— 数据主体权利：导出与彻底删除（M1 §4 / M5 §4）
 *
 * 用户要求：
 *   · "支持关闭自学习、导出记忆、删除单条记忆和彻底清除个人数据"
 *   · "增加隐私政策入口、遥测默认关闭、数据导出与删除、供应商密钥吊销说明"
 *
 * 三条纪律：
 *   ① **导出物里永远没有密钥**：`providers.json` 里的字段照原样导出，但密钥文件
 *      （`secrets/*.bin`）既不读也不写，导出清单里以 `<encrypted, not exported>` 占位；
 *   ② **彻底删除要能说清删了什么、留下了什么**（`removedFiles` / `kept`），
 *      不留"以为删干净了其实还在"的错觉；
 *   ③ 删除**不碰**日志目录（日志里只有长度/哈希/错误码，且是排障必需），
 *      但会在 `kept` 里如实列出，让用户知道还能去哪儿清理。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PrivacyExportRequest, PrivacyExportResult, PrivacyWipeRequest, PrivacyWipeResult } from '@airimate/shared'
import { appPaths } from './paths.js'
import { loadSettings } from './settings-store.js'
import { loadProviders } from './provider-store.js'
import { getPersona, exportHistory, clearSessionCache } from './session-store.js'
import { exportMemory, clearAllMemory } from './memory-store.js'
import { loadSchedules } from './schedule-store.js'
import { loadReminders, destroyReminderStore } from './reminder-store.js'
import { loadQuietHours, loadReminderPolicy, destroyQuietStore } from './quiet-store.js'
import { listPermissions, destroyPermissionStore } from './permission-store.js'
import { loadActivity, destroyActivityStore } from './activity-stats.js'
import { destroyEngineState } from './engine-state.js'
import { destroyKnowledgeStore } from './knowledge-source.js'
import { destroyReflectionStore, loadReflections } from './reflection-store.js'
import { secretStore } from './secrets-store.js'
import { log } from './log.js'

/** 数据文件清单（**唯一真源**：导出与删除都读它，避免两处各写一份） */
export function dataFiles(): Array<{ name: string, file: string, kind: 'config' | 'personal' }> {
  const p = appPaths()
  return [
    { name: 'settings', file: p.settingsFile, kind: 'config' },
    { name: 'providers', file: join(p.userData, 'providers.json'), kind: 'config' },
    { name: 'secrets-meta', file: join(p.secretsDir, 'meta.json'), kind: 'config' },
    { name: 'session', file: join(p.userData, 'session.json'), kind: 'personal' },
    { name: 'memory', file: join(p.userData, 'memory.json'), kind: 'personal' },
    { name: 'schedules', file: join(p.userData, 'schedules.json'), kind: 'personal' },
    { name: 'reminders', file: join(p.userData, 'reminders.json'), kind: 'personal' },
    { name: 'quiet-hours', file: join(p.userData, 'quiet-hours.json'), kind: 'config' },
    { name: 'permissions', file: join(p.userData, 'permissions.json'), kind: 'config' },
    { name: 'activity', file: join(p.userData, 'activity.json'), kind: 'personal' },
    { name: 'reflections', file: join(p.userData, 'reflections.json'), kind: 'personal' },
    { name: 'engine-state', file: join(p.userData, 'engine-state.json'), kind: 'config' },
    { name: 'knowledge-cache', file: join(p.userData, 'knowledge-cache.json'), kind: 'config' },
  ]
}

function safeBytes(file: string): number {
  try { return existsSync(file) ? statSync(file).size : 0 } catch { return 0 }
}

/** 导出目录：`<userData>/exports`（用户能找到，且留在应用自己的目录里） */
export function exportDir(): string {
  return join(appPaths().userData, 'exports')
}

/**
 * 导出个人数据。
 *
 * `includeChats:false` / `includeMemory:false` 让用户可以选择"只导出配置"——
 * 对话正文是最敏感的部分，必须能单独排除。
 */
export function exportPersonalData(req: PrivacyExportRequest): PrivacyExportResult {
  const dir = exportDir()
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const sections: string[] = []
  const excluded: string[] = ['密钥明文（只存在于 safeStorage 密文文件，永不导出）']

  const bundles: Record<string, unknown> = {}
  bundles.settings = loadSettings()
  sections.push('settings')
  bundles.providers = loadProviders().providers.map(p => ({
    ...p,
    // 出参形态与 `provider:list` 一致：只给"有没有密钥/指纹/长度"
    hasKey: secretStore().has(p.id),
    keyFingerprint: secretStore().fingerprintOf(p.id),
    keyLength: secretStore().lengthOf(p.id),
    apiKey: '<encrypted, not exported>',
  }))
  sections.push('providers')
  bundles.persona = getPersona()
  sections.push('persona')
  bundles.schedules = loadSchedules().schedules
  sections.push('schedules')
  bundles.reminders = loadReminders().reminders.map(({ dedupeKey: _k, ...r }) => r)
  sections.push('reminders')
  bundles.quiet = { quiet: loadQuietHours(), policy: loadReminderPolicy() }
  sections.push('quiet')
  bundles.permissions = listPermissions()
  sections.push('permissions')
  bundles.activity = loadActivity().days
  sections.push('activity')

  if (req.includeChats) {
    bundles.chat = exportHistory()
    sections.push('chat')
  } else {
    excluded.push('对话历史（按你的选择排除）')
  }
  if (req.includeMemory) {
    bundles.memory = exportMemory()
    sections.push('memory')
  } else {
    excluded.push('记忆正文（按你的选择排除）')
  }

  /**
   * ★ M4：每日反思也要能导出。
   *   它是"她学到的关于你的事"的**推导结果** —— 属于个人数据，
   *   用户有权看到"她到底总结出了什么"（这比只看记忆更能解释她的行为）。
   */
  try {
    bundles.reflections = loadReflections().days
    sections.push('reflections')
  } catch {
    excluded.push('每日反思（读取失败）')
  }

  const payload = {
    schema: 'airimate-personal-export/1',
    exportedAt: Date.now(),
    appVersion: process.env.npm_package_version ?? '1.0.0',
    sections,
    excluded,
    data: bundles,
  }

  if (req.format === 'json') {
    const file = join(dir, `airimate-export-${stamp}.json`)
    const text = `${JSON.stringify(payload, null, 2)}\n`
    writeFileSync(file, text, 'utf8')
    log().info('个人数据已导出', { sections: sections.length, bytes: Buffer.byteLength(text, 'utf8'), format: 'json' }, 'privacy.export')
    return { file, bytes: Buffer.byteLength(text, 'utf8'), sections, excluded }
  }

  // markdown：人读版（不塞原始 JSON，只给结构与计数 + 关键内容）
  const lines: string[] = []
  lines.push('# AiriMate One 个人数据导出')
  lines.push('')
  lines.push(`导出时间：${new Date().toISOString()}`)
  lines.push(`包含：${sections.join('、')}`)
  lines.push(`排除：${excluded.join('；')}`)
  lines.push('')
  lines.push('## 人设')
  const persona = bundles.persona as Record<string, unknown>
  lines.push(`- 名字：${String(persona.name)}`)
  lines.push(`- 称呼：${String(persona.userTitle ?? '')}`)
  lines.push(`- 性格：${String(persona.personality ?? '')}`)
  lines.push(`- 说话风格：${String(persona.speakingStyle ?? '')}`)
  lines.push('')
  lines.push('## 供应商（**不含密钥**）')
  for (const p of bundles.providers as Array<Record<string, unknown>>) {
    lines.push(`- ${String(p.label)} · ${String(p.kind)} · ${String(p.baseUrl)} · 模型 ${String(p.model)} · 密钥：${p.hasKey ? `已配置（长度 ${String(p.keyLength)}，指纹 ${String(p.keyFingerprint)}）` : '未配置'}`)
  }
  lines.push('')
  lines.push('## 日程')
  for (const s of (bundles.schedules as Array<Record<string, unknown>>)) {
    lines.push(`- ${String(s.start)} ${String(s.title)}（${String((s.recurrence as Record<string, unknown>)?.kind ?? '')}）`)
  }
  if (req.includeMemory) {
    lines.push('')
    lines.push('## 记忆')
    for (const m of (bundles.memory as Array<Record<string, unknown>>)) {
      lines.push(`- [${String(m.importance)}] ${String(m.text)}`)
    }
  }
  if (req.includeChats) {
    lines.push('')
    lines.push('## 对话历史')
    for (const m of (bundles.chat as Array<Record<string, unknown>>)) {
      lines.push(`- ${String(m.role)}：${String(m.text).slice(0, 2000)}`)
    }
  }
  if (Array.isArray(bundles.reflections) && (bundles.reflections as unknown[]).length > 0) {
    lines.push('')
    lines.push('## 每日反思（她学到的关于你的事）')
    for (const d of (bundles.reflections as Array<Record<string, unknown>>)) {
      lines.push(`### ${String(d.day)}`)
      lines.push(String(d.dailySummary ?? ''))
      const items = Array.isArray(d.items) ? d.items as Array<Record<string, unknown>> : []
      for (const it of items) {
        lines.push(`- [${String(it.kind)} · 置信度 ${String(it.confidence)} · ${String(it.approval)}] ${String(it.text)}`)
      }
    }
  }
  lines.push('')
  lines.push('## 完整机器可读数据')
  lines.push('```json')
  lines.push(JSON.stringify(payload, null, 2))
  lines.push('```')

  const file = join(dir, `airimate-export-${stamp}.md`)
  const text = `${lines.join('\n')}\n`
  writeFileSync(file, text, 'utf8')
  log().info('个人数据已导出', { sections: sections.length, bytes: Buffer.byteLength(text, 'utf8'), format: 'markdown' }, 'privacy.export')
  return { file, bytes: Buffer.byteLength(text, 'utf8'), sections, excluded }
}

/**
 * 彻底清除个人数据。
 *
 * 语义（**逐条写清，不含糊**）：
 *   · `personal` 类文件（对话 / 记忆 / 日程 / 提醒 / 活动）**一律删除**（内存缓存同步清空）；
 *   · `keepSettings:true`（默认）保留 settings / providers / permissions / quiet-hours
 *     —— 用户只是要清干净"我说过的话"，不必重新配一遍；设为 false 则连配置一起删；
 *   · 密钥文件**只有 `revokeKeys:true` 时才删**（删掉意味着要重新填 API Key，必须显式选择）；
 *   · 日志与崩溃转储**不删**（排障必需；且不含正文），但在 `kept` 里如实列出。
 */
export function wipePersonalData(req: PrivacyWipeRequest): PrivacyWipeResult {
  const removedFiles: string[] = []
  let removedBytes = 0
  const kept: string[] = []
  const files = dataFiles()

  // ① 先走各存储自己的 destroy（同时清掉内存缓存，避免进程内还留着旧数据）
  //
  // ⚠ 「删文件」与「清内存」必须成对：只删文件的话，进程内的缓存还在，
  //   于是 `chat:history` / `memory:list` 仍能返回"已删除"的数据 ——
  //   用户以为删干净了，其实没有（单测抓出来的）。
  const storeDestroyers: Array<[string, () => { removed: boolean, bytes: number }]> = [
    ['memory', () => { const n = clearAllMemory(); return { removed: n > 0, bytes: 0 } }],
    ['session', () => { clearSessionCache(); return { removed: true, bytes: 0 } }],
    ['reminders', destroyReminderStore],
    ['activity', destroyActivityStore],
    ['reflections', destroyReflectionStore],
    ['engine-state', destroyEngineState],
    ['knowledge-cache', destroyKnowledgeStore],
  ]
  if (!req.keepSettings) {
    storeDestroyers.push(['permissions', destroyPermissionStore], ['quiet-hours', destroyQuietStore])
  }
  for (const [name, fn] of storeDestroyers) {
    try {
      const r = fn()
      if (r.removed) {
        removedFiles.push(name)
        removedBytes += r.bytes
      }
    } catch (e) {
      log().warn('清除数据时出错', { name, err: e instanceof Error ? e.message : String(e) }, 'privacy.wipe.store-error')
    }
  }

  // ② 直接删文件（覆盖"存储没被 destroy 包装"的那些）
  const targets = files.filter(f => (req.keepSettings ? f.kind === 'personal' : true))
  for (const t of targets) {
    const bytes = safeBytes(t.file)
    try {
      if (existsSync(t.file)) {
        rmSync(t.file, { force: true })
        removedFiles.push(t.name)
        removedBytes += bytes
      }
    } catch (e) {
      kept.push(`${t.name}（删除失败：${e instanceof Error ? e.message.slice(0, 80) : '未知错误'}）`)
    }
  }

  // ③ 密钥
  if (req.revokeKeys) {
    const secretDir = appPaths().secretsDir
    try {
      if (existsSync(secretDir)) {
        for (const name of readdirSync(secretDir)) {
          const f = join(secretDir, name)
          const bytes = safeBytes(f)
          rmSync(f, { force: true })
          removedFiles.push(`secrets/${name}`)
          removedBytes += bytes
        }
      }
    } catch (e) {
      kept.push(`密钥文件（删除失败：${e instanceof Error ? e.message.slice(0, 80) : '未知错误'}）`)
    }
  } else {
    const n = ((): number => {
      try { return existsSync(appPaths().secretsDir) ? readdirSync(appPaths().secretsDir).filter(f => f.endsWith('.bin')).length : 0 } catch { return 0 }
    })()
    if (n > 0) kept.push(`已加密的密钥文件 ${n} 个（未选择"吊销密钥"）`)
  }

  if (req.keepSettings) kept.push('设置 / 供应商配置 / 权限 / 静音时段（按你的选择保留）')
  kept.push('日志文件（只含长度、哈希与错误码，不含对话正文；如需清理请在设置里删除 logs 目录）')
  kept.push('导出文件（在 exports 目录下，需要你自己删除）')

  log().info('个人数据已清除', {
    removed: removedFiles.length, bytes: removedBytes, keepSettings: req.keepSettings, revokeKeys: req.revokeKeys,
  }, 'privacy.wipe')
  return { removedFiles, removedBytes, kept }
}

/** 隐私摘要（UI 首页显示"本机存了什么"，让用户一眼看到边界） */
export function privacySummary(): {
  userDataDir: string
  files: Array<{ name: string, exists: boolean, bytes: number, kind: string }>
  secretFiles: number
  telemetryEnabled: boolean
  logFiles: number
  exportFiles: number
} {
  const secretDir = appPaths().secretsDir
  const count = (dir: string, filter: (n: string) => boolean): number => {
    try { return existsSync(dir) ? readdirSync(dir).filter(filter).length : 0 } catch { return 0 }
  }
  return {
    userDataDir: appPaths().userData,
    files: dataFiles().map(f => ({ name: f.name, exists: existsSync(f.file), bytes: safeBytes(f.file), kind: f.kind })),
    secretFiles: count(secretDir, n => n.endsWith('.bin')),
    telemetryEnabled: loadSettings().telemetryEnabled,
    logFiles: count(appPaths().logsDir, n => n.endsWith('.jsonl')),
    exportFiles: count(exportDir(), n => n.startsWith('airimate-export-')),
  }
}

/** 只读读一个导出文件的头部（供 UI"我导出了什么"核对；不解析全文） */
export function peekExport(file: string): string | null {
  try {
    if (!existsSync(file)) return null
    return readFileSync(file, 'utf8').slice(0, 2000)
  } catch { return null }
}
