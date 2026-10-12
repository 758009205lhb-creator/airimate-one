/**
 * @airimate/shared/ipc —— 主进程 ↔ 渲染进程的**白名单通道契约**
 *
 * 纪律（Tech-Spec §7.1）：
 *   1. preload 只暴露这里列出的通道；通道名是常量，禁止字符串拼接。
 *   2. 每个通道都有请求/响应的 zod schema；**两侧都校验**，失败即丢弃并记脱敏日志。
 *   3. 任何通道都不得传递密钥明文、不得传递任意文件路径（路径必须走 assetId/白名单根）。
 */
import { z } from 'zod'
import { StageCommandSchema, Vec3Schema } from './commands.js'
import { WindowModeSchema, RectSchema } from './settings.js'
import type { Rect } from './settings.js'

// ───────────────────────────────────────────────────────── 通道名（冻结）

export const IPC = {
  // renderer → main（invoke，有返回值）
  APP_DIAGNOSTICS: 'app:diagnostics',
  APP_QUIT: 'app:quit',
  APP_SHOW: 'app:show',
  APP_HIDE: 'app:hide',
  APP_STARTUP_GET: 'app:startup:get',
  APP_STARTUP_SET: 'app:startup:set',
  APP_STARTUP_AUDIT: 'app:startup:audit',
  LEGACY_SCAN: 'legacy:scan',

  // ── M1 首次运行向导（主进程判定每一步是否真的满足）
  ONBOARDING_GET: 'onboarding:get',
  ONBOARDING_SET_STEP: 'onboarding:set-step',
  ONBOARDING_COMPLETE: 'onboarding:complete',
  ONBOARDING_RESET: 'onboarding:reset',

  // ── M2 主动陪伴引擎
  SCHEDULE_LIST: 'schedule:list',
  SCHEDULE_UPSERT: 'schedule:upsert',
  SCHEDULE_DELETE: 'schedule:delete',
  REMINDER_LIST: 'reminder:list',
  REMINDER_UPSERT: 'reminder:upsert',
  REMINDER_DELETE: 'reminder:delete',
  /** 提醒中心里把某条提醒标记为已读/已处理 */
  REMINDER_ACK: 'reminder:ack',
  QUIET_GET: 'quiet:get',
  QUIET_SET: 'quiet:set',
  /** 提醒阈值（连续 50 分钟 / 久坐 60 分钟 / 23:30 夜间 + 各冷却） */
  QUIET_POLICY_SET: 'quiet:policy:set',
  PERMISSION_LIST: 'permission:list',
  PERMISSION_SET: 'permission:set',
  ACTIVITY_STATS: 'activity:stats',
  /** 手动推进一次引擎 tick（探针 / "改完设置立刻验证"） */
  PROACTIVE_TICK: 'proactive:tick',
  /** 手动触发一次早安电台（探针与"我现在就想听"都用它） */
  PROACTIVE_RADIO: 'proactive:radio',
  /** 引擎内部状态（只读诊断：冷却、队列、下次检查时间） */
  PROACTIVE_STATUS: 'proactive:status',
  /** 主动消息队列的快照（UI 的提醒中心） */
  PROACTIVE_INBOX: 'proactive:inbox',

  // ── M1 隐私 / 数据主体权利（导出与彻底删除）
  PRIVACY_EXPORT: 'privacy:export',
  PRIVACY_WIPE: 'privacy:wipe',
  /** 本机存了什么（只读摘要，用于隐私页） */
  PRIVACY_SUMMARY: 'privacy:summary',

  // ── 适配层框架（M5 §1）：能力枚举、许可判定、工具审计、存储清单
  /** 全部适配器 + 工具 + 选型事件（**不含密钥与用户内容**） */
  KIT_CAPABILITIES: 'kit:capabilities',
  /** 角色解析结论（含被拒条目与原因；**不返回绝对路径**） */
  KIT_ASSETS: 'kit:assets',
  /** 最近的工具调用审计（只有摘要，无正文） */
  KIT_TOOL_AUDIT: 'kit:tool-audit',
  /** 存储清单与迁移状态（隐私页 + 升级检查） */
  KIT_STORES: 'kit:stores',

  // ── M3 语音（默认关闭；启用后必须显示麦克风状态与一键停用）
  /** 当前语音状态（是否可用 / 麦克风是否占用 / 唤醒词 / 计数） */
  VOICE_STATUS: 'voice:status',
  /** 设置唤醒开关与唤醒词 */
  VOICE_CONFIG: 'voice:config',
  /** 一键停用（杀掉识别子进程并释放麦克风） */
  VOICE_STOP: 'voice:stop',
  /** 重新检测本机语音识别能力（只读枚举，**不打开麦克风**） */
  VOICE_PROBE: 'voice:probe',
  /** 识别一句（语音通话循环调它 ⇒ 连续对话） */
  VOICE_LISTEN_ONCE: 'voice:listen-once',
  /** 开始语音通话（STT → LLM → TTS 全链路，可打断、连续对话） */
  VOICE_CALL_START: 'voice:call-start',
  /** 结束通话（释放麦克风与朗读） */
  VOICE_CALL_STOP: 'voice:call-stop',
  /** 打断（停止朗读、继续听；不结束通话） */
  VOICE_CALL_INTERRUPT: 'voice:call-interrupt',
  /** 通话状态（第几轮 / 阶段 / 打断次数 / 静音轮数 / 为什么不能通话） */
  VOICE_CALL_STATE: 'voice:call-state',
  /**
   * ★ 闭环读数（2026-10-06，A4）：桥是否接上 / 待机监听是否在跑 / barge-in 是否开 /
   * 识别计数 / 四段（听·想·说·起）各自是否具备条件。
   * **只为"闭环接上了没有"提供一个明确的机械读数**，不含任何正文。
   */
  VOICE_LOOP_STATUS: 'voice:loop-status',
  /**
   * ★ 待机听唤醒的开关（2026-10-06，A4）。
   * 打开需要 `hearingEnabled` **且** `wakeWordEnabled` —— 两条硬前置在
   * `startWakeWatch()` 里强制，通道层不放宽。
   */
  VOICE_WAKE_WATCH: 'voice:wake-watch',

  // ── M3 屏幕理解（按需触发，非持续录屏）
  /** 屏幕理解状态（是否有权限 / 是否暂停 / 排除区数量 / 累计次数） */
  SCREEN_STATUS: 'screen:status',
  /** 暂停 / 恢复屏幕理解（内存态，重启恢复） */
  SCREEN_PAUSE: 'screen:pause',
  /** 最近一次截图提示（"截图前显示提示"的读数） */
  SCREEN_NOTICE: 'screen:notice',
  /** 列出授权目录（**只给数量与 id，不给路径**） */
  FS_ALLOWLIST: 'fs:allowlist',
  /** 授权一个目录（会做敏感目录判定，危险目录被拒） */
  FS_ALLOW_DIR: 'fs:allow-dir',
  /** 撤销一个授权目录 */
  FS_REVOKE_DIR: 'fs:revoke-dir',
  /** 确认一次 `needs-confirm` 档的工具调用（由确认弹窗回传） */
  TOOL_CONFIRM_RESULT: 'tool:confirm-result',

  // ── M4 每日自学习（默认关闭；高置信度自动写记忆，低置信度必须确认）
  /** 反思状态（开关 / 执行时间 / 待确认数 / 阈值） */
  REFLECTION_STATUS: 'reflection:status',
  /** 手动跑一次反思（`force` 忽略按天去重；`dryRun` 不写记忆） */
  REFLECTION_RUN: 'reflection:run',
  /** 历史列表（按天；新在前） */
  REFLECTION_HISTORY: 'reflection:history',
  /** 某一天的完整反思（含提取项） */
  REFLECTION_DAY: 'reflection:day',
  /** 待确认项（跨天） */
  REFLECTION_PENDING: 'reflection:pending',
  /** 确认 / 拒绝一条待确认项（拒绝后不再重复提问） */
  REFLECTION_DECIDE: 'reflection:decide',
  /** 清空全部反思记录（数据主体权利） */
  REFLECTION_CLEAR: 'reflection:clear',

  WINDOW_GET_MODE: 'window:get-mode',
  WINDOW_SET_MODE: 'window:set-mode',
  WINDOW_SET_ALWAYS_ON_TOP: 'window:set-always-on-top',
  WINDOW_CENTER: 'window:center',
  WINDOW_DRAG_BEGIN: 'window:drag-begin',
  WINDOW_DRAG_MOVE: 'window:drag-move',
  WINDOW_DRAG_END: 'window:drag-end',
  WINDOW_AUTO_RESIZE: 'window:auto-resize',
  /**
   * ★ 最小化**发起调用的那个窗口**（2026-10-08 返工轮新增）。
   *
   * ⚠ 2026-10-09 完善轮：对话窗口改成 `frame:true`（系统原生边框）之后，
   *   最小化/最大化由**系统按钮**提供，这条通道对 chat 窗口不再是必需路径。
   *   它**保留**下来（不删）：pet/panel 窗口是 `frame:false` 自绘标题栏，
   *   仍然需要一条"最小化我自己"的通道；删掉会留下一个没有替代品的缺口。
   */
  WINDOW_MINIMIZE: 'window:minimize',

  // ── ★★ 桌宠窗口的显示 / 收回 / 常驻（2026-10-09 完善轮）
  /**
   * **显示并聚焦桌宠窗口**（"呼出桌宠"）。
   * 与"把窗口从最小化恢复"是同一件事的不同说法 ⇒ 走同一个实现（`showWindow()`）。
   * 窗口**不存在**时按 `petResident` 的当前值创建它（不改变常驻设置）。
   */
  PET_SHOW: 'pet:show',
  /** **隐藏桌宠窗口**（"收回桌宠"）。**不写 `petResident`** —— 收回 ≠ 取消常驻。 */
  PET_HIDE: 'pet:hide',
  /** 呼出 ⇄ 收回（托盘的"显示桌宠 / 收回桌宠"两项其实就是这两个的显式版本） */
  PET_TOGGLE: 'pet:toggle',
  /**
   * **打开管理面板**（= 呼出 + 切 panel 模式 + 聚焦）。
   *
   * 为什么合成一条通道而不是让 renderer 串三次调用：三步之间任何一步失败
   * 都会留下"窗口出来了但形态不对"的中间态，而那条中间态没有任何界面表现。
   */
  PET_OPEN_PANEL: 'pet:open-panel',
  /**
   * 读写「桌宠常驻」。写的时候**立即生效并落盘**：
   *   勾上 ⇒ 显示桌宠 + `settings.petResident=true`；取消 ⇒ 隐藏桌宠 + `false`。
   */
  PET_SET_RESIDENT: 'pet:set-resident',
  /** 常驻设置**即时落盘**（勾选后不等 800ms 防抖；"重启后仍生效"这条判据要靠它） */
  PET_FLUSH_SETTINGS: 'pet:flush-settings',

  // ── ★ 对话（2026-10-08 返工轮：对话框与桌宠是**两个独立窗口**）
  /**
   * 打开 / 关闭**独立对话窗口**（不是"同一个窗口内的布局切换"）。
   *
   * 语义（五条入口全部走这里，不各写一套）：
   *   · `conversation:open`  ⇒ 显示并聚焦 chat 窗口（**再次触发只聚焦，绝不隐藏**）；
   *   · `conversation:close` ⇒ 隐藏 chat 窗口（不销毁、不退出应用；pet 窗口不受影响）。
   * ⚠ 上一轮的语义（pet 模式切到 `WINDOW_GEOMETRY.conversation`、panel 模式浮层）
   *   已随 `WINDOW_GEOMETRY.conversation` 一起**删除** —— 用户明确否决"聊天塞进桌宠窗口"。
   */
  CONVERSATION_OPEN: 'conversation:open',
  CONVERSATION_CLOSE: 'conversation:close',
  /** 只读状态（探针与界面共用同一份读数；含快捷键注册结果的**如实**报告） */
  CONVERSATION_STATE: 'conversation:state',
  /**
   * ★★ **桌宠自身的右键菜单**（2026-10-09 完善轮）。
   *
   * 为什么需要一条通道：桌宠窗口的右键菜单项里有「摸摸她 / 让她散步 / 打开管理面板 /
   * 暂时隐藏 / 重启 / 退出」这些**主进程才知道怎么做**的动作。
   * 若在 renderer 里自绘菜单，就得把"退出应用""重启"这类能力暴露给渲染进程的界面层 ——
   * 那是没必要扩大的攻击面。⇒ 用**原生菜单**（`Menu.popup`）+ 一条无入参通道：
   * renderer 只能说"用户右键了"，菜单项与动作**全部由主进程持有**。
   */
  PET_MENU: 'pet:menu',
  /**
   * ★ **界面动作**（renderer → main）：把"打开某个管理页"的意图交给主进程。
   *
   * 为什么不让 chat 窗口直接改 pet 窗口的状态：`tab` 是 **pet 窗口 renderer 的局部状态**，
   * 而发起方可能是 chat 窗口的菜单栏或托盘 —— 那些上下文里根本没有那个组件。
   * 主进程是唯一能把这条意图路由过去的地方。
   */
  UI_ACTION: 'ui:action',

  SETTINGS_GET: 'settings:get',
  SETTINGS_PATCH: 'settings:patch',

  PROVIDER_LIST: 'provider:list',
  PROVIDER_UPSERT: 'provider:upsert',
  PROVIDER_DELETE: 'provider:delete',
  PROVIDER_TEST: 'provider:test',
  /** 多供应商时显式选择生效项 */
  PROVIDER_SELECT: 'provider:select',
  /** 从端点拉模型清单（向导"选择模型"） */
  PROVIDER_MODELS: 'provider:models',

  PERSONA_GET: 'persona:get',
  PERSONA_SET: 'persona:set',

  CHAT_SEND: 'chat:send',
  CHAT_ABORT: 'chat:abort',
  CHAT_HISTORY: 'chat:history',
  CHAT_CLEAR: 'chat:clear',
  /**
   * ★★ **只重置上下文，不删历史**（2026-10-09 完善轮）。
   *
   * 与 `CHAT_CLEAR` 的区别（两者都要存在，因为它们是两件不同的事）：
   *   · `chat:clear`  —— **删掉**历史（不可逆；历史文件里那几条真的没了）；
   *   · `content:reset` —— 从**此刻**起她不再记得之前聊过什么，
   *     但历史**一条不删**（隐私导出、记忆页、导出的 JSON 里都还在）。
   *
   * 为什么必须有它（而不是把「新建对话」做成一键清空）：菜单栏里同时出现
   * 「新建对话」与「清除对话」两项时，如果它们**做同一件事**，那就是
   * 一个骗人的菜单 —— 用户点"新建"的意图是"换个话题重新开始"，
   * 不是"把我刚才的记录删了"。删除有它自己的入口（清空对话，两步确认）。
   */
  CHAT_CONTEXT_RESET: 'chat:context-reset',
  /**
   * ★ **打开对话数据目录**（菜单「对话 → 打开数据目录」）。
   * 出参含目录路径（与 `privacy:summary` 的 `userDataDir` 同源同权限），
   * 目的之一是让"这个菜单项真的有动作"可以被机械验证。
   */
  CHAT_OPEN_DATA_DIR: 'chat:open-data-dir',
  /**
   * ★ **重启应用**（桌宠右键菜单「重启应用」，2026-10-09 完善轮）。
   *
   * 为什么单独一条通道而不是复用 `app:quit`：两者对用户是不同的事
   * （"我要退出" vs "我要重开一下"），而对代码是不同的事 ——
   * 重启多了"把新进程拉起来"这一步，且必须**先**排程再退出
   * （顺序反了就是"点重启 = 关掉不回来"）。
   */
  APP_RESTART: 'app:restart',

  MEMORY_LIST: 'memory:list',
  MEMORY_ADD: 'memory:add',
  MEMORY_UPDATE: 'memory:update',
  MEMORY_DELETE: 'memory:delete',
  MEMORY_RECALL: 'memory:recall',
  /** 召回预览：命中的记忆 **+ 真正会被注入系统提示的文本** */
  MEMORY_RECALL_PREVIEW: 'memory:recall-preview',
  /** 检索（带重要度/标签过滤；空查询 = 浏览模式） */
  MEMORY_SEARCH: 'memory:search',

  TTS_SPEAK: 'tts:speak',
  TTS_STOP: 'tts:stop',
  TTS_VOICES: 'tts:voices',

  MOTION_LIST: 'motion:list',
  MOTION_RELOAD: 'motion:reload',
  AVATAR_CATALOG: 'avatar:catalog',

  // renderer → main（send，无返回值）
  HIT_REGIONS: 'hitregions:update',
  TELEMETRY: 'telemetry:report',
  /** renderer 主动推送舞台只读快照（避免主进程用 executeJavaScript 取数） */
  STAGE_SNAPSHOT: 'stage:snapshot',

  // main → renderer（send，广播）
  EVT_STAGE_COMMAND: 'evt:stage-command',
  EVT_CHAT_DELTA: 'evt:chat-delta',
  EVT_CHAT_DONE: 'evt:chat-done',
  EVT_CHAT_ERROR: 'evt:chat-error',
  EVT_WINDOW_STATE: 'evt:window-state',
  EVT_MODE_CHANGED: 'evt:mode-changed',
  EVT_TTS_AUDIO: 'evt:tts-audio',
  EVT_TTS_STATE: 'evt:tts-state',
  EVT_ALERT: 'evt:alert',
  EVT_SETTINGS_CHANGED: 'evt:settings-changed',
  /** 主进程在拖拽期间回报真实窗口位置（摇晃叠加层的驱动源，与 Mate 一致用真实位移） */
  EVT_DRAG_POS: 'evt:drag-pos',
  /** ★ M2：引擎把"可以送达用户"的主动行为推给 renderer（重要级会同时弹窗） */
  EVT_PROACTIVE: 'evt:proactive',
  /** ★ M2：活动/阻断状态变化（UI 显示"正在会议中，提醒已排队"这类真实状态） */
  EVT_ACTIVITY: 'evt:activity',
  /** ★ M2：提醒队列变化（提醒中心角标） */
  EVT_REMINDER_QUEUE: 'evt:reminder-queue',
  /** ★ M3：截图前的提示（用户要求"截图前显示提示"） */
  EVT_SCREEN_NOTICE: 'evt:screen-notice',
  /** ★ M3：语音事件（监听开始/停止、唤醒、听到一句、错误） */
  EVT_VOICE_NOTICE: 'evt:voice-notice',
  /** ★ M3：某个工具需要用户确认（confirm 档）；renderer 弹窗后用 `tool:confirm-result` 回传 */
  EVT_TOOL_CONFIRM: 'evt:tool-confirm',
  /** ★ M3：语音通话进度（听到/静音/思考/说话/被打断）；**回复文本只在这条上出现一次** */
  EVT_VOICE_CALL: 'evt:voice-call',
  /**
   * ★ 对话状态广播（main → renderer）。
   *
   * 为什么必须有：托盘菜单、全局快捷键、语音唤醒这三个入口**由主进程发起**，
   * renderer 不点任何东西。没有这条广播，界面就不会知道"对话框已经被别人打开了" ——
   * 表现是窗口换了尺寸、对话框却始终不出现（静默失效的典型形态）。
   */
  EVT_CONVERSATION_STATE: 'evt:conversation-state',
  /**
   * ★ 「现在开始听」请求（main → renderer，唤醒词触发时发一条）。
   *
   * 纪律：这条事件**不打开麦克风**，它只是让对话坞进入"听"状态并去调
   * **已有的** `voice:listen-once`。麦克风的唯一开关仍然只有
   * `hearingEnabled`（识别总开关）—— 不存在第二条语音链路、第二个麦克风监听。
   */
  EVT_CONVERSATION_LISTEN: 'evt:conversation-listen',
  /**
   * ★★ **界面动作请求**（main → pet 窗口，2026-10-09 完善轮）。
   *
   * 用途：对话窗口菜单栏 / 托盘 / 桌宠右键菜单里那些"要切到某个管理页面"的项
   * （记忆页 / 日程与提醒 / 偏好设置 / 语音与麦克风 / 快捷键一览 / 关于）。
   * 真正的"切页"只有 pet 窗口的界面做得出来（`tab` 是它的局部状态），
   * 所以主进程只发**一个目标视图标识**，由那边决定怎么呈现。
   *
   * 纪律：这条事件**只带一个枚举值**，不带任何用户内容、不带路径、不带密钥。
   */
  EVT_UI_ACTION: 'evt:ui-action',
  /**
   * ★ **桌宠右键菜单的状态快照**（main → 两个窗口，2026-10-09 完善轮）。
   *
   * 为什么必须广播：C4 要求"三处菜单入口的「桌宠常驻」勾选状态完全同步"。
   * 让三处各自去 `getSettings()` 会得到三份可能过期的副本（而它们的刷新时机不同），
   * 所以唯一真源（主进程）在**每一次常驻/可见性变化**时把同一份快照广播出去。
   */
  EVT_PET_MENU_STATE: 'evt:pet-menu-state',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

// ───────────────────────────────────────────────────────── 通用

export const OkSchema = z.object({ ok: z.literal(true) })
export const ErrSchema = z.object({ ok: z.literal(false), code: z.string().max(64), message: z.string().max(500) })
export const ResultSchema = z.discriminatedUnion('ok', [OkSchema, ErrSchema])
export type Result = z.infer<typeof ResultSchema>

export const AlertSchema = z.object({
  level: z.enum(['info', 'warn', 'error']),
  /** 面 向用户的短标题与说明（已脱敏，禁止出现路径以外的敏感信息） */
  title: z.string().max(120),
  detail: z.string().max(2000).optional(),
  code: z.string().max(64),
  /** 关联的验收判据（可选） */
  criterion: z.string().max(16).optional(),
  /** 是否为阻断级（需要在 UI 上占显著位置，不可被忽略） */
  blocking: z.boolean().default(false),
})
export type Alert = z.infer<typeof AlertSchema>

// ───────────────────────────────────────────────────────── 窗口

export const WindowStateSchema = z.object({
  mode: WindowModeSchema,
  bounds: RectSchema,
  visible: z.boolean(),
  alwaysOnTop: z.boolean(),
  focused: z.boolean(),
  scaleFactor: z.number().positive(),
})
export type WindowState = z.infer<typeof WindowStateSchema>

export const SetModeRequestSchema = z.object({ mode: WindowModeSchema, center: z.boolean().default(false) })
export type SetModeRequest = z.infer<typeof SetModeRequestSchema>

export const AlwaysOnTopRequestSchema = z.object({ on: z.boolean() })

/** 拖拽：开始/结束用屏幕坐标，主进程负责 setPosition（两参重载，尺寸不变） */
export const DragBeginRequestSchema = z.object({
  /** 按下时光标屏幕坐标 */
  cursor: Vec3Schema.pick({ x: true, y: true }),
  /** 按下时窗口左上角屏幕坐标 */
  windowOrigin: Vec3Schema.pick({ x: true, y: true }),
})
export type DragBeginRequest = z.infer<typeof DragBeginRequestSchema>

export const DragEndRequestSchema = z.object({ moved: z.boolean(), distance: z.number().min(0) })
export type DragEndRequest = z.infer<typeof DragEndRequestSchema>

/** 拖拽推进（高频，走 send 而非 invoke）：renderer 每帧上报光标屏幕坐标 */
export const DragMoveSchema = z.object({ x: z.number(), y: z.number() })
export type DragMove = z.infer<typeof DragMoveSchema>

/**
 * 主进程 → renderer 的拖拽位置回报。
 * `dx/dy` 是**窗口真实位移**，直接喂给摇晃叠加层（Mate 的 `AvatarSwayController` 也是用窗口位移）。
 */
export const DragPosSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  dx: z.number(),
  dy: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})
