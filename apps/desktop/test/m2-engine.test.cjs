/**
 * apps/desktop/test/m2-engine.test.cjs —— M2 主动引擎的**调度逻辑**单测
 *
 * 为什么这些一定要有单测：引擎的行为是"大部分时候什么都不做，偶尔做一件对的事"。
 * 端到端只能看到"有没有弹窗"，看不到"为什么没弹""是不是重复弹了""冷却有没有生效"。
 * 这里把 `runTick()` 用**注入的假时钟 + 假采样器**跑穿，逐条钉死判据：
 *
 *   · 阻断时**只进队列，不弹窗不发声不抢焦点**（用户硬约束）
 *   · 阻断结束后**补发**（提醒不丢）
 *   · 冷却 / 按天去重 / 状态机三层防重复触发
 *   · 各能力开关关掉之后**连队列都不进**
 *   · 采样不可用时**保守处理**（视为不可打扰）
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir, stubElectron, resetStores } = require('./helpers/harness.cjs')

const TMP = tmpdir('m2engine')
stubElectron(TMP)

const engine = require('../dist/main/proactive-engine.js')
const rem = require('../dist/main/reminder-store.js')
const quiet = require('../dist/main/quiet-store.js')
const sched = require('../dist/main/schedule-store.js')
const engineState = require('../dist/main/engine-state.js')
const activity = require('../dist/main/activity-stats.js')
const settingsStore = require('../dist/main/settings-store.js')
const knowledge = require('../dist/main/knowledge-source.js')
const SHARED = require(path.resolve(__dirname, '..', '..', '..', 'packages', 'shared', 'dist', 'index.js'))

const ALL = { engine, rem, quiet, sched, engineState, activity, settingsStore, knowledge }

test.beforeEach(() => {
  for (const f of ['reminders.json', 'quiet-hours.json', 'schedules.json', 'engine-state.json', 'activity.json', 'settings.json', 'knowledge-cache.json']) {
    fs.rmSync(path.join(TMP, f), { force: true })
  }
  resetStores(ALL)
  // 设置也要重置成默认（前一个用例可能关了某个开关）
  settingsStore.mergeSettings({ ...SHARED.DEFAULT_SETTINGS }, { immediate: true })
  /**
   * ★ 单测**绝不出网**。
   * 早安电台会去抓天气与资讯；如果测试真打外网，就会 (a) 每个用例慢数秒、
   * (b) 结果随网络波动而假失败、(c) 离线环境直接挂。
   * 而"没有数据时如实标注而不是编造"恰恰是**离线**才能稳定验证的判据。
   */
  knowledge.__setOfflineForTest(true)
})

// ───────────────────────────────────────────────────────── 测试夹具

/** 造一个可控的活动状态 */
function act(o = {}) {
  return {
    at: Date.now(), idleMs: 0, inputEvents1m: 1, fullscreen: false, gameProcess: null,
    meeting: null, focusAssist: false, userSilent: false, titleDigest: null, titleChars: 0,
    available: true, unavailableReason: null, blockReason: 'none', ...o,
  }
}

/**
 * 造一份可控的依赖。
 * `at` 固定了"现在几点"（引擎内部的时间判定全部走 `now()`）。
 */
function deps(o = {}) {
  const emitted = []
  const spoken = []
  let activityValue = o.activity ?? act()
  const fixedNow = o.now ?? new Date(2026, 0, 1, 9, 0, 0)
  return {
    emitted,
    spoken,
    setActivity: (a) => { activityValue = a },
    deps: {
      settings: () => settingsStore.loadSettings(),
      patchSettings: (p) => { settingsStore.patchSettings(p) },
      sample: async () => activityValue,
      emit: (e) => { emitted.push(e) },
      speak: async (text, id) => { spoken.push({ text, id }) },
      ready: async () => o.ready ?? { network: true, provider: true, detail: 'test' },
      now: () => fixedNow,
      tickMs: 1000,
      maxQueue: o.maxQueue ?? 50,
    },
  }
}

// ───────────────────────────────────────────────────────── 就绪与问候

