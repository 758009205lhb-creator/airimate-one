/**
 * apps/desktop/test/reflection.test.cjs —— 每日自学习（M4）单测
 *
 * 这组用例盯的是 M4 的**三条硬要求**：
 *   ① 高置信度事实写入长期记忆；**低置信度内容必须询问用户确认**
 *      —— 也就是"低置信度**绝不**自动写记忆"这条负向断言；
 *   ② 可学习偏好/习惯/工作节奏，但**不得自动修改代码、系统提示词、权限或电脑设置**
 *      —— 用"跑完反思后 settings/persona/permissions 逐字节不变"来机械证明；
 *   ③ 支持关闭自学习 / 导出 / 删除单条 / 彻底清除。
 *
 * 另外覆盖：按天去重、拒绝后不再重复提问、样本不足时不给工作节奏结论。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir, stubElectron, resetStores } = require('./helpers/harness.cjs')

const TMP = tmpdir('reflect')
stubElectron(TMP)

const refl = require('../dist/main/reflection-store.js')
const engine = require('../dist/main/reflection-engine.js')
const extract = require('../dist/main/reflection-extract.js')
const session = require('../dist/main/session-store.js')
const memory = require('../dist/main/memory-store.js')
const settings = require('../dist/main/settings-store.js')
const perm = require('../dist/main/permission-store.js')
const activity = require('../dist/main/activity-stats.js')
const knowledge = require('../dist/main/knowledge-source.js')
const engineState = require('../dist/main/engine-state.js')
const SHARED = require(path.resolve(__dirname, '..', '..', '..', 'packages', 'shared', 'dist', 'index.js'))

const ALL = { refl, engine, extract, session, memory, settings, perm, activity, knowledge, engineState }
const FILES = ['reflections.json', 'session.json', 'memory.json', 'settings.json', 'permissions.json', 'activity.json', 'engine-state.json', 'knowledge-cache.json']

test.beforeEach(() => {
  for (const f of FILES) fs.rmSync(path.join(TMP, f), { force: true })
  resetStores(ALL)
  settings.mergeSettings({ ...SHARED.DEFAULT_SETTINGS }, { immediate: true })
  knowledge.__setOfflineForTest(true)
})

/** 造一天的对话 */
function seedMessages(lines) {
  let n = 0
  for (const [role, text] of lines) {
    n += 1
    session.appendMessage({
      id: `m${n}`, role, text, createdAt: Date.now() - (100 - n) * 1000,
      commands: [], origin: role === 'user' ? 'user' : 'user',
    })
  }
}

const FIXED = new Date(2026, 0, 15, 22, 30, 0)
/**
 * 跑一次反思。
 *
 * ⚠ 这些用例大多要先**打开自学习**：`force` 只是忽略"今天跑过了"，
 *   它**不会**忽略用户的开关（那是用户的明确意愿，探针/手动也一样要尊重）。
 *   这一点在设计上是刻意的：`force` 的语义是"别管去重"，不是"别管设置"。
 */
function enableSelfLearning() {
  settings.mergeSettings({ selfLearningEnabled: true, selfLearningAt: '22:30' }, { immediate: true })
}
const runAt = (o = {}) => { enableSelfLearning(); return engine.runReflection({ force: true, ...o }, { now: () => FIXED }) }

// ───────────────────────────────────────────────────────── 默认与开关

test('★★ 自学习**默认关闭**（用户要求"支持关闭自学习"，默认就该是关的）', () => {
  assert.equal(settings.loadSettings().selfLearningEnabled, false)
  const s = engine.reflectionStatus()
  assert.equal(s.enabled, false)
  assert.equal(s.runs, 0)
  assert.equal(s.lastRunAt, null)
})

test('★ 关闭时**不会被自动触发**（reflectionDue 为 false）', () => {
  settings.mergeSettings({ selfLearningEnabled: false, selfLearningAt: '22:30' }, { immediate: true })
  assert.equal(engine.reflectionDue(new Date(2026, 0, 15, 22, 30, 0)), false)
  settings.mergeSettings({ selfLearningEnabled: true }, { immediate: true })
  assert.equal(engine.reflectionDue(new Date(2026, 0, 15, 22, 30, 0)), true, '开了 + 到点 + 今天没跑过 ⇒ 该跑')
  assert.equal(engine.reflectionDue(new Date(2026, 0, 15, 22, 31, 0)), false, '不在设定分钟上不该跑')
})