export type DragPos = z.infer<typeof DragPosSchema>

/** pet 模式自动调整窗口尺寸（按角色需要），拖拽期间主进程会拒绝该请求 */
export const AutoResizeRequestSchema = z.object({
  width: z.number().int().min(120).max(1200),
  height: z.number().int().min(120).max(1200),
  anchor: z.enum(['top-left', 'bottom-center']).default('top-left'),
})

// ───────────────────────────────────────────────────────── 桌宠窗口（显示 / 收回 / 常驻）
/**
 * ★★ 「桌宠常驻与呼出」的入参契约（2026-10-09 完善轮）。
 *
 * 一个通道 + 一个 `action` 枚举，而不是四条通道：
 * 四条通道意味着四处独立的校验与四份可以各自漂移的返回体，
 * 而它们的**语义强耦合**（"取消常驻"必须顺手收回窗口、"呼出"不该改常驻）。
 */
export const PetControlRequestSchema = z.object({
  action: z.enum(['show', 'hide', 'toggle', 'open-panel']),
  /** 动作来源（诊断用；`api` = 程序化调用，`startup` = 启动流程自己调的） */
  source: z.enum(['tray', 'chat-menu', 'pet-menu', 'hotkey', 'startup', 'probe', 'api']).default('api'),
})
export type PetControlRequest = z.infer<typeof PetControlRequestSchema>