test('开机问候：就绪后送达一次，且**同一天不重复**（去重落在 engine-state 上）', async () => {
  const h = deps()
  const r1 = await engine.runTick(h.deps)
  assert.equal(h.emitted.length, 1, '第一次 tick 应送出问候')
  assert.equal(h.emitted[0].kind, 'greeting')
  assert.equal(h.emitted[0].focus, false, '永不抢焦点')
  assert.ok(r1.delivered >= 1)

  const r2 = await engine.runTick(h.deps)
  assert.equal(h.emitted.length, 1, '同一天第二次 tick 不得重复问候')
  assert.ok(r2.skipped.includes('greeting'))
})

test('开机问候：网络不可达时**不发**（等网络就绪，而不是假装问候过了）', async () => {
  const h = deps({ ready: { network: false, provider: false, detail: 'offline' } })
  await engine.runTick(h.deps)
  assert.equal(h.emitted.length, 0)
  assert.equal(engineState.loadEngineState().greetingDoneDay, null, '没问候就不该记"今天问候过"')

  // 网络恢复后仍能问候
  const h2 = deps({ ready: { network: true, provider: true, detail: 'online' } })
  await engine.runTick(h2.deps)
  assert.equal(h2.emitted.length, 1)
})

test('★ 引擎全局关闭：连队列都不进（用户关了主动陪伴就该彻底安静）', async () => {
  settingsStore.patchSettings({ proactiveEnabled: false })
  const h = deps({ activity: act({ meeting: 'zoom' }) })
  const r = await engine.runTick(h.deps)
  assert.equal(h.emitted.length, 0)
  assert.equal(rem.loadReminders().reminders.length, 0)
  assert.ok(r.skipped.includes('proactive:disabled'))
})

test('单能力开关关闭：问候不发、且如实记 skipped', async () => {
  settingsStore.patchSettings({ greetingEnabled: false })
  const h = deps()
  const r = await engine.runTick(h.deps)
  assert.equal(h.emitted.filter(e => e.kind === 'greeting').length, 0)
  assert.ok(r.skipped.includes('greeting'))
})

// ───────────────────────────────────────────────────────── 阻断

test('★ 阻断（会议）：问候**进队列且不发声**，emit 不被调用', async () => {
  const h = deps({ activity: act({ meeting: 'zoom' }) })
  const r = await engine.runTick(h.deps)
  assert.equal(h.emitted.length, 0, '阻断期间绝不能 emit（那就是弹窗）')
  assert.equal(h.spoken.length, 0, '阻断期间绝不能发声')
  assert.equal(r.queued >= 1, true)
  assert.equal(r.blockReason, 'meeting')
})

test('★ 阻断（游戏 / 全屏 / 系统专注 / 手动静默）都被识别，且原因可区分', async () => {
  const cases = [
    [{ gameProcess: 'dota2' }, 'game'],
    [{ fullscreen: true }, 'fullscreen'],
    [{ focusAssist: true }, 'focus'],
    [{ userSilent: true }, 'user-silent'],
    [{ meeting: 'teams' }, 'meeting'],
  ]
  for (const [patch, reason] of cases) {
    resetStores(ALL)
    fs.rmSync(path.join(TMP, 'engine-state.json'), { force: true })
    const h = deps({ activity: act(patch) })
    const r = await engine.runTick(h.deps)
    assert.equal(r.blockReason, reason, `${JSON.stringify(patch)} 应判定为 ${reason}`)
    assert.equal(h.emitted.length, 0, `${reason} 期间不得 emit`)
  }
})

test('★ 静音时段：23:30 落在 23:00–07:30 里 ⇒ 阻断，且原因如实为 quiet-hours', async () => {
  const h = deps({ now: new Date(2026, 0, 1, 23, 30, 0) })
  const r = await engine.runTick(h.deps)
  assert.equal(r.blockReason, 'quiet-hours')
  assert.equal(h.emitted.length, 0)
})

test('★ 采样不可用 ⇒ **保守阻断**（读不到状态时宁可晚点提醒，也不打断用户）', async () => {
  const h = deps({ activity: act({ available: false, unavailableReason: '探针脚本不存在' }) })
  const r = await engine.runTick(h.deps)
  assert.equal(r.blockReason, 'focus')
  assert.equal(h.emitted.length, 0)
})