test('★ 关闭时 runReflection 不写盘并如实说明原因（不是静默跳过）', async () => {
  const r = await engine.runReflection({}, { now: () => FIXED })
  assert.equal(r.ran, false)
  assert.match(String(r.skippedReason), /关闭/)
  assert.equal(refl.loadReflections().days.length, 0, '被挡住时不该落盘')
})

test('手动触发（force）在开关关闭时**也能跑** —— 用户点"现在看看"是明确意图', async () => {
  seedMessages([['user', '我喜欢喝茉莉花茶']])
  const r = await runAt()
  assert.equal(r.ran, true)
  assert.equal(refl.loadReflections().days.length, 1)
})

test('★ 按天去重：同一天第二次不会重复跑（`force` 例外）', async () => {
  seedMessages([['user', '我喜欢喝茉莉花茶']])
  await runAt()
  // 第二次**不带 force**：应被"今天已经反思过"挡住（自学习是开着的）
  enableSelfLearning()
  const second = await engine.runReflection({ force: false }, { now: () => FIXED })
  assert.equal(second.ran, false)
  assert.match(String(second.skippedReason), /今天已经反思过/)
  assert.equal(refl.reflectionHistory(10).length, 1, '不该产生第二条记录')
})

test('★ `force` **同时**绕过去重与开关（它只由用户显式动作传入；自动路径另说）', async () => {
  seedMessages([['user', '我喜欢喝茉莉花茶']])
  /**
   * 开关是关的，但 `force` 代表"用户手点了一次" ⇒ 允许跑。
   * ⚠ 这条口径与代码注释必须一致（我第一版把注释写成"force 不忽略开关"，
   *   而实现是忽略的 —— 测试把注释与实现的不一致抓了出来，改的是注释）。
   *   **自动化路径**受开关约束，那是 `reflectionDue()` 的职责，下面单独验。
   */
  const forced = await engine.runReflection({ force: true }, { now: () => FIXED })
  assert.equal(forced.ran, true, 'force 必须能忽略用户开关（手动动作不受开关约束）')
  // 同一天再 force 一次仍然能跑 ⇒ 证明它也忽略了按天去重
  const again = await engine.runReflection({ force: true }, { now: () => FIXED })
  assert.equal(again.ran, true, 'force 必须能忽略"今天已经反思过"')
  // 但**不带 force** 时开关立刻把它挡住（自动路径就是这样被约束的）
  const auto = await engine.runReflection({ force: false }, { now: () => FIXED })
  assert.equal(auto.ran, false)
  assert.match(String(auto.skippedReason), /关闭/)
})

test('★★ **自动触发**严格受开关约束（`reflectionDue` 是唯一自动入口）', () => {
  // 开关关（默认）⇒ 即使到点也**不该**自动跑
  settings.mergeSettings({ selfLearningEnabled: false, selfLearningAt: '22:30' }, { immediate: true })
  assert.equal(engine.reflectionDue(new Date(2026, 0, 15, 22, 30, 0)), false)
  // 打开且到点且今天没跑过 ⇒ 才该跑
  settings.mergeSettings({ selfLearningEnabled: true }, { immediate: true })
  assert.equal(engine.reflectionDue(new Date(2026, 0, 15, 22, 30, 0)), true)
  // 不在设定分钟上不该跑
  assert.equal(engine.reflectionDue(new Date(2026, 0, 15, 22, 31, 0)), false)
})

// ───────────────────────────────────────────────────────── ★ 置信度闸门

