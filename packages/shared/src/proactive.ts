/**
 * @airimate/shared/proactive —— M2 主动陪伴引擎的**数据模型与契约**（唯一真源）
 *
 * 本文件只依赖 zod，**不 import 其它 shared 模块** —— 这是刻意的：
 * `ipc.ts` 会因为契约聚合而 import 本文件，若本文件再反向 import `ipc.ts`
 * 就会形成 ESM 循环，且 zod schema 在模块求值期构造 ⇒ 极易踩 TDZ 初始化顺序坑。
 * 需要引用 `StageCommand` / `Alert` 等类型的地方一律用 `import type`（编译期擦除，运行期无环）。
 *
 * 纪律（用户要求 + Tech-Spec §7）：
 *   · 所有新增配置都要在这里有 zod schema，并注册进 IPC 白名单（两侧校验）；
 *   · **不做**持续录屏、键盘内容记录、后台偷听、不可见自动化；
 *   · 提醒必须有冷却、开关与三级优先级；被阻断时必须进队列而不是丢掉。
 */
import { z } from 'zod'

// ───────────────────────────────────────────────────────── 首次运行向导（M1）

/**
 * 向导步骤。
 *
 * ⚠ 定义在本文件（而不是 `ipc.ts`）是有原因的顺序约束：
 *   `settings.ts` 的 `AppSettingsSchema.onboarding.step` 需要这个枚举，
 *   而 `ipc.ts` 需要 `settings.ts` —— 若枚举定义在 `ipc.ts` 就会形成
 *   `ipc → settings → ipc` 的 ESM 循环，zod schema 在模块求值期构造 ⇒ TDZ 崩。
 *   放这里（无反向依赖）三者都是单向的。
 */
export const OnboardingStepSchema = z.enum([
  'provider',    // 供应商配置
  'test',        // 连接测试
  'model',       // 选择模型
  'persona',     // 称呼 / 人设 / 声音
  'permission',  // 权限确认
  'schedule',    // 日程与隐私
  'done',
])
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>

/** 向导进度与判据（主进程写，renderer 只读） */
export const OnboardingStateSchema = z.object({
  step: OnboardingStepSchema.default('provider'),
  completedAt: z.number().nullable().default(null),
  /** 已通过连接测试的供应商 id 与时间（向导"测试"步骤的判据） */
  lastTestOk: z.object({
    providerId: z.string().max(64),
    at: z.number(),
    code: z.string().max(32),
  }).nullable().default(null),
})
export type OnboardingState = z.infer<typeof OnboardingStateSchema>

/**
 * 向导状态。**每一步是否满足由主进程判定**（不看 renderer 自报）——
 * 否则一个前端 bug 就能让用户带着"没验证过的配置"进入日常使用。
 */
export const OnboardingStatusSchema = z.object({
  state: OnboardingStateSchema,
  satisfied: z.object({
    provider: z.boolean(),
    test: z.boolean(),
    model: z.boolean(),
    persona: z.boolean(),
    permission: z.boolean(),
    schedule: z.boolean(),
  }),
  /** 当前被阻塞的步骤（null = 可以继续） */
  blockedBy: OnboardingStepSchema.nullable(),
  /** 面向用户的一句话说明（已脱敏） */
  hint: z.string().max(300),
  completed: z.boolean(),
})
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>

export const OnboardingSetStepSchema = z.object({ step: OnboardingStepSchema })
export const OnboardingCompleteSchema = z.object({ completed: z.boolean().default(true) })

// ───────────────────────────────────────────────────────── 公共枚举

/** 三级优先级：用户要求"重要 / 普通 / 静默" */
export const PrioritySchema = z.enum(['important', 'normal', 'silent'])
export type Priority = z.infer<typeof PrioritySchema>

/** 提醒的处置策略（比优先级更细，用于 UI 与审计解释"为什么没弹"） */
export const NotifyPolicySchema = z.enum(['popup', 'queue', 'inbox-only'])
export type NotifyPolicy = z.infer<typeof NotifyPolicySchema>

/**
 * 提醒种类。
 *   · `scheduled`     用户显式设定的定时提醒（/提醒 09:00 开会）
 *   · `continuous`    连续使用电脑提醒（默认 50 分钟）
 *   · `sedentary`     久坐提醒（活动量不足）
 *   · `night`         夜间休息提醒（默认 23:30 后）
 *   · `custom`        由用户手输的任意提醒
 */
export const ReminderKindSchema = z.enum(['scheduled', 'continuous', 'sedentary', 'night', 'custom'])
export type ReminderKind = z.infer<typeof ReminderKindSchema>

export const ReminderStateSchema = z.enum(['pending', 'queued', 'fired', 'done', 'cancelled', 'failed'])
export type ReminderState = z.infer<typeof ReminderStateSchema>

