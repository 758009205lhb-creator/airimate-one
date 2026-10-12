/**
 * apps/desktop/test/data-adapters.test.cjs —— `storage` / `privacy` 两类适配器的单测
 *
 * 为什么单独测这两类（而不是"顺手在 kit 探针里看一眼"）：
 *   探针只能证明"跑起来那一次是对的"，而这两类适配器有**三条容易悄悄退化的性质**：
 *     ① **可用性不能乐观**：`available:true` 必须在实测通过之后才置 ——
 *        乐观写 true 会让"存储通道坏了"看起来像"一切正常"（本项目最忌讳的假结论）；
 *     ② **不得外泄绝对路径**：一个知道所有存储文件在哪、一个知道用户数据目录在哪，
 *        是最容易把 `F:\...` 漏进 UI 诊断的两类；
 *     ③ **不得外泄用户内容**：只允许出现计数与布尔，出现任何条目正文/文件名/路径即失败。
 *
 * 这三条都是"写代码时注意"防不住的，必须在**投影之后的文本**上断言。
 *
 * ⚠ 本文件**不需要** electron 打桩：这两个适配器收的全部是注入的纯读函数
 *   （设计如此 —— 见 `capabilities/data-adapters.ts` 文件头的纪律①）。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createStorageAdapter, createPrivacyAdapter } = require('../dist/main/capabilities/data-adapters.js')

/** 把适配器所有**面向用户的文本字段**摊平成一个串（路径与内容断言都在这上面做） */
function textOf(adapter) {
  return [
    adapter.id, adapter.label, adapter.note, adapter.unavailableReason,
    ...(Array.isArray(adapter.capabilities) ? adapter.capabilities : []),
  ].filter(v => typeof v === 'string').join(' ')
}

const DRIVE = /[A-Za-z]:[\\/]/

// ───────────────────────────────────────────────────────────── storage

/** 一份正常的存储读数（模拟真实 STORE_DESCRIPTORS 的形状） */
function okStorageOptions(over = {}) {
  return {
    catalog: () => [
      { name: 'session', personal: true, version: 1, migrations: 0 },
      { name: 'memory', personal: true, version: 1, migrations: 0 },
      { name: 'settings', personal: false, version: 1, migrations: 0 },
    ],
    unregistered: () => [],
    registered: () => [{ tag: 'session', storeName: 'session', file: 'F:\\secret\\session.json' }],
    migrationStates: () => ({ session: null, memory: null, settings: null }),
    userDataDirExists: () => true,
    ...over,
  }
}

test('★ storage：登记表为空 ⇒ 如实报不可用（绝不乐观写 true）', () => {
  const a = createStorageAdapter(okStorageOptions({ catalog: () => [] }))
  assert.equal(a.available, false, 'init 之前不得是 true')
  a.init()
  assert.equal(a.available, false, '登记表为空时 available 必须仍是 false')
  assert.match(String(a.unavailableReason), /为空/)
  assert.match(textOf(a), /unavailable/)
})

test('storage：正常读数 ⇒ 可用，并把"库数/个人数据数/未登记数"写进能力标记', () => {
  const a = createStorageAdapter(okStorageOptions())
  a.init()
  assert.equal(a.available, true)
  assert.equal(a.unavailableReason, null)
  assert.match(textOf(a), /stores:3/)
  assert.match(textOf(a), /personal:2/)
  assert.match(textOf(a), /all-v1/, 'v1 全无迁移步骤时标 all-v1')
})

test('★ storage：有未登记的存储 ⇒ 计数出现在能力标记里（这是"升级会丢数据"的信号）', () => {
  const a = createStorageAdapter(okStorageOptions({ unregistered: () => ['schedule', 'reminder'] }))
  a.init()
  assert.equal(a.available, true, '未登记不等于通道不可用 —— 但必须可见')
  assert.match(textOf(a), /unregistered:2/)
})