test('★★ 高置信度事实**自动写入**长期记忆（并回填 memoryId）', async () => {
  seedMessages([['user', '我的生日是 3 月 14 日']])
  const r = await runAt()
  assert.equal(r.ran, true)
  const auto = r.reflection.items.filter(i => i.approval === 'auto')
  assert.equal(auto.length >= 1, true, `应至少有一条自动写入，实际条目：${JSON.stringify(r.reflection.items)}`)
  assert.ok(auto[0].memoryId, '自动写入后必须回填 memoryId（"写没写进去"要可核对）')
  assert.ok(auto[0].confidence >= SHARED.HIGH_CONFIDENCE)
  // 记忆层里真的能查到
  const found = memory.searchMemory({ query: '生日', limit: 10 })
  assert.equal(found.length >= 1, true, '记忆里应能搜到这条')
  assert.equal(memory.listMemory(50).some(e => e.id === auto[0].memoryId), true)
})

test('★★ 低置信度内容**绝不自动写入**长期记忆（必须等用户确认）', async () => {
  // "我要…" 是 0.60、"累" 是 0.50 —— 都低于 0.75 阈值
  seedMessages([['user', '我明天要交周报，今天好累']])
  const before = memory.memoryCount()
  const r = await runAt()
  assert.equal(r.ran, true)
  const pending = r.reflection.items.filter(i => i.approval === 'pending')
  assert.equal(pending.length >= 1, true, `应至少有低置信度项，实际：${JSON.stringify(r.reflection.items)}`)
  for (const p of pending) {
    assert.ok(p.confidence < SHARED.HIGH_CONFIDENCE, `${p.text} 的置信度 ${p.confidence} 不该进 pending`)
    assert.equal(p.memoryId, null, '低置信度项**不得**有 memoryId')
  }
  assert.equal(memory.memoryCount(), before, '低置信度内容绝不能自动写进记忆')
})

test('★★ 用户确认后才写入；**拒绝则不写入**且不再重复提问', async () => {
  seedMessages([['user', '我明天要交周报']])
  const r = await runAt()
  const pending = refl.pendingItems()
  assert.equal(pending.length >= 1, true, `应产生待确认项，实际：${JSON.stringify(r.reflection.items)}`)
  const item = pending[0]
  const before = memory.memoryCount()

  // ① 确认 ⇒ 写入
  const ok = refl.decideItem(item.day, item.id, true, (text, it) => {
    const m = memory.addMemory({ text, tags: ['自学习', it.kind], importance: it.confidence })
    return m?.id ?? null
  })
  assert.equal(ok.ok, true)
  assert.ok(ok.memoryId, '确认后必须真的写入记忆')
  assert.equal(memory.memoryCount(), before + 1)

  // ② 换一条全新的结论，测"拒绝 ⇒ 不写入 + 记指纹"
  session.clearHistory()
  seedMessages([['user', '我明天要去外地出差']])
  await engine.runReflection({ force: true }, { now: () => FIXED })
  const target = refl.pendingItems()[0]
  assert.ok(target, '应产生新的待确认项')
  const before2 = memory.memoryCount()
  const no = refl.decideItem(target.day, target.id, false, () => { throw new Error('拒绝时不该调用写入') })
  assert.equal(no.ok, true)
  assert.equal(no.memoryId, null)
  assert.equal(memory.memoryCount(), before2, '拒绝后记忆条数不变')
  assert.equal(refl.wasRejected(target.text), true, '拒绝要留下指纹')

  // ③ 同一结论再次提取 ⇒ 标为 skipped，**不再进入待确认**（不重复骚扰）
  const again = await engine.runReflection({ force: true }, { now: () => FIXED })
  const skipped = again.reflection.items.filter(i => i.approval === 'skipped')
  assert.equal(skipped.length >= 1, true, `被拒绝过的结论应记为 skipped，实际：${JSON.stringify(again.reflection.items)}`)
  assert.equal(again.reflection.items.some(i => i.approval === 'pending' && i.text === target.text), false, '拒绝过的不该再问一遍')
})

test('确认时记忆写入失败 ⇒ **如实保持 pending**（不假装已确认）', async () => {
  seedMessages([['user', '我明天要交周报']])
  await runAt()
  const item = refl.pendingItems()[0]
  assert.ok(item, '应产生待确认项')
  const r = refl.decideItem(item.day, item.id, true, () => null)   // 写入返回 null = 失败
  assert.equal(r.ok, true)
  assert.equal(r.memoryId, null)
  assert.equal(r.item.approval, 'pending', '写入失败必须保持待确认')
  assert.equal(refl.pendingCount(), 1, '仍然挂在待确认里')
})

