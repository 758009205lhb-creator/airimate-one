/**
 * @airimate/shared/settings —— 设置、窗口几何、常量（唯一真源）
 */
import { z } from 'zod'
import { OnboardingStepSchema } from './proactive.js'

export const APP_ID = 'com.airimate.one'
export const APP_NAME = 'AiriMate One'
export const APP_PROTOCOL = 'app'
/** 命名互斥量（Windows 会话级，带 Local\ 前缀避免跨会话冲突） */
export const SINGLETON_MUTEX = 'Local\\AiriMateOne.Singleton'

/** 版本：从 package.json 注入，运行时由 main 覆盖 */
export const CONTRACT_VERSION = '1.0.0'

export const WindowModeSchema = z.enum(['panel', 'pet'])
export type WindowMode = z.infer<typeof WindowModeSchema>

export const RectSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})
export type Rect = z.infer<typeof RectSchema>

/**
 * 窗口几何（冻结）。
 * ⚠ pet 模式宽高**不可变**（拖拽期间窗口尺寸不能变化，判据 A14）；panel 模式可记忆。
 * ⚠ 窗口始终以 transparent:true + frame:false 创建（Electron 不支持运行时切换这两项），
 *    panel 模式用不透明 CSS 背景填满 ⇒ 两种模式共用同一个 window/renderer/Scene/VRM。
 */
export const WINDOW_GEOMETRY = {
  pet: { width: 340, height: 420 },
  /**
   * panel 宽度定在 480：420 时舞台只剩 150px（面板 268 + 边框），
   * 导致轮盘被自适应压到半径 56、选项间距很紧、最右两项贴窗口边（实测截图）。
   * 480 让舞台拿到 ~210px，轮盘可回到半径 ~72 的舒适尺寸。
   */
  panel: { width: 480, height: 760 },
  panelMin: { width: 380, height: 520 },
  /**
   * ★★ **chat**：**独立对话窗口**的几何（2026-10-08 返工轮，取代已删除的 `conversation`）。
   *
   * 历史与根因（必须留着，否则会有人再犯一次）：
   *   上一轮把对话框做成了 pet 窗口内部贴底的 dock，并把 pet 窗口从 340×420 放大到
   *   380×560（即下面这个 `conversation` 尺寸）来腾地方。用户明确否决该形态：
   *   **聊天对话框与桌宠必须是两个完全独立的 BrowserWindow，不能被塞进同一个面板**。
   *   ⇒ `WINDOW_GEOMETRY.conversation` 已**删除**，pet 尺寸**恒定 340×420**，
   *     "打开对话就放大 pet 窗口"的逻辑（`enterConversationLayout`）也已**删除**。
   *
   * 数值依据（照抄参考实现 DockPetWin 的 `AgentChatWindow.xaml`，那是用户视频里的同角色形态）：
   *   `Width=720 / Height=560 / MinWidth=560 / MinHeight=420`。
   *   720×560 的对话区：滚动区约 430px 高（中文 14px/1.6 约 19 行），底部单行输入不挤。
   */
  chat: { width: 720, height: 560 },
  chatMin: { width: 560, height: 420 },
} as const

