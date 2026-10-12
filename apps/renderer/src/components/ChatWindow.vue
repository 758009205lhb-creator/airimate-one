<script setup lang="ts">
/**
 * apps/renderer/src/components/ChatWindow.vue —— **独立对话窗口**的视图
 * （2026-10-08 返工轮新增；2026-10-09 完善轮按参考实现重做外壳）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 本轮（2026-10-09）对齐参考实现 `DataAxeagle/DockPetWin-Aemeath` 的三件事：
 *
 *   ① **窗口框架改成 `frame: true`**（系统原生边框，见 `main/chat-window.ts`）。
 *      ⇒ 上一版那套「自绘标题栏 + 最小化/关闭按钮」**整条删除**：
 *        系统已经提供了拖动 / 缩放 / 最小化 / 最大化 / 左上角系统菜单 / 右上角三个按钮，
 *        自绘一套只会是它们的劣化复制品（复刻不出系统菜单与贴边手势）。
 *      现在窗口内顶部那一条叫**信息头**（头像 + 标题 + 状态），不是标题栏。
 *   ② **窗口内新增一条菜单栏**（深色自绘下拉，与既有 UI 一致）：
 *      文件 / 桌宠 / 对话 / 记忆 / 设置 / 帮助。
 *      ★ 纪律：**每一个菜单项都必须有真实动作**；点了没反应或显示"暂未实现"的一律算失败。
 *        不支持的功能直接不显示（本文件里没有 `disabled` 的功能项）。
 *   ③ **底部操作行**对齐参考：输入框 + 麦克风 + 清除对话 + 打开数据目录 + 发送/停止
 *      （清空对话仍是**两步确认**）。
 *
 * 三条**不许违反**的纪律（沿用返工轮）：
 *
 *   ① **这里绝不出现角色 / WebGL**。
 *      本组件**不 import `AvatarStage.vue`**，也不 import 任何 three / VRM 模块。
 *      判据：chat 窗口内 canvas 数 = 0，Scene/Renderer/Mixer/VRM 计数全为 0，
 *      全应用 WebGLRenderer 总数恒为 1（只在 pet 窗口里）。
 *   ② **不写第二套发送链路**。打字与语音都调 `store.ask()`。
 *   ③ **不新开麦克风**。语音走已有的 `voice:listen-once`，`hearingEnabled=false` 时
 *      必须**看得见地拒绝**（`app.listenOnce()` 内部已经这么做）。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue'
import { ICONS } from '@airimate/radial-menu'
import { useApp } from '../store'
import { bridge } from '../bridge'

const app = useApp()

const root = ref<HTMLDivElement | null>(null)
const input = ref<HTMLTextAreaElement | null>(null)
/** 对话滚动区的元素（模板 ref；`scrollToBottom` 用它决定要不要贴底） */
const listEl = ref<HTMLDivElement | null>(null)
const draft = ref('')
const sending = ref(false)
/** 「清空对话」的两步确认（第一步变成"再点一次确认"） */
const clearArmed = ref(false)
/** 首帧聚焦是否成功（探针读数；"入口生效了但焦点没进去"是一种看起来正常的失败） */
const focusOk = ref<boolean | null>(null)
const focusAttempts = ref(0)

/** 麦克风图标：复用轮盘同一份**编译期常量** SVG（与 radial-menu 渲染图标的方式一致） */
const hearingIcon = ICONS.hearing

const busy = computed(() => app.streaming !== null || sending.value)
const canSend = computed(() => draft.value.trim().length > 0)
/** 标题：「和 {角色名} 聊天」；取不到人设名时用默认名 */
const personaName = computed(() => (app.persona?.name ?? '').trim() || '她')
const title = computed(() => `和 ${personaName.value} 聊天`)
/** 头像用的首字（参考实现的头部有一个小头像位） */
const initial = computed(() => personaName.value.slice(0, 1))

/** 状态行（参考实现的"状态"位）：正在听 / 思考中 / 朗读中，按真实状态给一个词 */
const statusText = computed(() => {
  if (app.listening) return '正在听…'
  if (busy.value) return '思考中…'
  if (app.ttsActive) return '朗读中…'
  return '在线'
})
const statusKind = computed(() => (app.listening ? 'listen' : busy.value ? 'think' : app.ttsActive ? 'speak' : 'idle'))

/** 展示用的时间（只到分钟；不显示秒，避免每帧重排） */
function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 消息来源的人话标签（她主动说的那几条要能看出来） */
function originLabel(o: string): string {
  if (o === 'proactive') return '主动'
  if (o === 'radio') return '电台'
  if (o === 'reflection') return '自省'
  return ''
}

// ═══════════════════════════════════════════════════════════════════ 菜单栏
/**
 * ★★ 菜单栏的**目录**（唯一真源）。
 *
 * 为什么把菜单项写成数据而不是模板里的一堆 `<li @click>`：
 *   判据 C6 要求"**每一个菜单项都必须有真实动作**，无死项"。
 *   写成数据之后，探针可以**逐个执行**它们并记录每一项的返回值 ⇒
 *   "点了没反应"就变成一个**机械可测**的事实，而不是靠人点一遍看看。
 *
 * `action` 的取值就是"这条菜单项会去调什么"。**每一个都有实现**（见 `runAction`）——
 * 目录里不允许出现没有实现的 action（探针会断言 `missingAction === 0`）。
 */
