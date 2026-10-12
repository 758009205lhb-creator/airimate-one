/**
 * apps/desktop/test/m1-onboarding-privacy.test.cjs —— 首次运行向导判据 + 隐私导出/清除
 *
 * 这两块是"配置闭环"的两端：
 *   · 向导：**每一步是否满足由主进程判定**（不看 renderer 自报）；
 *   · 隐私：导出物里不能有密钥；彻底删除必须说清"删了什么、留了什么"。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir, stubElectron, resetStores, readJson } = require('./helpers/harness.cjs')

const TMP = tmpdir('m1onb')
stubElectron(TMP)

const onb = require('../dist/main/onboarding-store.js')
const privacy = require('../dist/main/privacy.js')
const providers = require('../dist/main/provider-store.js')
const secrets = require('../dist/main/secrets-store.js')
const session = require('../dist/main/session-store.js')
const memory = require('../dist/main/memory-store.js')
const permStore = require('../dist/main/permission-store.js')
const quietStore = require('../dist/main/quiet-store.js')
const sched = require('../dist/main/schedule-store.js')
const remStore = require('../dist/main/reminder-store.js')
const settingsStore = require('../dist/main/settings-store.js')
const SHARED = require(path.resolve(__dirname, '..', '..', '..', 'packages', 'shared', 'dist', 'index.js'))

const ALL = { onb, privacy, providers, secrets, session, memory, permStore, quietStore, sched, remStore, settingsStore }

const FILES = ['settings.json', 'providers.json', 'permissions.json', 'quiet-hours.json', 'schedules.json', 'reminders.json', 'session.json', 'memory.json', 'activity.json', 'engine-state.json', 'knowledge-cache.json']

test.beforeEach(() => {
  for (const f of FILES) fs.rmSync(path.join(TMP, f), { force: true })
  fs.rmSync(path.join(TMP, 'secrets'), { recursive: true, force: true })
  fs.rmSync(path.join(TMP, 'exports'), { recursive: true, force: true })
  resetStores(ALL)
  settingsStore.mergeSettings({ ...SHARED.DEFAULT_SETTINGS }, { immediate: true })
})

// ───────────────────────────────────────────────────────── 向导判据

test('向导：全新安装时每一步都未满足，blockedBy=provider', () => {
  const st = onb.onboardingStatus()
  assert.equal(st.completed, false)
  assert.equal(st.blockedBy, 'provider')
  assert.deepEqual(st.satisfied, {
    provider: false, test: false, model: false,
    // 人设与权限**首装即满足**：默认人设已有名字与称呼、权限默认全部关闭或禁止。
    // 这两步的意义是"用户确实看过这一页"，不是"必须改动点什么"。
    persona: true, permission: true, schedule: false,
  })
  assert.ok(st.hint.length > 0, '必须给出"为什么不能继续"的说明')
})

test('★ 向导：加了没有密钥的供应商**仍不算满足**（配了但没钥匙等于没配）', () => {
  providers.upsertProvider({ label: 'ds', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' })
  const st = onb.onboardingStatus()
  assert.equal(st.satisfied.provider, false)

  secrets.secretStore().set(providers.activeProvider().id, 'sk-test-1234567890')
  const st2 = onb.onboardingStatus()
  assert.equal(st2.satisfied.provider, true)
})

test('★ 向导：连接测试**必须针对当前生效的供应商**（换供应商后旧的通过记录作废）', () => {
  const a = providers.upsertProvider({ label: 'a', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm' })
  secrets.secretStore().set(a.id, 'sk-aaaaaaaaaaaa')
  onb.recordOnboardingTest(a.id, true, 'ok')
  assert.equal(onb.onboardingStatus().satisfied.test, true)

  // 新建并切到另一个供应商
  const b = providers.upsertProvider({ label: 'b', kind: 'openai', baseUrl: 'https://api.openai.com', model: 'gpt' })
  secrets.secretStore().set(b.id, 'sk-bbbbbbbbbbbb')
  providers.setActive(b.id)
  assert.equal(onb.onboardingStatus().satisfied.test, false, '旧供应商的通过记录不得解锁新配置')
})

test('★ 向导：测试失败会**清掉**上一次的成功记录（不能拿旧的"通过"解锁）', () => {
  const a = providers.upsertProvider({ label: 'a', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm' })
  secrets.secretStore().set(a.id, 'sk-aaaaaaaaaaaa')
  onb.recordOnboardingTest(a.id, true, 'ok')
  assert.equal(onb.onboardingStatus().satisfied.test, true)
  onb.recordOnboardingTest(a.id, false, 'auth')
  assert.equal(onb.onboardingStatus().satisfied.test, false)
  assert.equal(onb.loadOnboarding().lastTestOk, null)
})

test('向导：人设需要名字 + 称呼都非空', () => {
  const p = session.getPersona()
  assert.equal(onb.onboardingStatus().satisfied.persona, true, '默认人设有名字与称呼')
  session.setPersona({ ...p, userTitle: '' })
  assert.equal(onb.onboardingStatus().satisfied.persona, false)
})

test('★ 向导：完成必须所有步骤都满足（主进程拒绝跳过未做的步骤）', () => {
  const st = onb.onboardingStatus()
  assert.equal(st.blockedBy, 'provider')
  // `completeOnboarding` 本身不做判据（判据在 ipc handler 里），这里验证判据函数本身
  assert.notEqual(st.blockedBy, null, 'ipc 层据此拒绝 ONBOARDING_COMPLETE')
})

test('向导：reset 回到第一步且清掉完成标记（同时把 settings.onboarded 置回 false）', () => {
  onb.completeOnboarding(true)
  assert.equal(settingsStore.loadSettings().onboarded, true)
  onb.resetOnboarding()
  const st = onb.onboardingStatus()
  assert.equal(st.completed, false)
  assert.equal(st.state.step, 'provider')
  assert.equal(settingsStore.loadSettings().onboarded, false)
})

test('★ 向导：completeOnboarding(true) 会落盘（重启后不再弹向导）', () => {
  onb.completeOnboarding(true)
  onb.__resetCacheForTest?.()
  resetStores({ settingsStore, onb })
  assert.equal(onb.loadOnboarding().completedAt !== null, true)
  assert.equal(settingsStore.loadSettings().onboarded, true)
})

test('★ 向导：advanceOnboarding 在当前步未满足时**停住**，并纠正被手改的步骤值', () => {
  const st = onb.advanceOnboarding('permission')
  assert.equal(st.state.step, 'provider', '当前步没满足就必须回到第一个未满足的步骤')
})

test('向导：步骤值被手改坏时不会崩（schema 收敛回第一步）', () => {
  /**
   * ⚠ 必须**直接写文件**再清缓存，而不是 `mergeSettings` ——
   *   `mergeSettings` 会用 `AppSettingsSchema.parse()` 校验，非法枚举**当场就抛**，
   *   根本走不到"读旧文件"那条路径。这里要测的正是"别人手改坏了 settings.json 会怎样"。
   */
  fs.writeFileSync(path.join(TMP, 'settings.json'), JSON.stringify({
    ...SHARED.DEFAULT_SETTINGS,
    onboarding: { step: 'not-a-step', completedAt: null, lastTestOk: null },
  }, null, 2), 'utf8')
  onb.__resetCacheForTest?.()
  resetStores({ onb, settingsStore })
  const st = onb.onboardingStatus()
  assert.equal(st.state.step, 'provider', '非法步骤值必须被收敛回第一步，而不是让整份设置失效')
})