test('★ 阻断结束后**补发**：先前的问候在下一 tick 送达（不丢）', async () => {
  const h = deps({ activity: act({ meeting: 'zoom' }) })
  await engine.runTick(h.deps)
  assert.equal(h.emitted.length, 0)
  assert.ok(engineState.loadEngineState().greetingDoneDay !== null, '问候应已记账（否则会无限重试）')

  // 会议结束
  h.setActivity(act())
  await engine.runTick(h.deps)
  assert.equal(h.emitted.length, 1, '阻断结束后必须补发')
  assert.equal(h.emitted[0].kind, 'greeting')
})

// ───────────────────────────────────────────────────────── 日程播报

test('日程播报：有今日日程时送达一次，内容含时间与标题（**不编造**条数）', async () => {
  sched.upsertSchedule({ title: '晨会', start: '09:30', recurrence: { kind: 'daily' } })
  const h = deps()
  await engine.runTick(h.deps)
  const brief = h.emitted.find(e => e.kind === 'schedule-brief')
  assert.ok(brief, '应送出日程播报')
  assert.match(brief.text, /09:30/)
  assert.match(brief.text, /晨会/)
  assert.match(brief.text, /1 件事/)
})

test('日程播报：没有今日日程时**不发**（不制造"今天有 0 件事"这种噪音）', async () => {
  const h = deps()
  await engine.runTick(h.deps)
  assert.equal(h.emitted.filter(e => e.kind === 'schedule-brief').length, 0)
})

test('日程播报：同一天只播一次', async () => {
  sched.upsertSchedule({ title: '晨会', start: '09:30', recurrence: { kind: 'daily' } })
  const h = deps()
  await engine.runTick(h.deps)
  await engine.runTick(h.deps)
  assert.equal(h.emitted.filter(e => e.kind === 'schedule-brief').length, 1)
})

// ───────────────────────────────────────────────────────── 阈值型提醒

test('★ 连续使用：达到 50 分钟阈值时产生提醒；未达阈值不产生', async () => {
  const t0 = Date.now()
  // 建立连续段：两次活动采样，起点落在 50 分钟前
  activity.recordSample(act({ at: t0 - 51 * 60_000 }), new Date(t0 - 51 * 60_000))
  activity.recordSample(act({ at: t0 }), new Date(t0))
  assert.ok(activity.currentStreakMinutes(new Date(t0)) >= 50)

  const h = deps({ now: new Date(t0) })
  await engine.runTick(h.deps)
  const created = rem.loadReminders().reminders.filter(r => r.kind === 'continuous')
  assert.equal(created.length, 1, '应产生一条连续使用提醒')
  assert.equal(created[0].priority, 'normal')
  assert.match(created[0].title, /连续用电脑/)
})

test('★ 连续使用：阈值以下不提醒（默认 50 分钟）', async () => {
  const t0 = Date.now()
  activity.recordSample(act({ at: t0 - 10 * 60_000 }), new Date(t0 - 10 * 60_000))
  activity.recordSample(act({ at: t0 }), new Date(t0))
  const h = deps({ now: new Date(t0) })
  await engine.runTick(h.deps)
  assert.equal(rem.loadReminders().reminders.filter(r => r.kind === 'continuous').length, 0)
})

test('★ 连续使用：同一天不重复产生（去重键），且冷却生效', async () => {
  const t0 = Date.now()
  activity.recordSample(act({ at: t0 - 51 * 60_000 }), new Date(t0 - 51 * 60_000))
  activity.recordSample(act({ at: t0 }), new Date(t0))
  const h = deps({ now: new Date(t0) })
  await engine.runTick(h.deps)
  await engine.runTick(h.deps)
  await engine.runTick(h.deps)
  assert.equal(rem.loadReminders().reminders.filter(r => r.kind === 'continuous').length, 1, '去重键必须挡住重复')
})