/** 读写「桌宠常驻」；`resident` 必填（读用 `PET_MENU_STATE` 的快照，不另开只读通道） */
export const PetResidentRequestSchema = z.object({
  resident: z.boolean(),
  source: z.enum(['tray', 'chat-menu', 'pet-menu', 'probe', 'settings-panel', 'api']).default('api'),
})
export type PetResidentRequest = z.infer<typeof PetResidentRequestSchema>

/**
 * ★ 桌宠窗口 + 常驻设置的**只读快照**（三处菜单共用的唯一真源）。
 *
 * ⚠ 为什么把"窗口可见性"和"常驻设置"放进**同一个**对象：
 *   C4（三处勾选状态同步）与托盘 tooltip（已呼出 / 已收回 / 常驻）读的都是这两个字段的组合。
 *   分成两条广播就会出现"设置更新了、可见性那条还没到"的中间态 ——
 *   而那个中间态的界面表现正是"勾选和窗口对不上"。
 */
export const PetMenuStateSchema = z.object({
  /** 「桌宠常驻」勾选值（= `settings.petResident`，唯一真源在主进程） */
  resident: z.boolean(),
  /** 桌宠窗口**此刻**是否可见 */
  visible: z.boolean(),
  /** 窗口是否已创建（`false` = 还没建，此时 `visible` 恒为 false） */
  created: z.boolean(),
  /** 窗口 id（未创建为 null） */
  windowId: z.number().int().nullable(),
  /** 是否处于最小化（"已呼出但被最小化"与"已收回"是两种不同的状态，不能混） */
  minimized: z.boolean(),
  /** 托盘 tooltip 用的**同一份**人话状态（保证 tooltip 与菜单读数不漂移） */
  statusText: z.string().max(64),
})
export type PetMenuState = z.infer<typeof PetMenuStateSchema>

/**
 * ★ 界面动作请求（main → pet 窗口）。
 *
 * 取值就是"打开哪个视图"的白名单。**不支持的一律不在这里出现**，
 * 对应的菜单项也就不会显示（纪律：宁可不显示，也不要一个点了没反应的死项）。
 */
export const UiActionSchema = z.enum([
  'memory',          // 记忆页
  'schedule',        // 日程与提醒
  'settings',        // 偏好设置
  'voice',           // 语音与麦克风（含屏幕理解与权限）
  'shortcuts',       // 快捷键一览（对话框）
  'about',           // 关于（对话框）
  /**
   * ★ **桌宠已收回**（main → renderer，2026-10-09 完善轮）。
   *
   * 为什么混进"打开某个视图"的枚举里：对 renderer 而言这两件事是同一类 ——
   * "主进程让我做一件事"。而桌宠被收回时必须发生的事（气泡收起、轮盘关闭、
   * 命中区域回到未显示态）**只有 renderer 自己做得了**：
   * 窗口不可见时它的旧矩形会残留，表现为"看不见的窗口还在吃桌面点击"。
   */
  'pet-hidden',
  /** ★ **桌宠已呼出**（与上一条对称：让界面把"未显示"的干净态解除） */
  'pet-shown',
])
export type UiAction = z.infer<typeof UiActionSchema>

/** `evt:ui-action` 载荷 */
export const UiActionRequestSchema = z.object({
  action: UiActionSchema,
  /** 谁请求的（诊断用） */
  source: z.enum(['tray', 'chat-menu', 'pet-menu', 'api']).default('api'),
  at: z.number(),
})

/**
 * `ui:action` 的**入参**（renderer → main）。
 *
 * 只允许"打开某个视图"那一半（`memory` / `schedule` / `settings` / `voice` / `shortcuts` / `about`）——
 * `pet-hidden` / `pet-shown` 是**主进程单向下发**的状态通知，
 * 让 renderer 也能发它们等于凭空造出"假装自己被收回了"的能力，没有用处只有风险。
 */
export const UiActionRequestInputSchema = z.object({
  action: z.enum(['memory', 'schedule', 'settings', 'voice', 'shortcuts', 'about']),
  source: z.enum(['tray', 'chat-menu', 'pet-menu', 'api']).default('api'),
})
export type UiActionRequestInput = z.infer<typeof UiActionRequestInputSchema>
export type UiActionRequest = z.infer<typeof UiActionRequestSchema>

/**
 * ★ 对话数据目录 / 关于信息 —— **两条只读投影**。
 *
 * ⚠ 这里**不含**任何密钥、不含对话正文；`dataDir` 是 `%APPDATA%\AiriMateOne`
 *   这一个**固定**目录（与 `privacy:summary` 的 `userDataDir` 同一份来源、同一口径）。
 *   它出现在这里是因为"打开数据目录"这个菜单项必须能被机械验证
 *   （探针读回它并与 `app.getPath('userData')` 比对），而不是靠人眼看资源管理器。
 */
export const ChatDataDirSchema = z.object({
  dataDir: z.string().max(500),
  logsDir: z.string().max(500),
  opened: z.boolean(),
})

// ───────────────────────────────────────────────────────── 对话（对话框 + 气泡）

/**
 * 打开对话窗口的来源。**必须记下来**：五个入口（轮盘 / 托盘 / 快捷键 / 唤醒 / 双击）
 * 外加气泡里的「看完整对话 →」按钮，出问题时第一个要回答的问题就是"是哪条入口没生效"。
 */
export const ConversationSourceSchema = z.enum([
  'wheel', 'tray', 'hotkey', 'wake', 'dblclick', 'bubble',
  /**
   * ★ `startup`：**启动时自动打开对话窗口**（2026-10-09 完善轮）。
   *
   * 为什么单独一个来源而不是复用 `api`：新默认行为就是"打开软件只出现对话窗口"，
   * 而"这个窗口是启动时自己开的、还是用户点了什么开的"是排障的第一个问题
   * （`state.lastSource` 会原样进证据）。
   */
  'startup',
  /**
   * ★ `pet-menu`：从**桌宠自身的右键菜单**「和她说说话」打开（2026-10-09 完善轮）。
   * 参考实现里这是桌宠菜单的一项，所以它是第六条用户入口 ——
   * 六个入口的语义仍然完全一致（显示并聚焦，绝不隐藏）。
   */
  'pet-menu',
  /**
   * ★ `probe`：**验收探针**自己发起的调用（2026-10-09 完善轮新增）。
   *
   * 为什么探针要有一个**自己的来源名**：探针会为了让判据回到起点而收起窗口
   * （新默认行为是"启动就打开对话窗口"）。如果它复用 `api`，
   * 事后看日志就无法区分"用户/程序收起了一次"与"探针收起了一次" ——
   * 而排查"位置没记住""居中不对"这类问题时，**谁在什么时候收的窗口**是第一个要回答的问题。
   */
  'probe',
  'api',
])
export type ConversationSource = z.infer<typeof ConversationSourceSchema>

export const ConversationOpenRequestSchema = z.object({
  source: ConversationSourceSchema.default('api'),
  /**
   * 是否同时进入"听"状态（语音唤醒走这条；它**不**自己开麦克风，
   * 只是让对话窗口去调已有的 `voice:listen-once`）。
   */
  listen: z.boolean().default(false),
  /**
   * 打开后是否把焦点放到输入框。
   * 默认 `true` —— 用户按快捷键/双击/点气泡的意图就是"我要打字"。
   * 唤醒词那条路径显式要求焦点进输入框（规格 §五.5），所以它也是 true。
   */
  focusInput: z.boolean().default(true),
})

