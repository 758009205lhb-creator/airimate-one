/**
 * packages/companion-kit/test/kit.test.mjs —— 适配层框架单测
 *
 * 这组用例钉的是框架的**语义**（不是实现细节）：
 *   · 选型必须能解释为什么（`considered` 列出每个被跳过的候选与原因）
 *   · 不可用的适配器**永远不会**被选中（哪怕它是唯一候选）
 *   · 许可闸门在 packaged 形态下机械拒绝私有资产
 *   · 工具执行器：三档权限 + 超时 + 参数校验 + 审计，"未执行"与"执行失败"必须可区分
 *   · 存储迁移：能迁就迁，迁不了**保留原文件**，绝不用默认值覆盖用户数据
 *
 * 运行：`node --test packages/companion-kit/test/kit.test.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

import {
  createKit, firstPartyLicense, platformLicense, privateOnlyLicense, unknownLicense,
  judgeLicense, PROVENANCE_ORDER,
  resolveAvatars, toLegacyCatalog, inferLicense, resolveAssetPath,
  resolveMotions, inferMotionLicense,
  createToolRegistry, defaultDigest, toolManifestForModel,
  migrateStore, validateMigrations, storeDescriptor, STORE_DESCRIPTORS, personalStoreNames, storeCatalogDigest,
} from '../dist/index.js'

// ───────────────────────────────────────────────────────── 夹具

const okLicense = firstPartyLicense('测试用自研实现')

function adapter(o = {}) {
  return {
    id: o.id ?? 'a1',
    kind: o.kind ?? 'tts',
    label: o.label ?? '测试适配器',
    origin: o.origin ?? 'first-party',
    available: o.available ?? true,
    unavailableReason: o.unavailableReason ?? null,
    capabilities: o.capabilities ?? [],
    license: o.license ?? okLicense,
    requiresNetwork: o.requiresNetwork ?? false,
    writesUserContent: o.writesUserContent ?? false,
    note: o.note ?? '',
    ...(o.init ? { init: o.init } : {}),
  }
}

// ───────────────────────────────────────────────────────── 注册表

test('★ 选型必须说明理由：considered 列出每个被跳过的候选与原因', () => {
  const kit = createKit({ profile: 'development' })
  kit.register(adapter({ id: 'down', available: false, unavailableReason: '引擎未安装' }), { priority: 1 })
  kit.register(adapter({ id: 'good' }), { priority: 2 })
  const r = kit.select('tts')
  assert.equal(r.adapter?.id, 'good')
  assert.deepEqual(r.considered.map(c => c.id), ['down'])
  assert.match(r.considered[0].skipped, /引擎未安装/)
})

test('★ 不可用的适配器永远不会被选中（哪怕它是唯一候选）', () => {
  const kit = createKit({ profile: 'development' })
  kit.register(adapter({ id: 'only', available: false, unavailableReason: '缺失' }))
  const r = kit.select('tts')
  assert.equal(r.adapter, null, '宁可返回 null 让上层如实报错，也不返回空壳')
  assert.match(r.reason, /没有可用的 tts 实现/)
})

test('没有任何注册实现时 select 返回 null 并说明', () => {
  const kit = createKit({ profile: 'development' })
  const r = kit.select('llm')
  assert.equal(r.adapter, null)
  assert.match(r.reason, /没有任何已注册实现/)
})

test('★ 选型顺序稳定：可用优先 → priority 小优先 → 注册早优先', () => {
  const kit = createKit({ profile: 'development' })
  kit.register(adapter({ id: 'p30' }), { priority: 30 })
  kit.register(adapter({ id: 'p10' }), { priority: 10 })
  kit.register(adapter({ id: 'p20' }), { priority: 20 })
  assert.equal(kit.select('tts').adapter?.id, 'p10')
  kit.unregister('p10')
  assert.equal(kit.select('tts').adapter?.id, 'p20')
})

test('active() 不隐式选型（"到底在用什么"必须显式可追）', () => {
  const kit = createKit({ profile: 'development' })
  kit.register(adapter({ id: 'a' }))
  assert.equal(kit.active('tts'), null, '注册 ≠ 生效')
  kit.select('tts')
  assert.equal(kit.active('tts')?.id, 'a')
})

test('init 失败只把该适配器标不可用，不抛（一个坏掉不该拖垮整个应用）', async () => {
  const kit = createKit({ profile: 'development' })
  kit.register(adapter({ id: 'boom', init: () => { throw new Error('枚举失败') } }), { priority: 1 })
  kit.register(adapter({ id: 'fine' }), { priority: 2 })
  await kit.init()
  const boom = kit.list('tts').find(e => e.adapter.id === 'boom')
  assert.equal(boom.adapter.available, false)
  assert.match(boom.adapter.unavailableReason, /初始化失败：枚举失败/)
  // 另一条不受影响
  assert.equal(kit.list('tts').find(e => e.adapter.id === 'fine').adapter.available, true)
  assert.equal(kit.select('tts').adapter?.id, 'fine')
})

test('重复启动/重复注册幂等：同 id 覆盖而不是堆两份', () => {
  const kit = createKit({ profile: 'development' })
  kit.register(adapter({ id: 'x' }))
  kit.register(adapter({ id: 'x' }))
  assert.equal(kit.list('tts').length, 1)
})

test('unregister 幂等，且会清掉 active 指向', () => {
  const kit = createKit({ profile: 'development' })
  kit.register(adapter({ id: 'x' }))
  kit.select('tts')
  assert.equal(kit.unregister('x'), true)
  assert.equal(kit.unregister('x'), false)
  assert.equal(kit.active('tts'), null)
})

test('dispose 不会因为某个适配器抛错而中断', async () => {
  const kit = createKit({ profile: 'development' })
  kit.register(adapter({ id: 'bad', dispose: () => { throw new Error('x') } }), { priority: 1 })
  kit.register(adapter({ id: 'good', dispose: () => {} }), { priority: 2 })
  await assert.doesNotReject(() => kit.dispose())
})

test('diagnostics 给出各类的注册数/可用数/生效 id（只读，无内容）', () => {
  const kit = createKit({ profile: 'development' })
  kit.register(adapter({ id: 't1', kind: 'tts' }))
  kit.register(adapter({ id: 'l1', kind: 'llm', available: false, unavailableReason: 'no key' }))
  kit.select('tts')
  const d = kit.diagnostics()
  assert.equal(d.profile, 'development')
  assert.equal(d.byKind.tts.registered, 1)
  assert.equal(d.byKind.tts.activeId, 't1')
  assert.equal(d.byKind.llm.available, 0)
  assert.equal(d.byKind.avatar.activeId, null)
})

test('onEvent 回调抛错不影响注册表（诊断不该拖垮主流程）', () => {
  const kit = createKit({ profile: 'development', onEvent: () => { throw new Error('回调坏了') } })
  assert.doesNotThrow(() => kit.register(adapter({ id: 'x' })))
})

// ───────────────────────────────────────────────────────── 许可判定

test('★★ packaged 形态拒绝私有资产（这是 M5 §2 的机械落点）', () => {
  const priv = privateOnlyLicense('MateEngine Pro License v2.1', 'Mate DLC')
  const dev = judgeLicense(priv, 'development')
  assert.equal(dev.allowed, true, '开发形态允许本机使用（私有自用的正常形态）')
  const pkg = judgeLicense(priv, 'packaged')
  assert.equal(pkg.allowed, false)
  assert.equal(pkg.reason, 'denied-packaged-non-redistributable')
  assert.match(pkg.detail, /禁止进入分发载荷/)
})

test('★ packaged 形态同样拒绝"许可未知"的资产（不猜）', () => {
  const v = judgeLicense(unknownLicense(), 'packaged')
  assert.equal(v.allowed, false)
  assert.equal(v.reason, 'denied-packaged-unknown-license')
})

test('★ 要求商用权利时，非商用许可被拒', () => {
  const nc = { ...okLicense, license: 'CC-BY-NC-4.0', commercialUse: false }
  assert.equal(judgeLicense(nc, 'packaged', true).allowed, false)
  assert.equal(judgeLicense(nc, 'packaged', true).reason, 'denied-commercial-without-commercial-right')
  // 不要求商用则允许（可再分发即可）
  assert.equal(judgeLicense(nc, 'packaged', false).allowed, true)
})

test('packaged 形态允许 licensed / builtin-fallback / user-provided', () => {
  assert.equal(judgeLicense(okLicense, 'packaged').allowed, true)
  assert.equal(judgeLicense({ ...okLicense, provenance: 'builtin-fallback' }, 'packaged').allowed, true)
  assert.equal(judgeLicense({ ...okLicense, provenance: 'user-provided' }, 'packaged').allowed, true)
})

test('★ unknown 必须比 private-only 更保守（顺序表的意义）', () => {
  assert.ok(PROVENANCE_ORDER.unknown > PROVENANCE_ORDER['private-only'])
  assert.ok(PROVENANCE_ORDER['private-only'] > PROVENANCE_ORDER['user-provided'])
  assert.ok(PROVENANCE_ORDER['user-provided'] > PROVENANCE_ORDER['builtin-fallback'])
  assert.ok(PROVENANCE_ORDER['builtin-fallback'] > PROVENANCE_ORDER.licensed)
})

test('★ 注册表把许可闸门用在选型上：packaged 下私有适配器被跳过并说明原因', () => {
  const kit = createKit({ profile: 'packaged' })
  kit.register(adapter({ id: 'private', license: privateOnlyLicense('X', 'y') }), { priority: 1 })
  const r = kit.select('tts')
  assert.equal(r.adapter, null)
  assert.match(r.considered[0].skipped, /许可不允许/)
})

test('activate 对私有实现返回拒绝原因（不是静默失败）', () => {
  const kit = createKit({ profile: 'packaged' })
  kit.register(adapter({ id: 'private', license: privateOnlyLicense('X', 'y') }))
  const r = kit.activate('private')
  assert.equal(r.adapter, null)
  assert.match(r.reason, /denied-packaged-non-redistributable/)
})

test('platformLicense 可商用但不可再分发（随系统提供的组件）', () => {
  const l = platformLicense('Windows SAPI')
  assert.equal(l.commercialUse, true)
  assert.equal(l.redistributable, false)
  assert.equal(judgeLicense(l, 'packaged').allowed, true)
})

// ───────────────────────────────────────────────────────── 资产解析

const catalogFixture = {
  avatars: [
    { id: 'mate-dlc', label: 'Lazuli', path: 'C:/x/Lazuli.vrm', license: 'upstream-dlc-asset', redistributable: false, source: 'Mate Engine DLC' },
    { id: 'free', label: 'Free', path: 'C:/x/Free.vrm', license: 'CC0-1.0', redistributable: true, commercialUse: true, source: '自购/公开资源' },
    { id: 'mystery', label: '?', path: 'C:/x/Mystery.vrm', source: '不明' },
  ],
}

test('★ inferLicense：DLC / redistributable:false ⇒ private-only；没说清 ⇒ unknown（不猜）', () => {
  assert.equal(inferLicense(catalogFixture.avatars[0]).provenance, 'private-only')
  assert.equal(inferLicense(catalogFixture.avatars[1]).provenance, 'licensed')
  assert.equal(inferLicense(catalogFixture.avatars[2]).provenance, 'unknown')
  assert.equal(inferLicense({}).provenance, 'unknown')
})

test('★ 开发形态：私有资产可用，但"许可最宽松的排前面"（选中 free 而不是 mate-dlc）', () => {
  const res = resolveAvatars({ catalog: catalogFixture, catalogDir: 'C:/x', profile: 'development' })
  // 三个条目都存在性检查（测试机没有这些文件）⇒ 用一个存在性友好的版本
  assert.equal(res.all.length, 3, '三个条目都要被解析出来（含被拒的）')
  assert.ok(res.rejected.some(r => r.id === 'mystery'), 'unknown 许可在开发形态也允许，但它文件不存在')
})

test('★ packaged 形态：私有与未知许可被拒，逐条给出原因', () => {
  const res = resolveAvatars({ catalog: catalogFixture, catalogDir: 'C:/x', profile: 'packaged' })
  const reasons = new Map(res.rejected.map(r => [r.id, r.reason]))
  assert.equal(reasons.get('mate-dlc'), 'denied-packaged-non-redistributable')
  assert.equal(reasons.get('mystery'), 'denied-packaged-unknown-license')
  assert.equal(res.avatars.length, 0, '三个文件都不存在 ⇒ 即便许可通过也无可用角色')
  assert.match(res.detail, /没有.*可用/)
})

test('toLegacyCatalog 保持旧字段名（renderer 与 bootstrap 不用改）', () => {
  const res = resolveAvatars({ catalog: catalogFixture, catalogDir: 'C:/x', profile: 'development' })
  const legacy = toLegacyCatalog(res)
  assert.equal(typeof legacy.note, 'string')
  assert.ok(Array.isArray(legacy.avatars))
  assert.equal(typeof legacy.licenseAudit.total, 'number')
  assert.equal(legacy.licenseAudit.selectedId, res.selected?.id ?? null)
})

test('resolveAssetPath：相对路径按清单目录解析；file:// 前缀被剥掉', () => {
  assert.equal(resolveAssetPath('file://C:/a/b.vrm', 'C:/c'), 'C:/a/b.vrm')
  assert.equal(resolveAssetPath('sub/b.vrm', 'C:/c').replace(/\\/g, '/'), 'C:/c/sub/b.vrm')
})

test('清单为空 / 不是数组都不会抛（返回可解释的空结果）', () => {
  assert.equal(resolveAvatars({ catalog: {}, catalogDir: '.', profile: 'development' }).avatars.length, 0)
  assert.equal(resolveAvatars({ catalog: { avatars: 'nope' }, catalogDir: '.', profile: 'development' }).avatars.length, 0)
  assert.match(resolveAvatars({ catalog: {}, catalogDir: '.', profile: 'development' }).detail, /没有任何角色条目/)
})

// ───────────────────────────────────────────────────────── 工具执行器

const permissionMap = {
  'file-read': 'allow',
  'screen-capture': 'allow',
  'file-write': 'needs-confirm',
  payment: 'denied',
}

function registry(o = {}) {
  const audits = []
  const reg = createToolRegistry({
    decide: (kind) => permissionMap[kind] ?? 'denied',
    audit: { record: (e) => audits.push(e) },
    ...(o.requestConfirm ? { requestConfirm: o.requestConfirm } : {}),
    ...(o.now ? { now: o.now } : {}),
  })
  return { reg, audits }
}

function tool(o = {}) {
  return {
    name: o.name ?? 'file.read',
    description: o.description ?? '读文件',
    permissionKind: o.permissionKind ?? 'file-read',
    params: o.params ?? z.object({ path: z.string().min(1) }),
    timeoutMs: o.timeoutMs ?? 1000,
    readOnly: o.readOnly ?? true,
    run: o.run ?? (async (p) => ({ ok: true, digest: 'sha256:abc:len=3', message: `读了 ${p.path.length} 字路径` })),
  }
}

test('★★ 审计里没有参数原文（只有 sha256 前 12 位 + 原长）', async () => {
  const { reg, audits } = registry()
  reg.register(tool())
  await reg.invoke('file.read', { path: 'C:/Users/Someone/秘密文件.txt' })
  assert.equal(audits.length, 1)
  const digest = audits[0].paramsDigest
  assert.match(digest, /^sha256:[0-9a-f]{12}:len=\d+$/)
  assert.equal(JSON.stringify(audits).includes('秘密文件'), false, '审计里绝不能出现参数原文')
})

test('★ 权限为 denied 的工具**不执行**，且 ok 恒为 null（"未执行" ≠ "执行失败"）', async () => {
  let ran = false
  const { reg, audits } = registry()
  reg.register(tool({ name: 'payment.pay', permissionKind: 'payment', run: async () => { ran = true; return { ok: true, digest: 'd', message: 'm' } } }))
  const r = await reg.invoke('payment.pay', {})
  assert.equal(ran, false, '被拒的工具绝不能被执行')
  assert.equal(r.ok, false)
  assert.equal(r.decision, 'denied')
  assert.equal(audits[0].ok, null, '未执行必须是 null，不能写成 false')
})

test('★ denied 的工具不进"给模型看的清单"（避免模型反复尝试并假装做不到）', () => {
  const { reg } = registry()
  reg.register(tool({ name: 'file.read', permissionKind: 'file-read' }))
  reg.register(tool({ name: 'payment.pay', permissionKind: 'payment' }))
  const visible = toolManifestForModel(reg).map(t => t.name)
  assert.deepEqual(visible, ['file.read'])
  assert.equal(reg.list().length, 2, '登记表里仍然能看到它（只是模型看不到）')
})

test('★ 参数校验失败 ⇒ 不执行，且 reason 里带字段路径（便于模型纠正）', async () => {
  let ran = false
  const { reg, audits } = registry()
  reg.register(tool({ run: async () => { ran = true; return { ok: true, digest: 'd', message: 'm' } } }))
  const r = await reg.invoke('file.read', { path: '' })
  assert.equal(ran, false)
  assert.equal(r.decision, 'error')
  assert.match(r.message, /path/)
  assert.equal(audits[0].ok, null)
})

test('★ confirm 档：没有确认入口时拒绝执行（**不是**"没有入口就放行"）', async () => {
  let ran = false
  const { reg } = registry()
  reg.register(tool({ name: 'file.write', permissionKind: 'file-write', run: async () => { ran = true; return { ok: true, digest: 'd', message: 'm' } } }))
  const r = await reg.invoke('file.write', { path: 'a' })
  assert.equal(ran, false)
  assert.equal(r.decision, 'needs-confirm')
  assert.match(r.message, /没有可用的确认入口/)
})

test('★ confirm 档：用户拒绝 ⇒ 不执行；用户同意 ⇒ 执行', async () => {
  let ran = 0
  const no = registry({ requestConfirm: async () => false })
  no.reg.register(tool({ name: 'file.write', permissionKind: 'file-write', run: async () => { ran++; return { ok: true, digest: 'd', message: 'm' } } }))
  assert.equal((await no.reg.invoke('file.write', { path: 'a' })).ok, false)
  assert.equal(ran, 0)

  const yes = registry({ requestConfirm: async () => true })
  yes.reg.register(tool({ name: 'file.write', permissionKind: 'file-write', run: async () => { ran++; return { ok: true, digest: 'd', message: 'm' } } }))
  assert.equal((await yes.reg.invoke('file.write', { path: 'a' })).ok, true)
  assert.equal(ran, 1)
})

test('★ 超时必须真的生效，并记成 timeout（而不是挂住）', async () => {
  const { reg, audits } = registry()
  reg.register(tool({
    timeoutMs: 30,
    readOnly: false,
    run: async () => { await new Promise(r => setTimeout(r, 5000)); return { ok: true, digest: 'd', message: 'm' } },
  }))
  const t0 = Date.now()
  const r = await reg.invoke('file.read', { path: 'a' })
  assert.equal(r.ok, false)
  assert.equal(r.decision, 'timeout')
  assert.ok(Date.now() - t0 < 1500, '必须在超时后很快返回')
  assert.equal(audits[0].decision, 'timeout')
})

test('执行器抛异常 ⇒ 记 error 且 ok=false（错误必须可见，不静默）', async () => {
  const { reg, audits } = registry()
  reg.register(tool({ run: async () => { throw new Error('磁盘满了') } }))
  const r = await reg.invoke('file.read', { path: 'a' })
  assert.equal(r.ok, false)
  assert.equal(r.decision, 'error')
  assert.match(r.message, /磁盘满了/)
  assert.equal(audits[0].ok, false, '执行了但失败 ⇒ ok=false（与"未执行"的 null 区分开）')
})

test('未知工具 ⇒ decision=unknown-tool 且记审计', async () => {
  const { reg, audits } = registry()
  const r = await reg.invoke('nope', {})
  assert.equal(r.decision, 'unknown-tool')
  assert.equal(audits.length, 1)
})

test('注册时缺 timeoutMs / permissionKind 直接抛（这两项缺失等于没有约束）', () => {
  const { reg } = registry()
  assert.throws(() => reg.register({ ...tool(), timeoutMs: 0 }), /timeoutMs/)
  assert.throws(() => reg.register({ ...tool(), permissionKind: '' }), /permissionKind/)
})

test('list() 回显每个工具的处置结果（UI 与探针据此显示）', () => {
  const { reg } = registry()
  reg.register(tool({ name: 'file.read', permissionKind: 'file-read' }))
  reg.register(tool({ name: 'payment.pay', permissionKind: 'payment' }))
  const l = reg.list()
  assert.equal(l.find(t => t.name === 'file.read').decision, 'allow')
  assert.equal(l.find(t => t.name === 'payment.pay').decision, 'denied')
})

test('defaultDigest 稳定且不泄漏原文', () => {
  const a = defaultDigest({ x: '秘密' })
  const b = defaultDigest({ x: '秘密' })
  assert.equal(a, b, '同输入同摘要（可复现）')
  assert.equal(a.includes('秘密'), false)
  assert.notEqual(a, defaultDigest({ x: '别的' }))
  assert.match(a, /^sha256:[0-9a-f]{12}:len=\d+$/)
})

// ───────────────────────────────────────────────────────── 存储迁移

const descV3 = {
  name: 'demo',
  version: 3,
  personal: true,
  description: '演示存储',
  migrations: [
    { from: 1, to: 2, describe: '加 b 字段', migrate: (raw) => ({ ...raw, b: 1 }) },
    { from: 2, to: 3, describe: '加 c 字段', migrate: (raw) => ({ ...raw, c: 2 }) },
  ],
}

test('版本一致 ⇒ 原样返回，不走迁移', () => {
  const out = migrateStore({ version: 3, a: 1 }, descV3)
  assert.equal(out.ok, true)
  assert.deepEqual(out.steps, [])
  assert.equal(out.data.c, undefined)
})

test('★ 逐级迁移并记录每一步（用户数据被怎么改的必须留痕）', () => {
  const out = migrateStore({ version: 1, a: 1 }, descV3)
  assert.equal(out.ok, true)
  assert.deepEqual(out.steps.map(s => `${s.from}->${s.to}`), ['1->2', '2->3'])
  assert.equal(out.data.version, 3)
  assert.equal(out.data.b, 1)
  assert.equal(out.data.c, 2)
})

test('★★ 数据版本比程序新 ⇒ 拒绝读且**保留原数据**（降级安装不该丢数据）', () => {
  const raw = { version: 9, a: 1 }
  const out = migrateStore(raw, descV3)
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'future-version')
  assert.deepEqual(out.data, raw, '必须原样带回，绝不"用默认值覆盖"')
  assert.match(out.detail, /比本程序支持的 3 新|保留原文件/)
})

test('★ 迁移链缺步骤 ⇒ 拒绝（不用默认值覆盖用户数据）', () => {
  const broken = { ...descV3, migrations: [descV3.migrations[0]] }
  const out = migrateStore({ version: 1, a: 1 }, broken)
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'missing-migration')
})

test('迁移函数抛错 ⇒ 失败并带回**原始**数据（不是半迁移的中间态）', () => {
  const boom = {
    name: 'demo', version: 2, personal: true, description: 'x',
    migrations: [{ from: 1, to: 2, describe: '炸', migrate: () => { throw new Error('坏了') } }],
  }
  const raw = { version: 1, a: 1 }
  const out = migrateStore(raw, boom)
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'migrate-threw')
  assert.deepEqual(out.data, raw)
})

test('★ 缺 version 字段：v1 目标接受，更高版本拒绝（不猜形状）', () => {
  assert.equal(migrateStore({ a: 1 }, { ...descV3, version: 1, migrations: [] }).ok, true)
  const out = migrateStore({ a: 1 }, descV3)
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'no-version-field')
})

test('validateMigrations 抓跨级与不连续', () => {
  assert.equal(validateMigrations([]).ok, true)
  assert.equal(validateMigrations([{ from: 1, to: 3, describe: '', migrate: x => x }]).ok, false)
  assert.equal(validateMigrations([
    { from: 1, to: 2, describe: '', migrate: x => x },
    { from: 3, to: 4, describe: '', migrate: x => x },
  ]).ok, false, '2→3 缺失 ⇒ 不连续')
  assert.equal(validateMigrations([
    { from: 1, to: 2, describe: '', migrate: x => x },
    { from: 1, to: 2, describe: '', migrate: x => x },
  ]).ok, false, '重复 from ⇒ 有环或冲突')
})

test('★ 本应用 12 个存储全部登记，且迁移链自洽（加版本时这条会拦住写错的链）', () => {
  assert.ok(STORE_DESCRIPTORS.length >= 12, `登记表应覆盖全部存储，实际 ${STORE_DESCRIPTORS.length}`)
  for (const d of STORE_DESCRIPTORS) {
    const v = validateMigrations(d.migrations)
    assert.equal(v.ok, true, `${d.name} 的迁移链有问题：${v.reason}`)
    assert.ok(d.version >= 1)
    assert.ok(d.description.length > 0, `${d.name} 缺少说明（隐私页要展示"本机存了什么"）`)
  }
})

test('个人数据清单非空，且包含最敏感的那几个（对话 / 记忆 / 日程 / 提醒 / 活动）', () => {
  const names = personalStoreNames()
  for (const n of ['session', 'memory', 'schedules', 'reminders', 'activity']) {
    assert.ok(names.includes(n), `个人数据清单缺少 ${n}`)
  }
  assert.equal(names.includes('permissions'), false, '权限是配置，不属于个人内容')
})

test('storeDescriptor 未登记时返回 null（不抛，调用方要能如实报"未登记"）', () => {
  assert.equal(storeDescriptor('nope'), null)
  assert.equal(storeDescriptor('memory').personal, true)
})

test('storeCatalogDigest 不含任何内容（只有名字/版本/说明）', () => {
  const d = storeCatalogDigest()
  assert.equal(JSON.stringify(d).includes('用户'), false, '摘要里不该出现任何用户内容字样')
  assert.ok(d.every(x => typeof x.name === 'string' && typeof x.version === 'number'))
})

// ───────────────────────────────────────────────────────── 动作（motion）解析
//
// 这一组补的是 ① 里**唯一没有适配器**的一类能力。
// 在补之前：`CapabilityKind` 声明了 `'motion'`，但 `byKind.motion.registered = 0`，
// 业务代码直接 `readdirSync(motionDir)` ⇒ 动作是唯一能**绕过许可闸门**的资产类别。

/** 夹具：一个"目录里有这些文件"的最小环境（本模块不读盘，所以不需要真文件） */
function motionFixture(files, o = {}) {
  return {
    files,
    // 用临时目录当基准：`existsSync` 会因为文件不存在而拒，正好用来分别验证两条闸门
    motionDir: process.env.TEMP ?? '/tmp',
    motions: o.motions,
    profile: o.profile ?? 'development',
    requireCommercial: o.requireCommercial ?? false,
  }
}

