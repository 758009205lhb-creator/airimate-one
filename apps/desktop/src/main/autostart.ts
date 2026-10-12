/**
 * apps/desktop/src/main/autostart.ts —— 开机自启的唯一入口（Tech-Spec §8.2）
 *
 * 纪律（PRD FR-3.4 / 判据 A19）：
 *   ① 只操作**本应用自己**的启动项：`HKCU\...\Run\AiriMateOne`；
 *   ② 迁移旧启动项时：先**备份**（导出到 %APPDATA%\AiriMateOne\migration\backup-<ts>\），
 *      再把旧项**移动**到备份目录（值写入备份清单后删除原值），最后只留本应用一项；
 *   ③ 卸载时恢复：若备份中存在被本应用移除的旧项，按备份原样恢复（--restore-legacy）。
 *   ④ 绝不静默删除用户的其它启动项。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ID } from '@airimate/shared'
import { appPaths } from './paths.js'
import { log } from './log.js'

const RUN_KEY_DEFAULT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_KEY_PS_DEFAULT = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/**
 * 注册表位置**可被 QA 覆盖**，用于在沙箱键上做**真实回滚演练**。
 *
 * 为什么需要：回滚是"只在卸载时跑一次"的路径，它的缺陷在用户真要卸载那一刻才会暴露。
 * 只测纯函数（`planRestoreFromBackup`）覆盖不到**真正写注册表**的那几行；
 * 而拿用户真实的 `Run` 键做演练是不可接受的（中途崩溃就留下垃圾）。
 * 所以允许把位置改到一个沙箱键，在那里跑真实的"写 → 盘点 → 回滚 → 复核"。
 *
 * 安全约束（都在 `resolveRunKey*()` 里机械校验）：
 *   · 必须以 `HKCU` 开头 —— **绝不**允许指向 HKLM（那是全机范围，风险完全不同）；
 *   · 只允许 `\Software\...` 之下的子键，禁止 `..`；
 *   · 值名固定为 `AiriOne`，不可通过环境变量更改。
 */
const RUN_KEY_OVERRIDE_ENV = 'AIRIMATE_AUTOSTART_RUNKEY'

function resolveRunKey(): { win: string, ps: string } {
  const raw = process.env[RUN_KEY_OVERRIDE_ENV]
  if (!raw) return { win: RUN_KEY_DEFAULT, ps: RUN_KEY_PS_DEFAULT }
  const normalized = raw.trim().replace(/\//g, '\\')
  const okShape = /^HKCU\\Software\\[A-Za-z0-9 _\\.-]+$/i.test(normalized) && !normalized.includes('..')
  if (!okShape) {
    // 覆盖值不合法 ⇒ 忽略并告警（**不**静默回退，否则会以为在沙箱里其实动了真键）
    log().error('自启注册表覆盖值不合法，已忽略并改用默认键', { raw }, 'autostart.override.invalid')
    return { win: RUN_KEY_DEFAULT, ps: RUN_KEY_PS_DEFAULT }
  }
  return { win: normalized, ps: normalized.replace(/^HKCU\\/, 'HKCU:\\') }
}

const regKeyWin = (): string => resolveRunKey().win
const regKeyPs = (): string => resolveRunKey().ps
/**
 * ⚠ 启动项**值名**必须避开旧卸载器的删除前缀。
 *
 * E0 取证（`docs/evidence/E0-legacy-audit.md`）实测：旧工程的卸载器会删除
 * `HKCU\...\Run` 下所有匹配 `^(AI女友|AiriMate|airi-brain)` 的值，
 * 而 PowerShell 的 `-match` **大小写不敏感**。
 * ⇒ 任何以 `AiriMate` 开头的名字（含 `AiriMateOne`）都会被旧卸载器**静默删除**。
 * 因此这里用 `AiriOne`，并在 `assertNameSafeFromLegacyUninstaller()` 里做机械校验
 * （该断言本身也有单测覆盖）。
 */
const VALUE_NAME = 'AiriOne'

/** 旧卸载器的删除前缀（取证结论，写死以便机械校验） */
const LEGACY_UNINSTALLER_PREFIXES = ['AI女友', 'AiriMate', 'airi-brain'] as const

/**
 * 机械校验：启动项值名**不得**命中旧卸载器的删除前缀。
 * 在写入注册表前调用；命中即抛错（宁可不写，也不要写一个将来会被静默删掉的名字）。
 */
export function assertNameSafeFromLegacyUninstaller(name: string = VALUE_NAME): void {
  const lower = name.toLowerCase()
  for (const p of LEGACY_UNINSTALLER_PREFIXES) {
    if (lower.startsWith(p.toLowerCase())) {
      throw new Error(
        `启动项值名 "${name}" 以 "${p}" 开头：旧卸载器会按 ^(${LEGACY_UNINSTALLER_PREFIXES.join('|')}) 删除它（大小写不敏感）。请改用其它名字。`,
      )
    }
  }
}

function ps(command: string, timeout = 15_000): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout,
  })
}