export const ConversationCloseRequestSchema = z.object({
  source: ConversationSourceSchema.default('api'),
})

/**
 * ★ 独立对话窗口（chat）的状态 —— **只读诊断读数**。
 *
 * 为什么把"窗口句柄有没有变 / 有没有被真的创建过"也放进来：
 *   判据要求"重复打开只复用同一个窗口（hwnd 不变）"，而
 *   "每次都新建一个再显示"在**界面上看起来完全一样**（位置、尺寸、内容全同），
 *   只有比较窗口 id 才能分辨。这是"单例"这条判据唯一可信的读数口。
 */
export const ChatWindowStateSchema = z.object({
  /** `BrowserWindow.id`（Electron 的窗口句柄读数；恒等 = 复用了同一个窗口） */
  id: z.number().int().nullable(),
  visible: z.boolean(),
  focused: z.boolean(),
  minimized: z.boolean(),
  bounds: RectSchema.nullable(),
  alwaysOnTop: z.boolean(),
  /** 创建次数（本会话内）。判据：`openCount ≥ 2 ⇒ createdCount === 1` */
  createdCount: z.number().int().min(0),
  /** 创建后是否发过 `ready-to-show`（据此判断"窗口对象有了、页面还没画出来"） */
  readyToShow: z.boolean(),
  /** 本次 bounds 是"用记忆值"还是"居中"得来的 —— 居中的误差判据要靠它区分 */
  boundsSource: z.enum(['remembered', 'centered', 'default']).nullable(),
})

/**
 * ⚠ 显式声明接口，**不用** `z.infer`。
 *
 * 实测教训（本项目已踩过同一类坑）：renderer 与 main 走的是**不同的打包路径**
 * （Vite 编译 `packages/shared/src` 的 TS 源码；desktop 编译到 `dist/*.d.ts`），
 * 而 `z.infer` 在"递归 schema"上会解析成 `any`，把类型安全性悄悄丢掉。
 * 显式接口 + 下面这一行赋值检查，两边的形状不可能漂移。
 */
export interface ChatWindowState {
  id: number | null
  visible: boolean
  focused: boolean
  minimized: boolean
  bounds: Rect | null
  alwaysOnTop: boolean
  createdCount: number
  readyToShow: boolean
  boundsSource: 'remembered' | 'centered' | 'default' | null
}

/**
 * 对话状态（**只读**）。
 *
 * ⚠ 2026-10-08 返工轮：`layout` 的 `'conversation'` 取值**已删除**。
 *   它原本表示"pet 窗口被放到了 380×560 的对话态尺寸"，而那个做法已被用户否决
 *   （聊天框必须与桌宠是两个独立窗口）。现在：
 *     · `layout` 只描述 **pet 窗口**自己处于哪种形态（`panel` / `pet`），
 *       它与"对话窗口开没开"**完全解耦** —— 入口不再改 pet 窗口的任何东西；
 *     · 对话窗口自己的读数在 `chat` 里（含 hwnd、可见性、是否置顶、几何来源）。
 *   `mode` 保留（= `layout`，向后兼容既有读取方）。
 */
export const ConversationStateSchema = z.object({
  open: z.boolean(),
  layout: z.enum(['panel', 'pet']),
  mode: WindowModeSchema,
  bounds: RectSchema,
  /** chat 窗口（独立 BrowserWindow）的读数；未创建时为 null 字段全空 */
  chat: ChatWindowStateSchema,
  /**
   * ★★ **桌宠窗口 + 常驻设置**的读数（2026-10-09 完善轮新增）。
   *
   * ⚠ 带 `.default()`：老证据 JSON（2026-10-08 那批 `chatwindow.json`）里没有这个键，
   *   它们必须**仍然能解析** —— 否则"历史证据仍可作为历史被引用"这条就不成立了。
   *   但这不改变运行时事实：主进程现在**总是**填它（见 `conversationState()`）。
   */
  pet: PetMenuStateSchema.default({ resident: false, visible: false, created: false, windowId: null, minimized: false, statusText: '' }),
  /** 快捷键注册结果的**如实**报告（失败时 error 非空，且界面上有可见告警） */
  hotkey: z.object({
    accelerator: z.string().max(64),
    enabled: z.boolean(),
    registered: z.boolean(),
    error: z.string().max(300).nullable(),
  }),
  /** 本会话内各入口的触发计数（诊断用；不含任何内容） */
  openCount: z.number().int().min(0),
  closeCount: z.number().int().min(0),
  lastSource: ConversationSourceSchema.nullable(),
})
export type ConversationState = z.infer<typeof ConversationStateSchema>
/** 唤醒词触发的"开始听"请求（main → renderer；不含任何识别正文） */
export const ConversationListenRequestSchema = z.object({
  at: z.number(),
  /** 触发它的来源（目前只有 `wake`） */
  source: ConversationSourceSchema,
})
export type ConversationListenRequest = z.infer<typeof ConversationListenRequestSchema>

// ───────────────────────────────────────────────────────── 命中区域
/**
 * renderer 上报的**可交互区域**（窗口内 CSS 像素坐标）。
 * 主进程据此决定 setIgnoreMouseEvents —— 这是"透明区域不吃桌面点击"的唯一实现路径。
 */
export const HitRegionsSchema = z.object({
  regions: z.array(z.object({
    id: z.string().max(32),
    kind: z.enum(['character', 'wheel', 'bubble', 'panel']),
    x: z.number(), y: z.number(), w: z.number().min(0), h: z.number().max(20000),
    /** 外扩（像素）：悬停容差 */
    pad: z.number().min(0).max(128).default(0),
  })).max(16),
  /** 上报序号，主进程用于丢弃乱序 */
  seq: z.number().int().min(0),
})
export type HitRegions = z.infer<typeof HitRegionsSchema>

// ───────────────────────────────────────────────────────── 诊断（只读探针）

export const StageSnapshotSchema = z.object({
  stageId: z.string(),
  rendererId: z.string(),
  /**
   * 动作导演的当前相位（`MotionRuntime` 的状态机）。
   *
   * ⚠ 加上这个字段是在还债：运行时 `stage.ts` 的 `snapshot()` **一直在产出** `phase`，
   *   但 schema 里没有 ⇒ zod 默认把这个键**静默丢掉**，
   *   于是 renderer 侧读 `snap.phase` 永远是 `undefined`（typecheck 也报错）。
   *   这正是本项目反复踩到的"契约漂移导致字段静默消失"。
   *   这里按 `MotionRuntime` 的真实取值收敛为枚举；未知相位降级为 `uninitialized`
   *   而不是整条快照校验失败（快照是诊断通道，不该因为一个新相位就整体丢弃）。
   */
  phase: z.enum(['uninitialized', 'idle', 'state', 'oneShot', 'drag', 'error'])
    .catch('uninitialized')
    .default('uninitialized'),
  mixerId: z.string(),
  vrmInstanceId: z.string(),
  sceneCount: z.number().int(),
  rendererCount: z.number().int(),
  mixerCount: z.number().int(),
  vrmCount: z.number().int(),
  live2dCount: z.number().int(),
  activeClip: z.string().nullable(),
  activeWeight: z.number(),
  /**
   * 活动动作的播放时间与时长（秒）—— **浸泡回归判定"还在动"的直接证据**。
   *
   * 为什么不靠骨骼四元数判断：实测 `getNormalizedBoneNode().quaternion` 与
   * `getRawBoneNode().quaternion` 在 5 秒内每 500ms 只有**恒定 0.026°** 的变化，
   * 而它同时是 `boneTravelAccum` 的采样源 ⇒ 那个累计值也无法证明"在动"。
   * `AnimationAction.time` 随 `mixer.update()` 单调推进（到时回绕）；
   * 它不推进就只有一种解释 —— 渲染循环或 mixer 停了。
   *
   * `catch(null).default(null)` 是为了**向后兼容**：老快照缺这两个字段时
   * 不应让整条快照校验失败（快照是诊断通道，不该因新增字段而整体丢弃）。
   */
  activeTimeSec: z.number().nullable().catch(null).default(null),
  activeDurationSec: z.number().nullable().catch(null).default(null),
  baseClipId: z.string().nullable(),
  crossfade: z.object({ from: z.string().nullable(), to: z.string().nullable(), t: z.number() }),
  idleIndex: z.number().int(),
  idleTotal: z.number().int(),
  dragging: z.boolean(),
  /** 17 根必需骨骼的四元数（验收判据 A12 的采样源） */
  bones: z.record(z.string(), z.object({ x: z.number(), y: z.number(), z: z.number(), w: z.number() })),
  boneTravelAccum: z.record(z.string(), z.number()),
  fps: z.object({ avg1s: z.number(), avg5s: z.number() }),
  heapMB: z.number(),
  wheel: z.object({ open: z.boolean(), cx: z.number(), cy: z.number(), scale: z.number() }),
  modelId: z.string().nullable(),
  modelLoadMs: z.number().nullable(),
  warnings: z.array(z.string()),
  /**
   * 取景与渲染的实测诊断（用于定位"模型加载成功但看不见"这类问题）。
   * 全部是实测值，不是估算。
   */
  view: z.object({
    /** canvas 的 CSS 尺寸与 drawingBuffer 尺寸（两者不一致说明 setSize/DPR 有问题） */
    canvasCss: z.object({ w: z.number(), h: z.number() }),
    canvasBuffer: z.object({ w: z.number(), h: z.number() }),
    /** renderer 自己认为的尺寸与像素比（三方对照才能定位坐标错位） */
    rendererSize: z.object({ w: z.number(), h: z.number() }),
    pixelRatio: z.number(),
    devicePixelRatio: z.number(),
    /** 相机位置与到模型中心的距离 */
    cameraPos: z.object({ x: z.number(), y: z.number(), z: z.number() }),
    cameraDist: z.number(),
    near: z.number(),
    far: z.number(),
    fov: z.number(),
    /** 模型包围盒（世界坐标） */
    modelBox: z.object({
      min: z.object({ x: z.number(), y: z.number(), z: z.number() }),
      max: z.object({ x: z.number(), y: z.number(), z: z.number() }),
      size: z.object({ x: z.number(), y: z.number(), z: z.number() }),
    }).nullable(),
    /** 模型是否在相机视锥内（用包围盒 8 角点判定） */
    inFrustum: z.boolean(),
    /** 场景可见 Mesh 数 / 其中材质为 MToon 的数 / 可见蒙皮网格数 */
    visibleMeshes: z.number().int(),
    mtoonMeshes: z.number().int(),
    skinnedMeshes: z.number().int(),
    /** 渲染器最近一帧的绘制统计（renderer.info） */
    drawCalls: z.number().int(),
    triangles: z.number().int(),
    /** 最后一次渲染是否真的执行过（null = 从未渲染） */
    lastRenderAt: z.number().nullable(),
    /**
     * 驱动源计数（用于证明"到底是谁在驱动渲染"）：
     * `requestAnimationFrame` 在窗口被遮挡时会被 Chromium 节流甚至停发，
     * 因此还有一条 `setInterval` 兜底泵；这两个计数是判断渲染是否真在跑的唯一硬证据。
     */
    rafTicks: z.number().int(),
    intervalTicks: z.number().int(),
    paused: z.boolean(),
    /** 角色投影到画布内的屏幕矩形（画布 CSS 像素） */
    screenRect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
    /** WebGL 帧缓冲回读得到的"非清屏色像素比例"（-1 = 回读失败） */
    canvasNonBgRatio: z.number(),
    /** 模型健康度：尺度/骨骼高度/顶点数（定位"相机正常但模型看不见"） */
    modelHealth: z.object({
      meshWorldScale: z.number(),
      hipsWorldY: z.number().nullable(),
      headWorldY: z.number().nullable(),
      leftFootWorldY: z.number().nullable(),
      vrmRestHipsY: z.number().nullable(),
      maxVertices: z.number(),
      animationRestHipsY: z.number().nullable(),
      /** 实际清屏色（RGBA 0-255）—— 像素判定的唯一可信基准 */
      clearColorRgb: z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number() }).optional(),
      /** 画布采样点的实际 RGBA */
      pixelSamples: z.array(z.object({
        x: z.number(), y: z.number(),
        rgba: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      })).optional(),
      /** 蒙皮自检 */
      skin: z.object({
        skinnedMeshCount: z.number(),
        boneCount: z.number(),
        boneInversesSample: z.array(z.number()),
        firstVertexSkinIndex: z.array(z.number()),
        firstVertexSkinWeight: z.array(z.number()),
        hasSkinAttribute: z.boolean(),
      }).optional(),
      /** 可信像素统计（众数颜色为背景基准，免受色彩空间影响） */
      pixelStats: z.object({
        total: z.number(),
        nonBg: z.number(),
        ratio: z.number(),
        bgMode: z.tuple([z.number(), z.number(), z.number()]),
        contentBox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
      }).optional(),
      /** 逐 mesh 绘制可行性（空索引 / 零 drawRange 是"有顶点却不画"的典型病因） */
      meshDraw: z.array(z.object({
        name: z.string(),
        visible: z.boolean(),
        materialVisible: z.boolean(),
        hasIndex: z.boolean(),
        indexCount: z.number(),
        positionCount: z.number(),
        drawRangeCount: z.number(),
        inScene: z.boolean(),
      })).optional(),
      /** 蒙皮顶点实测：手动按 three.js 公式算世界坐标（最终判据） */
      skinProbe: z.object({
        meshName: z.string(),
        vertexCount: z.number(),
        reason: z.string().nullable(),
        attrNames: z.array(z.string()),
        boneMatrixCount: z.number(),
        samples: z.array(z.object({
          i: z.number(),
          local: z.tuple([z.number(), z.number(), z.number()]),
          world: z.tuple([z.number(), z.number(), z.number()]),
          ndc: z.tuple([z.number(), z.number(), z.number()]),
          skinIndex: z.tuple([z.number(), z.number(), z.number(), z.number()]),
          skinWeight: z.tuple([z.number(), z.number(), z.number(), z.number()]),
          weightSum: z.number(),
        })),
      }).nullable().optional(),
    }).optional(),
    /** 画布在**视口坐标**中的矩形（renderer 侧填充） */
    canvasViewport: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
    /** 画布的计算样式关键项（用于排查"被隐藏/被覆盖"） */
    canvasStyle: z.object({
      display: z.string(), visibility: z.string(), opacity: z.string(),
      zIndex: z.string(), position: z.string(),
    }).optional(),
  }),
})
export type StageSnapshot = z.infer<typeof StageSnapshotSchema>

