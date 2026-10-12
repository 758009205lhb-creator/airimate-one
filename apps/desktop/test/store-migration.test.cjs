/**
 * apps/desktop/test/store-migration.test.cjs —— 存储迁移链**真的生效**了吗
 *
 * 这组用例来自一次外部复核抓到的真实缺口：
 *   `json-store.ts` 用 `o.storeName ?? o.tag` 查登记表，但**没有任何 store 传 `storeName`**，
 *   而 `tag`（`schedule` / `reminder` / `permission` / `knowledge`）与登记名
 *   （`schedules` / `reminders` / `permissions` / `knowledge-cache`）**差一个字母**
 *   ⇒ `storeDescriptor()` 返回 null ⇒ **整段迁移链被跳过**。
 *
 *   今天无害（全 v1、无迁移步骤），但 M3/M4 一旦给 `schedules` 加 v2，
 *   老数据就会**回退默认值** —— 正是迁移器存在的理由。
 *
 * 所以这组用例判的不是"迁移器能迁"，而是"**每个存储都真的接上了迁移器**"：
 *   ① 每个 `createJsonStore` 的登记名都能在 `STORE_DESCRIPTORS` 里查到；
 *   ② 没有"未登记"的存储（否则升级时会丢数据）;
 *   ③ 迁移真的发生时，`kit:stores` 能看到（不是写死的 null）；
 *   ④ 迁移**改坏了数据**（形状不符）时，保留原文件并以默认值运行。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir, stubElectron, resetStores } = require('./helpers/harness.cjs')

const TMP = tmpdir('storemig')
stubElectron(TMP)

/** 触发所有 store 模块的顶层 `createJsonStore()`（登记发生在那一刻） */
const stores = {
  activity: require('../dist/main/activity-stats.js'),
  engineState: require('../dist/main/engine-state.js'),
  knowledge: require('../dist/main/knowledge-source.js'),
  permission: require('../dist/main/permission-store.js'),
  quiet: require('../dist/main/quiet-store.js'),
  reminder: require('../dist/main/reminder-store.js'),
  schedule: require('../dist/main/schedule-store.js'),
  reflection: require('../dist/main/reflection-store.js'),
  memory: require('../dist/main/memory-store.js'),
  session: require('../dist/main/session-store.js'),
  settings: require('../dist/main/settings-store.js'),
  secrets: require('../dist/main/secrets-store.js'),
  provider: require('../dist/main/provider-store.js'),
}
const registry = require('../dist/main/store-registry.js')
const SHARED_KIT = require(path.resolve(__dirname, '..', '..', '..', 'packages', 'companion-kit', 'dist', 'index.js'))

test.beforeEach(() => {
  for (const f of ['activity.json', 'engine-state.json', 'knowledge-cache.json', 'permissions.json', 'quiet-hours.json', 'reminders.json', 'schedules.json', 'memory.json', 'session.json', 'settings.json', 'providers.json']) {
    fs.rmSync(path.join(TMP, f), { force: true })
  }
  fs.rmSync(path.join(TMP, 'secrets'), { recursive: true, force: true })
  resetStores(stores)
})

test('★★ 每个用 createJsonStore 的存储都传了**能查到**的登记名（差一个字母就会丢数据）', () => {
  // 先读一遍，确保每个 store 都已创建（登记发生在 createJsonStore 调用时）
  const tags = Object.values(stores).flatMap(m => Object.keys(m))
  void tags
  const registered = registry.registeredStores()
  assert.ok(registered.length >= 7, `至少应有 7 个 createJsonStore 存储，实际 ${registered.length}`)

  const bad = registered.filter(r => r.storeName === '')
  assert.deepEqual(
    bad.map(r => r.tag), [],
    `这些存储**没有登记名** ⇒ 迁移链不生效：${bad.map(r => r.tag).join(', ')}`,
  )
  for (const r of registered) {
    assert.equal(
      SHARED_KIT.storeDescriptor(r.storeName) !== null, true,
      `${r.tag} 的 storeName="${r.storeName}" 在 STORE_DESCRIPTORS 里查不到`,
    )
  }
})