/**
 * **允许失败**的 PowerShell 调用 —— 用于"幂等清理"类操作。
 *
 * ⚠ 为什么需要它（实测踩到，很隐蔽）：`Remove-ItemProperty -Path <不存在的键> -Name X
 * -ErrorAction SilentlyContinue` 在 PowerShell 5.1 下**不会**被 SilentlyContinue 抑制干净 ——
 * 它仍然以非零退出码结束，于是 `ps()`（`execFileSync`）抛错。
 * 后果：回滚时若那个键已经不存在（例如自启刚被关闭、键被清空），
 * **明明回滚成功了却报告 `ok:false`**，把"成功"变成"失败"。
 *
 * 所以"删除一个可能不存在的东西"必须走这个函数：它的失败是**预期之内**的，
 * 只记日志、不上抛。注意它**只**用于幂等清理，不用于"必须成功"的写入。
 */
function psTolerant(command: string, what: string): boolean {
  try {
    ps(command)
    return true
  } catch (e) {
    log().warn('幂等清理未成功（按预期容忍）', { what, err: e instanceof Error ? e.message : String(e) }, 'autostart.tolerant-cleanup')
    return false
  }
}

export interface AutostartEntry {
  scope: 'hkcu-run' | 'hklm-run' | 'startup-user' | 'startup-common' | 'scheduled-task'
  name: string
  command: string
  target: string | null
  exists: boolean
  legacy: boolean
}

function isLegacyCommand(cmd: string): boolean {
  const l = cmd.toLowerCase()
  return l.includes('mateenginex')
    || l.includes('start-airi-brain')
    || l.includes('autostart-airi-brain')
    || l.includes('build\\pet\\app')
    || l.includes('build/pet/app')
    || l.includes('airi-brain.mjs')
    || l.includes('mate-engine-airi-bridge')
    || l.includes('llm-capture-proxy')
}

/** 只读盘点（用于诊断与迁移前的"现状"证据） */
export function inventoryAutostart(): AutostartEntry[] {
  const out: AutostartEntry[] = []
  try {
    const json = ps(`
      $ErrorActionPreference='SilentlyContinue'
      $r = @()
      $k = Get-ItemProperty -Path '${regKeyPs()}'
      if ($k) { foreach ($p in $k.PSObject.Properties) { if ($p.Name -notlike 'PS*') { $r += [pscustomobject]@{ scope='hkcu-run'; name=$p.Name; command=[string]$p.Value } } } }
      $dirs = @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp")
      foreach ($d in $dirs) { if (Test-Path $d) { Get-ChildItem -LiteralPath $d -File | ForEach-Object { $r += [pscustomobject]@{ scope='startup-folder'; name=$_.Name; command=$_.FullName } } } }
      Get-ScheduledTask | ForEach-Object { $t=$_; foreach ($a in $t.Actions) { if ($a.Execute) { $r += [pscustomobject]@{ scope='scheduled-task'; name=$t.TaskName; command=($a.Execute + ' ' + $a.Arguments) } } } }
      $r | ConvertTo-Json -Depth 3 -Compress
    `, 40_000)
    const parsed = JSON.parse(json.trim() || '[]') as Array<{ scope: string, name: string, command: string }>
    const list = Array.isArray(parsed) ? parsed : [parsed]
    for (const e of list) {
      const scope = e.scope === 'startup-folder' ? 'startup-user' : (e.scope as AutostartEntry['scope'])
      out.push({
        scope,
        name: e.name,
        command: e.command,
        target: null,
        exists: true,
        legacy: isLegacyCommand(e.command),
      })
    }
  } catch (e) {
    log().warn('自启项盘点失败', { err: e instanceof Error ? e.message : String(e) }, 'autostart.inventory.failed')
  }
  return out
}