test('★ storage：注册函数返回的 file 路径**不得**进入任何面向用户的字段', () => {
  const a = createStorageAdapter(okStorageOptions({
    registered: () => [
      { tag: 'session', storeName: 'session', file: 'F:\\deepseek harness\\AI女友\\userData\\session.json' },
      { tag: 'memory', storeName: 'memory', file: 'C:/Users/someone/AppData/Roaming/x/memory.json' },
    ],
  }))
  a.init()
  const t = textOf(a)
  assert.equal(DRIVE.test(t), false, `泄漏了绝对路径：${t}`)
  assert.equal(t.includes('deepseek'), false, '路径段不该残留')
  assert.equal(t.includes('userData'), false, '路径段不该残留')
  // 而"登记了几个"这个计数必须还在（否则等于把有用信息一起删掉了）
  assert.match(t, /stores:3/)
})

test('★ storage：readout 只给布尔与计数，且不含路径字段', () => {
  const a = createStorageAdapter(okStorageOptions())
  a.init()
  const r = a.readout()
  assert.equal(typeof r.userDataDirExists, 'boolean', '目录只以布尔形式出现')
  assert.equal(typeof r.descriptorCount, 'number')
  assert.deepEqual(r.unregistered, [])
  // 值里不得出现盘符（任何字段）
  assert.equal(DRIVE.test(JSON.stringify(r)), false, `readout 里出现了路径：${JSON.stringify(r)}`)
  // 明确：没有 userDataDir / path / file 这类字段
  for (const k of ['userDataDir', 'path', 'file', 'files']) {
    assert.equal(k in r, false, `readout 不该有字段 ${k}`)
  }
})

test('★ storage：未登记的存储名会出现在 readout 里（名字≠路径，是允许且必要的）', () => {
  const a = createStorageAdapter(okStorageOptions({ unregistered: () => ['schedule', 'knowledge'] }))
  a.init()
  assert.deepEqual(a.readout().unregistered, ['schedule', 'knowledge'])
})

test('storage：迁移结论按**步骤数组长度**计数（steps 是数组，不是数字）', () => {
  const a = createStorageAdapter(okStorageOptions({
    catalog: () => [
      { name: 'memory', personal: true, version: 2, migrations: 1 },
      { name: 'session', personal: true, version: 1, migrations: 0 },
    ],
    migrationStates: () => ({
      memory: { steps: [{ from: 1, to: 2, describe: '加字段' }] },
      session: null,
    }),
  }))
  a.init()
  assert.equal(a.readout().migratedCount, 1)
  assert.equal(a.readout().storesWithMigrations, 1)
  assert.match(textOf(a), /with-migrations:1/)
})

test('★ storage：每次 readout 都重新采样（不得把陈旧读数缓存成"当前状态"）', () => {
  /**
   * ⚠ 用可变变量而不是自增计数器：`init()` **本身就会采样一次**，
   *   用计数器会把那次也算进去 ⇒ 断言错位（第一版就是这么写错的，跑了才看出来）。
   */
  let unreg = []
  const a = createStorageAdapter(okStorageOptions({ unregistered: () => unreg }))
  a.init()
  assert.deepEqual(a.readout().unregistered, [], '初始应为空')
  unreg = ['late-store']
  assert.deepEqual(a.readout().unregistered, ['late-store'], '改了下游读数后必须立刻反映出来')
})

// ───────────────────────────────────────────────────────────── privacy

function okPrivacyOptions(over = {}) {
  return {
    channels: () => ({ exportAvailable: true, wipeAvailable: true }),
    summary: () => ({
      files: [
        { name: 'session', exists: true, bytes: 100, kind: 'personal' },
        { name: 'memory', exists: true, bytes: 200, kind: 'personal' },
        { name: 'settings', exists: false, bytes: 0, kind: 'config' },
      ],
      secretFiles: 1,
      telemetryEnabled: false,
      logFiles: 3,
      exportFiles: 2,
    }),
    ...over,
  }
}

test('★ privacy：两条通道都没接 ⇒ 如实报不可用（用户无法行使数据主体权利）', () => {
  const a = createPrivacyAdapter(okPrivacyOptions({
    channels: () => ({ exportAvailable: false, wipeAvailable: false }),
  }))
  a.init()
  assert.equal(a.available, false)
  assert.match(String(a.unavailableReason), /没有接线/)
  assert.match(textOf(a), /unavailable/)
})

test('privacy：只有一条通道接着 ⇒ 可用（那条权利仍能行使），能力标记如实只列那条', () => {
  const a = createPrivacyAdapter(okPrivacyOptions({
    channels: () => ({ exportAvailable: true, wipeAvailable: false }),
  }))
  a.init()
  assert.equal(a.available, true)
  assert.match(textOf(a), /export/)
  assert.equal(textOf(a).includes('wipe'), false, '没接的通道不得出现在能力标记里')
})