/** 阻断原因（引擎把"为什么没送达"如实写进审计） */
export const BlockReasonSchema = z.enum([
  'none',            // 未被阻断
  'quiet-hours',     // 静音时段
  'fullscreen',      // 全屏应用 / 演示
  'game',            // 游戏
  'meeting',         // 会议（摄像头/麦克风被占用、会议进程）
  'focus',           // 专注模式（系统"助手专注" / 用户手动）
  'user-silent',     // 用户手动"静默模式"
  'disabled',        // 该能力总开关关闭
  'cooldown',        // 冷却中
])
export type BlockReason = z.infer<typeof BlockReasonSchema>

export const RecurrenceKindSchema = z.enum(['once', 'daily', 'weekdays', 'weekly', 'monthly'])
export type RecurrenceKind = z.infer<typeof RecurrenceKindSchema>

// ───────────────────────────────────────────────────────── 时间工具（引擎与 UI 共用）

/** `HH:MM`（24 小时制）—— 用正则钉死，避免 `25:99` 这类值进入调度 */
export const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间必须是 HH:MM（00:00–23:59）')
export type TimeOfDay = z.infer<typeof TimeOfDaySchema>

/** `YYYY-MM-DD` */
export const DateOnlySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, '日期必须是 YYYY-MM-DD')
export type DateOnly = z.infer<typeof DateOnlySchema>

export function minutesOfDay(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) return -1
  return Number(m[1]) * 60 + Number(m[2])
}