export const AppSettingsSchema = z.object({
  version: z.literal(1),
  mode: WindowModeSchema.default('panel'),
  alwaysOnTop: z.boolean().default(true),
  autoStart: z.boolean().default(false),
  /** 无障碍：降低动效（待机轮换仍进行，但禁用大幅动作与摇晃） */
  reducedMotion: z.boolean().default(false),
  /** 面板模式的窗口几何（记忆） */
  panelBounds: RectSchema.nullable().default(null),
  /** 桌宠模式的窗口位置（记忆；尺寸固定） */
  petPosition: z.object({ x: z.number().int(), y: z.number().int() }).nullable().default(null),
  /**
   * ★ 独立对话窗口（chat）的记忆几何。
   *
   * ⚠ **必须写进 schema**：`mergeSettings()` 用 `AppSettingsSchema.parse()` 重建整个对象，
   *   没在这里声明的字段会被 zod **静默丢掉**（本项目反复踩过的契约漂移）。
   * 语义：`null` = **从未打开过** ⇒ 首次打开时在"鼠标所在显示器的工作区"居中；
   *       非 null = 用户上次的矩形，重启后恢复；若该矩形已不在任何显示器可见区内则回落到居中。
   */
  chatWindowBounds: RectSchema.nullable().default(null),
  /**
   * 对话窗口是否置顶。
   * 默认 `false`：它是一个**普通可选窗口**（`skipTaskbar:false`，能在任务栏找到、能被别的窗口盖住），
   * 不像 pet 窗口那样常驻置顶 —— 否则用户切到别的应用打字时会被它挡住。
   */
  chatWindowAlwaysOnTop: z.boolean().default(false),  /**
   * ★★ **桌宠是否常驻**（2026-10-09 完善轮新增；默认 **`false`**）。
   *
   * ⚠ **必须写进 schema**：`mergeSettings()` 用 `AppSettingsSchema.parse()` 重建整个对象，
   *   没在这里声明的字段会被 zod **静默丢掉**（本项目反复踩过的契约漂移）。
   *
   * 语义（**只决定"启动时显示不显示"，与"现在可见不可见"是两件事**）：
   *   · `false`（默认，非常驻）：应用启动（含开机自启）**不显示桌宠窗口**；
   *     桌宠只在被"呼出"时出现（托盘 / 对话窗口菜单栏 / 桌宠常驻勾选 / 快捷键）。
   *   · `true`（常驻）：应用启动即显示桌宠并保持（= 2026-10-08 之前那一版的行为）。
   *
   * ⚠ 「收回桌宠」**不写这个字段**：收回是"这一次不想看见她"，
   *   不是"以后都不要她"。把两者混成一个字段会让用户无法表达
   *   "常驻，但我现在先收起来一会儿"——而这个组合恰恰是最常用的。
   */
  petResident: z.boolean().default(false),
  /**
   * ★★ **启动时是否打开对话窗口**（2026-10-09 完善轮新增；默认 **`true`**）。
   *
   * 组合效果（就是用户要的那条）：
   *   | petResident | startupOpenChat | 启动后看到什么 |
   *   |---|---|---|
   *   | false（默认） | true（默认） | **只有对话窗口**，没有桌宠 ← 新的默认行为 |
   *   | true | true | 对话窗口 + 桌宠 |
   *   | false | false | 什么都没有，**只留托盘图标** |
   *   | true | false | 只有桌宠（= 2026-10-08 之前的行为） |
   *
   * ⚠ 旧行为（"打开软件就自动出现桌宠"）**不再存在**：它既不是默认，也没有任何
   *   开关能把它单独恢复成"启动只有桌宠"以外的形态 ——
   *   要恢复旧观感请设 `petResident=true` + `startupOpenChat=false`。
   */
  startupOpenChat: z.boolean().default(true),
  avatarId: z.string().max(64).default('lazuli'),
  ttsEnabled: z.boolean().default(false),
  ttsProviderId: z.string().max(64).nullable().default(null),
  ttsVoice: z.string().max(64).nullable().default(null),
  hearingEnabled: z.boolean().default(false),
  bubbleEnabled: z.boolean().default(true),
  chatModel: z.string().max(120).nullable().default(null),
  systemPersonaId: z.string().max(64).default('default'),
  /**
   * 帧率上限。**默认 90 而不是 60** —— 依据 A16 的实测判定：
   *   · `--fps-cap 60` 实测稳定在 **49.4**（低于 ≥50 门槛）；
   *   · `--fps-cap 120` 实测 **82 fps**（`fps5s` 82.2–83.2）。
   *   ⇒ 渲染成本充足，瓶颈是"60 上限 + 兜底泵间隔与 vsync 错位"导致的整帧跳过。
   *   抬到 90 后实测 50–54，稳定越过判据门槛；功耗可控（空闲时角色静止，GPU 占用低）。
   *   用户仍可在设置里改（15–240）。
   */
  fpsCap: z.number().int().min(15).max(240).default(90),
  /**
   * **显式角色缩放**（唯一允许改变角色大小的入口）。
   *
   * 规格（本轮）：缩放**只能**由设置/缩放控件修改；
   * 单击、拖动、轮盘开合、动作切换、窗口 resize 一律不得改变它。
   * 范围 0.70–1.40（步进 0.05 由 UI 负责），因为它绕**固定锚点**缩放，
   * 投影中心不动 ⇒ 中心点与底部基线保持不变。
   */
  avatarScale: z.number().min(0.70).max(1.40).default(1),
  locale: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
  /** 首次运行向导是否完成（密钥、人设） */
  onboarded: z.boolean().default(false),
  /** 用户对"忽略旧实例告警"的显式选择（记录以便审计） */
  legacyAcknowledged: z.array(z.string().max(120)).default([]),

  // ── M1 配置闭环
  /**
   * 不活跃多少分钟后"停止生成"（毫秒）。
   * 0 = 关闭该保护。默认 120s：模型卡死时用户不必干等（流式无增量即视为不活跃）。
   */
  chatIdleAbortMs: z.number().int().min(0).max(600_000).default(120_000),
  /** 聊天面板最多渲染多少条历史（加载更多由按钮触发） */
  chatHistoryLimit: z.number().int().min(20).max(1000).default(200),
  /** 遥测（**默认关闭**，用户要求；关闭时不发送任何数据，只保留本地日志） */
  telemetryEnabled: z.boolean().default(false),
  /** 是否在启动时自动打开首次运行向导（未完成时） */
  onboardingAutoStart: z.boolean().default(true),

  // ── M2 主动陪伴：能力总开关（全部可关；用户要求"可关闭开关"）
  proactiveEnabled: z.boolean().default(true),
  greetingEnabled: z.boolean().default(true),
  scheduleBriefEnabled: z.boolean().default(true),
  morningRadioEnabled: z.boolean().default(true),
  morningRadioAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('08:30'),
  /** 早安电台是否朗读（默认朗读；静音时段会被引擎拦下） */
  morningRadioSpeak: z.boolean().default(true),
  continuousReminderEnabled: z.boolean().default(true),
  sedentaryReminderEnabled: z.boolean().default(true),
  nightReminderEnabled: z.boolean().default(true),
  /** 用户手动静默模式（引擎据此把一切主动行为降级为"进队列"） */
  userSilent: z.boolean().default(false),
  /** 活动采样的开关（关闭后不读前台窗口，只留很粗的空闲读数） */
  activitySamplingEnabled: z.boolean().default(true),
  /** 是否把前台窗口标题摘要纳入活动统计（**默认关闭**；开启也只存哈希与长度） */
  activityTitleDigestEnabled: z.boolean().default(false),

  // ── M2 地点（天气需要；空 = 不播报天气，如实标注"未配置城市"）
  weatherCity: z.string().max(80).default(''),
  /** 天气服务（Open-Meteo 无需密钥）；空 = 关闭天气 */
  weatherEndpoint: z.string().max(300).default('https://api.open-meteo.com/v1/forecast'),
  /** 城市地理编码端点（Open-Meteo geocoding） */
  geocodeEndpoint: z.string().max(300).default('https://geocoding-api.open-meteo.com/v1/search'),

  // ── M4 自学习（M2 阶段只落开关与状态；默认关闭，用户要求"支持关闭自学习"）
  selfLearningEnabled: z.boolean().default(false),
  selfLearningAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('22:30'),

  // ── M3 语音（用户硬要求："语音唤醒默认关闭"、"启用后必须显示麦克风状态与一键停用"）
  /**
   * ⚠ `hearingEnabled`（上面已有的字段）在 M3 获得明确语义：
   *   **语音识别总开关**，默认 `false`。它是 `voice:listen-once` 的前置条件 ——
   *   关着时 renderer 调识别会被**直接拒绝**，而不是"悄悄把麦克风打开"。
   *   这一条是"不做后台偷听"在代码里的落点。
   */
  /** 语音唤醒（默认关闭；独立于识别总开关，两者都要开才会听） */
  wakeWordEnabled: z.boolean().default(false),
  /** 唤醒词（≤20 字；太短会误触发） */
  wakeWord: z.string().max(20).default('你好助手'),
  /** 是否已向用户展示过录音与隐私提示（用户要求"明确的录音和隐私提示"） */
  voicePrivacyNoticeShown: z.boolean().default(false),
  /** 单句识别的超时（毫秒） */
  voiceListenTimeoutMs: z.number().int().min(1000).max(60_000).default(16_000),
  /**
   * ★ 说话时允许用户**开口打断**（barge-in，2026-10-06 随 A4「做闭环」加入）。
   *
   * ⚠ **默认 `false`，这是刻意的**：开了之后她说话期间麦克风是活的，
   *   扬声器的声音**可能被自己的麦克风收进去** ⇒ 自己把自己打断。
   *   这个风险取决于设备/音量/回声消除，**代码里无法保证不发生** ⇒
   *   不替用户默认打开，而是让用户知情后显式开启。
   *   （对照：不点按钮的那条"听"通路本来就是开的，代价是 `hearingEnabled` 必须为真。）
   */
  voiceBargeIn: z.boolean().default(false),
  /** 是否已向用户说明过开启 barge-in 的代价（回授自打断）—— 只提示一次，不反复打扰 */
  voiceBargeInNoticeShown: z.boolean().default(false),

  // ── M3 屏幕理解（按需触发，**不持续录屏**）
  /** 截图前是否显示提示（默认开） */
  screenNoticeEnabled: z.boolean().default(true),
  /** 截图是否做敏感信息脱敏（默认开） */
  screenRedactSensitive: z.boolean().default(true),

  // ── ★ 对话（2026-10-06 本轮：左栏文字聊天 → 桌宠对话框 + 语音说话）
  /**
   * 全局快捷键：唤醒 / 收起桌宠对话。
   *
   * ⚠ 它**必须写进 schema**（而不是只在主进程里有个常量）：`mergeSettings()` 用
   *   `AppSettingsSchema.parse()` 重建整个对象 —— 没在这里声明的字段会被 zod **静默丢掉**，
   *   表现为"设置面板里改了、重启后又是默认值"（本项目反复踩过的契约漂移）。
   * 语法为 Electron `globalShortcut` 的 accelerator；注册失败（被别的软件占用）**必须可见报错**，
   * 绝不静默失效（见 main 的 `conversation.ts`）。
   */
  conversationHotkey: z.string().min(1).max(64).default('Ctrl+Alt+Space'),
  /** 是否注册上面的全局快捷键（默认开；用户可关，关掉后不再占用系统热键） */
  conversationHotkeyEnabled: z.boolean().default(true),
  /**
   * 气泡在**朗读结束**后自动消失的秒数（1–30，默认 3）。
   * 鼠标悬停会暂停倒计时；点击气泡展开全文时也不消失。
   */
  bubbleAutoHideSec: z.number().min(1).max(30).default(3),
  /**
   * 是否已经问过"对话以语音为主，是否开启朗读？"。
   *
   * 为什么要有它：进入对话时若 `ttsEnabled=false`，规格要求**弹一次明确确认**
   * （不许静默激活、也不许静默不出声）。问过之后不再打扰（无论用户当时选了是还是否），
   * 但**不代替用户写入启用** —— 只有用户点"开启"才写 `ttsEnabled=true`。
   */
  conversationAutoTtsConfirmed: z.boolean().default(false),
  /**
   * 首次运行向导的进度。
   *
   * ⚠ 放在 `settings.json` 里、并**写进 schema**：`mergeSettings()` 会用
   *   `AppSettingsSchema.parse()` 重建整个对象 —— 未在 schema 里声明的字段会被
   *   zod 静默丢掉（本项目反复踩过"契约漂移导致字段静默消失"）。
   */
  onboarding: z.object({
    step: OnboardingStepSchema.default('provider'),
    completedAt: z.number().nullable().default(null),
    lastTestOk: z.object({
      providerId: z.string().max(64),
      at: z.number(),
      code: z.string().max(32),
    }).nullable().default(null),
  }).default({}),
})
export type AppSettings = z.infer<typeof AppSettingsSchema>