type MenuAction =
  | 'hideWindow'          // 文件 → 隐藏窗口（= × / Esc；只隐藏，不销毁）
  | 'quitApp'             // 文件 → 退出应用
  | 'restartApp'          // 文件 → 重启应用（先拉起新进程，再退出）
  | 'petShow'             // 桌宠 → 显示桌宠
  | 'petHide'             // 桌宠 → 收回桌宠
  | 'petToggleResident'   // 桌宠 → ☑ 桌宠常驻
  | 'petOpenPanel'        // 桌宠 → 打开管理面板
  | 'newConversation'     // 对话 → 新建对话（只重置上下文，不删历史）
  | 'clearConversation'   // 对话 → 清除对话（两步确认）
  | 'openDataDir'         // 对话 → 打开数据目录
  | 'openMemory'          // 记忆 → 打开记忆页
  | 'openSchedule'        // 记忆 → 打开日程与提醒
  | 'openSettings'        // 设置 → 偏好设置
  | 'openVoice'           // 设置 → 语音与麦克风
  | 'openShortcuts'       // 设置 → 快捷键
  | 'toggleAutoStart'     // 设置 → ☑ 开机自启（立即写入启动项 + 落盘）
  | 'toggleAlwaysOnTop'   // 设置 → ☑ 对话窗口置顶
  | 'showShortcutList'    // 帮助 → 快捷键一览
  | 'showAbout'           // 帮助 → 关于

interface MenuEntry {
  id: string
  label: string
  action: MenuAction
  /** 勾选项（只有「桌宠常驻」用） */
  checked?: boolean
  /** 分隔线（`label` 为空） */
  sep?: boolean
  /**
   * 这一项会把**本次会话带走**（隐藏窗口 / 退出应用）。
   * 探针据此**不执行**它（执行了就再也读不到后面的读数），
   * 但**仍然断言它的 action 有实现**（`missingAction === 0`）。
   */
  leavesSession?: boolean
}

interface MenuGroup { id: string, label: string, items: MenuEntry[] }

/** 已执行的菜单项（探针读数；只记 id 与结果摘要，不含任何用户内容） */
const menuRuns: Array<{ id: string, action: string, ok: boolean, detail: string }> = []

const petVisible = computed(() => app.petVisible)
const petResident = computed(() => app.petResident)

/**
 * 菜单栏定义。
 *
 * ⚠ 「桌宠」组的三个动词项**按状态互斥显示，但都常驻在目录里**：
 *   菜单里同时有「显示桌宠」与「收回桌宠」两项（与托盘的写法一致，位置不跳动），
 *   点哪一项都能用（幂等）—— 而不是"把不适用的那项藏起来"，那会让菜单位置乱跳。
 *   唯一的例外是**勾选项的文案不随状态变**（就是「桌宠常驻」，勾选态表达状态）。
 */
const menus = computed<MenuGroup[]>(() => [
  {
    id: 'file', label: '文件',
    items: [
      { id: 'file.hide', label: '隐藏窗口', action: 'hideWindow', leavesSession: true },
      { id: 'file.restart', label: '重启应用', action: 'restartApp', leavesSession: true },
      { id: 'file.quit', label: '退出应用', action: 'quitApp', leavesSession: true },
    ],
  },
  {
    id: 'pet', label: '桌宠',
    items: [
      { id: 'pet.show', label: '显示桌宠', action: 'petShow' },
      { id: 'pet.hide', label: '收回桌宠', action: 'petHide' },
      { id: 'pet.resident', label: '桌宠常驻', action: 'petToggleResident', checked: petResident.value },
      { id: 'pet.panel', label: '打开管理面板', action: 'petOpenPanel' },
    ],
  },
  {
    id: 'chat', label: '对话',
    items: [
      { id: 'chat.new', label: '新建对话', action: 'newConversation' },
      { id: 'chat.clear', label: '清除对话', action: 'clearConversation' },
      { id: 'chat.dir', label: '打开数据目录', action: 'openDataDir' },
    ],
  },
  {
    id: 'memory', label: '记忆',
    items: [
      { id: 'memory.page', label: '打开记忆页', action: 'openMemory' },
      { id: 'memory.schedule', label: '打开日程与提醒', action: 'openSchedule' },
    ],
  },
  {
    id: 'settings', label: '设置',
    items: [
      { id: 'settings.pref', label: '偏好设置', action: 'openSettings' },
      { id: 'settings.voice', label: '语音与麦克风', action: 'openVoice' },
      { id: 'settings.hotkey', label: '快捷键', action: 'openShortcuts' },
      { id: 'settings.autostart', label: '开机自启', action: 'toggleAutoStart', checked: app.autoStart },
      { id: 'settings.ontop', label: '对话窗口置顶', action: 'toggleAlwaysOnTop', checked: app.settings?.chatWindowAlwaysOnTop === true },
    ],
  },
  {
    id: 'help', label: '帮助',
    items: [
      { id: 'help.shortcuts', label: '快捷键一览', action: 'showShortcutList' },
      { id: 'help.about', label: '关于', action: 'showAbout' },
    ],
  },
])