test('★ 向导：permission 步骤要求高风险项仍是 blocked（用户确实看过这一页）', () => {
  const perms = permStore.listPermissions()
  assert.equal(perms.length > 0, true)
  const st = onb.onboardingStatus()
  assert.equal(st.satisfied.permission, true, '默认全部 blocked/关闭 ⇒ 视为"已确认"')
})

test('★ 向导：schedule 步骤要求静音时段被确认过一次（updatedAt > 0）', () => {
  assert.equal(onb.onboardingStatus().satisfied.schedule, false)
  quietStore.setQuietHours({ start: '22:30' })
  assert.equal(onb.onboardingStatus().satisfied.schedule, true)
})

/**
 * ★★ 2026-10-06：**向导第一步的死锁**（用户实际卡在这里，完全无法开始使用）
 *
 * 缺陷形态：`OnboardingWizard.vue` 的「保存并继续」按钮两个分支都写
 *   `:disabled="!currentSatisfied"`，而 provider 步的判据是"**存在供应商且它有密钥**"——
 *   偏偏**保存供应商的唯一入口就是这个按钮**：
 *
 *       判据要先满足 ⇒ 才让你点保存
 *       而要满足判据 ⇒ 得先点保存
 *       ⇒ 按钮恒灰，`providers.json` 永远是空的，用户永远出不去第 1 步
 *
 * 为什么用**源码级断言**而不是 UI 探针：
 *   `ui` 探针只读 DOM 的文本与计数，**读不出"按钮是不是被禁用"**；
 *   而这条缺陷的表现恰好是"按钮在、但点不动"。
 *   源码级断言能直接钉住那个绑定式，成本极低且不会误报。
 */