test('★ 夜间提醒：23:30 之后仍在使用电脑 ⇒ 重要级提醒；且是"该休息"的内容', async () => {
  quiet.setReminderPolicy({ nightRestAt: '23:30' })
  const t0 = new Date(2026, 0, 1, 23, 40, 0).getTime()
  // 让连续段与活动都在"现在"
  activity.recordSample(act({ at: t0 }), new Date(t0))
  const h = deps({ now: new Date(t0), activity: act({ idleMs: 0 }) })
  await engine.runTick(h.deps)
  const night = rem.loadReminders().reminders.filter(r => r.kind === 'night')
  assert.equal(night.length, 1)
  assert.equal(night[0].priority, 'important', '夜间提醒是重要级')
})

test('夜间提醒：静音时段内它只会进队列（**不弹窗不发声**），但记录仍在', async () => {
  quiet.setReminderPolicy({ nightRestAt: '23:30' })
  const t0 = new Date(2026, 0, 1, 23, 40, 0).getTime()
  activity.recordSample(act({ at: t0 }), new Date(t0))
  const h = deps({ now: new Date(t0) })
  const r = await engine.runTick(h.deps)
  assert.equal(r.blockReason, 'quiet-hours')
  assert.equal(h.emitted.length, 0)
  const night = rem.loadReminders().reminders.filter(r => r.kind === 'night')
  assert.equal(night.length, 1)
  assert.equal(night[0].state, 'queued', '被阻断的提醒必须进队列而不是丢掉')
})

test('★ 夜间提醒：23:30 之前不触发', async () => {
  const t0 = new Date(2026, 0, 1, 22, 0, 0).getTime()
  activity.recordSample(act({ at: t0 }), new Date(t0))
  const h = deps({ now: new Date(t0) })
  await engine.runTick(h.deps)
  assert.equal(rem.loadReminders().reminders.filter(r => r.kind === 'night').length, 0)
})

test('★ 用户设定的定时提醒：到点送达；在会议中则进队列，会议结束后补发', async () => {
  /**
   * ⚠ **时间线必须自洽**：`deps({ now })` 注入的是假时钟（2026-01-01 09:00），
   *   而 `Date.now()` 是真实时间。早期这里用 `Date.now() - 1000` 造 fireAt，
   *   于是"到点"是拿真实时间去和假时钟比 ⇒ 永远"还没到点"。
   *   凡是要判"到点没到点"的用例，一律用**同一个假时钟**推导 fireAt。
   */
  const now0 = new Date(2026, 0, 1, 9, 0, 0)
  const r = rem.upsertReminder({ kind: 'scheduled', title: '拿快递', fireAt: now0.getTime() - 1000 })
  const h = deps({ now: now0, activity: act({ meeting: 'teams' }) })
  await engine.runTick(h.deps)
  assert.equal(h.emitted.length, 0, '会议中不弹')
  assert.equal(rem.getReminder(r.id).state, 'queued')

  h.setActivity(act())
  await engine.runTick(h.deps)
  const reminders = h.emitted.filter(e => e.kind === 'reminder')
  assert.equal(reminders.length, 1, '会议结束后必须补发提醒（这一刻也可能同时补发问候，按 kind 取）')
  assert.equal(reminders[0].title, '拿快递')
  assert.equal(rem.getReminder(r.id).state, 'fired')
})

test('★ 提醒的 speak 恒为 false（提醒不发声；发声只由电台/问候在允许时显式请求）', async () => {
  const t0 = Date.now()
  rem.upsertReminder({ kind: 'scheduled', title: 'x', fireAt: t0 - 1 })
  const h = deps()
  await engine.runTick(h.deps)
  assert.equal(h.emitted.every(e => e.speak === false), true)
  assert.equal(h.spoken.length, 0)
})

// ───────────────────────────────────────────────────────── 早安电台