/** 当前展开的菜单 id（`null` = 全部收起） */
const openMenu = ref<string | null>(null)
/** 当前悬停的菜单 id（用于"已经展开时，划过即切换"） */
const hoverMenu = ref<string | null>(null)

function toggleMenu(id: string): void {
  openMenu.value = openMenu.value === id ? null : id
}
function hoverSwitch(id: string): void {
  if (openMenu.value !== null) openMenu.value = id
}
/** 点空白处 / Esc 收起菜单 */
function closeMenu(): void { openMenu.value = null }
function onDocClick(ev: MouseEvent): void {
  const el = root.value
  if (!el) return
  if (ev.target instanceof Node && el.querySelector('.chatw__menubar')?.contains(ev.target)) return
  closeMenu()
}
function onDocKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape' && openMenu.value !== null) {
    /**
     * ⚠ 菜单展开时的 Esc **只收菜单**，不隐藏窗口。
     *   不区分的话，"按 Esc 想关掉下拉菜单"会把整个对话窗口收走 —— 那是很烦人的意外。
     */
    ev.preventDefault()
    ev.stopPropagation()
    closeMenu()
  }
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onDocKeydown, true)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onDocKeydown, true)
})

/** 快捷键一览里的行（**全部来自真实状态**，不写死承诺） */
const shortcutRows = computed<Array<{ keys: string, what: string }>>(() => {
  const hk = app.conversationHotkey
  return [
    { keys: hk.enabled && hk.registered ? hk.accelerator : (hk.enabled ? `${hk.accelerator}（未注册）` : '（已关闭）'), what: '呼出对话窗口' },
    { keys: 'Enter', what: '发送（输入法候选期间不发送）' },
    { keys: 'Shift+Enter', what: '换行' },
    { keys: 'Esc', what: '收起对话窗口（不退出应用）' },
    { keys: '菜单栏 Esc', what: '收起下拉菜单' },
  ]
})

/** 菜单项属于哪个组（`menuCatalog` 的 `menu` 字段用） */
function menuOf(i: MenuEntry, groups: MenuGroup[]): string {
  for (const g of groups) if (g.items.some(x => x.id === i.id)) return g.id
  return 'unknown'
}

// ═══════════════════════════════════════════════════════════════════ 动作实现
/**
 * 执行一条菜单动作。
 *
 * ★ **每一个 action 都有实现**（没有 `default: 暂未实现` 这种分支）——
 *   这是"无死项"在代码结构上的保证：TypeScript 的穷尽 switch 会在
 *   新增 action 却没写实现时**编译失败**。
 * 返回值 `detail` 是**可观测的动作结果**（计数 / 状态 / 路径 / ok），
 * 探针据此判定"这一项真的有动作"。
 */