export const AppDiagnosticsSchema = z.object({
  appId: z.string(),
  version: z.string(),
  pid: z.number().int(),
  bootId: z.string(),
  uptimeSec: z.number(),
  instances: z.number().int(),
  windows: z.array(z.object({
    id: z.number().int(),
    title: z.string(),
    bounds: RectSchema,
    visible: z.boolean(),
    mode: WindowModeSchema,
    alwaysOnTop: z.boolean(),
    ignoreMouseEvents: z.boolean(),
  })),
  browserWindowCount: z.number().int(),
  mutex: z.object({ holderPid: z.number().int().nullable(), status: z.enum(['held', 'already-held', 'unavailable']) }),
  lockFile: z.object({ path: z.string(), pid: z.number().int().nullable(), stale: z.boolean() }),
  listeningPorts: z.array(z.object({ address: z.string(), port: z.number().int(), loopback: z.boolean() })),
  legacy: z.object({
    checked: z.boolean(),
    blocked: z.boolean(),
    hits: z.array(z.object({ kind: z.string(), pid: z.number().int(), imagePath: z.string(), reason: z.string() })),
  }),
  secrets: z.object({ backend: z.enum(['safeStorage', 'credential-manager', 'unavailable']), providerCount: z.number().int() }),
  /**
   * 动作资产状态。
   *
   * ⚠ `license` / `redistributable` 是**后加的**，用 `.default()` 而不是必填：
   *   旧诊断报文（或某个还没升级的读取方）不该因为多了这两个字段就整个校验失败。
   *   但它们必须**能被读到** —— 否则"这些动作许不许随包分发"在界面上无法回答，
   *   而动作正是本项目里最容易被误当成"只是些文件"的私有资产。
   */
  motion: z.object({
    clipCount: z.number().int(),
    manifestCount: z.number().int(),
    failed: z.array(z.string()),
    clipIds: z.array(z.string()).default([]),
    license: z.string().nullable().default(null),
    redistributable: z.boolean().nullable().default(null),
  }),
  /**
   * ★ 对话状态摘要（只读）。放进诊断快照的理由与 m1/m2 相同：探针只认诊断文件，
   *   而"对话框开没开、窗口在哪种布局、快捷键到底注册上没有"必须能被机械验证。
   *   `.default()` 保证向后兼容（老快照缺这个键不该整条校验失败）。
   */
  conversation: ConversationStateSchema.nullable().default(null),
})
export type AppDiagnostics = z.infer<typeof AppDiagnosticsSchema>

// ───────────────────────────────────────────────────────── 设置

export const SettingsPatchSchema = z.object({
  mode: WindowModeSchema.optional(),
  alwaysOnTop: z.boolean().optional(),
  autoStart: z.boolean().optional(),
  reducedMotion: z.boolean().optional(),
  avatarId: z.string().max(64).optional(),
  ttsEnabled: z.boolean().optional(),
  ttsProviderId: z.string().max(64).optional(),
  ttsVoice: z.string().max(64).nullable().optional(),
  hearingEnabled: z.boolean().optional(),
  bubbleEnabled: z.boolean().optional(),
  chatModel: z.string().max(120).optional(),
  systemPersonaId: z.string().max(64).optional(),
  fpsCap: z.number().int().min(15).max(240).optional(),
  /** 显式角色缩放（0.70–1.40）；只有设置面板可以改它（见 AppSettingsSchema 注释） */
  avatarScale: z.number().min(0.70).max(1.40).optional(),
  locale: z.enum(['zh-CN', 'en-US']).optional(),

  // ── M1 配置闭环（renderer 可写；密钥与向导进度**不在这里**）
  chatIdleAbortMs: z.number().int().min(0).max(600_000).optional(),
  chatHistoryLimit: z.number().int().min(20).max(1000).optional(),
  telemetryEnabled: z.boolean().optional(),
  onboardingAutoStart: z.boolean().optional(),
  /**
   * 首次运行向导是否完成。
   * ⚠ 向导的**判据**在主进程（`onboarding:complete` 会拒绝未满足的步骤）；
   *   这个字段只是"是否还弹向导"的开关，允许用户跳过向导直接使用。
   */
  onboarded: z.boolean().optional(),

  // ── M2 主动陪伴（全部开关都可关；阈值在 reminder policy 里，不在 settings）
  proactiveEnabled: z.boolean().optional(),
  greetingEnabled: z.boolean().optional(),
  scheduleBriefEnabled: z.boolean().optional(),
  morningRadioEnabled: z.boolean().optional(),
  morningRadioAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  morningRadioSpeak: z.boolean().optional(),
  continuousReminderEnabled: z.boolean().optional(),
  sedentaryReminderEnabled: z.boolean().optional(),
  nightReminderEnabled: z.boolean().optional(),
  userSilent: z.boolean().optional(),
  activitySamplingEnabled: z.boolean().optional(),
  activityTitleDigestEnabled: z.boolean().optional(),
  weatherCity: z.string().max(80).optional(),
  weatherEndpoint: z.string().max(300).optional(),
  geocodeEndpoint: z.string().max(300).optional(),
  selfLearningEnabled: z.boolean().optional(),
  selfLearningAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),

  // ── M3 语音 / 屏幕（renderer 可写；**麦克风总开关也在其中**，默认 false）
  wakeWordEnabled: z.boolean().optional(),
  wakeWord: z.string().max(20).optional(),
  voicePrivacyNoticeShown: z.boolean().optional(),
  voiceListenTimeoutMs: z.number().int().min(1000).max(60_000).optional(),
  /** 说话时允许开口打断（barge-in）；**默认 false**，理由见 `settings.ts` 的同名字段 */
  voiceBargeIn: z.boolean().optional(),
  voiceBargeInNoticeShown: z.boolean().optional(),
  screenNoticeEnabled: z.boolean().optional(),
  screenRedactSensitive: z.boolean().optional(),

  // ── ★ 对话（返工轮）：快捷键与气泡时长都允许用户改；确认位只允许置真
  conversationHotkey: z.string().min(1).max(64).optional(),
  conversationHotkeyEnabled: z.boolean().optional(),
  bubbleAutoHideSec: z.number().min(1).max(30).optional(),
  conversationAutoTtsConfirmed: z.boolean().optional(),
  /**
   * ★ 独立对话窗口的记忆几何与置顶。
   *
   * `chatWindowBounds` 一般是**主进程**在窗口 move/resize 后写入的（见 `chat-window.ts`），
   * 开放给 renderer 是为了让"把记忆矩形设成屏幕外 ⇒ 回落居中"这条判据能被机械驱动 ——
   * 探针不必去拖窗口，直接写一个不可能在屏内的矩形再重开即可。
   */
  chatWindowBounds: RectSchema.nullable().optional(),
  chatWindowAlwaysOnTop: z.boolean().optional(),

  // ── ★★ 桌宠常驻与启动行为（2026-10-09 完善轮）
  /**
   * 桌宠是否常驻。**默认 `false`**（见 `settings.ts` 的同名字段）。
   *
   * ⚠ 正常路径是走 `pet:set-resident`（它会**顺手**显示/隐藏窗口 + 立即落盘）；
   *   开放给 renderer 直接改是为了让"设置面板里也有这个勾选框"与
   *   "探针要能把默认值复位"成为可能 —— 但**只改这一个字段不会动窗口**，
   *   设置面板改了它必须跟着调 `pet:set-resident`（见 `SettingsPanel.vue` 的写法）。
   */
  petResident: z.boolean().optional(),
  /** 启动时是否打开对话窗口（默认 `true`） */
  startupOpenChat: z.boolean().optional(),
})
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