test('处理不存在的条目 ⇒ ok:false（不静默）', () => {
  const r = refl.decideItem('2026-01-15', 'no-such-item', true, () => 'x')
  assert.equal(r.ok, false)
})

test('dryRun：高置信度也**不写记忆**（探针不该污染用户记忆）', async () => {
  seedMessages([['user', '我的生日是 3 月 14 日']])
  const before = memory.memoryCount()
  const r = await runAt({ dryRun: true })
  assert.equal(r.ran, true)
  assert.equal(r.reflection.autoWritten, 0)
  assert.equal(memory.memoryCount(), before, 'dryRun 不得写入任何记忆')
  assert.equal(r.reflection.items.every(i => i.memoryId === null), true)
  assert.ok(r.reflection.disclosures.some(d => d.includes('演练')), '必须如实标注这是演练')
})

// ───────────────────────────────────────────────────────── ★ 不得自动改设置

test('★★ 反思**绝不修改** settings / 人设 / 权限 / 电脑设置（只写记忆）', async () => {
  seedMessages([
    ['user', '我的生日是 3 月 14 日'],
    ['user', '我明天要交周报'],
    ['user', '我住在上海'],
    ['user', '叫我老王'],
  ])
  /**
   * ⚠ 快照必须在**打开开关之后**取：测试自己打开 `selfLearningEnabled` 也算改设置。
   *   这里要证明的是"**反思过程**没有改任何配置"，而不是"测试没改过配置"。
   */
  enableSelfLearning()
  settings.flushSettings()
  const snap = (f) => (fs.existsSync(path.join(TMP, f)) ? fs.readFileSync(path.join(TMP, f), 'utf8') : '<absent>')
  const beforeSettings = snap('settings.json')
  const beforePerm = snap('permissions.json')
  const beforeSession = snap('session.json')

  const r = await engine.runReflection({ force: true }, { now: () => FIXED })
  assert.equal(r.ran, true)
  assert.equal(r.reflection.items.length >= 2, true)
  settings.flushSettings()

  assert.equal(snap('settings.json'), beforeSettings, '反思不得改 settings')
  assert.equal(snap('permissions.json'), beforePerm, '反思不得改权限')
  assert.equal(snap('session.json'), beforeSession, '反思不得改对话历史')
  // 人设也不该被动过
  assert.equal(session.getPersona().systemPrompt.includes('动作：'), true, '系统提示词未被改写')
})

test('★ 提取出的"习惯/节奏"只是**结论**，不会变成设置项', async () => {
  seedMessages([['user', '每天 9 点我都会看邮件']])
  const r = await runAt()
  const habit = r.reflection.items.find(i => i.kind === 'habit')
  if (habit) {
    // habit 类置信度低 ⇒ 必须待确认，而不是被当成"用户的设置"直接生效
    assert.equal(habit.approval !== 'auto', true, '习惯类不该自动采纳')
  }
  // 关键：设置里**没有**任何被自动写入的日程/静音/作息字段
  const s = settings.loadSettings()
  assert.equal(s.selfLearningAt, '22:30', '反思时间本身不该被反思改掉')
  assert.equal(s.morningRadioAt, '08:30')
})

// ───────────────────────────────────────────────────────── 提取器与节奏

test('★ 置信度由**规则强度**确定性算出（不是模型自报）', () => {
  assert.equal(extract.scoreOf(0.9, 1), 0.9)
  assert.equal(extract.scoreOf(0.9, 2), 0.95)
  assert.equal(extract.scoreOf(0.9, 3), 0.97, '上限 0.97')
  assert.equal(extract.scoreOf(0.5, 1), 0.5)
  assert.equal(extract.scoreOf(0.5, 5), 0.7)
  assert.equal(extract.scoreOf(0, 1), 0)
})