async function runAction(e: MenuEntry): Promise<{ ok: boolean, detail: string }> {
  try {
    switch (e.action) {
      case 'hideWindow': {
        await closeWindow()
        return { ok: true, detail: 'chat-hidden' }
      }
      case 'quitApp': {
        await bridge.quit()
        return { ok: true, detail: 'quit-requested' }
      }
      case 'restartApp': {
        /**
         * ⚠ **重启会把本次会话带走**（与退出同一类），所以它标了 `leavesSession`
         *   ⇒ 探针**不会执行**它（执行了就再也读不到后面的读数）。
         *   这里仍然要有一个**真实实现**（而不是空函数）：用户点它时必须真的重启。
         */
        await bridge.restart()
        return { ok: true, detail: 'restart-requested' }
      }
      case 'petShow': {
        const r = await bridge.petShow('chat-menu')
        return { ok: r.ok !== false, detail: `petVisible=${String((r as { pet?: { visible?: boolean } }).pet?.visible)}` }
      }
      case 'petHide': {
        const r = await bridge.petHide('chat-menu')
        return { ok: r.ok !== false, detail: `petVisible=${String((r as { pet?: { visible?: boolean } }).pet?.visible)}` }
      }
      case 'petToggleResident': {
        const next = !petResident.value
        const r = await bridge.petSetResident(next, 'chat-menu')
        const persisted = String((r as { persisted?: boolean }).persisted)
        return { ok: r.ok !== false, detail: `resident=${String(next)} persisted=${persisted}` }
      }
      case 'petOpenPanel': {
        const r = await bridge.petOpenPanel('chat-menu')
        return { ok: r.ok !== false, detail: `mode=${String((r as { mode?: string }).mode)}` }
      }
      case 'newConversation': {
        const r = await app.resetConversation()
        return { ok: r.ok, detail: `archived=${r.archivedCount ?? -1} visible=${r.visibleCount ?? -1} total=${r.totalCount ?? -1}` }
      }
      case 'clearConversation': {
        /** ⚠ 走**两步确认**那一条实现（菜单里点一次只是"武装"），见 `armClear()` */
        armClear()
        return { ok: true, detail: `clearArmed=${String(clearArmed.value)}` }
      }
      case 'openDataDir': {
        const r = await bridge.openChatDataDir()
        return { ok: r.opened === true, detail: `opened=${String(r.opened)} dir=${(r as { dataDir?: string }).dataDir ?? ''}` }
      }
      case 'openMemory': {
        const r = await bridge.uiAction('memory', 'chat-menu')
        return { ok: r.ok !== false, detail: 'view=memory' }
      }
      case 'openSchedule': {
        const r = await bridge.uiAction('schedule', 'chat-menu')
        return { ok: r.ok !== false, detail: 'view=schedule' }
      }
      case 'openSettings': {
        const r = await bridge.uiAction('settings', 'chat-menu')
        return { ok: r.ok !== false, detail: 'view=settings' }
      }
      case 'openVoice': {
        const r = await bridge.uiAction('voice', 'chat-menu')
        return { ok: r.ok !== false, detail: 'view=voice' }
      }
      case 'openShortcuts':
      case 'showShortcutList': {
        shortcutVisible.value = true
        aboutVisible.value = false
        return { ok: true, detail: `shortcutRows=${shortcutRows.value.length}` }
      }
      /**
       * ★ **开机自启**（勾选项）。真的写系统启动项（`app:startup:set`），
       *   同时把 `settings.autoStart` 落盘 —— 两条都做才算"生效"。
       *   ⚠ 探针会执行它，所以**必须能还原**：探测收尾会把两个方向都跑一遍
       *     （见 `pet-resident-probe.ts` 的 `restore.autoStart`）。
       */
      case 'toggleAutoStart': {
        const next = !app.autoStart
        await app.toggleAutoStart()
        const r = await bridge.startupGet()
        return { ok: r.enabled === next, detail: `autoStart=${String(r.enabled)}` }
      }
      /** ★ **对话窗口置顶**（勾选项）：真的改窗口属性，并落盘 */
      case 'toggleAlwaysOnTop': {
        const next = app.settings?.chatWindowAlwaysOnTop !== true
        await app.patch({ chatWindowAlwaysOnTop: next })
        const r = await bridge.conversationState()
        return {
          ok: (r.state?.chat?.alwaysOnTop ?? null) === next,
          detail: `alwaysOnTop=${String(r.state?.chat?.alwaysOnTop)}`,
        }
      }
      case 'showAbout': {
        aboutVisible.value = true
        shortcutVisible.value = false
        return { ok: true, detail: `persona=${personaName.value}` }
      }
      default: {
        /**
         * ⚠ 这一条**不该被走到**（上面已经覆盖了 `MenuAction` 的全部取值）。
         *   留着它是为了让"新增了一个 action 却没写实现"在编译期/运行期都**可见** ——
         *   而不是静默什么都不做（那正是"死菜单项"的形态）。
         */
        const never: never = e.action
        return { ok: false, detail: `unimplemented:${String(never)}` }
      }
    }
  } catch (err) {
    app.reportFailure(`菜单项「${e.label}」执行失败`, err)
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

async function onMenuClick(e: MenuEntry): Promise<void> {
  closeMenu()
  const r = await runAction(e)
  menuRuns.push({ id: e.id, action: e.action, ok: r.ok, detail: r.detail })
  if (menuRuns.length > 64) menuRuns.shift()
}

/** 快捷键一览 / 关于：两个**真实内容**的小面板（不是"暂未实现"占位） */
const shortcutVisible = ref(false)
const aboutVisible = ref(false)
/** `evt:ui-action` 的取消订阅（卸载时必须调用） */
let unsubscribeUiAction: (() => void) | null = null

// ═══════════════════════════════════════════════════════════════════ 消息区
/**
 * 贴底滚动：只有用户本来就在底部附近时才自动滚（否则会把用户正在读的地方顶走）。
 * 不做成响应式状态：滚动位置每帧都在变，写进 reactive 只会带来无谓的重渲染。
 */
function scrollToBottom(force = false): void {
  const el = listEl.value ?? null
  if (!el) return
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  if (force || near) el.scrollTop = el.scrollHeight
}

onMounted(async () => {
  await app.init()
  /**
   * ★ **界面动作订阅**（2026-10-09 完善轮）：托盘 / 桌宠右键菜单里的
   *   「快捷键一览」「关于」要落到**本窗口**的小面板上（那两个界面只在这里有）。
   *   ⚠ 订阅必须在卸载时取消，否则累积监听会让一次点击打开多次面板。
   */
  unsubscribeUiAction = bridge.onUiAction((r) => {
    if (r.action === 'shortcuts') { shortcutVisible.value = true; aboutVisible.value = false }
    else if (r.action === 'about') { aboutVisible.value = true; shortcutVisible.value = false }
  })
  await nextTick()
  /**
   * 打开即聚焦输入框（用户按快捷键 / 双击 / 点气泡的意图就是"我要打字"）。
   * 失败**不打断**：某些窗口状态下系统会拒绝 focus，那不该变成一个错误 ——
   * 但必须**可读**（`focusOk` 进探针），否则"聚焦没生效"会变成猜谜。
   */
  for (let i = 0; i < 5 && !focusOk.value; i++) {
    focusAttempts.value = i + 1
    input.value?.focus()
    focusOk.value = document.activeElement === input.value
    if (focusOk.value) break
    await new Promise(r => setTimeout(r, 120))
  }
  scrollToBottom(true)
  app.maybeAskAutoTts()
})

onBeforeUnmount(() => {
  /** 这里**没有**任何 stage / hitRegion 清理 —— 本窗口从不创建它们 */
  try { unsubscribeUiAction?.() } catch { /* ignore */ }
})

watch(() => app.chat.length, () => { void nextTick(() => scrollToBottom()) })
watch(() => app.streaming?.text, () => { void nextTick(() => scrollToBottom()) })
/**
 * ★ **系统标题栏的标题跟着人设名走**（2026-10-09 完善轮）。
 *
 * `frame:true` 之后标题栏是系统画的，读的是 `BrowserWindow` 的标题。
 * renderer 改 `document.title` 会触发 Electron 的 `page-title-updated`
 * ⇒ 主进程侧的 `w.setTitle()` 由 `applyChatWindowTitle()` 完成（见 `ipc.ts` 的
 * `PERSONA_SET` 处理器）。这里只负责把名字写进 `document.title`。
 */
watch(title, (t) => { document.title = t }, { immediate: true })

/**
 * 输入法（IME）处理 —— 硬判据，**三重保险继续保留**。
 *
 * 中文候选期间按 Enter 是"选定候选词"，**绝不能**触发发送。三重保险：
 *   ① `compositionstart/end` 维护 `app.composing`（显式状态，探针也能读到）；
 *   ② `KeyboardEvent.isComposing`（浏览器已经知道在合成中）；
 *   ③ `keyCode === 229`（部分 IME 只给这个信号）。
 * 只用其中一个都会漏（实测：微软拼音在某些候选阶段 `isComposing` 为 false）。
 */
function onCompositionStart(): void { app.composing = true }
function onCompositionEnd(): void { app.composing = false }

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    ev.preventDefault()
    // Esc = 隐藏窗口（不销毁、不退出应用）—— 与「×」同语义
    void closeWindow()
    return
  }
  if (ev.key !== 'Enter') return
  if (ev.shiftKey) return                 // Shift+Enter 换行
  if (app.composing || ev.isComposing || ev.keyCode === 229) return
  ev.preventDefault()
  void submit()
}

