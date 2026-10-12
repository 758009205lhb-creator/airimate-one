/**
 * apps/desktop/test/m2-stores.test.cjs —— M2 持久化存储单测
 *
 * 覆盖：权限硬下限（**最重要的那条**）、日程重复规则与按天去重、
 * 提醒状态机 / 冷却 / 重试上限 / 队列上限、静音时段与阈值。
 *
 * 这些逻辑错了**不会报错**：只会让"该提醒的没提醒""不该打扰的打扰了"
 * 或者"危险能力被悄悄放开"。端到端几乎看不出来，所以在这里逐条钉死。
 *
 * 隔离：`electron` 被打桩，userData 指向本文件专属的临时目录。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir, stubElectron, resetStores } = require('./helpers/harness.cjs')

const TMP = tmpdir('m2stores')
stubElectron(TMP)

const perm = require('../dist/main/permission-store.js')
const sched = require('../dist/main/schedule-store.js')
const rem = require('../dist/main/reminder-store.js')
const quiet = require('../dist/main/quiet-store.js')
const engineState = require('../dist/main/engine-state.js')
const activity = require('../dist/main/activity-stats.js')

const ALL = { perm, sched, rem, quiet, engineState, activity }

test.beforeEach(() => {
  // 删文件 + 清内存缓存：缺任何一个都会让用例互相污染
  for (const f of ['permissions.json', 'schedules.json', 'reminders.json', 'quiet-hours.json', 'engine-state.json', 'activity.json']) {
    fs.rmSync(path.join(TMP, f), { force: true })
  }
  resetStores(ALL)
})

// ───────────────────────────────────────────────────────── 权限（硬下限）

test('★★ 权限：把 payment / credential-access 请求成 read-only，实际仍是 blocked 且 enabled 强制 false', () => {
  const p = perm.setPermission({ kind: 'payment', tier: 'read-only', enabled: true })
  assert.equal(p.effective, 'blocked', '硬下限必须收紧请求值')
  assert.equal(p.enabled, false, '禁止级能力必须强制关闭')
  assert.equal(p.grantedBy, 'floor', '必须留下"被硬下限收紧"的痕迹（审计）')
  assert.equal(perm.decidePermission('payment').decision, 'denied')

  const c = perm.setPermission({ kind: 'credential-access', tier: 'read-only', enabled: true })
  assert.equal(c.effective, 'blocked')
  assert.equal(c.enabled, false)
  assert.equal(perm.decidePermission('credential-access').decision, 'denied')
})

test('★ 权限：即使**直接改磁盘文件**放宽 payment，重新读盘后仍被收紧（硬下限不在 UI 层）', () => {
  // ⚠ 必须先触发一次写盘：`permissions.json` 在**首次 setPermission 之前并不存在**
  //   （`listPermissions()` 只走内存里的默认值）。踩到过一次：直接 readFileSync 会 ENOENT。
  perm.setPermission({ kind: 'file-read', enabled: true })
  const file = perm.permissionStorePath()
  assert.equal(fs.existsSync(file), true, 'setPermission 之后必须已落盘')
  // 模拟用户/恶意程序手改配置文件
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const target = raw.permissions.find(x => x.kind === 'payment')
  target.tier = 'read-only'
  target.effective = 'read-only'
  target.enabled = true
  fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')
  perm.__resetPermissionStoreForTest()
  const after = perm.getPermission('payment')
  assert.equal(after.effective, 'blocked', 'normalize() 必须在每次读盘时重算 effective')
  assert.equal(after.enabled, false)
  assert.equal(perm.decidePermission('payment').decision, 'denied')
})

test('权限：写类不能被放宽到只读，但可以被收紧', () => {
  const a = perm.setPermission({ kind: 'file-write', tier: 'read-only', enabled: true })
  assert.equal(a.effective, 'confirm', 'file-write 的下限是"需确认"')
  assert.equal(perm.decidePermission('file-write').decision, 'needs-confirm')
  const b = perm.setPermission({ kind: 'file-read', tier: 'blocked' })
  assert.equal(b.effective, 'blocked')
  assert.equal(perm.decidePermission('file-read').decision, 'denied')
})

test('权限：默认全部关闭且默认档位不宽于下限（首装不该有任何能力被静默开启）', () => {
  const all = perm.listPermissions()
  assert.ok(all.length >= 11, `能力数量应覆盖 PermissionKind，实际 ${all.length}`)
  assert.equal(all.every(p => p.enabled === false), true, '默认一个都不开')
  assert.equal(all.every(p => p.updatedAt === 0), true, '默认没有"已更新"痕迹')
})

test('权限：decidePermission 是唯一判定入口，且未启用一律 denied', () => {
  perm.setPermission({ kind: 'screen-capture', tier: 'read-only', enabled: false })
  assert.equal(perm.decidePermission('screen-capture').decision, 'denied')
  perm.setPermission({ kind: 'screen-capture', tier: 'read-only', enabled: true })
  assert.equal(perm.decidePermission('screen-capture').decision, 'allow')
  perm.setPermission({ kind: 'screen-capture', tier: 'confirm', enabled: true })
  assert.equal(perm.decidePermission('screen-capture').decision, 'needs-confirm')
})

test('权限：pathAllowlist 与 excludeRegions 落盘可读回（M3 的文件白名单与截图排除区）', () => {
  const p = perm.setPermission({
    kind: 'file-read',
    enabled: true,
    pathAllowlist: ['C:\\Users\\me\\Documents'],
    excludeRegions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
  })
  assert.deepEqual(p.pathAllowlist, ['C:\\Users\\me\\Documents'])
  assert.equal(p.excludeRegions.length, 1)
  perm.__resetPermissionStoreForTest()
  const back = perm.getPermission('file-read')
  assert.deepEqual(back.pathAllowlist, ['C:\\Users\\me\\Documents'])
  assert.equal(back.redactSensitive, true, '敏感信息脱敏默认开')
})

test('权限：摘要只给计数（诊断里不泄露白名单内容）', () => {
  perm.setPermission({ kind: 'file-read', enabled: true, pathAllowlist: ['C:\\secret-dir'] })
  const d = perm.permissionDigest()
  assert.equal(d.total >= 11, true)
  assert.equal(d.allowlistedDirs, 1)
  assert.equal(JSON.stringify(d).includes('secret-dir'), false, '摘要里不得出现路径明文')
})

// ───────────────────────────────────────────────────────── 日程

test('日程：落盘可读回，且默认值齐全（老文件缺字段不该整体失效）', () => {
  const s = sched.upsertSchedule({ title: '站会', start: '09:30', recurrence: { kind: 'weekdays' } })
  assert.equal(s.leadMinutes, 0)
  assert.equal(s.enabled, true)
  assert.equal(s.announceInRadio, true)
  sched.__resetScheduleStoreForTest()
  const back = sched.loadSchedules().schedules
  assert.equal(back.length, 1)
  assert.equal(back[0].title, '站会')
})

test('日程：weekly 没给星期几 / once 没给日期 / monthly 没给日 ⇒ **拒绝**（不存一条永不触发的日程）', () => {
  assert.throws(() => sched.upsertSchedule({ title: 'x', start: '10:00', recurrence: { kind: 'weekly' } }), /weekly/)
  assert.throws(() => sched.upsertSchedule({ title: 'x', start: '10:00', recurrence: { kind: 'once' } }), /一次性/)
  assert.throws(() => sched.upsertSchedule({ title: 'x', start: '10:00', recurrence: { kind: 'monthly' } }), /每月/)
  assert.equal(sched.loadSchedules().schedules.length, 0, '被拒的日程不得落盘')
})

test('日程：occursOn 覆盖 once/daily/weekdays/weekly/monthly', () => {
  const thu = new Date(2026, 0, 1)   // 2026-01-01 是星期四
  assert.equal(thu.getDay(), 4)
  const mk = (rec) => sched.upsertSchedule({ title: 't', start: '09:00', recurrence: rec })
  const once = mk({ kind: 'once', date: '2026-01-01' })
  assert.equal(sched.occursOn(once, thu), true)
  assert.equal(sched.occursOn(once, new Date(2026, 0, 2)), false)
  const daily = mk({ kind: 'daily' })
  assert.equal(sched.occursOn(daily, new Date(2026, 0, 3)), true)   // 周六也算
  const wd = mk({ kind: 'weekdays' })
  assert.equal(sched.occursOn(wd, thu), true)
  assert.equal(sched.occursOn(wd, new Date(2026, 0, 3)), false)     // 周六不算
  const weekly = mk({ kind: 'weekly', weekdays: [4] })
  assert.equal(sched.occursOn(weekly, thu), true)
  assert.equal(sched.occursOn(weekly, new Date(2026, 0, 2)), false)
  const monthly = mk({ kind: 'monthly', dayOfMonth: 1 })
  assert.equal(sched.occursOn(monthly, thu), true)
  assert.equal(sched.occursOn(monthly, new Date(2026, 0, 2)), false)
})

test('日程：dueSchedules 计算 leadMinutes 提前量，并在窗口外不触发', () => {
  sched.upsertSchedule({ title: '会议', start: '10:00', leadMinutes: 15, recurrence: { kind: 'daily' } })
  // 09:45 正好在触发点
  const at = sched.dueSchedules(new Date(2026, 0, 1, 9, 45))
  assert.equal(at.length, 1)
  assert.equal(at[0].triggerAt, '09:45')
  assert.equal(at[0].startsInMinutes, 15)
  // 09:40 还没到
  assert.equal(sched.dueSchedules(new Date(2026, 0, 1, 9, 40)).length, 0)
  // 10:30 已过窗口（10 分钟）⇒ 不该在中午又提醒一次
  assert.equal(sched.dueSchedules(new Date(2026, 0, 1, 10, 30)).length, 0)
})

test('★ 日程：markScheduleFired 按天去重（同一天不会重复提醒；第二天恢复）', () => {
  const s = sched.upsertSchedule({ title: '会议', start: '10:00', recurrence: { kind: 'daily' } })
  const t1 = new Date(2026, 0, 1, 10, 0)
  assert.equal(sched.dueSchedules(t1).length, 1)
  assert.equal(sched.markScheduleFired(s.id, t1), true)
  assert.equal(sched.dueSchedules(t1).length, 0, '同一分钟内不得再触发')
  assert.equal(sched.markScheduleFired(s.id, t1), false, '重复标记应返回 false')
  // 第二天
  assert.equal(sched.dueSchedules(new Date(2026, 0, 2, 10, 0)).length, 1)
})

test('★ 日程：改了开始时间会重置"今日已提醒"标记（否则改到明天会被今天的记录挡住）', () => {
  const s = sched.upsertSchedule({ title: '会议', start: '10:00', recurrence: { kind: 'daily' } })
  const t1 = new Date(2026, 0, 1, 10, 0)
  sched.markScheduleFired(s.id, t1)
  assert.equal(sched.loadSchedules().schedules[0].lastFiredDay, '2026-01-01')
  sched.upsertSchedule({ id: s.id, title: '会议', start: '11:00', recurrence: { kind: 'daily' } })
  assert.equal(sched.loadSchedules().schedules[0].lastFiredDay, null, '改时间必须重置去重标记')
  assert.equal(sched.dueSchedules(new Date(2026, 0, 1, 11, 0)).length, 1)
})

test('日程：todaySchedules 按开始时间排序，停用的不参与', () => {
  sched.upsertSchedule({ title: '晚', start: '20:00', recurrence: { kind: 'daily' } })
  sched.upsertSchedule({ title: '早', start: '08:00', recurrence: { kind: 'daily' } })
  sched.upsertSchedule({ title: '停用', start: '09:00', recurrence: { kind: 'daily' }, enabled: false })
  const list = sched.todaySchedules(new Date(2026, 0, 1, 12, 0))
  assert.deepEqual(list.map(s => s.title), ['早', '晚'])
})

test('日程：删除幂等（重复删除返回 false）', () => {
  const s = sched.upsertSchedule({ title: 'x', start: '09:00', recurrence: { kind: 'daily' } })
  assert.equal(sched.deleteSchedule(s.id), true)
  assert.equal(sched.deleteSchedule(s.id), false)
})

// ───────────────────────────────────────────────────────── 提醒状态机

test('提醒：新建后是 pending，dueReminders 到点才返回，markFired 写 firedAt（送达的唯一证据）', () => {
  const now = Date.now()
  const r = rem.upsertReminder({ kind: 'scheduled', title: '喝水', fireAt: now + 60_000 })
  assert.equal(r.state, 'pending')
  assert.equal(rem.dueReminders(now).length, 0)
  assert.equal(rem.dueReminders(now + 60_001).length, 1)
  const fired = rem.markFired(r.id)
  assert.equal(fired.state, 'fired')
  assert.equal(typeof fired.firedAt, 'number')
  assert.equal(rem.dueReminders(now + 120_000).length, 0, '已送达的不得再触发')
})

test('提醒：atTime 只给时刻且今天已过 ⇒ 自动顺延到明天（符合直觉）', () => {
  const r = rem.upsertReminder({ kind: 'scheduled', title: 'x', atTime: '00:01' })
  assert.ok(r.fireAt > Date.now(), '必须落在未来')
  const d = new Date(r.fireAt)
  assert.equal(d.getHours(), 0)
  assert.equal(d.getMinutes(), 1)
})

test('提醒：atTime + atDate 用指定日期（不改到明天）', () => {
  const r = rem.upsertReminder({ kind: 'scheduled', title: 'x', atTime: '09:00', atDate: '2026-06-01' })
  const d = new Date(r.fireAt)
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 5)
  assert.equal(d.getDate(), 1)
  assert.equal(d.getHours(), 9)
})

test('提醒：scheduled 既不给 fireAt 也不给 atTime ⇒ 抛错（不静默用"现在"）', () => {
  assert.throws(() => rem.upsertReminder({ kind: 'scheduled', title: 'x' }), /触发时间/)
})

test('★ 提醒：createEngineReminder 按去重键拦截重复（同一天同类只产生一次）', () => {
  const key = 'continuous:2026-01-01'
  const a = rem.createEngineReminder({ kind: 'continuous', title: 't', priority: 'normal', dedupeKey: key })
  assert.ok(a)
  const b = rem.createEngineReminder({ kind: 'continuous', title: 't', priority: 'normal', dedupeKey: key })
  assert.equal(b, null, '重复键必须返回 null')
  assert.equal(rem.loadReminders().reminders.length, 1)
})

test('★ 提醒：被阻断进队列后**不丢**，补发时仍能取到（markQueued → queuedReminders）', () => {
  const now = Date.now()
  const r = rem.upsertReminder({ kind: 'scheduled', title: '开会', fireAt: now })
  rem.markQueued(r.id, 'meeting')
  const q = rem.queuedReminders()
  assert.equal(q.length, 1)
  assert.equal(q[0].blockReason, 'meeting')
  const snap = rem.queueSnapshot()
  assert.equal(snap.length, 1)
  assert.match(snap[0].blockedReasonText, /会议/)
  // 补发
  rem.markFired(r.id)
  assert.equal(rem.queuedReminders().length, 0)
})

test('提醒：队列按优先级排序（重要 → 普通 → 静默）', () => {
  const now = Date.now()
  const a = rem.upsertReminder({ kind: 'scheduled', title: 'silent', fireAt: now, priority: 'silent' })
  const b = rem.upsertReminder({ kind: 'scheduled', title: 'important', fireAt: now + 1, priority: 'important' })
  const c = rem.upsertReminder({ kind: 'scheduled', title: 'normal', fireAt: now + 2, priority: 'normal' })
  for (const x of [a, b, c]) rem.markQueued(x.id, 'quiet-hours')
  assert.deepEqual(rem.queuedReminders().map(x => x.title), ['important', 'normal', 'silent'])
})

test('★ 提醒：重试有上限，超限转 failed 并记 lastError（不无限重试）', () => {
  const r = rem.upsertReminder({ kind: 'scheduled', title: 'x', fireAt: Date.now() })
  const max = quiet.loadReminderPolicy().maxRetries
  assert.equal(max, 3)
  for (let i = 1; i <= max; i++) {
    const after = rem.markAttemptFailed(r.id, `err${i}`)
    assert.equal(after.state, 'queued', `第 ${i} 次失败仍应留在队列里重试`)
    assert.equal(after.attempts, i)
  }
  const over = rem.markAttemptFailed(r.id, 'err-final')
  assert.equal(over.state, 'failed', '超过上限必须转 failed，不再重试')
  assert.equal(over.lastError, 'err-final')
  assert.equal(rem.queuedReminders().length, 0)
})

test('提醒：ack 后转 done（并从"未确认"列表消失）', () => {
  const r = rem.upsertReminder({ kind: 'scheduled', title: 'x', fireAt: Date.now() })
  rem.markFired(r.id)
  assert.equal(rem.unackedReminders().length, 1)
  const acked = rem.ackReminder(r.id, true)
  assert.equal(acked.state, 'done')
  assert.equal(typeof acked.ackedAt, 'number')
  assert.equal(rem.unackedReminders().length, 0)
})

test('提醒：ack(false) 是"取消确认"，回到 fired（不是删除）', () => {
  const r = rem.upsertReminder({ kind: 'scheduled', title: 'x', fireAt: Date.now() })
  rem.markFired(r.id)
  rem.ackReminder(r.id, true)
  const back = rem.ackReminder(r.id, false)
  assert.equal(back.state, 'fired')
  assert.equal(back.ackedAt, null)
})

test('★ 提醒：队列超限只丢最旧的**静默级**，重要级永远保留', () => {
  quiet.setReminderPolicy({ maxQueue: 3 })
  const now = Date.now()
  const silent = []
  for (let i = 0; i < 4; i++) {
    const r = rem.upsertReminder({ kind: 'scheduled', title: `s${i}`, fireAt: now + i, priority: 'silent' })
    rem.markQueued(r.id, 'quiet-hours')
    silent.push(r.id)
  }
  const imp = rem.upsertReminder({ kind: 'scheduled', title: 'imp', fireAt: now + 10, priority: 'important' })
  rem.markQueued(imp.id, 'quiet-hours')
  const dropped = rem.enforceQueueLimit()
  assert.equal(dropped.length, 2, '5 条队列 / 上限 3 ⇒ 丢 2 条静默级')
  const left = rem.queuedReminders().map(r => r.title)
  assert.ok(left.includes('imp'), '重要级必须保留')
  assert.equal(left.filter(t => t.startsWith('s')).length, 2)
})

test('★ 提醒：队列超限且全是重要/普通级 ⇒ **不丢**（宁可队列长一点也不丢要紧事）', () => {
  quiet.setReminderPolicy({ maxQueue: 2 })
  const now = Date.now()
  for (let i = 0; i < 5; i++) {
    const r = rem.upsertReminder({ kind: 'scheduled', title: `n${i}`, fireAt: now + i, priority: i === 0 ? 'important' : 'normal' })
    rem.markQueued(r.id, 'meeting')
  }
  const dropped = rem.enforceQueueLimit()
  assert.deepEqual(dropped, [])
  assert.equal(rem.queuedReminders().length, 5)
})

test('提醒：lastFiredAtOf 只看真的送达过的（没送出去的不消耗冷却）', () => {
  const a = rem.upsertReminder({ kind: 'continuous', title: 'x', fireAt: Date.now() })
  rem.markQueued(a.id, 'meeting')
  assert.equal(rem.lastFiredAtOf('continuous'), null, '排队中的不该算作"已送达"')
  rem.markFired(a.id)
  assert.equal(typeof rem.lastFiredAtOf('continuous'), 'number')
})

test('提醒：删除幂等；取消保留记录但不再触发', () => {
  const r = rem.upsertReminder({ kind: 'scheduled', title: 'x', fireAt: Date.now() - 1000 })
  assert.equal(rem.cancelReminder(r.id).state, 'cancelled')
  assert.equal(rem.dueReminders(Date.now()).length, 0)
  assert.equal(rem.deleteReminder(r.id), true)
  assert.equal(rem.deleteReminder(r.id), false)
})

// ───────────────────────────────────────────────────────── 静音时段与阈值

test('静音时段：默认 23:00–07:30、开启、允许重要级进队列；跨午夜判定正确', () => {
  const q = quiet.loadQuietHours()
  assert.equal(q.enabled, true)
  assert.equal(q.start, '23:00')
  assert.equal(q.end, '07:30')
  assert.equal(q.allowImportant, true)
  assert.equal(quiet.inQuietHours(new Date(2026, 0, 1, 2, 0)), true)
  assert.equal(quiet.inQuietHours(new Date(2026, 0, 1, 23, 30)), true)
  assert.equal(quiet.inQuietHours(new Date(2026, 0, 1, 12, 0)), false)
})

test('静音时段：改完落盘可读回，updatedAt 被写入（向导据此判断"用户确认过这一页"）', () => {
  const before = quiet.loadQuietHours().updatedAt
  assert.equal(before, 0)
  const q = quiet.setQuietHours({ start: '22:00', end: '08:00' })
  assert.equal(q.start, '22:00')
  assert.ok(q.updatedAt > 0)
  quiet.__resetQuietStoreForTest()
  assert.equal(quiet.loadQuietHours().start, '22:00')
})

test('提醒阈值：默认连续 50 分钟 / 久坐 60 分钟 / 夜间 23:30（用户要求的默认值）', () => {
  const p = quiet.loadReminderPolicy()
  assert.equal(p.continuousMinutes, 50)
  assert.equal(p.sedentaryMinutes, 60)
  assert.equal(p.nightRestAt, '23:30')
  assert.equal(p.maxRetries, 3)
  assert.equal(p.maxQueue, 50)
  assert.equal(p.cooldownMinutes.continuous, 60)
  assert.equal(p.cooldownMinutes.night, 720)
})

test('提醒阈值：部分更新不会把 cooldownMinutes 整体覆盖掉（深合并）', () => {
  quiet.setReminderPolicy({ cooldownMinutes: { continuous: 5 } })
  const p = quiet.loadReminderPolicy()
  assert.equal(p.cooldownMinutes.continuous, 5)
  assert.equal(p.cooldownMinutes.night, 720, '未提到的冷却项必须保持原值')
})

test('提醒阈值：非法值（0 分钟 / 25:00）被 schema 拒绝', () => {
  assert.throws(() => quiet.setReminderPolicy({ continuousMinutes: 0 }))
  assert.throws(() => quiet.setReminderPolicy({ nightRestAt: '25:00' }))
})

// ───────────────────────────────────────────────────────── 引擎状态（持久化调度）

test('引擎状态：按天去重字段与冷却可跨"重启"恢复（清缓存后仍在）', () => {
  engineState.patchEngineState({ greetingDoneDay: '2026-01-01', radioDay: '2026-01-01' })
  engineState.setCooldown('greeting', 123456789)
  engineState.__resetEngineStateForTest()
  const st = engineState.loadEngineState()
  assert.equal(st.greetingDoneDay, '2026-01-01')
  assert.equal(st.radioDay, '2026-01-01')
  assert.equal(engineState.cooldownUntilOf('greeting'), 123456789)
})

test('引擎状态：recordDecision 只留原因码与时间（**不记正文**），且有 64 条上限', () => {
  for (let i = 0; i < 100; i++) engineState.recordDecision('continuous', 'fired', 'none')
  const st = engineState.loadEngineState()
  assert.equal(st.recentDecisions.length, 64)
  assert.deepEqual(Object.keys(st.recentDecisions[0]).sort(), ['at', 'decision', 'kind', 'reason'])
})

test('引擎状态：pruneCooldowns 只清过期的', () => {
  engineState.setCooldown('a', 1000)
  engineState.setCooldown('b', Date.now() + 60_000)
  engineState.pruneCooldowns(Date.now())
  const st = engineState.loadEngineState()
  assert.equal('a' in st.cooldownUntil, false)
  assert.equal('b' in st.cooldownUntil, true)
})

// ───────────────────────────────────────────────────────── 活动统计

test('活动统计：只记计数与时长（没有按键内容、没有窗口标题原文）', () => {
  const mk = (o) => ({
    at: Date.now(), idleMs: 0, inputEvents1m: 3, fullscreen: false, gameProcess: null,
    meeting: null, focusAssist: false, userSilent: false, titleDigest: 'abc12345', titleChars: 42,
    available: true, unavailableReason: null, blockReason: 'none', ...o,
  })
  activity.recordSample(mk({}))
  activity.recordSample(mk({}))
  const st = activity.todayStats()
  assert.equal(st.activeMinutes, 2)
  assert.equal(st.inputEvents, 6)
  assert.equal(st.samples, 2)
  // 落盘结构里不得出现任何"内容"字段
  const raw = fs.readFileSync(activity.activityStorePath(), 'utf8')
  for (const bad of ['titleDigest', 'titleChars', 'keystroke', 'text']) {
    assert.equal(raw.includes(bad), false, `活动文件里不该出现 ${bad}`)
  }
})

test('活动统计：阻断采样被计数（用于"今天大部分时间都在会议里"这类建议）', () => {
  const base = {
    at: Date.now(), idleMs: 0, inputEvents1m: 1, fullscreen: false, gameProcess: null,
    meeting: 'zoom', focusAssist: false, userSilent: false, titleDigest: null, titleChars: 0,
    available: true, unavailableReason: null,
  }
  activity.recordSample({ ...base, blockReason: 'meeting' })
  activity.recordSample({ ...base, blockReason: 'meeting' })
  activity.recordSample({ ...base, blockReason: 'none' })
  assert.equal(activity.todayStats().blockedSamples, 2)
})

test('活动统计：连续段在空闲 5 分钟后断开（否则"连续 8 小时"会跨过午饭）', () => {
  const t0 = Date.now()
  activity.recordSample({ at: t0, idleMs: 0, inputEvents1m: 1, available: true, unavailableReason: null, fullscreen: false, gameProcess: null, meeting: null, focusAssist: false, userSilent: false, titleDigest: null, titleChars: 0, blockReason: 'none' })
  assert.ok(activity.currentStreakMinutes(new Date(t0 + 10 * 60_000)) >= 9)
  // 空闲 8 分钟 ⇒ 段断开
  activity.recordSample({ at: t0 + 20 * 60_000, idleMs: 8 * 60_000, inputEvents1m: 0, available: true, unavailableReason: null, fullscreen: false, gameProcess: null, meeting: null, focusAssist: false, userSilent: false, titleDigest: null, titleChars: 0, blockReason: 'none' })
  // 再活动时重新起段
  activity.recordSample({ at: t0 + 30 * 60_000, idleMs: 0, inputEvents1m: 1, available: true, unavailableReason: null, fullscreen: false, gameProcess: null, meeting: null, focusAssist: false, userSilent: false, titleDigest: null, titleChars: 0, blockReason: 'none' })
  assert.equal(activity.currentStreakMinutes(new Date(t0 + 30 * 60_000)), 0)
})

test('活动统计：resetStreak 清掉连续段（冷启动/锁屏时用）', () => {
  const t0 = Date.now()
  activity.recordSample({ at: t0, idleMs: 0, inputEvents1m: 1, available: true, unavailableReason: null, fullscreen: false, gameProcess: null, meeting: null, focusAssist: false, userSilent: false, titleDigest: null, titleChars: 0, blockReason: 'none' })
  activity.resetStreak()
  assert.equal(activity.currentStreakMinutes(), 0)
})

test('活动统计：adviceFromStats 只基于真实读数（没数据时不给建议）', () => {
  assert.deepEqual(activity.adviceFromStats(), [])
})
