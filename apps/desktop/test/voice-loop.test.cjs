/**
 * apps/desktop/test/voice-loop.test.cjs —— STT → LLM → TTS 闭环的**端到端单测**（A4）
 *
 * 为什么要有这个文件（用户 2026-10-06 裁定 A4「做闭环」）：
 *   闭环的两端是**麦克风与扬声器**，所以"听→想→说 真的接通了"这件事，
 *   此前只能靠人工拿麦克风试 ⇒ 它一直停在"未验证"里（M3 就是这么过来的）。
 *
 *   本文件把两端换成**脚本化的假件**：
 *     · 语音输入 → `__setVoiceIoForTest({ listenOnce })`（按序喂句子）；
 *     · 模型输出 → 替换 `globalThis.fetch`（回一段 SSE）；
 *     · 朗读     → `voice.setVoiceTts(...)`（可控的假 TTS）。
 *   于是一条完整的"唤醒 → 听到 → 问模型 → 朗读 → 打断"链路可以在**毫秒级**跑穿，
 *   而且每一步都可断言。**生产路径不受影响**（默认值就是真实实现）。
 *
 * ⚠ 这个文件测的是**接线**，不是"识别准不准/模型好不好"：
 *   那些需要真实设备与真实模型，仍然属于未验证项。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir, stubElectron, resetStores } = require('./helpers/harness.cjs')

const TMP = tmpdir('vloop')
stubElectron(TMP)

const call = require('../dist/main/voice-call.js')
const voice = require('../dist/main/voice-engine.js')
const settings = require('../dist/main/settings-store.js')
const providers = require('../dist/main/provider-store.js')
const secrets = require('../dist/main/secrets-store.js')
const session = require('../dist/main/session-store.js')
const SHARED = require(path.resolve(__dirname, '..', '..', '..', 'packages', 'shared', 'dist', 'index.js'))

const ALL = { call, voice, settings, providers, secrets, session }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 等到条件成立或超时（**超时即失败**，绝不静默放过） */
async function waitFor(fn, ms = 2000, what = '条件') {
  const t0 = Date.now()
  for (;;) {
    if (fn()) return true
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${what}`)
    await sleep(10)
  }
}

/** 替换 fetch：回一段 OpenAI 兼容的 SSE（内容是固定文本，不发真实请求） */
function stubFetch(replyText, { onCall } = {}) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    onCall?.(String(url), init)
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: replyText } }] })}\n\n`))
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return () => { globalThis.fetch = original }
}

/**
 * 可中断的假 IO：按脚本依次喂句子，用完之后**一直"沉默"直到被 abort**。
 *
 * ⚠ 两个细节都是实测踩出来的：
 *   ① 用完之后**不能立刻返回**空句 —— 那会变成"静音轮"无限空转（CPU 打满、测试卡死）；
 *      正确做法是"挂着等 abort"，模拟真实 `listenOnce` 等一句 16 秒的行为。
 *   ② **必须监听 `opts.signal`**：`speakReply` 会在朗读结束后 abort 掉并发的那个"听"。
 *      注入件不理会 abort 的话，它自己的定时器会一直吊着事件循环 ⇒ 测试进程不退出。
 */
function makeFakeListen(script, { idleMs = 300_000 } = {}) {
  const calls = { n: 0 }
  const listenOnce = async (opts = {}) => {
    const idx = calls.n
    calls.n += 1
    if (idx < script.length) {
      const item = script[idx]
      if (item?.fire) item.fire()
      return item?.result ?? { ok: true, text: item?.text ?? '', confidence: 0.9, isWake: false, reason: null }
    }
    // 脚本用完：挂着，直到被 abort
    await new Promise((resolve) => {
      const t = setTimeout(resolve, idleMs)
      t.unref?.()
      if (opts.signal?.aborted) { clearTimeout(t); resolve(); return }
      opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    })
    return { ok: true, text: '', confidence: 0, isWake: false, reason: null }
  }
  return { listenOnce, calls }
}