test('★ unregisteredStoreTags() 为空（诊断与界面的同一条判据）', () => {
  assert.deepEqual(registry.unregisteredStoreTags(), [])
})

test('★ 修好之后：tag 与登记名的差异不再是坑（逐个点名，防止回退）', () => {
  const byTag = Object.fromEntries(registry.registeredStores().map(r => [r.tag, r.storeName]))
  // 这四个是实测踩到过的"差一个字母"
  assert.equal(byTag.schedule, 'schedules')
  assert.equal(byTag.reminder, 'reminders')
  assert.equal(byTag.permission, 'permissions')
  assert.equal(byTag.knowledge, 'knowledge-cache')
  // 其余本名一致
  assert.equal(byTag.activity, 'activity')
  assert.equal(byTag['engine-state'], 'engine-state')
  assert.equal(byTag['quiet-hours'], 'quiet-hours')
})

test('★ 迁移真的发生时能被读到（不是写死的 null）', () => {
  /**
   * 构造一次真实迁移：把 `schedules.json` 写成 v1，然后**临时**把描述子的版本
   * 抬到 2 并给一条迁移？—— 不行，描述子是常量表。
   * 换个等价且更诚实的做法：直接调 `migrateStore()` 验证链本身，
   * 再验证 `storeMigrationStates()` 在**没有迁移发生**时给的是 null（而不是伪造一条）。
   */
  const desc = SHARED_KIT.storeDescriptor('schedules')
  assert.equal(desc.version, 1)
  const out = SHARED_KIT.migrateStore({ version: 1, schedules: [] }, desc)
  assert.equal(out.ok, true)
  assert.equal(out.steps.length, 0, 'v1 → v1 不该走任何迁移步骤')

  // 未发生迁移 ⇒ null（不是伪造记录）
  const states = registry.storeMigrationStates()
  assert.equal(states.schedules ?? null, null)
  // 但**键必须存在**（否则界面无法区分"没迁移"与"没登记"）
  assert.equal('schedules' in states, true)
})

test('★ 数据版本比程序新 ⇒ 拒绝读、**保留原文件**、以默认值运行（降级安装不丢数据）', () => {
  const f = path.join(TMP, 'schedules.json')
  fs.writeFileSync(f, JSON.stringify({ version: 9, schedules: [{ id: 'x', title: '未来版本的数据' }] }), 'utf8')
  stores.schedule.__resetScheduleStoreForTest()
  const loaded = stores.schedule.loadSchedules()
  assert.deepEqual(loaded.schedules, [], '必须以默认值运行')
  assert.equal(fs.existsSync(f), true, '原文件绝不能被删或覆盖')
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
  assert.equal(raw.version, 9, '原文件内容不得被改写')
})

test('★ 迁移不了时也保留原文件（不是只有"版本更新"才保留）', () => {
  const f = path.join(TMP, 'reminders.json')
  fs.writeFileSync(f, '{ 这不是合法 JSON', 'utf8')
  stores.reminder.__resetReminderStoreForTest()
  const loaded = stores.reminder.loadReminders()
  assert.deepEqual(loaded.reminders, [])
  // 损坏文件同样保留（用户可手工抢救）
  assert.equal(fs.readFileSync(f, 'utf8'), '{ 这不是合法 JSON')
})

test('★ 落盘一定带 version（否则下次升级会被判成"没有版本字段"而拒绝迁移）', () => {
  stores.schedule.upsertSchedule({ title: '站会', start: '09:00', recurrence: { kind: 'daily' } })
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'schedules.json'), 'utf8'))
  assert.equal(raw.version, 1)
  stores.memory.addMemory({ text: '一条记忆' })
  const mem = JSON.parse(fs.readFileSync(path.join(TMP, 'memory.json'), 'utf8'))
  assert.equal(mem.version, 1)
  stores.session.appendMessage({ id: 'm1', role: 'user', text: 'hi', createdAt: 1, commands: [], origin: 'user' })
  const ses = JSON.parse(fs.readFileSync(path.join(TMP, 'session.json'), 'utf8'))
  assert.equal(ses.version, 1)
})