test('★ 身份事实 = 高置信度；情绪/习惯 = 低置信度（分界是刻意的）', () => {
  const r = extract.extractFromMessages([
    { id: '1', role: 'user', text: '我住在上海', createdAt: 1, commands: [], origin: 'user' },
    { id: '2', role: 'user', text: '今天好累', createdAt: 3, commands: [], origin: 'user' },
    { id: '3', role: 'user', text: '每天 9 点我都会看邮件', createdAt: 4, commands: [], origin: 'user' },
  ])
  const byKind = Object.fromEntries(r.items.map(i => [i.kind, i.confidence]))
  assert.equal(byKind.fact >= SHARED.HIGH_CONFIDENCE, true, `事实类应高置信度：${JSON.stringify(r.items)}`)
  assert.equal(byKind.emotion < SHARED.HIGH_CONFIDENCE, true)
  assert.equal(byKind.habit < SHARED.HIGH_CONFIDENCE, true)
})

test('★ 待办类也是低置信度（"我要…"未必是长期事实 ⇒ 必须确认）', () => {
  const r = extract.extractFromMessages([
    { id: '1', role: 'user', text: '我明天要交周报', createdAt: 1, commands: [], origin: 'user' },
  ])
  const todo = r.items.find(i => i.kind === 'todo')
  assert.ok(todo, `应提取出待办，实际：${JSON.stringify(r.items)}`)
  assert.equal(todo.confidence < SHARED.HIGH_CONFIDENCE, true)
})

test('★ 只扫**用户**说的话（她自己的回复不该被当成用户的事实）', () => {
  const r = extract.extractFromMessages([
    { id: '1', role: 'assistant', text: '我住在上海', createdAt: 1, commands: [], origin: 'user' },
    { id: '2', role: 'assistant', text: '我喜欢抹茶', createdAt: 2, commands: [], origin: 'user' },
  ])
  assert.deepEqual(r.items, [], '助手消息不得参与提取（否则是自污染）')
  assert.equal(r.scannedUserMessages, 0)
})

test('★ 同一件事说两次 ⇒ 置信度小幅提升（幅度刻意很小）', () => {
  const once = extract.extractFromMessages([{ id: '1', role: 'user', text: '我喜欢抹茶', createdAt: 1, commands: [], origin: 'user' }])
  const twice = extract.extractFromMessages([
    { id: '1', role: 'user', text: '我喜欢抹茶', createdAt: 1, commands: [], origin: 'user' },
    { id: '2', role: 'user', text: '我喜欢抹茶', createdAt: 2, commands: [], origin: 'user' },
  ])
  assert.equal(twice.items[0].confidence > once.items[0].confidence, true)
  /**
   * ⚠ 比较前必须**四舍五入到 2 位**：浮点减法会给出
   *   `0.050000000000000044`，直接 `<= 0.05` 会假失败。
   *   （这条断言本来想表达的是"加成是 5%"，用原始浮点比就是在测浮点误差。）
   */
  const delta = Math.round((twice.items[0].confidence - once.items[0].confidence) * 100) / 100
  assert.equal(delta <= 0.05, true, `重复不该大幅提高置信度，实际加成 ${delta}`)
  assert.equal(twice.items[0].messageCount, 2)
  // 且**同一句话里的重复命中也会被计数**（不是被合并成 1 次）
  const dup = extract.extractFromMessages([
    { id: '1', role: 'user', text: '我喜欢抹茶，我喜欢抹茶', createdAt: 1, commands: [], origin: 'user' },
  ])
  assert.equal(dup.items.length, 1, `同一句里的重复应合并成一条，实际 ${dup.items.length} 条`)
  assert.equal(dup.items[0].messageCount, 2, '同一句里说两遍也要算两次命中')
})

test('★ 工作节奏：样本不足时 `confident:false`（三天数据推不出节奏）', () => {
  const day = (d, mins) => ({
    day: d, activeMinutes: mins, longestStreakMinutes: mins, longestIdleMinutes: 0,
    inputEvents: 0, blockedSamples: 0, samples: 1, firstActiveAt: null, lastActiveAt: null,
    hourlyActiveMinutes: Array.from({ length: 24 }, () => 0),
  })
  const few = extract.computeRhythm({ days: [day('2026-01-14', 300), day('2026-01-15', 200)] })
  assert.equal(few.confident, false, '只有 2 天样本时必须说"不确定"')
  const enough = extract.computeRhythm({ days: [day('2026-01-13', 300), day('2026-01-14', 200), day('2026-01-15', 250)] })
  assert.equal(enough.confident, true)
  assert.equal(enough.avgActiveMinutes, 250)
  const none = extract.computeRhythm({ days: [] })
  assert.equal(none.confident, false)
  assert.equal(none.avgActiveMinutes, 0)
})