test('★ 早安电台：内容包含日期/天气/日程/热点/建议/鼓励六节（缺数据时如实标注而不是编造）', async () => {
  sched.upsertSchedule({ title: '站会', start: '11:00', recurrence: { kind: 'daily' } })
  // ⚠ 10:00 而不是 08:30：默认静音时段是 23:00–07:30，但**08:30 也可能落在
  //   用户改过的静音时段里**；10:00 在默认配置下一定"可打扰"，让这条用例只测内容。
  const h = deps({ now: new Date(2026, 0, 1, 10, 0, 0) })
  const r = await engine.generateRadio(h.deps, { force: true, speak: false })
  assert.ok(r.content, 'force 时必须有内容')
  const c = r.content
  assert.equal(c.day, '2026-01-01')
  assert.equal(c.weekday, '星期四')
  assert.ok(c.greeting.length > 0)
  assert.ok(c.encouragement.length > 0)
  assert.equal(c.schedule.length, 1)
  assert.ok(c.script.includes('2026-01-01'))
  assert.ok(c.script.includes(c.encouragement))
  // 没有网络/没有城市 ⇒ 天气必须如实说不可用，且**不能**在稿子里编天气
  assert.equal(c.weather.available, false)
  assert.ok(c.disclosures.some(d => d.includes('天气')))
  assert.ok(c.disclosures.some(d => d.includes('AI 热点')))
  // 时长落在 30–60 秒区间
  assert.ok(c.estimatedSeconds >= 30 && c.estimatedSeconds <= 60, `时长应落在 30–60s，实际 ${c.estimatedSeconds}`)
})

test('早安电台：开场白用**人设里的问候语**（用户写的开场白不该被写死的"早上好"顶掉）', async () => {
  const session = require('../dist/main/session-store.js')
  const p = session.getPersona()
  session.setPersona({ ...p, greeting: '欢迎回来，我一直在这儿。' })
  const h = deps({ now: new Date(2026, 0, 1, 10, 0, 0) })
  const r = await engine.generateRadio(h.deps, { force: true })
  assert.equal(r.content.greeting, '欢迎回来，我一直在这儿。')
  assert.ok(r.content.script.startsWith('欢迎回来'))
})

test('早安电台：30–60 秒是**硬要求**（口播稿字数在 126–252 之间 + 边界兜底）', async () => {
  const h = deps()
  const r = await engine.generateRadio(h.deps, { force: true })
  const chars = [...r.content.script.replace(/\s+/g, '')].length
  assert.ok(chars >= 126 && chars <= 252, `口播稿字数 ${chars} 不在 126–252 之间`)
})

test('早安电台：同一天只播一次；冷却生效（force 是唯一绕过口）', async () => {
  const day1 = new Date(2026, 0, 1, 10, 0, 0)
  const h = deps({ now: day1 })
  // 首次：正常送达
  const first = await engine.generateRadio(h.deps, { speak: false })
  assert.equal(first.skippedReason, null)
  assert.equal(h.emitted.filter(e => e.kind === 'morning-radio').length, 1)

  /**
   * 同一天再来：挡它的是**按天去重**。
   * 顺序是刻意的 —— 去重判定在冷却之前，因为它对用户更直白（"今天已经播过了"）。
   */
  const second = await engine.generateRadio(h.deps, { speak: false })
  assert.match(String(second.skippedReason), /今天已经播报过/)
  assert.equal(second.content, null, '被跳过时不该去抓外网（每次 tick 都会调它）')
  assert.equal(h.emitted.filter(e => e.kind === 'morning-radio').length, 1)

  /**
   * ★ 冷却**独立于按天去重**：把去重状态清掉（模拟"新的一天"），
   *   但保留 60 分钟的冷却 ⇒ 这一次挡它的**只能**是冷却。
   *
   * 为什么要这样构造：光靠"第二天同一分钟"测不出冷却 ——
   * 那时 60 分钟的冷却其实早已过期（跨天是 24 小时），
   * 我早期把这条断言写成"冷却跨天仍生效"是错的，被测试自己抓了出来。
   */
  engineState.patchEngineState({ radioDay: null })
  const third = await engine.generateRadio(h.deps, { speak: false })
  assert.match(String(third.skippedReason), /冷却中/, '冷却窗口内必须被挡（此时与按天去重无关）')
  assert.equal(h.emitted.filter(e => e.kind === 'morning-radio').length, 1)

  // 过了冷却窗口（第二天）⇒ 冷却不再挡它
  const h3 = deps({ now: new Date(2026, 0, 2, 10, 0, 0) })
  const fourth = await engine.generateRadio(h3.deps, { speak: false })
  assert.equal(fourth.skippedReason, null, '跨天后冷却已过期，不该再挡')
  assert.equal(h3.emitted.filter(e => e.kind === 'morning-radio').length, 1)

  // force 是明确的手动入口：必须绕过冷却与去重
  const forced = await engine.generateRadio(h3.deps, { force: true, speak: false })
  assert.equal(forced.skippedReason, null)
  assert.ok(forced.content)
  assert.equal(h3.emitted.filter(e => e.kind === 'morning-radio').length, 2)
})