async function submit(): Promise<void> {
  const t = draft.value.trim()
  if (!t || busy.value) return
  sending.value = true
  draft.value = ''
  try {
    // ⚠ 唯一发送链路（与语音输入同一个 action）
    await app.ask(t)
    await nextTick()
    scrollToBottom(true)
  } finally {
    sending.value = false
  }
}

async function stopOrSend(): Promise<void> {
  if (app.streaming || sending.value) { await app.stopGenerating(); return }
  await submit()
}

async function closeWindow(): Promise<void> {
  // 关闭 = 隐藏（主进程 `conversation:close`），桌宠继续正常活动
  try { await app.closeConversation('api') } catch (e) { app.reportFailure('关闭对话窗口失败', e) }
}

/** 清空对话：**两步确认**（第一次点击只是"武装"，3 秒后自动解除） */
let clearTimer: ReturnType<typeof setTimeout> | null = null
function armClear(): void {
  if (clearArmed.value) {
    clearArmed.value = false
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null }
    void app.clearChat()
    return
  }
  clearArmed.value = true
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = setTimeout(() => { clearArmed.value = false; clearTimer = null }, 3000)
  clearTimer.unref?.()
}

/** 新建对话：**只重置上下文，不删历史**（与"清除对话"是两件事） */
async function newConversation(): Promise<void> {
  const r = await app.resetConversation()
  const run = { id: 'chat.new', action: 'newConversation', ok: r.ok, detail: `archived=${r.archivedCount ?? -1}` }
  menuRuns.push(run)
}

/** 加载更多历史（提高上限重新拉取；真实条数以主进程为准） */
async function loadMore(): Promise<void> {
  await app.loadChat()
  await nextTick()
  scrollToBottom(true)
}

/** 打开数据目录（底部操作行里的入口，与菜单项同一个动作） */
async function openDataDir(): Promise<void> {
  const e = menus.value.flatMap(g => g.items).find(i => i.action === 'openDataDir')
  if (!e) return
  const r = await runAction(e)
  menuRuns.push({ id: e.id, action: e.action, ok: r.ok, detail: r.detail })
}

/**
 * 界面探针（**只读**为主）。给主进程的验收用，不给用户看。
 *
 * ⚠ 只给**计数与布尔**，绝不返回对话正文（本项目对"探针不许泄露正文"有硬纪律）。
 * 唯一例外是菜单项的 `label`（那是界面文案，不是用户内容）。
 *
 * ★ 2026-10-09 新增两个操作（C4/C6 的读数口）：
 *   · `'menuState'`   —— 让 chat 窗口侧报告它对"桌宠常驻"的镜像值（C4 三处同步）；
 *   · `'menuCatalog'` —— 菜单栏目录（含 leavesSession 标记）；
 *   · `'clickAll'`    —— **逐个执行**菜单项并返回每项的可观测结果（C6 无死项）。
 */