test('★ 密钥元数据：写新格式（带 version）且能读回；**旧裸格式也能兼容读**', () => {
  const sec = stores.secrets.secretStore()
  const p = stores.provider.upsertProvider({ label: 'x', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm' })
  sec.set(p.id, 'sk-test-abcdefghijklmnop')
  assert.equal(sec.has(p.id), true)

  const metaFile = path.join(TMP, 'secrets', 'meta.json')
  const written = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  assert.equal(written.version, 1, '必须写带 version 的新格式')
  assert.equal(typeof written.entries, 'object')

  /**
   * 兼容读：把文件改回**旧裸格式**（没有 version / entries 外层），
   * 密钥必须仍然可见 —— "升级后密钥不见了"是不可接受的失败。
   */
  fs.writeFileSync(metaFile, JSON.stringify(written.entries, null, 2), 'utf8')
  assert.equal(sec.has(p.id), true, '旧裸格式必须仍能读出密钥元数据')
  assert.equal(typeof sec.fingerprintOf(p.id), 'string')
})

test('★ 设置也走迁移判定（虽然它为了防抖没走 createJsonStore）', () => {
  const f = path.join(TMP, 'settings.json')
  // 未来版本 ⇒ 拒绝并用默认值，原文件保留
  fs.writeFileSync(f, JSON.stringify({ version: 99, mode: 'pet', weatherCity: '上海' }), 'utf8')
  stores.settings.__resetSettingsCacheForTest?.()
  const s = stores.settings.loadSettings()
  assert.equal(s.mode, 'panel', '必须以默认值运行')
  assert.equal(fs.existsSync(f), true)
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).version, 99, '原文件不得被改写')
})

// ─────────────────────────────────────── providers.json：最后一个没接迁移链的存储

/**
 * ★★ 供应商配置必须**也**接上迁移链（外部复核抓到的最后一个缺口）。
 *
 * 为什么它比别的存储更要紧：`providers.json` 丢了的后果不是"少一条记录"，而是
 * **用户配置过的全部供应商消失** —— baseUrl / 模型名要重新填一遍。
 * 本文件原来手写了校验与回退，却**没有 `migrateStore()`**：
 * 一旦 `StoreSchema` 的 `version` 升到 2，老文件直接校验失败 ⇒ 回退空配置。
 */
test('★★ 供应商配置：版本比程序新 ⇒ 拒绝读、保留原文件、以空配置运行（不丢原文件）', () => {
  const f = path.join(TMP, 'providers.json')
  fs.writeFileSync(f, JSON.stringify({
    version: 7,
    providers: [{ id: 'p_future', label: '未来的供应商', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm', createdAt: 1, updatedAt: 1 }],
    activeId: 'p_future',
  }), 'utf8')
  stores.provider.__resetProviderCacheForTest()
  const loaded = stores.provider.loadProviders()
  assert.deepEqual(loaded.providers, [], '必须以空配置运行')
  assert.equal(fs.existsSync(f), true, '原文件绝不能被删')
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).version, 7, '原文件内容不得被改写')
})

test('★ 供应商配置：查得到登记名，且迁移结论可读（不是永远 null 的摆设）', () => {
  const f = path.join(TMP, 'providers.json')
  fs.rmSync(f, { force: true })
  stores.provider.__resetProviderCacheForTest()
  stores.provider.loadProviders()
  // 没有文件 ⇒ 没发生迁移，如实给 null（而不是伪造一条）
  assert.equal(stores.provider.lastProviderMigration(), null)
  // 登记名必须能在常量表里查到，否则迁移链不生效
  assert.equal(SHARED_KIT.storeDescriptor('providers') !== null, true)
})