test('早安电台：朗读开关关闭时不发声；开启且未被阻断时朗读口播稿', async () => {
  settingsStore.patchSettings({ ttsEnabled: true, morningRadioSpeak: false })
  const h = deps({ now: new Date(2026, 0, 1, 10, 0, 0) })
  await engine.generateRadio(h.deps, { speak: false })
  assert.equal(h.spoken.length, 0)
  assert.equal(h.emitted[0].speak, false)

  // 换一天，开启朗读
  settingsStore.patchSettings({ morningRadioSpeak: true })
  const h2 = deps({ now: new Date(2026, 0, 2, 10, 0, 0) })
  const r = await engine.generateRadio(h2.deps, { force: true, speak: true })
  assert.equal(h2.spoken.length, 1)
  assert.equal(h2.spoken[0].text, r.content.script, '朗读的必须是口播稿本身')
  assert.equal(h2.emitted[0].speak, true)
})

test('★ 早安电台：被阻断时**不发声**（静音时段里早上 7 点也不该念出来）', async () => {
  settingsStore.patchSettings({ ttsEnabled: true, morningRadioSpeak: true })
  // 07:00 落在默认静音时段 23:00–07:30 内
  const h = deps({ now: new Date(2026, 0, 1, 7, 0, 0) })
  const r = await engine.generateRadio(h.deps, { force: true, speak: true })
  assert.ok(r.content)
  assert.equal(h.spoken.length, 0, '阻断/静音期间绝不能发声')
  assert.equal(h.emitted.length, 0, '阻断期间必须进队列而不是 emit')
})

test('★ 早安电台：ttsEnabled 关闭时不朗读（即使 morningRadioSpeak 开着）', async () => {
  settingsStore.patchSettings({ ttsEnabled: false, morningRadioSpeak: true })
  const h = deps({ now: new Date(2026, 0, 1, 9, 0, 0) })
  await engine.generateRadio(h.deps, { force: true, speak: true })
  assert.equal(h.spoken.length, 0)
})

test('早安电台：到点才在 tick 里生成（08:30 之外不生成）', async () => {
  settingsStore.patchSettings({ morningRadioAt: '08:30' })
  const h = deps({ now: new Date(2026, 0, 1, 12, 0, 0) })
  await engine.runTick(h.deps)
  assert.equal(h.emitted.filter(e => e.kind === 'morning-radio').length, 0)
})

// ───────────────────────────────────────────────────────── 状态投影

test('proactiveStatus 回显**真实**开关值（不硬编码 true）', () => {
  const h = deps()
  engine.startProactiveEngine(h.deps)
  try {
    const st = engine.proactiveStatus()
    assert.equal(st.enabled.greeting, true)
    assert.equal(st.reflection.enabled, false, '自学习默认关闭')
    settingsStore.patchSettings({ sedentaryReminderEnabled: false, selfLearningEnabled: true })
    const st2 = engine.proactiveStatus()
    assert.equal(st2.enabled.sedentary, false)
    assert.equal(st2.reflection.enabled, true)
    assert.equal(st2.running, true)
    assert.equal(st2.nextTickInMs, 1000, '应回显实际生效的 tick 间隔')
  } finally {
    engine.stopProactiveEngine()
    engine.__resetEngineForTest()
  }
})

test('引擎不会重复启动（防两个 tick 循环同时跑）', () => {
  const h = deps()
  const a = engine.startProactiveEngine(h.deps)
  try {
    const b = engine.startProactiveEngine(h.deps)
    assert.equal(typeof b.stop, 'function')
    assert.equal(engine.engineRunning(), true)
    a.stop()
    assert.equal(engine.engineRunning(), false)
  } finally {
    engine.stopProactiveEngine()
    engine.__resetEngineForTest()
  }
})
