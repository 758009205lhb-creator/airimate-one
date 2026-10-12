/**
 * apps/desktop/src/main/act-parser.ts —— 动作标记的**唯一解析点**
 *
 * 纪律（PRD §6 唯一数据流）：
 *   模型回复里可能夹带动作/表情标记。**只能在这里解析一次**，
 *   产出的 `StageCommand[]` 经类型 + 运行时校验后推给 renderer；
 *   renderer **不得**再解析一遍（禁止双驱动）。
 *
 * 支持的标记（与 `MotionSemantic` / `EmotionName` 一一对应，不引入第二套词汇）：
 *   `[motion:wave]` `[motion:sit]` `[motion:dance once]`   动作（`once` 后缀 = 一次性）
 *   `[emotion:happy 0.8]`                                  表情（强度 0..1，可省）
 *   `[[wave]]` `((happy))`                                 简写
 *
 * 设计要点：
 *   · **未知标记一律丢弃**（不猜、不透传），并在返回值里报告，便于诊断；
 *   · 解析后必须从**展示文本**里彻底删除标记（用户不该看到它们）；
 *   · 不修改正文其余部分（包括换行与空白）。
 */
import type { EmotionCommand, EmotionName, MotionCommand, MotionSemantic, StageCommand } from '@airimate/shared'

const MOTION_WORDS: readonly MotionSemantic[] = [
  'idle', 'wave', 'nod', 'shake', 'dance', 'laugh', 'shy', 'sit', 'stand', 'walk', 'sleep', 'wake', 'drag',
]
const EMOTION_WORDS: readonly EmotionName[] = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral']

export interface ParsedReply {
  /** 给用户看的文本（**已剥离全部标记**） */
  displayText: string
  /** 解析出的动作/表情命令（已通过白名单校验） */
  commands: StageCommand[]
  /** 被丢弃的未知标记（诊断用；不回传给模型） */
  unknown: string[]
}

/**
 * ⚠ 正则必须**在函数内新建**，不能放在模块级常量里：
 *   带 `g` 标志的正则是有状态的（`lastIndex`），模块级共享会让"连续两次解析"结果不一致；
 *   另外大小写不敏感必须用 `i` 标志显式声明（实测：漏了 `i` 时 `[MOTION:Wave]` 完全不被识别）。
 */
const RE_MAIN_SRC = '\\[\\s*(motion|emotion|expression)\\s*:\\s*([a-zA-Z_]+)(?:\\s+(-?[0-9.]+|once))?\\s*\\]'
const RE_SHORT_SRC = '\\[\\[\\s*([a-zA-Z_]+)(?:\\s+(-?[0-9.]+|once))?\\s*\\]\\]|\\(\\(\\s*([a-zA-Z_]+)(?:\\s+(-?[0-9.]+|once))?\\s*\\)\\)'

function clamp01(n: number): number {
  return n < 0 ? 0 : (n > 1 ? 1 : n)
}

/**
 * 解析一轮回复。**纯函数**（无副作用、无 IO），因此可单测。
 */
export function parseReply(raw: string): ParsedReply {
  const commands: StageCommand[] = []
  const unknown: string[] = []
  const RE_MAIN = new RegExp(RE_MAIN_SRC, 'gi')
  const RE_SHORT = new RegExp(RE_SHORT_SRC, 'gi')

  const stripMain = raw.replace(RE_MAIN, (_m, kindRaw: string, wordRaw: string, argRaw?: string) => {
    const kind = kindRaw.toLowerCase()
    const word = wordRaw.toLowerCase()
    const arg = argRaw ?? ''
    if (kind === 'motion') {
      if (!MOTION_WORDS.includes(word as MotionSemantic)) { unknown.push(`motion:${word}`); return '' }
      const once = arg === 'once'
      const cmd: MotionCommand = {
        type: 'motion',
        motion: word as MotionSemantic,
        layer: 'base',
        once,
        interrupt: true,
        origin: 'llm',
      }
      commands.push(cmd)
      return ''
    }
    // emotion / expression
    if (!EMOTION_WORDS.includes(word as EmotionName)) { unknown.push(`emotion:${word}`); return '' }
    const intensity = arg && arg !== 'once' ? clamp01(Number(arg)) : 0.8
    const cmd: EmotionCommand = {
      type: 'emotion',
      emotion: word as EmotionName,
      intensity,
      durationMs: null,
      fadeInMs: 300,
      origin: 'llm',
    }
    commands.push(cmd)
    return ''
  })

  const displayText = stripMain.replace(RE_SHORT, (_m, w1?: string, a1?: string, w2?: string, a2?: string) => {
    const word = (w1 ?? w2 ?? '').toLowerCase()
    const arg = a1 ?? a2 ?? ''
    if (!word) return ''
    if (MOTION_WORDS.includes(word as MotionSemantic)) {
      const cmd: MotionCommand = {
        type: 'motion', motion: word as MotionSemantic, layer: 'base',
        once: arg === 'once', interrupt: true, origin: 'llm',
      }
      commands.push(cmd)
      return ''
    }
    if (EMOTION_WORDS.includes(word as EmotionName)) {
      const cmd: EmotionCommand = {
        type: 'emotion', emotion: word as EmotionName,
        intensity: arg && arg !== 'once' ? clamp01(Number(arg)) : 0.8,
        durationMs: null, fadeInMs: 300, origin: 'llm',
      }
      commands.push(cmd)
      return ''
    }
    unknown.push(`short:${word}`)
    return ''
  }).trim()

  return { displayText, commands, unknown }
}