export function hhmm(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export function dateOnly(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地日期键（用于"今天是否已问候过"这类按天去重） */
export function localDayKey(ts: number): string {
  return dateOnly(new Date(ts))
}

/**
 * `HH:MM` 是否落在 `[start, end)` 区间内（**支持跨午夜**，如 23:30–07:00）。
 * 这是静音时段与"23:30 后提醒休息"共用的判定。
 */
export function inTimeRange(now: string, start: string, end: string): boolean {
  const n = minutesOfDay(now)
  const s = minutesOfDay(start)
  const e = minutesOfDay(end)
  if (n < 0 || s < 0 || e < 0) return false
  if (s === e) return false          // 零长度区间：不生效（避免"永远静音"这种坑）
  return s < e ? (n >= s && n < e) : (n >= s || n < e)
}

// ───────────────────────────────────────────────────────── Schedule（日程）

export const ScheduleRecurrenceSchema = z.object({
  kind: RecurrenceKindSchema.default('once'),
  /** `kind === 'weekly'` 时必填：0=周日 … 6=周六 */
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  /** `kind === 'monthly'` 时必填：1–31（当月没有该日则跳过） */
  dayOfMonth: z.number().int().min(1).max(31).nullable().default(null),
  /** `kind === 'once'` 时必填：YYYY-MM-DD */
  date: DateOnlySchema.nullable().default(null),
})
export type ScheduleRecurrence = z.infer<typeof ScheduleRecurrenceSchema>

export const ScheduleSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  /** 开始时间 HH:MM */
  start: TimeOfDaySchema,
  /** 结束时间 HH:MM（可空 = 无明确结束） */
  end: TimeOfDaySchema.nullable().default(null),
  /** 提前多少分钟提醒（0 = 到点提醒） */
  leadMinutes: z.number().int().min(0).max(720).default(0),
  recurrence: ScheduleRecurrenceSchema,
  /** 重要日程在静音时段也允许弹窗（用户显式标注） */
  important: z.boolean().default(false),
  /** 是否参与早安电台播报 */
  announceInRadio: z.boolean().default(true),
  note: z.string().max(500).default(''),
  enabled: z.boolean().default(true),
  /** 上次触发日期（按天去重，防重复触发） */
  lastFiredDay: DateOnlySchema.nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Schedule = z.infer<typeof ScheduleSchema>

/** 新建/更新日程的入参（`id` 缺省 = 新建） */
export const ScheduleUpsertSchema = z.object({
  id: z.string().max(64).optional(),
  title: z.string().min(1).max(120),
  start: TimeOfDaySchema,
  end: TimeOfDaySchema.nullable().optional(),
  leadMinutes: z.number().int().min(0).max(720).optional(),
  recurrence: ScheduleRecurrenceSchema.partial().optional(),
  important: z.boolean().optional(),
  announceInRadio: z.boolean().optional(),
  note: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
})
export type ScheduleUpsert = z.infer<typeof ScheduleUpsertSchema>

export const ScheduleDeleteSchema = z.object({ id: z.string().min(1).max(64) })

// ───────────────────────────────────────────────────────── Reminder（提醒）

export const ReminderSchema = z.object({
  id: z.string().min(1).max(64),
  kind: ReminderKindSchema,
  title: z.string().min(1).max(200),
  /** 正文（可空；本地存储，日志只记长度） */
  body: z.string().max(2000).default(''),
  priority: PrioritySchema.default('normal'),
  /** 计划触发时间（毫秒时间戳）。`continuous`/`sedentary`/`night` 由引擎在触发时写入 */
  fireAt: z.number(),
  /** 关联日程 */
  scheduleId: z.string().max(64).nullable().default(null),
  state: ReminderStateSchema.default('pending'),
  /** 被阻断的原因（`state==='queued'` 时有意义） */
  blockReason: BlockReasonSchema.default('none'),
  /** 已尝试送达次数（重试上限见 `ReminderPolicySchema.maxRetries`） */
  attempts: z.number().int().min(0).default(0),
  /** 失败原因（脱敏短文案） */
  lastError: z.string().max(300).nullable().default(null),
  /** 实际送达时间 */
  firedAt: z.number().nullable().default(null),
  /** 用户确认/已读时间 */
  ackedAt: z.number().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Reminder = z.infer<typeof ReminderSchema>

export const ReminderUpsertSchema = z.object({
  id: z.string().max(64).optional(),
  kind: ReminderKindSchema.default('scheduled'),
  title: z.string().min(1).max(200),
  body: z.string().max(2000).optional(),
  priority: PrioritySchema.optional(),
  /** 定时提醒必须给时间；`continuous`/`sedentary`/`night` 可省略（由引擎按阈值生成） */
  fireAt: z.number().optional(),
  /** 便捷写法：`HH:MM` + `date`（缺省今天）⇒ 主进程换算成 fireAt */
  atTime: TimeOfDaySchema.optional(),
  atDate: DateOnlySchema.optional(),
  scheduleId: z.string().max(64).nullable().optional(),
}).refine(
  v => v.fireAt !== undefined || v.atTime !== undefined || v.kind !== 'scheduled',
  { message: '定时提醒必须给出 fireAt 或 atTime' },
)
export type ReminderUpsert = z.infer<typeof ReminderUpsertSchema>

export const ReminderDeleteSchema = z.object({ id: z.string().min(1).max(64) })
export const ReminderAckSchema = z.object({ id: z.string().min(1).max(64), acked: z.boolean().default(true) })

export const ReminderQueueItemSchema = z.object({
  reminder: ReminderSchema,
  /** 人类可读的"为什么现在才补发"（已脱敏） */
  blockedReasonText: z.string().max(200),
})
export type ReminderQueueItem = z.infer<typeof ReminderQueueItemSchema>

// ───────────────────────────────────────────────────────── QuietHours（静音时段）

/**
 * 静音时段。
 * `allowImportant` 是**"重要级提醒仍可送达"**的开关 —— 但它只放宽到"进队列 + 角标"，
 * 不会在静音时段弹窗或发声（用户要求的"不弹窗、不发声、不抢焦点"是硬约束）。
 */
export const QuietHoursSchema = z.object({
  enabled: z.boolean().default(true),
  start: TimeOfDaySchema.default('23:00'),
  end: TimeOfDaySchema.default('07:30'),
  /** 静音时段内是否允许"重要"级提醒送达（进队列 + 记录，不弹窗） */
  allowImportant: z.boolean().default(true),
  /** 全屏/游戏/会议/专注时是否一并静音（默认是） */
  respectFullscreen: z.boolean().default(true),
  respectMeeting: z.boolean().default(true),
  respectFocus: z.boolean().default(true),
  updatedAt: z.number().default(0),
})
export type QuietHours = z.infer<typeof QuietHoursSchema>

export const QuietHoursSetSchema = QuietHoursSchema.partial().refine(
  v => v.enabled !== undefined || v.start !== undefined || v.end !== undefined
    || v.allowImportant !== undefined || v.respectFullscreen !== undefined
    || v.respectMeeting !== undefined || v.respectFocus !== undefined,
  { message: '至少要给出一个要修改的字段' },
)
export type QuietHoursSet = z.infer<typeof QuietHoursSetSchema>

// ───────────────────────────────────────────────────────── 提醒阈值与政策

export const ReminderPolicySchema = z.object({
  /** 连续使用电脑多少分钟提醒活动（用户要求默认 50） */
  continuousMinutes: z.number().int().min(5).max(600).default(50),
  /** 久坐：连续多少分钟"无有效活动"提醒（默认 60） */
  sedentaryMinutes: z.number().int().min(5).max(600).default(60),
  /** 久坐判定里"有效活动"的下限（每分钟的键盘/鼠标事件数；默认 20） */
  sedentaryActivityFloor: z.number().int().min(0).max(100000).default(20),
  /** 夜间休息提醒时间（用户要求默认 23:30） */
  nightRestAt: TimeOfDaySchema.default('23:30'),
  /** 夜间提醒后是否进入静音时段（默认不自动改用户设置） */
  nightRestEnablesQuietHours: z.boolean().default(false),
  /** 各类提醒的冷却（分钟）—— 防重复轰炸 */
  cooldownMinutes: z.object({
    continuous: z.number().int().min(1).max(600).default(60),
    sedentary: z.number().int().min(1).max(600).default(60),
    night: z.number().int().min(1).max(1440).default(720),
    greeting: z.number().int().min(1).max(1440).default(480),
    radio: z.number().int().min(1).max(1440).default(60),
  }).default({}),
  /** 送达失败的重试上限（超过即 `state:'failed'` 并记审计，不再无限重试） */
  maxRetries: z.number().int().min(0).max(10).default(3),
  /** 消息队列上限（超出丢弃最旧的 `silent` 级，保留重要级） */
  maxQueue: z.number().int().min(1).max(500).default(50),
  updatedAt: z.number().default(0),
})
export type ReminderPolicy = z.infer<typeof ReminderPolicySchema>

export const ReminderPolicySetSchema = ReminderPolicySchema.partial().refine(
  v => Object.keys(v).filter(k => k !== 'updatedAt').length > 0,
  { message: '至少要给出一个要修改的字段' },
)
export type ReminderPolicySet = z.infer<typeof ReminderPolicySetSchema>

// ───────────────────────────────────────────────────────── Permission（权限）

/**
 * 工具/能力的 kind —— **只有这里列出的能力可以被授权**。
 * 新增能力必须同时在本枚举、`PERMISSION_TIERS`（硬下限）与主进程执行器里登记。
 */
export const PermissionKindSchema = z.enum([
  'screen-capture',     // 屏幕理解（按需截图）
  'file-read',          // 读取用户授权目录白名单内的文件
  'file-write',         // 写入用户授权目录（高风险：必须二次确认）
  'app-launch',         // 启动应用
  'shell-exec',         // 执行命令（高风险）
  'clipboard-read',     // 读取剪贴板
  'window-control',     // 控制窗口（移动/置顶/最小化）
  'input-simulate',     // 模拟键鼠（高风险：禁止自动执行）
  'system-settings',    // 修改系统设置（禁止）
  'credential-access',  // 读取凭据（**永久禁止**）
  'payment',            // 支付（**永久禁止**）
])
export type PermissionKind = z.infer<typeof PermissionKindSchema>

/** 三档权限（用户要求）：只读 / 普通操作需确认 / 高风险禁止或二次确认 */
export const PermissionTierSchema = z.enum(['read-only', 'confirm', 'blocked'])
export type PermissionTier = z.infer<typeof PermissionTierSchema>

/**
 * **硬下限**：任何授权都不得让某个能力比这里更宽松。
 * 这是"禁止自动支付 / 改密码 / 读凭据"在代码里的落点 —— 不是提示词里的君子协定。
 */
export const PERMISSION_TIER_FLOOR: Record<PermissionKind, PermissionTier> = {
  'screen-capture': 'read-only',
  'file-read': 'read-only',
  'file-write': 'confirm',
  'app-launch': 'confirm',
  'shell-exec': 'confirm',
  'clipboard-read': 'confirm',
  'window-control': 'read-only',
  // ↓ 永久禁止：UI 上只显示"禁止"，且无法被任何设置放宽
  'input-simulate': 'blocked',
  'system-settings': 'blocked',
  'credential-access': 'blocked',
  'payment': 'blocked',
}

/** 档位的严格程度（用于比较 `max(floor, requested)`） */
export const TIER_ORDER: Record<PermissionTier, number> = { 'read-only': 0, confirm: 1, blocked: 2 }

/** 取"实际生效"的档位：请求值不得宽于硬下限 */
export function effectiveTier(kind: PermissionKind, requested: PermissionTier): PermissionTier {
  const floor = PERMISSION_TIER_FLOOR[kind]
  return TIER_ORDER[requested] >= TIER_ORDER[floor] ? requested : floor
}

export const PermissionSchema = z.object({
  kind: PermissionKindSchema,
  label: z.string().max(60),
  /** 用户请求的档位（实际生效值由 `effectiveTier()` 取硬下限的严格者） */
  tier: PermissionTierSchema,
  /** 实际生效档位（主进程写；与 `tier` 不同就说明被硬下限收紧过） */
  effective: PermissionTierSchema,
  /** 是否启用（`blocked` 的能力永远为 false） */
  enabled: z.boolean(),
  /** 目录白名单（仅 `file-read` / `file-write` 有意义） */
  pathAllowlist: z.array(z.string().max(400)).max(64).default([]),
  /** 屏幕理解的排除区域（归一化 0–1 矩形；截图前打码） */
  excludeRegions: z.array(z.object({
    x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    w: z.number().min(0).max(1), h: z.number().min(0).max(1),
  })).max(16).default([]),
  /** 是否对截图做敏感信息脱敏（默认开） */
  redactSensitive: z.boolean().default(true),
  updatedAt: z.number().default(0),
  /** 授权来源，写进审计 */
  grantedBy: z.enum(['onboarding', 'settings', 'default', 'floor']).default('default'),
})
export type Permission = z.infer<typeof PermissionSchema>

export const PermissionSetSchema = z.object({
  kind: PermissionKindSchema,
  tier: PermissionTierSchema.optional(),
  enabled: z.boolean().optional(),
  pathAllowlist: z.array(z.string().max(400)).max(64).optional(),
  excludeRegions: z.array(z.object({
    x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    w: z.number().min(0).max(1), h: z.number().min(0).max(1),
  })).max(16).optional(),
  redactSensitive: z.boolean().optional(),
}).refine(
  v => v.tier !== undefined || v.enabled !== undefined || v.pathAllowlist !== undefined
    || v.excludeRegions !== undefined || v.redactSensitive !== undefined,
  { message: '至少要给出一个要修改的字段' },
)
export type PermissionSet = z.infer<typeof PermissionSetSchema>

// ───────────────────────────────────────────────────────── 工具调用审计

/**
 * 一次工具调用的审计记录。
 *
 * **禁止模型伪造执行成功**：`ok` 只能由执行器写入；
 * `paramsDigest` 是参数摘要（sha256 前 12 位 + 长度），**不落原始参数**（参数里可能有正文与路径）。
 */
export const ToolCallRecordSchema = z.object({
  id: z.string().min(1).max(64),
  tool: z.string().max(64),
  /** 参数摘要：算法 + 前 12 位 + 原长 */
  paramsDigest: z.string().max(80),
  /** 权限判定结果 */
  decision: z.enum(['allow', 'needs-confirm', 'denied', 'timeout', 'error']),
  /** 拒绝/失败原因（错误码或脱敏短文案） */
  reason: z.string().max(300).nullable().default(null),
  /** 实际是否执行成功（`null` = 未被允许执行） */
  ok: z.boolean().nullable().default(null),
  durationMs: z.number().int().min(0).nullable().default(null),
  /** 结果摘要（长度 + 哈希，不含正文） */
  resultDigest: z.string().max(80).nullable().default(null),
  at: z.number(),
})
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>

// ───────────────────────────────────────────────────────── ActivityStats（活动统计）

/**
 * 活动状态（内存态，供 UI 与引擎共用）。
 *
 * **隐私边界**：只统计"计数与时长"，**不记录按键内容、不记录窗口标题原文**
 * （前台窗口只留 `titleDigest` 与 `titleChars`，用于判断"这是同一个窗口吗"）。
 */
export const ActivityStateSchema = z.object({
  at: z.number(),
  /** 距离上次键鼠输入的空闲毫秒（Windows `GetLastInputInfo`） */
  idleMs: z.number().int().min(0),
  /** 本分钟内的输入事件计数（**只计数**） */
  inputEvents1m: z.number().int().min(0),
  /** 前台窗口是否全屏 */
  fullscreen: z.boolean(),
  /** 检测到的游戏进程名（如 `Game.exe`；仅进程名，不含路径） */
  gameProcess: z.string().max(120).nullable(),
  /** 会议检测（会议进程名 / 摄像头或麦克风被占用） */
  meeting: z.string().max(120).nullable(),
  /** 系统"助手专注"/免打扰 */
  focusAssist: z.boolean(),
  /** 用户手动静默模式 */
  userSilent: z.boolean(),
  /** 前台窗口标题摘要（sha256 前 8 位 + 原长）—— **不含原文** */
  titleDigest: z.string().max(24).nullable(),
  titleChars: z.number().int().min(0),
  /** 采样是否可用（PowerShell 探针失败时为 false，UI 必须如实显示） */
  available: z.boolean(),
  /** 采样失败原因（脱敏） */
  unavailableReason: z.string().max(200).nullable(),
  /** 当前生效的阻断原因（`none` = 可以打扰） */
  blockReason: BlockReasonSchema,
})
export type ActivityState = z.infer<typeof ActivityStateSchema>

/** 按天的活动汇总（持久化；早安电台与"今日总结"的输入） */
export const ActivityDayStatsSchema = z.object({
  day: DateOnlySchema,
  /** 电脑活跃时长（分钟；有输入事件的分钟累计） */
  activeMinutes: z.number().int().min(0).default(0),
  /** 连续使用的最长一段（分钟） */
  longestStreakMinutes: z.number().int().min(0).default(0),
  /** 最长无活动间隔（分钟） */
  longestIdleMinutes: z.number().int().min(0).default(0),
  /** 输入事件总数（**只计数**） */
  inputEvents: z.number().int().min(0).default(0),
  /** 被阻断（会议/全屏/游戏/静音）的采样次数 */
  blockedSamples: z.number().int().min(0).default(0),
  /** 采样次数（用于判定统计是否可信） */
  samples: z.number().int().min(0).default(0),
  firstActiveAt: z.number().nullable().default(null),
  lastActiveAt: z.number().nullable().default(null),
  /** 按小时的活动分布（24 格；分钟）—— 用于"工作节奏"学习 */
  hourlyActiveMinutes: z.array(z.number().int().min(0)).length(24).default(() => Array.from({ length: 24 }, () => 0)),
})
export type ActivityDayStats = z.infer<typeof ActivityDayStatsSchema>

// ───────────────────────────────────────────────────────── 早安电台内容

/**
 * 资讯条目：**必须带来源与日期**（用户要求"外部资料必须保留来源与日期"）。
 * 没有来源的条目一律不进入电台 —— 宁可少讲，不可编造。
 */
export const NewsItemSchema = z.object({
  title: z.string().min(1).max(300),
  source: z.string().min(1).max(120),
  url: z.string().max(600),
  /** 发布日期（YYYY-MM-DD）或抓取日期（`fetchedAt` 另有字段） */
  date: DateOnlySchema.nullable().default(null),
  fetchedAt: z.number(),
  /** `live` = 本次真的抓到的；`cache` = 用本地缓存；`none` = 无可用来源 */
  provenance: z.enum(['live', 'cache', 'none']).default('live'),
})
export type NewsItem = z.infer<typeof NewsItemSchema>

export const WeatherInfoSchema = z.object({
  available: z.boolean(),
  city: z.string().max(80).nullable().default(null),
  summary: z.string().max(120).nullable().default(null),
  tempC: z.number().nullable().default(null),
  feelsLikeC: z.number().nullable().default(null),
  highC: z.number().nullable().default(null),
  lowC: z.number().nullable().default(null),
  humidity: z.number().nullable().default(null),
  windKph: z.number().nullable().default(null),
  source: z.string().max(120).nullable().default(null),
  fetchedAt: z.number().nullable().default(null),
  /** 不可用原因（**必须如实说明**，不得编造天气） */
  unavailableReason: z.string().max(200).nullable().default(null),
})
export type WeatherInfo = z.infer<typeof WeatherInfoSchema>

/** 早安电台的结构化内容 + 可直接朗读的口播稿（30–60 秒） */
export const RadioContentSchema = z.object({
  id: z.string().max(64),
  day: DateOnlySchema,
  weekday: z.string().max(16),
  greeting: z.string().max(300),
  weather: WeatherInfoSchema,
  /** 今日日程的逐条摘要 */
  schedule: z.array(z.object({
    id: z.string().max(64),
    title: z.string().max(120),
    start: TimeOfDaySchema,
    minutesFromNow: z.number().int().nullable().default(null),
  })).max(20),
  news: z.array(NewsItemSchema).max(8),
  advice: z.array(z.string().max(300)).max(6),
  encouragement: z.string().max(300),
  /** 口播稿（TTS 直接读这一段） */
  script: z.string().max(4000),
  /** 估算朗读时长（秒）：按中文 4.2 字/秒估算，档位落在 30–60 秒 */
  estimatedSeconds: z.number().min(0).max(600),
  /** 内容来源不可用时的如实标注（如"天气：本机未配置城市"） */
  disclosures: z.array(z.string().max(200)).max(12).default([]),
  generatedAt: z.number(),
})
export type RadioContent = z.infer<typeof RadioContentSchema>

// ───────────────────────────────────────────────────────── 主动事件

export const ProactiveEventKindSchema = z.enum([
  'greeting',       // 开机问候
  'schedule-brief', // 今日日程播报
  'morning-radio',  // 早安电台
  'reminder',       // 定时/连续/久坐/夜间提醒
  'queue-flush',    // 阻断结束后的补发
  'self-test',      // 探针用：不产生用户可见副作用
])
export type ProactiveEventKind = z.infer<typeof ProactiveEventKindSchema>

export const ProactiveEventSchema = z.object({
  id: z.string().min(1).max(64),
  kind: ProactiveEventKindSchema,
  priority: PrioritySchema,
  /** 面向用户的短标题 */
  title: z.string().min(1).max(200),
  /** 正文（要朗读/气泡显示的内容） */
  text: z.string().max(8000),
  /** 结构化载荷：早安电台放 `RadioContent`；提醒放 `Reminder` 的公开投影 */
  payload: z.record(z.string(), z.unknown()).nullable().default(null),
  /** 声音是否允许（静音时段/静默模式下即使重要级也不发声） */
  speak: z.boolean().default(false),
  /** 是否允许把窗口提到前台（**默认 false** —— 不抢焦点） */
  focus: z.boolean().default(false),
  /** 建议的展示时长（毫秒） */
  ttlMs: z.number().int().min(1000).max(600000).default(20000),
  at: z.number(),
  /** 产生它的调度器标识（审计用） */
  source: z.string().max(64).default('engine'),
})
export type ProactiveEvent = z.infer<typeof ProactiveEventSchema>

/** 引擎只读状态（诊断与探针；不涉及用户正文） */
export const ProactiveStatusSchema = z.object({
  running: z.boolean(),
  /** 距下次检查的毫秒（-1 = 未排程） */
  nextTickInMs: z.number().int(),
  lastTickAt: z.number().nullable(),
  ticks: z.number().int().min(0),
  /** 引擎是否已完成"网络与服务就绪后的首次问候" */
  startupGreeted: z.boolean(),
  startupGreetedAt: z.number().nullable(),
  radioGeneratedAt: z.number().nullable(),
  /** 各能力的冷却到期时间（毫秒时间戳） */
  cooldownUntil: z.record(z.string(), z.number()),
  queueLength: z.number().int().min(0),
  /** 最近 N 次调度决策（**只含原因码，不含正文**） */
  recentDecisions: z.array(z.object({
    at: z.number(),
    kind: z.string().max(40),
    decision: z.enum(['fired', 'queued', 'skipped']),
    reason: BlockReasonSchema,
  })).max(64),
  /** 已送达（发出）的活跃提醒数 */
  activeReminders: z.number().int().min(0),
  /** 各能力开关（用户可在设置里关；这里回显真实值） */
  enabled: z.object({
    greeting: z.boolean(),
    scheduleBrief: z.boolean(),
    morningRadio: z.boolean(),
    continuous: z.boolean(),
    sedentary: z.boolean(),
    night: z.boolean(),
  }),
  /** 自学习相关的只读状态（M4；M2 只汇报开关与最近一次运行） */
  reflection: z.object({
    enabled: z.boolean(),
    lastRunAt: z.number().nullable(),
    lastRunDay: DateOnlySchema.nullable(),
    runs: z.number().int().min(0),
  }),
  /** ★ M4：待用户确认的反思条数（UI 角标；只给计数，不给内容） */
  pendingReflections: z.number().int().min(0).default(0),
})
export type ProactiveStatus = z.infer<typeof ProactiveStatusSchema>

export const ProactiveInboxSchema = z.object({
  /** 队列里待补发的（被阻断的）提醒 */
  queued: z.array(ReminderQueueItemSchema),
  /** 已送达但用户尚未确认的 */
  unacked: z.array(ReminderSchema).max(200),
  /** 最近送达的主动事件（**只保留脱敏字段**：标题 + 优先级 + 时间） */
  recent: z.array(z.object({
    id: z.string().max(64),
    kind: ProactiveEventKindSchema,
    priority: PrioritySchema,
    title: z.string().max(200),
    at: z.number(),
  })).max(50),
})
export type ProactiveInbox = z.infer<typeof ProactiveInboxSchema>

/** `proactive:radio` 入参：`force` 时忽略冷却（探针与用户手动点按） */export const ProactiveRadioRequestSchema = z.object({
  force: z.boolean().default(false),
  /** 是否真的朗读（探针默认 false，避免在 CI/无人环境放音） */
  speak: z.boolean().default(false),
})
export type ProactiveRadioRequest = z.infer<typeof ProactiveRadioRequestSchema>

export const ProactiveRadioResultSchema = z.object({
  content: RadioContentSchema,
  /** 文案是否已交给 TTS（`speak:false` 时为 false） */
  spoken: z.boolean(),
  /** 若被冷却挡住，如实返回（`null` = 正常生成） */
  skippedReason: z.string().max(200).nullable().default(null),
})
export type ProactiveRadioResult = z.infer<typeof ProactiveRadioResultSchema>

// ───────────────────────────────────────────────────────── M4 每日自学习

/**
 * 提取项的**类别**。
 *   · `preference`  偏好（喜欢/讨厌/习惯）
 *   · `fact`        重要事实（生日/人名/过敏…）
 *   · `todo`        待办
 *   · `emotion`     情绪变化
 *   · `habit`       工作节奏 / 日程习惯（**只描述，不自动改任何设置**）
 */
export const ReflectionItemKindSchema = z.enum(['preference', 'fact', 'todo', 'emotion', 'habit'])
export type ReflectionItemKind = z.infer<typeof ReflectionItemKindSchema>

/**
 * 提取项。
 *
 * ★ `confidence` 与 `approval` 是 M4 的核心设计（用户要求
 *   "高置信度事实写入长期记忆；低置信度内容必须询问用户确认"）：
 *   · `confidence >= HIGH_CONFIDENCE` ⇒ 自动写入长期记忆，`approval='auto'`；
 *   · 低于阈值 ⇒ **不写**，`approval='pending'`，必须由用户点确认后才写。
 *   `memoryId` 只在真的写入后才有值 —— "写没写进去"是可核对的，不是承诺。
 */
export const ReflectionItemSchema = z.object({
  id: z.string().min(1).max(64),
  kind: ReflectionItemKindSchema,
  /** 提取出的正文（本地存储；日志只记长度） */
  text: z.string().min(1).max(2000),
  /** 置信度 0–1（由提取规则的强度决定，不是模型自报） */
  confidence: z.number().min(0).max(1),
  /** `auto` = 已自动写入记忆；`pending` = 等用户确认；`rejected` = 用户拒绝；`skipped` = 低于阈值且用户未处理 */
  approval: z.enum(['auto', 'pending', 'rejected', 'skipped']).default('pending'),
  /** 命中该条的原始依据（**只存长度与指纹，不存正文**） */
  evidence: z.object({
    /** 来自哪些消息（条数） */
    messageCount: z.number().int().min(0),
    /** 触发它的关键词 id（规则名，不是用户原文） */
    ruleId: z.string().max(40),
  }),
  /** 写入长期记忆后的条目 id（`null` = 未写入） */
  memoryId: z.string().max(64).nullable().default(null),
  createdAt: z.number(),
})
export type ReflectionItem = z.infer<typeof ReflectionItemSchema>

/** 置信度阈值（**唯一真源**：提取器、UI、单测共用同一份） */
export const HIGH_CONFIDENCE = 0.75

/** 工作节奏（**只描述**，不自动改设置） */
export const WorkRhythmSchema = z.object({
  /** 最近 N 天里有活动的平均分钟数 */
  avgActiveMinutes: z.number().min(0).default(0),
  /** 最长连续使用段（分钟，取最近 N 天最大） */
  maxStreakMinutes: z.number().int().min(0).default(0),
  /** 最活跃的几个小时（0–23，按活动分钟数排序） */
  topHours: z.array(z.number().int().min(0).max(23)).max(6).default([]),
  /** 样本天数（**太少就不该下结论**，UI 要显示这个数） */
  sampleDays: z.number().int().min(0).default(0),
  /** 结论是否可信（样本不足时为 false，UI 不该把它当事实展示） */
  confident: z.boolean().default(false),
})
export type WorkRhythm = z.infer<typeof WorkRhythmSchema>

/** 每日反思结果 */
export const DailyReflectionSchema = z.object({
  day: DateOnlySchema,
  generatedAt: z.number(),
  /** 总结（一段话） */
  summary: z.string().max(4000),
  /** 结构化读数（**都是计数，没有正文**） */
  stats: z.object({
    messages: z.number().int().min(0),
    userMessages: z.number().int().min(0),
    assistantMessages: z.number().int().min(0),
    proactiveMessages: z.number().int().min(0),
    memoryHits: z.number().int().min(0),
    activeMinutes: z.number().int().min(0),
  }),
  items: z.array(ReflectionItemSchema).max(80),
  workRhythm: WorkRhythmSchema,
  /** 今日总结（面向用户，可直接展示） */
  dailySummary: z.string().max(4000),
  /** 明日建议（每条都基于真实读数） */
  tomorrowAdvice: z.array(z.string().max(300)).max(8),
  /** 外部资料（若有）——**必须带来源与日期** */
  externalRefs: z.array(z.object({
    title: z.string().max(300),
    source: z.string().max(120),
    date: DateOnlySchema.nullable().default(null),
  })).max(8).default([]),
  /** 提取用了什么（`heuristic` = 纯规则；`llm` = 走模型增强） */
  method: z.enum(['heuristic', 'llm', 'llm-failed']).default('heuristic'),
  /** 如实说明（如"模型不可用，本次只用规则提取"） */
  disclosures: z.array(z.string().max(200)).max(12).default([]),
  /** 本次是否真的写入了长期记忆（写入条数） */
  autoWritten: z.number().int().min(0).default(0),
  /** 待用户确认条数 */
  pendingApproval: z.number().int().min(0).default(0),
})
export type DailyReflection = z.infer<typeof DailyReflectionSchema>

/** 反思状态（UI 与探针） */
export const ReflectionStatusSchema = z.object({
  /** 用户开关（默认关闭） */
  enabled: z.boolean(),
  /** 每日执行时间（HH:MM） */
  at: TimeOfDaySchema,
  /** 最近一次运行 */
  lastRunAt: z.number().nullable(),
  lastRunDay: DateOnlySchema.nullable(),
  runs: z.number().int().min(0),
  /** 保留的历史天数 */
  keepDays: z.number().int().min(1).max(400),
  /** 待确认条数（角标） */
  pendingCount: z.number().int().min(0),
  /** 已自动写入记忆的累计条数 */
  autoWrittenTotal: z.number().int().min(0),
  /** 被用户拒绝的累计条数 */
  rejectedTotal: z.number().int().min(0),
  /** 置信度阈值（UI 要如实显示"多高才算高"） */
  highConfidence: z.number().min(0).max(1),
})
export type ReflectionStatus = z.infer<typeof ReflectionStatusSchema>

/** 历史列表（给 UI；`items` 可选，列表时常不带） */
export const ReflectionHistorySchema = z.object({
  days: z.array(DailyReflectionSchema).max(400),
  pending: z.array(ReflectionItemSchema).max(200),
})
export type ReflectionHistory = z.infer<typeof ReflectionHistorySchema>

/** 确认/拒绝一条待确认项 */
export const ReflectionDecideSchema = z.object({
  day: DateOnlySchema,
  itemId: z.string().min(1).max(64),
  approve: z.boolean(),
})
export type ReflectionDecide = z.infer<typeof ReflectionDecideSchema>

/** 手动运行一次（探针与"我现在就想看看"用它） */
export const ReflectionRunSchema = z.object({
  /** 忽略"今天已经跑过"与冷却 */
  force: z.boolean().default(false),
  /** 不写入任何记忆（只出报告）—— 探针默认用它，避免污染用户记忆 */
  dryRun: z.boolean().default(false),
})
export type ReflectionRun = z.infer<typeof ReflectionRunSchema>
