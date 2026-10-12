/**
 * apps/desktop/src/main/pet-visibility.ts —— **桌宠窗口的呼出 / 收回 / 常驻**的唯一状态机
 *（2026-10-09 完善轮新增）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 这个文件存在的理由（用户本轮的三条要求）：
 *
 *   ① 「桌宠是否常驻」开关 —— `petResident`（默认 `false`）；
 *   ② 「呼出 / 收回桌宠」—— 三处菜单入口（对话窗口菜单栏 / 托盘 / 桌宠右键）都要有；
 *   ③ **启动行为改了**：打开软件**不再自动出现桌宠**，
 *      默认只出现对话窗口（`startupOpenChat` 默认 `true`）。
 *
 * ⚠ **两个概念必须分开，否则一定会做错**：
 *
 *   | 概念 | 字段 | 回答的问题 |
 *   |---|---|---|
 *   | **常驻** | `settings.petResident` | "**下次启动**要不要自己出现？"（持久） |
 *   | **可见** | `BrowserWindow.isVisible()` | "**现在**看不看得见她？"（瞬时） |
 *
 *   · 「收回桌宠」**只改可见性**，不写 `petResident` ——
 *     用户点"收回"的意思是"我现在先不想看见她"，不是"以后都别出现了"。
 *     把两者混成一个字段，用户就无法表达"常驻，但我先收起来一会儿"，
 *     而那恰恰是最常用的组合。
 *   · 「取消常驻」**两件事都做**：写 `petResident=false` **并**顺手收回窗口 ——
 *     否则勾掉之后她还杵在那儿，用户会以为勾选框坏了。
 *   · 「呼出桌宠」**不改 `petResident`**：呼出是"这一次我要看她"，
 *     它不该顺手把应用改成常驻（那是用户没要求的持久副作用）。
 *
 * ⚠ **本文件不创建窗口**：窗口的创建点只有两处（`window-manager.ts` 的
 *   `createMainWindow` 与 `chat-window.ts` 的 `ensureChatWindow`）。
 *   这里只做 show/hide + 写设置 + 广播状态，第三个 `new BrowserWindow()` 是禁止项。
 * ════════════════════════════════════════════════════════════════════════════
 */
import type { PetMenuState } from '@airimate/shared'
import { IPC } from '@airimate/shared'
import { log } from './log.js'
import { broadcast } from './event-sink.js'
import { hitRegions } from './hit-region-registry.js'
import { flushSettings, loadSettings, mergeSettings } from './settings-store.js'
import { getWindow, hideWindow, showWindow, windowCreated, windowVisible } from './window-manager.js'

/**
 * ★ 让 renderer 把"未显示"的干净态落实（气泡收起 / 轮盘关闭 / 命中区域清空）。
 *
 * 为什么这条必须**同时**做两件事（主进程清 + renderer 清）：
 *   · 主进程这一侧清掉 `HitRegionService` 的矩形（否则那块区域还会吃桌面点击）；
 *   · renderer 那一侧收起气泡与轮盘（否则她们的状态活着，下次呼出会"带着旧气泡"出现）。
 * 两件都不能少，而它们的失效方式都是**不可见**的 —— 所以判据要读
 * `hitregions` 的 `regions` 计数与 renderer 探针的 `bubbleVisible`。
 */
function announceVisibility(action: 'pet-hidden' | 'pet-shown'): void {
  if (action === 'pet-hidden') {
    /**
     * ⚠ 顺序：先清主进程的命中区域，再通知 renderer。
     *   反过来的话，renderer 在收到通知与清理之间可能又上报一次旧几何，
     *   把刚清掉的矩形**写回来**（那种竞态只在慢机器上偶发，最难查）。
     */
    try { hitRegions().reset('pet-hidden') } catch { /* 未启动的服务不算错误 */ }
  }
  try {
    broadcast(IPC.EVT_UI_ACTION, { action, source: 'api', at: Date.now() })
  } catch (e) {
    log().debug('可见性通知广播失败', { action, err: e instanceof Error ? e.message : String(e) }, 'pet.visibility.broadcast-failed')
  }
}

/** 桌宠窗口**此刻**的可见性（窗口不存在或已销毁 ⇒ `false`） */
export function petWindowVisible(): boolean {
  return windowVisible()
}

/** 窗口是否已被创建（未创建时"收回"是空操作，不该报错也不该写设置） */
export function petWindowCreated(): boolean {
  return windowCreated()
}

