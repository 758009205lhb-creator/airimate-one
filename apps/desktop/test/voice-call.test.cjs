/**
 * apps/desktop/test/voice-call.test.cjs —— 语音通话链路的**前置条件与状态机**单测（M3 §2）
 *
 * 这个文件是补一个真实缺口才出现的：M3 第一版只有"识别一句"与"朗读一段"两个零件，
 * `onRecognizedText()` **全仓零订阅者**、也没有任何界面在驱动循环 ——
 * 外部复核指出"STT→LLM→TTS 全链路"当时并不存在。
 *
 * 这里能单测的部分（不依赖麦克风/模型/扬声器）：
 *   · 前置条件判定（为什么不能通话必须能说清）；
 *   · 状态投影的形状（**不含任何识别内容或回复正文**）；
 *   · 未启用/未配置时 `startVoiceCall()` **结构化拒绝**（不会悄悄开麦）；
 *   · 打断与结束的幂等性（没有通话时调用必须是安全的空操作）。
 *
 * 需要真人说话的"听→想→说"往返不在单测范围（见 `--probe m3` 的说明与文档的未验证清单）。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir, stubElectron, resetStores } = require('./helpers/harness.cjs')

const TMP = tmpdir('vcall')
stubElectron(TMP)

const call = require('../dist/main/voice-call.js')
const voice = require('../dist/main/voice-engine.js')
const settings = require('../dist/main/settings-store.js')
const provider = require('../dist/main/provider-store.js')
const secrets = require('../dist/main/secrets-store.js')
const SHARED = require(path.resolve(__dirname, '..', '..', '..', 'packages', 'shared', 'dist', 'index.js'))

const ALL = { call, voice, settings, provider, secrets }

test.beforeEach(() => {
  for (const f of ['settings.json', 'providers.json', 'session.json', 'memory.json']) {
    fs.rmSync(path.join(TMP, f), { force: true })
  }
  fs.rmSync(path.join(TMP, 'secrets'), { recursive: true, force: true })
  resetStores(ALL)
  settings.mergeSettings({ ...SHARED.DEFAULT_SETTINGS }, { immediate: true })
  call.stopVoiceCall('test-reset')
})

// ───────────────────────────────────────────────────────── 默认与前置条件

test('★★ 默认不能通话：语音未启用 + 未配置供应商，两条原因都要说出来', () => {
  const p = call.voiceCallPreflight()
  assert.equal(p.ready, false)
  assert.ok(p.reasons.some(r => r.includes('语音识别未启用')), `实际：${JSON.stringify(p.reasons)}`)
  assert.ok(p.reasons.some(r => r.includes('供应商')), `实际：${JSON.stringify(p.reasons)}`)
})

test('★ 未启用语音时 startVoiceCall **结构化拒绝**（不是抛错、也不会开麦）', () => {
  const r = call.startVoiceCall()
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /语音识别未启用/)
  assert.equal(call.voiceCallState().active, false, '被拒时不得进入通话状态')
  assert.equal(voice.voiceStatus().micActive, false, '被拒时绝不能占用麦克风')
})

test('★ 启用了语音但没有供应商 ⇒ 仍然拒绝（通话没有模型可答）', () => {
  settings.mergeSettings({ hearingEnabled: true }, { immediate: true })
  const r = call.startVoiceCall()
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /供应商/)
  assert.equal(call.voiceCallState().active, false)
})

test('TTS 未启用**不算**硬阻塞，但要在 reasons 里如实提示（她只会说文字不出声）', () => {
  settings.mergeSettings({ hearingEnabled: true, ttsEnabled: false }, { immediate: true })
  const p = call.voiceCallPreflight()
  assert.ok(p.reasons.some(r => r.includes('TTS')), `实际：${JSON.stringify(p.reasons)}`)
  // 硬条件仍然不满足（没有供应商），所以 ready 为 false —— 但原因里不该把 TTS 当硬阻塞
  assert.equal(p.ready, false)
})

// ───────────────────────────────────────────────────────── 状态投影

test('★ 通话状态里**没有识别内容或回复正文**（只有长度与计数）', () => {
  const s = call.voiceCallState()
  /**
   * ⚠ 这份清单是**逐键**钉死的：新增字段必须由人显式加进来。
   *   2026-10-06（A4 闭环）新增 5 个：`wakeWatchRunning` / `lastRecognizedChars` /
   *   `lastWasWake` / `recognizedCount` / `bargeInInterruptions` —— 全部是**布尔与计数**，
   *   仍然没有任何正文。这条断言的作用就是逼着改动者**显式**确认这一点。
   */
  assert.deepEqual(Object.keys(s).sort(), [
    'active', 'bargeInInterruptions', 'interruptions', 'lastError', 'lastHeardChars',
    'lastRecognizedChars', 'lastSpokeChars', 'lastWasWake', 'phase', 'recognizedCount',
    'silenceTurns', 'startedAt', 'turn', 'turnsCompleted', 'wakeWatchRunning',
  ].sort())
  for (const k of ['text', 'replyText', 'heard', 'reply', 'lastText']) {
    assert.equal(k in s, false, `状态里不该有 ${k}`)
  }
})