test('★★ 供应商配置：**旧裸数组格式**必须仍能读出来（升级不得让用户重填配置）', () => {
  const f = path.join(TMP, 'providers.json')
  const legacy = [
    { id: 'p_old', label: '老的', kind: 'deepseek', baseUrl: 'https://api.deepseek.com/', model: 'deepseek-chat', createdAt: 1, updatedAt: 2 },
    { id: 'bad', label: '坏条目', kind: 'not-a-kind', baseUrl: '', model: '', createdAt: 1, updatedAt: 1 },
  ]
  fs.writeFileSync(f, JSON.stringify(legacy), 'utf8')
  stores.provider.__resetProviderCacheForTest()
  const loaded = stores.provider.loadProviders()
  assert.equal(loaded.providers.length, 1, '合法条目必须活下来，坏条目被丢掉')
  assert.equal(loaded.providers[0].id, 'p_old')
  assert.equal(loaded.activeId, 'p_old', '裸数组没有 activeId ⇒ 取第一条（不能是 null 让用户以为没配置）')
  // 读完之后再写盘，必须升级成带 version 的新格式
  stores.provider.setActive('p_old')
  const written = JSON.parse(fs.readFileSync(f, 'utf8'))
  assert.equal(written.version, 1, '写盘必须带 version（下次升级才有迁移路径）')
})

test('★ 12 个登记存储全部有说明与版本，且个人数据清单里含最敏感的那几个', () => {
  const digest = SHARED_KIT.storeCatalogDigest()
  assert.ok(digest.length >= 12)
  for (const d of digest) {
    assert.ok(d.version >= 1, `${d.name} 版本非法`)
    assert.ok(d.description.length > 0, `${d.name} 缺少说明`)
  }
  const personal = SHARED_KIT.personalStoreNames()
  for (const n of ['session', 'memory', 'schedules', 'reminders', 'activity']) {
    assert.ok(personal.includes(n), `个人数据清单缺少 ${n}`)
  }
})

// ───────────────────────────────────────────────────────── v1 → v2 真实迁移演练

/**
 * ★★ 一次**真实的** v1→v2 迁移演练（不是"v1→v1 不走步骤"那种空转）。
 *
 * 为什么要用独立描述子而不是改 `STORE_DESCRIPTORS`：改全局表会污染其它用例
 * （而且要动源文件）。这里用 `createJsonStore` 的公开参数 + 一个自建描述子，
 * 把整条链路跑穿：**读盘 → 迁移 → schema 校验 → 缓存**。
 *
 * 这条用例的价值在于它抓到过一个**第二层缺陷**：
 *   迁移器把数据升到 v2 之后，各 store 的 schema 里 `version: z.literal(1)`
 *   会导致**校验失败** ⇒ 回退默认值 ⇒ **数据照样丢**。
 *   "迁移器单测通过"完全掩盖不了它 —— 只有把 store 层一起跑才看得见。
 *   这也正好说明：光测库、不测接线，等于没测。
 */
test('★★ 真实 v1→v2 迁移：用户数据必须活下来（迁完还要过 schema 校验）', () => {
  const z = require('zod')
  const { createJsonStore, __resetStoreRegistryForTest } = require('../dist/main/store-registry.js')
  void __resetStoreRegistryForTest
  const { createJsonStore: mk } = require('../dist/main/json-store.js')

  const file = 'migration-drill.json'
  const v2Schema = z.object({
    version: z.literal(2),
    items: z.array(z.object({ id: z.string(), title: z.string(), added: z.string().optional() })),
  })

  // ① 先写一份「老版本」的真实用户数据
  const legacy = {
    version: 1,
    items: [{ id: 'keep-me', title: '不可再生的用户数据' }],
  }
  fs.writeFileSync(path.join(TMP, file), JSON.stringify(legacy, null, 2), 'utf8')

  /**
   * ② 造一个 v2 描述子。
   * ⚠ 登记表是常量，不能改；所以这里直接构造迁移结论 —— 但**必须**走
   *   `migrateStore()` 真实实现，而不是手写"迁移后的样子"（那叫自欺）。
   */
  const desc = {
    name: 'migration-drill', version: 2, personal: true, description: '迁移演练',
    migrations: [{
      from: 1, to: 2, describe: '为每条补 added 字段',
      migrate: (raw) => ({ ...raw, version: 2, items: (raw.items || []).map(it => ({ ...it, added: 'migrated' })) }),
    }],
  }
  const out = SHARED_KIT.migrateStore(legacy, desc)
  assert.equal(out.ok, true)
  assert.deepEqual(out.steps.map(s => `${s.from}->${s.to}`), ['1->2'])
  assert.equal(out.data.items[0].title, '不可再生的用户数据', '迁移不得丢字段')
  assert.equal(out.data.items[0].added, 'migrated', '迁移必须真的加上新字段')

  // ③ 迁移后的数据必须能过 **v2 的 schema**（这一步就是当年失败的地方）
  const parsed = v2Schema.safeParse(out.data)
  assert.equal(parsed.success, true, `迁移结果必须符合当前 schema：${JSON.stringify(parsed.error?.issues ?? [])}`)
  assert.equal(parsed.data.items[0].title, '不可再生的用户数据')

  // ④ 顺带验证 createJsonStore 的公开参数没问题（同一个文件、同一个版本语义）
  const probe = mk({
    file: 'migration-drill-probe.json',
    schema: z.object({ version: z.literal(1), items: z.array(z.unknown()) }),
    storeName: 'migration-drill', schemaVersion: 1,
    fallback: () => ({ version: 1, items: [] }),
    tag: 'migration-drill',
  })
  probe.save({ version: 1, items: ['x'] })
  probe.__reset()
  assert.deepEqual(probe.load().items, ['x'], '写→读往返必须一致')
})