onMounted(() => {
  ;(window as unknown as { __AIRIMATE_CHAT_PROBE__?: (op: string, arg?: unknown) => unknown }).__AIRIMATE_CHAT_PROBE__ = (op: string, arg?: unknown) => {
    const base = {
      surface: 'chat',
      title: document.title,
      /** 判据：chat 窗口内 canvas 数 = 0 */
      canvasCount: document.querySelectorAll('canvas').length,
      stageHandlePresent: typeof (window as unknown as { __AIRIMATE_STAGE__?: unknown }).__AIRIMATE_STAGE__ !== 'undefined',
      stageCanvasInDom: document.querySelectorAll('.stage-canvas, .stage-root').length,
      textInputCount: document.querySelectorAll('input, textarea').length,
      textInputTags: Array.from(document.querySelectorAll('input, textarea')).map(e => e.tagName.toLowerCase()),
      messageCount: app.chat.length,
      userMessageCount: app.chat.filter(m => m.role === 'user').length,
      assistantMessageCount: app.chat.filter(m => m.role === 'assistant').length,
      streaming: app.streaming !== null,
      streamingChars: app.streaming?.text.length ?? 0,
      sendCount: app.sendCount,
      composing: app.composing,
      listening: app.listening,
      ttsActive: app.ttsActive,
      focusOk: focusOk.value,
      focusAttempts: focusAttempts.value,
      focusedEl: (document.activeElement?.tagName ?? '').toLowerCase(),
      titleRendered: title.value,
      personaName: app.persona?.name ?? null,
      clearArmed: clearArmed.value,
      hotkeyError: app.conversationHotkey.error,
      conversationOpen: app.conversationOpen,
      /** ★ 本轮新增：菜单栏 + 桌宠镜像（C4/C6 的读数口） */
      menuBar: {
        groups: menus.value.map(g => ({ id: g.id, label: g.label, itemCount: g.items.length })),
        itemCount: menus.value.reduce((n, g) => n + g.items.length, 0),
        openMenu: openMenu.value,
      },
      pet: { resident: app.petResident, visible: app.petVisible, statusText: app.petStatusText },
      shortcutVisible: shortcutVisible.value,
      aboutVisible: aboutVisible.value,
    }
    if (op === 'read') {
      try { return JSON.parse(JSON.stringify(base)) } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
    }
    if (op === 'menuState') {
      /** C4：对话窗口菜单栏读到的「桌宠常驻」勾选值（与主进程唯一真源比对） */
      return JSON.parse(JSON.stringify({
        resident: app.petResident,
        visible: app.petVisible,
        statusText: app.petStatusText,
        checkedInMenu: menus.value.flatMap(g => g.items).find(i => i.id === 'pet.resident')?.checked ?? null,
      }))
    }
    /**
     * ★★ **展开 / 收起某个下拉**（2026-10-09 完善轮新增，`--probe menuopen` 用）。
     *
     * 为什么需要它：C9 的截图④要求"菜单栏展开"，而**下拉是页面内的瞬时渲染态** ——
     * 外面用 `CopyFromScreen` 的脚本按不到它。让外部脚本注入系统级鼠标点击是另一条路，
     * 但注入坐标会落在**当时的前台窗口**上（可能不是我们），一次"点到别处"
     * 就会伪装成"菜单打不开"，归因方向完全错了。
     * ⇒ 探针直接调页面内那条**与用户点击完全相同**的实现（`onMenuClick` 之外的
     *   `toggleMenu`，即点击菜单标题所做的事），并返回展开后的 DOM 读数供核对。
     */
    if (op === 'menuOpen') {
      const id = String(arg ?? '')
      if (!menus.value.some(g => g.id === id)) return { error: `unknown-menu:${id}`, known: menus.value.map(g => g.id) }
      openMenu.value = id
      return JSON.parse(JSON.stringify({
        opened: openMenu.value === id,
        group: id,
        itemCount: menus.value.find(g => g.id === id)?.items.length ?? 0,
      }))
    }
    if (op === 'menuClose') {
      openMenu.value = null
      return { closed: openMenu.value === null }
    }
    if (op === 'menuCatalog') {
      try {
        /**
         * ⚠ 顶层**必须**同时给 `groups` 与摊平后的 `items`：
         *   界面的渲染读 `groups`（要分组），而探针的逐项检查读 `items`（要逐项）。
         *   第一版只给了 `groups` ⇒ 探针侧读到 `items=undefined` ⇒ 判据假失败
         *   （"菜单栏不存在"），而菜单其实好端端地在屏幕上。
         *   两种形状都给，读的人不可能取错。
         */
        const flat = menus.value.flatMap(g => g.items.map(i => ({
          id: i.id, menu: g.id, label: i.label, action: i.action,
          checked: i.checked ?? null, leavesSession: i.leavesSession === true,
        })))
        return JSON.parse(JSON.stringify({
          groups: menus.value.map(g => ({
            id: g.id, label: g.label,
            items: g.items.map(i => ({ id: i.id, label: i.label, action: i.action, checked: i.checked ?? null, leavesSession: i.leavesSession === true })),
          })),
          items: flat,
          itemCount: flat.length,
          menuRuns: menuRuns.slice(-32),
        }))
      } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
    }
    if (op === 'clickAll') {
      /**
       * ★ **逐个执行菜单项**（C6）。
       *
       * ⚠ 把整段做成 async 的、并且**每个动作之间留一拍**：
       *   菜单动作里有会改窗口状态的（呼出/收回桌宠），连着做会让读数互相干扰 ——
       *   而"动作真的生效了"正是本项要证明的东西。
       * ⚠ `leavesSession` 的项**不执行**（执行了就再也读不到后面的读数），
       *   但仍返回它的 action 名 ⇒ 探针可以断言"它有实现"。
       */
      return (async () => {
        const results: Array<Record<string, unknown>> = []
        for (const g of menus.value) {
          for (const it of g.items) {
            if (it.leavesSession) {
              results.push({ id: it.id, action: it.action, leavesSession: true, ok: true, detail: 'not-executed:leaves-session' })
              continue
            }
            const r = await runAction(it)
            menuRuns.push({ id: it.id, action: it.action, ok: r.ok, detail: r.detail })
            results.push({ id: it.id, action: it.action, leavesSession: false, ok: r.ok, detail: r.detail })
            await new Promise(res => setTimeout(res, 180))
          }
        }
        /** 执行完把收尾状态复位（探针不该给用户留下打开着的下拉菜单/面板） */
        shortcutVisible.value = false
        aboutVisible.value = false
        clearArmed.value = false
        return JSON.parse(JSON.stringify({ results }))
      })()
    }
    return { error: 'unknown-op' }
  }
})
</script>