export function isAutoStartEnabled(exePath: string): boolean {
  try {
    const v = ps(`(Get-ItemProperty -Path '${regKeyPs()}' -Name '${VALUE_NAME}' -ErrorAction SilentlyContinue).'${VALUE_NAME}'`)
    const line = v.trim()
    if (!line) return false
    return line.toLowerCase().includes(exePath.toLowerCase())
  } catch {
    return false
  }
}

/**
 * 只读审计（判据 A19）。
 *
 * 四面查询 + 归属判定，**不写任何东西**：
 *   ① `HKCU\...\Run`（唯一会写入的面）
 *   ② 启动文件夹（用户 + 公共）
 *   ③ 计划任务
 *   ④ `HKLM\...\Run`（我们不该出现在这里）
 * 判定："旧桌宠自启留下几条" + "本应用自启项恰好几条"。
 */
export interface AutostartAudit {
  generatedAt: string
  ownValueName: string
  hkcuRun: Array<{ name: string, command: string, isOurs: boolean, isLegacy: boolean }>
  hklmRun: Array<{ name: string, command: string, isOurs: boolean, isLegacy: boolean }>
  startupFolders: Array<{ scope: string, name: string, path: string, isLegacy: boolean }>
  scheduledTasks: Array<{ name: string, execute: string, arguments: string, isLegacy: boolean }>
  ownEntryCount: number
  legacyEntryCount: number
  pass: boolean
}

export function auditAutostart(): AutostartAudit {
  const ownValueName = VALUE_NAME
  const parse = (json: string): Array<Record<string, string>> => {
    const t = json.trim()
    if (!t) return []
    try {
      const p = JSON.parse(t) as unknown
      return (Array.isArray(p) ? p : [p]) as Array<Record<string, string>>
    } catch { return [] }
  }
  let runRows: Array<Record<string, string>> = []
  let startupRows: Array<Record<string, string>> = []
  let taskRows: Array<Record<string, string>> = []
  try {
    runRows = parse(ps(`
      $ErrorActionPreference='SilentlyContinue'
      $r = @()
      foreach ($k in @('${regKeyPs()}','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run')) {
        $item = Get-ItemProperty -Path $k
        if ($item) { foreach ($p in $item.PSObject.Properties) { if ($p.Name -notlike 'PS*') { $r += [pscustomobject]@{ hive=$k.Substring(0,4); name=$p.Name; command=[string]$p.Value } } } }
      }
      $r | ConvertTo-Json -Depth 3 -Compress
    `, 40_000))
  } catch { /* 读不到就留空，报告里会体现 */ }
  try {
    startupRows = parse(ps(`
      $ErrorActionPreference='SilentlyContinue'
      $r = @()
      foreach ($d in @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp")) {
        if (Test-Path $d) { Get-ChildItem -LiteralPath $d -File | ForEach-Object { $r += [pscustomobject]@{ scope=$d; name=$_.Name; command=$_.FullName } } }
      }
      $r | ConvertTo-Json -Depth 3 -Compress
    `, 40_000))
  } catch { /* ignore */ }
  try {
    taskRows = parse(ps(`
      $ErrorActionPreference='SilentlyContinue'
      $r = @()
      Get-ScheduledTask | ForEach-Object { $t=$_; foreach ($a in $t.Actions) { if ($a.Execute) { $r += [pscustomobject]@{ name=$t.TaskName; execute=[string]$a.Execute; arguments=[string]$a.Arguments } } } }
      $r | ConvertTo-Json -Depth 3 -Compress
    `, 60_000))
  } catch { /* ignore */ }

  const isLegacy = (s: string): boolean => /mateenginex|start-airi-brain|autostart-airi-brain|build[\\/]pet[\\/]app|airi-brain\.mjs|mate-engine-airi-bridge|llm-capture-proxy/i.test(s)

  const hkcuRun = runRows.filter(r => r.hive === 'HKCU').map(r => ({
    name: r.name ?? '', command: r.command ?? '',
    isOurs: (r.name ?? '') === ownValueName, isLegacy: isLegacy(r.command ?? ''),
  }))
  const hklmRun = runRows.filter(r => r.hive === 'HKLM').map(r => ({
    name: r.name ?? '', command: r.command ?? '',
    isOurs: (r.name ?? '') === ownValueName, isLegacy: isLegacy(r.command ?? ''),
  }))
  const startupFolders = startupRows
    .filter(r => !/desktop\.ini$/i.test(r.name ?? ''))
    .map(r => ({ scope: r.scope ?? '', name: r.name ?? '', path: r.command ?? '', isLegacy: isLegacy(r.command ?? '') }))
  const scheduledTasks = taskRows.map(r => ({
    name: r.name ?? '', execute: r.execute ?? '', arguments: r.arguments ?? '',
    isLegacy: isLegacy(`${r.execute ?? ''} ${r.arguments ?? ''}`),
  })).filter(t => t.isLegacy)

  const ownEntryCount = hkcuRun.filter(r => r.isOurs).length + hklmRun.filter(r => r.isOurs).length
  const legacyEntryCount = [...hkcuRun, ...hklmRun].filter(r => r.isLegacy).length
    + startupFolders.filter(r => r.isLegacy).length
    + scheduledTasks.length

  return {
    generatedAt: new Date().toISOString(),
    ownValueName,
    hkcuRun, hklmRun, startupFolders, scheduledTasks,
    ownEntryCount, legacyEntryCount,
    /**
     * 通过条件：**旧桌宠自启 0 条**，且**本应用自启项最多 1 条**（0 条 = 用户关掉了自启，也算通过）。
     */
    pass: legacyEntryCount === 0 && ownEntryCount <= 1,
  }
}