/** 配好"能通话"的最小前置：供应商 + 密钥 + 两个开关 */
function makeReady() {
  const p = providers.upsertProvider({
    label: 'ds', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
  })
  secrets.secretStore().set(p.id, 'sk-test-000000000000')
  settings.mergeSettings({ hearingEnabled: true, ttsEnabled: true, wakeWordEnabled: true }, { immediate: true })
  voice.setVoiceConfig({ wakeWordEnabled: true, wakeWord: '你好助手' })
  return p
}

test.beforeEach(() => {
  for (const f of ['settings.json', 'providers.json', 'session.json', 'memory.json']) {
    fs.rmSync(path.join(TMP, f), { force: true })
  }
  fs.rmSync(path.join(TMP, 'secrets'), { recursive: true, force: true })
  resetStores(ALL)
  settings.mergeSettings({ ...SHARED.DEFAULT_SETTINGS }, { immediate: true })
  call.__resetVoiceCallForTest()
  voice.setVoiceTts(null)
})

// ───────────────────────────────────────────────────── 桥：那条线真的接上了

test('★★ installVoiceCallBridge 之后 bridgeInstalled 为真（原来的实现是"只求值参数"的空壳）', () => {
  assert.equal(call.voiceClosedLoopStatus().bridgeInstalled, false, '接线前必须如实为 false')
  call.installVoiceCallBridge()
  const s = call.voiceClosedLoopStatus()
  assert.equal(s.bridgeInstalled, true, '接线后必须为 true')
  assert.equal(s.recognizedCount, 0, '「接上了」与「跑过东西」是两件事：计数此时仍应为 0')
})

test('★ 识别正文经 voice-engine 的订阅真的到达了消费者（recognizedCount 会涨）', () => {
  call.installVoiceCallBridge()
  const before = call.voiceClosedLoopStatus().recognizedCount
  /**
   * ⚠ 这里用**真实的引擎出口**（不是注入件）验证订阅是活的：
   *   前一条测试只证明"接上了"，这一条证明"线上真的能过东西"。
   */
  voice.__fireRecognizedTextForTest('一句普通的话', false)
  const after = call.voiceClosedLoopStatus().recognizedCount
  assert.equal(after, before + 1, '引擎报出一句话之后计数必须 +1（否则订阅是死的）')
})

// ───────────────────────────────────────────────────── 待机听唤醒：两道硬前置

test('★★ 待机监听的两道硬前置：识别未启用 ⇒ 拒绝', () => {
  const r = call.startWakeWatch()
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /语音识别未启用/)
  assert.equal(call.voiceClosedLoopStatus().wakeWatchRunning, false, '被拒时绝不能处于运行态')
})

test('★★ 识别开了但**唤醒未启用** ⇒ 仍然拒绝（默认关闭，必须用户显式打开）', () => {
  settings.mergeSettings({ hearingEnabled: true, wakeWordEnabled: false }, { immediate: true })
  const r = call.startWakeWatch()
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /唤醒未启用/)
  assert.equal(call.voiceClosedLoopStatus().wakeWatchRunning, false)
})

test('★ 两个开关都开 ⇒ 待机监听可以开始；stopWakeWatch 幂等', () => {
  settings.mergeSettings({ hearingEnabled: true, wakeWordEnabled: true }, { immediate: true })
  const fake = makeFakeListen([])
  call.__setVoiceIoForTest({ listenOnce: fake.listenOnce })
  const r = call.startWakeWatch()
  assert.equal(r.ok, true, `实际拒绝原因：${r.reason}`)
  assert.equal(call.voiceClosedLoopStatus().wakeWatchRunning, true)
  assert.equal(call.stopWakeWatch('user').stopped, true)
  assert.equal(call.stopWakeWatch('user').stopped, false, '第二次停止必须是安全空操作')
  assert.equal(call.voiceClosedLoopStatus().wakeWatchRunning, false)
})

test('★★ 设置关掉任一开关 ⇒ reconcile 必须把待机监听停掉（不能"显示关了、麦克风还开着"）', () => {
  makeReady()
  const fake = makeFakeListen([])
  call.__setVoiceIoForTest({ listenOnce: fake.listenOnce })
  assert.equal(call.reconcileWakeWatch().running, true)
  settings.mergeSettings({ hearingEnabled: false }, { immediate: true })
  const r = call.reconcileWakeWatch()
  assert.equal(r.shouldRun, false)
  assert.equal(r.running, false)
  assert.equal(call.voiceClosedLoopStatus().wakeWatchRunning, false)
})

