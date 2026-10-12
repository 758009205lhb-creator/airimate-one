/**
 * @airimate/shared/commands —— **统一动作事件类型**（唯一真源）
 *
 * 纪律（PRD §6 / Tech-Spec §6.2）：
 *   用户输入 → AIRI 会话 → 回复文本 + 动作事件 → MotionDirector → AvatarStage
 *   这条链上**只有一个**动作事件定义。禁止 DOM 层再解析一次动作标记（双驱动）。
 *   所有跨进程消息必须经这里的 zod schema 运行时校验后才允许执行。
 */
import { z } from 'zod'

// ───────────────────────────────────────────────────────── 基础

export const Vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() })
export type Vec3 = z.infer<typeof Vec3Schema>

/** 表情 / 情绪名（VRM expression 名 + 产品语义）。只用 VRM 标准名，避免依赖具体模型的扩展名。 */
export const EmotionName = z.enum(['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'])
export type EmotionName = z.infer<typeof EmotionName>

/** 口型（VRM 标准 5 元音） */
export const VisemeName = z.enum(['aa', 'ih', 'ou', 'ee', 'oh'])
export type VisemeName = z.infer<typeof VisemeName>

/** 动作库里的语义动作名（映射到具体 clip 由 MotionDirector 决定，不在命令里写文件名） */
export const MotionSemantic = z.enum([
  'idle',        // 回到待机轮换
  'wave',        // 挥手
  'nod',         // 点头
  'shake',       // 摇头
  'dance',       // 跳舞（一次性）
  'laugh',       // 笑
  'shy',         // 害羞/捂脸
  'sit',         // 坐下（状态）
  'stand',       // 站起
  'walk',        // 行走（状态）
  'sleep',       // 睡眠（状态）
  'wake',        // 醒来
  'drag',        // 拖拽（由拖拽状态直接驱动，一般不由模型产出）
])
export type MotionSemantic = z.infer<typeof MotionSemantic>

/** 动作层：基础层互斥；叠加层不得覆盖骨骼主动作 */
export const MotionLayerKind = z.enum(['base', 'overlay'])
export type MotionLayerKind = z.infer<typeof MotionLayerKind>

// ───────────────────────────────────────────────────────── EmotionCommand

export const EmotionCommandSchema = z.object({
  type: z.literal('emotion'),
  emotion: EmotionName,
  /** 目标强度 0..1；0 表示清除该表情 */
  intensity: z.number().min(0).max(1),
  /** 持续毫秒；null/undefined = 保持到被下一个表情或 clear 覆盖 */
  durationMs: z.number().int().positive().nullable().optional(),
  /** 淡入时间（毫秒），默认 300 */
  fadeInMs: z.number().int().min(0).max(5000).optional(),
  /** 来源追踪：用于诊断与验收（不含用户隐私内容） */
  origin: z.string().max(64).optional(),
})
export type EmotionCommand = z.infer<typeof EmotionCommandSchema>

// ───────────────────────────────────────────────────────── MotionCommand

export const MotionCommandSchema = z.object({
  type: z.literal('motion'),
  motion: MotionSemantic,
  layer: MotionLayerKind.default('base'),
  /** true = 一次性动作播完回退；false = 状态动作（由 state 决定何时退出） */
  once: z.boolean().default(false),
  /** 交叉淡化时长（毫秒）。缺省由 MotionDirector 按 Mate 参数决定（待机 3000 / 拖拽 180 / 释放 250） */
  fadeMs: z.number().int().min(0).max(10000).optional(),
  /** 允许打断当前动作（拖拽永远优先，不受此字段影响） */
  interrupt: z.boolean().default(true),
  strength: z.number().min(0).max(1).optional(),
  origin: z.string().max(64).optional(),
})
export type MotionCommand = z.infer<typeof MotionCommandSchema>

// ───────────────────────────────────────────────────────── SpeechCommand

export const SpeechCommandSchema = z.object({
  type: z.literal('speech'),
  /** 文本本身**不进日志**（logger 会脱敏）；这里仅供播放与口型使用 */
  text: z.string().max(20000),
  /** 语音合成是否启用；false = 仅做口型 */
  speak: z.boolean().default(true),
  /** 口型驱动：由音频幅度或文本节奏驱动 */
  visemeSource: z.enum(['audio', 'text', 'none']).default('audio'),
  utteranceId: z.string().max(64),
  origin: z.string().max(64).optional(),
})
export type SpeechCommand = z.infer<typeof SpeechCommandSchema>

// ───────────────────────────────────────────────────────── VisibilityCommand

export const VisibilityCommandSchema = z.object({
  type: z.literal('visibility'),
  target: z.enum(['character', 'chatPanel', 'bubble', 'wheel']),
  visible: z.boolean(),
  origin: z.string().max(64).optional(),
})
export type VisibilityCommand = z.infer<typeof VisibilityCommandSchema>

// ───────────────────────────────────────────────────────── WindowModeCommand

/**
 * ⚠ 模式切换**不得**创建新窗口 / 新 renderer / 重载角色（PRD FR-1.3）。
 *   主进程收到后用同一个 BrowserWindow 改属性，并把结果广播回 renderer。
 */
export const WindowModeCommandSchema = z.object({
  type: z.literal('windowMode'),
  mode: z.enum(['panel', 'pet']),
  /** 是否同时把窗口置于屏幕中央（轮盘的"居中"入口用） */
  center: z.boolean().default(false),
  origin: z.string().max(64).optional(),
})
export type WindowModeCommand = z.infer<typeof WindowModeCommandSchema>

// ───────────────────────────────────────────────────────── 判别联合

export const StageCommandSchema = z.discriminatedUnion('type', [
  EmotionCommandSchema,
  MotionCommandSchema,
  SpeechCommandSchema,
  VisibilityCommandSchema,
  WindowModeCommandSchema,
])
export type StageCommand = z.infer<typeof StageCommandSchema>

export const StageCommandType = z.enum(['emotion', 'motion', 'speech', 'visibility', 'windowMode'])
export type StageCommandType = z.infer<typeof StageCommandType>

/** 运行时解析：失败返回错误列表（不抛），调用方负责记脱敏日志并拒绝执行 */
export function parseStageCommand(input: unknown):
  | { ok: true; value: StageCommand }
  | { ok: false; issues: string[] } {
  const r = StageCommandSchema.safeParse(input)
  if (r.success) return { ok: true, value: r.data }
  return { ok: false, issues: r.error.issues.map(i => `${i.path.join('.') || '<root>'}: ${i.message}`) }
}