export interface AutostartSetResult {
  ok: boolean
  detail: string
  legacyMoved: string[]
  backupDir: string | null
}

/**
 * 打开/关闭自启，并在打开时**顺便迁移**旧启动项（备份后移动）。
 * @param exePath 本应用可执行文件绝对路径（开发期为 electron.exe；打包后为 AiriMateOne.exe）
 * @param appArgs 启动参数（打包后可为 ['--autostart']）
 */
export function setAutoStart(enabled: boolean, exePath: string, appArgs: string[] = [], dryRun = false): AutostartSetResult {
  const legacyMoved: string[] = []
  let backupDir: string | null = null

  // 写注册表之前先做机械校验：绝不写一个将来会被旧卸载器静默删除的名字
  try {
    assertNameSafeFromLegacyUninstaller()
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    log().error('启动项名不安全，已拒绝写入', { err: detail }, 'autostart.name.unsafe')
    return { ok: false, detail, legacyMoved, backupDir }
  }

  /** 干跑：只报告"将会做什么"，**不碰注册表**（QA/首次运行向导用） */
  if (dryRun) {
    const before = auditAutostart()
    const wouldRemove = before.hkcuRun.filter(r => r.isLegacy).map(r => r.name)
    const plan = {
      dryRun: true,
      enabled,
      valueName: VALUE_NAME,
      target: appArgs.length ? `"${exePath}" ${appArgs.join(' ')}` : `"${exePath}"`,
      wouldRemoveLegacy: wouldRemove,
      wouldSetOwn: enabled,
      currentOwnCount: before.ownEntryCount,
      currentLegacyCount: before.legacyEntryCount,
    }
    log().info('开机自启（干跑，未写注册表）', plan as unknown as Record<string, string | number | boolean | null>, 'autostart.dry-run')
    return { ok: true, detail: JSON.stringify(plan), legacyMoved: wouldRemove, backupDir: null }
  }

  try {
    if (!enabled) {
      // 幂等清理：键可能已经不存在，失败是预期内的（见 psTolerant 的注释）
      psTolerant(`Remove-ItemProperty -Path '${regKeyPs()}' -Name '${VALUE_NAME}' -ErrorAction SilentlyContinue`, 'remove-own')
      log().info('已移除本应用开机自启项', {}, 'autostart.disabled')
      return { ok: true, detail: 'removed', legacyMoved, backupDir }
    }

    // ① 备份现状
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    backupDir = join(appPaths().migrationDir, `backup-${ts}`)
    mkdirSync(backupDir, { recursive: true })
    const before = inventoryAutostart()
    writeFileSync(join(backupDir, 'autostart-before.json'), `${JSON.stringify(before, null, 2)}\n`, 'utf8')
    try {
      ps(`reg export '${regKeyWin()}' '${join(backupDir, 'hkcu-run.reg')}' /y`)
    } catch (e) {
      log().warn('reg export 失败（继续，但备份不完整需人工确认）', { err: e instanceof Error ? e.message : String(e) }, 'autostart.backup.partial')
    }

    // ② 迁移旧项：备份后删除（可恢复）
    const legacy = before.filter(e => e.legacy && e.scope === 'hkcu-run')
    for (const e of legacy) {
      try {
        psTolerant(`Remove-ItemProperty -Path '${regKeyPs()}' -Name '${e.name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`, `remove-legacy:${e.name}`)
        legacyMoved.push(e.name)
      } catch (err) {
        log().warn('旧启动项移除失败（保留原状，不阻断）', { name: e.name, err: err instanceof Error ? err.message : String(err) }, 'autostart.legacy.remove-failed')
      }
    }
    writeFileSync(join(backupDir, 'autostart-after.json'), `${JSON.stringify({ legacyMoved, ownValue: VALUE_NAME }, null, 2)}\n`, 'utf8')
    writeFileSync(join(backupDir, 'migration-manifest.json'), `${JSON.stringify({
      appId: APP_ID, createdAt: new Date().toISOString(), removedLegacyEntries: legacyMoved, ownValue: { name: VALUE_NAME, exePath, args: appArgs },
    }, null, 2)}\n`, 'utf8')

    // ③ 写入本应用唯一一项
    const value = appArgs.length ? `"${exePath}" ${appArgs.join(' ')}` : `"${exePath}"`
    ps(`New-ItemProperty -Path '${regKeyPs()}' -Name '${VALUE_NAME}' -Value '${value.replace(/'/g, "''")}' -PropertyType String -Force | Out-Null`)
    log().info('开机自启已启用（旧项已备份并移动）', { legacyMoved: legacyMoved.join(',') || '<none>', backupDir }, 'autostart.enabled')
    return { ok: true, detail: 'set', legacyMoved, backupDir }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    log().error('自启设置失败', { err: detail }, 'autostart.failed')
    return { ok: false, detail, legacyMoved, backupDir }
  }
}