export const DEFAULT_SETTINGS: AppSettings = AppSettingsSchema.parse({ version: 1 })

/** VRMA 运行时参数（照抄 Mate，见 Tech-Spec §6.3；不得随手改） */
export const MOTION_TUNING = {
  idleSwitchSec: 12,
  idleTransitionSec: 3,
  dragFadeInSec: 0.18,
  dragFadeOutSec: 0.25,
  springFrequency: 2.6,
  dampingRatio: 0.35,
  maxLeanZDeg: 25,
  maxLeanXDeg: 12,
  limbLag: 6,
  horizontalVelocityToLean: 0.25,
  verticalVelocityToPitch: 0.15,
  mouseSensitivity: 0.6,
  leanFilterPerSec: 12,
  blendSpeed: 8,
} as const

/**
 * **临时屏蔽的动作语义**（用户 2026-09-27 决定，方案 C）。
 *
 * 为什么屏蔽（有据可查）：`sleeping_pet_sleeping` 的 hips 平移在 three-vrm 的
 * `modelRestHipsY / animationRestHipsY`（=0.834 / 0.09546 ≈ 8.7×）放大后，
 * 行程达到 **y 4.53 m / z 10.30 m** —— 荒谬值，无法播放。本轮把根位移按策略钉死后，
 * 该 clip 的"躺下"分量丢失 ⇒ 呈现的是**站姿抱臂**（截图 `clipPoses-clip-sleep.png`），
 * 也就是一个**明显不对的姿态**。与其给用户看错姿态，不如先摘掉。
 *
 * ⚠ **这是一处临时措施，不是设计**。恢复条件与步骤：
 *   1. 资产侧重新导出 `sleeping_pet_sleeping.vrma`（归一化 `RootT`，让"躺下"
 *      落在关节旋转或**合理量级**的根位移上）；
 *   2. 从本数组里删掉 `'sleep'`；
 *   3. 把 `packages/shared/src/settings.ts` 的 `WHEEL_SPEC.items` 里
 *      `{ id: 'sleep', label: '休眠', icon: 'sleep', kind: 'action' }` 放回；
 *   4. 把 `apps/desktop/src/main/session-store.ts` 人设提示词里的 `[motion:sleep]` 放回；
 *   5. 重跑 `pwsh -File tools/qa/run-probe.ps1 -Name clipPoses`，
 *      期望 sleep 的 `accepted` 由 `false` 变回 `true` 且角色仍在画布内。
 *
 * 屏蔽点只有一处（`Stage.requestMotion`）⇒ 轮盘、聊天 Act 标记、探针三条入口同时生效。
 */