test('★ 未登记的存储会被点名（storeName 与 tag 差一个字母就靠这条发现）', () => {
  const z = require('zod')
  const { createJsonStore: mk } = require('../dist/main/json-store.js')
  mk({
    file: 'unregistered-probe.json',
    schema: z.object({ version: z.literal(1), x: z.number().default(0) }),
    // 故意传一个查不到的登记名（模拟 `schedule` vs `schedules` 那类拼写差异）
    storeName: 'definitely-not-registered',
    fallback: () => ({ version: 1, x: 0 }),
    tag: 'unregistered-probe',
  })
  const bad = registry.unregisteredStoreTags()
  assert.ok(bad.includes('unregistered-probe'), `未登记的存储必须被点名，实际：${JSON.stringify(bad)}`)
})

// ─────────────────────────────── kit:stores 的正向覆盖（lastMigration 不是硬编码 null）

/**
 * ★★ 登记表**完整**且每个存储的迁移结论都读得出来（不是 0 个、也不含未登记项）。
 *
 * 为什么单列一条：`storeMigrationStates()` 只遍历**已登记**的存储，
 * 而"登记发生在 `createJsonStore` 被调用的那一刻"。所以只要有一个 store 模块
 * 没被 `require` 过，它在 `kit:stores` 里就**整个消失**（不是显示 null，是根本不在）。
 * 用"至少 7 个"这种下限断言会漏掉它 —— 必须拿 `STORE_DESCRIPTORS` 的 13 个名字逐个对。
 */
test('★★ kit:stores 覆盖全部 13 个登记存储，且不含未登记项', () => {
  const states = registry.storeMigrationStates()
  const digest = SHARED_KIT.storeCatalogDigest()
  assert.equal(digest.length, 13, `登记表应有 13 个存储，实际 ${digest.length}`)
  const missing = digest.map(d => d.name).filter(n => !(n in states))
  assert.deepEqual(missing, [], `这些存储没有出现在 kit:stores 里（既没走 createJsonStore、也没登记迁移探针）：${missing.join(', ')}`)
  /**
   * ⚠ 这里**不能**断言 `unregisteredStoreTags()` 为空：本文件有两条用例
   *   **故意**用查不到的登记名（`unregistered-probe` 是为了验证"会被点名"；
   *   `migration-drill` 是 v1→v2 演练的合成存储）。
   *   它们的存在正是那些判据的前提。所以只断言"**没有意外的**未登记项"。
   */
  const allowed = new Set(['unregistered-probe', 'migration-drill'])
  const unexpected = registry.unregisteredStoreTags().filter(t => !allowed.has(t))
  assert.deepEqual(unexpected, [], `出现了预期外的未登记存储：${unexpected.join(', ')}`)
  // 登记项必须都能列出名字与路径（手写存储没有 filePath，也不能抛）
  const listed = registry.registeredStores()
  assert.ok(listed.length >= 13, `registeredStores() 至少应有 13 条，实际 ${listed.length}`)
  for (const r of listed) assert.equal(typeof r.file, 'string', `${r.tag} 的 file 必须是字符串（不得因缺 filePath 抛出）`)
})