export function petWindowMinimized(): boolean {
  const w = getWindow()
  if (!w || w.isDestroyed()) return false
  return w.isMinimized()
}

export function petResident(): boolean {
  return loadSettings().petResident
}

/**
 * 动作来源。与 shared 的 zod 枚举保持一致（这里是**类型**，运行时校验在 `ipc.ts`）。
 *
 * ⚠ 两处枚举必须一起改：`PetActionSource`（这里）与 `PetResidentRequestSchema`
 *   （`packages/shared/src/ipc.ts`）。少改一处会**编译失败**（这是有意的：
 *   上一次少改一处时，运行期表现为"来源被 zod 拒绝、设置没变"，而界面什么都不说）。
 */
export type PetActionSource =
  | 'tray' | 'chat-menu' | 'pet-menu' | 'hotkey' | 'startup' | 'probe' | 'settings-panel' | 'api'

/** 启动时是否自动打开对话窗口（默认 `true`） */
export function startupOpenChat(): boolean {
  return loadSettings().startupOpenChat
}

/**
 * 托盘 tooltip 与菜单用的**同一份**人话状态。
 *
 * 为什么"同一份"是要紧的：tooltip 与菜单如果各算一次，
 * 迟早会出现"菜单说已收回、悬停提示说已呼出"这种自相矛盾的读数，
 * 而它不会有任何报错。⇒ 只有这一个函数，两边都调它。
 *
 * 五种状态的分母（**"常驻"与"已呼出"不是一回事**）：
 *   · 窗口还没创建            ⇒ 已收回（未创建）
 *   · 常驻 + 可见             ⇒ 常驻中
 *   · 常驻 + 被最小化         ⇒ 常驻中（已最小化）
 *   · 非常驻 + 可见           ⇒ 已呼出（临时）
 *   · 不可见                  ⇒ 已收回
 */
export function petStatusText(s: { resident: boolean, visible: boolean, created: boolean, minimized: boolean }): string {
  if (!s.created) return '桌宠已收回（未创建）'
  if (s.minimized) return s.resident ? '桌宠常驻中（已最小化）' : '桌宠已呼出（已最小化）'
  if (s.visible) return s.resident ? '桌宠常驻中' : '桌宠已呼出'
  return '桌宠已收回'
}

/**
 * ★ 组装出一份**完整**的 `PetMenuState`（唯一实现；托盘 tooltip / 三处菜单 /
 *   `conversation:state` 全都调它 —— 这是"三处读数不可能互相矛盾"的结构性保证）。
 *
 * ⚠ 为什么单独抽一个纯函数（而不是各调用点自己拼对象）：
 *   少写一个字段（例如某处忘了 `minimized`）不会报错，只会让那一处显示错状态 ——
 *   而"三处勾选/状态不一致"正是 C4 要防的形态。
 */
export function buildPetMenuState(s: {
  resident: boolean, visible: boolean, created: boolean, minimized: boolean, windowId: number | null
}): PetMenuState {
  return { ...s, statusText: petStatusText(s) }
}

/** 只读快照（三处菜单 + 托盘 tooltip + `conversation:state` 共用这一份） */
export function petMenuState(): PetMenuState {
  const w = getWindow()
  return buildPetMenuState({
    resident: petResident(),
    visible: petWindowVisible(),
    created: petWindowCreated(),
    minimized: petWindowMinimized(),
    windowId: w && !w.isDestroyed() ? w.id : null,
  })
}

export interface PetActionResult {
  ok: boolean
  /** 这次调用**真的**改变了可见性吗（`false` = 本来就是那个状态，幂等成功） */
  changed: boolean
  state: PetMenuState
  /** 拒绝原因（非空 ⇒ `ok:false`） */
  reason: string | null
}

function result(before: boolean, ok: boolean, reason: string | null): PetActionResult {
  const after = petWindowVisible()
  return { ok, changed: before !== after, state: petMenuState(), reason }
}

/**
 * **呼出桌宠**（显示并聚焦；最小化时先恢复）。
 *
 * ⚠ 窗口不存在时**不创建**：创建只发生在启动流程里（`bootstrap`）。
 *   理由：窗口的创建参数（preload 路径 / devServerUrl / fpsCap）只有 bootstrap 拼得出来，
 *   在这里再拼一份就是第二个真源 —— 而"两个真源"在本项目已经造成过
 *   `--mode=pet` 静默失效那类问题。
 *   ⇒ 启动时窗口**总是**被创建（只是不显示），所以运行期它必然存在。
 */