/**
 * 回滚**计划**（纯函数，不碰注册表）—— 由备份清单算出"该恢复什么、该删什么、该警告什么"。
 *
 * 为什么必须抽成纯函数：回滚是**只在卸载时跑一次**的路径，平时永远不会被执行到，
 * 所以它的缺陷只会在"用户真的要卸载"那一刻才暴露 —— 那时已经无法挽回。
 * 抽出来之后可以用合成备份把各种边界情况跑一遍（`autostart-restore.test.cjs`）。
 *
 * 抽出来时发现并修掉了两个真实缺陷：
 *  ① **过度恢复**：原实现遍历备份里**全部** `hkcu-run` 条目并逐个写回，
 *     而备份是 `inventoryAutostart()` 的**完整快照**（含本应用自己的 `AiriOne`）
 *     ⇒ 会把本应用的自启项也一起"恢复"回去，卸载后仍然开机自启。
 *  ② **静默丢失**：原有恢复无论备份里有什么，都只写 HKCU Run，也不检查
 *     "被移除的旧项是否在其它位置"。若旧项原本在 HKLM Run / 启动文件夹 /
 *     计划任务里，回滚会 **什么都不恢复却报告成功**。
 */
export interface RestorePlan {
  /** 要写回 HKCU Run 的值（只含旧项，绝不含本应用自己的值名） */
  toRestore: Array<{ name: string, command: string }>
  /** 本应用自己的值名（回滚时删除，避免"卸载了还在自启"） */
  toRemoveOwn: string
  /** 备份里存在、但**本实现无法自动恢复**的位置（必须让用户看见） */
  unsupported: Array<{ scope: AutostartEntry['scope'], name: string, command: string }>
  /** 备份里存在但本应用**没有**移除的条目（不该被回滚；列出便于人工核对） */
  notOurs: string[]
  /**
   * 恢复成功、但名字命中旧卸载器删除前缀 ⇒ **只要用户将来还装旧方案，
   * 旧的卸载器会再把它删掉**。这不是回滚失败，是必须让用户知道的前提条件。
   */
  riskyRestored: string[]
}

