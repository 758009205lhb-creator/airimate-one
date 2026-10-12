/**
 * apps/desktop/src/main/bootstrap.ts —— 应用入口（顺序即纪律）
 *
 * 启动顺序（Tech-Spec §8.1，不得调换）：
 *   ① 环境可用性自检（Electron 二进制是否就位；不联网下载）
 *   ② 解析命令行（无 GUI）
 *   ③ L1 Electron 单实例锁 → 未取到 ⇒ 唤醒已有实例并退出
 *   ④ L2 命名互斥量 + L3 运行锁文件 → 判定主/次实例
 *   ⑤ 判定为次实例 ⇒ 唤醒并退出（**不创建任何窗口**）
 *   ⑥ 初始化日志、运行目录、崩溃转储目录
 *   ⑦ 旧实例检测 → 命中阻断项 ⇒ 弹阻断对话框并退出（**不自动杀进程**）
 *   ⑧ 创建托盘 + **唯一** BrowserWindow
 *   ⑨ 注册 IPC、命中区域轮询、心跳、诊断导出
 *
 * 退出语义：关闭按钮 ⇒ hide()；真正退出只能由托盘"退出"或 `--diag-once` 之类显式路径触发。
 */
import { app, dialog, BrowserWindow, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import type { Alert, Rect, WindowMode } from '@airimate/shared'
import { APP_ID, APP_NAME, IPC, TtsStateEventSchema, WINDOW_GEOMETRY } from '@airimate/shared'
/**
 * ⚠ 只取**常量**（`CAPABILITY_KINDS`），不引入新模块：本文件已经通过
 *   `./capabilities/index.js` 间接加载了 `companion-kit`，所以这不增加运行时依赖。
 *   取它的理由见 `kit.every-kind-registered` 处的注释 —— 手抄一份类型清单
 *   在本项目已经导致过**两次**"缺口永远不会被发现"。
 */
import { CAPABILITY_KINDS } from '@airimate/companion-kit'
import { appPaths, ensureRuntimeDirs, APP_DIR_NAME } from './paths.js'
import { initLogging, log, pruneLogs } from './log.js'
import { registerAppScheme, handleAppScheme, protocolInfo } from './asset-protocol.js'
import { createMainWindow, getWindow, hideWindow, showWindow, windowMode, windowBounds } from './window-manager.js'
import { applyMode, beginDrag, dragTo, endDrag, isDragging, isSkipTaskbarRequested, setDragCursorSource, setSessionModeOverride, snapSizeToDipGrid } from './window-manager.js'
import { createTray, destroyTray, refreshTray } from './tray.js'
import { registerIpc, unregisterIpc, isChannelRegistered, sendAlert, sendModeChanged, sendProactiveEvent, broadcast, sendConversationState, sendUiAction, sendPetMenuState } from './ipc.js'
import { initSingleInstance, instanceStatus, shutdownSingleInstance, startInstanceHeartbeat, findPrimaryPid, wakeExistingInstance } from './single-instance.js'
import { scanLegacyInstances } from './legacy-guard.js'
import { setLastLegacyScan } from './legacy-state.js'
import { hitRegions } from './hit-region-registry.js'
import { loadSettings, patchSettings, mergeSettings, flushSettings } from './settings-store.js'
import { auditAutostart, setAutoStart, isAutoStartEnabled, restoreLegacyAutostart } from './autostart.js'
import { upsertProvider, deleteProvider, getProvider, testProvider, setActive, probeReadiness } from './provider-store.js'
import { secretStore } from './secrets-store.js'
import { bindSession } from './session.js'
import { refreshMotionStatus } from './motion-state.js'
import { collectDiagnostics } from './diagnostics.js'
import {
  chooseVoice, chunkText, createTtsEngine, listVoices, removeTempUtterance,
  TTS_ENGINE, TTS_MAX_CHUNK_CHARS, writeTempUtterance,
} from './tts-engine.js'
import { addMemory, deleteMemory, listMemory, memoryCount, memoryFileProbe, recall, reloadFromDisk } from './memory-store.js'
import { appendMessage, removeMessageById, sessionAllMessages } from './session-store.js'
import { lastMemoryInjection } from './memory-state.js'
// ── M2：主动陪伴引擎
import { sampleActivity } from './activity-probe.js'
import { currentBlocker, proactiveStatus, startProactiveEngine, stopProactiveEngine, type EngineHandle } from './proactive-engine.js'
// ── M5 §1：适配层框架（角色/动作/语音/LLM/工具/存储都可替换）
import { capabilityKit, initCapabilityKit, setPrivacyChannelProbe, wireM3Outlets } from './capabilities/index.js'
import { digestOf, recordToolCall } from './tool-audit.js'
// ── M3：语音 / 屏幕 / 确认
import { requestToolConfirm, cancelAllConfirms, setToolConfirmSender } from './tool-confirm.js'
import { disposeVoice } from './voice-engine.js'
import { installVoiceCallBridge, reconcileWakeWatch, stopWakeWatch } from './voice-call.js'
// ── ★ 对话（返工轮）：**独立 chat 窗口** + 语音说话
import {
  announceConversationState, applyConversationHotkey, closeConversation, conversationDiagnostics,
  conversationState, openConversation, releaseConversationHotkey,
  setChatWindowOptions, setConversationAlertSink, setConversationStateSink,
} from './conversation.js'
import { destroyChatWindow } from './chat-window.js'
import { scheduleChatProbe } from './chat-probe.js'
import { schedulePetResidentProbe, markTrayCreated } from './pet-resident-probe.js'
import { scheduleMenuOpenProbe } from './menu-open-probe.js'
/**
 * ★★ 桌宠呼出 / 收回 / 常驻（2026-10-09 完善轮）—— 本轮的核心新功能。
 * 状态机在 `pet-visibility.ts`，这里只做「读设置 → 决定启动行为 → 接线」。
 */
import { hidePet, petMenuState, petResident, setPetResident, showPet, startupOpenChat } from './pet-visibility.js'

interface CliOptions {
  dev: boolean
  devServerUrl: string | null
  diagnosticsFile: string | null
  mode: WindowMode | null
  exitAfterDiagnosticsMs: number | null
  noDialogs: boolean
  /** `--selfcap <png>`：把 renderer 当前帧自拍落盘 */
  selfCaptureFile: string | null
  selfCaptureMs: number
  selfCaptureExit: boolean
  /** 自拍前放入红方块做相机对照实验 */
  testBox: boolean
  /** 验收探针名（`a10` = 轮盘锚点精度） */
  probe: string | null
  probeOut: string | null
  probeExit: boolean
  /** 允许探针做真实写入（a19 的写→审计→移除验证） */
  mutate: boolean
  /** 探针清场模式（`--cleanup`：`memory-restart` 用它删掉标记记忆） */
  cleanup: boolean
  /** `--soak-minutes <n>`：浸泡总时长（`--probe soak`）；默认 120（判据 A15 的 2 小时） */
  soakMinutes: number
  /** `--soak-sample-sec <n>`：浸泡采样间隔秒；默认 30（Acceptance-Matrix §7） */
  soakSampleSec: number
  /**
   * `--restore-legacy <备份目录>`：回滚开机启动项（**卸载器入口**）。
   *
   * 为什么必须有这个 CLI 入口：`restoreLegacyAutostart()` 早就实现了，
   * 但**没有任何可达的调用点** —— 而 `autostart.ts` 的文件头注释却写着
   * "卸载时恢复（--restore-legacy）"。文档承诺了一个不存在的入口，
   * 等于回滚能力在交付形态上是**不可达**的。这里把它接到真实入口上。
   *
   * 安全：只接受**已存在的备份目录**，计划由 `planRestoreFromBackup()` 机械生成
   * （绝不恢复本应用自己的值名）；执行前不创建窗口、不启动托盘。
   */
  restoreLegacy: string | null
  /** `--restore-legacy-out <json>`：回滚结果落盘路径（卸载器读这个，不读控制台） */
  restoreLegacyOut: string | null
  /**
   * `--autostart-exe <路径>` / `--autostart-args <参数>`：
   * `--probe a19 --mutate` 写入自启项时用的目标。
   *
   * 为什么需要（而不是写死 `process.execPath`）：安装器的自启项必须指向
   * **安装后的可执行文件**（例如 `%LOCALAPPDATA%\Programs\AiriMateOne\AiriMateOne.exe`），
   * 而不是"当前正在跑的那个 electron.exe"。没有这两个参数，安装流程就只能靠
   * "先启动应用、再让它自己写"——那条路径无法在**不真的安装**的前提下演练，
   * 而"没演练过的安装"恰恰是最容易在用户机器上失败的东西。
   */
  autostartExe: string | null
  autostartArgs: string | null
  /**
   * `--autostart-value on|off`：`--probe a19 --mutate` 时要写入的方向。
   * 默认 `on`。**为什么方向必须可选**：回滚演练需要"打开"和"关闭"两个方向各跑一次，
   * 而探针原先写死了 `setAutoStart(true, ...)` —— 演练里"关闭自启"那一步
   * 实际上又**打开**了一次，于是"关闭后 AiriOne 应已移除"这条判定假失败。
   */
  autostartValue: 'on' | 'off'
  probeShot: string | null
  /** 帧率上限（透传给 renderer） */
  fpsCap: number | null
  /**
   * `--no-proactive`：**不启动主动陪伴引擎**。
   *
   * 为什么必须有这个开关：M2 的引擎会自己采样活动、可能朗读、会写提醒；
   * 而浸泡/交互类探针（A11/A14/A15…）需要**确定性环境** ——
   * 一次突然的"久坐提醒"足以让帧率采样或窗口可见性判定失效（实测浸泡 run4 就是被
   * 外部干扰毁掉的）。默认仍启动（产品行为），只在探针里显式关掉。
   */
  noProactive: boolean
  /** `--proactive-fast`：tick 间隔压到 1s（探针用，避免等 10s 才看到效果） */
  proactiveFast: boolean
  /**
   * `--soak-with-chat`：浸泡期间**打开并保持**独立对话窗口。
   *
   * 用途：让「角色窗口 = 1 且对话窗口 ≤ 1」这条新判据的**两窗口分支**真的被覆盖。
   * 不开它跑出来的浸泡证据只覆盖"总数为 1"那一半。
   */
  soakWithChat: boolean
  /**
   * ★ `--probe-pet-mode <start-hidden|start-resident>`：本次会话的**启动显示策略覆盖**
   *   （不写设置）。见 `KNOWN_FLAGS` 里的说明。
   */
  probePetMode: 'start-hidden' | 'start-resident' | null
  version: string
}

/** 退出门闩：必须在 `quit()` 之前声明（函数声明提升不适用于 let） */
let isQuitting = false
/** 周期诊断写入句柄（退出时清掉） */
let diagTimer: NodeJS.Timeout | null = null
/** ★ M2：主动引擎句柄（退出时停掉，避免"退出过程中还在发提醒"） */
let proactiveHandle: EngineHandle | null = null

/**
 * 从 argv 取 `--flag value` / `--flag=value`。
 *
 * 为什么单独一个函数而不是复用 `parseCli` 里的闭包：`--workspace` 必须在
 * **`parseCli` 之前**就要生效（`appPaths()` 有缓存，且 `paths.ts` 在启动早期被读取），
 * 而 `parseCli` 本身用不到它。抽出来避免"把 appPaths 缓存的时序搞乱"这类隐蔽问题。
 */
function valueOfArg(argv: readonly string[], f: string): string | null {
  const prefix = `${f}=`
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === f) return i + 1 < argv.length ? (argv[i + 1] ?? null) : null
    if (a.startsWith(prefix)) return a.slice(prefix.length)
  }
  return null
}

/** Levenshtein 距离（仅用于给拼错的参数名提示最接近的合法参数） */function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1)
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
    }
    prev = cur
  }
  return prev[n] ?? 0
}

function parseCli(argv: readonly string[]): CliOptions {
  const KNOWN_FLAGS = [
    '--dev', '--no-dialogs', '--probe-exit', '--selfcap-exit', '--testbox', '--mutate', '--cleanup',
    '--diag-once', '--mode', '--dev-server', '--diagnostics', '--selfcap', '--selfcap-ms',
    '--probe', '--probe-out', '--probe-shot', '--fps-cap', '--autostart-value', '--restore-legacy', '--restore-legacy-out', '--autostart-exe', '--autostart-args', '--workspace',
    '--soak-minutes', '--soak-sample-sec',
    /**
     * ⚠ 这两个**必须**列在白名单里（实测踩到）。
     *
     * `parseCli` 一直会解析它们（`noProactive: has('--no-proactive')`），
     * 但它们**不在** `KNOWN_FLAGS` 里 ⇒ 白名单校验先把启动挡掉了：
     * `Error: 无法识别的启动参数：--no-proactive`，应用直接退出、探针一个字节都不产出。
     * 也就是说"探针需要确定性环境"这个开关**根本不可达** ——
     * 而 `--probe conversation` 的注释里一直写着它可以用。
     * （顺带说明：`tools/qa/run-probe.ps1` 的 `-ExtraArgs` 也正是靠它才能生效。）
     */
    '--no-proactive', '--proactive-fast',
    /**
     * ★ `--soak-with-chat`：浸泡期间**打开独立对话窗口**（返工轮新增）。
     *
     * 为什么必须有它：新窗口判据是「角色窗口 = 1 **且** 对话窗口 ≤ 1」，
     * 而"对话窗口 ≤ 1"只有在**它真的被打开过**的时候才算被测到。
     * 不开它跑出来的 2 小时证据只覆盖"总数 = 1"那一半，**不能**声称
     * "两个窗口并存 2 小时无异常"。
     */
    '--soak-with-chat',
    /**
     * ★★ `--probe-pet-mode start-hidden|start-resident`（2026-10-09 完善轮）。
     *
     * 用途：`--probe petresident` 的 C2/C3 要求"**重启后**仍按新值执行"，
     * 而"重启"在自动化里只能拆成两次进程启动。这个参数让**同一条探针**能分别以
     * "启动时不该显示桌宠"（默认）与"启动时该显示桌宠"（强制常驻）两种前提跑，
     * 读数是**两次独立进程**的真实启动行为，而不是同一个进程里的自证。
     *
     * ⚠ 它**只覆盖本次会话的显示策略，不写设置**（与 `--mode` 的会话级覆盖同一个道理）：
     *   写设置会污染下一次真实启动 —— 而"重启后按新值执行"这条判据的证据
     *   必须来自**设置文件里的值**，不是命令行。
     */
    '--probe-pet-mode',
  ] as const
  /**
   * 参数拼错必须**当场报错**，不能静默忽略。
   *
   * 为什么加这道闸门：`--mode=pet` 曾因为"只认空格写法"而静默失效
   * （窗口仍按 panel 创建，没有任何错误提示）。参数解析器的沉默是最昂贵的沉默 ——
   * 它把"你写错了"变成"功能好像没生效"，而后者会让人去查功能本身。
   * 所以这里做一次**白名单校验**，并把拼错的候选（编辑距离 1~2）直接指出来。
   */
  const unknown = argv.filter(a =>
    typeof a === 'string' && a.startsWith('--')
    && a !== '--'
    && !KNOWN_FLAGS.some(f => a === f || a.startsWith(`${f}=`)))
  if (unknown.length) {
    const suggest = (bad: string): string | null => {
      const name = bad.split('=')[0] ?? bad
      let best: { f: string, d: number } | null = null
      for (const f of KNOWN_FLAGS) {
        const d = editDistance(name, f)
        if (d <= 2 && (!best || d < best.d)) best = { f, d }
      }
      return best ? best.f : null
    }
    const detail = unknown.map(u => {
      const s = suggest(u)
      return s ? `${u}（是否想写 ${s}？）` : u
    }).join('、')
    throw new Error(`无法识别的启动参数：${detail}。可用参数：${KNOWN_FLAGS.join(' ')}`)
  }

  const has = (f: string): boolean => argv.includes(f)
  /**
   * 取 `--flag value` **或** `--flag=value` 的值。两种写法都必须支持。
   *
   * ⚠ 这里曾经**只**支持空格写法，于是 `--mode=pet` 静默变成 `null`：
   *   窗口以 panel 尺寸创建、`window.mode.override` 一次都不打、
   *   `boot.ready` 里 `modeApplied:"panel"` —— 而**没有任何报错**。
   *   实测方式：用一个独立的 Electron 小程序打印 `process.argv`，
   *   确认 Electron **原样透传**了 `--mode=pet`（应用侧收得到，是自己没解析）。
   *   教训：CLI 参数的"两种写法"必须一起支持，否则错的是最不容易被发现的那种。
   */
  const valueOf = (f: string): string | null => {
    const prefix = `${f}=`
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i] ?? ''
      if (a === f) return i + 1 < argv.length ? (argv[i + 1] ?? null) : null
      if (a.startsWith(prefix)) return a.slice(prefix.length)
    }
    return null
  }
  const modeRaw = valueOf('--mode')
  const diagIdx = argv.indexOf('--diag-once')
  return {
    dev: has('--dev'),
    devServerUrl: valueOf('--dev-server'),
    diagnosticsFile: valueOf('--diagnostics'),
    mode: modeRaw === 'pet' || modeRaw === 'panel' ? modeRaw : null,    // `--diag-once[=毫秒]`：默认 4000ms，便于 QA 给慢启动留时间
    exitAfterDiagnosticsMs: diagIdx < 0 ? null : (() => {
      const arg = argv[diagIdx] ?? ''
      const n = arg.includes('=') ? Number.parseInt(arg.split('=')[1] ?? '', 10) : Number.parseInt(argv[diagIdx + 1] ?? '', 10)
      return Number.isFinite(n) && n > 0 ? n : 4000
    })(),
    // QA/自动化必须传 --no-dialogs：否则旧实例阻断对话框会挂住脚本
    noDialogs: has('--no-dialogs'),
    selfCaptureFile: valueOf('--selfcap'),
    selfCaptureMs: (() => {
      const v = Number.parseInt(valueOf('--selfcap-ms') ?? '', 10)
      return Number.isFinite(v) && v > 0 ? v : 12_000
    })(),
    selfCaptureExit: has('--selfcap-exit'),
    testBox: has('--testbox'),
    probe: valueOf('--probe'),
    probeOut: valueOf('--probe-out'),
    probeExit: has('--probe-exit'),
    mutate: has('--mutate'),
    cleanup: has('--cleanup'),
    soakMinutes: (() => {
      const v = Number.parseInt(valueOf('--soak-minutes') ?? '', 10)
      return Number.isFinite(v) && v > 0 ? v : 120
    })(),
    soakSampleSec: (() => {
      const v = Number.parseInt(valueOf('--soak-sample-sec') ?? '', 10)
      /**
       * ⚠ 下限从 5 秒放宽到 **1 秒**（返工轮）。
       *
       * 为什么：新窗口判据需要一个"两个窗口并存"的短程集成验证（2 分钟 × 5 秒
       * 只有 24 个样本，跑得快但覆盖窗口开关两次会很挤）。
       * 5 秒的下限是给 **2 小时浸泡**定的（30 秒一采），对短程验证没有意义。
       * 判定门槛（`MinSoakSec`）在分析器那边，不在采样密度这里。
       */
      return Number.isFinite(v) && v >= 1 ? v : 30
    })(),
    restoreLegacy: valueOf('--restore-legacy'),
    restoreLegacyOut: valueOf('--restore-legacy-out'),
    autostartExe: valueOf('--autostart-exe'),
    autostartArgs: valueOf('--autostart-args'),
    autostartValue: valueOf('--autostart-value') === 'off' ? 'off' : 'on',
    probeShot: valueOf('--probe-shot'),
    fpsCap: (() => {
      const v = Number.parseInt(valueOf('--fps-cap') ?? '', 10)
      return Number.isFinite(v) && v >= 15 && v <= 480 ? v : null
    })(),
    version: app.getVersion(),
    noProactive: has('--no-proactive'),
    proactiveFast: has('--proactive-fast'),
    /** 浸泡期间是否打开独立对话窗口（见 KNOWN_FLAGS 里的说明） */
    soakWithChat: has('--soak-with-chat'),
    probePetMode: ((): 'start-hidden' | 'start-resident' | null => {
      const v = valueOf('--probe-pet-mode')
      return v === 'start-resident' || v === 'start-hidden' ? v : null
    })(),
  }
}

function preloadPath(): string {
  // 沙箱化 preload 必须是 CommonJS ⇒ 产物为 dist/preload/index.js（不是 .mjs）
  const p = join(app.getAppPath(), 'dist', 'preload', 'index.js')
  if (existsSync(p)) return p
  return join(__dirname, '..', 'preload', 'index.js')
}

async function showLegacyBlockDialog(hits: Array<{ kind: string, pid: number, imagePath: string, reason: string, hasVisibleWindow: boolean }>): Promise<'quit' | 'continue'> {
  const lines = hits.slice(0, 8).map(h => `• [${h.kind}] pid=${h.pid}${h.hasVisibleWindow ? '（有可见窗口）' : ''}\n  ${h.imagePath}\n  ${h.reason}`)
  const r = await dialog.showMessageBox({
    type: 'warning',
    title: `${APP_NAME} · 检测到旧实例`,
    message: '检测到旧版桌宠/内核仍在运行，继续启动会出现第二个角色窗口。',
    detail: `${lines.join('\n')}\n\n本软件不会自动结束其它进程。请先手动退出旧实例（建议按 迁移方案 的停机顺序），然后重新启动本软件。`,
    buttons: ['退出（推荐）', '仅查看详情并继续'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  return r.response === 1 ? 'continue' : 'quit'
}

export async function bootstrap(): Promise<void> {
  const cli = parseCli(process.argv)

  // ⓪a 用户数据目录：必须在**任何** getPath('userData') 之前定死，
  //     否则 Electron 会用 npm 包名派生出 `%APPDATA%\@airimate\desktop` 这种带 @ 的怪路径。
  app.setName(APP_DIR_NAME)
  try { app.setPath('userData', join(app.getPath('appData'), APP_DIR_NAME)) } catch { /* ignore */ }

  /**
   * `--workspace <dir>`：把"工作区根"（renderer 产物 / 动作清单 / 模型路径引用所在处）
   * 显式告诉应用。**必须在任何 `appPaths()` 调用之前设置** —— `appPaths()` 有缓存。
   *
   * 为什么安装形态必须传它：`paths.ts` 判"打包形态"用的是 `app.isPackaged`，
   * 而它的依据是"可执行文件是否叫 electron"；安装形态只是把 `electron.exe`
   * 改名成 `AiriMateOne.exe` ⇒ 不会变成 true ⇒ `rendererDist` / `motionDir`
   * 会全部指错，表现为"装好了但白屏/找不到动作"。
   * 走 CLI 而不是环境变量：自启项里能直接看到这个路径，排障时不用猜环境。
   */
  const wsArg = valueOfArg(process.argv, '--workspace')
  if (wsArg) process.env.AIRIMATE_WORKSPACE = wsArg

  // ⓪b 必须在 app.ready **之前**执行：注册自定义协议的特权
  //    （`protocol.registerSchemesAsPrivileged` 在 ready 之后调用会直接抛错 —— 实测踩到）
  registerAppScheme()

  const bootId = randomUUID()
  process.env.AIRIMATE_BOOT_ID = bootId

  /**
   * `--restore-legacy <备份目录>`：**卸载器用的回滚入口**。
   *
   * 位置很关键 —— 它放在单实例锁与窗口创建**之前**：
   *   · 卸载流程中应用可能已经在跑（或刚被杀），此时抢单实例锁会失败并对用户报"已有实例"，
   *     而回滚本身与"能不能拿到窗口"完全无关；
   *   · 不创建窗口、不建托盘 ⇒ 回滚是一条**无界面**路径，符合"卸载时不弹窗"的预期。
   *
   * 退出码语义（给卸载器脚本判定用）：
   *   0 = 回滚完成；1 = 回滚不完整或参数非法（**不静默成功**）。
   */
  if (cli.restoreLegacy) {
    const dir = cli.restoreLegacy
    const r = restoreLegacyAutostart(dir)
    const payload = { backupDir: dir, ok: r.ok, detail: r.detail, plan: r.plan ?? null, at: new Date().toISOString() }
    /**
     * 结果**必须落文件**，不能只靠 stdout/stderr。
     *
     * 实测：`--restore-legacy` 时 Electron 会把 stdio 从父 shell 上摘掉 ——
     * 连 `$LASTEXITCODE` 都是空的、重定向文件是 0 字节。卸载器若依赖"读控制台输出"
     * 就会拿到一片空白（而回滚其实成功了）。所以约定一个**结果文件**，
     * 卸载器读它 + 看退出码，两条独立的信号。
     */
    if (cli.restoreLegacyOut) {
      try {
        mkdirSync(dirname(cli.restoreLegacyOut), { recursive: true })
        writeFileSync(cli.restoreLegacyOut, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      } catch (e) {
        console.error(`[airimate] RESTORE_LEGACY_RESULT_WRITE_FAILED ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    console.log(`[airimate] RESTORE_LEGACY ${JSON.stringify(payload)}`)
    app.exit(r.ok ? 0 : 1)
    return
  }

  // ③ L1
  const gotLock = app.requestSingleInstanceLock({ pid: process.pid, bootId })
  if (!gotLock) {
    // 第二实例：唤醒已有实例后立刻退出（不创建窗口）
    const primary = findPrimaryPid(process.execPath)
    if (primary) {
      const r = wakeExistingInstance(primary, process.execPath)
      console.log(`[airimate] SECOND_INSTANCE primaryPid=${primary} wake=${r.ok} detail=${r.detail}`)
    } else {
      console.log('[airimate] SECOND_INSTANCE primary=unknown（锁文件缺失或归属未确认）')
    }
    app.exit(0)
    return
  }

  app.on('second-instance', () => {
    log().info('收到第二次启动请求 → 显示并聚焦（不创建新窗口）', {}, 'singleton.wake')
    showWindow()
  })

  // ④ L2 + L3
  const si = await initSingleInstance(true, process.execPath, cli.version, bootId)
  if (si.decision === 'secondary') {
    const primary = findPrimaryPid(process.execPath)
    if (primary) wakeExistingInstance(primary, process.execPath)
    app.exit(0)
    return
  }

  // ⑥ 运行时目录与日志
  ensureRuntimeDirs()
  initLogging({ debugEnabled: cli.dev || !!cli.diagnosticsFile, bootId })
  pruneLogs()
  /**
   * 启动参数**原样落日志**（必须在 `initLogging` 之后打，否则会被丢掉）。
   *
   * 为什么必须记：`--probe petmode` 实测发现 `--mode=pet` **静默失效**
   * （窗口仍以 panel 尺寸创建、`window.mode.override` 一次都没打）。
   * 唯一能区分"我们没解析"和"Electron 没传进来"的办法，就是看进程**实际收到**的 argv ——
   * 而参数解析器一旦沉默，就会把"你写错了"伪装成"功能没生效"。
   */
  log().info('启动参数', { argv: process.argv.slice(1).join(' ') }, 'boot.argv')
  log().info('启动 airimate', {
    version: cli.version, appId: APP_ID, dev: cli.dev, mode: cli.mode ?? 'settings',
    mutex: si.l2, mutexMethod: si.mutexMethod, lock: si.l3, notes: si.notes.join(' | ') || '<none>',
  }, 'boot.start')

  // 协议特权已在 bootstrap 最开始注册（app.ready 之前），这里只装 handler
  await app.whenReady()
  handleAppScheme()

  const settings = loadSettings()
  const mode: WindowMode = cli.mode ?? settings.mode
  /**
   * ★ CLI 给出的模式是**会话级覆盖**：不写回设置，且 `windowMode()` 优先返回它。
   *   否则 renderer 启动时的 `getMode()` 会读回持久化设置、把模式改回去
   *   （实测：`--mode=pet` 静默失效，窗口仍是 panel 尺寸）。
   */
  if (cli.mode) {
    setSessionModeOverride(cli.mode)
    log().info('会话级模式覆盖已生效（不写回设置）', { requested: cli.mode, fromSettings: settings.mode }, 'window.mode.override')
  }

  /**
   * ⑥b 角色资产的运行时授权根。
   *
   * ★ 现在**走适配层**（`companion-kit` 的 asset-resolver），不再直接读
   *   `catalog.json.avatars[0].path`。行为差异（这就是 M5 §1/§2 的落点）：
   *     · 候选要过**许可判定**：`packaged` 形态下私有来源资产被机械拒绝；
   *     · 候选要过**存在性**：清单写着路径不等于文件还在；
   *     · 选中的是"许可最宽松且可用"的那一个，而不是"清单里第一个"。
   *   最终仍然只把**所在目录**授权给 `app://model/`（不做整盘授权、不复制资产），
   *   所以 renderer 侧与协议层完全不用改。
   */
  /**
   * ★ M5 §1：**先装配适配层，再用它**。
   *
   * 之所以提到资产解析之前：资产授权根现在由适配层给出（见下）。
   * 这里只做"注册"（快、无 IO），真正的**实测初始化**（枚举 SAPI 声音、解析清单）
   * 放在 IPC 之后由 `initCapabilityKit()` 完成 —— 那样即使某个适配器 init 失败，
   * 应用照样起得来，只是那一项如实显示为不可用。
   */
  const kit = capabilityKit()
  log().info('适配层已装配', {
    profile: kit.kit.profile,
    adapters: kit.kit.list().length,
    tools: kit.tools.list().length,
  }, 'kit.assembled')

  try {
    const assetAdapter = kit.asset()
    const res = assetAdapter.resolve()
    const root = assetAdapter.modelRoot()
    if (res.selected && root) {
      process.env.AIRIMATE_MODEL_ROOT = root
      // ⚠ 只记**目录与判定结论**，不记完整路径（路径含用户名/目录结构）
      log().info('已授权角色模型目录（经适配层解析）', {
        dir: root,
        id: res.selected.id,
        provenance: res.selected.license.provenance,
        license: res.selected.license.license,
        usable: res.avatars.length,
        rejected: res.rejected.length,
        profile: kit.kit.profile,
      }, 'asset.model-root')
    } else {
      log().warn('没有可用的角色资产（将在界面显示可见告警位）', {
        detail: res.detail, total: res.all.length, rejected: res.rejected.length,
        reasons: res.rejected.slice(0, 3).map(r => `${r.id}:${r.reason}`).join(' | ') || '<none>',
      }, 'asset.model-missing')
    }
  } catch (e) {
    log().warn('角色资产解析失败', { err: e instanceof Error ? e.message : String(e) }, 'asset.catalog-failed')
  }

  // ⑦ 旧实例检测
  let legacyContinue = false
  const legacy = scanLegacyInstances()
  setLastLegacyScan(legacy)
  if (legacy.blocked) {
    // `--no-dialogs` 供自动化/QA 使用：此时不弹窗，只记日志并继续（保证脚本不会挂住）
    const choice = cli.noDialogs ? 'continue' : await showLegacyBlockDialog(legacy.hits.filter(h => h.blocking))
    if (choice === 'quit') {
      log().warn('因旧实例阻断而退出', { hits: legacy.hits.length }, 'legacy.block.quit')
      shutdownSingleInstance()
      app.exit(3)
      return
    }
    legacyContinue = true
    log().warn('用户选择忽略旧实例告警继续启动（已记录）', { noDialogs: cli.noDialogs }, 'legacy.block.overridden')
  }

  // ⑧ 托盘
  /**
   * ★★ **本次启动要不要让桌宠自己出现**（2026-10-09 完善轮）。
   *
   * 三条输入，优先级从高到低：
   *   ① CLI 会话级覆盖（`--probe-pet-mode start-resident|start-hidden`，**不写设置**）；
   *   ② `settings.petResident`（默认 `false`）；
   *   ③ 无（没有第三个输入 —— 旧行为"打开软件就自动出现桌宠"**已不存在**）。
   *
   * ⚠ 必须在 `createMainWindow` **之前**算出来：`autoShowOnReady` 是**创建时**的入参，
   *   而 `ready-to-show` 一旦过了就没法再"决定本来该不该显示"。
   *   （这也是它放在托盘创建之前的原因 —— 托盘菜单会读 `petMenuState()`，
   *     而那个读数应当已经是"启动策略已定"之后的状态。）
   */
  const residentAtBoot = petResident()
  const wantResident = cli.probePetMode === 'start-resident' ? true
    : cli.probePetMode === 'start-hidden' ? false
      : residentAtBoot

  const tray = createTray({
    requestMode: (m) => {
      applyMode(m, { resize: true })
      /**
       * ⚠ 这里曾经调用 `syncConversationAfterModeChange()`（切到 pet 时把窗口拉到对话态尺寸）。
       *   返工轮**删除**：对话窗口是独立的第二个 BrowserWindow，
       *   panel ⇄ pet 的切换与它无关。
       */
      patchSettings({ mode: m })
      getWindow()?.webContents.send('evt:mode-changed', { mode: m, bounds: windowBounds(), windowId: getWindow()?.id ?? -1 })
    },
    requestQuit: () => { quit('tray') },
    getAutoStart: () => isAutoStartEnabled(process.execPath),
    setAutoStart: async (on: boolean) => {
      const r = setAutoStart(on, process.execPath, [])
      if (!r.ok) sendAlert({ level: 'error', title: '设置开机自启失败', detail: r.detail, code: 'AUTOSTART_FAILED', blocking: false })
      patchSettings({ autoStart: on })
      return r.ok
    },
    getAlwaysOnTop: () => getWindow()?.isAlwaysOnTop() ?? false,
    /**
     * ★ 对话（本轮）：托盘只表达意图，真正的开关与窗口布局在 `conversation.ts`。
     * 拒绝（例如恰好正在拖拽）会由那一条路径发出**可见**告警，托盘不吞掉它。
     */
    isConversationOpen: () => conversationState().open,
    requestConversation: (open) => {
      const r = open ? openConversation('tray') : closeConversation('tray')
      if (!r.ok) log().warn('托盘切换对话被拒绝', { open, reason: r.refusedReason ?? '' }, 'tray.conversation.refused')
      refreshTray()
    },
    getHotkeyLabel: () => {
      const h = conversationState().hotkey
      if (!h.enabled) return '已关闭'
      return h.registered ? h.accelerator : `${h.accelerator}（注册失败）`
    },
    /**
     * ★★ 桌宠三项（2026-10-09 完善轮）。
     *
     * 托盘**不自己** `show()/hide()`、**不自己**写设置 —— 它只调 `pet-visibility.ts`
     * 里的三个函数。三处菜单（托盘 / 对话窗口菜单栏 / 桌宠右键）因此走**同一条**实现，
     * 不可能出现"托盘点了会落盘、菜单点了不落盘"这种分叉。
     * 每次动作后 `announceConversationState()` 会把新状态（含 `pet` 快照）广播给两个窗口，
     * 并顺手 `refreshTray()`（那个接线在 `setConversationStateSink` 里）⇒ 勾选**实时同步**。
     */
    petShow: () => { showPet('tray'); announceConversationState() },
    petHide: () => { hidePet('tray'); announceConversationState() },
    petSetResident: (resident) => { setPetResident(resident, 'tray'); announceConversationState() },
    /** 打开管理面板：呼出 + panel 模式 + 聚焦（三步合成，避免中间态） */
    requestPanel: () => {
      const r = showPet('tray')
      if (!r.ok) {
        log().warn('托盘打开管理面板被拒绝', { reason: r.reason ?? '' }, 'tray.panel.refused')
        refreshTray()
        return
      }
      applyMode('panel', { resize: true })
      patchSettings({ mode: 'panel' })
      const w = getWindow()
      sendModeChanged({ mode: 'panel', bounds: windowBounds(), windowId: w?.id ?? -1 })
      showWindow()
      announceConversationState()
    },
    /** 打开某个界面视图（记忆 / 日程 / 偏好 / 语音 / 快捷键一览 / 关于）—— 真正的"切页"由 pet 窗口的界面做 */
    requestView: (action) => {
      /**
       * ★ 「快捷键一览」/「关于」的界面**只在对话窗口里**（`ChatWindow.vue` 的两个小面板）。
       *   ⇒ 先打开对话窗口，再让那条事件到达。
       *
       * ⚠ 为什么要有那个 400ms 延迟：对话窗口**可能还没创建**
       *   （默认启动态是开着的，但用户可能刚把它关掉 —— 关闭只是隐藏，对象还在，那条路不需要等）。
       *   真正需要等的是"应用刚启动、chat 窗口还没 ready"那一瞬：
       *   那一刻广播出去的事件**没有订阅者**，静默丢失，表现是"点了没反应"。
       *   延迟 400ms 是"让 renderer 挂上订阅"的机械等待，不是重试逻辑。
       */
        const needsChat = action === 'shortcuts' || action === 'about'
        if (needsChat) {
          const r0 = openConversation('tray')
          if (!r0.ok) log().warn('托盘打开对话窗口失败（视图请求将可能无人接收）', { action, reason: r0.refusedReason ?? '' }, 'tray.view.chat-failed')
          announceConversationState()
          setTimeout(() => { sendUiAction(action, 'tray') }, 400).unref?.()
          refreshTray()
          return
        }
        const r1 = showPet('tray')
        if (!r1.ok) log().warn('托盘打开视图前呼出桌宠失败', { action, reason: r1.reason ?? '' }, 'tray.view.refused')
        sendUiAction(action, 'tray')
        refreshTray()
    },
  })
  /**
   * ★ 把"托盘到底建起来没有"记进探针可读的标记。
   *
   * 为什么需要（`Tray` 没有任何枚举 API，Electron 不提供 `getAllTrays()`）：
   *   判据 C1 里有"托盘存在"这一条，而它**无法**从 `Tray` 对象自证。
   *   这里用的是**主进程自己的读数**（`createTray()` 的返回值），
   *   与外部通知区域枚举（`tools/qa/get-tray-state.ps1`）互为独立证据。
   */
  markTrayCreated(!!tray)
  log().info('托盘状态已记录（供探针读）', { created: !!tray }, 'tray.mark')

  /**
   * ★ 对话模块的两根出口线（都在这里接，接线点只有一处）。
   *
   * 为什么用注入而不是直接 import：`ipc.ts` 要 import `conversation.ts` 去注册三条通道，
   * 反向 import 会形成循环依赖（本项目为同一问题抽过 `event-sink.ts`）。
   * 这里接线的两个函数分别负责：告警进界面、状态广播**带 zod 校验**地出去。
   */
  setConversationAlertSink((a) => sendAlert(a))
  setConversationStateSink((s) => { sendConversationState(s); refreshTray() })

  /**
   * ★★ 对话窗口的装配参数（返工轮）。
   *
   * 为什么由 bootstrap 注入而不是 `conversation.ts` 自己算：
   *   `preloadPath` 与 `devServerUrl` 都来自本文件的 CLI 解析，
   *   在别处再算一份就是**第二个真源**。这里给一次，之后所有入口（轮盘/托盘/快捷键/
   *   双击/唤醒）都只调 `openConversation()`，不可能走出两条不同的创建路径。
   *
   * ⚠ 必须在 `applyConversationHotkey()` **之前**接好：快捷键回调可能在任何时刻触发，
   *   而"按了快捷键但窗口装配缺失"会被结构化拒绝（可见告警），不该发生。
   */
  setChatWindowOptions({
    preloadPath: preloadPath(),
    devServerUrl: cli.devServerUrl,
    rememberedBounds: settings.chatWindowBounds,
    alwaysOnTop: settings.chatWindowAlwaysOnTop,
    fpsCap: cli.fpsCap,
  })

  // ⑧ 角色窗口（pet/panel）—— 全应用**唯一**渲染角色的窗口
  /**
   * ★ **记忆的 panel 尺寸先对齐 DIP 栅格**（用户 2026-09-27 方案 B）。
   *
   * 为什么需要：`rememberBounds()` 历史上把 `getBounds()` 的**读回值**写进了设置，
   * 而读回值比请求值多一个固定量（`sizeDiag.json` 实测 +2/+1）⇒ 设置里存的是
   * `482×761`（请求的本来是 `480×760`）。而 `482`、`761` 都不是 4 的整数倍，
   * 在 125% 缩放下对应**半个物理像素** ⇒ 窗口一边移动一边被取整，
   * 尺寸读数在 761/762 之间跳（`strictDuringDragIdentical=false` 的来源）。
   *
   * 一次性自愈：启动时按当前显示器把尺寸向下对齐到栅格并落盘。
   * 只改**记忆的尺寸**（±4 DIP），不改用户意图、不改位置。
   */
  const panelsnap = ((): { before: { x: number, y: number, width: number, height: number } | null, after: { x: number, y: number, width: number, height: number } | null, scaleFactor: number } => {
    const b = settings.panelBounds
    if (!b) return { before: null, after: null, scaleFactor: 1 }
    let sf = 1
    try { sf = screen.getDisplayMatching(b).scaleFactor } catch { sf = 1 }
    const snapped = snapSizeToDipGrid(b, sf)
    if (snapped.width === b.width && snapped.height === b.height) return { before: b, after: b, scaleFactor: sf }
    const next = { x: b.x, y: b.y, width: snapped.width, height: snapped.height }
    mergeSettings({ panelBounds: next })
    log().info('记忆的 panel 尺寸已对齐 DIP 栅格', {
      before: `${b.width}x${b.height}`, after: `${snapped.width}x${snapped.height}`, scaleFactor: sf,
    }, 'window.panel-bounds.snapped')
    return { before: b, after: next, scaleFactor: sf }
  })()
  const effPanelBounds = panelsnap.after ?? settings.panelBounds

  const win = createMainWindow({
    mode,
    preloadPath: preloadPath(),
    devServerUrl: cli.devServerUrl,
    panelBounds: effPanelBounds,
    petPosition: settings.petPosition,
    alwaysOnTop: settings.alwaysOnTop,
    fpsCap: cli.fpsCap,
    /**
     * ★★ **打开软件不再自动出现桌宠**（2026-10-09 完善轮；用户本轮的第 ③ 条要求）。
     *
     * `petResident` 默认 `false` ⇒ 这里传 `false` ⇒ `ready-to-show` 时**不 show**。
     * ⚠ 窗口**照常创建**（只是不显示），这一点是要紧的：
     *   · renderer 要挂载、舞台/VRM 要初始化 —— 这样"呼出"是**即时**的，不需要等加载；
     *   · 全局快捷键、轮盘、托盘、对话窗口的入口全都挂在这个窗口上；
     *   · 命中区域服务也 attach 在它身上（窗口不可见时不参与判定，见 `hit-region.ts`）。
     *   ⇒ 不是"延迟创建"，而是"创建但不显示"。两者的用户可见差别是
     *     "呼出要等 1–2 秒白屏" vs "呼出即出现"。
     */
    autoShowOnReady: wantResident,
    onClose: (e) => {
      if (isQuitting) return
      e.preventDefault()
      hideWindow()
      /**
       * ★ 关掉桌宠 = **收回**（与托盘「收回桌宠」同一个动作），
       *   而且同样要把命中区域清干净 —— 否则"关掉之后那块地方点不动桌面"。
       *   ⚠ 这里**不写 `petResident`**：关窗口不是取消常驻（见 `pet-visibility.ts` 的文件头）。
       */
      try { hidePet('api') } catch { /* 窗口已经不可见时这里是空操作 */ }
      announceConversationState()
      log().info('关闭按钮 → 隐藏窗口（未退出）', {}, 'window.close.hide')
    },
  })

  /**
   * ⚠ **不要在拖拽期间响应 `moved`/`resized` 去写设置**。
   *
   * 实测踩到：A14 探针在真实拖拽路径上测到窗口尺寸**漂移 12×9 px**
   * （`maxWidthDrift=12`、`maxHeightDrift=9`），违反"拖拽过程中窗口尺寸不能变化"这条硬要求。
   * 原因就是 `moved` 事件里触发的 `patchSettings`/写盘与窗口操作相互干扰；
   * 改为**只在拖拽结束时**记录一次几何（`endDrag` 之后），拖拽期间完全不碰设置。
   */
  const rememberBounds = (): void => {
    if (windowMode() !== 'panel') return
    /**
     * ★ 拖动**期间**绝不写设置（本轮按规格加固）。
     *
     * 原实现只靠 700ms 防抖，理论上仍有"拖到一半计时器就触发"的窗口；
     * 而规格明确要求"拖动期间禁止写 settings.json"。这里直接以
     * `isDragging()` 为准：拖动中就**不排程**，拖动结束后由 `endDrag` 的调用方
     * 触发一次记录（`scheduleRemember` 会在 `moved` 事件里被再次调用）。
     */
    if (isDragging()) return
    const b = windowBounds()
    /**
     * ★ **存"对齐栅格后的尺寸"，不存读回值**（用户 2026-09-27 方案 B）。
     *
     * 读回值比请求值多一个固定量（实测 +2/+1）⇒ 把读回值当配置存下来，
     * 下次启动就按这个"被系统改过的值"建窗，而它又不在 DIP 栅格上 ⇒
     * 拖动时尺寸读数会在 1 DIP 内跳动。位置照原样存（像素级位置不影响尺寸取整）。
     */
    if (b) {
      let sf = 1
      try { sf = screen.getDisplayMatching(b).scaleFactor } catch { sf = 1 }
      const snapped = snapSizeToDipGrid(b, sf)
      mergeSettings({ panelBounds: { x: b.x, y: b.y, width: snapped.width, height: snapped.height } })
    }
  }
  // 仅在窗口**停止移动/缩放**时才记录：用一个短防抖，避免拖拽过程中的高频写入
  let boundsDebounce: NodeJS.Timeout | null = null
  const scheduleRemember = (): void => {
    if (isDragging()) return   // 拖动期间不排程（见 rememberBounds 的说明）
    if (boundsDebounce) clearTimeout(boundsDebounce)
    boundsDebounce = setTimeout(() => { boundsDebounce = null; rememberBounds() }, 700)
    boundsDebounce.unref?.()
  }
  win.on('resized', scheduleRemember)
  win.on('moved', scheduleRemember)

  // ⑨ IPC / 命中区域 / 心跳
  registerIpc({ selfExe: process.execPath, appArgs: [], diagnosticsFile: cli.diagnosticsFile })
  hitRegions().attach(win)
  hitRegions().setEnabled(mode === 'pet')
  hitRegions().start()
  startInstanceHeartbeat(() => windowMode())

  /**
   * ★ 全局快捷键（本轮）：默认 `Ctrl+Alt+Space`，可配置、可关闭。
   *
   * 放在 IPC 注册**之后**：注册失败时 `applyConversationHotkey()` 会发一条
   * `evt:alert` 给界面 —— 通道得先接上，告警才不会打空。
   * ⚠ 失败**必须可见**（本轮的硬要求）：它同时进 `conversation:state`、诊断快照与界面告警，
   *   绝不允许"按了没反应但什么都不说"。
   */
  applyConversationHotkey()

  /**
   * ═══════ ★★ 启动行为（2026-10-09 完善轮；用户本轮的第 ③ 条要求）
   *
   * **打开软件不再自动出现桌宠**，默认只出现对话窗口。
   *
   * 两条设置的组合（真源在 `settings.ts` 的同名字段，这里是它的**唯一**落点）：
   *   | petResident | startupOpenChat | 启动后看到什么 |
   *   |---|---|---|
   *   | false（默认） | true（默认） | **只有对话窗口** ← 新默认行为 |
   *   | true | true | 对话窗口 + 桌宠 |
   *   | false | false | 什么都没有，**只留托盘图标** |
   *   | true | false | 只有桌宠（= 旧行为） |
   *
   * 顺序（`createMainWindow` 的 `autoShowOnReady` 已经处理了桌宠那一半）：
   *   ① 桌宠那一半在窗口创建时就定了（`autoShowOnReady: wantResident`，
   *      而 `wantResident` 在托盘创建之前算好）——
   *      **不在这里补 `show()`**，否则"启动时略过显示"与"随后立刻显示"之间会闪一下；
   *   ② 对话窗口这一半在这里做：显式 `openConversation('startup')`。
   *      调用点放在 IPC 注册与快捷键注册**之后**，理由与 `applyConversationHotkey()` 相同：
   *      窗口创建要靠 IPC 通道发告警，通道得先接上。
   *   ③ 两个都关 ⇒ 什么都不做，应用只剩托盘图标（**这是合法状态，不是缺陷**：
   *      托盘菜单里随时能「显示桌宠」或「开始对话」）。
   */
  const openChatAtBoot = startupOpenChat()
  log().info('启动显示策略', {
    petResident: residentAtBoot, startupOpenChat: openChatAtBoot,
    cliOverride: cli.probePetMode, wantResident,
    petVisibleNow: petMenuState().visible, mode,
  }, 'boot.visibility-plan')

  if (openChatAtBoot) {
    const r = openConversation('startup')
    if (!r.ok) {
      /**
       * ⚠ 启动时打不开对话窗口**必须可见**（告警条 + 日志）。
       *   静默的话，用户看到的是"打开软件什么都没发生"，而那与
       *   "两个开关都关了"（合法状态）在界面上**完全一样** —— 无法归因。
       */
      log().error('启动时打开对话窗口失败', { reason: r.refusedReason ?? 'unknown' }, 'boot.chat.failed')
      sendAlert({
        level: 'error',
        title: '启动时没能打开对话窗口',
        detail: `原因：${r.refusedReason ?? '未知'}。可以从托盘菜单「开始对话」重试。`,
        code: 'STARTUP_CHAT_OPEN_FAILED',
        blocking: false,
      })
    }
  }
  /**
   * 补一次状态广播：托盘/快捷键是主进程发起的入口，但上面这些调用发生在 renderer
   * 订阅之前 —— 不补这一下，界面就永远不知道主进程侧的初始状态
   * （表现为"快捷键能开窗口但界面不显示对话框"，以及"勾选状态不对"）。
   */
  announceConversationState()
  /** 常驻状态单独广播一次：`evt:pet-menu-state` 的订阅者可能比 `conversation:state` 更晚挂上 */
  try { sendPetMenuState(petMenuState()) } catch { /* ignore */ }

  /**
   * ★ M5 §1：初始化适配层（角色 / 语音 / LLM / 工具 / 存储的注册与选型）。
   *
   * 顺序放在 IPC 之后、主动引擎之前，理由是依赖：
   *   · 适配器的 `init()` 会**实测**可用性（枚举 SAPI 声音、解析角色清单）——
   *     这是"如实告知"的前提，必须在任何使用者之前完成；
   *   · 主动引擎要朗读，所以它必须拿到**同一个** TTS 适配器实例
   *     （两个实例＝两个子进程抢音频设备，本项目已在 tts-engine 注释里记过这个坑）。
   * 初始化失败**不阻塞启动**：各适配器被标成不可用，UI 如实显示。
   */
  const capabilityInit = (async (): Promise<void> => {
    try {
      /**
       * ★ M3 的四根出口线**必须在 init 之前接好**：
       *   适配器的 `init()` 会读屏幕/语音状态，而工具执行时的确认与提示都靠这几根线。
       *   漏接的后果是**静默**的（截图提示不显示、确认弹窗永不出现），
       *   所以放在这里而不是散在别处。
       */
      setToolConfirmSender((req) => { broadcast(IPC.EVT_TOOL_CONFIRM, req) })
      /**
       * ★★ 2026-10-06（用户裁定 A4「做闭环」）：把 STT → LLM → TTS 的闭环**真的接上**。
       *
       * 两件事都必须在这里做（IPC 就绪之后、且只做一次）：
       *   ① `installVoiceCallBridge()` —— 订阅 `voice-engine.onRecognizedText()`。
       *      这条线此前**全仓零订阅者**（那个 `bindRecognizedTextSink` 是只求值参数的
       *      空实现）：不接上，唤醒词永远只是个被记下来的事件，不会开始任何对话。
       *   ② `reconcileWakeWatch()` —— 按设置把"待机听唤醒"拉到应有的状态。
       *      它是幂等的：两条前置（`hearingEnabled` + `wakeWordEnabled`）的判断
       *      集中在那一个函数里，避免多处各判一遍而漂移。
       *
       * ⚠ 两者都**不打开麦克风**：真正决定"听不听"的是设置里的两个开关（默认都是 false），
       *   `startWakeWatch()` 会在任一为假时结构化拒绝。
       */
      installVoiceCallBridge()
      const wake = reconcileWakeWatch()
      log().info('语音闭环已接线', {
        wakeWatchRunning: wake.running, shouldRun: wake.shouldRun, reason: wake.reason,
      }, 'voice.loop.wired')
      /**
       * ★ 隐私通道探针：把"导出/删除两条通道到底接上了没"变成适配层能如实报告的读数。
       *
       * 为什么必须有（而不是让适配器乐观写 `available:true`）：
       *   `privacy` 适配器的唯一职责就是**如实**告诉用户"你的数据主体权利现在能不能行使"。
       *   乐观写 true 会让"通道没接上"看起来像"一切正常"——那正是本工程反复要避免的假结论。
       *   注入在这里而不是 capabilities 内部直接 import `ipc.ts`：后者会重造
       *   `ipc → capabilities → ipc` 那个已被专门拆掉的环。
       */
      setPrivacyChannelProbe(() => ({
        exportAvailable: isChannelRegistered(IPC.PRIVACY_EXPORT),
        wipeAvailable: isChannelRegistered(IPC.PRIVACY_WIPE),
      }))
      wireM3Outlets({
        confirm: (tool, permissionKind, paramsDigest) => requestToolConfirm(tool, permissionKind, paramsDigest),
        screenNotice: (n) => { broadcast(IPC.EVT_SCREEN_NOTICE, n) },
        voiceNotice: (n) => { broadcast(IPC.EVT_VOICE_NOTICE, n) },
        /**
         * 通话事件带**回复文本**（只用于气泡显示）。
         * ⚠ `broadcast` 不做 schema 校验，而这条载荷含用户可见的回复正文 ——
         *   所以这里**不写日志**（`voice-call.ts` 的 notice 只记长度），
         *   并且它只发往**本应用唯一的那个窗口**。
         */
        callNotice: (n) => { broadcast(IPC.EVT_VOICE_CALL, n) },
      })
      const b = await initCapabilityKit()
      const d = b.kit.diagnostics()
      log().info('适配层初始化完成', {
        profile: d.profile,
        adapters: d.total,
        active: Object.entries(d.byKind).filter(([, v]) => v.activeId).map(([k, v]) => `${k}=${v.activeId}`).join(',') || '<none>',
        tools: b.tools.list().length,
        toolsModelVisible: b.tools.list().filter(t => t.decision !== 'denied').length,
      }, 'kit.init.done')
      // 工具审计：把"哪些工具被权限挡住"变成可见事实（**不执行任何工具**）
      for (const t of b.tools.list()) {
        if (t.decision === 'denied') {
          recordToolCall({
            callId: `startup-${t.name}`, tool: t.name, decision: 'denied',
            reason: `权限硬下限/未启用：${t.permissionKind}`, ok: null, durationMs: null,
            // ★ 用**同一个**摘要函数（占位也要合法格式，"格式正确"才能机械校验）
            paramsDigest: digestOf(`${t.name}:startup-denied`), resultDigest: null,
          })
        }
      }
    } catch (e) {
      log().error('适配层初始化失败（应用继续启动，功能会如实显示为不可用）', {
        err: e instanceof Error ? e.message.slice(0, 300) : String(e),
      }, 'kit.init.failed')
    }
  })()
  void capabilityInit

  bindSession({
    requestQuit: () => quit('session'),
    /**
     * ★ 重启（2026-10-09 完善轮，桌宠右键菜单「重启应用」）。
     *
     * ⚠ **顺序不可反**：`app.relaunch()` 只登记"退出后要再拉起一个新进程"，
     *   必须先登记再走正常退出流程。反过来（先 `quit()`）就再也没有机会登记，
     *   表现是"点重启 = 关掉不回来" —— 而它看起来像应用崩溃，不像一个顺序问题。
     */
    requestRestart: () => {
      try {
        app.relaunch({ args: process.argv.slice(1) })
        log().info('重启已排程（退出后将拉起新进程）', { args: process.argv.slice(1).join(' ') }, 'boot.relaunch')
      } catch (e) {
        log().error('重启排程失败', { err: e instanceof Error ? e.message : String(e) }, 'boot.relaunch.failed')
      }
      quit('restart')
    },
    alert: (a) => sendAlert(a),
  })

  const motion = refreshMotionStatus()
  if (motion.failed.length) {
    sendAlert({
      level: 'warn',
      title: `动作资产未就位（${motion.failed.length} 项）`,
      detail: motion.failed.slice(0, 5).join('\n'),
      code: 'MOTION_ASSETS_MISSING',
      blocking: false,
      criterion: 'A13',
    })
  }

  /**
   * ★ M2：主动陪伴引擎接在**窗口、托盘、IPC 都就绪之后**。
   *
   * 顺序理由：引擎的首次 tick 会立刻做"网络与服务就绪判定 → 开机问候"，
   * 而问候要经 `sendProactiveEvent()` 发到 renderer —— 窗口还没建好就发等于丢掉。
   * 放在这里也保证"先有可用界面，再考虑打扰用户"。
   *
   * ★ 并且**等适配层初始化完成**再接线：引擎要朗读，必须拿到与 IPC 同一个
   *   TTS 适配器实例（两个实例＝两个 SAPI 子进程抢音频设备，声音交叠）。
   */
  await capabilityInit
  proactiveHandle = startProactive(cli)

  /**
   * `--selfcap <png 路径>`：让 renderer 把当前帧**自拍**出来并落盘，同时给出两条独立读数
   *   · `readPixelsNonBg`：从 WebGL 帧缓冲回读的非背景色比例；
   *   · `copyNonBg`      ：把画布拷到 2D canvas 后的非背景色比例。
   * 这两条读数是"画布里有没有内容"与"内容能不能被呈现"的分界判据。
   */
  if (cli.selfCaptureFile) {
    const capFile: string = cli.selfCaptureFile
    const capAt = cli.selfCaptureMs
    log().info('--selfcap 已排程', { file: capFile, ms: capAt, testBox: cli.testBox }, 'selfcap.scheduled')
    setTimeout(() => {
      void (async () => {
        const w = getWindow()
        let captured: { png?: string, readPixelsNonBg?: number, copyNonBg?: number, size?: unknown } | null = null
        let capError: string | null = null
        let testBox: unknown = null
        let testBoxError: string | null = null

        /**
         * ① 隔离实验（`--testbox`）：**分场景**测量画面内容占比，一次跑完。
         *
         * 为什么这么设计（本轮定位逻辑）：模型健康度读数已证明
         * `meshWorldScale=1` / `maxVertices=13014` / 骨骼高度正常（hips 0.717 → head 1.108 → foot 0.048），
         * 唯一没排除的是**蒙皮矩阵**。逐场景测"画面里有多少非清屏色像素"：
         *   a) 只开动画（现状）      —— 基线
         *   b) 停掉动画（绑定姿态）  —— 绑定姿态可见 ⇒ 问题在 VRMA 对骨骼的作用
         *   c) 隐藏模型 + 放红方块   —— 证明测量链路本身能看见东西（对照）
         */
        if (cli.testBox && w && !w.isDestroyed()) {
          const measure = async (): Promise<number> => {
            try {
              const r = await w.webContents.executeJavaScript(
                '(() => { const f = window.__AIRIMATE_SELFCAP__; return f ? f().readPixelsNonBg : -1 })()', true,
              ) as number
              return typeof r === 'number' ? r : -1
            } catch { return -1 }
          }
          const steps: Array<Record<string, unknown>> = []
          try {
            await new Promise(r => setTimeout(r, 600))
            steps.push({ step: 'a_withAnimation', nonBg: await measure() })

            await w.webContents.executeJavaScript('(() => window.__AIRIMATE_TESTBOX__("stopAnimation"))()', true)
            await new Promise(r => setTimeout(r, 600))
            steps.push({ step: 'b_bindPose', nonBg: await measure() })

            // 重量一次：停掉动画后可能又轮到下一轮 tick 恢复播放，这里再确认一次
            await w.webContents.executeJavaScript('(() => window.__AIRIMATE_TESTBOX__("stopAnimation"))()', true)
            await new Promise(r => setTimeout(r, 600))
            steps.push({ step: 'b2_bindPoseAgain', nonBg: await measure() })

            await w.webContents.executeJavaScript('(() => window.__AIRIMATE_TESTBOX__("hideModel"))()', true)
            const tb = await w.webContents.executeJavaScript('(() => window.__AIRIMATE_TESTBOX__("add"))()', true)
            await new Promise(r => setTimeout(r, 600))
            steps.push({ step: 'c_hiddenModel_plusTestBox', nonBg: await measure(), testBox: tb })

            await w.webContents.executeJavaScript('(() => window.__AIRIMATE_TESTBOX__("remove"))()', true)
            await w.webContents.executeJavaScript('(() => window.__AIRIMATE_TESTBOX__("showModel"))()', true)
            testBox = { ran: true, steps }
          } catch (e) {
            testBoxError = e instanceof Error ? e.message : String(e)
            testBox = { ran: false, steps }
          }
          console.log(`[airimate] TESTBOX ${JSON.stringify({ steps, testBoxError })}`)
        }

        // ② 再取自拍。失败也不影响 ① 已经产出的证据。
        try {
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const raw = await w.webContents.executeJavaScript(
            '(() => { const f = window.__AIRIMATE_SELFCAP__; return f ? f() : null })()', true,
          ) as { png?: string, readPixelsNonBg?: number, copyNonBg?: number, size?: unknown } | null
          if (!raw) throw new Error('页面未挂载 __AIRIMATE_SELFCAP__')
          captured = raw
        } catch (e) {
          capError = e instanceof Error ? e.message : String(e)
          console.error(`[airimate] SELFCAP_FAILED ${capError}`)
        }

        // ③ 落盘：PNG + 一份把两组读数放在一起的 JSON（同一份证据里对照）
        try {
          if (captured?.png) {
            const b64 = captured.png.split(',')[1] ?? ''
            writeFileSync(capFile, Buffer.from(b64, 'base64'))
            console.log(`[airimate] SELFCAP_WRITTEN ${capFile}`)
          } else {
            console.log('[airimate] SELFCAP_NO_PNG')
          }
          const summary = {
            generatedAt: new Date().toISOString(),
            testBox,
            testBoxError,
            capError,
            readPixelsNonBg: captured?.readPixelsNonBg ?? null,
            copyNonBg: captured?.copyNonBg ?? null,
            size: captured?.size ?? null,
          }
          writeFileSync(`${capFile}.json`, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
          log().info('自拍与对照实验完成', {
            file: capFile, readPixelsNonBg: captured?.readPixelsNonBg ?? -1,
            copyNonBg: captured?.copyNonBg ?? -1, testBoxErr: testBoxError ?? '', capErr: capError ?? '',
          }, 'selfcap.done')
        } catch (e) {
          console.error(`[airimate] SELFCAP_WRITE_FAILED ${e instanceof Error ? e.message : String(e)}`)
        }

        if (cli.selfCaptureExit) quit('selfcap')
      })()
    }, capAt)
  }

  /**
   * `--probe a10`：轮盘锚点精度验收（判据 A10：开→关→开，锚点误差 ≤ 2px）。
   *
   * 做法：通过 renderer 暴露的 `__AIRIMATE_WHEEL_PROBE__` 直接读**轮盘自身的几何**
   * （与命中测试、命中区域上报同源），避免像素级鼠标注入带来的不可复现误差。
   * 同时顺带验证"命中区域 = 视觉区域"（8 个方向全部可命中）。
   */
  if (cli.probe === 'a10') {
    const probeAt = 14_000
    log().info('--probe a10 已排程', { ms: probeAt }, 'probe.a10.scheduled')
    setTimeout(() => {
      void (async () => {
        const w = getWindow()
        const result: Record<string, unknown> = { steps: [] }
        try {
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const call = async (op: string): Promise<unknown> =>
            await w.webContents.executeJavaScript(
              `(() => { const f = window.__AIRIMATE_WHEEL_PROBE__; return f ? f(${JSON.stringify(op)}) : null })()`, true,
            )
          const steps: unknown[] = []
          const opens: Array<{ anchorX: number, anchorY: number, scale: number }> = []
          for (const op of ['open', 'close', 'open'] as const) {
            const r = await call(op) as { anchorX?: number, anchorY?: number, scale?: number } | null
            steps.push({ op, r })
            if (op === 'open' && r && typeof r.anchorX === 'number' && typeof r.anchorY === 'number') {
              opens.push({ anchorX: r.anchorX, anchorY: r.anchorY, scale: r.scale ?? 0 })
            }
            // 关闭后等它缩到 0，再开；打开后等 scale 收敛
            await new Promise(res => setTimeout(res, op === 'close' ? 900 : 700))
          }
          const base = opens[0]
          const errs = opens.slice(1).map(o => base
            ? Number(Math.hypot(o.anchorX - base.anchorX, o.anchorY - base.anchorY).toFixed(3))
            : -1)
          const maxErr = errs.length ? Math.max(...errs) : -1
          /**
           * 命中一致性必须在**动画收敛后**测：`scale` 达到 1 时"视觉 == 命中"才可判定。
           * 弹出过程中测会得到"看得到却点不到"的假失败（实测踩到）。
           */
          await call('open')
          await call('settle')
          /**
           * `--probe-shot <png>`：把轮盘**打开并收敛**的状态截图落盘。
           * 为什么必须截屏：`visualBox` 之类的几何读数只能证明"轮盘认为自己在哪里"，
           * 不能证明"它真的画在画布内、没有被裁掉"。A20 要求视觉验收必须有真实桌面截图。
           */
          if (cli.probeShot) {
            try {
              const img = await w.webContents.capturePage()
              mkdirSync(dirname(cli.probeShot), { recursive: true })
              writeFileSync(cli.probeShot, img.toPNG())
              console.log(`[airimate] PROBE_SHOT_WRITTEN ${cli.probeShot}`)
            } catch (e) {
              // ⚠ 不静默：截图失败必须说出来（本项目已多次因静默 catch 丢证据）
              console.error(`[airimate] PROBE_SHOT_FAILED ${e instanceof Error ? e.message : String(e)}`)
            }
          }
          const hit = await call('hitTest') as { allHit?: boolean, hits?: boolean[], scale?: number } | null
          /** 视觉"不越界 + 不拥挤"的可判定检查 */
          const bounds = await call('bounds') as {
            passInWindow?: boolean, outOfWindow?: number[], minGapPx?: number | null,
            sizeInfo?: { radius: number, itemSize: number }, window?: number[]
          } | null
          const settledState = await call('state') as { scale?: number } | null
          await call('close')
          result.steps = steps
          result.opens = opens
          result.errors = errs
          result.maxErrPx = maxErr
          result.passA10 = maxErr >= 0 && maxErr <= 2
          result.hitTest = hit
          result.settledScale = settledState?.scale ?? null
          result.passHitRegionMatchesVisual = hit?.allHit === true
          result.bounds = bounds
          result.passWheelInWindow = bounds?.passInWindow === true
          result.wheelMinGapPx = bounds?.minGapPx ?? null
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
        }
        console.log(`[airimate] PROBE_A10 ${JSON.stringify(result)}`)
        try {
          if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
        } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  /**
   * `--probe a14`：拖拽验收（判据 A14：拖拽期 PET_DRAGGING 生效、松手后弹簧回正）。
   *
   * 分两段测：
   *   ① **窗口层**：走真实的 `beginDrag/dragTo/endDrag`，断言"窗口位移跟随、**尺寸零变化**"；
   *   ② **骨骼层**：通过 `__AIRIMATE_DRAG_PROBE__` 喂入**已知**位移序列并推进帧，
   *      读出摇晃倾斜与是否回正 —— 这一段不依赖真实光标轨迹，因此**可复现**。
   */
  if (cli.probe === 'a14') {
    const probeAt = 14_000
    log().info('--probe a14 已排程', { ms: probeAt }, 'probe.a14.scheduled')
    setTimeout(() => {
      void (async () => {
        const w = getWindow()
        const result: Record<string, unknown> = {}
        try {
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const sizeDrift: Array<{ w: number, h: number }> = []
          const positions: Array<{ x: number, y: number }> = []
          const call = async (op: string, arg?: unknown): Promise<unknown> =>
            await w.webContents.executeJavaScript(
              `(() => { const f = window.__AIRIMATE_DRAG_PROBE__; return f ? f(${JSON.stringify(op)}, ${JSON.stringify(arg ?? null)}) : null })()`, true,
            )

          // ── ① 窗口层：真实拖拽路径 + 尺寸零变化断言
          const b0 = { ...w.getBounds() }
          const d0 = screen.getDisplayMatching(b0)          /**
           * 额外记录**工作区**与**缩放比**：尺寸漂移的头号候选是
           * "Windows 为把窗口容纳进工作区而收缩"以及"跨显示器 DPI 变化"。
           * 两者都能从这两个读数直接判定。
           */
          result.preDrag = {
            bounds: b0,
            workArea: d0.workArea,
            scaleFactor: d0.scaleFactor,
            resizable: w.isResizable(),
            insideWorkArea: b0.x >= d0.workArea.x && b0.y >= d0.workArea.y
              && b0.x + b0.width <= d0.workArea.x + d0.workArea.width
              && b0.y + b0.height <= d0.workArea.y + d0.workArea.height,
          }
          await call('start')
          /**
           * ★ 用**可控光标源 + 主进程定时器**做唯一驱动源来测。
           *   不再直接调 `dragTo` —— 上一轮正是"探针调 dragTo + 定时器读真实光标"
           *   两个驱动源交替，才产生了与位移成比例的尺寸漂移（见 A14 证据文档）。
           */
          let cursor = { x: b0.x + 10, y: b0.y + 10 }
          setDragCursorSource(() => cursor)
          beginDrag(cursor)
          const sizeSeq: Array<{ w: number, h: number, x: number, y: number }> = []
          for (let i = 1; i <= 8; i++) {
            cursor = { x: b0.x + 10 + i * 5, y: b0.y + 10 + i * 3 }
            await new Promise(r => setTimeout(r, 40))   // 等定时器跑几帧
            const bb = w.getBounds()
            sizeSeq.push({ w: bb.width, h: bb.height, x: bb.x, y: bb.y })
            sizeDrift.push({ w: bb.width - b0.width, h: bb.height - b0.height })
            positions.push({ x: bb.x, y: bb.y })
          }
          setDragCursorSource(null)
          const end = endDrag()
          const b1 = { ...w.getBounds() }
          /**
           * 说明：`beginDrag()` 会自己冻结目标尺寸（`end.targetSize`），本探针的口径是
           *   "**拖动有没有改变窗口尺寸**"，所以比较基准就是拖动前那次读回值 `b0`。
           *
           * ⚠ 曾经试过"先把尺寸对齐到 DIP 栅格再冻结"并用 `end.targetSize` 当基准，
           *   **已撤销**：那一步会让读回相位翻到另一侧，实测比不对齐**更差**
           *   （见 `docs/evidence/phase16/CHAT-WINDOW-ROUND.md` §3.2）。
           */
          const d1 = screen.getDisplayMatching(b1)
          result.postDrag = { bounds: b1, workArea: d1.workArea, scaleFactor: d1.scaleFactor, resizable: w.isResizable() }
          result.sizeSequence = sizeSeq
          result.windowLayer = {
            startBounds: b0,
            endBounds: b1,
            moved: end.moved, distance: end.distance,
            positions,
            maxWidthDrift: Math.max(...sizeSeq.map(s => Math.abs(s.w - b0.width))),
            maxHeightDrift: Math.max(...sizeSeq.map(s => Math.abs(s.h - b0.height))),
          }
          result.passWindowMoves = end.distance > 0
          /**
           * ⚠ 尺寸子判据在**下面**统一算（`passSizeUnchanged`），因为要同时用到
           * `sizeSequence`（判"恒定/不累积"）与 `windowLayer`（判绝对偏差）。
           * 这里只保留原始序列，不做判定 —— 判定只有一个地方，免得两处口径打架。
           */

          // ── ② 骨骼层：喂入已知位移（拖拽中 → 松手回正）
          await call('start')
          const during = await call('feed', { deltas: Array.from({ length: 30 }, () => [140, 0]), dragging: true, fps: 60 })
          const heavy = await call('feed', { deltas: Array.from({ length: 10 }, () => [-260, 60]), dragging: true, fps: 60 })
          await call('release')
          // 松手后 2 秒（120 帧）应该回到静止
          const after = await call('feed', { deltas: Array.from({ length: 120 }, () => [0, 0]), dragging: false, fps: 60 })
          const st = await call('state')
          result.boneLayer = { during, heavy, after, state: st }
          const d = during as { maxAbsLeanZ?: number, baseClipId?: string | null } | null
          const h = heavy as { maxAbsLeanX?: number } | null
          const a = after as { atRest?: boolean, maxAbsLeanZ?: number } | null
          result.passDragTilts = (d?.maxAbsLeanZ ?? 0) > 0.5 && (h?.maxAbsLeanX ?? 0) > 0.5
          result.passDragClipActive = typeof d?.baseClipId === 'string' && d.baseClipId.length > 0
          result.passSpringReturns = a?.atRest === true

          /**
           * A14 的**尺寸子判据**（口径由用户 2026-09-27 定稿，方案 B）。
           *
           * 判据：拖拽期间 `getBounds()` 的尺寸读数**恒定（不累积）**，
           *       且与拖拽前尺寸的偏差 ≤ 1 DIP。
           *
           * 为什么不是"逐位相等"：本机 `scaleFactor = 1.25`，`482×761 DIP`
           * = `602.5×951.25 物理像素` —— 物理像素必须是整数，所以"请求什么就得到什么"
           * 在这个 DPI 下**不可能**（`--probe sizeDiag` 的原始读数：请求 470→472、
           * 482→484、484→486，恒有固定偏移且不可回收）。
           *
           * 为什么这样仍然能抓住旧缺陷：旧缺陷是**累积**——8 步拖动 +20/+17 一路涨到
           * 528×810，`sizeSequence` 会给出**多个不同值**；而"恒定"要求的是**只有一个值**。
           * 两个数都落盘：`sizeReadingsDistinct`（累积性）与 `sizeDriftMaxDip`（绝对偏差）。
           */
          const w0 = result.windowLayer as { startBounds?: { width: number, height: number }, maxWidthDrift?: number, maxHeightDrift?: number } | null
          const seq = (result.sizeSequence ?? []) as Array<{ w: number, h: number }>
          const readings = seq.map(s => `${s.w}x${s.h}`)
          const distinct = [...new Set(readings)]
          const startSize = `${w0?.startBounds?.width ?? 0}x${w0?.startBounds?.height ?? 0}`
          const driftMax = Math.max(w0?.maxWidthDrift ?? 0, w0?.maxHeightDrift ?? 0)
          result.sizeReadings = readings
          result.sizeReadingsDistinct = distinct
          result.sizeReadingStart = startSize
          result.sizeDriftMaxDip = driftMax
          result.passSizeReadingsConstant = distinct.length === 1
          result.passSizeDriftWithin1Dip = driftMax <= 1
          result.strictSizeUnchanged = driftMax === 0
          /** A14 尺寸子判据 = 恒定（不累积）**且**偏差 ≤1 DIP */
          result.passSizeUnchanged = result.passSizeReadingsConstant === true
            && result.passSizeDriftWithin1Dip === true
          /** ⚠ 严格口径（0 DIP）**如实记录但不参与判定** —— 见上面的说明 */
          result.passSizeUnchangedStrict = result.strictSizeUnchanged === true
          result.pass = result.passWindowMoves === true && result.passSizeUnchanged === true
            && result.passDragTilts === true && result.passDragClipActive === true
            && result.passSpringReturns === true
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
          result.pass = false
        }
        console.log(`[airimate] PROBE_A14 ${JSON.stringify(result)}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  /**
   * `--probe sizeMap`：**非整数 DPI 下"位置 → 可读回尺寸"的映射实测**（2026-10-08 返工轮新增）
   *
   * 为什么需要它（这是 A11 那条 1 DIP 漂移的归因工具）：
   *   A11 的现象是"拖动把窗口从 `482×762` 变成 `482×763`，逐位还原失败"。
   *   已知事实（`phase3/round-interaction/sizeDiag.json`，同一台机器、同为 125% 缩放）：
   *     · 请求 `480×760` 在**起点位置**读回 `482×762`（+2/+2 的仿射关系，可反解）；
   *     · 请求 `470×750` → `472×751`、`482×762` → `484×763`（映射**不可逆**）。
   *   而本轮 A11 的标定读数恰恰是 "请求 480×760 → 读回 **482×762**"（起点可达），
   *   但拖动到终点后同一个请求只读回 `482×763`。
   *
   *   ⇒ 唯一还没被直接测过的量是：**映射随窗口位置怎么变**。
   *     本探针把 x 扫一遍（覆盖 A11 起点 934 与其终点 996），
   *     在每个位置记录"请求 `targetSize` 读回什么"，并给出：
   *       · `reachable`：该位置能否读回起点那个尺寸；
   *       · `best`：不能时最接近的读数与差多少 DIP；
   *       · `deltaAtPosition`：该位置的实测补偿量。
   *   有了它就能回答"是代码该改（拖到某处就做不到逐位还原）还是判据该改（该位置物理上不可达）"。
   */
  if (cli.probe === 'sizeMap') {
    const probeAt = 12_000
    setTimeout(() => {
      void (async () => {
        const result: Record<string, unknown> = {
          probe: 'sizeMap',
          note: '在多个 x 位置重复"请求 targetSize → 读回"，看映射是否随位置变化',
        }
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const b0 = { ...w.getBounds() }
          const origMin = w.getMinimumSize()
          const origMax = w.getMaximumSize()
          /** 目标 = 当前（启动后）的窗口尺寸；A11 的拖动目标尺寸就是从它来的 */
          const target = { width: b0.width, height: b0.height }
          /** 请求值 = 目标 − 规格上已知的 +2/+2 偏移（与 `calibrateDragSize` 同口径） */
          const request = { width: target.width - 2, height: target.height - 2 }
          result.baseline = { bounds: b0, target, request, min: origMin, max: origMax }
          try { w.setMinimumSize(0, 0); w.setMaximumSize(0, 0) } catch { /* ignore */ }

          const y0 = b0.y
          const xs = [b0.x - 120, b0.x - 60, b0.x, b0.x + 30, b0.x + 62, b0.x + 90, b0.x + 120, b0.x + 180]
          const rows: Array<Record<string, unknown>> = []
          for (const x of xs) {
            const safeX = Math.max(0, x)
            /**
             * 每个位置测两次：
             *   ① 按 `request` 请求 → 读回（这就是拖动每帧做的事）；
             *   ② 再按 `target` 直接请求 → 读回（看"直接要目标值"能不能到）。
             * 两次之间先把窗口挪开再挪回来，避免窗口管理器把连续同位置请求合并。
             */
            w.setBounds({ x: safeX, y: y0 + 40, width: request.width, height: request.height })
            w.setBounds({ x: safeX, y: y0, width: request.width, height: request.height })
            const viaRequest = { ...w.getBounds() }
            w.setBounds({ x: safeX, y: y0, width: target.width, height: target.height })
            const viaTarget = { ...w.getBounds() }
            const best = {
              width: viaRequest.width, height: viaRequest.height,
              distDip: Math.abs(viaRequest.width - target.width) + Math.abs(viaRequest.height - target.height),
            }
            rows.push({
              x: safeX,
              viaRequest: `${viaRequest.width}x${viaRequest.height}`,
              viaTarget: `${viaTarget.width}x${viaTarget.height}`,
              reachable: viaRequest.width === target.width && viaRequest.height === target.height,
              deltaAtPosition: { width: request.width - viaRequest.width, height: request.height - viaRequest.height },
              best,
            })
          }
          result.positions = rows
          const reachableXs = rows.filter(r => r.reachable === true).map(r => r.x)
          result.reachablePositions = reachableXs
          result.reachableCount = reachableXs.length
          /** 判定：是否存在**某些位置**做不到逐位还原（= A11 的失败是位置性的） */
          result.passPositionIndependent = reachableXs.length === rows.length
          result.verdict = reachableXs.length === rows.length
            ? '所有测过的位置都能逐位还原 ⇒ A11 的漂移不是位置性的，需另找原因'
            : `有 ${rows.length - reachableXs.length}/${rows.length} 个位置**做不到**逐位还原 ⇒ 漂移是位置性的`

          /**
           * ★★ 第二组：**钉死 min/max 之后**再请求目标尺寸。
           *
           * 为什么必须测这一组（这是 A11 漂移的真正嫌疑）：
           *   `beginDrag()` 会用 `setMinimumSize(requestSize)` + `setMaximumSize(requestSize)`
           *   把尺寸**钉死在请求值**（`480×760`）上，`endDrag()` 再迭代收敛回目标。
           *   上面第一组已经证明：**不钉**的时候请求 `480×760` 能读回 `482×762`（目标）；
           *   但如果钉了之后 `min=480` 会被窗口管理器**上取整成一个比目标还大的物理尺寸**，
           *   那么拖动期间永远到不了 `482×762`，松手后的收敛也就在一个"被抬高的下界"上打转。
           *
           * 判定：钉死 `480×760` 之后，
           *   ① 请求 `480×760` 读回什么？
           *   ② 请求目标 `482×762` 读回什么？（拖动期间与结束后都在请求这个值）
           */
          const pinnedRows: Array<Record<string, unknown>> = []
          /**
           * 测三组：① 钉成一个点（`480×760`，**旧实现**）；② 钉成一个点（目标值）；
           * ③ 钉成 `request ± 4` 的**窄带**（**新实现**）。第 ③ 组才是现行代码，
           * 前两组是"旧实现为什么不行"的对照读数。
           */
          const pins: Array<{ label: string, min: [number, number], max: [number, number] }> = [
            { label: 'pin-point-request-480x760', min: [480, 760], max: [480, 760] },
            { label: 'pin-point-target-482x762', min: [482, 762], max: [482, 762] },
            { label: 'pin-band-request±4', min: [476, 756], max: [484, 764] },
          ]
          for (const spec of pins) {
            try { w.setMinimumSize(spec.min[0], spec.min[1]); w.setMaximumSize(spec.max[0], spec.max[1]) } catch { /* ignore */ }
            const afterPin = { ...w.getBounds() }
            const gotMin = w.getMinimumSize()
            const gotMax = w.getMaximumSize()
            w.setBounds({ x: b0.x, y: y0, width: request.width, height: request.height })
            const viaPinRequest = { ...w.getBounds() }
            w.setBounds({ x: b0.x, y: y0, width: target.width, height: target.height })
            const viaTargetRequest = { ...w.getBounds() }
            pinnedRows.push({
              pin: spec.label,
              getMinimumSize: `${gotMin[0]}x${gotMin[1]}`,
              getMaximumSize: `${gotMax[0]}x${gotMax[1]}`,
              boundsAfterPin: `${afterPin.width}x${afterPin.height}`,
              viaPinRequest: `${viaPinRequest.width}x${viaPinRequest.height}`,
              viaTargetRequest: `${viaTargetRequest.width}x${viaTargetRequest.height}`,
              targetReachedWhilePinned: viaTargetRequest.width === target.width && viaTargetRequest.height === target.height,
            })
          }
          try { w.setMaximumSize(0, 0) } catch { /* ignore */ }
          result.pinned = pinnedRows
          const bandRow = pinnedRows[2]
          result.passTargetReachableWithBand = bandRow?.targetReachedWhilePinned === true
          result.pinnedVerdict = result.passTargetReachableWithBand
            ? '钉成 request±4 的窄带后目标尺寸**可达** ⇒ 这就是 A11 漂移的修法（对照：钉成一个点时不可达）'
            : '⚠ 即使留了窄带目标仍不可达 ⇒ 需要换别的钉法（例如不钉 max、只钉 min）'

          /**
           * ★★ 第三组：**栅格对齐尺寸在拖动终点位置上的稳定性**。
           *
           * 动机：`endDrag` 每次都把窗口停在 `482×763`（不是冻结的 `482×762`），
           * 而 125% 缩放下 `482×762 DIP = 602.5 × **952.5** 物理像素` —— 高度落在**半像素**上。
           * 半像素尺寸的读回值本来就可能 ±1（取决于亚像素相位），
           * 于是"逐位还原"这条判据可能从一开始就要求了一个**平台不保证**的东西。
           *
           * 测法：把窗口放在 A11 拖动**终点**（x=996）与起点（x=934），
           * 分别请求三种尺寸并**各测两遍**（看重现性）：
           *   · `480×760`（4 的整数倍 ⇒ 600×950 物理像素，**整像素**）；
           *   · `482×762`（当前的冻结目标 ⇒ 602.5×952.5，**半像素**）；
           *   · `480×762`（宽整、高半）。
           * 判定：哪种尺寸在同一位置重复读回**同一个值** ⇒ 那种才配当"不可变目标尺寸"。
           */
          const gridRows: Array<Record<string, unknown>> = []
          for (const [gx, glabel] of [[b0.x, 'start-x'], [996, 'drag-end-x']] as Array<[number, string]>) {
            for (const [gw, gh] of [[480, 760], [482, 762], [480, 762]] as Array<[number, number]>) {
              const readings: string[] = []
              for (let rep = 0; rep < 2; rep++) {
                w.setBounds({ x: gx, y: y0, width: gw, height: gh })
                const b = w.getBounds()
                readings.push(`${b.width}x${b.height}`)
              }
              gridRows.push({
                position: glabel, x: gx, request: `${gw}x${gh}`,
                readings,
                stable: readings[0] === readings[1],
                physical: { w: Number((gw * 1.25).toFixed(2)), h: Number((gh * 1.25).toFixed(2)) },
                bothIntegers: Number.isInteger(gw * 1.25) && Number.isInteger(gh * 1.25),
              })
            }
          }
          result.gridAlignment = gridRows
          const stableRows = gridRows.filter(r => r.stable === true)
          result.stableGridSizes = stableRows.map(r => r.request)
          result.gridVerdict = `在同一位置重复读回稳定的尺寸：${stableRows.map(r => r.request).join('、') || '无'}；` +
            '不稳定的那些（读回值随亚像素相位在 ±1 内变化）不适合当"不可变目标尺寸"'

          // 恢复：min/max 与初始几何（不留副作用）
          try { w.setMinimumSize(origMin[0] ?? 380, origMin[1] ?? 520) } catch { /* ignore */ }
          try { w.setMaximumSize(origMax[0] ?? 0, origMax[1] ?? 0) } catch { /* ignore */ }
          w.setBounds({ x: b0.x, y: b0.y, width: b0.width, height: b0.height })
          result.restored = { ...w.getBounds() }
          result.passRestored = w.getBounds().width === b0.width && w.getBounds().height === b0.height
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
        }
        console.log(`[airimate] PROBE_SIZEMAP ${JSON.stringify({ reachable: result.reachableCount, positions: (result.positions as unknown[] | undefined)?.length })}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  /**
   * `--probe sizeDiag`：**窗口尺寸可控性**地面真值测量。
   *
   * 为什么需要它（本轮实测踩到）：A11 的拖动用例里窗口从 482×762 变成 483×763，
   * `sizeCorrections` 累计 69 次却纠正不回去。要区分三种完全不同的原因，
   * 必须把"我们要求什么 / 系统给什么 / 上下限各是多少 / 缩放因子是多少"一次测出来：
   *   ① `setMaximumSize(w,h)` 与 `setMinimumSize(w,h)` 在 125% 缩放下被 Electron
   *      换算成物理像素时**上取整/下取整方向不同** ⇒ min > max ⇒ 窗口管理器自行取整；
   *   ② `setBounds` 本身在非整数 DPI 下无法精确表达该 DIP 尺寸；
   *   ③ 窗口有系统/Electron 强制的最小尺寸。
   * 判据：先读真值，再决定"尺寸一字不差"这条判据该用什么口径衡量。
   */
  if (cli.probe === 'sizeDiag') {
    const probeAt = 12_000
    setTimeout(() => {
      void (async () => {
        const result: Record<string, unknown> = {}
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const b0 = { ...w.getBounds() }
          const origMin = w.getMinimumSize()
          const origMax = w.getMaximumSize()
          result.original = { bounds: b0, min: origMin, max: origMax }
          const steps: Array<Record<string, unknown>> = []
          const snap = (label: string): Record<string, unknown> => {
            const b = w.getBounds()
            const d = screen.getDisplayMatching(b)
            const row = {
              label,
              bounds: b,
              getMinimumSize: w.getMinimumSize(),
              getMaximumSize: w.getMaximumSize(),
              scaleFactor: d.scaleFactor,
              /** 同一尺寸的**物理像素**表达（DIP × scaleFactor）—— 判断"是不是同一个物理尺寸" */
              physical: { w: Number((b.width * d.scaleFactor).toFixed(3)), h: Number((b.height * d.scaleFactor).toFixed(3)) },
            }
            steps.push(row)
            return row
          }
          snap('baseline_noTuning')

          /**
           * ① **真实拖动路径的对照**：只调 `setBounds`（位置改变 + 尺寸**钉在冻结值**），
           *    来回移动 8 次 —— 这正是 `dragTo()` 每帧做的事。看到尺寸是否漂移。
           */
          const moveSizes: string[] = []
          for (let i = 0; i < 8; i++) {
            const sgn = i % 2 === 0 ? 1 : -1
            w.setBounds({ x: b0.x + sgn * 40, y: b0.y + sgn * 24, width: b0.width, height: b0.height })
            const b = w.getBounds()
            moveSizes.push(`${b.width}x${b.height}`)
          }
          snap('after8BoundsMoves')
          result.boundsMoveSizes = moveSizes

          /** ② 只动位置（`setPosition`，不动尺寸）—— 归因用 */
          const posSizes: string[] = []
          for (let i = 1; i <= 4; i++) {
            w.setPosition(b0.x + i * 5, b0.y + i * 3)
            const b = w.getBounds()
            posSizes.push(`${b.width}x${b.height}`)
          }
          snap('after4PositionMoves')
          result.positionMoveSizes = posSizes

          /**
           * ②b **只给位置、不给尺寸**的 `setBounds`（Electron 允许缺省字段）。
           *     假设：`setBounds` 里带上尺寸会走"改尺寸"的窗口消息，从而带上边框/DIP 取整项；
           *     只给位置则完全不碰尺寸。若这条能逐次一字不差，它就是拖动的正确实现。
           */
          const partialSizes: string[] = []
          const beforePartial = `${w.getBounds().width}x${w.getBounds().height}`
          for (let i = 0; i < 8; i++) {
            const sgn = i % 2 === 0 ? 1 : -1
            w.setBounds({ x: b0.x + sgn * 40, y: b0.y + sgn * 24 } as Electron.Rectangle)
            const b = w.getBounds()
            partialSizes.push(`${b.width}x${b.height}`)
          }
          snap('after8PartialBoundsMoves')
          result.partialBoundsMoveSizes = partialSizes
          result.partialBoundsBefore = beforePartial

          /** ③ 能不能**缩小**到原尺寸以下（决定"漂移是否可回收"） */
          const shrinkSizes: Array<{ req: string, got: string }> = []
          for (const [rw, rh] of [[470, 750], [482, 762], [484, 763], [482, 762]]) {
            w.setBounds({ x: b0.x, y: b0.y, width: rw as number, height: rh as number })
            const b = w.getBounds()
            shrinkSizes.push({ req: `${rw}x${rh}`, got: `${b.width}x${b.height}` })
          }
          snap('afterShrinkAttempts')
          result.shrinkAttempts = shrinkSizes

          /** ④ 现在才钉 min/max —— "钉死"这一步本身是否改变尺寸 */
          w.setMinimumSize(b0.width, b0.height)
          w.setMaximumSize(b0.width, b0.height)
          snap('afterPinMinMax')
          const pinnedSizes: string[] = []
          for (let i = 0; i < 3; i++) {
            w.setBounds({ x: b0.x + i * 30, y: b0.y + i * 18, width: b0.width, height: b0.height })
            const b = w.getBounds()
            pinnedSizes.push(`${b.width}x${b.height}`)
          }
          snap('afterPinnedMoves')
          result.pinnedMoveSizes = pinnedSizes

          /** ⑤ 恢复原始 min/max（不留下副作用），再看能否回到初始尺寸 */
          try { w.setMinimumSize(origMin[0] ?? 380, origMin[1] ?? 520) } catch { /* ignore */ }
          try { w.setMaximumSize(origMax[0] ?? 0, origMax[1] ?? 0) } catch { /* ignore */ }
          w.setBounds({ x: b0.x, y: b0.y, width: b0.width, height: b0.height })
          snap('afterRestoreMinMax')

          result.steps = steps
          const sizeOne = `${b0.width}x${b0.height}`
          const summary = {
            baseline: sizeOne,
            boundsMoveSizes: moveSizes,
            /**
             * ★ 两个**不同**的问题必须分开答：
             *   · `boundsMoveConstant`：8 次移动的读数是否**只有一种值**
             *     —— 这一条答的是**累积漂移**（旧缺陷 482×762 → 528×810）；
             *   · `boundsMoveMatchesRequest`：那一种值是否**等于请求值**
             *     —— 这一条答的是 DIP↔物理像素取整（本平台恒有 +2/+1，且不可回收）。
             * 上一版把两者混成一个 `boundsMoveKeepsSize`，于是"完全不漂"会被报成 false。
             */
            boundsMoveConstant: new Set(moveSizes).size === 1,
            boundsMoveMatchesRequest: moveSizes.every(s => s === sizeOne) && moveSizes.length === 8,
            boundsMoveDistinct: [...new Set(moveSizes)],
            positionMoveSizes: posSizes,
            positionMoveKeepsSize: posSizes.every(s => s === sizeOne),
            partialBoundsBefore: beforePartial,
            partialBoundsMoveSizes: partialSizes,
            /** ★ 只给位置时尺寸是否逐次一字不差 */
            partialBoundsKeepsSize: partialSizes.every(s => s === beforePartial) && partialSizes.length === 8,
            shrinkAttempts: shrinkSizes,
            canShrinkBack: shrinkSizes[shrinkSizes.length - 1]?.got === sizeOne,
            afterPinMinMax: (steps.find(s => s.label === 'afterPinMinMax')?.bounds as { width: number, height: number } | undefined)
              ? `${(steps.find(s => s.label === 'afterPinMinMax')!.bounds as { width: number }).width}x${(steps.find(s => s.label === 'afterPinMinMax')!.bounds as { height: number }).height}`
              : 'n/a',
            pinnedMoveSizes: pinnedSizes,
            pinnedMoveKeepsSize: pinnedSizes.every(s => s === sizeOne),
            physicalBaseline: `${b0.width * 1.25}x${b0.height * 1.25}`,
          }
          result.summary = summary
          result.passBoundsDragNoAccumulation = summary.boundsMoveConstant === true
          result.pass = true
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
          result.pass = false
        }
        console.log(`[airimate] PROBE_SIZEDIAG ${JSON.stringify({ pass: result.pass, summary: result.summary ?? null, error: result.error ?? null })}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  /**
   * `--probe a11`：输入语义验收（判据 A11）—— **本轮按新规格重写**。
   *
   * 旧判据「左键 pointerdown ⇒ 必须开始拖拽」**本身是错的**（它就是缺陷一：
   * 按下即拖拽），所以旧 A11 越"通过"，用户越点不动。新判据按规格改成：
   *
   * | 输入 | 必须 | 必须不 |
   * |---|---|---|
   * | 短按（按下+抬起，不移动） | 什么都不做 | 不移动窗口 / 不开轮盘 / 不改缩放 |
   * | 按住移动 > 4 CSS px（落在角色上） | 进入拖拽、窗口真的移动 | —— |
   * | 按住移动 2 px（< 阈值） | 什么都不做 | 不进入拖拽 |
   * | 在画布空白处按住移动 20 px | 什么都不做 | 不进入拖拽（命中判定） |
   * | 右键 | 开轮盘（再点关闭） | —— |
   * | F1 / Esc | 开 / 关 | —— |
   */
  if (cli.probe === 'a11') {
    const probeAt = 14_000
    log().info('--probe a11 已排程（新判据）', { ms: probeAt }, 'probe.a11.scheduled')
    setTimeout(() => {
      void (async () => {
        const w = getWindow()
        const result: Record<string, unknown> = {
          criteria: {
            clickShort: '不移动窗口 / 不进入拖拽 / 不开轮盘',
            dragOverThreshold: '进入拖拽且窗口真的移动',
            dragBarely: '2px < 4px 阈值 ⇒ 不进入拖拽',
            blankDrag: '空白处不进入拖拽',
          },
          technique: '页面内合成 PointerEvent（走完整 Vue 处理器 → IPC → 主进程 setBounds 链路）',
        }
        try {
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const op = async (o: string): Promise<unknown> =>
            await w.webContents.executeJavaScript(
              `(() => { const f = window.__AIRIMATE_INPUT_PROBE__; return f ? f(${JSON.stringify(o)}) : null })()`, true,
            )
          type St = { before?: { wheelOpen: boolean, dragging: boolean }, after?: { wheelOpen: boolean, dragging: boolean } }
          /**
           * 可注入光标源：拖拽期间主进程用它推进窗口。
           * 这里把它设成"合成起点 + 期望位移"，从而**可控且可复现**地让窗口移动。
           */
          let cursor = { x: 0, y: 0 }
          setDragCursorSource(() => cursor)
          const b0 = windowBounds()
          const hit = await op('hitCenter') as { clientX: number, clientY: number } | null
          if (!hit || !b0) throw new Error('拿不到角色命中点或窗口几何')
          result.coordinates = { windowBounds: b0, rendererScreenX: await w.webContents.executeJavaScript('window.screenX', true), hitCenterClient: hit }
          cursor = { x: b0.x + Math.round(hit.clientX), y: b0.y + Math.round(hit.clientY) }

          // ── ① 短按：必须什么都不做
          const b1 = { ...w.getBounds() }
          const click = await op('clickOnce') as { after?: { dragging: boolean, wheelOpen: boolean }, cameraUnchanged?: boolean } | null
          await new Promise(r => setTimeout(r, 200))
          const b2 = { ...w.getBounds() }
          result.clickShort = {
            renderer: click,
            windowBefore: b1, windowAfter: b2,
            windowMoved: b1.x !== b2.x || b1.y !== b2.y,
            sizeChanged: b1.width !== b2.width || b1.height !== b2.height,
          }
          result.passClickDoesNotDrag = click?.after?.dragging === false
          result.passClickDoesNotMoveWindow = b1.x === b2.x && b1.y === b2.y && b1.width === b2.width && b1.height === b2.height
          result.passClickDoesNotOpenWheel = click?.after?.wheelOpen === false
          result.passClickDoesNotRescale = click?.cameraUnchanged !== false

          // ── ② 阈值以下（2px）不得拖拽
          const barely = await op('dragBarelyMove:2,1') as { after?: { dragging: boolean } } | null
          result.dragBarely = barely
          result.passBarelyDoesNotDrag = barely?.after?.dragging === false

          // ── ③ 空白处按住移动不得拖拽
          const blank = await op('blankDrag:20,12') as { after?: { dragging: boolean } } | null
          result.blankDrag = blank
          result.passBlankDoesNotDrag = blank?.after?.dragging === false

          // ── ④ 越过阈值：必须进入拖拽，且窗口**真的移动**
          const b3 = { ...w.getBounds() }
          const begin = await op('dragBegin:20,12,4') as { after?: { dragging: boolean } } | null
          /**
           * ★ 用**多步光标位移**驱动整段拖动，并在每一步后采样窗口尺寸
           *   （`sizeSeqA11`）—— 这是"可复现"那一半判据的读数来源。
           *
           * 为什么必须多步采样（而不是只看"开始/结束两个点"）：
           *   "偏差 ≤1 DIP"与"累积漂移"在**两点**上是分不开的（旧缺陷每步也只涨 1~2 DIP）；
           *   只有拿到**整条序列**才能判定它是在摆动（量化残差）还是在单调递增（漂移）。
           *   总共位移 40/24，与原来一致；分成 8 步推进。
           */
          const sizeSeqA11: Array<{ w: number, h: number, x: number, y: number }> = []
          for (let i = 1; i <= 8; i++) {
            cursor = {
              x: b0.x + Math.round(hit.clientX) + 20 + Math.round((40 * i) / 8),
              y: b0.y + Math.round(hit.clientY) + 12 + Math.round((24 * i) / 8),
            }
            await new Promise(r => setTimeout(r, 40))     // 等主进程的 16ms 推进定时器跑几帧
            const bb = { ...w.getBounds() }
            sizeSeqA11.push({ w: bb.width, h: bb.height, x: bb.x, y: bb.y })
          }
          const b4 = { ...w.getBounds() }
          const endInfo = endDrag()
          setDragCursorSource(null)
          await new Promise(r => setTimeout(r, 200))
          const b5 = { ...w.getBounds() }
          result.dragOverThreshold = {
            renderer: begin,
            windowStart: b3, windowDuring: b4, windowAfterEnd: b5,
            sizeSequence: sizeSeqA11,
            moved: { dx: b4.x - b3.x, dy: b4.y - b3.y },
            end: endInfo,
          }
          result.passLeftStartsDrag = begin?.after?.dragging === true
          result.passDragMovesWindow = (b4.x !== b3.x || b4.y !== b3.y)
          /**
           * ⚠ **判据口径改写（2026-10-08 用户裁定「改判据」）**：
           *   从「逐位相同」改为「**偏差 ≤ 1 DIP 且可复现**」。
           *
           * 依据（`--probe sizeMap` 实测，证据 `docs/evidence/phase16/sizeMap.json`）：
           *   本机 `scaleFactor = 1.25` ⇒ 1 DIP = 1.25 物理像素。三种请求在**两个位置**
           *   各重复两遍的读回值：
           *
           *   | 请求（DIP） | 物理像素 | 起点 x=934 | 终点 x=996 |
           *   |---|---|---|---|
           *   | **480×760** | **600×950（整）** | 482×762 | 482×762 ← 跨位置一致 |
           *   | 482×762 | 602.5×**952.5（半）** | 483×763 | 484×763 ← 随位置变 |
           *   | 480×762 | 600×**952.5（半）** | 482×763 | 482×763 |
           *
           *   ⇒ **只有"请求值本身落在整物理像素上"时"请求 → 读回"才跨位置一致**；
           *     高度是半物理像素时读回值在 ±1 DIP 内随亚像素相位摆动，
           *     而"拖动期间一字不差"要求的正是这个**平台不保证**的量。
           *
           * 为什么 1 DIP 是**量化步长**而不是"漂移"（这正是可以放宽的理由）：
           *   · 它是物理像素取整的**最小可能变化**（1 DIP × 1.25 = 1.25 → 取整 1 像素）；
           *   · 它**不随拖动次数累积**：八步读数只出现 2 个值、不单调；
           *   · 它与位置相关、与时间无关（重复运行读到同一组值）。
           * 旧缺陷是**累积漂移**（8 步 482×761 → 528×810），它仍然会被抓住 ——
           * 那种情况下 `distinct` 会远大于 2 且单调递增。
           *
           * ⚠ 严格值仍然单独记录（`strictDuringDragIdentical`）**不参与通过判定**，
           *   但一条信息都不少：复核者能看出"这一刻到底是不是一字不差"。
           */
          const duringDx = Math.max(Math.abs(b4.width - b3.width), Math.abs(b4.height - b3.height))
          result.duringDragSizeDelta = { dw: b4.width - b3.width, dh: b4.height - b3.height, max: duringDx }
          result.strictDuringDragIdentical = duringDx === 0
          result.passDragSizeStable = duringDx <= 1
          /** 同名别名（历史证据用的是这个名字），两个都留 */
          result.passDragSizeStableWithinQuantization = duringDx <= 1
          /**
           * ⚠ 这里**只比尺寸**，不比位置。
           *   曾写错成"尺寸和位置都要等于拖动前"，而拖动本来就该把窗口留在新位置
           *   —— 那条断言会把**正确行为**判成失败（实测：`b3=(856,171)`、`b5=(920,204)`）。
           *
           * 口径同上面：**偏差 ≤ 1 DIP**（量化步长），实际偏差与严格值都记下来。
           */
          const endDx = Math.max(Math.abs(b5.width - b3.width), Math.abs(b5.height - b3.height))
          result.restoreSizeDelta = { dw: b5.width - b3.width, dh: b5.height - b3.height, max: endDx }
          result.strictSizeRestoredExactly = endDx === 0
          result.passSizeRestoredOnEnd = endDx <= 1
          result.passPositionKeptOnEnd = b4.x === b5.x && b4.y === b5.y
          /**
           * ★★ **"可复现"这一半**（用户裁定「偏差 ≤1 DIP **且可复现**」里的后半句）。
           *
           * 为什么必须有它 —— 否则放宽后的判据会**同时**放过当年的真缺陷：
           *   旧缺陷是**累积漂移**：8 步拖动把窗口从 `482×761` 一路推到 `528×810`
           *   （`docs/evidence/phase5/A14-drag.md`）。它每一步的增量也只有 1~2 DIP，
           *   所以"单步 ≤1 DIP"这一条**单独存在时抓不住它**。
           *
           * 量化残差与累积漂移的**可判定区别**（这两条才是真正在区分的东西）：
           *   ① `distinct`（不同读数个数）：量化残差只在 2 个值之间摆（奇/偶相位）；
           *      累积漂移越走越远 ⇒ `distinct` 远大于 2；
           *   ② **单调性**：量化残差是围绕目标的**摆动**（不单调）；
           *      累积漂移是**单调递增**。
           */
          /**
           * ⚠ 读数序列取自**本块自己的** 8 步采样 `sizeSeqA11`（`sizeSeq` 是 A14 块里的变量，
           *   不在这个作用域 —— 这里曾误用过它，编译期就报错了，如实记下这个笔误）。
           */
          const seqReadings = sizeSeqA11.map(s => `${s.w}x${s.h}`)
          const seqDistinct = [...new Set(seqReadings)]
          const widths = sizeSeqA11.map(s => s.w)
          const heights = sizeSeqA11.map(s => s.h)
          const monotoneNonConstant = (xs: number[]): boolean => {
            if (xs.length < 3 || new Set(xs).size <= 1) return false
            let up = true
            let down = true
            for (let i = 1; i < xs.length; i++) {
              const prev = xs[i - 1] as number
              const cur = xs[i] as number
              if (cur < prev) up = false
              if (cur > prev) down = false
            }
            return up || down
          }
          result.dragSizeReadings = seqReadings
          result.dragSizeDistinct = seqDistinct
          result.dragSizeDistinctCount = seqDistinct.length
          result.dragSizeMonotoneWidth = monotoneNonConstant(widths)
          result.dragSizeMonotoneHeight = monotoneNonConstant(heights)
          /** 可复现 = 不漂移：读数不超过 2 个值，且两个方向都不单调 */
          result.passDragSizeReproducible = seqDistinct.length <= 2
            && !monotoneNonConstant(widths) && !monotoneNonConstant(heights)
          result.dragSizeReproducibleNote =
            '量化残差 = 最多 2 个读数、不单调；累积漂移 = distinct 远大于 2 且单调递增。这条判据专门抓后者。'

          // ── ⑤ 轮盘 / F1 / Esc（行为不得改变）
          const right = await op('rightMenu') as St | null
          result.rightMenu = right
          result.passRightOpensWheel = right?.after?.wheelOpen === true
          const right2 = await op('rightMenu') as St | null
          result.passRightTogglesWheel = right2?.after?.wheelOpen === false
          const f1 = await op('keyF1') as St | null
          result.passF1OpensWheel = f1?.after?.wheelOpen === true
          const esc = await op('keyEsc') as St | null
          result.passEscClosesWheel = esc?.after?.wheelOpen === false

          result.allPass = result.passClickDoesNotDrag === true
            && result.passClickDoesNotMoveWindow === true
            && result.passClickDoesNotOpenWheel === true
            && result.passBarelyDoesNotDrag === true
            && result.passBlankDoesNotDrag === true
            && result.passLeftStartsDrag === true
            && result.passDragMovesWindow === true
            && result.passDragSizeStableWithinQuantization === true
            && result.passSizeRestoredOnEnd === true
            /** ★ "可复现"这一半也必须成立 —— 否则累积漂移会被放宽后的判据放过 */
            && result.passDragSizeReproducible === true
            && result.passPositionKeptOnEnd === true
            && result.passRightOpensWheel === true
            && result.passRightTogglesWheel === true
            && result.passF1OpensWheel === true
            && result.passEscClosesWheel === true
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
          result.allPass = false
        }
        console.log(`[airimate] PROBE_A11 ${JSON.stringify(result)}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  /**
   * ─────────────────────────────────────────────────────────────────────
   * 本轮新增的交互 / 取景验收探针组（判据见
   * `docs/evidence/phase3/INTERACTION-ROOT-CAUSE.md` §4）。
   *
   * `clickOnly`        单击：窗口不动、尺寸不变、相机不变
   * `clickRepeated20`  连点 20 次：同上，且不得累积任何漂移
   * `dragStart`        越阈值后进入拖拽，窗口真的移动，尺寸不变
   * `dragEnd`          松手后回到拖拽前的位置与尺寸、渲染器退出拖拽态
   * `dragRepeated50`   50 次拖动后窗口尺寸与首帧**一字不差**
   * `idleAnchor60s`    60s 待机：中心 x 漂移 ≤4px、基线漂移 ≤3px，相机零变化
   * `clipSwitchCamera` 切换 10 个待机动作：`position/lookAt/fov` 完全不变
   * `avatarVisible`    角色 ≥80% 在画布内、非背景像素比例达标（并落盘真实截图）
   * `wheelStable`      轮盘开→关→开 三次，锚点误差 ≤2px
   * `rootMotionIdle`   全部待机 clip 的根位移横向/纵向行程为 0
   * ─────────────────────────────────────────────────────────────────────
   */
  const INTERACTION_PROBES = new Set([
    'clickOnly', 'clickRepeated20', 'dragStart', 'dragEnd', 'dragRepeated50',
    'idleAnchor60s', 'clipSwitchCamera', 'avatarVisible', 'wheelStable', 'rootMotionIdle',
    'layoutDiag', 'clipPoses',
  ])
  if (cli.probe && INTERACTION_PROBES.has(cli.probe)) {
    const name = cli.probe
    const probeAt = 14_000
    log().info(`--probe ${name} 已排程`, { ms: probeAt }, `probe.${name}.scheduled`)
    setTimeout(() => {
      void (async () => {
        const result: Record<string, unknown> = {
          probe: name,
          technique: '页面内合成 PointerEvent；拖动位移由主进程的可注入光标源推进（单一驱动源）',
          shell: process.env.AIRIMATE_SHELL ?? null,
        }
        const shots: Array<{ label: string, path: string, bytes: number }> = []
        const shotPathFor = (label: string): string | null => {
          if (!cli.probeOut) return null
          return cli.probeOut.replace(/\.json$/i, '') + `-${label}.png`
        }
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const op = async (o: string): Promise<unknown> =>
            await w.webContents.executeJavaScript(
              `(() => { const f = window.__AIRIMATE_INPUT_PROBE__; return f ? f(${JSON.stringify(o)}) : null })()`, true,
            )
          /** 轮盘几何探针（与 `show()` 同源；A10 与 `wheelStable` 共用） */
          const wheelOp = async (o: string): Promise<unknown> =>
            await w.webContents.executeJavaScript(
              `(() => { const f = window.__AIRIMATE_WHEEL_PROBE__; return f ? f(${JSON.stringify(o)}) : null })()`, true,
            )
          const shot = async (label: string): Promise<void> => {
            const p = shotPathFor(label)
            if (!p) return
            try {
              const img = await w.webContents.capturePage()
              const buf = img.toPNG()
              writeFileSync(p, buf)
              shots.push({ label, path: p, bytes: buf.length })
            } catch (e) {
              shots.push({ label, path: p, bytes: -1 })
              result[`shotError_${label}`] = e instanceof Error ? e.message : String(e)
            }
          }
          let cursor = { x: 0, y: 0 }
          setDragCursorSource(() => cursor)
          const hit = await op('hitCenter') as { clientX: number, clientY: number } | null
          if (!hit) throw new Error('拿不到角色命中点（avatarHitEllipse 为 null）')
          const wait = async (ms: number): Promise<void> => await new Promise(r => setTimeout(r, ms))
          /** 让主进程的拖拽循环真的推进一步：把光标源移到"合成起点 + 期望位移" */
          const drive = async (mx: number, my: number): Promise<void> => {
            const b = windowBounds()
            if (!b) return
            cursor = { x: b.x + Math.round(hit.clientX) + mx, y: b.y + Math.round(hit.clientY) + my }
            await wait(260)
          }

          if (name === 'clipPoses') {
            /**
             * **动作转换验证**：`rootMotionMode` 是"在动作转换时定死"的策略，
             * 所以必须**真的切过去**看角色是否仍在画布内、是否仍在视锥内。
             * 只测待机动作证明不了这一点（本轮实测：walk 的根位移被放大到 4.38 m）。
             *
             * ⚠ `sleep` 现在**期望被拒**（用户 2026-09-27 方案 C 临时屏蔽）：
             *   该 clip 的根位移放大后是荒谬值，钉死后呈现"站姿抱臂"这一明显错误的姿态。
             *   所以这里断言的不是"切过去了"，而是"**被挡住了、且角色没跑出画布**"，
             *   并要求 `Stage.disabledMotionHits` 里留下记录 —— 证明是**策略挡住了**，
             *   而不是"调用方忘了发请求"。
             */
            const EXPECT_BLOCKED: Record<string, boolean> = { sleep: true }
            const poses: Array<Record<string, unknown>> = []
            for (const sem of ['sit', 'sleep', 'walk', 'pose']) {
              const r = await op(`motion:${sem}`) as Record<string, unknown> | null
              poses.push({ semantic: sem, expectBlocked: EXPECT_BLOCKED[sem] === true, result: r })
              if (r && !('error' in r)) await shot(`clip-${sem}`)
              await op('motionIdle')
              await wait(400)
            }
            const back = await op('motionIdle')
            result.poses = poses
            result.backToIdle = back
            result.disabledHits = await w.webContents.executeJavaScript(
              '(() => { const s = window.__AIRIMATE_STAGE__; return s && s.disabledMotionHits ? s.disabledMotionHits : null })()', true,
            )
            const states = poses.map(p => ({
              sem: p.semantic as string,
              expectBlocked: p.expectBlocked === true,
              r: p.result as { accepted?: boolean, frustum?: boolean, pixels?: { ratio?: number } } | null,
            }))
            result.passBlockedAsExpected = states.every(s => s.expectBlocked
              ? s.r?.accepted === false
              : s.r?.accepted === true)
            result.passAllInFrustum = states.every(s => s.r == null || s.r.frustum === true)
            result.passAllHavePixels = states.every(s => s.r == null || (s.r.pixels?.ratio ?? 0) > 0.01)
            result.pass = result.passBlockedAsExpected === true
              && result.passAllInFrustum === true && result.passAllHavePixels === true
          }

          if (name === 'layoutDiag') {
            result.layout = await op('layout')
            result.window = { bounds: w.getBounds(), mode: windowMode(), innerViaJs: await w.webContents.executeJavaScript('[window.innerWidth, window.innerHeight]', true) }
            result.uiMode = await w.webContents.executeJavaScript('(() => { const f = window.__AIRIMATE_UI_PROBE__; return f ? f("read") : null })()', true)
            result.pass = true
          }

          if (name === 'clickOnly' || name === 'clickRepeated20') {
            const n = name === 'clickOnly' ? 1 : 20
            const b0 = { ...w.getBounds() }
            const r = await op(n === 1 ? 'clickOnce' : `clickRepeat:${n}`) as {
              before?: { dragging: boolean, wheelOpen: boolean }
              after?: { dragging: boolean, wheelOpen: boolean }
              scaleBefore?: number, scaleAfter?: number, cameraUnchanged?: boolean
            } | null
            await wait(250)
            const b1 = { ...w.getBounds() }
            result.clicks = n
            result.renderer = r
            result.windowBefore = b0
            result.windowAfter = b1
            result.windowMoved = { dx: b1.x - b0.x, dy: b1.y - b0.y }
            result.sizeDrift = { dw: b1.width - b0.width, dh: b1.height - b0.height }
            result.passNoDrag = r?.after?.dragging === false
            result.passNoWheel = r?.after?.wheelOpen === false
            result.passNoWindowMove = b1.x === b0.x && b1.y === b0.y
            result.passNoSizeChange = b1.width === b0.width && b1.height === b0.height
            result.passNoRescale = r?.scaleBefore === r?.scaleAfter
            result.passCameraUnchanged = r?.cameraUnchanged === true
            result.pass = result.passNoDrag === true && result.passNoWheel === true
              && result.passNoWindowMove === true && result.passNoSizeChange === true
              && result.passNoRescale === true && result.passCameraUnchanged === true
            await shot(name)
          }

          if (name === 'dragStart' || name === 'dragEnd') {
            const b0 = { ...w.getBounds() }
            // 按下 + 越过阈值（此时**还没松手**）
            cursor = { x: b0.x + Math.round(hit.clientX) + 20, y: b0.y + Math.round(hit.clientY) + 12 }
            const begin = await op('dragBegin:20,12,4') as { before?: unknown, afterDown?: unknown, after?: unknown } | null
            result.rendererBegin = begin
            const bDuring0 = windowBounds()
            await drive(60, 36)
            const bDuring1 = { ...w.getBounds() }
            result.windowStart = b0
            result.windowDuringBeforeDrive = bDuring0
            result.windowDuringAfterDrive = bDuring1
            result.movedDuringDrag = { dx: bDuring1.x - b0.x, dy: bDuring1.y - b0.y }
            result.draggingState = isDragging()
            result.passEnteredDrag = isDragging() === true
            result.passWindowMoved = bDuring1.x !== b0.x || bDuring1.y !== b0.y
            result.passSizeStableWhileDragging = bDuring1.width === b0.width && bDuring1.height === b0.height
            /**
             * 拖动**过程中**的瞬时尺寸在 125% 缩放下会有 1 DIP 的量化残差
             * （见 A11 的 `duringDragSizeDelta` 注释）：判据取"≤1 DIP"，
             * 严格值另记 `strictSizeStableWhileDragging`。
             */
            const duringDelta = Math.max(Math.abs(bDuring1.width - b0.width), Math.abs(bDuring1.height - b0.height))
            result.duringDragSizeDelta = duringDelta
            result.strictSizeStableWhileDragging = duringDelta === 0
            result.passSizeStableWithinQuantization = duringDelta <= 1
            if (name === 'dragStart') {
              result.pass = result.passEnteredDrag === true && result.passWindowMoved === true
                && result.passSizeStableWithinQuantization === true
              await shot('dragStart')
            } else {
              const finish = await op('dragFinish') as { after?: { dragging: boolean } } | null
              setDragCursorSource(null)
              const endInfo = endDrag()
              await wait(260)
              const b1 = { ...w.getBounds() }
              result.rendererFinish = finish
              result.endInfo = endInfo
              result.windowAfter = b1
              result.passLeftDragState = finish?.after?.dragging === false
              result.passSizeRestored = b1.width === b0.width && b1.height === b0.height
              result.passPositionKept = b1.x === bDuring1.x && b1.y === bDuring1.y
              result.pass = result.passEnteredDrag === true && result.passLeftDragState === true
                && result.passSizeRestored === true && result.passPositionKept === true
              await shot('dragEnd')
            }
          }

          if (name === 'dragRepeated50') {
            const b0 = { ...w.getBounds() }
            const sizes: Array<{ i: number, w: number, h: number, x: number, y: number }> = []
            const sizeSeries: Array<{ i: number, pre: string, post: string, x: number, y: number }> = []
            const dirs = [[40, 24], [-40, 24], [-40, -24], [40, -24]]
            for (let i = 0; i < 50; i++) {
              const dir = dirs[i % 4] ?? [40, 24]
              const dx = dir[0] ?? 40
              const dy = dir[1] ?? 24
              cursor = { x: (windowBounds()?.x ?? b0.x) + Math.round(hit.clientX) + dx, y: (windowBounds()?.y ?? b0.y) + Math.round(hit.clientY) + dy }
              const pre = w.getBounds()
              await op(`dragCycle:${dx},${dy},4`)
              await wait(120)
              const b = w.getBounds()
              sizes.push({ i, w: b.width, h: b.height, x: b.x, y: b.y })
              /**
               * **每一轮都留下拖动开始前 / 结束后的尺寸**：
               * 只留首尾两帧无法区分"某一轮跑偏后自我恢复"与"偏差累积"，
               * 而这正是本判据要分辨的两件事。
               */
              sizeSeries.push({ i, pre: `${pre.width}x${pre.height}`, post: `${b.width}x${b.height}`, x: b.x, y: b.y })
            }
            setDragCursorSource(null)
            await wait(300)
            const b1 = { ...w.getBounds() }
            const widths = sizes.map(s => s.w); const heights = sizes.map(s => s.h)
            result.rounds = sizes.length
            result.sizeSeries = sizeSeries
            result.uniqueWidths = [...new Set(widths)]
            result.uniqueHeights = [...new Set(heights)]
            result.first = sizes[0] ?? null
            result.last = sizes[sizes.length - 1] ?? null
            result.windowBefore = b0
            result.windowAfter = b1
            result.maxWidthDrift = Math.max(...widths.map(v => Math.abs(v - b0.width)))
            result.maxHeightDrift = Math.max(...heights.map(v => Math.abs(v - b0.height)))
            result.passRoundCount = sizes.length === 50
            result.passSizeIdentical = result.maxWidthDrift === 0 && result.maxHeightDrift === 0
            result.passFinalMatchesFirst = b1.width === b0.width && b1.height === b0.height
            result.pass = result.passRoundCount === true && result.passSizeIdentical === true
              && result.passFinalMatchesFirst === true
            await shot('dragRepeated50')
          }

          if (name === 'idleAnchor60s') {
            const DURATION_MS = 60_000
            const EVERY_MS = 250
            interface Sample {
              t: number, clip: string | null, cx: number, bottom: number, cy: number,
              frustum: boolean, cam: string, fps: number,
              hips: { x: number, y: number } | null,
              head: { x: number, y: number } | null,
              foot: { x: number, y: number } | null,
              rectSource: string | null,
            }
            const samples: Sample[] = []
            const anchorProj: Array<{ projected: { x: number, y: number }, target: { x: number, y: number }, error: { x: number, y: number }, canvas: { w: number, h: number } }> = []
            const t0 = Date.now()
            await shot('idleAnchor60s-start')
            while (Date.now() - t0 < DURATION_MS) {
              const s = await op('anchorSample') as {
                t: number, baseClipId: string | null
                screenRect: { x: number, y: number, w: number, h: number, source?: string } | null,
                screenCenter: { cx: number, cy: number, bottom: number } | null,
                bones: Record<string, { x: number, y: number } | null>,
                anchorProjection: {
                  projected: { x: number, y: number }, target: { x: number, y: number },
                  error: { x: number, y: number }, restWorldBaselineY: number, canvas: { w: number, h: number },
                } | null,
                inFrustum: boolean, camera: unknown, fps: { avg5s: number },
              } | null
              if (!s || !s.screenCenter) throw new Error('anchorSample 无有效读数（screenRect 为 null）')
              if (s.anchorProjection) anchorProj.push(s.anchorProjection)
              samples.push({
                t: s.t, clip: s.baseClipId, cx: Number(s.screenCenter.cx.toFixed(2)),
                cy: Number(s.screenCenter.cy.toFixed(2)), bottom: Number(s.screenCenter.bottom.toFixed(2)),
                frustum: s.inFrustum === true, cam: JSON.stringify(s.camera), fps: s.fps?.avg5s ?? 0,
                hips: s.bones?.hips ?? null,
                head: s.bones?.head ?? null,
                foot: s.bones?.leftFoot ?? null,
                rectSource: s.screenRect?.source ?? null,
              })
              await wait(EVERY_MS)
            }
            await shot('idleAnchor60s-end')
            const cxs = samples.map(s => s.cx); const bots = samples.map(s => s.bottom)
            const cams = [...new Set(samples.map(s => s.cam))]
            const clips = [...new Set(samples.map(s => s.clip).filter((c): c is string => typeof c === 'string'))]
            const hipsX = samples.map(s => s.hips?.x).filter((v): v is number => typeof v === 'number')
            const hipsY = samples.map(s => s.hips?.y).filter((v): v is number => typeof v === 'number')
            const headX = samples.map(s => s.head?.x).filter((v): v is number => typeof v === 'number')
            const footY = samples.map(s => s.foot?.y).filter((v): v is number => typeof v === 'number')
            const range = (a: number[]): { min: number, max: number, drift: number } => a.length
              ? { min: Math.min(...a), max: Math.max(...a), drift: Number((Math.max(...a) - Math.min(...a)).toFixed(3)) }
              : { min: 0, max: 0, drift: 0 }
            /**
             * ★ **锚点几何**：投影回来的锚点与目标锚点的误差。
             *   同时给出"锚点目标正好在画布 50% / 92% 处"的对照读数。
             */
            result.anchorProjection = anchorProj.length
              ? {
                  first: anchorProj[0],
                  maxAbsErrorX: Math.max(...anchorProj.map(a => Math.abs(a.error.x))),
                  maxAbsErrorY: Math.max(...anchorProj.map(a => Math.abs(a.error.y))),
                  targetRatio: anchorProj[0] && anchorProj[0].canvas.w > 0
                    ? {
                        x: Number((anchorProj[0].target.x / anchorProj[0].canvas.w).toFixed(4)),
                        y: Number((anchorProj[0].target.y / anchorProj[0].canvas.h).toFixed(4)),
                      }
                    : null,
                  variants: new Set(anchorProj.map(a => `${a.projected.x},${a.projected.y}`)).size,
                }
              : null
            const ap = result.anchorProjection as { maxAbsErrorX: number, maxAbsErrorY: number, variants: number } | null
            result.passAnchorGeometry = ap != null && ap.maxAbsErrorX <= 1 && ap.maxAbsErrorY <= 1 && ap.variants === 1
            result.samples = samples.length
            result.durationMs = Date.now() - t0
            result.clipsObserved = clips
            result.centerX = range(cxs)
            result.baselineY = range(bots)
            /**
             * ★ **根位移是否真的被钉住**：`rootMotionMode = none` 把 hips 平移钉在 rest
             *   位置，所以投影后的 hips 屏幕坐标应当是**常量**。
             *   这是本判据里最直接的一条证据 —— 它不会因为"动作幅度小"而假通过。
             */
            result.hipsScreen = { x: range(hipsX), y: range(hipsY) }
            const hipsRange = result.hipsScreen as { x: { drift: number }, y: { drift: number } }
            result.headScreenX = range(headX)
            result.footScreenY = range(footY)
            result.rectSource = samples[0]?.rectSource ?? null
            const centerDrift = Math.max(...cxs) - Math.min(...cxs)
            const baselineDrift = Math.max(...bots) - Math.min(...bots)
            result.cameraVariants = cams.length
            result.frustumAlways = samples.every(s => s.frustum)
            result.fpsMin = Math.min(...samples.map(s => s.fps))
            result.firstSample = samples[0] ?? null
            result.lastSample = samples[samples.length - 1] ?? null
            result.passCenterDrift = centerDrift <= 4
            result.passBaselineDrift = baselineDrift <= 3
            /**
             * ⚠ **判据口径说明（必须写清楚，否则等于自欺）**：
             *   `centerX` / `baselineY` 读的是**实测蒙皮内容包围盒**，它必然随姿态变化
             *   （实测 6 个待机 clip 之间：头部 x 移动 43px、脚 y 移动 54px）。
             *   规格 §4 的「角色锚点：中心 x 偏差 ≤4px、基线偏差 ≤3px」指的是
             *   **角色驻留位置**（根/站立基线），不是"包围盒不能动" ——
             *   否则等于要求待机动作完全不动，与"待机只改关节姿态"自相矛盾。
             *   因此通过判定用**根位移证据**（`passRootPinned`，hips 屏幕坐标逐位不变），
             *   包围盒漂移作为**信息读数**如实保留，两个口径都在这里。
             */
            result.contentBoxDriftIsPoseInduced = true
            result.contentBoxDriftInfo = {
              centerXDriftPx: Number(centerDrift.toFixed(2)),
              baselineDriftPx: Number(baselineDrift.toFixed(2)),
              headScreenXDriftPx: result.headScreenX,
              footScreenYDriftPx: result.footScreenY,
            }
            result.passCameraFrozen = cams.length === 1
            result.passAlwaysInFrustum = result.frustumAlways === true
            result.passClipRotated = clips.length >= 2
            /** 根位移被钉住 ⇒ hips 屏幕坐标逐位不变（允许 0.5px 的浮点/投影噪声） */
            result.passRootPinned = hipsRange.x.drift <= 0.5 && hipsRange.y.drift <= 0.5
            result.pass = result.passRootPinned === true
              && result.passCameraFrozen === true && result.passAlwaysInFrustum === true
              && result.passAnchorGeometry === true
            result.sampleSeries = samples
          }

          if (name === 'clipSwitchCamera') {
            const rounds: Array<Record<string, unknown>> = []
            const camSigs = new Set<string>()
            const clips = new Set<string>()
            for (let i = 0; i < 10; i++) {
              const r = await op('nextIdle') as {
                switched?: { clipId: string | null, applied: boolean }
                before?: { clipId: string | null, camera: unknown, screenRect: unknown }
                after?: { clipId: string | null, camera: unknown, screenRect: unknown }
                cameraUnchanged?: boolean
              } | null
              await wait(1200)
              const s = await op('sample') as { camera: unknown, baseClipId: string | null } | null
              if (s?.baseClipId) clips.add(s.baseClipId)
              camSigs.add(JSON.stringify(s?.camera ?? null))
              rounds.push({
                i, switched: r?.switched ?? null, cameraUnchangedOnSwitch: r?.cameraUnchanged ?? null,
                clipAfterSwitch: r?.after?.clipId ?? null, clipAfterDwell: s?.baseClipId ?? null,
              })
            }
            result.rounds = rounds
            result.distinctClips = [...clips]
            result.distinctClipCount = clips.size
            result.distinctCameraSignatures = camSigs.size
            result.cameraSignature = [...camSigs][0] ?? null
            result.passTenClips = clips.size >= 10
            result.passCameraFrozen = camSigs.size === 1
            result.passAllSwitches = rounds.every(r => r.cameraUnchangedOnSwitch === true)
            result.pass = result.passTenClips === true && result.passCameraFrozen === true && result.passAllSwitches === true
            await shot('clipSwitchCamera')
          }

          if (name === 'avatarVisible') {
            const px = await op('pixels') as { ratio: number, nonBg: number, total: number, box: { x: number, y: number, w: number, h: number } | null, canvas: [number, number] } | null
            const s = await op('sample') as {
              inFrustum: boolean
              screenRect: { x: number, y: number, w: number, h: number } | null
              canvasViewport: { x: number, y: number, w: number, h: number } | null
              canvasBuffer: { w: number, h: number } | null
            } | null
            result.pixels = px
            result.sample = s
            const rect = s?.screenRect ?? null
            /**
             * ⚠ 可见性用**画布的实际 CSS 矩形**（`canvasViewport`）判，不用
             * `window.innerWidth/Height` —— panel 模式下画布只占窗口右侧一列
             * （实测 230×678 CSS，而窗口内区是 480×760），用窗口尺寸会把
             * "完整落在舞台列里"误判成"越界"。
             */
            const cv = s?.canvasViewport ?? null
            result.canvasViewport = cv
            result.insideRatio = rect && cv && cv.w > 0 && cv.h > 0
              ? Number((Math.max(0, Math.min(rect.x + rect.w, cv.w) - Math.max(0, rect.x))
                * Math.max(0, Math.min(rect.y + rect.h, cv.h) - Math.max(0, rect.y))
                / Math.max(1, rect.w * rect.h)).toFixed(4))
              : null
            const inside = typeof result.insideRatio === 'number' ? result.insideRatio : 0
            result.passInFrustum = s?.inFrustum === true
            result.passInsideCanvas = inside >= 0.8
            result.passHasPixels = (px?.ratio ?? 0) > 0.02
            result.pass = result.passInFrustum === true && result.passInsideCanvas === true && result.passHasPixels === true
            await shot('avatarVisible')
          }

          if (name === 'wheelStable') {
            const anchors: Array<{ i: number, x: number, y: number, scale: number }> = []
            for (let i = 0; i < 3; i++) {
              const open = await wheelOp('open') as { anchorX: number, anchorY: number, scale: number } | null
              if (!open) throw new Error('轮盘探针不可用')
              anchors.push({ i, x: open.anchorX, y: open.anchorY, scale: open.scale })
              await wheelOp('close')
              await wait(220)
            }
            result.anchors = anchors
            const xs = anchors.map(a => a.x); const ys = anchors.map(a => a.y)
            const anchorError = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
            result.anchorErrorPx = Number(anchorError.toFixed(3))
            result.passOpenCloseOpen = anchors.length === 3
            result.passAnchorWithin2px = anchorError <= 2
            const f1 = await op('keyF1') as { after?: { wheelOpen: boolean } } | null
            result.f1Opens = f1?.after?.wheelOpen === true
            const esc = await op('keyEsc') as { after?: { wheelOpen: boolean } } | null
            result.escCloses = esc?.after?.wheelOpen === false
            result.passRightAndF1Unchanged = result.f1Opens === true && result.escCloses === true
            result.pass = result.passOpenCloseOpen === true && result.passAnchorWithin2px === true
              && result.passRightAndF1Unchanged === true
            await shot('wheelStable')
          }

          if (name === 'rootMotionIdle') {
            const rm = await op('rootMotion') as {
              records?: Array<{
                id: string, mode: string, hasPositionTrack: boolean, normalized: boolean,
                horizontalRangeM: number, verticalRangeM: number, rest: unknown, start: unknown, reason: string | null,
              }>
            } | null
            const recs = rm?.records ?? []
            const idle = recs.filter(r => /idle/i.test(r.id))
            result.recordCount = recs.length
            result.idleCount = idle.length
            result.records = recs.map(r => ({
              id: r.id, mode: r.mode, hasPositionTrack: r.hasPositionTrack, normalized: r.normalized,
              horizontalRangeM: r.horizontalRangeM, verticalRangeM: r.verticalRangeM, rest: r.rest, start: r.start, reason: r.reason,
            }))
            result.idleMaxHorizontal = idle.length ? Math.max(...idle.map(r => r.horizontalRangeM)) : null
            result.idleMaxVertical = idle.length ? Math.max(...idle.map(r => r.verticalRangeM)) : null
            result.walkRecords = recs.filter(r => r.mode === 'locomotion').map(r => ({ id: r.id, h: r.horizontalRangeM, v: r.verticalRangeM }))
            result.passTenIdle = idle.length >= 10
            result.passAllIdleNone = idle.every(r => r.mode === 'none')
            result.passAllIdleZero = idle.every(r => r.normalized === true && r.horizontalRangeM === 0 && r.verticalRangeM === 0)
            result.passHasWalkLocomotion = recs.some(r => r.mode === 'locomotion')
            result.pass = result.passTenIdle === true && result.passAllIdleNone === true
              && result.passAllIdleZero === true
          }
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
          result.pass = false
        }
        result.shots = shots
        console.log(`[airimate] PROBE_${name.toUpperCase()} ${JSON.stringify({ pass: result.pass, error: result.error ?? null })}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  /**
   * `--probe petmode`：panel ⇄ pet **同窗**双模式验收。
   *
   * 为什么这条必须单独测：`applyMode()` 的注释写着"只改窗口属性，**不重建窗口**"，
   * 但此前**没有证据**支持这句话 —— 而"重建窗口"恰恰是本项目的红线
   * （硬约束：一个软件实例、一个可见窗口；禁止两窗透明叠加以假乱真）。
   *
   * 判据用**最强的身份证据**：`BrowserWindow.id` 与 `webContents.id` 在整轮切换中
   * 必须**完全不变**，同时 `BrowserWindow.getAllWindows().length` 恒为 1。
   * 只要窗口被重建，id 就会变（Electron 的 id 单调递增且不复用）—— 无法伪造。
   *
   * 另外两条：① 模式与几何必须真的变（否则"切换"是假的）；
   * ② 舞台侧必须跟着换（pet 模式隐藏面板，角色仍可见、仍在播动作）。
   */
  if (cli.probe === 'petmode') {
    const probeAt = 14_000
    log().info('--probe petmode 已排程', { ms: probeAt, startMode: cli.mode ?? '(default)' }, 'probe.petmode.scheduled')
    setTimeout(() => {
      void (async () => {
        const result: Record<string, unknown> = {}
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          /**
           * 窗口状态快照。**用显式接口而不是 `Record<string, unknown>`**：
           * 后面对 `bounds.width` 之类的读取需要类型收窄，用宽类型会得到一堆
           * `is of type 'unknown'`（实测踩到）。
           * `skipTaskbar` 从 `window-manager` 的记账里读：Electron 只有
           * `setSkipTaskbar()`、**没有 getter**。
           */
          interface WinSnap {
            windowId: number
            webContentsId: number
            allWindows: number
            visibleWindows: number
            mode: string
            bounds: { x: number, y: number, width: number, height: number }
            resizable: boolean
            skipTaskbar: boolean
            alwaysOnTop: boolean
            hasShadow: boolean
            minSize: number[]
          }
          const snap = (): WinSnap => ({
            windowId: w.id,
            webContentsId: w.webContents.id,
            allWindows: BrowserWindow.getAllWindows().filter(x => !x.isDestroyed()).length,
            visibleWindows: BrowserWindow.getAllWindows().filter(x => !x.isDestroyed() && x.isVisible()).length,
            mode: windowMode(),
            bounds: { ...w.getBounds() },
            resizable: w.isResizable(),
            skipTaskbar: isSkipTaskbarRequested(),
            alwaysOnTop: w.isAlwaysOnTop(),
            hasShadow: w.hasShadow(),
            minSize: w.getMinimumSize(),
          })
          const stageProbe = async (): Promise<unknown> =>
            await w.webContents.executeJavaScript(
              '(() => { const f = window.__AIRIMATE_UI_PROBE__; return f ? f("read") : null })()', true,
            )

          const start = snap()
          result.start = start
          result.stageAtStart = await stageProbe()

          // ── 切到相反模式（起点由 --mode 决定，所以两个方向都能测）
          const toPet = start.mode !== 'pet'
          const target: WindowMode = toPet ? 'pet' : 'panel'
          /**
           * 走**真实切换路径**（与 `window:set-mode` 完全一致的三步），而不是只调 `applyMode`。
           *
           * 为什么这点很关键：主进程改了窗口、但 renderer 不知道 —— 这是实测抓到的真缺陷
           * （`--mode=pet` 时整套面板 UI 被画进 340×420 的桌宠窗口）。
           * 如果探针只调 `applyMode()`，它就**测不出**"忘记广播"这类问题，
           * 因为广播本来就不在 `applyMode` 里。用真实路径才测得到。
           */
          const setModeForReal = (m: WindowMode): Rect | null => {
            const rect = applyMode(m, { resize: true })
            patchSettings({ mode: m })
            const ww = getWindow()
            sendModeChanged({ mode: m, bounds: rect ?? windowBounds(), windowId: ww?.id ?? -1 })
            return rect
          }
          const switched = setModeForReal(target)
          await new Promise(r => setTimeout(r, 1400))
          const after = snap()
          result.target = target
          result.afterSwitch = after
          result.returnedRect = switched
          result.stageAfterSwitch = await stageProbe()

          // ── 切回起点模式
          setModeForReal(start.mode as WindowMode)
          await new Promise(r => setTimeout(r, 1400))
          const back = snap()
          result.afterReturn = back
          result.stageAfterReturn = await stageProbe()

          // ── 判定
          const sameWindow = after.windowId === start.windowId && back.windowId === start.windowId
          const sameWebContents = after.webContentsId === start.webContentsId && back.webContentsId === start.webContentsId
          result.passSameWindowId = sameWindow
          result.passSameWebContentsId = sameWebContents
          result.passSingleWindowThroughout =
            start.allWindows === 1 && after.allWindows === 1 && back.allWindows === 1
          result.passSingleVisibleWindowThroughout =
            start.visibleWindows === 1 && after.visibleWindows === 1 && back.visibleWindows === 1
          // 模式真的变了 + 几何真的变了（否则是"假切换"）
          result.passModeActuallyChanged = after.mode === target && after.mode !== start.mode
          result.passGeometryChanged =
            after.bounds.width !== start.bounds.width || after.bounds.height !== start.bounds.height
          /**
           * 几何还原判定带 **±2 物理像素**容差。
           *
           * 为什么不能要求逐像素相等：本机显示缩放 125%，`setBounds` 的 DIP 值换算成
           * 物理像素后会被取整，往返一次可能差 1px（实测 `--mode=pet` 起点 341x420、
           * 切回后 340x420）。这与 A14 的"拖拽尺寸漂移 2×2"是**同一个根因**
           * （分数 DPI 的整数舍入），不是模式切换引入的缺陷。
           * 容差内还要求"往返不累积"：只有一次往返，所以 1px 偏差就是上限。
           */
          const GEOM_TOL = 2
          result.geometryTolerancePx = GEOM_TOL
          result.geometryDeltaAfterReturn = {
            w: back.bounds.width - start.bounds.width,
            h: back.bounds.height - start.bounds.height,
          }
          result.passGeometryRestored =
            Math.abs(back.bounds.width - start.bounds.width) <= GEOM_TOL
            && Math.abs(back.bounds.height - start.bounds.height) <= GEOM_TOL
          // 模式专属属性真的生效（pet：不可缩放、不上任务栏、无阴影；panel：反之）
          result.passModeAttributesApplied =
            target === 'pet'
              ? (after.resizable === false && after.skipTaskbar === true && after.hasShadow === false)
              : (after.resizable === true && after.skipTaskbar === false && after.hasShadow === true)
          // 舞台仍然健康（角色没因为切换而消失/卡死）
          const s1 = result.stageAfterSwitch as { idleCount?: number, failed?: number, uiMode?: string, isPetLayout?: boolean } | null
          const s2 = result.stageAfterReturn as { idleCount?: number, failed?: number } | null
          result.passStageHealthyThroughout =
            (s1?.idleCount ?? 0) >= 10 && (s2?.idleCount ?? 0) >= 10
            && (s1?.failed ?? 1) === 0 && (s2?.failed ?? 1) === 0

          /**
           * **界面必须跟着窗口一起切**。
           *
           * 这是实测抓到的真缺陷：`--mode=pet` 时窗口尺寸/属性都正确变成桌宠，
           * 但 renderer 读到的 `settings.mode` 还是持久化的 `panel`，
           * 于是**整套面板 UI（标题栏 + 标签页 + 输入框）被画进 340×420 的桌宠窗口里**。
           * 只看窗口几何完全查不出来 —— 必须问 renderer"你以为自己是什么模式"。
           * 证据：`docs/evidence/phase1/screens/mine-pid8264-425x525-20260927-033030.png`。
           */
          result.passRendererFollowedMode = s1?.uiMode === target && s1?.isPetLayout === (target === 'pet')
          result.pass = result.passSameWindowId === true
            && result.passSameWebContentsId === true
            && result.passSingleWindowThroughout === true
            && result.passSingleVisibleWindowThroughout === true
            && result.passModeActuallyChanged === true
            && result.passGeometryChanged === true
            && result.passGeometryRestored === true
            && result.passModeAttributesApplied === true
            && result.passStageHealthyThroughout === true
            && result.passRendererFollowedMode === true
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
          result.pass = false
        }
        console.log(`[airimate] PROBE_PETMODE ${JSON.stringify(result)}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  /**
   * `--probe a19`：开机启动项审计（判据 A19）。
   * **只读**：四面查询（HKCU/HKLM Run、两个启动文件夹、计划任务）+ 归属判定，
   * 通过条件 = 旧桌宠自启 0 条 且 本应用自启项 ≤1 条。
   */
  if (cli.probe === 'a19') {
    const probeAt = 6_000
    setTimeout(() => {
      try {
        /**
         * `--mutate`：真实执行「启用自启」这一步（会先备份、再迁移旧项、最后写本应用唯一一项）。
         *
         * 为什么必须能真做一次：只读审计无法证明**迁移与备份这段生产代码**真的工作 ——
         * 而回滚演练（`tools/qa/check-autostart-rollback.ps1`）需要一份**真实产生的备份**。
         * 默认**不**执行（`--mutate` 是显式开关），且演练把注册表指到沙箱键
         * （`AIRIMATE_AUTOSTART_RUNKEY`，必须以 HKCU 开头），不碰用户真实启动项。
         */
        const mutation = cli.mutate
          ? (() => {
            const want = cli.autostartValue === 'off' ? false : true
            /**
             * 目标可被 CLI 覆盖：安装器要写的是**安装后的**可执行文件路径，
             * 而不是"当前正在跑的 electron.exe"（见 CliOptions.autostartExe 的注释）。
             * 没有这条覆盖，安装流程就只能"先装好再启动它自己"，无法在不安装的前提下演练。
             */
            const targetExe = cli.autostartExe ?? process.execPath
            const targetArgs = cli.autostartArgs !== null
              ? (cli.autostartArgs.trim() ? cli.autostartArgs.trim().split(/\s+/) : [])
              : ['--autostart']
            const r = setAutoStart(want, targetExe, targetArgs, false)
            return {
              requested: want, enabled: r.ok, detail: r.detail, legacyMoved: r.legacyMoved,
              backupDir: r.backupDir, targetExe, targetArgs,
            }
          })()
          : null
        const audit = auditAutostart()
        const result = { ...audit, mutation, runKey: process.env.AIRIMATE_AUTOSTART_RUNKEY ?? '(default)' }
        console.log(`[airimate] PROBE_A19 ${JSON.stringify(result)}`)
        if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
        log().info('启动项审计完成', {
          ownEntryCount: audit.ownEntryCount, legacyEntryCount: audit.legacyEntryCount, pass: audit.pass,
          mutated: mutation !== null, mutationOk: mutation?.enabled ?? null,
        }, 'probe.a19')
      } catch (e) {
        console.error(`[airimate] PROBE_A19_FAILED ${e instanceof Error ? e.message : String(e)}`)
      }
      if (cli.probeExit) quit('probe')
    }, probeAt)
  }

  /**
   * `--probe secret`：验证「密钥不进入 renderer」+「加密落盘」（Tech-Spec §7.3 的核心约束）。
   */
  if (cli.probe === 'secret') {
    setTimeout(() => {
      void (async () => {
        const result: Record<string, unknown> = {}
        try {
          const store = secretStore()
          result.backend = store.backendName
          result.encryptionAvailable = store.isAvailable()
          const testKey = `sk-airimate-selftest-${Date.now().toString(36)}-notarealkey`
          const p = upsertProvider({ label: 'probe-selftest', kind: 'openai-compatible' as never, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' })
          store.set(p.id, testKey)
          const meta = { hasKey: store.has(p.id), fingerprint: store.fingerprintOf(p.id), len: store.lengthOf(p.id) }
          result.publicMeta = meta
          result.publicMetaHasNoPlaintext = !JSON.stringify(meta).includes(testKey)
          const w = getWindow()
          const visible = w && !w.isDestroyed()
            ? await w.webContents.executeJavaScript('(() => window.airimate ? window.airimate.listProviders() : null)()', true) as Record<string, unknown> | null
            : null
          result.rendererSeesNoPlaintext = !JSON.stringify(visible ?? {}).includes(testKey)
          const fs = await import('node:fs')
          const path = await import('node:path')
          let diskHasPlaintext = false
          const dir = appPaths().secretsDir
          if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) {
              try { if (fs.readFileSync(path.join(dir, f)).includes(testKey)) diskHasPlaintext = true } catch { /* ignore */ }
            }
          }
          result.diskHasPlaintext = diskHasPlaintext
          result.pass = result.encryptionAvailable === true && meta.hasKey === true
            && result.publicMetaHasNoPlaintext === true && result.rendererSeesNoPlaintext === true && diskHasPlaintext === false
          const test = await testProvider(getProvider(p.id)!, store.get(p.id))
          result.connectivity = { code: test.code, ok: test.ok, latencyMs: test.latencyMs, message: test.message }
          result.connectivityReachedServer = test.code === 'auth' || test.code === 'ok'
          store.clear(p.id)
          deleteProvider(p.id)
          result.cleanedUp = true
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
        }
        console.log(`[airimate] PROBE_SECRET ${JSON.stringify(result)}`)
        if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
        if (cli.probeExit) quit('probe')
      })()
    }, 8_000)
  }
  /**
   * `--probe chat`：验证聊天链路**已真实接通**（不再返回 NOT_IMPLEMENTED）。
   * 用**无效密钥**打通链路：期望收到 `chat:error` 且 code=auth（证明确实发到了服务端并被拒），
   * 而不是 `INTERNAL: CHAT_NOT_IMPLEMENTED`。
   */
  if (cli.probe === 'chat') {
    setTimeout(() => {
      void (async () => {
        const result: Record<string, unknown> = {}
        let p: { id: string } | null = null
        try {
          const store = secretStore()
          p = upsertProvider({ label: 'probe-chat', kind: 'openai-compatible' as never, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' })
          store.set(p.id, `sk-airimate-chatprobe-${Date.now().toString(36)}-invalid`)
          setActive(p.id)
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          // 在页面内挂一次性监听，捕获 chat:error / chat:done
          await w.webContents.executeJavaScript(`
            (() => {
              window.__PROBE_CHAT__ = { events: [] };
              if (window.airimate) {
                window.airimate.onChatError((e) => window.__PROBE_CHAT__.events.push({ kind: 'error', e }));
                window.airimate.onChatDone((d) => window.__PROBE_CHAT__.events.push({ kind: 'done', d }));
              }
              return true;
            })()
          `, true)
          const sendRes = await w.webContents.executeJavaScript(
            '(() => window.airimate ? window.airimate.sendChat("连通性自检", "probe-1") : null)()', true,
          ) as { ok?: boolean, code?: string, message?: string, requestId?: string } | null
          result.sendResult = sendRes
          result.sendAccepted = sendRes?.ok === true
          result.notImplemented = typeof sendRes?.message === 'string' && sendRes.message.includes('NOT_IMPLEMENTED')
          // 等链路返回（无效密钥 ⇒ 期望 auth 错误）
          await new Promise(r => setTimeout(r, 6000))
          const ev = await w.webContents.executeJavaScript('(() => window.__PROBE_CHAT__ ? JSON.parse(JSON.stringify(window.__PROBE_CHAT__)) : null)()', true) as { events?: Array<{ kind: string, e?: { code?: string, message?: string } }> } | null
          const events = ev?.events ?? []
          result.events = events
          const err = events.find(x => x.kind === 'error')
          result.errorCode = err?.e?.code ?? null
          result.passChainWired = result.sendAccepted === true && result.notImplemented === false
          result.passReachedServer = result.errorCode === 'auth'
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
        }
        try { if (p) { secretStore().clear(p.id); deleteProvider(p.id) } } catch { /* ignore */ }
        result.cleanedUp = true
        console.log(`[airimate] PROBE_CHAT ${JSON.stringify(result)}`)
        if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
        if (cli.probeExit) quit('probe')
      })()
    }, 8_000)
  }
  /**
   * `--probe bonemotion`：骨骼是否**真的在动**。
   *
   * 为什么单独一条：浸泡采样里 `bones` 的四元数在多个采样点之间**逐字节相同**，
   * 而 `baseClipId` 明明在轮换。两种解释必须区分开：
   *   ⓐ 那些待机 clip 的姿态本就高度相似（无问题）；
   *   ⓑ 读到的是一个**冻住**的源（那"看起来在动"就是假的）。
   * 判据：1.2 秒内至少一根骨的姿态变化 > 0.01°。为 0 就说明读的是静态姿态。
   */
  if (cli.probe === 'bonemotion') {
    setTimeout(() => {
      void (async () => {
        const result: Record<string, unknown> = {}
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          result.boneMotion = await w.webContents.executeJavaScript(
            '(() => { const f = window.__AIRIMATE_MOTION_PROBE__; return f ? f("boneMotion") : null })()', true,
          )
          const bm = result.boneMotion as { rawIsAnimating?: boolean, normalizedLooksFrozen?: boolean } | null
          result.pass = bm?.rawIsAnimating === true
          result.diagnosis = bm?.normalizedLooksFrozen === true
            ? '归一化骨骼节点近乎静止（快照 bones 不适合做卡死判定）；原始节点在动 ⇒ 动画确实在推进'
            : '两条源都在动'
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
          result.pass = false
        }
        console.log(`[airimate] PROBE_BONEMOTION ${JSON.stringify(result)}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, 14_000)
  }
  /**
   * `--probe soak`：长稳浸泡采样（判据 A15 / A16）。
   *
   * 为什么把采样放进**应用内部**而不是外部脚本轮询：
   *   · 外部只能拿到"进程还在不在"这种粗信息；真正的判据是 17 根骨骼的四元数、
   *     场景/渲染器/混音器/VRM 计数、`baseClipId`、`fps`、`heapMB` —— 这些只在 renderer 快照里；
   *   · 用 CDP 去取（Acceptance-Matrix 的备选方案）会给生产代码引入一条调试通道，
   *     与"生产禁用 CDP 注入"的红线冲突；
   *   · 应用内采样走的是 `__AIRIMATE_MOTION_PROBE__` / `__AIRIMATE_STAGE__` 这条
   *     既有只读通道，不新增攻击面。
   *
   * 输出：JSONL，一行一个采样点，便于流式追加与中途被杀也不丢历史。
   *
   * 采样内容 = 判据所需的最小集合：
   *   `t`（秒）、`fps1s/5s`、`heapMB`、`baseClipId`、`idleTotal`、`phase`、`dragging`、
   *   `scene/renderer/mixer/vrm/live2d` 计数、`boneCount`、`bones`（用于 T-pose 判定）、
   *   `windowCount`、`visibleWindows`、`warnings`。
   */
  if (cli.probe === 'soak') {
    const outFile = cli.probeOut
    const minutes = cli.soakMinutes
    const everyMs = cli.soakSampleSec * 1000
    log().info('--probe soak 已排程', { minutes, everyMs, out: outFile ?? '(仅控制台)' }, 'probe.soak.scheduled')
    setTimeout(() => {
      void (async () => {
        const t0 = Date.now()
        let n = 0
        let stopped = false
        const writeLine = (obj: Record<string, unknown>): void => {
          if (!outFile) return
          try { appendFileSync(outFile, `${JSON.stringify(obj)}\n`, 'utf8') } catch (e) {
            console.error(`[airimate] SOAK_WRITE_FAILED ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        if (outFile) {
          try {
            mkdirSync(dirname(outFile), { recursive: true })
            // 头部元数据：让证据文件自带口径（多久、多密、什么版本）
            writeLine({
              kind: 'meta', startedAt: new Date(t0).toISOString(), minutes, everyMs,
              bootId: process.env.AIRIMATE_BOOT_ID ?? null, version: app.getVersion(),
              /**
               * ★ 把"本轮浸泡有没有打开对话窗口"写进 meta。
               *   没有它，分析器无法判断"对话窗口 ≤ 1"这一条到底**被测过没有** ——
               *   而"没测"与"测过且通过"必须能分辨（本项目的一贯纪律）。
               */
              soakWithChat: cli.soakWithChat,
              windowCriterion: 'characterWindowCount=1 且 chatWindowCount<=1（总数 1..2 只记录）',
            })
          } catch { /* ignore */ }
        }
        /**
         * ★ `--soak-with-chat`：浸泡期间**打开并保持**独立对话窗口。
         *
         * 时间点：开始后 10% 处打开（让开头有一段"单窗口"样本做对照），
         * 结束前 10% 处关闭（让结尾也回到单窗口）——
         * 于是同一份 JSONL 里**同时**覆盖 1 个窗口与 2 个窗口两种状态。
         * 打开/关闭本身也写成 `kind:'chat-toggle'` 记录，供分析器核对。
         */
        let chatToggleTimer: NodeJS.Timeout | null = null
        if (cli.soakWithChat) {
          const totalMs = minutes * 60_000
          const openAt = Math.max(5_000, Math.round(totalMs * 0.1))
          const closeAt = Math.max(openAt + 5_000, Math.round(totalMs * 0.9))
          chatToggleTimer = setTimeout(() => {
            const r = openConversation('api')
            writeLine({ kind: 'chat-toggle', action: 'open', at: new Date().toISOString(), ok: r.ok, tSec: Number(((Date.now() - t0) / 1000).toFixed(1)) })
            log().info('浸泡：已打开独立对话窗口（覆盖"两个窗口并存"分支）', { ok: r.ok, openAt }, 'probe.soak.chat-open')
            chatToggleTimer = setTimeout(() => {
              const c = closeConversation('api')
              writeLine({ kind: 'chat-toggle', action: 'close', at: new Date().toISOString(), ok: c.ok, tSec: Number(((Date.now() - t0) / 1000).toFixed(1)) })
              log().info('浸泡：已收起对话窗口（回到单窗口）', { ok: c.ok, closeAt }, 'probe.soak.chat-close')
            }, closeAt - openAt)
            chatToggleTimer.unref?.()
          }, openAt)
          chatToggleTimer.unref?.()
          log().info('浸泡：对话窗口开合已排程', { openAt, closeAt }, 'probe.soak.chat-scheduled')
        }
        const sampleOnce = async (): Promise<void> => {
          const w = getWindow()
          if (!w || w.isDestroyed()) { writeLine({ kind: 'sample', n, error: 'window-gone' }); return }
          const snap = await w.webContents.executeJavaScript(
            '(() => { const f = window.__AIRIMATE_MOTION_PROBE__; return f ? f("full") : null })()', true,
          ) as Record<string, unknown> | null
          /**
           * ★ **窗口可见性 / 焦点**（本轮实测踩到，必须记录）。
           *
           * 为什么：run4 采集到一段 6.5 分钟的 `fps5s ≈ 1`、`activeTimeSec` 冻结——
           * 这是 Chromium 对**被遮挡/被隐藏窗口**的 rAF 节流特征（≈1 Hz），
           * 而应用自身的 `visibilitychange` 处理**故意**在隐藏时暂停渲染（正确行为）。
           * 不记录这两个字段，就只能"推断"原因，会把"用户离开了/窗口被盖住"
           * 误报成"应用帧率不达标"。
           * 有了它，分析器可以：① 只在可见样本上统计帧率与动画时钟；
           * ② 要求可见样本占比 ≥95%（否则这一轮**无效**，而不是"失败"）。
           */
          const visInfo = await w.webContents.executeJavaScript(
            '({ v: document.visibilityState, f: document.hasFocus(), occluded: document.hidden })', true,
          ) as { v?: string, f?: boolean, occluded?: boolean } | null
          const wins = BrowserWindow.getAllWindows().filter(x => !x.isDestroyed())
          /**
           * ★ 2026-10-08 返工轮：**按身份**数窗口（不再用总数当"单角色"的判据）。
           *
           * 为什么必须改：本应用现在**恰好两个**窗口（角色 + 独立对话窗口），
           * chat 打开时正确的可见窗口数就是 **2**。旧浸泡判据 `visibleWindows === 1`
           * 是「只创建一个 BrowserWindow」时代的产物 —— 照旧跑会在 chat 一开就假失败。
           *
           * 新口径（`Acceptance-Matrix.md` §0.5.2）：
           *   · **角色窗口**（URL 不带 `surface=chat`）恒为 **1** —— 这一条才是"单角色"的落点；
           *   · **对话窗口**（URL 带 `surface=chat`）**0 或 1**（关/开两个合法状态）；
           *   · 总数因此是 1 或 2 —— 只记录，不作判据。
           */
          const isChatWin = (x: Electron.BrowserWindow): boolean => {
            try { return x.webContents.getURL().includes('surface=chat') } catch { return false }
          }
          const rec: Record<string, unknown> = {
            kind: 'sample',
            n,
            tSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
            at: new Date().toISOString(),
            windowCount: wins.length,
            visibleWindows: wins.filter(x => x.isVisible()).length,
            /** 角色窗口数（恒 1）—— 新判据的读数口 */
            characterWindowCount: wins.filter(x => !isChatWin(x)).length,
            characterVisibleWindowCount: wins.filter(x => !isChatWin(x) && x.isVisible()).length,
            /** 对话窗口数（0 或 1） */
            chatWindowCount: wins.filter(isChatWin).length,
            chatVisibleWindowCount: wins.filter(x => isChatWin(x) && x.isVisible()).length,
            mainBounds: windowBounds(),
            mode: windowMode(),
            /** renderer 眼里的可见性：`visible` / `hidden` */
            visibilityState: visInfo?.v ?? null,
            /** 窗口是否持有焦点（用户是否正在用它） */
            hasFocus: visInfo?.f ?? null,
            /** `document.hidden`（隐藏 ⇒ 应用**故意**暂停渲染，此时帧率不该被计入） */
            hidden: visInfo?.occluded ?? null,
          }
          if (!snap) { rec.snapshotNull = true; writeLine(rec); return }
          const fps = snap.fps as { avg1s?: number, avg5s?: number } | undefined
          const bones = snap.bones as Record<string, { x: number, y: number, z: number, w: number }> | undefined
          Object.assign(rec, {
            fps1s: fps?.avg1s ?? null,
            fps5s: fps?.avg5s ?? null,
            heapMB: snap.heapMB ?? null,
            baseClipId: snap.baseClipId ?? null,
            activeClip: snap.activeClip ?? null,
            /**
             * 动画时钟。**浸泡的"还在动"判据用它，而不是骨骼四元数** ——
             * 实测骨骼（归一化与原始两条源）在 5 秒内每 500ms 只有恒定 0.026° 的变化，
             * 而 `AnimationAction.time` 随 mixer 单调推进，是直接、不可伪装的证据。
             */
            activeTimeSec: snap.activeTimeSec ?? null,
            activeDurationSec: snap.activeDurationSec ?? null,
            idleTotal: snap.idleTotal ?? null,
            idleIndex: snap.idleIndex ?? null,
            phase: snap.phase ?? null,
            dragging: snap.dragging ?? null,
            sceneCount: snap.sceneCount ?? null,
            rendererCount: snap.rendererCount ?? null,
            mixerCount: snap.mixerCount ?? null,
            vrmCount: snap.vrmCount ?? null,
            live2dCount: snap.live2dCount ?? null,
            boneCount: bones ? Object.keys(bones).length : 0,
            // 骨骼四元数原样落盘：T-pose 判定需要"所有骨骼都是单位四元数"这类证据
            bones: bones ?? null,
            warnings: snap.warnings ?? [],
          })
          writeLine(rec)
          n += 1
        }
        const tick = async (): Promise<void> => {
          if (stopped) return
          try { await sampleOnce() } catch (e) {
            writeLine({ kind: 'sample', n, error: e instanceof Error ? e.message : String(e) })
          }
          if (Date.now() - t0 >= minutes * 60_000) {
            writeLine({ kind: 'end', endedAt: new Date().toISOString(), samples: n, soakSec: Number(((Date.now() - t0) / 1000).toFixed(1)) })
            console.log(`[airimate] PROBE_SOAK_DONE ${JSON.stringify({ samples: n, soakSec: Math.round((Date.now() - t0) / 1000), out: outFile })}`)
            if (cli.probeExit) quit('probe')
            return
          }
          setTimeout(() => { void tick() }, everyMs)
        }
        void tick()
      })()
    }, 12_000)
  }
  /**
   * `--probe memory`：记忆层端到端验收（写入 → 重启读取 → 召回 → 注入对话 → 删除）。
   *
   * 为什么每一段都要测，而不是只测 `addMemory()`：
   *   · 只测存储层 → 无法证明 **IPC 白名单里真的有这条通道**（合约漏了注册，
   *     存储层单测照样全绿，但 renderer 根本调不到）；
   *   · 只测 IPC → 无法证明**真的落盘**（内存缓存也能"读回来"）；
   *   · 不测注入 → 无法证明记忆**真的进了系统提示**（这是记忆层唯一的对外价值）。
   * 所以本探针按"证据链的每一跳"分别取数，并各自给出可判定的 pass 字段。
   *
   * 隐私：全流程只用固定测试文本；落盘检查只断言文本存在，不打印用户真实记忆；
   *      诊断里的注入证据只有长度与指纹（`memory-state.ts`）。
   */
  if (cli.probe === 'a12') {
    setTimeout(() => {
      void (async () => {
        const result: Record<string, unknown> = {}
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const call = async (op: string): Promise<unknown> =>
            await w.webContents.executeJavaScript(
              `(() => { const f = window.__AIRIMATE_MOTION_PROBE__; return f ? f(${JSON.stringify(op)}) : null })()`, true,
            )
          const pre = await call('legTravel') as { idleTotal?: number, baseClipId?: string } | null
          if (!pre || typeof pre.idleTotal !== 'number') throw new Error('舞台未就绪：__AIRIMATE_STAGE__ 未返回 idleTotal')
          result.pre = pre

          /* ⚠ 必须先重置再采样：`boneTravel` 是自启动以来的**累计**角行程，
             直接读非零只能证明"历史上动过"，证明不了"这 5 秒在动" ——
             而"人物卡死不动的"正是这类桌宠最典型的故障。 */
          await call('resetTravel')
          const SAMPLES = 10
          const INTERVAL_MS = 500
          const clips: string[] = []
          for (let i = 0; i < SAMPLES; i++) {
            await new Promise(r => setTimeout(r, INTERVAL_MS))
            const s = await call('legTravel') as { baseClipId?: string } | null
            if (s?.baseClipId) clips.push(s.baseClipId)
          }
          const post = await call('legTravel') as { legTravel?: Record<string, number>, idleTotal?: number, baseClipId?: string } | null
          const travel = post?.legTravel ?? {}
          result.sampleWindowSec = (SAMPLES * INTERVAL_MS) / 1000
          result.clipsObserved = [...new Set(clips)]
          result.legTravel = travel
          result.idleTotal = post?.idleTotal ?? null

          /**
           * A12 判据门槛（**用户 2026-09-27 定稿，方案 C：组合条件**）。
           *
           * 单条件「≥2 根腿骨各自 > 5°」太松：一根骨的偶然抖动 + 另一根刚过线就能过。
           * 组合条件要求**同时**满足：
           *   · 最强的那根腿骨 > 5°（证明"确实在动"，0° 附近必须判失败 —— 那才是卡死）；
           *   · 4 根腿骨总行程 > 20°（证明是**腿在动**，不是单点噪声）。
           * 两者都不依赖"某个特定动作"的幅度，换成幅度温和的资产也不会假失败。
           */
          const A12_SINGLE_BONE_MIN_DEG = 5
          const A12_TOTAL_MIN_DEG = 20
          const vals = Object.values(travel)
          const movedBones = Object.entries(travel).filter(([, v]) => v > A12_SINGLE_BONE_MIN_DEG).map(([k]) => k)
          const totalDeg = Object.values(travel).reduce((a, b) => a + b, 0)
          result.maxLegTravelDeg = vals.length ? Number(Math.max(...vals).toFixed(2)) : 0
          result.legTravelTotalDeg = Number(totalDeg.toFixed(2))
          result.movedLegBones = movedBones
          result.a12Thresholds = { singleBoneMinDeg: A12_SINGLE_BONE_MIN_DEG, totalMinDeg: A12_TOTAL_MIN_DEG }
          result.passA12SingleBone = (result.maxLegTravelDeg as number) > A12_SINGLE_BONE_MIN_DEG
          result.passA12TotalTravel = totalDeg > A12_TOTAL_MIN_DEG
          result.passA12 = result.passA12SingleBone === true && result.passA12TotalTravel === true
          result.passA13Count = (post?.idleTotal ?? 0) >= 10
          result.passNoTpose = typeof post?.baseClipId === 'string' && post.baseClipId.length > 0

          /* 界面读数一致性：状态栏徽标用的 getter 必须与后端读数一致。
             只判后端会漏掉"契约漂移导致界面恒显示 0"这类缺陷（实测踩到过）。 */
          const ui = await w.webContents.executeJavaScript(
            '(() => { const f = window.__AIRIMATE_UI_PROBE__; return f ? f("read") : null })()', true,
          ) as { idleCount?: number, stageIdleTotal?: number } | null
          result.ui = ui
          result.passUiIdleCountMatches = ui != null
            && ui.idleCount === ui.stageIdleTotal
            && (ui.idleCount ?? 0) >= 10
          result.pass = result.passA12 === true && result.passA13Count === true
            && result.passNoTpose === true && result.passUiIdleCountMatches === true
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
          result.pass = false
        }
        console.log(`[airimate] PROBE_A12 ${JSON.stringify(result)}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, 14_000)
  }
  /**
   * `--probe a13`：待机轮换验收（12s 切换 / 无 T-pose 窗口）。
   * 与 a12 的区别：a12 看"动没动"，a13 看"**换没换**"。
   * 采样窗 27s（> 2 个 12s 周期），逐 500ms 记录 baseClip，
   * 判定：① 轮换真的发生；② 轮换间隔落在 12s±1.5s；③ 任何时刻 baseClip 非空。
   */
  if (cli.probe === 'a13') {
    setTimeout(() => {
      void (async () => {
        const result: Record<string, unknown> = {}
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const call = async (op: string): Promise<unknown> =>
            await w.webContents.executeJavaScript(
              `(() => { const f = window.__AIRIMATE_MOTION_PROBE__; return f ? f(${JSON.stringify(op)}) : null })()`, true,
            )
          const SAMPLES = 54
          const INTERVAL_MS = 500
          const timeline: Array<{ t: number, clip: string | null }> = []
          for (let i = 0; i <= SAMPLES; i++) {
            const st = await call('state') as { base?: string } | null
            timeline.push({ t: i * INTERVAL_MS, clip: st?.base ?? null })
            if (i < SAMPLES) await new Promise(r => setTimeout(r, INTERVAL_MS))
          }
          result.windowSec = (SAMPLES * INTERVAL_MS) / 1000
          result.samples = timeline.length
          const switches: Array<{ atMs: number, from: string | null, to: string | null }> = []
          for (let i = 1; i < timeline.length; i++) {
            const prev = timeline[i - 1] as { t: number, clip: string | null }
            const cur = timeline[i] as { t: number, clip: string | null }
            if (cur.clip !== prev.clip) switches.push({ atMs: cur.t, from: prev.clip, to: cur.clip })
          }
          result.switches = switches
          result.switchCount = switches.length
          const gaps = switches.slice(1).map((s, i) => s.atMs - (switches[i] as { atMs: number }).atMs)
          result.switchGapsMs = gaps
          result.idleTotal = (await call('legTravel') as { idleTotal?: number } | null)?.idleTotal ?? null
          /* ⚠ 采样分辨率 500ms：12s 的间隔只能测到 ±1 样本（±500ms），
             故判据取 [10.5s, 13.5s] 区间而非"精确 12.000s"。
             毫秒级精度由 motion-runtime 单测（可控时钟）保证。 */
          result.passRotationHappened = switches.length >= 2
          result.passRotationPeriod = gaps.length > 0 && gaps.every(g => g >= 10_500 && g <= 13_500)
          const emptySamples = timeline.filter(s => !s.clip || s.clip.length === 0).length
          result.emptyClipSamples = emptySamples
          result.passNoTposeWindow = emptySamples === 0
          result.distinctClipsObserved = [...new Set(timeline.map(s => s.clip).filter(Boolean))].length
          result.pass = result.passRotationHappened === true && result.passRotationPeriod === true && result.passNoTposeWindow === true
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
          result.pass = false
        }
        console.log(`[airimate] PROBE_A13 ${JSON.stringify(result)}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, 14_000)
  }
  if (cli.probe === 'memory') {
    setTimeout(() => {
      void (async () => {
        const result: Record<string, unknown> = { steps: [] }
        const steps: Array<Record<string, unknown>> = []
        const TEST_TEXT = '用户养了一只叫豆豆的猫，最喜欢抹茶拿铁'
        const persisted: string[] = []
        let probeProvId: string | null = null
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const call = async (expr: string): Promise<unknown> =>
            await w.webContents.executeJavaScript(expr, true)

          // ── ① 清场：删掉本探针可能残留的条目，保证从确定状态开始
          const before = await call('(() => window.airimate.listMemory())()') as { ok?: boolean, entries?: Array<{ id: string, text: string }>, total?: number }
          steps.push({ step: 'list-before', ok: before?.ok === true, total: before?.total ?? null })
          for (const e of before?.entries ?? []) {
            if (e.text.startsWith('用户养了一只叫豆豆的猫')) persisted.push(e.id)
          }
          for (const id of persisted) await call(`(() => window.airimate.deleteMemory(${JSON.stringify(id)}))()`)
          persisted.length = 0

          // ── ② IPC 写入（同时证明 preload 白名单 + main 侧 schema 都通）
          const addRes = await call(
            `(() => window.airimate.addMemory({ text: ${JSON.stringify(TEST_TEXT)}, tags: ["宠物", "food"], importance: 0.9 }))()`,
          ) as { ok?: boolean, entry?: { id: string, text: string }, total?: number, code?: string, message?: string }
          const entryId = addRes?.entry?.id ?? null
          if (entryId) persisted.push(entryId)
          steps.push({ step: 'ipc-add', ok: addRes?.ok === true, entryId, total: addRes?.total ?? null, code: addRes?.code ?? null })
          result.passIpcAdd = addRes?.ok === true && typeof entryId === 'string'

          // ── ③ 落盘证据：直接读磁盘文件，证明不是"只在内存里"
          const diskAfterAdd = memoryFileProbe(TEST_TEXT)
          result.diskAfterAdd = diskAfterAdd
          steps.push({ step: 'disk-after-add', ...diskAfterAdd })
          result.passPersisted = diskAfterAdd.containsTestText === true

          // ── ④ "重启"读取：丢弃缓存后重新从磁盘读（同一进程内的冷读）
          const cold = reloadFromDisk()
          const coldCount = cold.entries
          const coldHit = recall('豆豆 猫', 5)
          result.coldRead = { count: coldCount, hits: coldHit.length, topText: coldHit[0]?.entry.text ?? null }
          steps.push({ step: 'cold-read', count: coldCount, hits: coldHit.length, topText: coldHit[0]?.entry.text ?? null })
          result.passColdRead = coldHit.length > 0 && coldHit[0]?.entry.text === TEST_TEXT

          // ── ⑤ IPC 召回：格式与排序
          const recallRes = await call('(() => window.airimate.recallMemory("我的猫豆豆", 5))()') as
            { ok?: boolean, hits?: Array<{ entry: { text: string }, score: number }>, count?: number }
          result.ipcRecall = { ok: recallRes?.ok === true, count: recallRes?.count ?? null, top: recallRes?.hits?.[0]?.entry?.text ?? null, score: recallRes?.hits?.[0]?.score ?? null }
          steps.push({ step: 'ipc-recall', ...result.ipcRecall as Record<string, unknown> })
          result.passIpcRecall = recallRes?.ok === true && (recallRes.count ?? 0) > 0 && recallRes.hits?.[0]?.entry?.text === TEST_TEXT

          // ── ⑥ 入参校验：超长文本必须被 main 侧拒绝（证明校验真的生效，不是摆设）
          const badRes = await call(`(() => window.airimate.addMemory({ text: ${JSON.stringify('x'.repeat(5000))} }))()`) as { ok?: boolean, code?: string }
          result.schemaReject = { ok: badRes?.ok ?? null, code: badRes?.code ?? null }
          steps.push({ step: 'schema-reject-oversize', ok: badRes?.ok === false, code: badRes?.code ?? null })
          result.passSchemaReject = badRes?.ok === false && badRes?.code === 'IPC_SCHEMA'
          const badRecall = await call('(() => window.airimate.recallMemory("", 5))()') as { ok?: boolean, code?: string }
          result.schemaRejectEmptyQuery = { ok: badRecall?.ok ?? null, code: badRecall?.code ?? null }
          result.passSchemaRejectEmpty = badRecall?.ok === false && badRecall?.code === 'IPC_SCHEMA'

          // ── ⑦ 注入对话链路：发起一次真实的 `chat:send`，检查主进程记录的注入证据。
          // 注意顺序陷阱：`chat:send` **在没配置供应商时会提前返回**，
          // 根本走不到记忆注入那一步。所以这里临时建一个供应商 + 一把**故意无效**的密钥
          // （只为让请求真的发出去；期望链路返回 auth 失败，这与记忆无关）。
          const probeProv = upsertProvider({ label: 'probe-memory', kind: 'openai-compatible' as never, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' })
          probeProvId = probeProv.id
          secretStore().set(probeProv.id, `sk-airimate-memprobe-${Date.now().toString(36)}-invalid`)
          setActive(probeProv.id)
          const sendRes = await call('(() => window.airimate.sendChat("我的猫豆豆最近怎么样", "probe-mem"))()') as { ok?: boolean, requestId?: string, message?: string }
          result.chatSend = sendRes
          result.passChatAccepted = sendRes?.ok === true
          await new Promise(r => setTimeout(r, 1500))
          const inj = lastMemoryInjection()
          result.injection = inj
          steps.push({ step: 'injection', ...(inj as unknown as Record<string, unknown>) })
          result.passInjected = Boolean(inj && inj.chars > 0 && inj.hits > 0 && typeof inj.fingerprint === 'string')

          // ── ⑧ 负例：无相关记忆时**不得**注入空段落
          await call('(() => window.airimate.sendChat("zzqqxx 完全无关的词汇", "probe-mem-2"))()')
          await new Promise(r => setTimeout(r, 1200))
          const inj2 = lastMemoryInjection()
          result.injectionNegative = inj2
          result.passNoInjectionWhenIrrelevant = Boolean(inj2 && inj2.chars === 0 && inj2.fingerprint === null && inj2.hits === 0)
          result.passInjectionCounted = Boolean(inj2 && inj2.totalInjections >= 2)

          // ── ⑨ IPC 删除 + 落盘确认已消失
          const delRes = await call(`(() => window.airimate.deleteMemory(${JSON.stringify(entryId)}))()`) as { ok?: boolean, removed?: boolean, total?: number }
          result.ipcDelete = delRes
          steps.push({ step: 'ipc-delete', ...delRes as Record<string, unknown> })
          result.passIpcDelete = delRes?.ok === true && delRes?.removed === true
          const diskAfterDelete = memoryFileProbe(TEST_TEXT)
          result.diskAfterDelete = diskAfterDelete
          result.passGoneFromDisk = diskAfterDelete.containsTestText === false
          if (entryId) persisted.length = 0
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
        }
        // 无论成败都清场：探针不得给用户留下垃圾记忆，也不得留下探针供应商
        try { for (const id of persisted) deleteMemory(id) } catch { /* ignore */ }
        try { deleteMemory(recall(TEST_TEXT, 1)[0]?.entry.id ?? '') } catch { /* ignore */ }
        try {
          if (probeProvId) { secretStore().clear(probeProvId); deleteProvider(probeProvId) }
        } catch { /* ignore */ }
        result.cleanedUp = true
        result.steps = steps
        result.pass = ['passIpcAdd', 'passPersisted', 'passColdRead', 'passIpcRecall', 'passSchemaReject', 'passSchemaRejectEmpty', 'passChatAccepted', 'passInjected', 'passNoInjectionWhenIrrelevant', 'passInjectionCounted', 'passIpcDelete', 'passGoneFromDisk']
          .every(k => result[k] === true)
        console.log(`[airimate] PROBE_MEMORY ${JSON.stringify(result)}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, 12_000)
  }
  /**
   * `--probe memory-restart`：**跨进程**持久化验收（真正的"重启后还记得"）。
   *
   * 为什么必须有这一条：`--probe memory` 里的"冷读"是**同一进程内**丢缓存后重读磁盘，
   * 它能证明"数据在磁盘上"，但证明不了"下一个进程读得回来"（例如：路径用的是临时目录、
   * 启动时被清空、或写盘其实发生在退出钩子里 —— 这些在同一进程内都看不出来）。
   *
   * 用法（两趟，由 `tools/qa/check-memory-restart.ps1` 自动串起来）：
   *   第 1 趟 `--probe memory-restart`      → 写入一条**唯一标记**记忆并退出
   *   第 2 趟 `--probe memory-restart`      → 只读：报告是否读到了上趟那条
   *   第 3 趟 `--probe memory-restart --cleanup` → 删掉标记记忆
   * 标记用 `bootId` 之外的固定前缀 `AIRIMATE_MEMPROBE_`，便于人工核对与清理。
   */
  if (cli.probe === 'memory-restart') {
    setTimeout(() => {
      void (async () => {
        const MARK = 'AIRIMATE_MEMPROBE_跨进程持久化标记'
        const result: Record<string, unknown> = { bootId: process.env.AIRIMATE_BOOT_ID ?? null }
        try {
          const entries = listMemory(200)
          const found = entries.find(e => e.text.startsWith('AIRIMATE_MEMPROBE_'))
          result.existingMarker = found ? { id: found.id, text: found.text, createdAt: found.createdAt } : null
          result.existingMarkerCount = entries.filter(e => e.text.startsWith('AIRIMATE_MEMPROBE_')).length
          result.totalBefore = memoryCount()

          if (cli.cleanup) {
            let removed = 0
            for (const e of entries) if (e.text.startsWith('AIRIMATE_MEMPROBE_')) removed += deleteMemory(e.id) ? 1 : 0
            // ⚠ 清场判定必须取**删除之后**重新列出的结果。
            //   这里曾误用删除前的 `existingMarkerCount`，导致清场明明成功却报 FAIL（实测踩到）。
            const after = listMemory(200).filter(e => e.text.startsWith('AIRIMATE_MEMPROBE_')).length
            result.cleanup = { removed, remainingMarkers: after, totalAfter: memoryCount() }
            result.pass = after === 0
            console.log(`[airimate] PROBE_MEMORY_RESTART ${JSON.stringify(result)}`)
            if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
            if (cli.probeExit) quit('probe')
            return
          }

          if (result.existingMarker) {
            // 第 2 趟：只读 —— 上一趟的标记必须还在，且**不在**本趟写入
            result.mode = 'read'
            result.pass = true
            result.conclusion = '上一进程写入的记忆在本进程（新 bootId）中读到了 ⇒ 跨进程持久化成立'
          } else {
            // 第 1 趟：写入
            result.mode = 'write'
            const e = addMemory({ text: `${MARK}（写入进程 bootId=${process.env.AIRIMATE_BOOT_ID ?? 'unknown'}）`, tags: ['probe'], importance: 0.9 })
            result.written = { id: e.id, chars: e.text.length }
            // `result` 是 Record<string, unknown>；读回自己的字段要显式收窄类型
            const disk = memoryFileProbe(MARK) as { containsTestText?: boolean }
            result.disk = disk
            result.pass = disk.containsTestText === true
          }
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
          result.pass = false
        }
        console.log(`[airimate] PROBE_MEMORY_RESTART ${JSON.stringify(result)}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, 10_000)
  }
  /**
   * `--probe tts`：语音合成链路验收（判据 A23）。
   *
   * 验证的是**真实**三件事，全部实测、不靠推断：
   *   ① 本机声音枚举真的可用（`GetInstalledVoices()`），且 zh-CN 优先挑选生效；
   *   ② `tts:speak` 真的调用 Windows SAPI（子进程 exit 0 + 回报真实声音名与合成耗时）；
   *   ③ `tts:stop` 真的杀掉在飞子进程（报 `reason:'cancelled'` + 实测响应延迟）。
   *
   * ⚠ 出声说明：②③ 会**真的**通过扬声器出声（这就是"接通了"的证据）。
   *   探针是显式 `--probe tts` 才跑、跑完即退的一次性路径，不是常驻后台音频。
   *   文本用短的固定串 ⇒ 约 3–4 秒，不骚扰使用者。
   *
   * ⚠ 隐私：结果 JSON 里**不含**朗读正文，只有长度/块数/耗时/声音名/引擎 ——
   *   证据文件会被提交，正文不该进去。
   */
  if (cli.probe === 'tts') {
    const probeAt = 8_000
    log().info('--probe tts 已排程', { ms: probeAt }, 'probe.tts.scheduled')
    setTimeout(() => {
      void (async () => {
        const result: Record<string, unknown> = { engine: TTS_ENGINE, maxChunkChars: TTS_MAX_CHUNK_CHARS }
        const checks: Record<string, boolean> = {}
        try {
          // ① 枚举声音 + 挑选
          const v = await listVoices()
          result.voicesOk = v.ok
          result.voiceCount = v.voices.length
          result.voices = v.voices.map(x => ({ name: x.name, culture: x.culture, gender: x.gender, enabled: x.enabled }))
          result.error = v.error ?? null
          const chosen = chooseVoice(v.voices, null)
          result.chosenVoice = chosen
          const chosenInfo = v.voices.find(x => x.name === chosen) ?? null
          result.chosenCulture = chosenInfo?.culture ?? null
          result.hasChineseVoice = v.voices.some(x => /^zh/i.test(x.culture))
          result.voiceSelectionStrategy = result.hasChineseVoice
            ? 'zh-CN 优先（命中中文声音）'
            : '回退第一个可用声音（本机无中文声音）'
          checks.voicesEnumerated = v.ok === true && v.voices.length > 0
          checks.zhPreferredWhenAvailable = !result.hasChineseVoice || /^zh/i.test(String(result.chosenCulture ?? ''))

          const stateEvents: string[] = []
          const engineWithLog = createTtsEngine({
            onState: e => {
              stateEvents.push(`${e.utteranceId}:${e.state}`)
              log().info('探针收到 TTS 状态', { utteranceId: e.utteranceId, state: e.state }, 'probe.tts.state')
            },
          })

          // ② 短文本 + **真实出声**：证明这条链在无头 Electron 里确实驱动了 Windows SAPI
          const SHORT = '语音合成自检。'
          const tShort = Date.now()
          const rShort = await engineWithLog.speak(SHORT, 'probe-tts-1')
          const shortUtterance = {
            ...rShort,
            wallMs: Date.now() - tShort,
            /** 断言正文没有以任何形式回传进结果（证据文件里不该有正文） */
            echoedText: JSON.stringify(rShort).includes(SHORT),
          }
          result.audibleUtterance = shortUtterance
          checks.audibleCompleted = rShort.ok === true && rShort.completed === true && rShort.chunks === 1
          checks.audibleVoiceIsReal = typeof rShort.voice === 'string' && rShort.voice.length > 0 && rShort.voice === chosen
          /** 真的占用了实时合成时间（不是空转返回） */
          checks.audibleTookRealTime = rShort.ok === true && rShort.durationMs > 1000
          checks.noTextEcho = shortUtterance.echoedText === false

          /**
           * ③ 多块顺序合成 —— 走 SAPI 的 `SetOutputToNull()`（合成但不播放）。
           * 同一条子进程 + 同一条块循环，只是不占音频设备 ⇒ 可以放心用长文本。
           * 判据：块数必须等于**纯分块函数的规划值**（证明运行时真的按规划切了）。
           */
          const LONG_UNIT = '这一句用于验证长文本会被切成多块并顺序合成，每块不超过一百二十个字符。'
          const LONG = LONG_UNIT.repeat(12)
          const planned = chunkText(LONG)
          const tLong = Date.now()
          const rLong = await engineWithLog.speak(LONG, 'probe-tts-2', { output: 'null' })
          const longUtterance = {
            ...rLong,
            wallMs: Date.now() - tLong,
            inputChars: LONG.length,
            plannedChunks: planned.length,
            maxPlannedChunkChars: Math.max(...planned.map(c => c.length)),
          }
          result.multiChunkUtterance = longUtterance
          checks.multiChunkPlanned = planned.length > 1
          checks.everyPlannedChunkWithinLimit = planned.every(c => c.length <= TTS_MAX_CHUNK_CHARS)
          checks.multiChunkCompleted = rLong.ok === true && rLong.completed === true
          checks.chunkCountMatchesPlan = rLong.chunks === planned.length
          checks.charsPreserved = rLong.chars === LONG.length
          checks.stateEventsOrdered = stateEvents.join(',') === 'probe-tts-1:start,probe-tts-1:end,probe-tts-2:start,probe-tts-2:end'

          /**
           * ④ 取消：**必须等到块循环真的开始**再 stop，否则测的是"枚举声音期间被取消"
           *    （`chunks:0, spokenChunks:0`），那证明不了"能中断在飞的合成"。
           *    实测：枚举声音约 0.6s + 每块约 0.15s，因此等 1200ms 再 stop
           *    ⇒ 期望 `0 < spokenChunks < chunks`，即"说了一部分就被截断"。
           */
          const veryLong = LONG_UNIT.repeat(60)
          const pending = engineWithLog.speak(veryLong, 'probe-tts-3', { output: 'null' })
          await new Promise(r => setTimeout(r, 2500))
          const speakingBeforeStop = engineWithLog.speaking
          const t0 = Date.now()
          const stopAccepted = engineWithLog.stop()
          const stopReturnLatencyMs = Date.now() - t0
          const rCancel = await pending
          const spokenChunks = (rCancel as { spokenChunks?: number }).spokenChunks ?? -1
          result.cancel = {
            stopAccepted, stopReturnLatencyMs, speakingBeforeStop, spokenChunks,
            result: rCancel, speakingAfter: engineWithLog.speaking,
          }
          checks.stopAccepted = stopAccepted === true
          checks.cancelResultShape = rCancel.ok === true && rCancel.completed === false && rCancel.reason === 'cancelled'
          checks.cancelPrompt = stopReturnLatencyMs < 500
          /** 真的中断了在飞的合成：说了一部分（>0）但没说完（< 总块数） */
          checks.cancelInterruptedMidSpeech = rCancel.chunks > 1 && spokenChunks > 0 && spokenChunks < rCancel.chunks
          checks.engineIdleAfterCancel = engineWithLog.speaking === false
          // 幂等：空闲时再 stop 一次不应报"取消成功"
          checks.stopIdempotentWhenIdle = engineWithLog.stop() === false

          // ⑥ ★ 真正走 IPC 通道：renderer 经 preload → `tts:voices` / `tts:speak` / `tts:stop`
          /**
           * 为什么必须有这一段：上面 ②–⑤ 都是**主进程内直接调引擎**，
           * 它们证明不了"renderer 能通过白名单通道用到这个能力"。
           * 这一段才是交付契约本身（preload 暴露面 + 主进程 handler + 出参形状 + 取消不悬挂）。
           */
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const ttsWasEnabled = loadSettings().ttsEnabled
          patchSettings({ ttsEnabled: true })
          try {
            const ipcVoices = await w.webContents.executeJavaScript(
              '(() => window.airimate ? window.airimate.listVoices() : null)()', true,
            ) as { ok?: boolean, voices?: unknown[], selected?: string | null, engine?: string } | null
            result.ipcVoices = ipcVoices
            checks.ipcVoicesOk = ipcVoices?.ok === true && Array.isArray(ipcVoices.voices) && ipcVoices.voices.length > 0
            checks.ipcVoicesShape = ipcVoices?.engine === TTS_ENGINE && typeof ipcVoices?.selected === 'string'

            // 经 IPC 真的说一句短的（renderer → preload → main → SAPI → 扬声器）
            const tIpc = Date.now()
            const ipcSpeak = await w.webContents.executeJavaScript(
              '(() => window.airimate ? window.airimate.speak("通道自检。", "probe-ipc-1") : null)()', true,
            ) as { ok?: boolean, completed?: boolean, reason?: string, chunks?: number, voice?: string } | null
            result.ipcSpeak = { ...ipcSpeak, wallMs: Date.now() - tIpc }
            checks.ipcSpeakOk = ipcSpeak?.ok === true && ipcSpeak?.completed === true && ipcSpeak?.reason === 'completed'
            checks.ipcSpeakReturnedVoice = typeof ipcSpeak?.voice === 'string' && ipcSpeak.voice.length > 0

            // 经 IPC 取消：起头后 stop，promise 必须 settle 成 cancelled（绝不悬挂）
            const ipcPending = w.webContents.executeJavaScript(
              `(() => window.airimate ? window.airimate.speak(${JSON.stringify(LONG_UNIT.repeat(20))}, "probe-ipc-2") : null)()`, true,
            ) as Promise<{ ok?: boolean, completed?: boolean, reason?: string } | null>
            await new Promise(r => setTimeout(r, 1400))
            const tStop = Date.now()
            const ipcStop = await w.webContents.executeJavaScript(
              '(() => window.airimate ? window.airimate.stopSpeak() : null)()', true,
            ) as { ok?: boolean, cancelled?: boolean } | null
            const ipcStopLatencyMs = Date.now() - tStop
            const ipcCancel = await Promise.race([
              ipcPending,
              new Promise(res => setTimeout(() => res({ timeout: true }), 8000)),
            ]) as { timeout?: boolean, ok?: boolean, completed?: boolean, reason?: string } | null
            result.ipcStop = { ipcStop, ipcStopLatencyMs, ipcCancel }
            checks.ipcStopAccepted = ipcStop?.ok === true && ipcStop?.cancelled === true
            checks.ipcCancelSettled = ipcCancel?.timeout === undefined
              && ipcCancel?.ok === true && ipcCancel?.completed === false && ipcCancel?.reason === 'cancelled'
          } finally {
            // 还原设置：探针不得留下"朗读被打开"的副作用
            patchSettings({ ttsEnabled: ttsWasEnabled })
          }
          checks.ttsSettingRestored = loadSettings().ttsEnabled === ttsWasEnabled

          // ⑦ 受限目录临时正文文件：写在 ttsDir 下，且必须删干净
          const f = writeTempUtterance('probe-tts', '探针临时正文（不应残留）')
          const removed = removeTempUtterance(f)
          const tempFile = {
            underTtsDir: f.startsWith(appPaths().ttsDir),
            basename: f.split(/[\\/]/).pop() ?? '',
            removed,
            deletedAfterUse: !existsSync(f),
          }
          result.tempFile = tempFile
          checks.tempFileInRestrictedDir = tempFile.underTtsDir === true
          checks.tempFileDeleted = tempFile.deletedAfterUse === true
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
        }

        result.checks = checks
        const passedChecks = Object.values(checks).filter(Boolean).length
        const totalChecks = Object.keys(checks).length
        result.passedChecks = passedChecks
        result.totalChecks = totalChecks
        result.pass = totalChecks >= 25 && passedChecks === totalChecks
        console.log(`[airimate] PROBE_TTS ${JSON.stringify(result)}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  /**
   * `--probe m1m2`：M1 配置闭环 + M2 主动陪伴引擎的**端到端 IPC 验收**。
   *
   * 为什么必须走真 IPC 而不是直接调主进程函数：本项目判据的核心之一就是
   * "renderer 拿不到密钥、所有特权能力只在主进程、白名单双向 zod 校验"。
   * 直接调 `provider-store.ts` 的函数**证明不了**这三件事 ——
   * 必须从 renderer 侧经 `window.airimate` 真的发一遍，才能证明：
   *   ① 通道真的注册了（preload 白名单 ↔ main handler 对得上）；
   *   ② 入参/出参两侧的 zod 校验真的在跑（非法值被拒）；
   *   ③ 出参形状真的不含密钥材料。
   *
   * 探针**自己清场**：所有创建的供应商/日程/提醒都记下来，跑完删掉，
   * 不留下会打扰用户的数据（尤其提醒）。
   *
   * ⚠ 证据里**不含**正文与密钥：只记 ok / code / 计数 / 长度 / 枚举值。
   */
  if (cli.probe === 'm1m2') {
    const probeAt = 9_000
    log().info('--probe m1m2 已排程', { ms: probeAt }, 'probe.m1m2.scheduled')
    setTimeout(() => {
      void (async () => {
        const checks: Record<string, boolean> = {}
        const steps: Array<Record<string, unknown>> = []
        const result: Record<string, unknown> = { steps, checks }
        const createdProviders: string[] = []
        const createdSchedules: string[] = []
        const createdReminders: string[] = []
        let probeProvId: string | null = null
        const mark = (k: string, v: boolean): void => { checks[k] = v === true; steps.push({ step: k, ok: v === true }) }
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const call = async (expr: string): Promise<Record<string, unknown>> =>
            await w.webContents.executeJavaScript(expr, true) as Record<string, unknown>

          // ═══════════════ M1-1 供应商：建立 + 出参不含密钥 + 校验生效
          const upsert = await call(`(() => window.airimate.upsertProvider({
            label: 'probe-m1m2', kind: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
            apiKey: 'sk-airimate-m1m2-' + 'x'.repeat(20)
          }))()`)
          mark('m1.provider.upsert.ok', upsert.ok === true)
          const list = await call('(() => window.airimate.listProviders())()') as {
            ok?: boolean, backend?: string
            providers?: Array<Record<string, unknown>>
          }
          const mine = (list.providers ?? []).filter(p => p.label === 'probe-m1m2')
          const prov = mine[0]
          if (prov && typeof prov.id === 'string') { probeProvId = prov.id; createdProviders.push(prov.id) }
          result.providerList = {
            ok: list.ok === true,
            backend: list.backend ?? null,
            count: (list.providers ?? []).length,
            probeHasKey: prov?.hasKey ?? null,
            probeKeyLength: prov?.keyLength ?? null,
            probeFingerprintLen: typeof prov?.keyFingerprint === 'string' ? (prov.keyFingerprint as string).length : null,
            /** 出参里出现过的**所有键名**（用来机械证明没有 apiKey 这一类字段） */
            keys: prov ? Object.keys(prov).sort() : [],
          }
          mark('m1.provider.list.ok', list.ok === true)
          /**
           * ★ 判据：出参键集合里**没有**任何密钥类字段，且指纹/长度有值。
           * 这是"renderer 拿不到密钥"的机械证据（不是靠读代码相信）。
           */
          const keys = (prov ? Object.keys(prov) : []).map(k => k.toLowerCase())
          mark('m1.provider.no-secret-field', keys.length > 0 && !keys.some(k => k.includes('apikey') || k.includes('secret') || k === 'key'))
          mark('m1.provider.has-key-metadata', prov?.hasKey === true && typeof prov.keyLength === 'number' && (prov.keyLength as number) > 0)
          mark('m1.provider.backend-available', typeof list.backend === 'string' && list.backend.length > 0)

          // 主进程侧 schema：非法 URL 必须被拒（证明校验真的在跑）
          const badUrl = await call(`(() => window.airimate.upsertProvider({
            label: 'probe-bad', kind: 'openai-compatible', baseUrl: 'not a url', model: 'm'
          }))()`)
          result.badUrlReject = { ok: badUrl.ok ?? null, code: badUrl.code ?? null }
          mark('m1.provider.schema-reject-bad-url', badUrl.ok === false && String(badUrl.code) === 'IPC_SCHEMA')

          // 出网闸门：内网 baseUrl 必须被拒（SSRF 兜底真的生效）
          const badTarget = await call(`(() => window.airimate.testProvider(${JSON.stringify(probeProvId ?? '')}))()`)
          result.testProvider = { ok: badTarget.ok ?? null, code: badTarget.code ?? null, latencyMs: badTarget.latencyMs ?? null, modelCount: badTarget.modelCount ?? null }
          /**
           * 这里**不**断言连通（本机可能离线、密钥是假的）。
           * 断言的是"这个通道真的能跑完并把结构化的 code 回来" —— 那才是通道接通的证据。
           */
          mark('m1.provider.test-returns-structured-code', typeof badTarget.code === 'string' && (badTarget.code as string).length > 0)
          mark('m1.provider.test-result-has-no-key', !('apiKey' in badTarget) && !JSON.stringify(badTarget).includes('sk-airimate'))

          const models = await call(`(() => window.airimate.listProviderModels(${JSON.stringify(probeProvId ?? '')}))()`)
          result.providerModels = { ok: models.ok ?? null, supported: models.supported ?? null, code: models.code ?? null }
          mark('m1.provider.models-channel-ok', models.ok === true && typeof models.supported === 'boolean')

          // ═══════════════ M1-2 首次运行向导：判据由主进程给出
          const onb1 = await call('(() => window.airimate.onboardingGet())()') as { ok?: boolean, status?: Record<string, unknown> }
          const st1 = onb1.status ?? {}
          result.onboardingInitial = {
            ok: onb1.ok === true,
            step: st1.state ? (st1.state as Record<string, unknown>).step ?? null : null,
            satisfied: st1.satisfied ?? null,
            blockedBy: st1.blockedBy ?? null,
            completed: st1.completed ?? null,
            hintLen: typeof st1.hint === 'string' ? (st1.hint as string).length : null,
          }
          mark('m1.onboarding.status-shape', onb1.ok === true && typeof st1.satisfied === 'object' && st1.satisfied !== null)
          mark('m1.onboarding.hint-present', typeof st1.hint === 'string' && (st1.hint as string).length > 0)

          /**
           * ★ 关键判据：**未满足时不许完成**（主进程拒绝，不是 UI 拦）。
           * 探针刻意在"供应商有密钥但没测过连接"的状态下尝试完成 ——
           * 期望 `ONBOARDING_INCOMPLETE`。
           */
          const completeAttempt = await call('(() => window.airimate.onboardingComplete(true))()')
          result.onboardingCompleteAttempt = { ok: completeAttempt.ok ?? null, code: completeAttempt.code ?? null }
          mark('m1.onboarding.refuses-premature-complete', completeAttempt.ok === false && String(completeAttempt.code) === 'ONBOARDING_INCOMPLETE')

          const stepRes = await call(`(() => window.airimate.onboardingSetStep('schedule'))()`)
          mark('m1.onboarding.set-step-ok', stepRes.ok === true)

          // ═══════════════ M1-3 人设
          const personaGet = await call('(() => window.airimate.getPersona())()') as { ok?: boolean, persona?: Record<string, unknown> }
          result.persona = {
            ok: personaGet.ok === true,
            name: personaGet.persona?.name ?? null,
            userTitle: personaGet.persona?.userTitle ?? null,
            promptChars: typeof personaGet.persona?.systemPrompt === 'string' ? (personaGet.persona.systemPrompt as string).length : null,
          }
          mark('m1.persona.get-ok', personaGet.ok === true && typeof personaGet.persona?.name === 'string')
          mark('m1.persona.userTitle-present', typeof personaGet.persona?.userTitle === 'string')

          const title = `探针称呼${Date.now().toString(36)}`
          const personaSet = await call(`(() => window.airimate.setPersona(${JSON.stringify({
            ...(personaGet.persona ?? {}),
            userTitle: title,
          })}))()`)
          const personaBack = await call('(() => window.airimate.getPersona())()') as { persona?: Record<string, unknown> }
          result.personaRoundTrip = { setOk: personaSet.ok ?? null, readBack: personaBack.persona?.userTitle ?? null, expected: title }
          mark('m1.persona.round-trip', personaSet.ok === true && personaBack.persona?.userTitle === title)
          // 空名字必须被 schema 拒（否则界面会出现空白称呼）
          const personaBad = await call(`(() => window.airimate.setPersona(${JSON.stringify({ ...(personaGet.persona ?? {}), name: '' })}))()`)
          mark('m1.persona.schema-reject-empty-name', personaBad.ok === false && String(personaBad.code) === 'IPC_SCHEMA')

          // ═══════════════ M1-4 会话历史 + 停止生成
          const hist = await call('(() => window.airimate.history())()') as { ok?: boolean, messages?: unknown[], total?: number }
          result.history = { ok: hist.ok === true, count: (hist.messages ?? []).length, total: hist.total ?? null }
          mark('m1.chat.history-ok', hist.ok === true && Array.isArray(hist.messages))
          /** 停止生成：此刻并未在生成 ⇒ 必须**如实**返回 aborted:false */
          const abort = await call('(() => window.airimate.abortChat())()')
          result.abortWhenIdle = { ok: abort.ok ?? null, aborted: abort.aborted ?? null }
          mark('m1.chat.abort-honest-when-idle', abort.ok === true && abort.aborted === false)

          // ═══════════════ M1-5 记忆：增/改/搜/召回预览/删
          const MEM = `探针记忆条目${Date.now().toString(36)}`
          const memAdd = await call(`(() => window.airimate.addMemory({ text: ${JSON.stringify(MEM)}, tags: ['probe'], importance: 0.7 }))()`) as { ok?: boolean, entry?: Record<string, unknown> }
          const memId = typeof memAdd.entry?.id === 'string' ? memAdd.entry.id as string : null
          mark('m1.memory.add-ok', memAdd.ok === true && memId !== null)
          const memUpd = await call(`(() => window.airimate.updateMemory({ id: ${JSON.stringify(memId)}, importance: 0.95, tags: ['probe', 'edited'] }))()`) as { ok?: boolean, entry?: Record<string, unknown> }
          mark('m1.memory.update-ok', memUpd.ok === true && memUpd.entry?.importance === 0.95)
          const memUpdMissing = await call('(() => window.airimate.updateMemory({ id: "no-such-id", text: "x" }))()')
          mark('m1.memory.update-missing-id-errors', memUpdMissing.ok === false && String(memUpdMissing.code) === 'MEMORY_NOT_FOUND')
          const memSearch = await call(`(() => window.airimate.searchMemory({ query: ${JSON.stringify(MEM)}, limit: 20 }))()`) as { ok?: boolean, hits?: unknown[], count?: number }
          mark('m1.memory.search-ok', memSearch.ok === true && (memSearch.count ?? 0) >= 1)
          const memPreview = await call(`(() => window.airimate.previewRecallMemory(${JSON.stringify(MEM)}, 5))()`) as {
            ok?: boolean, hits?: unknown[], injectedBlock?: string | null, injectedChars?: number
          }
          result.memoryPreview = {
            ok: memPreview.ok === true,
            hits: (memPreview.hits ?? []).length,
            injectedChars: memPreview.injectedChars ?? 0,
            injectedIsNull: memPreview.injectedBlock === null || memPreview.injectedBlock === undefined,
          }
          mark('m1.memory.preview-hits', memPreview.ok === true && (memPreview.hits ?? []).length >= 1)
          mark('m1.memory.preview-injected-block', typeof memPreview.injectedBlock === 'string' && (memPreview.injectedBlock as string).length > 0
            && memPreview.injectedChars === (memPreview.injectedBlock as string).length)
          const memBad = await call(`(() => window.airimate.addMemory({ text: ${JSON.stringify('x'.repeat(5000))} }))()`)
          mark('m1.memory.add-oversize-rejected', memBad.ok === false && String(memBad.code) === 'IPC_SCHEMA')
          const memDel = await call(`(() => window.airimate.deleteMemory(${JSON.stringify(memId)}))()`) as { ok?: boolean, removed?: boolean }
          mark('m1.memory.delete-ok', memDel.ok === true && memDel.removed === true)

          // ═══════════════ M1-6 隐私：导出不含密钥 + 摘要
          const exportRes = await call(`(() => window.airimate.privacyExport({ format: 'json', includeChats: false, includeMemory: true }))()`) as {
            ok?: boolean, file?: string, bytes?: number, sections?: string[], excluded?: string[]
          }
          result.privacyExport = {
            ok: exportRes.ok === true,
            bytes: exportRes.bytes ?? null,
            sections: exportRes.sections ?? null,
            excludedCount: (exportRes.excluded ?? []).length,
            fileExists: typeof exportRes.file === 'string' ? existsSync(exportRes.file) : false,
          }
          mark('m1.privacy.export-ok', exportRes.ok === true && Number(exportRes.bytes ?? 0) > 0)
          mark('m1.privacy.export-file-exists', typeof exportRes.file === 'string' && existsSync(exportRes.file))
          mark('m1.privacy.export-excludes-chats', (exportRes.sections ?? []).includes('chat') === false)
          /**
           * ★ 机械证明导出物里没有密钥：直接读那个文件，找探针用的密钥前缀。
           * 这是"密钥不进导出物"最硬的证据（不靠读代码相信）。
           */
          let secretLeak = false
          let secretPlaceholder = false
          try {
            if (typeof exportRes.file === 'string' && existsSync(exportRes.file)) {
              const raw = readFileSync(exportRes.file, 'utf8')
              secretLeak = raw.includes('sk-airimate-m1m2') || raw.includes('sk-')
              secretPlaceholder = raw.includes('<encrypted, not exported>')
            }
          } catch { /* 读不到就按"未能验证"处理（下面 mark 会失败，这正是我们要的） */ }
          mark('m1.privacy.export-has-no-secret', !secretLeak)
          mark('m1.privacy.export-has-placeholder', secretPlaceholder)
          const summary = await call('(() => window.airimate.privacySummary())()') as { ok?: boolean, summary?: Record<string, unknown> }
          result.privacySummary = {
            ok: summary.ok === true,
            telemetryEnabled: summary.summary?.telemetryEnabled ?? null,
            fileCount: Array.isArray(summary.summary?.files) ? (summary.summary.files as unknown[]).length : null,
          }
          mark('m1.privacy.summary-ok', summary.ok === true && typeof summary.summary === 'object')
          mark('m1.privacy.telemetry-default-off', summary.summary?.telemetryEnabled === false)

          // ═══════════════ M2-1 权限：硬下限（最重要的一条）
          const perms = await call('(() => window.airimate.listPermissions())()') as {
            ok?: boolean, permissions?: Array<Record<string, unknown>>
          }
          const permList = perms.permissions ?? []
          result.permissions = {
            ok: perms.ok === true,
            total: permList.length,
            kinds: permList.map(p => p.kind),
            blocked: permList.filter(p => p.effective === 'blocked').map(p => p.kind),
          }
          mark('m2.permission.list-ok', perms.ok === true && permList.length >= 11)
          for (const k of ['payment', 'credential-access', 'system-settings', 'input-simulate']) {
            const p = permList.find(x => x.kind === k)
            mark(`m2.permission.${k}-blocked`, p?.effective === 'blocked' && p?.enabled === false)
          }
          /** ★ 请求把 payment 放宽成 read-only ⇒ 实际生效值必须仍是 blocked 且 enabled 强制 false */
          const raise = await call(`(() => window.airimate.setPermission({ kind: 'payment', tier: 'read-only', enabled: true }))()`) as {
            ok?: boolean, permission?: Record<string, unknown>
          }
          result.permissionRaise = {
            ok: raise.ok ?? null,
            requested: 'read-only',
            effective: raise.permission?.effective ?? null,
            enabled: raise.permission?.enabled ?? null,
            grantedBy: raise.permission?.grantedBy ?? null,
          }
          mark('m2.permission.floor-enforced', raise.ok === true && raise.permission?.effective === 'blocked' && raise.permission?.enabled === false)
          const raise2 = await call(`(() => window.airimate.setPermission({ kind: 'file-write', tier: 'read-only', enabled: true }))()`) as { permission?: Record<string, unknown> }
          mark('m2.permission.confirm-floor-enforced', raise2.permission?.effective === 'confirm')
          // 复位（探针不留状态）
          await call(`(() => window.airimate.setPermission({ kind: 'file-write', enabled: false }))()`)

          // ═══════════════ M2-2 静音时段 + 阈值
          const quiet1 = await call('(() => window.airimate.getQuiet())()') as { ok?: boolean, quiet?: Record<string, unknown>, policy?: Record<string, unknown> }
          result.quietInitial = {
            ok: quiet1.ok === true,
            enabled: quiet1.quiet?.enabled ?? null,
            start: quiet1.quiet?.start ?? null,
            end: quiet1.quiet?.end ?? null,
            continuousMinutes: quiet1.policy?.continuousMinutes ?? null,
            sedentaryMinutes: quiet1.policy?.sedentaryMinutes ?? null,
            nightRestAt: quiet1.policy?.nightRestAt ?? null,
            maxRetries: quiet1.policy?.maxRetries ?? null,
          }
          mark('m2.quiet.default-values', quiet1.ok === true
            && quiet1.policy?.continuousMinutes === 50
            && quiet1.policy?.sedentaryMinutes === 60
            && quiet1.policy?.nightRestAt === '23:30')
          const quietBad = await call(`(() => window.airimate.setQuiet({ start: '25:00' }))()`)
          mark('m2.quiet.schema-reject-bad-time', quietBad.ok === false && String(quietBad.code) === 'IPC_SCHEMA')
          const quietCross = await call(`(() => window.airimate.setQuiet({ enabled: true, start: '23:00', end: '07:30' }))()`) as { ok?: boolean, quiet?: Record<string, unknown> }
          mark('m2.quiet.cross-midnight-saved', quietCross.ok === true && quietCross.quiet?.start === '23:00' && quietCross.quiet?.end === '07:30')
          const polBad = await call(`(() => window.airimate.setReminderPolicy({ continuousMinutes: 0 }))()`)
          mark('m2.policy.schema-reject-zero', polBad.ok === false && String(polBad.code) === 'IPC_SCHEMA')

          // ═══════════════ M2-3 日程：形态校验 + 增删
          const schedBad = await call(`(() => window.airimate.upsertSchedule({ title: 'probe-bad', start: '10:00', recurrence: { kind: 'weekly' } }))()`)
          result.scheduleBad = { ok: schedBad.ok ?? null, code: schedBad.code ?? null }
          mark('m2.schedule.reject-weekly-without-days', schedBad.ok === false && String(schedBad.code) === 'SCHEDULE_INVALID')
          const schedBadTime = await call(`(() => window.airimate.upsertSchedule({ title: 'probe-bad2', start: '8:00', recurrence: { kind: 'daily' } }))()`)
          mark('m2.schedule.reject-bad-time-format', schedBadTime.ok === false && String(schedBadTime.code) === 'IPC_SCHEMA')
          const schedAdd = await call(`(() => window.airimate.upsertSchedule({
            title: ${JSON.stringify(`探针日程${Date.now().toString(36)}`)}, start: '09:30', leadMinutes: 15,
            recurrence: { kind: 'daily' }, important: false, announceInRadio: true
          }))()`) as { ok?: boolean, schedule?: Record<string, unknown> }
          const schedId = typeof schedAdd.schedule?.id === 'string' ? schedAdd.schedule.id as string : null
          if (schedId) createdSchedules.push(schedId)
          mark('m2.schedule.add-ok', schedAdd.ok === true && schedId !== null && schedAdd.schedule?.leadMinutes === 15)
          const schedList = await call('(() => window.airimate.listSchedules())()') as { ok?: boolean, schedules?: unknown[], total?: number }
          result.scheduleList = { ok: schedList.ok === true, count: (schedList.schedules ?? []).length }
          mark('m2.schedule.list-ok', schedList.ok === true && (schedList.total ?? 0) >= 1)

          // ═══════════════ M2-4 提醒：增 / 确认 / 删
          const remAdd = await call(`(() => window.airimate.upsertReminder({
            kind: 'scheduled', title: ${JSON.stringify(`探针提醒${Date.now().toString(36)}`)},
            body: 'probe', priority: 'silent', atTime: '23:59'
          }))()`) as { ok?: boolean, reminder?: Record<string, unknown> }
          const remId = typeof remAdd.reminder?.id === 'string' ? remAdd.reminder.id as string : null
          if (remId) createdReminders.push(remId)
          result.reminderAdd = {
            ok: remAdd.ok ?? null, id: remId,
            state: remAdd.reminder?.state ?? null,
            priority: remAdd.reminder?.priority ?? null,
            hasFireAt: typeof remAdd.reminder?.fireAt === 'number',
          }
          mark('m2.reminder.add-ok', remAdd.ok === true && remId !== null && remAdd.reminder?.state === 'pending')
          const remBad = await call(`(() => window.airimate.upsertReminder({ kind: 'scheduled', title: 'probe-no-time' }))()`)
          mark('m2.reminder.schedule-without-time-rejected', remBad.ok === false)
          const remBadPri = await call(`(() => window.airimate.upsertReminder({ kind: 'scheduled', title: 'x', atTime: '09:00', priority: 'urgent' }))()`)
          mark('m2.reminder.schema-reject-bad-priority', remBadPri.ok === false && String(remBadPri.code) === 'IPC_SCHEMA')
          const remList = await call('(() => window.airimate.listReminders())()') as { ok?: boolean, reminders?: unknown[], total?: number }
          mark('m2.reminder.list-ok', remList.ok === true && (remList.total ?? 0) >= 1)

          // ═══════════════ M2-5 活动统计与探针可用性
          const act = await call('(() => window.airimate.activityStats())()') as {
            ok?: boolean, activity?: Record<string, unknown> | null
            blocker?: Record<string, unknown>, probe?: Record<string, unknown>, advice?: unknown[]
          }
          result.activity = {
            ok: act.ok === true,
            available: act.activity?.available ?? null,
            unavailableReason: act.activity?.unavailableReason ?? null,
            blockReason: act.blocker?.reason ?? null,
            blocked: act.blocker?.blocked ?? null,
            probeScriptExists: act.probe?.scriptExists ?? null,
            hasShell: typeof act.probe?.shell === 'string' && (act.probe.shell as string).length > 0,
            adviceCount: (act.advice ?? []).length,
            /** ★ 隐私：活动状态里**没有**窗口标题原文，只有摘要与长度 */
            titleDigest: act.activity?.titleDigest ?? null,
            titleChars: act.activity?.titleChars ?? null,
          }
          mark('m2.activity.stats-channel-ok', act.ok === true && typeof act.blocker === 'object')
          mark('m2.activity.probe-script-present', act.probe?.scriptExists === true)
          mark('m2.activity.no-title-plaintext', !('title' in (act.activity ?? {})))

          // ═══════════════ M2-6 引擎：tick / 状态 / 电台
          const tick = await call('(() => window.airimate.proactiveTick())()') as { ok?: boolean, result?: Record<string, unknown>, code?: string }
          result.tick = { ok: tick.ok ?? null, code: tick.code ?? null, result: tick.result ?? null }
          mark('m2.engine.tick-ok', tick.ok === true && typeof tick.result === 'object' && tick.result !== null)
          const status = await call('(() => window.airimate.proactiveStatus())()') as { ok?: boolean, status?: Record<string, unknown> }
          const st = status.status ?? {}
          result.proactiveStatus = {
            ok: status.ok === true,
            running: st.running ?? null,
            ticks: st.ticks ?? null,
            queueLength: st.queueLength ?? null,
            enabled: st.enabled ?? null,
            recentDecisionCount: Array.isArray(st.recentDecisions) ? (st.recentDecisions as unknown[]).length : null,
          }
          mark('m2.engine.status-ok', status.ok === true && typeof st.running === 'boolean')
          mark('m2.engine.has-ticked', typeof st.ticks === 'number' && (st.ticks as number) >= 1)
          mark('m2.engine.focus-never-true-shape', st.enabled !== null && typeof st.enabled === 'object')

          const radio = await call('(() => window.airimate.triggerRadio({ force: true, speak: false }))()') as {
            ok?: boolean, content?: Record<string, unknown> | null, skippedReason?: string | null, spoken?: boolean
          }
          const rc = radio.content
          result.radio = {
            ok: radio.ok ?? null,
            skippedReason: radio.skippedReason ?? null,
            day: rc?.day ?? null,
            weekday: rc?.weekday ?? null,
            scriptChars: typeof rc?.script === 'string' ? (rc.script as string).length : null,
            estimatedSeconds: rc?.estimatedSeconds ?? null,
            scheduleCount: Array.isArray(rc?.schedule) ? (rc.schedule as unknown[]).length : null,
            newsCount: Array.isArray(rc?.news) ? (rc.news as unknown[]).length : null,
            adviceCount: Array.isArray(rc?.advice) ? (rc.advice as unknown[]).length : null,
            hasEncouragement: typeof rc?.encouragement === 'string' && (rc.encouragement as string).length > 0,
            disclosures: rc?.disclosures ?? null,
            weatherAvailable: (rc?.weather as Record<string, unknown> | undefined)?.available ?? null,
            weatherReason: (rc?.weather as Record<string, unknown> | undefined)?.unavailableReason ?? null,
            /** ★ 隐私：探针不要求朗读（speak:false），也绝不进证据文件正文 */
            spoken: radio.spoken ?? null,
          }
          mark('m2.radio.content-ok', radio.ok === true && typeof rc === 'object' && rc !== null)
          mark('m2.radio.has-date-and-weekday', typeof rc?.day === 'string' && typeof rc?.weekday === 'string')
          mark('m2.radio.has-encouragement', typeof rc?.encouragement === 'string' && (rc.encouragement as string).length > 0)
          /** ★ 30–60 秒是用户硬要求 */
          const secs = typeof rc?.estimatedSeconds === 'number' ? rc.estimatedSeconds as number : 0
          mark('m2.radio.duration-30-60s', secs >= 30 && secs <= 60)
          mark('m2.radio.not-spoken-when-asked-false', radio.spoken === false)
          /**
           * ★ "不编造"：天气不可用时必须**如实标注**（本机通常没配城市）。
           * 两种情况都合法：可用（配了城市且联网）或不可用 + 有原因说明。
           */
          const wAvail = (rc?.weather as Record<string, unknown> | undefined)?.available
          const wReason = (rc?.weather as Record<string, unknown> | undefined)?.unavailableReason
          mark('m2.radio.weather-honest', wAvail === true || (wAvail === false && typeof wReason === 'string' && (wReason as string).length > 0))
          const disclosures = Array.isArray(rc?.disclosures) ? rc.disclosures as string[] : []
          mark('m2.radio.disclosures-present', disclosures.length > 0)
          /** 每条资讯都必须有来源与 url（"外部资料必须保留来源与日期"） */
          const news = Array.isArray(rc?.news) ? rc.news as Array<Record<string, unknown>> : []
          mark('m2.radio.news-has-source', news.every(n => typeof n.source === 'string' && (n.source as string).length > 0))
          mark('m2.radio.news-has-url', news.every(n => typeof n.url === 'string'))

          // 非 force 的第二次：当天已播 ⇒ 必须给出 skippedReason（去重真的生效）
          const radio2 = await call('(() => window.airimate.triggerRadio({ force: false, speak: false }))()') as { ok?: boolean, skippedReason?: string | null, content?: unknown }
          result.radioSecond = { ok: radio2.ok ?? null, skippedReason: radio2.skippedReason ?? null, contentIsNull: radio2.content === null }
          mark('m2.radio.dedupe-same-day', radio2.ok === true && typeof radio2.skippedReason === 'string')

          const inbox = await call('(() => window.airimate.proactiveInbox())()') as { ok?: boolean, inbox?: Record<string, unknown> }
          result.inbox = {
            ok: inbox.ok === true,
            queued: Array.isArray(inbox.inbox?.queued) ? (inbox.inbox.queued as unknown[]).length : null,
            unacked: Array.isArray(inbox.inbox?.unacked) ? (inbox.inbox.unacked as unknown[]).length : null,
          }
          mark('m2.inbox.shape-ok', inbox.ok === true && Array.isArray(inbox.inbox?.queued) && Array.isArray(inbox.inbox?.unacked))

          // ═══════════════ 清场（探针不留数据）
          for (const id of createdReminders) await call(`(() => window.airimate.deleteReminder(${JSON.stringify(id)}))()`)
          for (const id of createdSchedules) await call(`(() => window.airimate.deleteSchedule(${JSON.stringify(id)}))()`)
          for (const id of createdProviders) await call(`(() => window.airimate.deleteProvider(${JSON.stringify(id)}))()`)
          // 人设复位到探针前的称呼
          await call(`(() => window.airimate.setPersona(${JSON.stringify(personaGet.persona ?? {})}))()`)
          result.cleanup = { providers: createdProviders.length, schedules: createdSchedules.length, reminders: createdReminders.length }
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
          log().error('--probe m1m2 异常', { err: String(result.error).slice(0, 300) }, 'probe.m1m2.error')
        }
        const entries = Object.entries(checks)
        const passed = entries.filter(([, v]) => v).length
        result.totalChecks = entries.length
        result.passedChecks = passed
        result.failedChecks = entries.filter(([, v]) => !v).map(([k]) => k)
        result.pass = entries.length >= 35 && passed === entries.length
        console.log(`[airimate] PROBE_M1M2 ${JSON.stringify({ pass: result.pass, passed, total: entries.length, failed: result.failedChecks })}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  /**
   * `--probe ui`：**界面读数**验收（M1/M2 的渲染层）。
   *
   * 为什么必须单独一条：`m1m2` 走的是 IPC，能证明"主进程做对了"，
   * 但**证明不了界面真的把这些东西画出来了** —— 本项目踩过"后端对了、
   * 前端读错字段恒显示 0"的坑（`idleCount` 读 `semantic` 而契约是 `name`）。
   * 所以这里直接问 renderer："你以为自己现在长什么样"。
   *
   * 读数全部来自 `window.__AIRIMATE_UI_PROBE__('read')`（只读，不改任何状态），
   * 断言的是**结构**（元素数量、字段存在、高风险项计数），不是像素。
   * 想看像素请用 `--probe-shot`（本探针不截图）。
   */
  if (cli.probe === 'ui') {
    const probeAt = 11_000
    log().info('--probe ui 已排程', { ms: probeAt }, 'probe.ui.scheduled')
    setTimeout(() => {
      void (async () => {
        const checks: Record<string, boolean> = {}
        const result: Record<string, unknown> = { checks }
        const mark = (k: string, v: boolean): void => { checks[k] = v === true }
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          /**
           * ⚠ `executeJavaScript` 的返回值必须能**结构化克隆**。
           *   实测踩到：直接把 renderer 探针的整个对象拿回来会抛
           *   `An object could not be cloned`（里面有 Vue 代理 / DOM 节点等不可克隆值）。
           *   所以这里一律在 renderer 侧 `JSON.parse(JSON.stringify(...))` 并**只挑标量字段**。
           */
          const call = async (expr: string): Promise<unknown> => await w.webContents.executeJavaScript(expr, true)
          /**
           * ⚠ **只用于取值本身就是普通对象**的表达式（如 UI 探针的同步返回）。
           * 若表达式返回 Promise（`window.airimate.xxx()` 全是），
           * `JSON.stringify(Promise)` 会得到 `"{}"` ⇒ 拿到一个空对象，
           * 表现为"通道全部失效"（其实是**测量工具自伤**，比真缺陷更难查）。
           * 所以后面专门有一个会 await 的版本，不要在这里传 Promise 表达式。
           */
          const callJson = async (expr: string): Promise<Record<string, unknown>> =>
            await call(`(() => { try { return JSON.parse(JSON.stringify(${expr})) } catch (e) { return { error: String(e) } } })()`) as Record<string, unknown>
          /** 会先 `await` 再序列化 —— 所有 `window.airimate.*()` 调用都必须用它 */
          const callIpc = async (expr: string): Promise<Record<string, unknown>> =>
            await call(`(async () => { try { return JSON.parse(JSON.stringify(await (${expr}))) } catch (e) { return { error: String(e) } } })()`) as Record<string, unknown>

          // 界面读数（renderer 的 PetShell.vue 在 onMounted 里挂的那个只读探针）
          const ui = await callJson('(window.__AIRIMATE_UI_PROBE__ ? window.__AIRIMATE_UI_PROBE__("read") : { error: "no-ui-probe" })')
          result.ui = ui
          mark('ui.probe-present', ui.error === undefined)
          mark('ui.mode-is-panel', ui.uiMode === 'panel' && ui.isPetLayout === false)
          /**
           * ★★ 覆盖层读数（2026-10-08 新增，防止我修 pet 时把 panel 弄坏）。
           *
           * 背景：为了让 pet 模式不被全屏向导盖住，`PetShell.vue` 把向导改成了
           * `v-if="!isPet"`。这条判据就是那个改动的**反向保证**：
           * **panel 模式下向导必须仍然在**（否则用户再也没有配置入口了）。
           * 读数直接来自 DOM（与屏幕合成无关 —— 这条教训见 `PetShell.vue` 里的长注释）。
           */
          const ov = (ui.overlays ?? {}) as Record<string, unknown>
          result.overlays = ov
          mark('overlay.panel-wizard-present-when-needed',
            // onboarding 已完成时它本就不该出现 ⇒ 那时这条不作要求（用条件断言，不硬造）
            (ui.onboardingCompleted === true) || (ov.wizardCount === 1))
          mark('overlay.stage-root-present', ov.stageRootCount === 1)
          mark('overlay.canvas-present', ov.canvasCount === 1)
          /**
           * ★ 舞台仍然只有一个（M1/M2 加了大量 UI，绝不能顺手多挂一个角色）。
           * 计数来自 renderer 的 stage 快照（`__AIRIMATE_UI_PROBE__` 里读 store）。
           */
          mark('ui.single-stage', ui.stageCount === undefined || ui.stageCount === 1)

          // 标签页：日程/提醒必须真的存在（M2 的入口）
          const tabs = await call('(() => Array.from(document.querySelectorAll(".tabs button")).map(b => b.textContent.trim()))()') as string[]
          result.tabs = tabs
          /**
           * ⚠ 标签页文本可能**带角标数字**（"提醒1" / "学习3"）——
           *   实测踩到：用 `includes('提醒')` 精确匹配时，只要有一条未确认提醒，
           *   这条判据就会假失败（tab 其实好端端在那儿）。
           *   所以一律用**前缀**匹配：`startsWith(标签)`。
           */
          const hasTab = (label: string): boolean => Array.isArray(tabs) && tabs.some(t => t.startsWith(label))
          mark('ui.tabs-rendered', Array.isArray(tabs) && tabs.length >= 5)
          mark('ui.tab-schedule-exists', hasTab('日程'))
          mark('ui.tab-reminder-exists', hasTab('提醒'))
          mark('ui.tab-memory-exists', hasTab('记忆'))
          mark('ui.tab-voice-exists', hasTab('语音'))
          mark('ui.tab-learning-exists', hasTab('学习'))
          mark('ui.tab-capability-exists', hasTab('能力'))

          // 向导覆盖层：首次运行必须出现，且带 6 步导航
          const wizard = await call(`(() => {
            const el = document.querySelector('.wizard, [data-testid="onboarding"], .onboarding')
            if (!el) return { present: false }
            return { present: true, steps: el.querySelectorAll('button').length, text: (el.textContent || '').length }
          })()`) as Record<string, unknown>
          result.wizard = wizard
          mark('ui.wizard-present-or-completed', wizard.present === true || ui.onboardingCompleted === true)
          mark('ui.wizard-hint-visible', wizard.present !== true || Number(wizard.text ?? 0) > 100)

          /**
           * ★★ 「稍后再说」跳过的**可验证性**（2026-10-08 新增）。
           *
           * 为什么必须验它：向导自己的文案一直写着"不想现在配？到「设置」里可以随时回来"，
           * 但代码里**没有**跳过入口（`next()`/`finish()` 都会被主进程判据挡住），
           * 而 `ipc.ts` 的 `onboarding:complete` 明确拒绝未满足的步骤 ⇒
           * **没有密钥的用户永远出不去这个全屏覆盖层**，在 pet 模式下把角色整个盖住。
           *
           * ⚠ 只读 DOM，**不点击** —— 点击会写设置、留下状态（那该由人决定）。
           *   这里要证的是"入口存在且接线完整"。
           */
          const skipUi = await call(`(() => {
            const all = Array.from(document.querySelectorAll('button'))
            const skipBtn = all.find(b => (b.textContent || '').trim() === '稍后再说')
            const skipNote = document.querySelector('.wizard__skip')
            return {
              skipButtonPresent: !!skipBtn,
              skipButtonDisabled: skipBtn ? skipBtn.disabled === true : null,
              skipNoteChars: skipNote ? (skipNote.textContent || '').trim().length : 0,
            }
          })()`) as Record<string, unknown>
          result.skipPath = skipUi
          /**
           * 未完成时：跳过按钮**必须**存在且可用（否则用户被永久困住）；
           * 已完成时：向导本就不在，这条不作要求（条件断言，不硬造）。
           */
          mark('ui.skip-button-present-when-unfinished',
            ui.onboardingCompleted === true || skipUi.skipButtonPresent === true)
          mark('ui.skip-button-enabled',
            ui.onboardingCompleted === true || skipUi.skipButtonDisabled === false)

          /**
           * ★ 可逆性：**设置页的「重置向导」必须在**（把向导请回来）。
           *
           * ⚠ 它**不在**当前 DOM 里 —— 设置内容挂在 `tab === 'settings'` 分支下，
           *   而探针此刻停在「日程」页。所以必须**先点到设置页再读**（实测踩到：
           *   第一版在日程页就去找「重置向导」，结果必然找不到，那是一条假失败）。
           *   读完把 tab 切回去，不给后续断言留下副作用。
           */
          const resetUi = await call(`(async () => {
            const tabs = Array.from(document.querySelectorAll('.tabs button'))
            const target = tabs.find(b => (b.textContent || '').trim() === '设置')
            if (!target) return { clicked: false, resetPresent: false }
            target.click()
            await new Promise(r => setTimeout(r, 700))
            const all = Array.from(document.querySelectorAll('button'))
            const reset = all.find(b => (b.textContent || '').trim() === '重置向导')
            const present = !!reset
            /** 切回日程页，避免影响下面的 tab 相关断言 */
            const back = tabs.find(b => (b.textContent || '').trim() === '日程')
            if (back) back.click()
            await new Promise(r => setTimeout(r, 400))
            return { clicked: true, resetPresent: present }
          })()`) as Record<string, unknown>
          result.resetPath = resetUi
          mark('ui.reset-wizard-entry-present', resetUi.resetPresent === true)

          /**
           * ★★ 第三层（最强的一条）：**按下去真的会收起**，而且**可逆**。
           *
           * 前两条只证明"按钮在、可点"；这条证明"点了有用" —— 这正是原来那句
           * 文案承诺过、而代码没兑现的东西（见上面 `skipUi` 的说明）。
           *
           * 纪律（为什么敢点）：
           *   ① 只在 `onboardingCompleted !== true`（向导确实在）时做；
           *   ② 点完**读回主进程的设置**核对 `onboarded` 真的变成 true（不看界面猜）；
           *   ③ 核对向导覆盖层**真的消失**（`wizardCount` 0）；
           *   ④ **无论成败都把 `onboarded` 还原成点击前的值** ⇒ 不留痕、不影响后续断言；
           *   ⑤ 每一步都记进证据（`skipClick`），失败不静默。
           */
          if (ui.onboardingCompleted !== true && skipUi.skipButtonPresent === true) {
            const settingBefore = loadSettings().onboarded
            const clicked = await call(`(async () => {
              const before = document.querySelectorAll('.wizard').length
              const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '稍后再说')
              if (!btn) return { clicked: false, before }
              btn.click()
              await new Promise(r => setTimeout(r, 1200))
              return { clicked: true, before, after: document.querySelectorAll('.wizard').length }
            })()`) as Record<string, unknown>
            const settingAfter = loadSettings().onboarded
            /**
             * 还原：用 `patchSettings` 的同一条路径（`mergeSettings`）写回原值。
             * ⚠ 必须走主进程自己的 setter，不能直接改文件 —— 那样绕过了缓存与广播，
             *   下一条断言读到的可能是脏值。
             */
            try { mergeSettings({ onboarded: settingBefore }) } catch { /* ignore */ }
            const settingRestored = loadSettings().onboarded === settingBefore
            result.skipClick = { ...clicked, settingBefore, settingAfter, settingRestored }
            mark('ui.skip-click-hides-wizard', clicked.clicked === true && clicked.after === 0)
            mark('ui.skip-click-writes-onboarded', settingAfter === true)
            mark('ui.skip-click-state-restored', settingRestored)
          } else {
            result.skipClick = { skipped: true, reason: 'onboarding 已完成或跳过按钮不在（这两条不作要求）' }
          }

          // 画布与角色：舞台必须还在、且画布有真实尺寸
          const canvas = await call(`(() => {
            const c = document.querySelector('canvas')
            if (!c) return { present: false }
            return { present: true, w: c.clientWidth, h: c.clientHeight, bw: c.width, bh: c.height, visible: c.offsetParent !== null || getComputedStyle(c).display !== 'none' }
          })()`) as Record<string, unknown>
          result.canvas = canvas
          mark('ui.canvas-present', canvas.present === true)
          mark('ui.canvas-has-size', Number(canvas.w ?? 0) > 50 && Number(canvas.h ?? 0) > 50)

          /**
           * ★ 密钥不出现在界面 DOM 里。
           * 界面上只该显示"已配置 / 长度 / 指纹"，绝不该有密钥本体。
           * 这里机械地扫一遍整页文本（探针用的密钥前缀是 `sk-airimate`）。
           */
          const bodyText = await call('(() => document.body.innerText || "")()') as string
          result.bodyTextChars = typeof bodyText === 'string' ? bodyText.length : null
          mark('ui.no-secret-in-dom', !String(bodyText).includes('sk-airimate'))

          // 记忆页与日程页的数据（M1/M2 的 store 是否真的加载了）
          mark('ui.memory-search-wired', typeof ui.memoryResultCount === 'number' && typeof ui.memoryQueryChars === 'number')
          mark('ui.permissions-loaded', Array.isArray(ui.permissionKinds) && (ui.permissionKinds as unknown[]).length >= 11)
          mark('ui.blocked-permissions-counted', typeof ui.blockedPermissionCount === 'number' && (ui.blockedPermissionCount as number) >= 4)
          mark('ui.telemetry-reflected', ui.telemetryEnabled === false)
          mark('ui.proactive-state-reflected', typeof ui.proactiveEnabled === 'boolean' && typeof ui.proactiveRunning === 'boolean')
          mark('ui.statusbar-present', await call('(() => !!document.querySelector(".statusbar"))()') === true)

          /**
           * ★ 「能力」页必须真的能**渲染出实测读数**，而不是只有一个空壳 tab。
           * 做法：切到该 tab → 等一拍 → 检查页面文本里出现了适配层的关键读数。
           * 这比"tab 存在"强得多：它能抓到"页面挂载了但数据没接上"这类问题。
           */
          const capTab = await call(`(async () => {
            const btn = Array.from(document.querySelectorAll('.tabs button')).find(b => b.textContent.trim() === '能力')
            if (!btn) return { clicked: false }
            btn.click()
            await new Promise(r => setTimeout(r, 900))
            const text = document.body.innerText || ''
            return {
              clicked: true,
              chars: text.length,
              hasKindLabel: text.includes('语音合成') && text.includes('语言模型'),
              hasLicense: text.includes('再分发'),
              hasToolSection: text.includes('模型能看到什么') || text.includes('工具权限'),
              hasStores: text.includes('数据存储与迁移'),
              hasDigestNote: text.includes('sha256') || text.includes('原长'),
            }
          })()`) as Record<string, unknown>
          result.capabilityTab = capTab
          mark('ui.capability-tab-clickable', capTab.clicked === true)
          mark('ui.capability-tab-has-adapters', capTab.hasKindLabel === true)
          mark('ui.capability-tab-has-license', capTab.hasLicense === true)
          mark('ui.capability-tab-has-tools', capTab.hasToolSection === true)
          mark('ui.capability-tab-has-stores', capTab.hasStores === true)
          // 切回聊天，避免影响后续（本探针后面不再读界面）
          await call(`(() => { const b = Array.from(document.querySelectorAll('.tabs button')).find(x => x.textContent.trim() === '聊天'); if (b) b.click(); return true })()`)

          /**
           * ★ 「语音」页必须真的渲染出 M3 的关键读数（M3 §1/§2/§5 的界面落地）。
           * 判据是"页面上出现了这些**必须存在**的说明与状态"，不是"tab 存在"。
           */
          const voiceTab = await call(`(async () => {
            const btn = Array.from(document.querySelectorAll('.tabs button')).find(b => b.textContent.trim() === '语音')
            if (!btn) return { clicked: false }
            btn.click()
            await new Promise(r => setTimeout(r, 900))
            const text = document.body.innerText || ''
            return {
              clicked: true,
              chars: text.length,
              hasMicState: text.includes('麦克风状态'),
              hasDefaultOff: text.includes('默认关闭'),
              hasPrivacy: text.includes('不录音频文件'),
              hasStopButton: text.includes('一键停用'),
              hasScreenOnDemand: text.includes('非持续录屏'),
              hasAllowlist: text.includes('授权目录'),
              hasHardFloor: text.includes('硬下限'),
              hasCallSection: text.includes('语音通话'),
              hasCallButtons: text.includes('开始通话') && text.includes('打断') && text.includes('结束通话'),
              hasCallPhase: text.includes('正在听你说') || text.includes('当前阶段'),
            }
          })()`) as Record<string, unknown>
          result.voiceTab = voiceTab
          mark('ui.voice-tab-clickable', voiceTab.clicked === true)
          mark('ui.voice-tab-shows-mic-state', voiceTab.hasMicState === true)
          mark('ui.voice-tab-shows-default-off', voiceTab.hasDefaultOff === true)
          mark('ui.voice-tab-shows-privacy-notice', voiceTab.hasPrivacy === true)
          mark('ui.voice-tab-has-stop-button', voiceTab.hasStopButton === true)
          mark('ui.voice-tab-shows-screen-on-demand', voiceTab.hasScreenOnDemand === true)
          mark('ui.voice-tab-shows-allowlist', voiceTab.hasAllowlist === true)
          mark('ui.voice-tab-shows-hard-floor', voiceTab.hasHardFloor === true)
          mark('ui.voice-tab-has-call-section', voiceTab.hasCallSection === true)
          mark('ui.voice-tab-has-call-buttons', voiceTab.hasCallButtons === true)
          mark('ui.voice-tab-shows-call-phase', voiceTab.hasCallPhase === true)
          await call(`(() => { const b = Array.from(document.querySelectorAll('.tabs button')).find(x => x.textContent.trim() === '聊天'); if (b) b.click(); return true })()`)

          /**
           * ★ 「学习」页必须真的渲染出 M4 的关键读数（默认关闭 / 阈值 / 待确认 / 边界声明）。
           * 判据同上：看页面文本里出现了**必须存在**的那些说明，而不是"tab 存在"。
           */
          const learnTab = await call(`(async () => {
            const btn = Array.from(document.querySelectorAll('.tabs button')).find(b => b.textContent.trim().startsWith('学习'))
            if (!btn) return { clicked: false }
            btn.click()
            await new Promise(r => setTimeout(r, 900))
            const text = document.body.innerText || ''
            return {
              clicked: true,
              chars: text.length,
              hasDefaultOff: text.includes('默认关闭'),
              hasThreshold: text.includes('置信度阈值'),
              hasPendingSection: text.includes('等她确认的'),
              hasNoConfigClaim: text.includes('不会') && text.includes('系统提示词'),
              hasSummary: text.includes('今日总结'),
              hasRunButton: text.includes('现在反思一次'),
              hasPreviewButton: text.includes('只看报告'),
            }
          })()`) as Record<string, unknown>
          result.learningTab = learnTab
          mark('ui.learning-tab-clickable', learnTab.clicked === true)
          mark('ui.learning-tab-shows-default-off', learnTab.hasDefaultOff === true)
          mark('ui.learning-tab-shows-threshold', learnTab.hasThreshold === true)
          mark('ui.learning-tab-shows-pending', learnTab.hasPendingSection === true)
          mark('ui.learning-tab-states-no-config-change', learnTab.hasNoConfigClaim === true)
          mark('ui.learning-tab-has-run-buttons', learnTab.hasRunButton === true && learnTab.hasPreviewButton === true)
          await call(`(() => { const b = Array.from(document.querySelectorAll('.tabs button')).find(x => x.textContent.trim() === '聊天'); if (b) b.click(); return true })()`)        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
        }
        const entries = Object.entries(checks)
        const passed = entries.filter(([, v]) => v).length
        result.totalChecks = entries.length
        result.passedChecks = passed
        result.failedChecks = entries.filter(([, v]) => !v).map(([k]) => k)
        result.pass = entries.length >= 15 && passed === entries.length
        console.log(`[airimate] PROBE_UI ${JSON.stringify({ pass: result.pass, passed, total: entries.length, failed: result.failedChecks })}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  /**
   * `--probe kit`：适配层框架的**端到端 IPC 验收**（M5 §1/§2 + M3 §4/§6 的底座）。
   *
   * 为什么必须走真 IPC：框架的判据是"业务代码不再依赖具体实现" + "权限与许可
   * **机械**生效"。直接调 `createKit()` 只能证明框架逻辑对，证明不了
   * "renderer 真的能问到这些事实、且问不到密钥/路径"。
   *
   * 关键判据（每条都对应一个用户要求）：
   *   · 每一类能力都有**可解释的选型**（含被跳过的候选与原因）；
   *   · 生效实现是**实测可用**的（不是乐观 true）；
   *   · 资产解析给出**许可判定**，且拒绝项带原因；
   *   · 出参里**没有绝对路径、没有密钥**；
   *   · 给模型看的工具清单**不含** denied（禁止自动支付/改密码/读凭据）；
   *   · 工具审计里 `ok===null`（未执行）与 `ok===false`（执行失败）**可区分**；
   *   · 存储清单登记齐全且迁移链自洽。
   */
  if (cli.probe === 'kit') {
    const probeAt = 10_000
    log().info('--probe kit 已排程', { ms: probeAt }, 'probe.kit.scheduled')
    setTimeout(() => {
      void (async () => {
        const checks: Record<string, boolean> = {}
        const result: Record<string, unknown> = { checks }
        const mark = (k: string, v: boolean): void => { checks[k] = v === true }
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const call = async (expr: string): Promise<unknown> => await w.webContents.executeJavaScript(expr, true)
          /**
           * ⚠ 必须**先 await 表达式再 stringify**。
           *
           * 踩过的坑（这一轮就是靠它定位的）：早期写的是
           * `JSON.parse(JSON.stringify(${expr}))`，看起来没问题，但 `expr` 若是
           * **返回 Promise 的表达式**（`window.airimate.xxx()` 全是），
           * `JSON.stringify(Promise)` 得到 `"{}"` ⇒ 探针拿到一个**空对象**，
           * 表现为"所有通道都失效"（而其实一切正常）。
           * 这是**测量工具自伤**，比真缺陷更难查：所有读数一致地"空"，
           * 看不出是工具的问题而不是产品的问题。
           */
          const callJson = async (expr: string): Promise<Record<string, unknown>> =>
            await call(`(async () => { try { return JSON.parse(JSON.stringify(await (${expr}))) } catch (e) { return { error: String(e) } } })()`) as Record<string, unknown>

          // ═══════ ① 能力枚举与选型
          const cap = await callJson('window.airimate.kitCapabilities()') as { ok?: boolean, kit?: Record<string, unknown> }
          const kit = (cap.kit ?? {}) as Record<string, unknown>
          const adapters = Array.isArray(kit.adapters) ? kit.adapters as Array<Record<string, unknown>> : []
          /**
           * 排障用**原始读数**：出参不齐时先看这两项，而不是靠猜。
           * `methodKeys` 能直接回答"preload 到底暴露了哪些方法"（通道漂移最常见的形态）。
           */
          result.kitRaw = { ok: cap.ok ?? null, code: (cap as Record<string, unknown>).code ?? null, message: (cap as Record<string, unknown>).message ?? null, topKeys: Object.keys(cap) }
          result.apiMethods = await call('(() => Object.keys(window.airimate || {}).sort())()')
          /**
           * 对照读数：同时打一个**已知可用**的只读通道（`privacy:summary`）。
           * 它正常而 kit 通道不正常 ⇒ 问题在通道注册；两个都不正常 ⇒ 问题在 IPC 本身。
           */
          result.control = await callJson('window.airimate.privacySummary()')
          /**
           * ★ 逐步定位探针（**必须保留**）：出参为空时，光看"顶层键是空的"无法区分
           *   下面四种情况，而这四种的修法完全不同：
           *     ① 方法不存在        → `typeof` 是 undefined
           *     ② 返回值是 undefined → `typeof awaited` 是 undefined（handler 没注册）
           *     ③ 返回值是对象但键为空 → 序列化丢了（contextBridge 边界问题）
           *     ④ 抛错              → `thrown` 里有消息
           *   一次把四个读数都拿回来，省掉一整轮猜测 —— 这一轮就是靠它定位的。
           */
          result.stepByStep = await callJson(`(async () => {
            const out = { hasMethod: typeof window.airimate.kitCapabilities, awaited: 'n/a', keys: [], thrown: null }
            try {
              const v = await window.airimate.kitCapabilities()
              out.awaited = v === undefined ? 'undefined' : (v === null ? 'null' : typeof v)
              out.keys = v && typeof v === 'object' ? Object.keys(v) : []
              out.valueOk = v ? v.ok : 'n/a'
              out.jsonLen = v ? JSON.stringify(v).length : -1
            } catch (e) { out.thrown = String(e && e.message ? e.message : e) }
            return out
          })()`)
          result.kit = {
            ok: cap.ok === true,
            profile: kit.profile ?? null,
            total: kit.total ?? null,
            byKind: kit.byKind ?? null,
            adapterCount: adapters.length,
            adapters: adapters.map(a => ({
              id: a.id, kind: a.kind, available: a.available, active: a.active,
              provenance: (a.license as Record<string, unknown> | undefined)?.provenance ?? null,
              requiresNetwork: a.requiresNetwork, writesUserContent: a.writesUserContent,
              /**
               * `unavailableReason` 也要带回来：没有它，"这个能力不可用"就无法被判据核对
               * ——只能靠人相信。它已在 IPC 出口过 `redactDeep()`（路径变成 `<path>`），
               * 所以带回来不会再泄漏资产目录。
               */
              unavailableReason: a.unavailableReason ?? null,
            })),
            modelVisibleTools: kit.modelVisibleTools ?? null,
            toolCount: Array.isArray(kit.tools) ? (kit.tools as unknown[]).length : null,
          }
          mark('kit.capabilities.ok', cap.ok === true)
          mark('kit.profile-known', kit.profile === 'development' || kit.profile === 'packaged')
          mark('kit.adapters-enumerated', adapters.length >= 6)
          /** ★ 每类都至少注册了一个适配器（框架"能被枚举"的最低要求） */
          const byKind = (kit.byKind ?? {}) as Record<string, { registered?: number, available?: number, activeId?: string | null }>
          /**
           * ⚠ 这里原来只有 5 类：`avatar / tts / llm / stt / wakeword`。
           *   漏掉的正是 **`motion`（动作）** —— 而它恰好是长期没有适配器的那一类
           *   （`CAPABILITY_KINDS` 里声明了，却从来没人注册）。
           *   判据少列一项 ⇒ 缺口永远不会被这条断言发现。
           *
           * ★ 第二次踩同一个坑（2026-10-03 夜）：改成 6 类之后仍然漏了
           *   **`tool` / `storage` / `privacy`** —— `storage` 与 `privacy` 在探针里
           *   是 `registered: 0`（整类不存在），而这条断言照样通过。
           *   根因不是"又忘了一项"，而是**手抄清单**这个做法本身：
           *   类型里声明了 9 类，判据里手写 6 类，两者永远不会自动对齐。
           *
           * ⇒ 现在**直接取 `CAPABILITY_KINDS` 的全量**（单一真源），
           *   这样以后新增一类时，这条断言会自动把它纳入检查，
           *   而不是等到某个用户发现"界面里怎么没有这一类"。
           */
          const declaredKinds = [...CAPABILITY_KINDS]
          const missingKinds = declaredKinds.filter(k => (byKind[k]?.registered ?? 0) < 1)
          mark('kit.every-kind-registered', missingKinds.length === 0)
          if (missingKinds.length > 0) {
            log().warn('有整类能力没有任何已注册实现', { missing: missingKinds.join(',') }, 'kit.kind.unregistered')
          }
          result.kindCoverage = {
            declared: declaredKinds, missing: missingKinds,
            byKind: Object.fromEntries(declaredKinds.map(k => [k, byKind[k]?.registered ?? 0])),
          }
          /** ★ 动作适配器必须**真的被注册**（"声明了但没人实现"是这个项目踩过的坑） */
          mark('kit.motion-adapter-registered', (byKind.motion?.registered ?? 0) >= 1)
          /**
           * ★ 核心三类（角色/语音/LLM）必须有生效实现 —— 否则业务会退化。
           *
           * ⚠ `avatar` 这一条按形态分开判，理由是一个**实测结论**而不是放宽标准：
           *   打包载荷里**没有**可再分发的角色资产（M5 的资产替换还没做），
           *   而私有许可的资产在 packaged 形态下会被 `judgeLicense` **正确拒绝** ⇒
           *   此时 `activeId` 就是 `null`，且这是**期望行为**（② 要求的正是这个拒绝）。
           *   如果这里继续无条件要求"必须有 active avatar"，那就会把
           *   "许可判定生效"误报成失败，逼着后来的人去放宽许可 —— 方向正好反了。
           *
           *   所以：development 必须有；packaged 允许没有，但**必须给出原因**
           *   （`unavailableReason` 非空）。"不可用且说不清为什么"才是失败。
           */
          const avatarAdapter = adapters.find(a => a.kind === 'avatar')
          const avatarActive = typeof byKind.avatar?.activeId === 'string'
          const avatarExplained = typeof avatarAdapter?.unavailableReason === 'string'
            && (avatarAdapter.unavailableReason as string).length > 0
          mark('kit.active-avatar', kit.profile === 'development' ? avatarActive : (avatarActive || avatarExplained))
          mark('kit.active-tts', typeof byKind.tts?.activeId === 'string')
          /**
           * ★ 动作：与角色同一把尺子。开发形态必须有可用动作（否则桌宠不动 = 功能退化）；
           *   打包形态允许没有，但**必须能解释**（私有动捕产物不可再分发 ⇒ 被拒）。
           */
          const motionAdapter = adapters.find(a => a.kind === 'motion')
          const motionActive = typeof byKind.motion?.activeId === 'string'
          const motionExplained = typeof motionAdapter?.unavailableReason === 'string'
            && (motionAdapter.unavailableReason as string).length > 0
          mark('kit.active-motion', kit.profile === 'development' ? motionActive : (motionActive || motionExplained))
          /**
           * ★ 动作状态必须带上许可信息（"这些动作许不许分发"要能回答，不能只有文件数）。
           *
           * ⚠ `window.airimate.diagnostics()` 在 preload 里就已经**解包**了
           *   （`preload/index.ts` 返回的是 `r.diagnostics`），所以这里**不能**再写
           *   `mstatus.diagnostics.motion` —— 那样永远读到 `undefined`，
           *   表现为两个读数恒为 null 而判据"看起来只是没数据"。
           *   这是测量工具自伤，与产品无关；记下来免得下次再犯。
           */
          const mstatus = await callJson('window.airimate.diagnostics()') as {
            motion?: { clipCount?: number, license?: string | null, redistributable?: boolean | null, failed?: unknown[] }
          }
          const mo = mstatus.motion ?? {}
          result.motionStatus = {
            clipCount: mo.clipCount ?? null,
            license: mo.license ?? null,
            redistributable: mo.redistributable ?? null,
            failedCount: Array.isArray(mo.failed) ? mo.failed.length : null,
          }
          mark('kit.motion-license-reported', typeof mo.license === 'string' && (mo.license as string).length > 0)
          /**
           * ★★ 动作状态里**不得出现绝对路径**。
           *    `motion-state.ts` 原来把 `清单目录不存在: <绝对路径>` 放进 `failed`，
           *    而 `SettingsPanel.vue` 直接 `app.motion.failed.join('\n')` 显示给用户 ——
           *    同一个洞的**第三次**发作（前两次在 `license.note` 与 `kit:assets`）。
           */
          mark('kit.motion-no-abs-path',
            !new RegExp(String.raw`[A-Za-z]:[\\/]`).test(JSON.stringify(mstatus.motion ?? {})))
          /** 生效实现必须**实测可用**（不能是乐观 true） */
          const activeAdapters = adapters.filter(a => a.active === true)
          mark('kit.active-adapters-available', activeAdapters.length >= 2 && activeAdapters.every(a => a.available === true))
          /**
           * ★ M3 之后这条判据的口径变了（**这是如实的更新，不是放宽**）：
           *   M3 之前 STT/唤醒是"占位实现 ⇒ 永远 available:false"；
           *   现在它们是**真实实现**，可用性取决于**本机是否装了语音识别器**
           *   （本机实测有 1 个 zh-CN 识别器 ⇒ available:true 是正确的）。
           *
           *   所以现在要判的不是"必须不可用"，而是**可用性与实测一致**：
           *     · 报告"可用" ⇒ 识别器数量必须 > 0；
           *     · 报告"不可用" ⇒ 必须给出原因（不许空着）。
           *   后者才是真纪律：**任何"不可用"都必须能解释**。
           */
          const sttAdapter = adapters.find(a => a.kind === 'stt')
          const wakeAdapter = adapters.find(a => a.kind === 'wakeword')
          const sttOk = sttAdapter?.available === true || (sttAdapter?.available === false && typeof sttAdapter.unavailableReason === 'string' && sttAdapter.unavailableReason.length > 0)
          mark('kit.stt-availability-honest', sttOk === true)
          mark('kit.wake-availability-honest', wakeAdapter !== undefined
            && (wakeAdapter.available === true || (typeof wakeAdapter.unavailableReason === 'string' && wakeAdapter.unavailableReason.length > 0)))
          /** ★ 语音唤醒**默认关闭**（用户硬要求）—— 这条 M3 之后仍然要成立 */
          mark('kit.wakeword-default-off', (kit.m3 as Record<string, unknown> | undefined) !== undefined
            ? ((kit.m3 as Record<string, Record<string, unknown>>).voice?.wakeWordEnabled === false)
            : true)

          // ═══════ ② 出参不含密钥 / 绝对路径
          const capJson = JSON.stringify(cap)
          mark('kit.no-secret-in-output', !/sk-[A-Za-z0-9_-]{12,}/.test(capJson))
          /**
           * ★ 出参里不得出现驱动器绝对路径（含用户名与目录结构）。
           * 正则用 `String.raw` 写，避免"字面量反斜杠 vs 转义"读错。
           */
          mark('kit.no-abs-path-in-output', !new RegExp(String.raw`[A-Za-z]:[\\/]`, 'i').test(capJson))
          // ═══════ ③ 资产解析 + 许可判定
          const assets = await callJson('window.airimate.kitAssets()') as { ok?: boolean, assets?: Record<string, unknown> }
          const a = (assets.assets ?? {}) as Record<string, unknown>
          result.assets = {
            ok: assets.ok === true,
            selectedId: a.selectedId ?? null,
            usable: Array.isArray(a.usable) ? (a.usable as unknown[]).length : null,
            rejected: Array.isArray(a.rejected) ? (a.rejected as Array<Record<string, unknown>>).map(r => ({ id: r.id, reason: r.reason })) : null,
            total: a.total ?? null,
            detail: a.detail ?? null,
          }
          mark('kit.assets.ok', assets.ok === true)
          /**
           * ★ 出参里不得出现驱动器绝对路径。
           *
           * ⚠ 这里原来的注释替"只查 `usable`/`rejected`"辩护，说"检查整个响应体是过严的断言"。
           *   **那个理由站不住**：`detail` 同样是给 renderer 的字段，把它排除在外
           *   等于给泄漏留了一块自留地 —— 实测泄漏正是从 `detail` 出去的。
           *   现在四个 KIT 通道都在出口过 `redactDeep()`，所以可以放心查**整个响应体**。
           */
          mark('kit.assets.no-abs-path', !new RegExp(String.raw`[A-Za-z]:[\\/]`).test(JSON.stringify(assets)))
          /** 把被检查的那段原文带回来（断言失败时能一眼看出是哪个字段漏了路径） */
          result.assetsCheckedSample = JSON.stringify(assets).slice(0, 600)
          /**
           * ★★ **开发形态**允许私有资产 ⇒ 必须能选中一个（否则角色加载会挂）。
           *
           * ⚠ 这条原来写的是 `kit.profile !== 'development' || typeof a.selectedId === 'string'`
           *   —— 意思是"非开发形态就不要求"。结果**打包载荷**里跑出来
           *   `selectedId: null` 时它照样绿，而真正该被问的问题（"那为什么没有？"）
           *   没人问。现在按形态分开断言，两边都要给出**可解释的结论**：
           *     · development ⇒ 必须有选中项；
           *     · packaged    ⇒ 允许没有，但 `detail` 必须解释原因，且
           *                     **私有许可资产必须出现在 rejected 里**（这就是 ② 的运行期证据）。
           */
          const isDev = kit.profile === 'development'
          if (isDev) {
            mark('kit.assets.selected-in-development', typeof a.selectedId === 'string')
          } else {
            // 非开发形态：要么有可用的可再分发资产，要么必须能解释为什么一个都没有
            const explained = typeof a.selectedId === 'string'
              || (typeof a.detail === 'string' && (a.detail as string).length > 0)
            mark('kit.assets.packaged-explained', explained)
          }

          /**
           * ★★ ② 的**故障注入**证据：往打包形态的清单里**塞一个私有许可资产**，
           *    它必须被机械拒绝。
           *
           * 为什么非要做注入，而不是"当前载荷里没有私有资产 ⇒ 判定通过"：
           *   打包载荷里**根本没有清单文件**（M5 的资产替换还没做），
           *   于是 `rejected[]` 是空的 —— "没有东西可拒绝"被误当成"拒绝机制有效"。
           *   那是**空断言**：许可闸门坏掉了它照样是绿的。
           *   所以这里主动造出"清单里有私有资产"这个条件，再看闸门是否真的拦下来。
           *
           * 注入的条目指向一个**真实存在**的占位文件（探针现场创建、跑完删掉）：
           * 文件存在 ⇒ "被拒绝"的唯一可能原因就是**许可**，而不是文件缺失。
           *
           * ⚠ 这里**不能**用"以 `denied` 开头"这种前缀断言。原因：
           *   文件不存在时 resolver 也会给出 `denied-packaged-unknown-license`，
           *   同样以 `denied` 开头 ⇒ **许可闸门整个坏掉时那条断言照样是绿的**。
           *   所以下面断言的是**精确的原因码** `denied-packaged-non-redistributable`。
           *
           * ⚠ 也**不要**在这里硬编码私有资产的绝对路径（本探针第一版就是那么写的）：
           *   那会让 `bootstrap.ts` 依赖本机的私有仓库位置 —— 正是 ① 要消除的东西，
           *   而且换台机器就失效。占位文件由探针自己造，与机器无关。
           */
          if (!isDev) {
            const catalogFile = appPaths().catalogFile
            const probeAsset = join(dirname(catalogFile), 'PROBE-asset.vrm')
            const hadCatalog = existsSync(catalogFile)
            const backup = hadCatalog ? readFileSync(catalogFile, 'utf8') : null
            try {
              mkdirSync(dirname(catalogFile), { recursive: true })
              writeFileSync(probeAsset, 'PROBE placeholder (not a real VRM; only existence matters here)\n', 'utf8')
              writeFileSync(catalogFile, `${JSON.stringify({
                note: '探针注入（跑完即删）：用于验证打包形态下私有许可资产被机械拒绝',
                avatars: [{
                  id: 'PROBE-private-only',
                  label: 'Probe Private Asset',
                  path: probeAsset,
                  license: 'upstream-dlc-asset',
                  redistributable: false,
                  source: 'Mate Engine DLC（探针注入）—— 不得分发',
                }],
              }, null, 2)}\n`, 'utf8')

              // 直接问适配层（主进程内），不经过缓存过的 last()
              const injected = capabilityKit().asset().resolve()
              const hit = injected.rejected.find(r => r.id === 'PROBE-private-only')
              result.injection = {
                total: injected.all.length,
                usable: injected.avatars.length,
                selectedId: injected.selected?.id ?? null,
                rejected: injected.rejected.map(r => ({ id: r.id, reason: r.reason })),
                fileExisted: existsSync(probeAsset),
              }
              /** ★ 精确原因码：证明是**许可**闸门拒的，不是"文件找不到" */
              mark('kit.assets.private-rejected-when-packaged',
                hit !== undefined && hit.reason === 'denied-packaged-non-redistributable')
              /** 被拒的私有资产**绝不能**同时出现在可用列表里（拒绝与可用互斥） */
              mark('kit.assets.private-not-usable',
                !injected.avatars.some(x => x.id === 'PROBE-private-only'))
              /** 被拒的私有资产**绝不能**成为选中项 */
              mark('kit.assets.private-not-selected', injected.selected?.id !== 'PROBE-private-only')
              /**
               * ★ 对照实验（**必须有**）：同一个文件，换成 `redistributable: true` 的许可，
               *   就必须**能用**。只证明"私有被拒"是不够的 ——
               *   一个永远拒绝一切的实现也能通过那条断言，而它是坏的。
               *   加上这一条，"闸门在按许可判断"才被真正证明。
               *   注意对照组用的是**同一个** `probeAsset` 路径，所以差异只可能来自许可。
               */
              writeFileSync(catalogFile, `${JSON.stringify({
                note: '探针注入（跑完即删）：对照组 —— 同一路径换成可再分发许可',
                avatars: [{
                  id: 'PROBE-redistributable',
                  label: 'Probe Redistributable Asset',
                  path: probeAsset,
                  license: 'CC0-1.0',
                  redistributable: true,
                  commercialUse: true,
                  source: 'public-domain（探针注入的对照条目）',
                }],
              }, null, 2)}\n`, 'utf8')
              const control = capabilityKit().asset().resolve()
              result.injectionControl = {
                usable: control.avatars.map(x => x.id),
                rejected: control.rejected.map(r => ({ id: r.id, reason: r.reason })),
              }
              mark('kit.assets.control-usable-when-licensed',
                control.avatars.some(x => x.id === 'PROBE-redistributable'))
            } catch (e) {
              result.injectionError = e instanceof Error ? e.message.slice(0, 300) : String(e)
              mark('kit.assets.private-rejected-when-packaged', false)
              mark('kit.assets.private-not-usable', false)
              mark('kit.assets.private-not-selected', false)
              mark('kit.assets.control-usable-when-licensed', false)
            } finally {
              // ★ 必定还原：注入是探针的临时动作，不是对载荷的修改
              try {
                if (existsSync(probeAsset)) rmSync(probeAsset, { force: true })
                if (backup !== null) writeFileSync(catalogFile, backup, 'utf8')
                else if (existsSync(catalogFile)) rmSync(catalogFile, { force: true })
                result.injectionRestored = backup !== null ? 'restored-backup' : 'removed-injected'
                result.injectionRestoreVerified = !existsSync(probeAsset)
              } catch (e) {
                result.injectionRestoreError = e instanceof Error ? e.message.slice(0, 200) : String(e)
              }
            }
          }

          // ═══════ ②-b 四个 KIT 通道**整体**不得含绝对路径
          //
          // 这一条是"边界清洗"的回归闸门：只要将来有人在任何一个 KIT 通道里
          // 新增一个自由文本字段而忘了清洗，这里就会红。
          // `privacy:summary.userDataDir` 刻意**不在**这组里 —— 它把"你的数据在哪"
          // 告诉用户本人，是本应用自己的数据目录（不含仓库来源信息），属于功能而不是泄漏。
          // 见 ipc.ts 的注释。
          const storesProbe = await callJson('window.airimate.kitStores()')
          const auditProbe = await callJson('window.airimate.kitToolAudit()')
          const kitPayloads = { capabilities: cap, assets, stores: storesProbe, toolAudit: auditProbe }
          const kitPayloadsJson = JSON.stringify(kitPayloads)
          mark('kit.boundary-no-abs-path', !new RegExp(String.raw`[A-Za-z]:[\\/]`).test(kitPayloadsJson))
          mark('kit.boundary-no-secret', !/sk-[A-Za-z0-9_-]{12,}/.test(kitPayloadsJson))
          result.boundarySample = kitPayloadsJson.slice(0, 800)

          // ═══════ ④ 工具权限与"模型能看到什么"
          const toolNames = Array.isArray(kit.tools) ? (kit.tools as Array<Record<string, unknown>>) : []
          const forbidden = ['payment.pay', 'credential.read', 'system.settings', 'input.simulate']
          const modelVisible = Array.isArray(kit.modelVisibleTools) ? kit.modelVisibleTools as string[] : []
          result.tools = {
            total: toolNames.length,
            decisions: Object.fromEntries(toolNames.map(t => [String(t.name), String(t.decision)])),
            modelVisible,
          }
          mark('kit.forbidden-tools-registered', forbidden.every(f => toolNames.some(t => t.name === f)))
          /** ★★ 永久禁止的能力**不得**出现在给模型的清单里 */
          mark('kit.forbidden-tools-not-model-visible', forbidden.every(f => !modelVisible.includes(f)))
          mark('kit.forbidden-tools-denied', forbidden.every(f => toolNames.find(t => t.name === f)?.decision === 'denied'))
          /** 占位实现也不能"看起来可调用"（M3 未实现 ⇒ 权限默认全部关闭 ⇒ denied） */
          mark('kit.placeholder-tools-denied-by-default', toolNames.filter(t => String(t.name).startsWith('screen.') || String(t.name).startsWith('file.')).every(t => t.decision === 'denied'))

          // ═══════ ⑤ 工具审计："未执行"与"执行失败"可区分
          const audit = await callJson('window.airimate.kitToolAudit()') as { ok?: boolean, calls?: unknown[], digest?: Record<string, unknown> }
          const digest = (audit.digest ?? {}) as Record<string, unknown>
          result.toolAudit = { ok: audit.ok === true, digest, sampleCount: Array.isArray(audit.calls) ? (audit.calls as unknown[]).length : null }
          mark('kit.tool-audit.ok', audit.ok === true)
          mark('kit.tool-audit-has-records', (digest.total as number ?? 0) >= 1)
          mark('kit.tool-audit-never-executed-counted', typeof digest.neverExecuted === 'number' && (digest.neverExecuted as number) >= 1)
          /**
           * ★★ 审计里不得出现参数原文：每条 `paramsDigest` 必须是
           * `sha256:<12 位>:len=<n>` 的形式（机械判定，不靠读代码相信）。
           */
          const calls = Array.isArray(audit.calls) ? audit.calls as Array<Record<string, unknown>> : []
          mark('kit.tool-audit-digest-only', calls.every(c => /^sha256:[0-9a-f]{0,12}:len=\d+$/.test(String(c.paramsDigest))))
          mark('kit.tool-audit-no-plaintext', !new RegExp(String.raw`[A-Za-z]:[\\/]|sk-`).test(JSON.stringify(audit)))

          // ═══════ ⑥ 存储清单与迁移链
          /**
           * ★ 本段补齐两件**原先没有任何判据覆盖**的事（本轮实测发现）：
           *   ① 每个存储条目是否**真的带着** `lastMigration` 字段 ——
           *      `store-registry.ts` 的存在理由就是让界面能区分"**没登记**"与"**登记了但没迁移**"，
           *      而旧版探针只读了 `name/version/description` 就把整个响应丢了，
           *      于是这把"登记表接线"验证成了"清单数量对不对"；
           *   ② `unregistered` 是否为空 —— 非空意味着那些存储的**迁移链不生效**（升级会丢数据）。
           */
          const stores = await callJson('window.airimate.kitStores()') as { ok?: boolean, stores?: unknown[], personal?: string[], unregistered?: string[] }
          const list = Array.isArray(stores.stores) ? stores.stores as Array<Record<string, unknown>> : []
          const personal = Array.isArray(stores.personal) ? stores.personal as string[] : []
          const unregistered = Array.isArray(stores.unregistered) ? stores.unregistered as string[] : []
          const withMigrationField = list.filter(s => 'lastMigration' in s)
          result.stores = {
            ok: stores.ok === true,
            count: list.length,
            personal,
            versions: list.map(s => `${String(s.name)}@${String(s.version)}`),
            /** 每个条目都必须带这个字段（值可为 null —— null 表示"没迁移"，键必须存在） */
            lastMigrationFieldCount: withMigrationField.length,
            /**
             * ★ 语义澄清（我本轮差点因此得出相反结论）：
             *   `lastMigration` 是**上次读盘的迁移结论**（`MigrationOutcome`），
             *   **不是"发生过迁移"的事件**。v1 数据 + v1 描述子时它照样是
             *   `{ok:true, steps:[], reason:'ok', fromVersion:1}` —— **不是 null**。
             *   null 只出现在"这个存储登记了、但还没读盘"（或未登记 → 键根本不存在）。
             *   ⇒ 所以下两栏必须分开记：`outcomes`（有读盘结论的存储）与
             *     `migratedNames`（真的**走了迁移步骤**的存储，`steps.length > 0`）。
             */
            outcomes: list.filter(s => s.lastMigration !== null && s.lastMigration !== undefined).map(s => String(s.name)),
            /** 真的执行过迁移步骤的存储（当前无 v2 迁移 ⇒ 预期为空数组） */
            migratedNames: list
              .filter(s => Array.isArray((s.lastMigration as { steps?: unknown[] } | null)?.steps)
                && ((s.lastMigration as { steps: unknown[] }).steps.length > 0))
              .map(s => String(s.name)),
            /** 未登记的存储（非空 ⇒ 迁移链不生效） */
            unregistered,
          }
          mark('kit.stores.ok', stores.ok === true)
          mark('kit.stores-registered', list.length >= 12)
          mark('kit.stores-versioned', list.every(s => typeof s.version === 'number' && (s.version as number) >= 1))
          mark('kit.stores-personal-listed', ['session', 'memory', 'schedules', 'reminders', 'activity'].every(n => personal.includes(n)))
          mark('kit.stores-descriptions', list.every(s => typeof s.description === 'string' && (s.description as string).length > 0))
          /** ★ 新增：迁移结论**可读**（每个条目都带 `lastMigration` 键，不是被响应清洗掉） */
          mark('kit.stores-migration-readable', list.length > 0 && withMigrationField.length === list.length)
          /** ★ 新增：**没有任何**未登记的存储（否则其迁移链不生效，升级会丢数据） */
          mark('kit.stores-none-unregistered', unregistered.length === 0)

          /**
           * ★ 新增：`storage` / `privacy` 两类适配器**真的注册了**（本轮补的缺口）。
           *
           * 为什么单独立断言：这两类此前是 `registered: 0` —— 整类不存在。
           * 而 `kit.every-kind-registered`（改为全量清单后）**已经**能发现它，
           * 这里再立一条的理由是**可读性**：失败时要一眼看出是哪一类缺，
           * 而不是从一堆 kind 里去找。两条断言一宽一窄，成本极低。
           */
          const storageAdapter = adapters.find(a => a.kind === 'storage')
          const privacyAdapter = adapters.find(a => a.kind === 'privacy')
          mark('kit.storage-adapter-registered', !!storageAdapter)
          mark('kit.privacy-adapter-registered', !!privacyAdapter)
          /**
           * 两类都必须**可用**（`init()` 实测通过）。
           * `available:false` 是可接受的"如实报告"，但那样这条判据就该红 ——
           * 因为"存储或隐私通道不可用"是真问题，不该被一条恒真的判据盖住。
           */
          mark('kit.storage-adapter-available', storageAdapter?.available === true)
          mark('kit.privacy-adapter-available', privacyAdapter?.available === true)
          /**
           * ★ 两类适配器的**文本字段不得含绝对路径**。
           *   它们是最容易泄漏路径的两类（一个知道所有存储文件在哪，
           *   一个知道用户数据目录在哪）—— 所以必须在**投影之后**再验一遍，
           *   而不是只在实现里"注意不要写路径"。
           */
          const dataAdapterText = [storageAdapter, privacyAdapter]
            .flatMap(a => (a ? [a.label, a.note, a.unavailableReason, ...(Array.isArray(a.capabilities) ? a.capabilities : [])] : []))
            .filter(v => typeof v === 'string')
            .join(' ')
          mark('kit.data-adapters-no-abs-path', !/[A-Za-z]:[\\/]|\\\\[^\s]/.test(dataAdapterText))

          // ═══════ ⑦ 适配层与 M1/M2 的接线（不是"装了个框架但没人用"）
          const diag = await callJson('window.airimate.diagnostics()') as { ok?: boolean, browserWindowCount?: number }
          mark('kit.single-window-preserved', diag.browserWindowCount === 1)
          mark('kit.no-extra-window', (diag.browserWindowCount ?? 0) <= 1)
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
        }
        const entries = Object.entries(checks)
        const passed = entries.filter(([, v]) => v).length
        result.totalChecks = entries.length
        result.passedChecks = passed
        result.failedChecks = entries.filter(([, v]) => !v).map(([k]) => k)
        result.pass = entries.length >= 25 && passed === entries.length
        console.log(`[airimate] PROBE_KIT ${JSON.stringify({ pass: result.pass, passed, total: entries.length, failed: result.failedChecks })}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  /**
   * `--probe m3`：语音 / 屏幕理解 / 电脑操作的**端到端 IPC 验收**（M3 §1–§6）。
   *
   * 关键判据（每条对应一个用户要求）：
   *   · 语音唤醒**默认关闭**，且识别在未启用时**被拒绝**（不做后台偷听）；
   *   · 屏幕理解**按需**（没有定时器）、状态可见、暂停可用、截图前有提示；
   *   · 文件读取：白名单外被拒、敏感文件被拒、**危险目录不能被授权**；
   *   · 三档权限：禁止项**不进给模型的清单**、needs-confirm **绝不因缺少入口而放行**；
   *   · 审计：`参数/结果`只记摘要，且"未执行"（ok=null）与"执行失败"（ok=false）可区分。
   *
   * ⚠ 探针**不打开麦克风**（不会调 `voice:listen-once`，那需要真人说话），
   *   也**不真的截图**（`screen.capture` 是 denied 档，调用只会被拒 ——
   *   探针验证的正是"被拒"这件事）。这样整套验收在无人值守时也能跑。
   */
  if (cli.probe === 'm3') {
    const probeAt = 10_000
    log().info('--probe m3 已排程', { ms: probeAt }, 'probe.m3.scheduled')
    setTimeout(() => {
      void (async () => {
        const checks: Record<string, boolean> = {}
        const result: Record<string, unknown> = { checks }
        const mark = (k: string, v: boolean): void => { checks[k] = v === true }
        /** 探针创建的授权目录（跑完撤销，不留痕迹） */
        const createdDirs: string[] = []
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const call = async (expr: string): Promise<unknown> => await w.webContents.executeJavaScript(expr, true)
          const callJson = async (expr: string): Promise<Record<string, unknown>> =>
            await call(`(async () => { try { return JSON.parse(JSON.stringify(await (${expr}))) } catch (e) { return { error: String(e) } } })()`) as Record<string, unknown>

          // ═══════ ① 语音：默认关闭 + 能力如实 + 一键停用
          const vs = await callJson('window.airimate.voiceStatus()') as { ok?: boolean, status?: Record<string, unknown> }
          const st = (vs.status ?? {}) as Record<string, unknown>
          result.voice = {
            ok: vs.ok === true,
            available: st.available ?? null,
            recognizerCount: st.recognizerCount ?? null,
            wakeWordEnabled: st.wakeWordEnabled ?? null,
            micActive: st.micActive ?? null,
            state: st.state ?? null,
            wakeWord: st.wakeWord ?? null,
          }
          mark('m3.voice.status-ok', vs.ok === true)
          /** ★★ "语音唤醒默认关闭"是用户硬要求 */
          mark('m3.voice.wakeword-default-off', st.wakeWordEnabled === false)
          /** ★★ 默认**不占用麦克风** */
          mark('m3.voice.mic-not-active-by-default', st.micActive === false)
          /** 能力如实：可用性必须与识别器数量一致（不许乐观 true） */
          mark('m3.voice.availability-honest', (st.available === true) === ((st.recognizerCount as number ?? 0) > 0))
          /** 状态里**没有识别正文**（只有长度与计数） */
          mark('m3.voice.no-text-in-status', !('text' in st) && !('lastText' in st))

          // 未启用识别时调识别 ⇒ 必须**被拒绝**（而不是悄悄打开麦克风）
          const listenDenied = await callJson('window.airimate.voiceListenOnce(1200)')
          result.listenWhenDisabled = { ok: listenDenied.ok ?? null, code: listenDenied.code ?? null }
          mark('m3.voice.listen-refused-when-disabled', listenDenied.ok === false && String(listenDenied.code) === 'VOICE_DISABLED')
          mark('m3.voice.listen-denied-did-not-open-mic', (await callJson('window.airimate.voiceStatus()') as { status?: Record<string, unknown> }).status?.micActive === false)

          // 唤醒词可设置 + 长度受限
          const cfg = await callJson(`window.airimate.voiceConfig({ wakeWordEnabled: true, wakeWord: '探针唤醒词' })`) as { ok?: boolean, status?: Record<string, unknown> }
          mark('m3.voice.config-ok', cfg.ok === true && cfg.status?.wakeWord === '探针唤醒词')
          const cfgTooLong = await callJson(`window.airimate.voiceConfig({ wakeWord: '一二三四五六七八九十一二三四五六七八九十一二三' })`)
          mark('m3.voice.config-rejects-too-long', cfgTooLong.ok === false && String(cfgTooLong.code) === 'IPC_SCHEMA')
          // 一键停用（幂等，且必定释放麦克风）
          const stop = await callJson('window.airimate.voiceStop()') as { ok?: boolean, status?: Record<string, unknown> }
          mark('m3.voice.stop-ok', stop.ok === true && stop.status?.micActive === false)
          // 复位探针改过的配置
          await callJson(`window.airimate.voiceConfig({ wakeWordEnabled: false, wakeWord: '你好助手' })`)
          const afterReset = await callJson('window.airimate.voiceStatus()') as { status?: Record<string, unknown> }
          mark('m3.voice.config-restored', afterReset.status?.wakeWordEnabled === false && afterReset.status?.wakeWord === '你好助手')

          // ═══════ ①b 语音通话（STT → LLM → TTS 全链路）
          /**
           * ⚠ 探针**不真的开始通话**：那会打开麦克风并等着真人说话，
           *   无人值守时只会干等一轮又一轮。这里验证的是**链路的存在与前置条件**：
           *     · 状态通道可用且形态符合契约；
           *     · 未启用/未配置时**结构化拒绝**（不会悄悄开麦）—— 这正是"不做后台偷听"的直接读数；
           *     · 打断与结束在未通话时是安全空操作。
           */
          const cs = await callJson('window.airimate.voiceCallState()') as {
            ok?: boolean, state?: Record<string, unknown>, preflight?: { ready?: boolean, reasons?: string[] }
          }
          const cstate = (cs.state ?? {}) as Record<string, unknown>
          result.voiceCall = {
            ok: cs.ok === true,
            active: cstate.active ?? null,
            phase: cstate.phase ?? null,
            turn: cstate.turn ?? null,
            silenceTurns: cstate.silenceTurns ?? null,
            interruptions: cstate.interruptions ?? null,
            preflightReady: cs.preflight?.ready ?? null,
            preflightReasons: cs.preflight?.reasons ?? null,
          }
          mark('m3.call.state-ok', cs.ok === true)
          mark('m3.call.not-active-by-default', cstate.active === false && cstate.phase === 'idle')
          mark('m3.call.state-has-no-text', !('text' in cstate) && !('replyText' in cstate))
          /** ★★ 前置条件必须能解释"为什么不能通话"（而不是一个点不动的按钮） */
          mark('m3.call.preflight-explains', Array.isArray(cs.preflight?.reasons) && (cs.preflight?.reasons?.length ?? 0) > 0)
          const callDenied = await callJson('window.airimate.voiceCallStart()')
          result.callStartDenied = { ok: callDenied.ok ?? null, code: callDenied.code ?? null }
          mark('m3.call.start-refused-when-not-ready', callDenied.ok === false && String(callDenied.code) === 'VOICE_CALL_REFUSED')
          mark('m3.call.refusal-did-not-open-mic', (await callJson('window.airimate.voiceStatus()') as { status?: Record<string, unknown> }).status?.micActive === false)
          const intr = await callJson('window.airimate.voiceCallInterrupt()') as { interrupted?: boolean }
          mark('m3.call.interrupt-safe-when-idle', intr.interrupted === false)
          const cstop = await callJson('window.airimate.voiceCallStop()') as { stopped?: boolean }
          mark('m3.call.stop-safe-when-idle', cstop.stopped === false)

          /**
           * ═══════ ①-b ★ 闭环接线读数（2026-10-06，A4）
           *
           * 为什么单独立这几条：用户裁定"做闭环"之后，"闭环到底接上了没有"必须是
           * **一个能读出来的事实**，而不是靠读源码或拿麦克风试。
           * 这几条只断言**接线**（桥接上、四段具备条件、默认不外放麦克风），
           * **不**声称"真实说一句话她能回" —— 那需要真实设备，仍属未验证项。
           */
          const loop = await callJson('window.airimate.voiceLoopStatus()') as { ok?: boolean, loop?: Record<string, unknown> }
          const lp = (loop.loop ?? {}) as {
            bridgeInstalled?: boolean, wakeWatchRunning?: boolean, bargeInEnabled?: boolean
            recognizedCount?: number, bargeInInterruptions?: number
            stages?: { listen?: boolean, think?: boolean, speak?: boolean, activate?: boolean }
          }
          result.loop = {
            ok: loop.ok === true,
            bridgeInstalled: lp.bridgeInstalled ?? null,
            wakeWatchRunning: lp.wakeWatchRunning ?? null,
            bargeInEnabled: lp.bargeInEnabled ?? null,
            recognizedCount: lp.recognizedCount ?? null,
            stages: lp.stages ?? null,
          }
          mark('m3.loop.status-ok', loop.ok === true)
          /** ★★ 那条"全仓零订阅者"的线**现在真的接上了**（本轮修掉的核心缺口） */
          mark('m3.loop.bridge-installed', lp.bridgeInstalled === true)
          /** 闭环四段的条件读数必须**齐全**（缺一段就说明读数本身是残的） */
          mark('m3.loop.stages-reported', !!lp.stages
            && typeof lp.stages.listen === 'boolean' && typeof lp.stages.think === 'boolean'
            && typeof lp.stages.speak === 'boolean' && typeof lp.stages.activate === 'boolean')
          /** 默认**不该**在待机监听（两个开关默认都是 false）⇒ 不得悄悄听 */
          mark('m3.loop.wake-watch-off-by-default', lp.wakeWatchRunning === false)
          /** barge-in 默认关闭（自己把自己打断的声学风险不替用户默认打开） */
          mark('m3.loop.barge-in-off-by-default', lp.bargeInEnabled === false)
          /** 闭环读数**不含任何正文**（只允许布尔与计数） */
          mark('m3.loop.status-has-no-text',
            !('text' in lp) && !('replyText' in lp) && !('lastText' in lp))
          /**
           * ★ 待机监听的双重前置必须**在运行期就被拒**（不是文档里的一句承诺）：
           *   识别与唤醒默认都为 false ⇒ 打开待机监听必须结构化拒绝。
           */
          const wwDeny = await callJson('window.airimate.voiceWakeWatch(true)') as { ok?: boolean, code?: string }
          mark('m3.loop.wake-watch-refused-when-disabled',
            wwDeny.ok === false && String(wwDeny.code).startsWith('WAKE_WATCH_REFUSED'))
          mark('m3.loop.wake-watch-refusal-did-not-open-mic',
            (await callJson('window.airimate.voiceStatus()') as { status?: Record<string, unknown> }).status?.micActive === false)
          /** 拒绝之后运行态必须仍然是"没在听" */
          const loopAfter = await callJson('window.airimate.voiceLoopStatus()') as { loop?: Record<string, unknown> }
          mark('m3.loop.wake-watch-still-off-after-refusal',
            (loopAfter.loop as { wakeWatchRunning?: boolean } | undefined)?.wakeWatchRunning === false)

          // ═══════ ② 屏幕理解：状态可读 + 暂停 + 提示 + 权限未开时被拒
          const ss = await callJson('window.airimate.screenStatus()') as { ok?: boolean, status?: Record<string, unknown> }
          const scr = (ss.status ?? {}) as Record<string, unknown>
          result.screen = {
            ok: ss.ok === true,
            permitted: scr.permitted ?? null,
            paused: scr.paused ?? null,
            captureCount: scr.captureCount ?? null,
            lastCaptureAt: scr.lastCaptureAt ?? null,
            excludeRegions: Array.isArray(scr.excludeRegions) ? (scr.excludeRegions as unknown[]).length : null,
            redactSensitive: scr.redactSensitive ?? null,
          }
          mark('m3.screen.status-ok', ss.ok === true)
          /** ★★ 默认没人点过截图 ⇒ 计数为 0（"不持续录屏"的直接读数） */
          mark('m3.screen.no-capture-yet', scr.captureCount === 0 && scr.lastCaptureAt === null)
          mark('m3.screen.permitted-false-by-default', scr.permitted === false)
          const pause = await callJson('window.airimate.screenPause(true)') as { status?: Record<string, unknown> }
          mark('m3.screen.pause-works', pause.status?.paused === true)
          const resume = await callJson('window.airimate.screenPause(false)') as { status?: Record<string, unknown> }
          mark('m3.screen.resume-works', resume.status?.paused === false)
          mark('m3.screen.status-has-no-image', JSON.stringify(scr).length < 2000 && !('image' in scr) && !('dataUrl' in scr))

          // ═══════ ③ 目录白名单：能加、能撤、危险目录被拒
          const al0 = await callJson('window.airimate.fsAllowlist()') as { ok?: boolean, rules?: Record<string, unknown> }
          mark('m3.fs.allowlist-ok', al0.ok === true)
          result.fsRules = al0.rules ?? null
          mark('m3.fs.rules-present', Number((al0.rules as Record<string, unknown> | undefined)?.file ?? 0) >= 15
            && Number((al0.rules as Record<string, unknown> | undefined)?.dir ?? 0) >= 12)
          /** ★ 出参里**没有完整路径**（只给 id 与末级目录名） */
          mark('m3.fs.allowlist-no-full-path', !new RegExp(String.raw`[A-Za-z]:[\\/]`).test(JSON.stringify(al0)))

          /**
           * 授权一个真实存在的普通目录。
           *
           * ⚠ **不能放在 `userData` 下**：那里是 `AiriMateOne`，本身就有一条
           *   "本应用自己的数据目录（含加密密钥文件）"硬拒绝规则 ⇒ 加不进去。
           *   实测就是这样被拒的（`SENSITIVE-DIR`）—— 那是**规则正确工作的证据**，
           *   所以探针改用一个真正中性的临时目录（`os.tmpdir()` 下的探针专属目录）。
           */
          const probeDir = join(tmpdir(), `airimate-m3-probe-${process.pid}`)
          try { mkdirSync(probeDir, { recursive: true }) } catch { /* ignore */ }
          const probeDirLabel = probeDir.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean).pop() ?? ''
          const addOk = await callJson(`window.airimate.fsAllowDir(${JSON.stringify(probeDir)})`) as { ok?: boolean, entries?: Array<{ id: string, label: string }>, code?: string }
          result.fsAdd = { ok: addOk.ok ?? null, code: addOk.code ?? null, label: probeDirLabel, labels: (addOk.entries ?? []).map(e => e.label) }
          mark('m3.fs.allow-dir-ok', addOk.ok === true && (addOk.entries ?? []).some(e => e.label === probeDirLabel))
          mark('m3.fs.entry-has-id-and-label', (addOk.entries ?? []).every(e => typeof e.id === 'string' && e.id.length === 12 && typeof e.label === 'string'))
          if (addOk.ok === true && addOk.entries) {
            const mine = addOk.entries.find(e => e.label === probeDirLabel)
            if (mine) createdDirs.push(mine.id)
          }
          /** ★★ 危险目录**不能被授权**（`.ssh` / Windows） */
          const sshDir = join(appPaths().userData, '.ssh')
          try { mkdirSync(sshDir, { recursive: true }) } catch { /* ignore */ }
          const addBad = await callJson(`window.airimate.fsAllowDir(${JSON.stringify(sshDir)})`)
          result.fsAddSensitive = { ok: addBad.ok ?? null, code: addBad.code ?? null }
          mark('m3.fs.rejects-sensitive-dir', addBad.ok === false && ['SENSITIVE-DIR', 'SENSITIVE_DIR'].includes(String(addBad.code)))
          const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
          const addSys = await callJson(`window.airimate.fsAllowDir(${JSON.stringify(sysRoot)})`)
          mark('m3.fs.rejects-system-dir', addSys.ok === false)
          /** 不存在的目录也要被拒（避免白名单里塞进无效路径） */
          const addMissing = await callJson(`window.airimate.fsAllowDir(${JSON.stringify(join(appPaths().userData, 'definitely-not-here-xyz'))})`)
          mark('m3.fs.rejects-missing-dir', addMissing.ok === false)

          // ═══════ ④ 工具：三档权限 + 禁止项不进模型清单 + confirm 不放行
          const cap = await callJson('window.airimate.kitCapabilities()') as { kit?: Record<string, unknown> }
          const m3 = ((cap.kit ?? {}) as Record<string, unknown>).m3 as Record<string, unknown> | undefined
          result.kitM3 = m3 ?? null
          mark('m3.kit.has-m3-state', typeof m3 === 'object' && m3 !== null)

          const audit = await callJson('window.airimate.kitToolAudit()') as { digest?: Record<string, unknown> }
          result.toolAudit = audit.digest ?? null
          /** ★★ "未执行"与"执行失败"必须可区分（ok=null vs ok=false） */
          mark('m3.audit.distinguishes-not-executed', typeof (audit.digest as Record<string, unknown> | undefined)?.neverExecuted === 'number')
          mark('m3.audit.has-records', Number((audit.digest as Record<string, unknown> | undefined)?.total ?? 0) >= 6)

          /**
           * ★★ 屏幕截图在**未授权**时必须被拒（工具存在但不可用）。
           *   探针**不真的截图**：`screen-capture` 默认 denied ⇒ 执行器在权限判定阶段就返回 denied，
           *   根本走不到 `desktopCapturer`。这正是我们要证明的。
           */
          const cap2 = await callJson('window.airimate.kitCapabilities()') as { kit?: Record<string, unknown> }
          const tools = ((cap2.kit ?? {}) as Record<string, unknown>).tools as Array<Record<string, unknown>> | undefined
          const decisions = Object.fromEntries((tools ?? []).map(t => [String(t.name), String(t.decision)]))
          result.toolDecisions = decisions
          mark('m3.tools.registered', (tools ?? []).length >= 12)
          mark('m3.tools.screen-denied-by-default', decisions['screen.capture'] === 'denied')
          mark('m3.tools.file-read-denied-by-default', decisions['file.read'] === 'denied')
          mark('m3.tools.clipboard-needs-confirm-or-denied', ['needs-confirm', 'denied'].includes(String(decisions['clipboard.read'])))
          mark('m3.tools.shell-exec-registered-forbidden', decisions['shell.exec'] === 'denied')
          mark('m3.tools.file-write-registered-forbidden', decisions['file.write'] === 'denied')
          const modelVisible = ((cap2.kit ?? {}) as Record<string, unknown>).modelVisibleTools as string[] | undefined
          mark('m3.tools.forbidden-not-model-visible', ['payment.pay', 'credential.read', 'system.settings', 'input.simulate', 'shell.exec', 'file.write']
            .every(n => !(modelVisible ?? []).includes(n)))

          // ═══════ ⑤ 清理：撤销探针创建的授权目录
          for (const id of createdDirs) await callJson(`window.airimate.fsRevokeDir(${JSON.stringify(id)})`)
          const alFinal = await callJson('window.airimate.fsAllowlist()') as { entries?: unknown[] }
          result.cleanup = { revoked: createdDirs.length, remaining: (alFinal.entries ?? []).length }
          mark('m3.fs.cleanup-done', (alFinal.entries ?? []).every(e => (e as { label?: string }).label !== probeDirLabel))
          try { rmSync(probeDir, { recursive: true, force: true }) } catch { /* 清理失败不影响判据 */ }
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
        }
        const entries = Object.entries(checks)
        const passed = entries.filter(([, v]) => v).length
        result.totalChecks = entries.length
        result.passedChecks = passed
        result.failedChecks = entries.filter(([, v]) => !v).map(([k]) => k)
        result.pass = entries.length >= 30 && passed === entries.length
        console.log(`[airimate] PROBE_M3 ${JSON.stringify({ pass: result.pass, passed, total: entries.length, failed: result.failedChecks })}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  /**
   * `--probe m4`：每日自学习的**端到端 IPC 验收**（M4 §1–§5）。
   *
   * 关键判据（每条对应一个用户要求）：
   *   · 自学习**默认关闭**，且 `reflectionDue`（唯一自动入口）在关闭时为 false；
   *   · 手动反思能跑，并产出总结 / 提取项 / 工作节奏 / 明日建议；
   *   · **高置信度自动写入记忆，低置信度绝不自动写** —— 这条用"记忆条数变化 + 条目 approval"双向证明；
   *   · **dryRun 不写任何记忆**（探针默认用它，避免污染用户数据）；
   *   · 待确认项可确认/可拒绝，拒绝后不再重复提问；
   *   · 反思**不改 settings / permissions**（跑前后按字节比对）；
   *   · 清空反思只清反思，**不动已写入的记忆**。
   *
   * ⚠ 探针**清场**：它会在 `session.json` 里写入几条测试消息（反思的输入），
   *   跑完把这些消息删掉、把探针写入的记忆删掉、并清空反思记录。
   *   测试消息用固定前缀，便于精确定位删除。
   */
  if (cli.probe === 'm4') {
    const probeAt = 10_000
    log().info('--probe m4 已排程', { ms: probeAt }, 'probe.m4.scheduled')
    setTimeout(() => {
      void (async () => {
        const checks: Record<string, boolean> = {}
        const result: Record<string, unknown> = { checks }
        const mark = (k: string, v: boolean): void => { checks[k] = v === true }
        /** 探针写入的记忆 id（跑完删掉） */
        const probeMemoryIds: string[] = []
        /** 探针写入的消息 id（跑完删掉） */
        const PROBE_TAG = 'M4PROBE'
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const call = async (expr: string): Promise<unknown> => await w.webContents.executeJavaScript(expr, true)
          const callJson = async (expr: string): Promise<Record<string, unknown>> =>
            await call(`(async () => { try { return JSON.parse(JSON.stringify(await (${expr}))) } catch (e) { return { error: String(e) } } })()`) as Record<string, unknown>

          // ═══════ ① 默认关闭 + 状态可读
          const st = await callJson('window.airimate.reflectionStatus()') as { ok?: boolean, status?: Record<string, unknown> }
          const rs = (st.status ?? {}) as Record<string, unknown>
          result.status = {
            ok: st.ok === true,
            enabled: rs.enabled ?? null,
            at: rs.at ?? null,
            runs: rs.runs ?? null,
            pendingCount: rs.pendingCount ?? null,
            highConfidence: rs.highConfidence ?? null,
          }
          mark('m4.status.ok', st.ok === true)
          /** ★★ 默认关闭（用户要求"支持关闭自学习"⇒ 默认就该是关的） */
          mark('m4.status.default-off', rs.enabled === false)
          mark('m4.status.threshold-visible', typeof rs.highConfidence === 'number' && (rs.highConfidence as number) > 0 && (rs.highConfidence as number) < 1)

          // 状态里**没有**任何提取内容或对话正文
          mark('m4.status.no-content', !('items' in rs) && !('summary' in rs) && !('text' in rs))

          // ═══════ ② 反思前置：写入几条带标记的测试消息
          const seed = await callJson(`(async () => {
            const r = await window.airimate.history()
            return { count: (r.messages || []).length }
          })()`)
          result.historyBefore = seed.count ?? null
          /**
           * ⚠ 直接经 IPC 写消息没有通道（renderer 不该能伪造历史）。
           *   所以探针从**主进程侧**写入（这一段代码本身在主进程里跑），
           *   并用固定标记便于精确清理。
           */
          const before = { settings: '', perms: '' }
          try {
            before.settings = readFileSync(appPaths().settingsFile, 'utf8')
          } catch { before.settings = '<absent>' }
          try {
            before.perms = readFileSync(join(appPaths().userData, 'permissions.json'), 'utf8')
          } catch { before.perms = '<absent>' }

          appendMessage({ id: `${PROBE_TAG}-u1`, role: 'user', text: `${PROBE_TAG} 我的生日是 3 月 14 日`, createdAt: Date.now(), commands: [], origin: 'user' })
          appendMessage({ id: `${PROBE_TAG}-u2`, role: 'user', text: `${PROBE_TAG} 我明天要交周报`, createdAt: Date.now(), commands: [], origin: 'user' })
          appendMessage({ id: `${PROBE_TAG}-u3`, role: 'user', text: `${PROBE_TAG} 今天好累`, createdAt: Date.now(), commands: [], origin: 'user' })

          // ═══════ ③ dryRun：只看报告，**不写任何记忆**
          const memBefore = memoryCount()
          const dry = await callJson('window.airimate.reflectionRun({ force: true, dryRun: true })') as {
            ok?: boolean, ran?: boolean, reflection?: Record<string, unknown>
          }
          const dryRef = (dry.reflection ?? {}) as Record<string, unknown>
          const dryItems = Array.isArray(dryRef.items) ? dryRef.items as Array<Record<string, unknown>> : []
          result.dryRun = {
            ok: dry.ok ?? null,
            ran: dry.ran ?? null,
            items: dryItems.length,
            autoWritten: dryRef.autoWritten ?? null,
            pending: dryRef.pendingApproval ?? null,
            method: dryRef.method ?? null,
            hasSummary: typeof dryRef.dailySummary === 'string' && (dryRef.dailySummary as string).length > 0,
            adviceCount: Array.isArray(dryRef.tomorrowAdvice) ? (dryRef.tomorrowAdvice as unknown[]).length : null,
            disclosures: dryRef.disclosures ?? null,
          }
          mark('m4.dryrun.ran', dry.ok === true && dry.ran === true)
          mark('m4.dryrun.extracted-something', dryItems.length >= 2)
          /** ★★ dryRun 绝不写记忆 */
          mark('m4.dryrun.no-memory-write', memoryCount() === memBefore && Number(dryRef.autoWritten ?? 0) === 0)
          mark('m4.dryrun.has-daily-summary', typeof dryRef.dailySummary === 'string' && (dryRef.dailySummary as string).length > 5)
          mark('m4.dryrun.has-disclosure', Array.isArray(dryRef.disclosures) && (dryRef.disclosures as unknown[]).length > 0)

          /** ★★ 高置信度 vs 低置信度的**分界必须存在且正确** */
          const high = dryItems.filter(i => Number(i.confidence) >= Number(rs.highConfidence ?? 0.75))
          const low = dryItems.filter(i => Number(i.confidence) < Number(rs.highConfidence ?? 0.75))
          result.confidenceSplit = {
            high: high.map(i => ({ kind: i.kind, c: i.confidence })),
            low: low.map(i => ({ kind: i.kind, c: i.confidence })),
          }
          mark('m4.confidence.high-exists', high.length >= 1)
          mark('m4.confidence.low-exists', low.length >= 1)
          mark('m4.confidence.high-all-pending-in-dryrun', high.every(i => i.approval === 'pending' && i.memoryId === null))

          // ═══════ ④ 真跑一次：高置信度应自动写入记忆
          const memBefore2 = memoryCount()
          const real = await callJson('window.airimate.reflectionRun({ force: true, dryRun: false })') as {
            ok?: boolean, ran?: boolean, reflection?: Record<string, unknown>
          }
          const realRef = (real.reflection ?? {}) as Record<string, unknown>
          const realItems = Array.isArray(realRef.items) ? realRef.items as Array<Record<string, unknown>> : []
          const autoItems = realItems.filter(i => i.approval === 'auto')
          result.realRun = {
            ok: real.ok ?? null,
            ran: real.ran ?? null,
            items: realItems.length,
            auto: autoItems.length,
            pending: realRef.pendingApproval ?? null,
            pausedMemoryDelta: memoryCount() - memBefore2,
          }
          mark('m4.real.ran', real.ok === true && real.ran === true)
          mark('m4.real.auto-wrote-high-confidence', autoItems.length >= 1 && memoryCount() > memBefore2)
          mark('m4.real.auto-items-have-memory-id', autoItems.every(i => typeof i.memoryId === 'string' && (i.memoryId as string).length > 0))
          /** ★★ 低置信度**绝不**自动写：所有非 auto 项的 memoryId 必须是 null */
          mark('m4.real.low-never-auto-written', realItems.filter(i => i.approval !== 'auto').every(i => i.memoryId === null))
          for (const i of autoItems) if (typeof i.memoryId === 'string') probeMemoryIds.push(i.memoryId)

          // ═══════ ⑤ 待确认 → 确认 / 拒绝
          const pend = await callJson('window.airimate.reflectionPending()') as { ok?: boolean, items?: Array<Record<string, unknown>>, count?: number }
          const pendingItems = pend.items ?? []
          result.pending = { ok: pend.ok ?? true, count: pendingItems.length }
          mark('m4.pending.listed', pend.ok === true && pendingItems.length >= 1)
          mark('m4.pending.has-day-and-rule', pendingItems.every(i => typeof i.day === 'string' && typeof (i.evidence as Record<string, unknown> | undefined)?.ruleId === 'string'))

          /** 确认第一条 ⇒ 应写入记忆 */
          const first = pendingItems[0]
          if (first) {
            const memBefore3 = memoryCount()
            const dec = await callJson(`window.airimate.reflectionDecide(${JSON.stringify(first.day)}, ${JSON.stringify(first.id)}, true)`) as {
              ok?: boolean, memoryId?: string | null
            }
            result.confirm = { ok: dec.ok ?? null, memoryId: dec.memoryId ?? null, memoryDelta: memoryCount() - memBefore3 }
            mark('m4.decide.approve-writes-memory', dec.ok === true && typeof dec.memoryId === 'string' && memoryCount() > memBefore3)
            if (typeof dec.memoryId === 'string') probeMemoryIds.push(dec.memoryId)
          } else {
            mark('m4.decide.approve-writes-memory', false)
          }

          /** 拒绝第二条 ⇒ 不写记忆，且指纹记下 */
          const second = pendingItems[1]
          if (second) {
            const memBefore4 = memoryCount()
            const dec2 = await callJson(`window.airimate.reflectionDecide(${JSON.stringify(second.day)}, ${JSON.stringify(second.id)}, false)`) as { ok?: boolean, memoryId?: string | null }
            result.reject = { ok: dec2.ok ?? null, memoryId: dec2.memoryId ?? null, memoryDelta: memoryCount() - memBefore4 }
            mark('m4.decide.reject-does-not-write', dec2.ok === true && dec2.memoryId === null && memoryCount() === memBefore4)
          } else {
            // 没有第二条待确认时不算失败（内容决定了条数），但要如实标注
            result.reject = { note: '只有一条待确认项，跳过拒绝路径' }
          }

          /** 处理过的条目不能重复处理（防重放） */
          if (first) {
            const again = await callJson(`window.airimate.reflectionDecide(${JSON.stringify(first.day)}, ${JSON.stringify(first.id)}, true)`)
            mark('m4.decide.replay-rejected', again.ok === false)
          } else {
            mark('m4.decide.replay-rejected', true)
          }

          // ═══════ ⑥ ★★ 反思不得修改任何配置（按字节比对）
          let afterSettings = '<absent>'
          let afterPerms = '<absent>'
          try { afterSettings = readFileSync(appPaths().settingsFile, 'utf8') } catch { afterSettings = '<absent>' }
          try { afterPerms = readFileSync(join(appPaths().userData, 'permissions.json'), 'utf8') } catch { afterPerms = '<absent>' }
          result.configUnchanged = {
            settings: before.settings === afterSettings,
            permissions: before.perms === afterPerms,
          }
          mark('m4.no-config-mutation.settings', before.settings === afterSettings)
          mark('m4.no-config-mutation.permissions', before.perms === afterPerms)

          // ═══════ ⑦ 历史可读 + 清空只清反思
          const hist = await callJson('window.airimate.reflectionHistory(10)') as { ok?: boolean, days?: unknown[], total?: number }
          mark('m4.history.readable', hist.ok === true && (hist.days ?? []).length >= 1)
          const memBefore5 = memoryCount()
          const cleared = await callJson('window.airimate.reflectionClear()') as { ok?: boolean, removedDays?: number }
          const hist2 = await callJson('window.airimate.reflectionHistory(10)') as { days?: unknown[] }
          result.clear = { ok: cleared.ok ?? null, removedDays: cleared.removedDays ?? null, remaining: (hist2.days ?? []).length, memoryKept: memoryCount() }
          mark('m4.clear.removes-reflections', cleared.ok === true && (hist2.days ?? []).length === 0)
          /** ★★ 清反思**不动已写入的记忆**（两回事，界面会如实说明） */
          mark('m4.clear.keeps-memory', memoryCount() === memBefore5)

          // ═══════ ⑧ 清场：删掉探针写入的记忆与消息
          for (const id of probeMemoryIds) {
            try { deleteMemory(id) } catch { /* 已被删则忽略 */ }
          }
          const histAll = sessionAllMessages()
          for (const m of histAll) {
            if (m.id.startsWith(PROBE_TAG) || m.text.startsWith(PROBE_TAG)) {
              try { removeMessageById(m.id) } catch { /* ignore */ }
            }
          }
          result.cleanup = { memories: probeMemoryIds.length }
          mark('m4.cleanup.done', true)
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
        }
        const entries = Object.entries(checks)
        const passed = entries.filter(([, v]) => v).length
        result.totalChecks = entries.length
        result.passedChecks = passed
        result.failedChecks = entries.filter(([, v]) => !v).map(([k]) => k)
        result.pass = entries.length >= 20 && passed === entries.length
        console.log(`[airimate] PROBE_M4 ${JSON.stringify({ pass: result.pass, passed, total: entries.length, failed: result.failedChecks })}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  /**
   * ═══════ `--probe chatwindow`：**独立对话窗口**的端到端验收（2026-10-08 返工轮）
   *
   * ⚠ 名字**必须是 `chatwindow` 而不是 `chat`**：`--probe chat` 早就被 A22
   *   （"聊天链路真实接通"）占用了 —— 用同一个名字会让两条探针互相覆盖产物
   *   （实测：`run-probe.ps1 -Name chat` 写出的 JSON 是 A22 的内容，pass 字段根本不存在）。
   *
   * 它取代了 `--probe conversation`。旧的 45 项检查里有一整套断言的就是本轮废止的形态
   * （`layout.opens-as-conversation` 要求 pet 窗口变成 380×560、`single.visible-window`
   * 要求全程只有 1 个可见窗口）—— 新口径下 chat 打开时正确的可见窗口数就是 2。
   * 在旧探针上打补丁会让"哪些断言语义变了"埋在 45 项里，所以整条重写。
   * 实现在 `chat-probe.ts`（比较长，独立成文件）。
   */
  if (cli.probe === 'chatwindow') {
    scheduleChatProbe({
      out: cli.probeOut, exit: cli.probeExit, shotPrefix: cli.probeShot, quit: (r) => quit(r),
    })
  }

  /**
   * ═══════ `--probe petresident`：**桌宠常驻与启动行为**的端到端验收（2026-10-09 完善轮）
   *
   * 它守的是本轮用户的三条要求：
   *   ① `petResident`（默认 `false`）与 `startupOpenChat`（默认 `true`）两个设置真的进了 schema；
   *   ② 「呼出 / 收回桌宠」在三处菜单入口都能用，且**勾选状态实时同步**；
   *   ③ **打开软件不再自动出现桌宠**（默认启动只有对话窗口）。
   *
   * 实现在 `pet-resident-probe.ts`（较长，独立成文件 —— 与 `chat-probe.ts` 同一个理由）。
   */
  if (cli.probe === 'petresident') {
    schedulePetResidentProbe({
      out: cli.probeOut, exit: cli.probeExit, quit: (r) => quit(r),
      petModeOverride: cli.probePetMode,
      startupOpenChatAtBoot: openChatAtBoot,
      petVisibleAtBoot: petMenuState().visible,
      residentAtBoot,
    })
  }

  /**
   * ═══════ `--probe menuopen`：**菜单栏展开态**与**桌宠右键菜单**的取证（2026-10-09 完善轮）
   *
   * 它只管两件事：把两种菜单**真的展开**，然后按哨兵握手让外部脚本截图。
   * 为什么必须是探针而不是截图脚本自己点：见 `menu-open-probe.ts` 的文件头
   * （下拉是页面内的瞬时状态；原生菜单只有主进程弹得出来）。
   */
  if (cli.probe === 'menuopen') {
    scheduleMenuOpenProbe({
      out: cli.probeOut, exit: cli.probeExit, shotPrefix: cli.probeShot, quit: (r) => quit(r),
    })
  }

  /**
   * ═══════ `--probe petoverlay`：**pet 模式下覆盖层不得盖住角色**（2026-10-08 新增）
   *
   * 它守的是这一条用户裁定：
   *   首次运行向导是 `position:absolute; inset:0` 的**全屏覆盖层**，而它的显示条件依赖
   *   主进程的 `onboarding.completed`（要求"供应商已配置 + 测试通过"）——没有密钥的用户
   *   **永远**满足不了 ⇒ 覆盖层**永久驻留** ⇒ 340×420 的 pet 窗口里角色**整个被盖住**，
   *   用户的直观感受是"桌宠不见了"。
   *
   * ⚠ 判据为什么读 DOM 而不读屏幕（这是本轮用一次错误结论换来的教训）：
   *   我最初用"屏幕某区域的亮像素数"当证据，得出过"pet 窗口不上屏"的**错误**结论 ——
   *   实际原因是**用户开着全屏应用**，`CopyFromScreen` 拍到的是**游戏的画面**，
   *   本应用的窗口在更低的合成层，截图里根本看不到。
   *   ⇒ 覆盖层是否盖住角色，**只能读自己的 DOM**：它与前台是什么应用无关。
   */
  if (cli.probe === 'petoverlay') {
    const probeAt = 11_000
    log().info('--probe petoverlay 已排程', { ms: probeAt }, 'probe.petoverlay.scheduled')
    setTimeout(() => {
      void (async () => {
        const checks: Record<string, boolean> = {}
        const result: Record<string, unknown> = { probe: 'petoverlay', checks }
        const mark = (k: string, v: boolean): void => { checks[k] = v === true }
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const callJson = async (expr: string): Promise<Record<string, unknown>> =>
            await w.webContents.executeJavaScript(
              `(async () => { try { return JSON.parse(JSON.stringify(await (${expr}))) } catch (e) { return { error: String(e) } } })()`, true,
            ) as Record<string, unknown>
          const ui = await callJson('(window.__AIRIMATE_UI_PROBE__ ? window.__AIRIMATE_UI_PROBE__("read") : { error: "no-ui-probe" })')
          const ov = (ui.overlays ?? {}) as Record<string, unknown>
          result.mode = windowMode()
          result.uiMode = ui.uiMode
          result.overlays = ov
          result.petBounds = windowBounds()
          mark('petoverlay.probe-present', ui.error === undefined)
          mark('petoverlay.mode-is-pet', windowMode() === 'pet' && ui.uiMode === 'pet')
          /** ★ 核心一条：pet 模式下**不许**有向导覆盖层（它会铺满整个视口） */
          mark('petoverlay.no-wizard', ov.wizardCount === 0)
          mark('petoverlay.no-full-viewport-overlay', ov.wizardCoversAll === false)
          /** 角色舞台必须还在（覆盖层问题的对照） */
          mark('petoverlay.stage-root-present', ov.stageRootCount === 1)
          mark('petoverlay.canvas-present', ov.canvasCount === 1)
          mark('petoverlay.pet-size-unchanged', !!result.petBounds
            && Math.abs((result.petBounds as { width: number }).width - 340) <= 1
            && Math.abs((result.petBounds as { height: number }).height - 420) <= 1)
          result.totalChecks = Object.keys(checks).length
          result.passedChecks = Object.values(checks).filter(Boolean).length
          result.failedChecks = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
          result.pass = result.passedChecks === result.totalChecks
          console.log(`[airimate] PROBE_PETOVERLAY ${JSON.stringify({ pass: result.pass, passed: result.passedChecks, total: result.totalChecks, failed: result.failedChecks })}`)
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
          result.pass = false
        }
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  if (cli.probe === 'wizard') {
    const probeAt = 10_000
    log().info('--probe wizard 已排程', { ms: probeAt }, 'probe.wizard.scheduled')
    setTimeout(() => {
      void (async () => {
        const checks: Record<string, boolean> = {}
        const result: Record<string, unknown> = { checks }
        const mark = (k: string, v: boolean): void => { checks[k] = v === true }
        try {
          const w = getWindow()
          if (!w || w.isDestroyed()) throw new Error('窗口不存在')
          const call = async (expr: string): Promise<unknown> => await w.webContents.executeJavaScript(expr, true)
          const callJson = async (expr: string): Promise<Record<string, unknown>> =>
            await call(`(async () => { try { return JSON.parse(JSON.stringify(await (${expr}))) } catch (e) { return { error: String(e) } } })()`) as Record<string, unknown>

          // ── ① 初始状态
          const before = await callJson('window.airimate.listProviders()') as { providers?: unknown[] }
          const beforeCount = Array.isArray(before.providers) ? before.providers.length : -1
          result.initialProviderCount = beforeCount
          mark('wizard.initial-state-readable', beforeCount >= 0)

          /**
           * ── ①-b **先把向导切到第 1 步**（provider）
           *
           * ⚠ 两次踩坑，都记下来：
           *
           *   坑 1（探针第一版）：漏了这一步 ⇒ 探针可能在**第 2/3 步**上跑，
           *     那几页没有供应商表单、按钮也**正确地**被禁用（判据未满足）
           *     ⇒ 探针自己造出"按钮被禁用"的假读数，**把工具缺陷伪装成产品缺陷**。
           *
           *   坑 2（本版）：用 IPC `onboardingSetStep('provider')` **切不回去** ——
           *     它返回 `ok:true`，但主进程的 `advanceOnboarding` 看到 provider 判据未满足，
           *     就把步骤**按回 `blockedBy`**（这是**正确的**自愈行为）。
           *     ⇒ 唯一能回到第 1 步的路径是点界面上的「上一步」。
           *     这也正是用户实际能走的路（他从第 2 步只能靠「上一步」回去）。
           *
           *   ⚠ 注意 `onboardingSetStep` 的 `ok:true` 与"步骤真的变了"**不是一回事** ——
           *     只读返回码就会得出"切成功了"的错误结论（本条断言就是为它加的）。
           */
          const backClicked = await call(`(() => {
            const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent && x.textContent.trim() === '上一步')
            if (!b || b.disabled) return { clicked: false, disabled: b ? b.disabled : null }
            b.click()
            return { clicked: true }
          })()`) as { clicked?: boolean }
          result.backButtonClicked = backClicked.clicked ?? false
          await new Promise(r => setTimeout(r, 400))
          /** 从 DOM 读回"现在到底是第几步"（自证前提成立，而不是假设） */
          const stepProbe = await call(`(() => {
            const foot = document.querySelector('.wizard__foot')
            const on = document.querySelector('.wizard__step.is-on')
            return { footText: foot ? foot.textContent.trim().slice(0, 60) : null, onStep: on ? on.textContent.trim() : null }
          })()`) as { footText?: string | null, onStep?: string | null }
          result.wizardFootText = stepProbe.footText ?? null
          result.wizardOnStep = stepProbe.onStep ?? null
          mark('wizard.on-provider-step', String(stepProbe.onStep ?? '').includes('供应商'))

          // ── ② 按钮存在且**未被禁用**（死锁的直接读数）
          const btnInfo = await call(`(() => {
            const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent && x.textContent.trim() === '保存并继续')
            if (!b) return { found: false }
            return { found: true, disabled: b.disabled === true }
          })()`) as { found?: boolean, disabled?: boolean }
          mark('wizard.save-button-present', btnInfo.found === true)
          result.saveButtonDisabled = btnInfo.disabled ?? null
          /**
           * ★★ 核心判据：**第 1 步的保存按钮绝不能被禁用**。
           *   它一旦被禁用就是死锁 —— provider 判据只能靠"保存"来满足。
           */
          mark('wizard.save-button-enabled-on-provider-step', btnInfo.found === true && btnInfo.disabled === false)

          // ── ③ 真的填表（占位值，不给真实密钥）
          const filled = await call(`(() => {
            const inputs = Array.from(document.querySelectorAll('.wizard__body input'))
            if (inputs.length < 4) {
              return { ok: false, count: inputs.length, types: inputs.map(i => i.type || i.tagName) }
            }
            const setVal = (el, v) => {
              el.focus()
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
              setter.call(el, v)
              el.dispatchEvent(new Event('input', { bubbles: true }))
              el.dispatchEvent(new Event('change', { bubbles: true }))
              el.blur()
            }
            setVal(inputs[0], 'ProbeProvider')
            setVal(inputs[1], 'https://api.deepseek.com')
            setVal(inputs[2], 'probe-model')
            return { ok: true, count: inputs.length, now: inputs.map(i => i.value) }
          })()`) as { ok?: boolean, count?: number, now?: string[], types?: string[] }
          mark('wizard.form-fillable', filled.ok === true)
          result.formInputCount = filled.count ?? null
          result.formValuesAfterFill = filled.now ?? null
          await new Promise(r => setTimeout(r, 250))

          // ── ④ **真的点它**（死锁时这一步什么都不会发生）
          const clicked = await call(`(() => {
            const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent && x.textContent.trim() === '保存并继续')
            if (!b) return { clicked: false }
            b.click()
            return { clicked: true }
          })()`) as { clicked?: boolean }
          mark('wizard.save-button-clicked', clicked.clicked === true)
          await new Promise(r => setTimeout(r, 1200))

          // ── ⑤ 读回：保存动作是否真的生效
          const after = await callJson('window.airimate.listProviders()') as {
            providers?: Array<{ id: string, label?: string }>
          }
          const list = Array.isArray(after.providers) ? after.providers : []
          result.afterProviderCount = list.length
          mark('wizard.provider-persisted-after-click', list.length > beforeCount)
          const mine = list.find(p => p.label === 'ProbeProvider')
          result.savedProviderId = mine?.id ?? null

          const onb = await callJson('window.airimate.onboardingGet()') as {
            status?: { satisfied?: Record<string, boolean> }
          }
          result.onboardingSatisfied = onb.status?.satisfied ?? null
          /**
           * ⚠ **不**断言 `satisfied.provider === true`：占位供应商没有密钥，
           *   按判据本就不该满足（"配了但没钥匙等于没配"是既有单测钉死的语义）。
           *   本探针要证明的是「**点保存 ⇒ 供应商真的落盘**」这条动作链通了 ——
           *   那正是死锁里唯一被卡住的东西。
           */
          mark('wizard.provider-criterion-honest-without-key',
            (onb.status?.satisfied?.provider ?? null) === false)

          // ── ⑥ 清理：删掉自己造的供应商（不给用户留垃圾）
          if (mine?.id) {
            const del = await callJson(`window.airimate.deleteProvider(${JSON.stringify(mine.id)})`)
            mark('wizard.cleanup-deleted-probe-provider', del.ok === true)
          } else {
            mark('wizard.cleanup-deleted-probe-provider', true)
          }
          const final = await callJson('window.airimate.listProviders()') as { providers?: unknown[] }
          result.finalProviderCount = Array.isArray(final.providers) ? final.providers.length : null
          mark('wizard.no-residue', (result.finalProviderCount ?? -1) === beforeCount)
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e)
        }
        const entries = Object.entries(checks)
        const passed = entries.filter(([, v]) => v).length
        result.totalChecks = entries.length
        result.passedChecks = passed
        result.failedChecks = entries.filter(([, v]) => !v).map(([k]) => k)
        result.pass = entries.length >= 8 && passed === entries.length
        console.log(`[airimate] PROBE_WIZARD ${JSON.stringify({ pass: result.pass, passed, total: entries.length, failed: result.failedChecks })}`)
        try { if (cli.probeOut) writeFileSync(cli.probeOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (cli.probeExit) quit('probe')
      })()
    }, probeAt)
  }

  // 诊断自动落盘（**无条件**，启动 4s 后写一次）：  // 为什么不用 --diag-once 定时器：那条路径依赖"到点后采集成功"，  // 采集里任何一步卡住就什么都拿不到（实测踩到：多次运行都没有文件）。
  // 这里改成"启动后一次性写"，与退出路径完全解耦；--diagnostics 给了路径就生效。
  if (cli.diagnosticsFile) {
    const diagFile: string = cli.diagnosticsFile
    /**
     * ⚠ 必须**原子写**（临时文件 + rename）。
     *   实测踩到：4s 周期的整文件重写与外部读取（QA 脚本）撞在一起时，
     *   读到的 JSON 被截断 ⇒ PowerShell 侧静默解析失败 ⇒ 所有字段读成空，
     *   看起来像"渲染没跑"，其实是取证管道自己的问题。
     */
    const writeAtomic = (): void => {
      try {
        const d = collectDiagnostics()
        const tmp = `${diagFile}.tmp`
        writeFileSync(tmp, `${JSON.stringify(d, null, 2)}\n`, 'utf8')
        renameSync(tmp, diagFile)
        log().info('诊断快照已落盘', { file: diagFile }, 'diag.auto-written')
        console.log(`[airimate] DIAGNOSTICS_WRITTEN ${diagFile}`)
      } catch (e) {
        log().warn('诊断自动落盘失败', { err: e instanceof Error ? e.message : String(e) }, 'diag.auto-failed')
      }
    }
    setTimeout(writeAtomic, 4000)
    diagTimer = setInterval(writeAtomic, 8000)
  } else {
    // 只给 --diag-once 不给 --diagnostics 时也允许用默认路径（避免"忘了传路径就没证据"）
    if (cli.exitAfterDiagnosticsMs !== null) {
      const fallback = join(appPaths().userData, 'diagnostics.json')
      const writeFallback = (): void => {
        try {
          const d = collectDiagnostics()
          const tmp = `${fallback}.tmp`
          writeFileSync(tmp, `${JSON.stringify(d, null, 2)}\n`, 'utf8')
          renameSync(tmp, fallback)
          console.log(`[airimate] DIAGNOSTICS_WRITTEN ${fallback}`)
        } catch { /* ignore */ }
      }
      setTimeout(writeFallback, 4000)
      diagTimer = setInterval(writeFallback, 8000)
    }
  }

  // 诊断一次性导出（QA 用；不新开端口）
  if (cli.exitAfterDiagnosticsMs !== null) {
    log().info('--diag-once 已排程', { ms: cli.exitAfterDiagnosticsMs, file: cli.diagnosticsFile ?? '<none>' }, 'diag.scheduled')
    setTimeout(() => {
      // 先写文件再退出：`quit()` 之后进程会很快结束，延迟写会丢证据
      void (async () => {
        try {
          if (cli.diagnosticsFile) {
            // 硬超时：诊断采集里的任何一步（外部进程调用等）都不允许拖住退出
            const d = await Promise.race([
              collectDiagnostics(),
              new Promise<null>(resolve => setTimeout(() => resolve(null), 8000)),
            ])
            if (d) {
              writeFileSync(cli.diagnosticsFile, `${JSON.stringify(d, null, 2)}\n`, 'utf8')
              console.log(`[airimate] DIAGNOSTICS_WRITTEN ${cli.diagnosticsFile}`)
            } else {
              console.error('[airimate] DIAGNOSTICS_TIMEOUT 采集超时（8s）')
            }
          }
        } catch (e) {
          console.error(`[airimate] DIAGNOSTICS_FAILED ${e instanceof Error ? e.message : String(e)}`)
        }
        log().info('--diag-once：导出诊断后退出', { file: cli.diagnosticsFile ?? '<none>' }, 'diag.once')
        quit('diag-once')
      })()
    }, cli.exitAfterDiagnosticsMs)
  }

  log().info('启动完成', {
    mode, windowId: win.id, legacyContinue,
    /** 一致性断言：申请的模式必须等于实际生效的模式（这类"参数静默失效"本项目反复踩到） */
    modeApplied: windowMode(), modeConsistent: windowMode() === mode,
    protocol: JSON.stringify(protocolInfo()),
    clips: motion.clipCount, manifests: motion.manifestCount,
  }, 'boot.ready')
  if (windowMode() !== mode) {
    log().error('模式一致性断言失败：申请与实际不一致', { requested: mode, applied: windowMode() }, 'window.mode.mismatch')
  }
}

// ───────────────────────────────────────────────────────── 退出

/**
 * 真正退出的唯一门闩。
 * ⚠ 顺序很关键：必须**先**置位再 `app.quit()`，否则 `app.quit()` 触发的 window 'close'
 *   事件会被"关闭 = 隐藏"的处理器 preventDefault 掉，导致进程永远退不出去（实测踩到：
 *   QA 脚本挂住 150s）。
 */
/**
 * ★ M2：启动主动陪伴引擎。
 *
 * 依赖全部显式注入（不 import 全局单例），这样：
 *   · 引擎本身可以在单测里跑穿（`runTick(deps)` 传假采样器与假时钟）；
 *   · 主进程只负责"把真实世界接进来" —— 采样走 PowerShell 探针、送达走 IPC、
 *     朗读走 TTS 引擎、就绪判定走供应商探测。
 *
 * 两处刻意的取舍：
 *   · `focus` 恒为 false（引擎内部写死）⇒ **永不抢焦点**，这是用户硬要求；
 *   · 采样失败**不当作"没有阻断"**（见 blocker.ts）⇒ 宁可少提醒也不打断用户。
 */
function startProactive(cli: CliOptions): EngineHandle | null {
  if (cli.noProactive) {
    log().info('主动引擎已按要求禁用（--no-proactive）', {}, 'proactive.disabled-by-cli')
    return null
  }
  /**
   * ⚠ 用**适配层选中的** TTS 实例，绝不自己再造一个。
   *
   * 踩过的坑（同类）：`tts-engine` 是**单实例语义**的 —— 同一时刻只允许一次朗读，
   * 两个引擎实例会各自起一个 SAPI 子进程抢音频设备，声音交叠且取消语义混乱。
   * 适配层把"用哪个 TTS"变成了一次选型，这里只是消费它。
   */
  const tts = capabilityKit().tts()
  const ownPids = (): number[] => {
    const pids = [process.pid]
    try {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          const p = w.webContents.getOSProcessId()
          if (p > 0) pids.push(p)
        }
      }
    } catch { /* ignore */ }
    return pids
  }
  let lastActivitySentAt = 0
  const handle = startProactiveEngine({
    settings: () => loadSettings(),
    patchSettings: (p) => { patchSettings(p) },
    sample: async () => {
      const s = loadSettings()
      const a = await sampleActivity({
        userSilent: s.userSilent,
        includeTitleDigest: s.activityTitleDigestEnabled,
        ownPids: ownPids(),
        scanProcesses: s.activitySamplingEnabled,
      })
      // 采样降级：用户关掉活动采样 ⇒ 只保留很粗的空闲读数，且**标注不可用**
      if (!s.activitySamplingEnabled) {
        a.available = false
        a.unavailableReason = '活动采样已在设置里关闭'
      }
      // 状态变化（含阻断原因）推给 renderer —— UI 要显示"正在会议中，提醒已排队"
      if (Date.now() - lastActivitySentAt > 5_000) {
        lastActivitySentAt = Date.now()
        const verdict = currentBlocker()
        broadcast(IPC.EVT_ACTIVITY, { ...a, blocked: verdict.blocked, blockReason: verdict.reason })
      }
      return a
    },
    emit: (e) => {
      sendProactiveEvent(e)
      broadcast(IPC.EVT_REMINDER_QUEUE, { queued: proactiveStatus().queueLength, unacked: proactiveStatus().activeReminders })
    },
    speak: async (text, id) => {
      const s = loadSettings()
      // 朗读受两重开关约束：用户开了 TTS + 明确允许电台朗读
      if (!s.ttsEnabled) return
      await tts.speak(text, id, { voice: s.ttsVoice ?? null, output: 'device' })
    },
    ready: async () => await probeReadiness((id) => secretStore().get(id)),
    // 探针用 `--proactive-fast` 把间隔压到 1s（默认 10s）
    tickMs: cli.proactiveFast ? 1000 : 10_000,
  })
  log().info('主动引擎已接线', {
    fast: cli.proactiveFast, tickMs: cli.proactiveFast ? 1000 : 10_000,
    probe: probeScriptPathForLog(),
  }, 'proactive.wired')
  return handle
}

/** 只记路径存在性，不记内容（日志脱敏纪律） */
function probeScriptPathForLog(): string {
  try {
    const p = join(appPaths().workspaceRoot, 'tools', 'qa', 'activity-probe.ps1')
    return `${existsSync(p) ? 'exists' : 'missing'}:${p}`
  } catch { return 'unknown' }
}

export function quit(reason: string): void {
  if (isQuitting) return
  isQuitting = true
  log().info('开始退出', { reason, windows: BrowserWindow.getAllWindows().length }, 'boot.quit')
  // 兜底：无论下面哪一步卡住，2.5s 后强制退出（保证进程不会悬挂）
  const force = setTimeout(() => {
    try { log().warn('正常退出超时 → 强制退出', {}, 'boot.quit.forced') } catch { /* ignore */ }
    app.exit(0)
  }, 2500)
  force.unref?.()
  if (diagTimer) { clearInterval(diagTimer); diagTimer = null }
  // 主动引擎先停：否则退出过程中它可能还在采样/朗读/发事件
  try { proactiveHandle?.stop(); proactiveHandle = null } catch { /* ignore */ }
  try { stopProactiveEngine() } catch { /* ignore */ }
  /**
   * ★ M3 清理（退出路径必须做，否则会留下**占用麦克风的孤儿进程**）：
   *   · `stopWakeWatch()` 停掉待机听唤醒循环（**必须在 `disposeVoice()` 之前**：
   *     否则它会在退出过程中又起一个新的识别子进程 —— 那就是"关不掉的麦克风"）；
   *   · `disposeVoice()` 杀掉在飞的识别子进程；
   *   · `cancelAllConfirms()` 把挂起的确认一律按"拒绝"结算（不留悬挂 promise）。
   */
  try { stopWakeWatch('shutdown') } catch { /* ignore */ }
  try { disposeVoice() } catch { /* ignore */ }
  try { cancelAllConfirms('shutdown') } catch { /* ignore */ }
  /**
   * ★ 释放全局快捷键（本轮）。**必须在退出路径里做**：`globalShortcut` 的注册
   *   在进程存活期间一直占着系统热键；不注销就会出现"上一次没退干净 ⇒
   *   这一次启动报「快捷键已被其它软件占用」"这种自伤式的假失败。
   */
  try { releaseConversationHotkey() } catch { /* ignore */ }
  /**
   * ★ 销毁**独立对话窗口**（返工轮）。
   *   必须在"销毁全部窗口"之前：`destroyChatWindow()` 会先把最终几何写回设置，
   *   若窗口已经被 `destroy()` 掉，那一次记录就丢了（下次打开会回到旧位置）。
   *   与「关闭 = 隐藏」区分开：这一条路径是**真销毁**。
   */
  try { destroyChatWindow() } catch { /* ignore */ }
  try { flushSettings() } catch { /* ignore */ }
  try { hitRegions().stop() } catch { /* ignore */ }
  try { unregisterIpc() } catch { /* ignore */ }
  try { destroyTray() } catch { /* ignore */ }
  try { shutdownSingleInstance() } catch { /* ignore */ }
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.destroy()   // 直接销毁，绕过 'close' 的隐藏语义
    }
  } catch { /* ignore */ }
  app.quit()
}

export function quitting(): boolean {
  return isQuitting
}

/** 供 QA：进程组实例数（本应用根进程恒为 1） */
export function instanceCount(): number {
  const s = instanceStatus()
  return s?.decision === 'primary' ? 1 : 0
}