// ───────────────────────────────────────────────────── 唤醒词真的能开始对话

test('★★ 待机期间听到唤醒词 ⇒ **打开对话框**并请求进入「听」状态（2026-10-06 本轮规格）', async () => {
  makeReady()
  const notices = []
  call.onCallNotice(n => notices.push(n))

  /**
   * ⚠ 判据在**本轮「桌宠对话框 + 语音说话」里被改写过**，这里如实记录：
   *
   *   旧行为（2026-10-06 A4）：唤醒词 ⇒ 直接 `startVoiceCall()`（STT→LLM→TTS 全链路通话）。
   *   新行为（本轮规格 §二.4）：唤醒词 ⇒ **先打开对话框**，由对话坞去调
   *     **已有的** `voice:listen-once` 进入"听"状态，识别到的话走**同一条** `ask()` 发送链。
   *
   *   为什么改：主界面已经不是"文字流水面板"了，唤醒词只起一个后台通话循环、
   *   界面上什么都不出现，等于把对话藏了起来。
   *   为什么**不**同时起通话：两个循环会**抢麦克风**（`runWakeWatch` 的注释里记过这个坑），
   *   所以两条分支必须二选一 —— 这里断言"没有起通话"，是在证明**只有一个麦克风消费者**。
   *
   *   ⚠ 归到本轮的**未验证项**：真实麦克风说唤醒词的端到端行为需要真实设备，
   *     本条只验证"引擎报出唤醒词 ⇒ 打开对话并被请求进入听状态"这条接线。
   */
  const fake = makeFakeListen([
    { fire: () => voice.__fireRecognizedTextForTest('你好助手', true), result: { ok: true, text: '', confidence: 0.9, isWake: true, reason: null } },
  ])
  call.__setVoiceIoForTest({ listenOnce: fake.listenOnce })
  // 注入"打开对话成功"（单测无窗口，真实实现走的是 panel 分支；这里显式表达意图）
  const opened = []
  call.__setConversationOpenerForTest(() => { opened.push(Date.now()); return { ok: true, reason: null } })

  assert.equal(call.startWakeWatch().ok, true)
  await waitFor(() => opened.length > 0, 2000, '唤醒词之后对话框被请求打开')
  await waitFor(() => notices.some(n => n.kind === 'wake-activated'), 2000, 'wake-activated 事件')
  const wakeNotice = notices.find(n => n.kind === 'wake-activated')
  assert.match(String(wakeNotice.detail), /对话框/, `提示里必须说清"打开的是对话框"：${wakeNotice.detail}`)
  assert.equal(call.voiceCallState().active, false, '不得同时起全链路通话（两个麦克风消费者）')
  call.stopWakeWatch('test')
})

test('★★ 对话框打不开时 ⇒ **回退**到全链路通话（本轮新增的失败分支，必须有验证）', async () => {
  makeReady()
  const notices = []
  call.onCallNotice(n => notices.push(n))

  const fake = makeFakeListen([
    { fire: () => voice.__fireRecognizedTextForTest('你好助手', true), result: { ok: true, text: '', confidence: 0.9, isWake: true, reason: null } },
  ])
  call.__setVoiceIoForTest({ listenOnce: fake.listenOnce })
  // 模拟"窗口正在拖拽 ⇒ 对话布局被拒绝"（真实拒绝原因见 conversation.ts）
  call.__setConversationOpenerForTest(() => ({ ok: false, reason: 'dragging' }))

  assert.equal(call.startWakeWatch().ok, true)
  await waitFor(() => call.voiceCallState().active === true, 2000, '回退到通话')
  const wakeNotice = notices.find(n => n.kind === 'wake-activated')
  assert.ok(wakeNotice, '必须有一条 wake-activated 事件')
  assert.match(String(wakeNotice.detail), /dragging/, '提示里必须带上**真实的**拒绝原因，不许含糊')
  assert.equal(call.voiceClosedLoopStatus().wakeWatchRunning, false, '通话开始后待机监听必须让出麦克风')
  call.stopVoiceCall('test')
})