export const DISABLED_MOTION_SEMANTICS: readonly string[] = ['sleep']

/** 轮盘参数（冻结；判据 A10 依赖它） */
export const WHEEL_SPEC = {
  radiusPx: 104,
  hubRadiusPx: 44,
  startAngleDeg: -90,
  /** 从 scale=0 弹开：每帧 lerp(scale, target, 0.2) */
  scaleLerpPerFrame: 0.2,
  scaleEpsilon: 0.001,
  /** 锚点：角色包围盒上沿的 30% 处（贴着她，不挡脸） */
  anchorRatioY: 0.30,
  /** 命中测试外扩 */
  hitPadPx: 24,
  items: [
    /**
     * ★ 轮盘「对话」项（id 保持 `chat` 不变 —— **契约稳定**：探针、单测、历史证据都按 id 引用）。
     *
     * 行为（2026-10-08 返工轮定稿）：**打开并聚焦独立的 chat 窗口**。
     *   · **不**切 panel 模式（那是旧旧行为）、**不**放大 pet 窗口（那是上一轮的错误行为）；
     *   · `kind` 从 `'toggle'` 改回 **`'action'`**：因为"再次触发只聚焦、绝不隐藏"
     *     （见 `docs/Acceptance-Matrix.md` 的入口语义判据），它不再是一个有开/关两态的项目 ——
     *     留成 toggle 会让轮盘画出一个永远"已开"的勾，反而误导。
     *   · 五个入口（轮盘 / 托盘 / 快捷键 / 双击 / 唤醒词）语义**完全一致**：show + focus；
     *     隐藏只走「×」/ Esc / 托盘「结束对话」/ `conversation:close`。
     */
    { id: 'chat', label: '对话', icon: 'chat', kind: 'action' },
    { id: 'hearing', label: '听力', icon: 'hearing', kind: 'toggle' },
    { id: 'speaker', label: '扬声器', icon: 'speaker', kind: 'toggle' },
    { id: 'avatar', label: '角色', icon: 'avatar', kind: 'panel' },
    { id: 'settings', label: '设置', icon: 'settings', kind: 'panel' },
    { id: 'center', label: '居中', icon: 'center', kind: 'action' },
    { id: 'alwaysOnTop', label: '置顶', icon: 'pin', kind: 'toggle' },
    /**
     * ⛔ **`sleep`「休眠」项已临时摘除**（见 `DISABLED_MOTION_SEMANTICS` 的说明）。
     *    恢复时把下面这行放回即可：
     *    { id: 'sleep', label: '休眠', icon: 'sleep', kind: 'action' },
     */
  ],
} as const
export type WheelItemId = (typeof WHEEL_SPEC.items)[number]['id']

/** 17 根必需骨骼（转换产物与运行时都必须绑定成功；判据 A12 的采样集合包含腿部 4 根） */
export const REQUIRED_BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot',
  'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand',
] as const
export type RequiredBone = (typeof REQUIRED_BONES)[number]

/** 腿部骨骼（判据 A12：任意 5 秒采样内必须有运动） */
export const LEG_BONES = ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'] as const

/** 动作资产目录（本地，不进分发包） */
export const MOTION_DIR = 'assets/motion'
export const MOTION_MANIFEST_DIR = 'assets/motion/manifests'