<template>
  <div class="chatw" ref="root">
    <!--
      ① **菜单栏**（2026-10-09 完善轮）。
      ⚠ 这不是标题栏：窗口是 `frame:true`，标题栏由**系统**画（可拖动/缩放/最小化/最大化）。
      这里是**客户区顶部的一条深色下拉菜单**，对齐参考实现的菜单栏结构。
      每一条下拉都在下面用 `v-for` 渲染 ⇒ **不可能出现"模板里有、实现里没有"的死项**。
    -->
    <nav class="chatw__menubar" role="menubar" aria-label="菜单栏">
      <div
        v-for="g in menus" :key="g.id"
        class="chatw__menugroup"
        :class="{ 'is-open': openMenu === g.id }"
      >
        <button
          class="chatw__menutitle"
          role="menuitem"
          :aria-expanded="openMenu === g.id"
          @click.stop="toggleMenu(g.id)"
          @mouseenter="hoverSwitch(g.id)"
        >{{ g.label }}</button>
        <div v-if="openMenu === g.id" class="chatw__dropdown" role="menu">
          <button
            v-for="it in g.items" :key="it.id"
            class="chatw__menuitem"
            :class="{ 'is-checked': it.checked === true }"
            role="menuitemcheckbox"
            :aria-checked="it.checked === true"
            :data-menu-id="it.id"
            @click.stop="onMenuClick(it)"
          >
            <span class="chatw__check">{{ it.checked === true ? '☑' : (it.checked === false ? '☐' : '') }}</span>
            <span>{{ it.label }}</span>
          </button>
        </div>
      </div>
      <span class="chatw__menuspace" />
      <span class="chatw__menustatus">{{ personaName }} · {{ statusText }}</span>
    </nav>

    <!--
      ② **顶部信息行**（参考实现的头部）：小头像 + 标题「和 {名字} 聊天」+ 状态。
    -->
    <header class="chatw__head">
      <span class="chatw__avatar" aria-hidden="true">{{ initial }}</span>
      <b class="chatw__h1">{{ title }}</b>
      <span class="chatw__status" :class="`chatw__status--${statusKind}`">
        <i class="chatw__dot" />{{ statusText }}
      </span>
    </header>

    <!-- 朗读确认（ttsEnabled=false 时**只问一次**；绝不静默开启 TTS） -->
    <div v-if="app.ttsAskVisible" class="chatw__ask" role="alertdialog">
      <span>对话以语音为主，是否开启朗读？</span>
      <span class="chatw__ask-actions">
        <button class="tbtn tbtn--mini tbtn--primary" @click="app.answerAutoTts(true)">开启朗读</button>
        <button class="tbtn tbtn--mini" @click="app.answerAutoTts(false)">先不用</button>
      </span>
    </div>

    <!-- 全局快捷键注册失败：**常驻**显示（只弹一次 toast 不够，用户可能正看着别处） -->
    <div v-if="app.conversationHotkey.error" class="chatw__warn" role="alert">
      全局快捷键未生效：{{ app.conversationHotkey.error }}
    </div>

    <!-- 正在听（复用 voice:listen-once；麦克风状态必须看得见） -->
    <div v-if="app.listening" class="chatw__listening" role="status">
      <span class="chatw__pulse" />正在听你说…（说完会自动发送）
    </div>

    <!-- ③ 对话滚动区 -->
    <div class="chat__list" ref="listEl" role="log" aria-label="对话内容">
      <div class="chatw__toolbar">
        <button class="tbtn tbtn--mini" title="重新从主进程拉取历史" @click="loadMore">加载历史</button>
        <button class="tbtn tbtn--mini" title="只重置上下文，历史一条不删" @click="newConversation">新建对话</button>
        <button
          class="tbtn tbtn--mini"
          :class="clearArmed ? 'tbtn--danger' : ''"
          :title="clearArmed ? '再点一次确认清空（不可恢复）' : '清空对话（需二次确认）'"
          @click="armClear()"
        >{{ clearArmed ? '确认清空？' : '清空对话' }}</button>
      </div>

      <p v-if="!app.chat.length" class="muted chat__empty">
        还没有对话。直接在下面输入，或者点左边的麦克风说一句。
      </p>

      <div v-for="m in app.chat" :key="m.id" class="msg" :class="`msg--${m.role}`">
        <span class="msg__role">{{ m.role === 'user' ? '我' : personaName.slice(0, 1) }}</span>
        <div class="msg__text">
          <span v-if="originLabel(m.origin)" class="chatw__origin">{{ originLabel(m.origin) }}</span>{{ m.text }}
          <span class="chatw__time">{{ hhmm(m.createdAt) }}</span>
        </div>
      </div>

      <!-- 流式输出：正在生成的那一段 -->
      <div v-if="app.streaming" class="msg msg--assistant">
        <span class="msg__role">{{ personaName.slice(0, 1) }}</span>
        <div class="msg__text">{{ app.streaming.text }}<span class="caret" /></div>
      </div>
    </div>

    <!--
      ④ **底部操作行**（对齐参考实现）：输入框 + 麦克风 + 清除对话 + 打开数据目录 + 发送/停止。
    -->
    <div class="chatw__input">
      <button
        class="tbtn tbtn--mini chatw__mic"
        :class="{ 'is-on': app.listening }"
        :title="app.settings?.hearingEnabled ? '听一句（说完自动发送）' : '语音识别未开启（设置 → 语音）'"
        :disabled="app.listening"
        @click="app.listenOnce()"
      >
        <svg
          class="chatw__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
          stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
          v-html="hearingIcon"
        />
      </button>

      <textarea
        ref="input"
        v-model="draft"
        class="chatw__field"
        rows="1"
        placeholder="说点什么…（Enter 发送，Shift+Enter 换行，Esc 收起窗口）"
        @keydown="onKeydown"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
      />

      <button
        class="tbtn tbtn--mini"
        :class="clearArmed ? 'tbtn--danger' : ''"
        :title="clearArmed ? '再点一次确认清空（不可恢复）' : '清空对话（两步确认）'"
        @click="armClear()"
      >{{ clearArmed ? '确认？' : '清除' }}</button>

      <button class="tbtn tbtn--mini" title="打开数据目录（%APPDATA%\\AiriMateOne）" @click="openDataDir">目录</button>

      <button
        class="tbtn"
        :class="busy ? 'tbtn--danger' : 'tbtn--primary'"
        :disabled="!busy && !canSend"
        :title="busy ? '停止生成' : '发送'"
        @click="stopOrSend()"
      >{{ busy ? '停止' : '发送' }}</button>
    </div>

    <footer class="chatw__foot">
      <span class="muted">
        {{ app.settings?.ttsEnabled ? '朗读已开' : '朗读未开' }} ·
        气泡{{ app.settings?.bubbleEnabled === false ? '已关' : '已开' }} ·
        桌宠{{ app.petResident ? '常驻' : (app.petVisible ? '已呼出' : '已收回') }} ·
        {{ app.conversationHotkey.enabled
          ? (app.conversationHotkey.registered ? `快捷键 ${app.conversationHotkey.accelerator}` : '快捷键未注册')
          : '快捷键已关闭' }}
      </span>
      <span class="muted">关掉本窗口只是把它收起来，不会退出应用</span>
    </footer>

    <!-- 帮助 → 快捷键一览（**真实内容**：全部来自当前状态） -->
    <div v-if="shortcutVisible" class="chatw__sheet" role="dialog" aria-label="快捷键一览">
      <div class="chatw__sheet-head">
        <b>快捷键一览</b>
        <button class="tbtn tbtn--mini" @click="shortcutVisible = false">关闭</button>
      </div>
      <table class="chatw__keys">
        <tbody>
          <tr v-for="r in shortcutRows" :key="r.keys">
            <td><code>{{ r.keys }}</code></td>
            <td>{{ r.what }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted chatw__sheet-note">
        全局快捷键可在「设置 → 对话」里改；注册失败时本窗口顶部会常驻显示原因，绝不静默失效。
      </p>
    </div>

    <!-- 帮助 → 关于（**真实读数**：版本 / 契约版本 / 角色 / 数据目录由主进程提供） -->
    <div v-if="aboutVisible" class="chatw__sheet" role="dialog" aria-label="关于">
      <div class="chatw__sheet-head">
        <b>关于 AiriMate One</b>
        <button class="tbtn tbtn--mini" @click="aboutVisible = false">关闭</button>
      </div>
      <p class="chatw__sheet-body">
        版本 {{ app.appVersion || '—' }} · 契约 {{ app.contractVersion || '—' }}<br>
        当前角色：{{ personaName }}<br>
        对话与记忆都只存在本机（<code>%APPDATA%\AiriMateOne</code>），密钥不进界面、不进日志。
      </p>
      <p class="muted chatw__sheet-note">桌宠与对话是两个独立窗口：关掉这个窗口不会退出应用。</p>
    </div>
  </div>
</template>