// ───────────────────────────────────────────────────────── 对话

export const ChatSendRequestSchema = z.object({
  text: z.string().min(1).max(8000),
  /** 幂等键，防重复发送 */
  clientId: z.string().max(64),
})
export type ChatSendRequest = z.infer<typeof ChatSendRequestSchema>
export const ChatDeltaSchema = z.object({
  requestId: z.string(),
  delta: z.string(),
  /** 已经过主进程的动作标记剥离；renderer 只做展示，不解析动作 */
  displayText: z.string(),
})
export type ChatDelta = z.infer<typeof ChatDeltaSchema>

export const ChatDoneSchema = z.object({
  requestId: z.string(),
  /** 完整回复（已剥离动作标记，供气泡与口型使用） */
  text: z.string(),
  /** 由会话层产出、已解析并通过校验的动作事件（唯一真源） */
  commands: z.array(StageCommandSchema),
  usage: z.object({ promptTokens: z.number().int().nullable(), completionTokens: z.number().int().nullable() }).nullable(),
  /** true = 被 /stop 中断 */
  aborted: z.boolean(),
  durationMs: z.number(),
})
export type ChatDone = z.infer<typeof ChatDoneSchema>

export const ChatErrorSchema = z.object({
  requestId: z.string(),
  code: z.enum(['no-provider', 'auth', 'rate-limit', 'network', 'aborted', 'bad-response', 'internal']),
  /** 已脱敏；不得包含密钥 */
  message: z.string().max(500),
  retryable: z.boolean(),
})
export type ChatError = z.infer<typeof ChatErrorSchema>

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  text: z.string(),
  createdAt: z.number(),
  /** 该条回复触发的动作（用于回放与验收） */
  commands: z.array(StageCommandSchema).default([]),
  /**
   * 消息来源。普通对话是 `user`；主动消息（问候 / 早安电台 / 反思）标成对应来源，
   * 这样 UI 能把"她主动说的"与"我发起的"区分开，验收也能按来源统计。
   */
  origin: z.enum(['user', 'proactive', 'radio', 'reflection']).default('user'),
})
export type ChatMessage = z.infer<typeof ChatMessageSchema>

export const ChatHistorySchema = z.object({ messages: z.array(ChatMessageSchema), total: z.number().int() })

/**
 * `chat:context-reset` 出参。
 *
 * ⚠ 这是"**只重置上下文，不删历史**"（见 `IPC.CHAT_CONTEXT_RESET` 的说明）。
 *   两个计数都是**如实读数**：
 *     · `archivedCount` —— 被划到"上一段对话"的消息条数（它们仍在历史里）；
 *     · `visibleCount`  —— 重置之后**界面上还能看到**的条数（正常是 0）。
 *   探针据此断言"历史真的没被删"（`archivedCount > 0` 且总量不减），
 *   而不是只看一句 ok:true。
 */
export const ChatContextResetResultSchema = z.object({
  ok: z.literal(true),
  archivedCount: z.number().int().min(0),
  visibleCount: z.number().int().min(0),
  totalCount: z.number().int().min(0),
  resetAt: z.number(),
})

/**
 * `chat:abort` 出参。
 *
 * ⚠ `aborted:false` 是**必须存在**的取值：用户点"停止"时可能刚好没有在生成的回复，
 *   如实告知比假装成功更重要（否则 UI 会显示"已停止"而其实什么也没发生）。
 */
export const ChatAbortResultSchema = z.object({
  aborted: z.boolean(),
  requestId: z.string().nullable(),
  /** 已被 renderer 收到的增量字符数（UI 显示"已停止（已收到 N 字）"） */
  receivedChars: z.number().int().min(0),
})
export type ChatAbortResult = z.infer<typeof ChatAbortResultSchema>

// ───────────────────────────────────────────────────────── TTS（语音合成）

/**
 * `tts:speak` 入参。
 *
 * ⚠ **正文只在这条通道上出现一次**，且只在主进程内存里：
 *   · 主进程把它经 **stdin** 交给 `powershell.exe`（SAPI）子进程；
 *   · 命令行里没有正文（进程列表 / 命令行日志拿不到对话内容）；
 *   · 日志只记长度，不记正文（见项目脱敏纪律）。
 * `utteranceId` 与 `SpeechCommandSchema.utteranceId` 同形，用于把
 * `evt:tts-state` 关联回产生它的那条 `speech` 命令。
 */
export const TtsSpeakRequestSchema = z.object({
  text: z.string().min(1).max(20000),
  utteranceId: z.string().min(1).max(64),
  /** 覆盖本次朗读的声音名（缺省用设置里的 `ttsVoice`，再缺省 zh-CN 优先） */
  voice: z.string().max(64).nullable().optional(),
})
export type TtsSpeakRequest = z.infer<typeof TtsSpeakRequestSchema>

/** 本机可用声音（**公开投影**：不含任何本机路径） */
export const TtsVoiceSchema = z.object({
  /** 传给 SAPI 的 `SelectVoice()` 的名字，也是 `AppSettings.ttsVoice` 的可选值 */
  id: z.string().max(64),
  label: z.string().max(160),
  /** BCP-47 文化名，如 `zh-CN`；未知为 `unknown` */
  lang: z.string().max(32),
  gender: z.string().max(16).nullable(),
})
export type TtsVoice = z.infer<typeof TtsVoiceSchema>

/** `evt:tts-state`：朗读生命周期（与 `preload-api.ts` 的 `TtsStateEvent` 同形） */
export const TtsStateEventSchema = z.object({
  utteranceId: z.string().max(64),
  state: z.enum(['start', 'end', 'error']),
  error: z.string().max(300).optional(),
})
export type TtsStateEventPayload = z.infer<typeof TtsStateEventSchema>

// ───────────────────────────────────────────────────────── 供应商

export const ProviderKindSchema = z.enum(['openai-compatible', 'deepseek', 'openai', 'anthropic-compatible', 'ollama', 'custom'])
export type ProviderKind = z.infer<typeof ProviderKindSchema>

/** ⚠ 出参：**永不包含 apiKey** */
export const ProviderPublicSchema = z.object({
  id: z.string().max(64),
  label: z.string().max(64),
  kind: ProviderKindSchema,
  baseUrl: z.string().max(300),
  model: z.string().max(120),
  hasKey: z.boolean(),
  /** sha256(key) 前 8 位 + 长度，仅用于"是不是同一把钥匙"的判断 */
  keyFingerprint: z.string().max(16).nullable(),
  keyLength: z.number().int().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type ProviderPublic = z.infer<typeof ProviderPublicSchema>

/** 入参：apiKey 只在 renderer→main 的单向通道里出现一次，主进程加密后立即丢弃明文 */
export const ProviderUpsertSchema = z.object({
  id: z.string().max(64).optional(),
  label: z.string().min(1).max(64),
  kind: ProviderKindSchema,
  baseUrl: z.string().url().max(300),
  model: z.string().min(1).max(120),
  /** 不传 = 保持原密钥；传空串 = 清除密钥 */
  apiKey: z.string().max(400).optional(),
})
export type ProviderUpsert = z.infer<typeof ProviderUpsertSchema>

export const ProviderSelectSchema = z.object({ id: z.string().min(1).max(64) })

export const ProviderTestCodeSchema = z.enum([
  'ok', 'auth', 'rate-limit', 'network', 'bad-response', 'timeout', 'no-key', 'blocked-target', 'insecure-url',
])
export type ProviderTestCode = z.infer<typeof ProviderTestCodeSchema>

export const ProviderTestResultSchema = z.object({
  ok: z.boolean(),
  code: ProviderTestCodeSchema,
  latencyMs: z.number().int().nullable(),
  message: z.string().max(300),
  /** 命中模型数（`/models` 可达时给出，便于用户判断端点是否正确） */
  modelCount: z.number().int().nullable().default(null),
})
export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>

/** 从供应商端点拉取模型清单（可选能力；端点不支持时 `supported:false`，不报错） */
export const ProviderModelsResultSchema = z.object({
  supported: z.boolean(),
  models: z.array(z.string().max(160)).max(500).default([]),
  code: ProviderTestCodeSchema,
  message: z.string().max(300),
})
export type ProviderModelsResult = z.infer<typeof ProviderModelsResultSchema>

// ───────────────────────────────────────────────────────── 首次运行向导
//
// 形状定义在 `proactive.ts`（避免 `ipc → settings → ipc` 的 ESM 循环，见那里的注释），
// 这里只做转发，让「契约都在 ipc.ts」这个阅读习惯继续成立。
export {
  OnboardingStepSchema, OnboardingStateSchema, OnboardingStatusSchema,
  OnboardingSetStepSchema, OnboardingCompleteSchema,
} from './proactive.js'
export type { OnboardingStep, OnboardingState, OnboardingStatus } from './proactive.js'

// ───────────────────────────────────────────────────────── 人设 / 记忆

export const PersonaSchema = z.object({
  id: z.string().max(64),
  name: z.string().min(1).max(40),
  /** 她怎么称呼用户（称呼偏好） */
  userTitle: z.string().max(40).default('你'),
  /** 系统提示词（结构化字段拼装，避免用户写裸 prompt） */
  systemPrompt: z.string().max(8000),
  personality: z.string().max(2000),
  speakingStyle: z.string().max(1000),
  greeting: z.string().max(500),
  /** 说话节奏 → 口型/动作的表演偏好 */
  performance: z.object({
    expressiveness: z.number().min(0).max(1),
    gestureFrequency: z.number().min(0).max(1),
    idleChatter: z.boolean(),
  }),
  updatedAt: z.number(),
})
export type Persona = z.infer<typeof PersonaSchema>

export const MemoryEntrySchema = z.object({
  id: z.string(),
  /** 记忆正文（本地存储；日志与诊断包中一律脱敏） */
  text: z.string().max(4000),
  tags: z.array(z.string().max(32)).max(16),
  importance: z.number().min(0).max(1),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  useCount: z.number().int().min(0),
})
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>

/** `memory:add` 入参。正文上限与存储层一致（4000），标签上限 16。 */
export const MemoryAddRequestSchema = z.object({
  text: z.string().min(1).max(4000),
  tags: z.array(z.string().max(32)).max(16).optional(),
  importance: z.number().min(0).max(1).optional(),
})

/** `memory:update` —— 只有正文/标签/重要度可改（id 与使用统计由存储层掌管） */
export const MemoryUpdateRequestSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(4000).optional(),
  tags: z.array(z.string().max(32)).max(16).optional(),
  importance: z.number().min(0).max(1).optional(),
}).refine(
  v => v.text !== undefined || v.tags !== undefined || v.importance !== undefined,
  { message: '至少要给出一个要修改的字段' },
)
export type MemoryUpdateRequest = z.infer<typeof MemoryUpdateRequestSchema>