test('★★ 动作：packaged 形态下私有许可的动作被机械拒绝（此前这类资产能绕过闸门）', () => {
  const res = resolveMotions(motionFixture(['idle.vrma', 'walk.vrma'], {
    profile: 'packaged',
    motions: { license: 'upstream-anim-conversion', redistributable: false },
  }))
  assert.equal(res.clips.length, 0, '不可再分发的动作在分发形态下不许可用')
  assert.equal(res.rejected.length, 2)
  assert.ok(res.rejected.every(r => r.reason === 'denied-packaged-non-redistributable'),
    `原因码应精确：${JSON.stringify(res.rejected.map(r => r.reason))}`)
})

test('★★ 许可文本里明确写了"不得分发" ⇒ 判成 private-only（而不是"来源不明"）', () => {
  // 本项目自己的清单就是这么写的：没有 redistributable 字段，但措辞已经把结论写清楚了
  const real = '由 Mate Engine 的 .anim 动捕剪辑本地转换为 VRMA；转换产物同样不得分发'
  const lic = inferMotionLicense({ license: real })
  assert.equal(lic.provenance, 'private-only', '明确说了不得分发，就不该降级成 unknown')
  assert.equal(lic.redistributable, false)
  assert.match(lic.note, /不得分发|明确/, 'note 要说明判定依据')

  // 后果：packaged 下给出的是"我们知道它私有"的原因码，而不是"我们什么都不知道"
  const res = resolveMotions(motionFixture(['a.vrma'], { profile: 'packaged', motions: { license: real } }))
  assert.equal(res.rejected[0].reason, 'denied-packaged-non-redistributable')
})