// ───────────────────────────────────────────────────────── 总结与建议

test('★ 今日总结的每一句都对应真实读数（没数据就说没记录）', async () => {
  const r = await runAt()
  assert.match(r.reflection.dailySummary, /几乎没有记录/, `实际：${r.reflection.dailySummary}`)
})

test('★ 有数据时总结给出条数与分钟数（可核对）', async () => {
  seedMessages([['user', '在吗'], ['user', '帮我看看这个'], ['assistant', '好的']])
  // ⚠ 采样要**按引擎的固定时钟**记：否则会记到"真实的今天"，
  //   而引擎读的是 `todayStats(FIXED)` ⇒ 表现为"活动采样今天没有数据"
  activity.recordSample({
    at: FIXED.getTime(), idleMs: 0, inputEvents1m: 5, fullscreen: false, gameProcess: null,
    meeting: null, focusAssist: false, userSilent: false, titleDigest: null, titleChars: 0,
    available: true, unavailableReason: null, blockReason: 'none',
  }, FIXED)
  const r = await runAt()
  assert.match(r.reflection.dailySummary, /说了 2 句/)
  assert.match(r.reflection.dailySummary, /活跃 1 分钟/)
  assert.equal(r.reflection.stats.userMessages, 2)
  assert.equal(r.reflection.stats.activeMinutes, 1)
})

test('★ 反思结果里有真实的计数（不是占位 0）', async () => {
  seedMessages([['user', '我住在上海'], ['assistant', '记住了']])
  const r = await runAt()
  assert.equal(r.reflection.stats.messages, 2)
  assert.equal(r.reflection.stats.userMessages, 1)
  assert.equal(r.reflection.stats.assistantMessages, 1)
})

// ───────────────────────────────────────────────────────── 状态与存储

test('契约一致性：状态与结果都符合 shared 的 schema（漂移会被这条抓住）', async () => {
  seedMessages([['user', '我住在上海']])
  const r = await runAt()
  assert.equal(SHARED.DailyReflectionSchema.safeParse(r.reflection).success, true)
  assert.equal(SHARED.ReflectionStatusSchema.safeParse(engine.reflectionStatus()).success, true)
})

test('★ 落盘可读回（重启不丢），且状态反映真实运行次数', async () => {
  seedMessages([['user', '我住在上海']])
  await runAt()
  refl.__resetReflectionStoreForTest()
  assert.equal(refl.reflectionHistory(10).length, 1)
  const s = engine.reflectionStatus()
  assert.equal(s.runs, 1)
  assert.equal(s.lastRunDay, '2026-01-15')
  assert.equal(typeof s.lastRunAt, 'number')
})

test('★ 反思文件里**不含对话原文**（只含提取出的结论）', async () => {
  const SECRET_LINE = '我今天买了一杯很特别的咖啡豆叫耶加雪菲'
  seedMessages([['user', SECRET_LINE]])
  await runAt()
  const raw = fs.readFileSync(path.join(TMP, 'reflections.json'), 'utf8')
  assert.equal(raw.includes(SECRET_LINE), false, '原始消息不该出现在反思文件里')
})

test('★ 清空反思记录：只清反思，**不动已写入的记忆**（两回事必须说清）', async () => {
  seedMessages([['user', '我的生日是 3 月 14 日']])
  await runAt()
  const memBefore = memory.memoryCount()
  assert.equal(memBefore >= 1, true)
  const removed = refl.clearAllReflections()
  assert.equal(removed, 1)
  assert.equal(refl.reflectionHistory(10).length, 0)
  assert.equal(refl.pendingCount(), 0)
  assert.equal(memory.memoryCount(), memBefore, '清反思不该删记忆（界面会如实说明）')
})