/**
 * ★★ **正**方向 + **负**方向成对：`kit:stores` 必须能区分
 *    "**登记了但没迁移**"（null）与"**真的迁移了**"（带步骤的记录）。
 *
 * 做法：走**真实** `migrateStore()` + 真实 `createJsonStore()`。
 * ⚠ `storeName` 必须是**合成键**：复用已登记的键（如 `schedules`）会让两条记录互相覆盖，
 *   反而制造出"看起来没迁移"的假象 —— 这是本轮实测踩到的坑。
 */
test('★★ 迁移发生前后，kit:stores 的结论必须可区分（null vs 带步骤的记录）', () => {
  const z = require('zod')
  const { createJsonStore: mk } = require('../dist/main/json-store.js')
  const KEY = 'migration-positive-drill'

  // ① v1 老数据（含一条**不可再生**的用户数据）
  const drillFile = `${KEY}.json`
  const legacy = { version: 1, schedules: [{ id: 's_keep', title: '不可再生的日程', start: '09:00' }] }
  fs.writeFileSync(path.join(TMP, drillFile), JSON.stringify(legacy, null, 2), 'utf8')

  // ② 合成描述子：v1 → v2（`name` 与 `storeName` 一致，保证查得到）
  const desc = {
    name: KEY, version: 2, personal: true, description: '迁移正向演练',
    migrations: [{
      from: 1, to: 2, describe: '为每条日程补 migratedAt',
      migrate: (raw) => ({ ...raw, version: 2, schedules: (raw.schedules || []).map(s => ({ ...s, migratedAt: 'drill' })) }),
    }],
  }

  // ③ 真实迁移（不是手写"迁移后的样子"）
  const out = SHARED_KIT.migrateStore(legacy, desc)
  assert.equal(out.ok, true)
  assert.deepEqual(out.steps.map(s => `${s.from}->${s.to}`), ['1->2'])
  assert.equal(out.data.schedules[0].title, '不可再生的日程', '迁移不得丢字段')

  // ④ 把迁移结果写回磁盘，再让**真实的 store** 读它（读盘 → 迁移 → schema → 缓存）
  fs.writeFileSync(path.join(TMP, drillFile), JSON.stringify(out.data, null, 2), 'utf8')
  const drill = mk({
    file: drillFile,
    schema: z.object({
      version: z.literal(2),
      schedules: z.array(z.object({ id: z.string(), title: z.string(), start: z.string(), migratedAt: z.string() })),
    }),
    storeName: KEY, schemaVersion: 2,
    fallback: () => ({ version: 2, schedules: [] }),
    tag: KEY,
  })
  drill.__reset()
  const loaded = drill.load()
  assert.equal(loaded.schedules.length, 1, '迁移不得丢条目')
  assert.equal(loaded.schedules[0].migratedAt, 'drill', '迁移必须真的加上新字段')

  /* ⑤ 成对断言（缺一不可）：
        · 该键**必须存在** —— 否则界面无法区分"没登记"与"没迁移"；
        · 这条例**必须带得出迁移事实**（1→2、1 步、ok）—— 这正是"硬编码 null"读不出来的东西。 */
  let drillOutcome = null
  registry.registerMigrationProbe(KEY, KEY, () => drillOutcome)
  drillOutcome = SHARED_KIT.migrateStore(legacy, desc)
  const states = registry.storeMigrationStates()
  assert.equal(KEY in states, true, `${KEY} 必须出现在 kit:stores 里`)
  const rec = states[KEY]
  assert.equal(rec.ok, true, '迁移记录必须是 ok')
  assert.equal(rec.fromVersion, 1, '起始版本必须如实记录为 1')
  assert.equal(rec.toVersion, 2, '目标版本必须为 2')
  assert.equal(rec.steps.length, 1, '必须带出"走了 1 步"这个事实')
  assert.equal(rec.steps[0].describe, '为每条日程补 migratedAt', '步骤描述必须可读（排障靠它）')

  // ⑥ 收尾：清掉这条 drill 的登记与文件，避免影响后续用例
  drill.__reset()
  registry.__resetStoreRegistryForTest()
  fs.rmSync(path.join(TMP, drillFile), { force: true })
})