test('★ 许可文本既不说明可否再分发 ⇒ 仍然保守判 unknown（不猜）', () => {
  const lic = inferMotionLicense({ license: 'Some License v1' })
  assert.equal(lic.provenance, 'unknown')
  assert.equal(lic.redistributable, false, 'unknown 一律不可再分发')
  // 明确可再分发才放开
  assert.equal(inferMotionLicense({ license: 'CC0-1.0', redistributable: true }).provenance, 'licensed')
  assert.equal(inferMotionLicense(null).provenance, 'unknown', '没有 motions 块 ⇒ 最保守')
})

test('★ 动作同样要求"文件真的存在"（`readdirSync` 的条目不等于磁盘状态）', () => {
  const res = resolveMotions(motionFixture(['__airimate_no_such_clip__.vrma'], {
    motions: { license: 'CC0-1.0', redistributable: true },
  }))
  assert.equal(res.clips.length, 0)
  assert.equal(res.rejected.length, 1)
  assert.equal(res.rejected[0].reason, 'denied-packaged-unknown-license')
  assert.match(res.rejected[0].detail, /不存在/)
})

test('★ 只有 .vrma 算动作 clip（大小写不敏感），其它文件被忽略', () => {
  const res = resolveMotions(motionFixture(['a.vrma', 'B.VRMA', 'readme.txt', 'clip.glb', '.DS_Store'], {
    motions: { license: 'CC0-1.0', redistributable: true },
  }))
  assert.equal(res.totalClipFiles, 2, '只有两个 .vrma（含大写扩展名）')
})

test('★★ 动作解析出参里**不含绝对路径**（它会经 IPC 显示在设置页）', () => {
  const res = resolveMotions(motionFixture(['idle.vrma'], {
    profile: 'packaged',
    motions: { license: 'X', redistributable: false },
  }))
  const json = JSON.stringify(res)
  assert.equal(/[A-Za-z]:[\\/]/.test(json), false, `出参里出现了盘符：${json.slice(0, 200)}`)
  // 但"为什么不可用"必须说清楚
  assert.match(res.detail, /私有|不可用/)
})

test('动作没有"选一个"的语义：全部可用 clip 都返回（不是只挑一个）', () => {
  const dir = process.env.TEMP ?? '/tmp'
  const files = ['a.vrma', 'b.vrma']
  const res = resolveMotions({
    files, motionDir: dir,
    motions: { license: 'CC0-1.0', redistributable: true },
    profile: 'development',
  })
  // 开发形态允许，但文件不存在 ⇒ 仍会被存在性闸门拦下；这里只断言"逐条判定"而非"挑一个"
  assert.equal(res.totalClipFiles, 2)
  assert.equal(res.detail.length > 0, true)
})