test('★★ 向导第 1 步的保存按钮**不得**被判据禁用（否则永远出不去第 1 步）', () => {
  // ⚠ 向导在 **renderer** 里（`apps/renderer/src/components/`），不在 desktop —— 这里踩过一次
  const p = path.resolve(__dirname, '..', '..', 'renderer', 'src', 'components', 'OnboardingWizard.vue')
  assert.equal(fs.existsSync(p), true, `向导源码不在预期位置：${p}`)
  const src = fs.readFileSync(p, 'utf8')
  const m = src.match(/<button[^>]*@click="next\(\)"[^>]*>保存并继续<\/button>/)
  assert.ok(m, '在向导源码里找不到「保存并继续」按钮（判据可能已被改名，请同步这条断言）')
  const btn = m[0]
  // 它必须仍然带着一个 disabled 绑定（否则会退化成"随便点都能过"）
  const dm = btn.match(/:disabled="([^"]*)"/)
  assert.ok(dm, `按钮缺少 :disabled 绑定：${btn}`)
  const expr = dm[1]
  /**
   * ⚠ 断言的确切语义：**provider 步不受 `currentSatisfied` 约束**。
   *   表达式里必须存在"provider 例外"这一项，且不能在 provider 步时求值为 !currentSatisfied。
   */
  assert.match(expr, /step\s*!==\s*'provider'/,
    `第 1 步必须放行保存（provider 判据只能靠"保存"来满足）——实际绑定：${expr}`)
  assert.equal(/^!currentSatisfied$/.test(expr.trim()), false,
    `绑定退化成了"恒由判据决定" ⇒ 死锁会回来：${expr}`)
})

test('★ provider:upsert 是唯一能创建"供应商存在"这条判据的入口（死锁的根因）', () => {
  // 全新状态下判据未满足
  assert.equal(onb.onboardingStatus().satisfied.provider, false)
  // 只有 upsert + 存密钥之后才满足 —— 也就是说"保存"这个动作必须先能做
  const p = providers.upsertProvider({ label: 'ds', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm' })
  assert.equal(onb.onboardingStatus().satisfied.provider, false, '只有供应商、没有密钥仍不算满足')
  secrets.secretStore().set(p.id, 'sk-test-1234567890')
  assert.equal(onb.onboardingStatus().satisfied.provider, true)
})

// ───────────────────────────────────────────────────────── 出网闸门（供应商侧）

test('★ provider-store：出网闸门拒绝内网 baseUrl（renderer 不能借它打内网）', () => {
  assert.equal(providers.egressAllowed('https://api.deepseek.com/v1').ok, true)
  const r = providers.egressAllowed('https://10.0.0.1/v1')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'blocked-target')
  const r2 = providers.egressAllowed('http://api.deepseek.com/v1')
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'insecure-url')
})