// ───────────────────────────────────────────────────── 闭环：听 → 想 → 说

test('★★★ 完整闭环：听到一句 → 问模型（SSE）→ 朗读回复 → 落进对话历史', async () => {
  makeReady()
  const restore = stubFetch('我听见了。')
  const spoken = []
  voice.setVoiceTts({
    speak: async (text) => { spoken.push(text); return { ok: true, completed: true } },
    stop: () => true,
  })
  const fake = makeFakeListen([{ text: '今天天气怎么样' }])
  call.__setVoiceIoForTest({ listenOnce: fake.listenOnce })
  try {
    assert.equal(call.startVoiceCall().ok, true)
    await waitFor(() => call.voiceCallState().turnsCompleted >= 1, 3000, '完成一轮对话')
    const s = call.voiceCallState()
    assert.equal(s.turnsCompleted, 1)
    assert.equal(s.lastHeardChars, '今天天气怎么样'.length, '只记长度，不存正文')
    assert.deepEqual(spoken, ['我听见了。'], 'TTS 必须收到模型回复的正文')
    assert.equal(s.lastSpokeChars, '我听见了。'.length)
    // 语音说过的话必须进同一份对话历史（否则"语音里的她"与"打字里的她"是两个人）
    const sess = session.loadSession()
    const texts = (sess.messages ?? []).map(m => m.text)
    assert.ok(texts.includes('今天天气怎么样'), `用户那句没进历史：${JSON.stringify(texts)}`)
    assert.ok(texts.includes('我听见了。'), `回复没进历史：${JSON.stringify(texts)}`)
  } finally {
    call.stopVoiceCall('test')
    restore()
  }
})

test('★ 静音轮（VAD 判无人说话）要**计数并上报**，而不是静默循环（"没反应"必须有解释）', async () => {
  makeReady()
  const notices = []
  call.onCallNotice(n => notices.push(n))
  const fake = makeFakeListen([{ text: '   ' }, { text: '   ' }, { text: '   ' }])
  call.__setVoiceIoForTest({ listenOnce: fake.listenOnce })
  assert.equal(call.startVoiceCall().ok, true)
  await waitFor(() => call.voiceCallState().silenceTurns >= 1, 2000, '静音轮计数')
  assert.ok(notices.some(n => n.kind === 'silence'))
  call.stopVoiceCall('test')
})

test('★ 识别失败**不结束通话**（下一轮再试），且原因如实上报', async () => {
  makeReady()
  const notices = []
  call.onCallNotice(n => notices.push(n))
  const fake = makeFakeListen([
    { result: { ok: false, text: '', confidence: 0, isWake: false, reason: '识别器忙' } },
  ])
  call.__setVoiceIoForTest({ listenOnce: fake.listenOnce })
  assert.equal(call.startVoiceCall().ok, true)
  await waitFor(() => call.voiceCallState().lastError === '识别器忙', 2000, '错误原因上报')
  assert.equal(call.voiceCallState().active, true, '一次识别失败不该结束整通通话')
  assert.ok(notices.some(n => n.kind === 'error'))
  call.stopVoiceCall('test')
})

// ───────────────────────────────────────────────────── 打断（barge-in）

test('★★ 说话时听到用户开口 ⇒ 立刻打断（tts.stop + 计数 + 事件）', async () => {
  makeReady()
  settings.mergeSettings({ voiceBargeIn: true }, { immediate: true })
  const restore = stubFetch('这是一段很长的回复，她还在说。')
  let stopCalls = 0
  voice.setVoiceTts({
    // 朗读要"很久"：这样并发的"听"一定先有结果
    speak: async () => { await sleep(3000); return { ok: true, completed: true } },
    stop: () => { stopCalls += 1; return true },
  })
  const fake = makeFakeListen([
    { text: '讲个长故事' },   // ① 用户的请求
    { text: '等一下' },       // ② 用户在**她说话时**开口（这一条由并发的那次 listen 读到）
  ])
  call.__setVoiceIoForTest({ listenOnce: fake.listenOnce })
  try {
    assert.equal(call.startVoiceCall().ok, true)
    await waitFor(() => call.voiceCallState().bargeInInterruptions >= 1, 4000, 'barge-in 打断')
    const s = call.voiceCallState()
    assert.ok(stopCalls >= 1, '打断必须真的调 tts.stop（否则声音继续）')
    assert.ok(s.interruptions >= 1, '打断次数必须计数')
    assert.equal(s.active, true, '打断不是结束通话')
  } finally {
    call.stopVoiceCall('test')
    restore()
  }
})