export function planRestoreFromBackup(
  before: readonly AutostartEntry[],
  ownValueName: string = VALUE_NAME,
): RestorePlan {
  const ownLower = ownValueName.toLowerCase()
  const toRestore: Array<{ name: string, command: string }> = []
  const unsupported: RestorePlan['unsupported'] = []
  const notOurs: string[] = []
  const riskyRestored: string[] = []
  const seen = new Set<string>()

  for (const e of before) {
    if (!e.exists) continue
    const nameLower = e.name.toLowerCase()
    // ① 本应用自己的值名**绝不**恢复（否则卸载后仍自启）
    if (nameLower === ownLower) { notOurs.push(e.name); continue }
    // ② 只恢复"旧项"，且只恢复在 HKCU Run 里的 —— 其它位置本实现写不回去
    if (!e.legacy) { notOurs.push(e.name); continue }
    if (e.scope !== 'hkcu-run') { unsupported.push({ scope: e.scope, name: e.name, command: e.command }); continue }
    // ③ 去重（同一名字出现多次时只恢复一次）
    if (seen.has(nameLower)) continue
    seen.add(nameLower)
    toRestore.push({ name: e.name, command: e.command })
    /**
     * ⚠ 这里**曾经**拒绝恢复命中旧卸载器前缀的名字 —— 那是**反的**。
     *
     * `assertNameSafeFromLegacyUninstaller()` 的适用对象是**我们要写进去的新值名**
     * （新应用的自启项），因为旧卸载器会按 `^(AI女友|AiriMate|airi-brain)` 删除匹配项。
     * 而**旧启动项自己的名字本来就叫这些**（`AI女友`、`airi-brain`）——
     * 用同一把尺子去卡它们，结果是"回滚旧项"这个功能**正好拒绝回滚旧项**。
     *
     * 实测暴露：`tools/qa/check-autostart-rollback.ps1` 演练里
     * `airi-brain` 与 `AI女友` 两条被 `blocked` 拒绝，只有 `MateEngineX` 被恢复。
     *
     * 正确行为：**照原样恢复**（备份里是什么就恢复什么），但把它标成 `riskyRestored`
     * 让用户知道"如果你将来又装了旧方案并跑旧卸载器，这两条会再次被删"。
     */
    try {
      assertNameSafeFromLegacyUninstaller(e.name)
    } catch {
      riskyRestored.push(e.name)
    }
  }

  return { toRestore, toRemoveOwn: ownValueName, unsupported, notOurs, riskyRestored }
}

/**
 * 卸载/回滚：把备份里的旧项恢复回去（仅当存在备份）。
 *
 * 行为由 `planRestoreFromBackup()` 决定；本函数只负责**执行**与**如实报告**。
 * 有任何无法自动恢复的位置（`unsupported`）或无法安全恢复的值名（`blocked`）时，
 * `ok` 为 false 并把细节写进 `detail` —— 不允许"什么都没恢复却报告成功"。
 */
export function restoreLegacyAutostart(backupDir: string): { ok: boolean, detail: string, plan?: RestorePlan } {
  const file = join(backupDir, 'autostart-before.json')
  if (!existsSync(file)) return { ok: false, detail: '备份文件不存在' }
  try {
    const before = JSON.parse(readFileSync(file, 'utf8')) as AutostartEntry[]
    const plan = planRestoreFromBackup(before)

    let restored = 0
    for (const e of plan.toRestore) {
      ps(`New-ItemProperty -Path '${regKeyPs()}' -Name '${e.name.replace(/'/g, "''")}' -Value '${e.command.replace(/'/g, "''")}' -PropertyType String -Force | Out-Null`)
      restored++
    }
    // 删除本应用自己的自启项：卸载后不应再自启（幂等：键可能已不存在）
    psTolerant(`Remove-ItemProperty -Path '${regKeyPs()}' -Name '${plan.toRemoveOwn}' -ErrorAction SilentlyContinue`, 'restore-remove-own')

    const problems: string[] = []
    if (plan.unsupported.length) {
      problems.push(`有 ${plan.unsupported.length} 个旧项不在 HKCU Run，本实现无法自动恢复：`
        + plan.unsupported.map(u => `${u.scope}:${u.name}`).join(', '))
    }
    const ok = problems.length === 0
    const warnings: string[] = []
    if (plan.riskyRestored.length) {
      warnings.push(`已恢复 ${plan.riskyRestored.length} 个值名命中旧卸载器删除前缀的旧项`
        + `（${plan.riskyRestored.join(', ')}）：只要将来再运行**旧方案的卸载器**，它们会再次被删除`)
    }
    const detail = ok
      ? `restored=${restored} removedOwn=${plan.toRemoveOwn}`
        + (warnings.length ? `；注意 → ${warnings.join('；')}` : '')
      : `restored=${restored} removedOwn=${plan.toRemoveOwn}；需人工处理 → ${problems.join('；')}`
    if (ok) {
      if (warnings.length) log().warn('启动项已回滚（带前提条件）', { restored, backupDir, warnings: warnings.join(' | ') }, 'autostart.restored.warn')
      else log().info('已回滚启动项', { restored, backupDir, notOurs: plan.notOurs.length }, 'autostart.restored')
    } else {
      log().error('启动项回滚不完整（需人工处理）', { restored, backupDir, problems: problems.join(' | ') }, 'autostart.restore.incomplete')
    }
    return { ok, detail, plan }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}