export function showPet(source: PetActionSource): PetActionResult {
  const before = petWindowVisible()
  const w = getWindow()
  if (!w || w.isDestroyed()) {
    log().error('呼出桌宠失败：窗口不存在（启动流程没有创建它）', { source }, 'pet.show.no-window')
    return { ok: false, changed: false, state: petMenuState(), reason: 'no-window' }
  }
  try {
    showWindow()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log().error('呼出桌宠失败', { source, err: msg }, 'pet.show.failed')
    return { ok: false, changed: false, state: petMenuState(), reason: msg.slice(0, 300) }
  }
  const r = result(before, true, null)
  log().info('桌宠已呼出', { source, changed: r.changed, resident: r.state.resident }, 'pet.show')
  /** 呼出 ⇒ 解除"未显示"的干净态（气泡/轮盘可以重新工作） */
  if (r.changed) announceVisibility('pet-shown')
  return r
}

/**
 * **收回桌宠**（隐藏，不销毁、不退出）。
 *
 * ⚠ **不写 `petResident`**（见文件头的两个概念表）。返回体里 `state.resident` 原样保留，
 *   界面据此知道"收回之后常驻设置没有被改"。
 */
export function hidePet(source: PetActionSource): PetActionResult {
  const before = petWindowVisible()
  const w = getWindow()
  if (!w || w.isDestroyed()) {
    /** 未创建 = 本来就不可见 ⇒ 幂等成功（不报错，否则托盘项会变成一个会失败的按钮） */
    log().info('收回桌宠：窗口尚未创建（幂等成功）', { source }, 'pet.hide.no-window')
    return { ok: true, changed: false, state: petMenuState(), reason: null }
  }
  try {
    hideWindow()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log().error('收回桌宠失败', { source, err: msg }, 'pet.hide.failed')
    return { ok: false, changed: false, state: petMenuState(), reason: msg.slice(0, 300) }
  }
  const r = result(before, true, null)
  log().info('桌宠已收回（不写常驻设置）', {
    source, changed: r.changed, residentUnchanged: r.state.resident,
  }, 'pet.hide')
  /**
   * ★★ 收回 ⇒ **命中区域与气泡/轮盘状态回到"未显示"的干净态**（本轮完善项）。
   *   不做这件事的后果是"看不见的窗口还在吃桌面点击"，而它不会报任何错。
   */
  if (r.changed) announceVisibility('pet-hidden')
  return r
}

/** 呼出 ⇄ 收回（托盘的「显示桌宠 / 收回桌宠」两项就是 `show` / `hide` 的显式版本） */
export function togglePet(source: PetActionSource): PetActionResult {
  return petWindowVisible() ? hidePet(source) : showPet(source)
}

/**
 * ★★ **写「桌宠常驻」并立即生效 + 落盘**（用户要求："切换要立即生效并落盘"）。
 *
 * 三件事的顺序**不可调换**：
 *   ① 先写设置（`mergeSettings`，内存态立刻生效）；
 *   ② **立即 flush**（不等 800ms 防抖）—— "重启后仍生效"这条判据完全依赖它，
 *      而防抖没落盘时进程被杀 ⇒ 用户勾了、重启后又是旧值（且无从察觉）；
 *   ③ 再动窗口（勾上 ⇒ 显示；取消 ⇒ 收回）。
 *
 * ⚠ 第 ③ 步可能失败（窗口不存在），**但设置已经写了** —— 这是刻意的：
 *   用户勾的是"以后启动都要显示她"，那一半必须算数。失败会如实出现在返回体里。
 */
export function setPetResident(resident: boolean, source: PetActionSource): PetActionResult & { persisted: boolean } {
  mergeSettings({ petResident: resident })
  let persisted = true
  try {
    flushSettings()
  } catch (e) {
    persisted = false
    log().error('常驻设置写盘失败', { source, err: e instanceof Error ? e.message : String(e) }, 'pet.resident.persist-failed')
  }
  /** 生效：勾上 ⇒ 呼出；取消 ⇒ 收回。幂等（本来就是那个状态时 changed=false） */
  const eff = resident ? showPet(source) : hidePet(source)
  log().info('桌宠常驻设置已更新', { source, resident, persisted, changed: eff.changed }, 'pet.resident')
  return { ...eff, persisted }
}