export const MemoryDeleteRequestSchema = z.object({ id: z.string().min(1).max(64) })

/** `memory:recall` 入参：limit 上限 20（避免 renderer 一次拉走全部记忆）。 */
export const MemoryRecallRequestSchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(20).default(5),
})

/**
 * `memory:search` 入参：`query` 为空串时退化为"按重要度 + 时间浏览"。
 * 与 `recall` 的区别：**检索**有过滤条件、可用于管理；**召回**只做相关性打分。
 */
export const MemorySearchRequestSchema = z.object({
  query: z.string().max(2000).default(''),
  limit: z.number().int().min(1).max(100).default(50),
  minImportance: z.number().min(0).max(1).default(0),
  tag: z.string().max(32).nullable().default(null),
})
export type MemorySearchRequest = z.infer<typeof MemorySearchRequestSchema>

export const MemoryRecallHitSchema = z.object({ entry: MemoryEntrySchema, score: z.number() })
export type MemoryRecallHit = z.infer<typeof MemoryRecallHitSchema>

/**
 * 召回预览：既给命中条目，也给**真正会被注入系统提示的文本**。
 * 记忆层不能是黑盒 —— 用户要能判断该记什么、该删什么。
 */
export const MemoryRecallPreviewSchema = z.object({
  query: z.string().max(2000),
  hits: z.array(MemoryRecallHitSchema),
  injectedBlock: z.string().max(2000).nullable(),
  injectedChars: z.number().int().min(0),
})
export type MemoryRecallPreview = z.infer<typeof MemoryRecallPreviewSchema>

// ───────────────────────────────────────────────────────── 隐私与数据主体权利

export const PrivacyExportRequestSchema = z.object({
  format: z.enum(['json', 'markdown']).default('json'),
  includeChats: z.boolean().default(true),
  includeMemory: z.boolean().default(true),
})
export type PrivacyExportRequest = z.infer<typeof PrivacyExportRequestSchema>

export const PrivacyExportResultSchema = z.object({
  file: z.string().max(400),
  bytes: z.number().int().min(0),
  sections: z.array(z.string().max(64)).max(32),
  /** 导出时被剔除/占位的字段（如密钥恒为 `<encrypted>`），让用户清楚边界 */
  excluded: z.array(z.string().max(64)).max(32),
})
export type PrivacyExportResult = z.infer<typeof PrivacyExportResultSchema>

/** 彻底清除个人数据：必须显式给出确认串，避免误触 */
export const PrivacyWipeRequestSchema = z.object({
  confirm: z.literal('DELETE-ALL-PERSONAL-DATA'),
  /** 是否保留设置与供应商配置（默认保留；密钥文件始终单独确认） */
  keepSettings: z.boolean().default(true),
  /** 是否同时吊销（删除）已保存的密钥 */
  revokeKeys: z.boolean().default(false),
})
export type PrivacyWipeRequest = z.infer<typeof PrivacyWipeRequestSchema>

export const PrivacyWipeResultSchema = z.object({
  removedFiles: z.array(z.string().max(200)).max(64),
  removedBytes: z.number().int().min(0),
  /** 未被删除且**必须**向用户说明的东西 */
  kept: z.array(z.string().max(200)).max(64),
})
export type PrivacyWipeResult = z.infer<typeof PrivacyWipeResultSchema>

// ───────────────────────────────────────────────────────── M3 语音 / 屏幕 / 确认

/**
 * 语音状态（**只给状态与计数，绝不含识别正文**）。
 * `micActive` 是用户要求的"麦克风状态"的唯一读数来源。
 */
export const VoiceStatusSchema = z.object({
  available: z.boolean(),
  unavailableReason: z.string().max(300).nullable(),
  state: z.enum(['idle', 'listening', 'recognizing', 'stopped', 'error']),
  /** 是否正在使用麦克风 */
  micActive: z.boolean(),
  wakeWordEnabled: z.boolean(),
  wakeWord: z.string().max(20),
  lastWakeAt: z.number().nullable(),
  /** 最近一次识别的**长度**（不是内容） */
  lastTextChars: z.number().int().nullable(),
  lastTextAt: z.number().nullable(),
  recognizerCount: z.number().int().min(0),
  utteranceCount: z.number().int().min(0),
  lastError: z.string().max(300).nullable(),
})
export type VoiceStatus = z.infer<typeof VoiceStatusSchema>

export const VoiceConfigRequestSchema = z.object({
  wakeWordEnabled: z.boolean().optional(),
  wakeWord: z.string().max(20).optional(),
}).refine(v => v.wakeWordEnabled !== undefined || v.wakeWord !== undefined, { message: '至少要给出一个要修改的字段' })

/** 识别一句的入参/出参：**文本只在这次调用的返回值里出现**，不进日志、不进状态 */
export const VoiceListenRequestSchema = z.object({ timeoutMs: z.number().int().min(1000).max(60_000).default(16_000) })
export const VoiceListenResultSchema = z.object({
  ok: z.boolean(),
  /** 识别到的文本（可能为空 = 没听到有效内容） */
  text: z.string().max(2000),
  confidence: z.number().min(0).max(1),
  isWake: z.boolean(),
  reason: z.string().max(300).nullable(),
})

/** 语音事件（主进程 → renderer）：**只有事件与长度，没有识别正文** */
export const VoiceNoticeSchema = z.object({
  at: z.number(),
  kind: z.enum(['listening-started', 'listening-stopped', 'wake', 'utterance', 'error']),
  detail: z.string().max(200),
})
export type VoiceNotice = z.infer<typeof VoiceNoticeSchema>

/** 屏幕理解状态（**不含任何画面内容**） */
export const ScreenStatusSchema = z.object({
  permitted: z.boolean(),
  paused: z.boolean(),
  lastCaptureAt: z.number().nullable(),
  captureCount: z.number().int().min(0),
  excludeRegions: z.array(z.object({
    x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    w: z.number().min(0).max(1), h: z.number().min(0).max(1),
  })).max(16),
  redactSensitive: z.boolean(),
})
export type ScreenStatus = z.infer<typeof ScreenStatusSchema>

/** 截图前的提示（用户要求"截图前显示提示"） */
export const ScreenNoticeSchema = z.object({
  at: z.number(),
  region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  excludedBlocks: z.number().int().min(0),
  redacted: z.boolean(),
  detail: z.string().max(300),
})
export type ScreenNotice = z.infer<typeof ScreenNoticeSchema>

export const ScreenPauseRequestSchema = z.object({ paused: z.boolean() })

/** 目录白名单条目（**给 renderer 的只有 id 与末级目录名，没有完整路径**） */
export const FsAllowlistEntrySchema = z.object({
  id: z.string().max(64),
  /** 末级目录名（如 `Documents`）—— 足以让用户认出来，又不泄露完整路径 */
  label: z.string().max(120),
})
export const FsAllowlistSchema = z.object({
  entries: z.array(FsAllowlistEntrySchema).max(64),
  /** 敏感规则数量（让用户知道"有多少条硬拒绝规则"） */
  rules: z.object({ file: z.number().int().min(0), dir: z.number().int().min(0) }),
})
export const FsAllowDirRequestSchema = z.object({ path: z.string().min(1).max(1000) })
export const FsRevokeDirRequestSchema = z.object({ id: z.string().min(1).max(64) })

/**
 * 工具确认请求（主进程 → renderer）。
 * ⚠ **只给工具名、权限种类与参数摘要**（摘要本来就是哈希）——
 *   弹窗不需要、也不应该看到参数原文。
 */
export const ToolConfirmRequestSchema = z.object({
  confirmId: z.string().min(1).max(64),
  tool: z.string().max(64),
  permissionKind: z.string().max(40),
  paramsDigest: z.string().max(80),
  /** 面向用户的一句话（这个操作会做什么） */
  detail: z.string().max(300),
  /** 超时（毫秒）：超时视为拒绝 */
  timeoutMs: z.number().int().min(1000).max(120_000),
  at: z.number(),
})
export type ToolConfirmRequest = z.infer<typeof ToolConfirmRequestSchema>

export const ToolConfirmResultSchema = z.object({
  confirmId: z.string().min(1).max(64),
  approved: z.boolean(),
})

// ───────────────────────────────────────────────────────── 语音通话（M3 §2 全链路）

export const VoiceCallPhaseSchema = z.enum(['idle', 'listening', 'thinking', 'speaking', 'error'])
export type VoiceCallPhase = z.infer<typeof VoiceCallPhaseSchema>

/**
 * 通话状态（**不含任何识别内容或回复正文**）。
 * `silenceTurns` 是为了让"没反应"有解释：静音 vs 坏了必须能区分。
 *
 * ★ 2026-10-06（A4）新增 5 个字段，全部是**布尔与计数**，仍然不含任何正文。
 *   它们的存在是为了让"闭环接上了没有"可以被机械读出（而不是靠读源码或拿麦克风试）。
 *   ⚠ 带 `.default()` 是刻意的：旧证据文件里没有这些键，缺省化之后仍可解析 ——
 *     否则读取历史证据会直接抛错（本项目对"老数据必须还能读"有明确要求）。
 */
export const VoiceCallStateSchema = z.object({
  active: z.boolean(),
  phase: VoiceCallPhaseSchema,
  turn: z.number().int().min(0),
  turnsCompleted: z.number().int().min(0),
  lastHeardChars: z.number().int().nullable(),
  lastSpokeChars: z.number().int().nullable(),
  interruptions: z.number().int().min(0),
  silenceTurns: z.number().int().min(0),
  lastError: z.string().max(300).nullable(),
  startedAt: z.number().nullable(),
  /** 待机听唤醒是否在运行 */
  wakeWatchRunning: z.boolean().default(false),
  /** 最近一次识别到的字符数（**不是内容**） */
  lastRecognizedChars: z.number().int().nullable().default(null),
  /** 最近一次识别是否命中唤醒词 */
  lastWasWake: z.boolean().nullable().default(null),
  /** 累计被订阅到的识别次数（证明 `onRecognizedText` 那条线真的有人接） */
  recognizedCount: z.number().int().min(0).default(0),
  /** 因为**听到用户开口**而打断的次数（与"点按钮打断"分开计数） */
  bargeInInterruptions: z.number().int().min(0).default(0),
})
export type VoiceCallState = z.infer<typeof VoiceCallStateSchema>

/** 闭环读数（`voice:loop-status`）——**只有布尔与计数** */
export const VoiceLoopStatusSchema = z.object({
  bridgeInstalled: z.boolean(),
  wakeWatchRunning: z.boolean(),
  bargeInEnabled: z.boolean(),
  recognizedCount: z.number().int().min(0),
  bargeInInterruptions: z.number().int().min(0),
  stages: z.object({
    listen: z.boolean(),
    think: z.boolean(),
    speak: z.boolean(),
    activate: z.boolean(),
  }),
})
export type VoiceLoopStatus = z.infer<typeof VoiceLoopStatusSchema>