test('★★ barge-in **默认关闭**（自己把自己打断的声学风险不能替用户默认打开）', () => {
  const s = SHARED.DEFAULT_SETTINGS
  assert.equal(s.voiceBargeIn, false, '默认必须是 false —— 扬声器声音可能被自己的麦克风收进去')
  assert.equal(call.voiceClosedLoopStatus().bargeInEnabled, false)
})

test('barge-in 关闭时，说话期间**不会**因为"听到东西"而打断', async () => {
  makeReady()
  settings.mergeSettings({ voiceBargeIn: false }, { immediate: true })
  const restore = stubFetch('短回复。')
  voice.setVoiceTts({ speak: async () => ({ ok: true, completed: true }), stop: () => true })
  const fake = makeFakeListen([{ text: '你好' }, { text: '我说点什么' }])
  call.__setVoiceIoForTest({ listenOnce: fake.listenOnce })
  try {
    assert.equal(call.startVoiceCall().ok, true)
    await waitFor(() => call.voiceCallState().turnsCompleted >= 1, 3000, '完成一轮')
    assert.equal(call.voiceCallState().bargeInInterruptions, 0, '关闭时不该有 barge-in 打断')
  } finally {
    call.stopVoiceCall('test')
    restore()
  }
})

// ───────────────────────────────────────────────────── 状态投影与契约

test('★ 闭环状态投影**只有布尔与计数**（不含任何识别正文或回复）', () => {
  const s = call.voiceClosedLoopStatus()
  const json = JSON.stringify(s)
  assert.equal(/(今天|天气|回复|text)/.test(json.replace(/"(listen|think|speak|activate)"/g, '')), false, `投影里不该出现正文类字段：${json}`)
  for (const k of ['bridgeInstalled', 'wakeWatchRunning', 'bargeInEnabled', 'recognizedCount', 'bargeInInterruptions', 'stages']) {
    assert.ok(k in s, `缺少字段 ${k}`)
  }
})

test('★ 通话状态与契约**逐键一致**（新增 5 个字段后仍然对得上）', () => {
  const s = call.voiceCallState()
  const parsed = SHARED.VoiceCallStateSchema.safeParse(s)
  assert.equal(parsed.success, true, `状态不符合契约：${JSON.stringify(parsed.error?.issues ?? [])}`)
  assert.deepEqual(Object.keys(parsed.data).sort(), Object.keys(s).sort(), '运行态与 schema 的键集合必须完全一致')
})

test('★ 老证据文件（没有新字段）仍能解析 —— 新增字段必须带 default', () => {
  const legacy = {
    active: false, phase: 'idle', turn: 0, turnsCompleted: 0,
    lastHeardChars: null, lastSpokeChars: null, interruptions: 0, silenceTurns: 0,
    lastError: null, startedAt: null,
  }
  const parsed = SHARED.VoiceCallStateSchema.safeParse(legacy)
  assert.equal(parsed.success, true, '旧形状必须仍可解析，否则历史证据读不出来')
  assert.equal(parsed.data.wakeWatchRunning, false)
  assert.equal(parsed.data.recognizedCount, 0)
})

test('★ 闭环四段的"具备条件"读数如实：默认全 false，配好后 listen/think/speak 为真', () => {
  const before = call.voiceClosedLoopStatus().stages
  assert.equal(before.listen, false)
  assert.equal(before.think, false)
  assert.equal(before.speak, false)
  assert.equal(before.activate, false)
  makeReady()
  const after = call.voiceClosedLoopStatus().stages
  assert.equal(after.listen, true)
  assert.equal(after.think, true, '有供应商 ⇒ "想"这一段具备条件')
  assert.equal(after.speak, true)
  assert.equal(after.activate, true, '识别 + 唤醒都开 ⇒ "能被唤醒启动"具备条件')
})