test('初始状态：未通话、阶段 idle、计数全 0', () => {
  const s = call.voiceCallState()
  assert.equal(s.active, false)
  assert.equal(s.phase, 'idle')
  assert.equal(s.turn, 0)
  assert.equal(s.turnsCompleted, 0)
  assert.equal(s.interruptions, 0)
  assert.equal(s.silenceTurns, 0)
  assert.equal(s.startedAt, null)
})

test('VoiceCallStateSchema 与运行态投影**逐键一致**（契约漂移会被这条抓住）', () => {
  const s = call.voiceCallState()
  const parsed = SHARED.VoiceCallStateSchema.safeParse(s)
  assert.equal(parsed.success, true, `状态不符合契约：${JSON.stringify(parsed.error?.issues ?? [])}`)
  assert.deepEqual(Object.keys(parsed.data).sort(), Object.keys(s).sort())
})

// ───────────────────────────────────────────────────────── 打断与结束

test('★ 没有通话时「打断」与「结束」必须安全（幂等空操作，不抛）', () => {
  assert.equal(call.interruptVoiceCall().interrupted, false)
  assert.equal(call.stopVoiceCall('user').stopped, false)
  assert.equal(call.stopVoiceCall('user').stopped, false)
  assert.equal(call.voiceCallState().active, false)
})

test('★ 结束通话必须**必定释放朗读**（她说一半时结束，声音要立刻停）', () => {
  let stopped = 0
  voice.setVoiceTts({ speak: async () => ({ ok: true, completed: true }), stop: () => { stopped++; return true } })
  try {
    call.stopVoiceCall('user')
    assert.ok(stopped >= 1, 'stopVoiceCall 必须调用 TTS 的 stop（否则声音会继续）')
  } finally {
    voice.setVoiceTts(null)
  }
})

test('★ 没有在说话时「打断」不计数（不能把"点了下按钮"算成一次打断）', () => {
  const before = call.voiceCallState().interruptions
  const r = call.interruptVoiceCall()
  assert.equal(r.interrupted, false)
  assert.equal(call.voiceCallState().interruptions, before, '没有实际打断就不该计数')
})

// ───────────────────────────────────────────────────────── TTS 端口

test('★ 语音引擎的 TTS 端口是**注入**的（未注入时 getVoiceTts 返回 null，不抛）', () => {
  voice.setVoiceTts(null)
  assert.equal(voice.getVoiceTts(), null)
  const port = { speak: async () => ({ ok: true }), stop: () => false }
  voice.setVoiceTts(port)
  assert.equal(voice.getVoiceTts(), port)
  voice.setVoiceTts(null)
})

test('打断在没有 TTS 端口时也必须安全（不因缺端口而抛）', () => {
  voice.setVoiceTts(null)
  assert.doesNotThrow(() => call.interruptVoiceCall())
})