/** 待机听唤醒开关请求 */
export const VoiceWakeWatchRequestSchema = z.object({ enabled: z.boolean() })
export type VoiceWakeWatchRequest = z.infer<typeof VoiceWakeWatchRequestSchema>

/**
 * 通话事件（主进程 → renderer）。
 * ⚠ `replyText` 是**唯一**承载回复正文的字段：它只用于气泡显示，
 *   由 `voice-call.ts` 的 notice 提供，且**不写日志**（日志只记长度）。
 */
export const VoiceCallNoticeSchema = z.object({
  at: z.number(),
  kind: z.enum([
    'call-started', 'call-stopped', 'heard', 'silence', 'thinking', 'speaking', 'interrupted', 'error',
    // ★ 2026-10-06（A4）闭环相关的事件类型
    'wake-activated', 'wake-watch-started', 'wake-watch-stopped', 'wake-watch-ignored', 'barge-in',
  ]),
  detail: z.string().max(200),
  replyText: z.string().max(8000).optional(),
})
export type VoiceCallNotice = z.infer<typeof VoiceCallNoticeSchema>

// ───────────────────────────────────────────────────────── 出网目标校验（SSRF 兜底）

export interface EgressTargetVerdict {
  ok: boolean
  reason: 'ok' | 'bad-url' | 'insecure-url' | 'blocked-host' | 'blocked-ip' | 'blocked-port'
  /** 已脱敏说明 */
  detail: string
  host: string
}

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
]

/**
 * 判断一个供应商 `baseUrl` 是否允许主进程出网（**唯一实现**，主进程与单测共用）。
 *
 * 规则：
 *   · 只允许 `https:`；例外：环回主机（`localhost` / `127.0.0.1` / `::1`）允许 `http:`
 *     —— 本地 Ollama 的常见形态；
 *   · 拒绝内网 / 链路本地 / 保留网段（环回例外之外）；
 *   · 拒绝 URL 里带用户名密码；
 *   · 拒绝**公网**目标上的非常规端口（只允许 443/80），避免把密钥发到奇怪的服务。
 *
 * 注意：这里只做**字面量**判定，不做 DNS 解析 —— DNS 重绑定不在本层职责内；
 * 出网侧另有 `redirect:'error'` 兜底（不跟随重定向 ⇒ 密钥不会被带到第三方主机）。
 */
export function checkEgressTarget(rawUrl: string): EgressTargetVerdict {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'bad-url', detail: 'URL 解析失败', host: '' }
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (u.username || u.password) {
    return { ok: false, reason: 'blocked-host', detail: 'URL 中不得包含用户名或密码', host }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: 'insecure-url', detail: `不支持的协议：${u.protocol}`, host }
  }
  if (u.protocol === 'http:' && !loopback) {
    return { ok: false, reason: 'insecure-url', detail: '非环回目标必须使用 https', host }
  }
  if (!loopback) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      return PRIVATE_V4.some(re => re.test(host))
        ? { ok: false, reason: 'blocked-ip', detail: '目标是内网地址', host }
        // 公网 IP 字面量：允许，但仍受端口限制（下面统一判）
        : checkPort(u, host)
    }
    if (host.includes(':')) {
      return { ok: false, reason: 'blocked-ip', detail: '不接受公网 IPv6 字面量目标', host }
    }
    return checkPort(u, host)
  }
  return { ok: true, reason: 'ok', detail: 'ok', host }
}

function checkPort(u: URL, host: string): EgressTargetVerdict {
  const port = u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port)
  if (port !== 443 && port !== 80) {
    return { ok: false, reason: 'blocked-port', detail: `公网目标只允许 443/80，收到 ${port}`, host }
  }
  return { ok: true, reason: 'ok', detail: 'ok', host }
}

// ───────────────────────────────────────────────────────── 动作清单

/**
 * 动作 clip 清单（sidecar）。
 *
 * ⚠ **这是与 `tools/motion-lab/convert-anim.mjs` 产出的 sidecar 对齐后的契约**。
 *   早期我在这里自造了一套字段名（`id`/`semantic`/`durationSec`/`boneTravel`…），
 *   结果管线产出的 16 份清单**全部 schema 校验失败**（实测日志：
 *   `idle_pet_idle.json: schema 校验失败`），动作只能靠"按文件名直接加载"绕过去 ——
 *   这是双契约并存，属于我自己造成的债务，这里按**管线的真实产物**收敛为一份。
 *   校验通过后 `manifests` 才会有内容，动作的 loop / 叠加层许可 / 活动量才真正生效。
 */
export const MotionClipManifestSchema = z.object({
  /** sidecar 格式版本（管线写的是 `motion-clip-manifest/1`） */
  schema: z.string().max(64).optional(),
  /** clip 名（= `.vrma` 文件名去掉扩展名），**唯一标识** */
  name: z.string().min(1).max(120),
  /** 稳定 slug（管线给的小写下划线名） */
  slug: z.string().max(120).optional(),
  /** 所属集合（`idle` / `misc` / `sitting` …），等价于早期设计里的 semantic */
  set: z.string().max(40).optional(),
  /** 源 `.anim` 绝对路径（可追溯） */
  source: z.string().max(400),
  /** 源 `.anim` 相对路径 */
  sourceRelative: z.string().max(400).optional(),
  /** 源字节数 */
  sourceBytes: z.number().int().nonnegative().optional(),
  /** 内嵌的 clip 名（可能是字符串，也可能是 `{name,frameCount,...}` 结构） */
  clip: z.union([z.string().max(200), z.record(z.string(), z.unknown())]).optional(),
  /** 产出的 `.vrma`（可能是相对路径字符串，也可能是 `{path,bytes,sha256}` 结构） */
  vrma: z.union([z.string().max(400), z.record(z.string(), z.unknown())]).optional(),
  /** 时长（秒） */
  duration: z.number().nonnegative(),
  /** 是否可无缝循环（可能是布尔，也可能是 `{seamless,poseDelta,...}` 结构） */
  loopable: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
  loop: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
  /** 根位移范围（对象 / 三元数组 / 结构化对象都容忍） */
  rootDisplacement: z.unknown().optional(),
  /**
   * **根位移策略**（本轮新增；见 `docs/evidence/phase3/INTERACTION-ROOT-CAUSE.md` §3.3）。
   *
   * 背景：Mate 的 `.anim` 里 `RootT.x` 是一个**与身高同量级的常量**（实测 idle 系列
   * `rest.x ≈ 0.965–1.16`），而 three-vrm 会按 `modelRestHipsY / animationRestHipsY`
   * 把它放大（实测 ≈ 4.85×）⇒ 角色被推到 x ≈ −4.6 m，**完全跑出视锥**。
   *
   * 三种策略（在**装载时**改写 hips 平移轨道，不改资产字节）：
   *   · `none`       根位移**完全钉死**在模型 rest 位置（x/y/z 都不动）；
   *   · `inPlace`    横向钉死，保留纵向起伏（原地动作）；
   *   · `locomotion` 横向按"相对本 clip 起始姿势"的位移播放（行走）。
   *
   * 缺省由 `manifestRootMotionMode()` 按 `set` 推断，**默认 `none`**
   * （安全侧：宁可少动，也不能让角色跑出画布）。
   */
  rootMotionMode: z.enum(['none', 'inPlace', 'locomotion']).optional(),
  /** 逐骨总角行程（度） */
  perBoneActivityDeg: z.record(z.string(), z.number()).optional(),
  /** 腿活动量（度），可能是数字或结构化对象 */
  legActivity: z.union([z.number(), z.record(z.string(), z.unknown())]).optional(),
  /** 允许叠加的层 */
  allowedOverlayLayers: z.array(z.string().max(32)).max(16).optional(),
  /** 曲线统计（原样保留，便于诊断） */
  curveStats: z.record(z.string(), z.unknown()).optional(),
  warnings: z.array(z.string().max(300)).max(50).optional(),
  outOfRangeMuscles: z.array(z.unknown()).max(200).optional(),
  /** 未验证项（管线自报） */
  unverified: z.array(z.string().max(300)).max(50).optional(),
  /** 兼容字段：早期 schema 用过 `id` / `bytes` / `sha256` 等 */
  id: z.string().max(120).optional(),
  bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().max(64).optional(),
})
export type MotionClipManifest = z.infer<typeof MotionClipManifestSchema>

/**
 * 取清单里的**唯一标识**：优先 `name`，回退 `slug` / 旧字段 `id`。
 * 所有消费方都必须用这个函数，避免各处各取一套字段。
 */
export function manifestClipId(m: MotionClipManifest): string {
  return m.name || m.slug || m.id || ''
}

/** 取语义集合名（早期叫 semantic）。数组形态也容忍。 */
export function manifestSemantic(m: MotionClipManifest): string {
  const legacy = (m as unknown as { semantic?: unknown }).semantic
  if (typeof legacy === 'string' && legacy) return legacy
  if (Array.isArray(legacy) && legacy.length) return String(legacy[0])
  return m.set ?? ''
}

/** 根位移策略（见 `MotionClipManifestSchema.rootMotionMode`） */
export type MotionRootMotionMode = 'none' | 'inPlace' | 'locomotion'

/**
 * 解析 clip 的根位移策略。
 *
 * 缺省规则（**保守**）：只有明确的行走/位移类动作才允许横向位移，
 * 其余一律 `none` —— 因为 `none` 是唯一能保证"角色常驻舞台锚点"的策略。
 * 判断依据同时看 `set` 与 clip 名，任一处命中"walk/run/locomotion/move"即为行走。
 */
export function manifestRootMotionMode(m: MotionClipManifest): MotionRootMotionMode {
  if (m.rootMotionMode) return m.rootMotionMode
  const s = `${manifestSemantic(m)} ${m.name ?? ''} ${m.slug ?? ''}`.toLowerCase()
  if (/(walk|run|locomotion|move)/.test(s)) return 'locomotion'
  return 'none'
}

// ───────────────────────────────────────────────────────── 旧实例

export const LegacyHitSchema = z.object({
  kind: z.enum(['mate-engine-kernel', 'legacy-pet', 'legacy-brain', 'legacy-bridge', 'legacy-airi-combo']),
  pid: z.number().int(),
  imagePath: z.string().max(400),
  commandLine: z.string().max(1200).optional(),
  hasVisibleWindow: z.boolean(),
  windowTitle: z.string().max(200).nullable(),
  reason: z.string().max(300),
  blocking: z.boolean(),
})
export type LegacyHit = z.infer<typeof LegacyHitSchema>

export const LegacyScanResultSchema = z.object({
  checkedAt: z.number(),
  hits: z.array(LegacyHitSchema),
  blocked: z.boolean(),
})
export type LegacyScanResult = z.infer<typeof LegacyScanResultSchema>