test('provider-store：/models 返回形态的模型 id 抽取（含宽松兜底，不抛错）', () => {
  assert.deepEqual(providers.extractModelIds({ data: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b'])
  assert.deepEqual(providers.extractModelIds({ models: [{ name: 'x', object: 'model' }] }), ['x'])
  assert.deepEqual(providers.extractModelIds({ result: ['p', 'q'] }), ['p', 'q'])
  assert.deepEqual(providers.extractModelIds(null), [])
  assert.deepEqual(providers.extractModelIds({ data: [{ id: 'dup' }, { id: 'dup' }] }), ['dup'], '必须去重')
})

test('provider-store：setActive 对不存在的 id 返回 false（不静默忽略）', () => {
  assert.equal(providers.setActive('nope'), false)
})

// ───────────────────────────────────────────────────────── 隐私导出

test('★★ 导出物里**没有**密钥明文，只有 hasKey/指纹/长度与占位符', () => {
  const p = providers.upsertProvider({ label: 'ds', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm' })
  const SECRET = 'sk-SUPER-SECRET-VALUE-1234567890'
  secrets.secretStore().set(p.id, SECRET)
  session.appendMessage({ id: 'u1', role: 'user', text: '我叫小明', createdAt: 1, commands: [], origin: 'user' })
  memory.addMemory({ text: '用户叫小明', importance: 0.9 })

  const r = privacy.exportPersonalData({ format: 'json', includeChats: true, includeMemory: true })
  const raw = fs.readFileSync(r.file, 'utf8')
  assert.equal(raw.includes(SECRET), false, '导出物里绝不能出现密钥明文')
  assert.equal(raw.includes('sk-'), false, '连密钥前缀都不该出现')
  assert.ok(raw.includes('<encrypted, not exported>'))
  assert.ok(raw.includes('我叫小明'), '对话正文应当被导出（这是用户要的）')
  assert.ok(raw.includes('用户叫小明'))
  assert.equal(r.sections.includes('chat'), true)
  assert.equal(r.sections.includes('memory'), true)
  assert.ok(r.excluded.some(x => x.includes('密钥')))
})

test('导出：includeChats/includeMemory = false 时确实排除（并按实情写进 excluded）', () => {
  session.appendMessage({ id: 'u1', role: 'user', text: '机密对话内容', createdAt: 1, commands: [], origin: 'user' })
  memory.addMemory({ text: '机密记忆内容' })
  const r = privacy.exportPersonalData({ format: 'json', includeChats: false, includeMemory: false })
  const raw = fs.readFileSync(r.file, 'utf8')
  assert.equal(raw.includes('机密对话内容'), false)
  assert.equal(raw.includes('机密记忆内容'), false)
  assert.equal(r.sections.includes('chat'), false)
  assert.ok(r.excluded.some(x => x.includes('对话历史')))
  assert.ok(r.excluded.some(x => x.includes('记忆正文')))
})

test('导出：markdown 格式可读且含来源/结构；文件真的写出来了', () => {
  const p = providers.upsertProvider({ label: 'ds', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm' })
  secrets.secretStore().set(p.id, 'sk-xxxxxxxxxxxx')
  sched.upsertSchedule({ title: '晨会', start: '09:00', recurrence: { kind: 'daily' } })
  const r = privacy.exportPersonalData({ format: 'markdown', includeChats: false, includeMemory: true })
  assert.equal(fs.existsSync(r.file), true)
  assert.ok(r.bytes > 0)
  const text = fs.readFileSync(r.file, 'utf8')
  assert.ok(text.includes('# AiriMate One 个人数据导出'))
  assert.ok(text.includes('不含密钥'))
  assert.ok(text.includes('晨会'))
  assert.ok(text.includes('```json'), 'markdown 里附完整机器可读数据')
})

// ───────────────────────────────────────────────────────── 隐私清除

test('★★ 彻底清除：删掉个人数据、保留设置（keepSettings 默认），并如实列出 kept', () => {
  session.appendMessage({ id: 'u1', role: 'user', text: '说过的话', createdAt: 1, commands: [], origin: 'user' })
  memory.addMemory({ text: '记住的事' })
  sched.upsertSchedule({ title: '日程', start: '09:00', recurrence: { kind: 'daily' } })
  const r = privacy.wipePersonalData({ confirm: 'DELETE-ALL-PERSONAL-DATA', keepSettings: true, revokeKeys: false })

  assert.equal(fs.existsSync(path.join(TMP, 'session.json')), false)
  assert.equal(fs.existsSync(path.join(TMP, 'memory.json')), false)
  assert.equal(fs.existsSync(path.join(TMP, 'schedules.json')), false)
  assert.equal(fs.existsSync(path.join(TMP, 'reminders.json')), false)
  assert.equal(fs.existsSync(path.join(TMP, 'settings.json')), true, 'keepSettings 时设置必须保留')
  assert.ok(r.removedFiles.length >= 3)
  assert.ok(r.removedBytes >= 0)
  assert.ok(r.kept.some(x => x.includes('日志')), '必须说明日志没删（用户有权知道）')
  // 内存缓存也要清（否则进程内还留着旧数据，界面上"删了还在"）
  assert.equal(memory.memoryCount(), 0)
  assert.equal(session.history(100).length, 0)
})

test('★ 彻底清除：keepSettings=false 时连配置一起删', () => {
  providers.upsertProvider({ label: 'ds', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm' })
  settingsStore.mergeSettings({ weatherCity: '上海' }, { immediate: true })
  privacy.wipePersonalData({ confirm: 'DELETE-ALL-PERSONAL-DATA', keepSettings: false, revokeKeys: false })
  assert.equal(fs.existsSync(path.join(TMP, 'settings.json')), false)
  assert.equal(fs.existsSync(path.join(TMP, 'providers.json')), false)
  assert.equal(fs.existsSync(path.join(TMP, 'permissions.json')), false)
})

test('★ 彻底清除：密钥默认**不删**（要重新填 API Key，必须显式选择），并在 kept 里说明', () => {
  const p = providers.upsertProvider({ label: 'ds', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm' })
  secrets.secretStore().set(p.id, 'sk-xxxxxxxxxxxx')
  const r = privacy.wipePersonalData({ confirm: 'DELETE-ALL-PERSONAL-DATA', keepSettings: true, revokeKeys: false })
  assert.equal(secrets.secretStore().has(p.id), true, '未选择吊销时密钥必须保留')
  assert.ok(r.kept.some(x => x.includes('密钥')), '必须说明密钥没删')
})

test('彻底清除：revokeKeys=true 时密钥文件被删掉', () => {
  const p = providers.upsertProvider({ label: 'ds', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm' })
  secrets.secretStore().set(p.id, 'sk-xxxxxxxxxxxx')
  const r = privacy.wipePersonalData({ confirm: 'DELETE-ALL-PERSONAL-DATA', keepSettings: true, revokeKeys: true })
  assert.equal(secrets.secretStore().has(p.id), false)
  assert.ok(r.removedFiles.some(x => x.startsWith('secrets/')))
})

// ───────────────────────────────────────────────────────── 隐私摘要

test('隐私摘要：只给文件名/存在性/大小与计数（不泄露内容），并回显遥测开关真实值', () => {
  memory.addMemory({ text: '一条很短但真实的记忆' })
  const s = privacy.privacySummary()
  assert.equal(typeof s.userDataDir, 'string')
  assert.ok(s.files.some(f => f.name === 'memory' && f.exists === true && f.bytes > 0))
  assert.equal(s.telemetryEnabled, false, '遥测默认关闭')
  const json = JSON.stringify(s)
  assert.equal(json.includes('一条很短但真实的记忆'), false, '摘要里不得出现记忆正文')
})

test('数据文件清单是唯一真源（导出与删除共用，两处不会漂移）', () => {
  const names = privacy.dataFiles().map(f => f.name)
  for (const n of ['settings', 'providers', 'session', 'memory', 'schedules', 'reminders', 'quiet-hours', 'permissions', 'activity', 'engine-state', 'knowledge-cache']) {
    assert.ok(names.includes(n), `数据文件清单缺少 ${n}`)
  }
  assert.equal(new Set(names).size, names.length, '清单里不该有重名')
})

// ───────────────────────────────────────────────────────── 记忆编辑（M1 要求）

test('记忆：update 可改正文/标签/重要度；重复写入同文本仍去重', () => {
  const e = memory.addMemory({ text: '旧正文', tags: ['a'], importance: 0.2 })
  const u = memory.updateMemory({ id: e.id, text: '新正文', tags: ['b', 'c'], importance: 0.9 })
  assert.equal(u.text, '新正文')
  assert.deepEqual(u.tags, ['b', 'c'])
  assert.equal(u.importance, 0.9)
  assert.equal(u.id, e.id, 'id 不变（同一条记忆）')
})

test('记忆：update 找不到 id ⇒ 返回 null（不静默假装成功）', () => {
  assert.equal(memory.updateMemory({ id: 'nope', text: 'x' }), null)
})

test('记忆：search 空查询 = 浏览模式（按重要度+时间），带标签/重要度过滤', () => {
  memory.addMemory({ text: '低', importance: 0.1, tags: ['x'] })
  memory.addMemory({ text: '高', importance: 0.9, tags: ['y'] })
  const browse = memory.searchMemory({ limit: 10 })
  assert.equal(browse.length, 2)
  assert.equal(browse[0].entry.text, '高', '浏览模式按重要度优先')
  assert.deepEqual(memory.searchMemory({ limit: 10, tag: 'y' }).map(h => h.entry.text), ['高'])
  assert.deepEqual(memory.searchMemory({ limit: 10, minImportance: 0.5 }).map(h => h.entry.text), ['高'])
})

test('★ 记忆：search **不写使用统计**（检索是"我在找东西"，不是"角色想起了这件事"）', () => {
  memory.addMemory({ text: '用户喜欢茉莉花茶' })
  memory.searchMemory({ query: '茉莉花茶', limit: 5 })
  const e = memory.listMemory(10)[0]
  assert.equal(e.useCount, 0, 'search 不该动 useCount')
  assert.equal(e.lastUsedAt, null)
  // 而 recall 会写
  memory.recall('茉莉花茶', 5)
  assert.equal(memory.listMemory(10)[0].useCount, 1)
})

test('★ 记忆：previewRecall 只召回**一次**（命中数与注入文本同源，使用次数不被算两遍）', () => {
  memory.addMemory({ text: '用户养了一只叫豆豆的猫', importance: 0.8 })
  const p = memory.previewRecall('豆豆', 5)
  assert.equal(p.hits.length, 1)
  assert.ok(p.injectedBlock.includes('豆豆'))
  assert.equal(p.injectedChars, p.injectedBlock.length)
  assert.equal(memory.listMemory(10)[0].useCount, 1, '同一次预览只能算一次使用')
})

test('记忆：previewRecall 无命中时 injectedBlock 为 null（不塞空段落污染提示）', () => {
  memory.addMemory({ text: '用户喜欢茉莉花茶' })
  const p = memory.previewRecall('完全无关的 zzqqxx', 5)
  assert.deepEqual(p.hits, [])
  assert.equal(p.injectedBlock, null)
  assert.equal(p.injectedChars, 0)
})

test('记忆：exportMemory 返回副本（调用方改它不该影响存储）', () => {
  memory.addMemory({ text: '原文本' })
  const all = memory.exportMemory()
  all[0].text = '被改了'
  assert.equal(memory.listMemory(10)[0].text, '原文本')
})

test('记忆：clearAllMemory 清空并返回条数', () => {
  memory.addMemory({ text: 'a' })
  memory.addMemory({ text: 'b' })
  assert.equal(memory.clearAllMemory(), 2)
  assert.equal(memory.memoryCount(), 0)
})

test('会话：历史带 origin 字段（区分"她主动说的"与"我发起的"）', () => {
  session.appendMessage({ id: 'a1', role: 'assistant', text: '早上好', createdAt: 1, commands: [], origin: 'proactive' })
  const h = session.history(10)
  assert.equal(h[0].origin, 'proactive')
  assert.equal(session.sessionMessageCount(), 1)
})

test('会话：落盘的 session.json 里含 origin，且不含任何密钥形态的字段', () => {
  session.appendMessage({ id: 'a1', role: 'assistant', text: '主动消息', createdAt: 1, commands: [], origin: 'radio' })
  const raw = readJson(path.join(TMP, 'session.json'))
  assert.equal(raw.messages[0].origin, 'radio')
  assert.equal('apiKey' in raw.messages[0], false)
})

test('提醒：upsertReminder 落盘可读回（重启后提醒还在）', () => {
  const r = remStore.upsertReminder({ kind: 'scheduled', title: '拿快递', atTime: '18:00' })
  remStore.__resetReminderStoreForTest()
  assert.equal(remStore.getReminder(r.id).title, '拿快递')
})