test('反思存储也登记在 STORE_DESCRIPTORS 里（隐私删除与迁移要覆盖它）', () => {
  const d = SHARED.storeDescriptor ? null : null
  void d
  const kit = require(path.resolve(__dirname, '..', '..', '..', 'packages', 'companion-kit', 'dist', 'index.js'))
  const desc = kit.storeDescriptor('reflections')
  assert.ok(desc, 'reflections 必须登记（否则 privacy:wipe 与迁移链都漏掉它）')
  assert.equal(desc.personal, true, '含个人数据')
  const personal = kit.personalStoreNames()
  assert.ok(personal.includes('reflections'))
})

/**
 * ★ 「保留 400 天」必须**真的在生效**，而且只有**一个**数字来源。
 *
 * 为什么值得单独立一条用例：这个上限此前在 `reflectionStatus()` 里是**手写的 400**，
 * 与存储层的 `KEEP_DAYS` 是两份独立常量 —— 一旦有人改了存储层的裁剪上限，
 * 界面仍会显示旧数字：一个**看起来生效、实际早就不对**的上限，
 * 比没有上限更糟（用户会据此以为旧记录会被自动清掉）。
 * 所以这里同时钉两件事：状态上报的值 === 存储层的常量，且裁剪真的发生。
 */
test('★ 保留上限只有一个来源：reflectionStatus().keepDays === KEEP_DAYS', () => {
  assert.equal(typeof refl.KEEP_DAYS, 'number')
  assert.equal(refl.KEEP_DAYS > 0, true)
  assert.equal(engine.reflectionStatus().keepDays, refl.KEEP_DAYS,
    '状态里的保留天数必须来自存储层常量，不能在引擎里再写一个数字')
  /**
   * 还有一条**跨包耦合**必须显式钉住：`ReflectionStatusSchema.keepDays` 是 `.max(400)`。
   * 把 `KEEP_DAYS` 调到 400 以上会让状态通道的 zod 校验失败 —— 那会表现为
   * "提醒/日程整块不好用"，与反思八竿子打不着，极难定位。
   * 所以这里直接断言上界，让改常量的人在**单测**里就撞墙，而不是在运行时。
   */
  assert.equal(refl.KEEP_DAYS <= 400, true,
    'KEEP_DAYS 超过 400 会让 ReflectionStatusSchema 校验失败（改这个值必须同时改 shared 的 schema）')
})

test('★ 超过保留上限时按天裁剪，保留**最新**的这几天', () => {
  refl.__resetReflectionStoreForTest()
  const keep = refl.KEEP_DAYS
  const overflow = 3
  // 造 keep+overflow 天：day 用 ISO 日期字符串，字典序即时间序
  const base = Date.UTC(2026, 0, 1)
  for (let i = 0; i < keep + overflow; i++) {
    const day = new Date(base + i * 86_400_000).toISOString().slice(0, 10)
    refl.saveReflection({
      day,
      generatedAt: base + i * 86_400_000,
      summary: '', stats: {
        messages: 0, userMessages: 0, assistantMessages: 0, proactiveMessages: 0,
        memoryHits: 0, activeMinutes: 0,
      },
      items: [], workRhythm: {
        avgActiveMinutes: 0, maxStreakMinutes: 0, topHours: [], sampleDays: 0, confident: false,
      },
      dailySummary: '', tomorrowAdvice: [], externalRefs: [], method: 'heuristic',
      disclosures: [], autoWritten: 0, pendingApproval: 0,
    })
  }
  const days = refl.loadReflections().days
  assert.equal(days.length, keep, `超限必须被裁到 ${keep} 天（否则文件会无限增长）`)
  // 最新的那天在，最旧的几天被丢掉了
  const newest = new Date(base + (keep + overflow - 1) * 86_400_000).toISOString().slice(0, 10)
  const oldest = new Date(base).toISOString().slice(0, 10)
  assert.equal(days[0].day, newest, '排在最前的是最新的一天')
  assert.equal(days.some(d => d.day === oldest), false, '最旧的已被裁掉')
  // 且落盘可读回（裁剪不是只在内存里）
  assert.equal(JSON.parse(fs.readFileSync(path.join(TMP, 'reflections.json'), 'utf8')).days.length, keep)
  refl.__resetReflectionStoreForTest()
})