test('privacy：两条都接着 ⇒ 可用，且只统计**存在**的文件', () => {
  const a = createPrivacyAdapter(okPrivacyOptions())
  a.init()
  assert.equal(a.available, true)
  const r = a.readout()
  assert.equal(r.filesPresent, 2, 'settings 不存在 ⇒ 不计入')
  assert.equal(r.personalFilesPresent, 2)
  assert.equal(r.secretFilesPresent, 1)
  assert.equal(r.exportFiles, 2)
})

test('★ privacy：`privacySummary()` 返回里的路径与文件名**不得**进入适配器输出', () => {
  const a = createPrivacyAdapter(okPrivacyOptions({
    summary: () => ({
      // 故意塞进一个真实形态的 userDataDir 与文件名
      userDataDir: 'F:\\deepseek harness\\AI女友\\userData',
      files: [
        { name: 'session.json', file: 'F:\\deepseek harness\\AI女友\\userData\\session.json', exists: true, bytes: 1, kind: 'personal' },
      ],
      secretFiles: 1,
      telemetryEnabled: false,
      logFiles: 0,
      exportFiles: 0,
    }),
  }))
  a.init()
  const t = textOf(a)
  const r = JSON.stringify(a.readout())
  for (const s of [t, r]) {
    assert.equal(DRIVE.test(s), false, `泄漏了绝对路径：${s}`)
    assert.equal(s.includes('userData'), false, '路径段不该残留')
    assert.equal(s.includes('session.json'), false, '文件名不该残留')
  }
})

test('★ privacy：renderer 出网事实是**常量 false**（本项目硬约束，不得被读成"未知"）', () => {
  const a = createPrivacyAdapter(okPrivacyOptions())
  a.init()
  assert.equal(a.readout().rendererCanReachNetwork, false)
  assert.match(textOf(a), /renderer-no-network/)
})

test('★ privacy：`channels` 抛异常时**不得**把适配器变成"可用"（只允许 init 标不可用）', () => {
  const a = createPrivacyAdapter(okPrivacyOptions({
    channels: () => { throw new Error('IPC 还没就绪') },
  }))
  // `init()` 里抛会让 kit 把 available 标 false 并记原因（框架行为，见 kit.ts）
  assert.throws(() => a.init(), /IPC 还没就绪/)
})

// ───────────────────────────────────────────────────────────── 两类共同

test('★ 两类：id 稳定且互不相同（诊断/激活按 id 寻址，改了就是破坏性变更）', () => {
  const s = createStorageAdapter(okStorageOptions())
  const p = createPrivacyAdapter(okPrivacyOptions())
  assert.equal(s.id, 'storage.json-descriptor-registry')
  assert.equal(p.id, 'privacy.data-subject-rights')
  assert.notEqual(s.id, p.id)
})

test('★ 两类：kind 必须是适配层声明的枚举值（写错了会在注册表里静默多出一类）', () => {
  assert.equal(createStorageAdapter(okStorageOptions()).kind, 'storage')
  assert.equal(createPrivacyAdapter(okPrivacyOptions()).kind, 'privacy')
})

test('★ 两类：许可为 first-party ⇒ 在 packaged 形态下也**允许**（存储与隐私是代码，不是资产）', () => {
  const s = createStorageAdapter(okStorageOptions())
  const p = createPrivacyAdapter(okPrivacyOptions())
  for (const a of [s, p]) {
    assert.equal(a.license.provenance, 'licensed', `${a.id} 的来源必须是 licensed`)
    assert.equal(a.license.redistributable, true, `${a.id} 自研代码可再分发`)
    assert.equal(a.license.commercialUse, true)
    assert.equal(a.origin, 'first-party')
  }
})

test('★ 两类：都如实声明会写用户内容 / 不出网（隐私审查要点，不许漏标）', () => {
  for (const a of [createStorageAdapter(okStorageOptions()), createPrivacyAdapter(okPrivacyOptions())]) {
    assert.equal(a.writesUserContent, true, `${a.id} 会碰用户数据 ⇒ 必须如实标 true`)
    assert.equal(a.requiresNetwork, false, `${a.id} 不出网`)
  }
})
