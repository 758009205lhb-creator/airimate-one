/**
 * apps/desktop/test/m1-contract.test.cjs —— M1/M2 契约一致性单测
 *
 * 这组用例防的是**契约漂移**（本项目反复踩到的那类问题）：
 *   ① preload 里**内联**的通道名与 `@airimate/shared` 的 `IPC` 常量不一致
 *      ⇒ preload 的 `assertContract()` 会在启动时抛错，或者更糟：某个通道静默失效；
 *   ② 新通道只加在 shared 没加在 preload（或反过来）⇒ 调用方拿到 undefined 而不是报错；
 *   ③ 出网闸门（SSRF 兜底）规则被放宽 ⇒ renderer 能借 baseUrl 让主进程打内网；
 *   ④ 关键 schema 的**上界**被悄悄放大（例如记忆正文从 4000 变成无上限）。
 *
 * 运行：`node --test apps/desktop/test/m1-contract.test.cjs`
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

// preload 的 dist 是 CJS，require 时会执行 `contextBridge.exposeInMainWorld`
// ⇒ 必须先把 electron 打桩掉（否则报 "Cannot find module 'electron'"）
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    let exposed = null
    return {
      contextBridge: { exposeInMainWorld: (k, v) => { exposed = { k, v } } },
      ipcRenderer: { invoke: async () => ({}), on: () => {}, send: () => {}, removeListener: () => {} },
      __getExposed: () => exposed,
    }
  }
  return origLoad.call(this, request, parent, isMain)
}

const SHARED = require(path.resolve(__dirname, '..', '..', '..', 'packages', 'shared', 'dist', 'index.js'))
const PRELOAD = require(path.resolve(__dirname, '..', 'dist', 'preload', 'index.js'))

// ───────────────────────────────────────────────────────── ① 通道名清单

test('shared.IPC 里没有重复的通道名（重复会让 removeHandler 误删另一个通道）', () => {
  const values = Object.values(SHARED.IPC)
  const dup = values.filter((v, i) => values.indexOf(v) !== i)
  assert.deepEqual(dup, [], `重复的通道名：${dup.join(', ')}`)
})

test('shared.IPC 的键与值都是非空字符串，且值不含空格', () => {
  for (const [k, v] of Object.entries(SHARED.IPC)) {
    assert.equal(typeof v, 'string', `${k} 的值必须是字符串`)
    assert.ok(v.length > 0, `${k} 不能是空串`)
    assert.ok(!/\s/.test(v), `${k} 的通道名不该含空格：${JSON.stringify(v)}`)
  }
})

test('★ preload 的 assertContract() 对真实 IPC 常量**必须通过**（这是启动期的硬闸门）', () => {
  assert.doesNotThrow(() => PRELOAD.assertContract(SHARED.IPC))
})

test('★ preload 内联通道与 shared.IPC 双向一一对应（少了会静默失效，多了会调用到未注册通道）', () => {
  // 只靠 `assertContract()` 能证明"preload 里有的都对"，证明不了"shared 里有的 preload 也有"。
  // 后者会**静默失效**（调用方拿到 undefined，而不是报错）—— 正是最难查的一类问题。
  const preloadKeys = new Set(Object.keys(PRELOAD.CHANNELS))
  const sharedKeys = Object.keys(SHARED.IPC)
  const missing = sharedKeys.filter(k => !preloadKeys.has(k))
  const extra = [...preloadKeys].filter(k => !(k in SHARED.IPC))
  assert.deepEqual(missing, [], `shared.IPC 里有但 preload 未暴露的通道：${missing.join(', ')}`)
  assert.deepEqual(extra, [], `preload 里有但 shared.IPC 未定义的通道：${extra.join(', ')}`)
  // 值也必须逐个相同（键对上但值写错同样会失效）
  for (const k of sharedKeys) {
    assert.equal(PRELOAD.CHANNELS[k], SHARED.IPC[k], `通道 ${k} 的值不一致`)
  }
})

// ───────────────────────────────────────────────────────── ② M1 关键 schema

test('记忆正文上界被钉死（4000）—— 不能被悄悄放大', () => {
  assert.equal(SHARED.MemoryAddRequestSchema.safeParse({ text: 'x'.repeat(4000) }).success, true)
  assert.equal(SHARED.MemoryAddRequestSchema.safeParse({ text: 'x'.repeat(4001) }).success, false)
  assert.equal(SHARED.MemoryAddRequestSchema.safeParse({ text: '' }).success, false)
})

test('memory:update 至少要有一个字段（空补丁必须被拒，否则会写一次无意义的 updatedAt）', () => {
  assert.equal(SHARED.MemoryUpdateRequestSchema.safeParse({ id: 'm1' }).success, false)
  assert.equal(SHARED.MemoryUpdateRequestSchema.safeParse({ id: 'm1', importance: 0.5 }).success, true)
})

test('记忆检索上限 100、召回上限 20（避免 renderer 一次拉走全部记忆）', () => {
  assert.equal(SHARED.MemorySearchRequestSchema.safeParse({ limit: 100 }).success, true)
  assert.equal(SHARED.MemorySearchRequestSchema.safeParse({ limit: 101 }).success, false)
  assert.equal(SHARED.MemoryRecallRequestSchema.safeParse({ query: 'a', limit: 20 }).success, true)
  assert.equal(SHARED.MemoryRecallRequestSchema.safeParse({ query: 'a', limit: 21 }).success, false)
})

test('供应商出参 schema **不含 apiKey 字段**（结构上就传不出密钥）', () => {
  const shape = SHARED.ProviderPublicSchema.shape
  assert.equal('apiKey' in shape, false)
  assert.ok('hasKey' in shape && 'keyFingerprint' in shape && 'keyLength' in shape)
  // 多传了 apiKey 也会被 zod 剥掉（不是报错 —— 这是刻意的：出参校验失败会整条丢弃，
  // 而剥掉未知键更安全）
  const parsed = SHARED.ProviderPublicSchema.parse({
    id: 'p1', label: 'l', kind: 'deepseek', baseUrl: 'https://x', model: 'm',
    hasKey: true, keyFingerprint: 'abcdef01', keyLength: 35, createdAt: 1, updatedAt: 2,
    apiKey: 'sk-SHOULD-NOT-SURVIVE',
  })
  assert.equal('apiKey' in parsed, false, 'apiKey 必须被剥掉')
})

test('供应商 upsert 的 baseUrl 必须是合法 URL（无效 URL 在入参就被拒）', () => {
  const base = { label: 'l', kind: 'deepseek', model: 'm' }
  assert.equal(SHARED.ProviderUpsertSchema.safeParse({ ...base, baseUrl: 'https://api.deepseek.com' }).success, true)
  assert.equal(SHARED.ProviderUpsertSchema.safeParse({ ...base, baseUrl: 'not a url' }).success, false)
  assert.equal(SHARED.ProviderUpsertSchema.safeParse({ ...base, baseUrl: '' }).success, false)
})

test('人设：名字必填且非空（空名字会让界面出现"她"以外的空白）', () => {
  const p = {
    id: 'default', name: 'Lazuli', userTitle: '你', systemPrompt: '', personality: '',
    speakingStyle: '', greeting: '', performance: { expressiveness: 0.5, gestureFrequency: 0.5, idleChatter: false },
    updatedAt: 0,
  }
  assert.equal(SHARED.PersonaSchema.safeParse(p).success, true)
  assert.equal(SHARED.PersonaSchema.safeParse({ ...p, name: '' }).success, false)
  // userTitle 有默认值（老配置文件没有这个字段也能解析）
  const { userTitle, ...without } = p
  assert.equal(SHARED.PersonaSchema.safeParse(without).success, true)
  assert.equal(SHARED.PersonaSchema.parse(without).userTitle, '你')
})

test('清单数据（Schedule/Reminder/Permission/QuietHours）都能解析一份"最小合法值"', () => {
  // 这几条是 M2 的持久化形状：默认值不齐会让老文件整体失效（用户数据丢失）
  assert.equal(SHARED.ScheduleSchema.safeParse({
    id: 's1', title: '开会', start: '09:00', recurrence: { kind: 'daily' }, createdAt: 1, updatedAt: 2,
  }).success, true)
  assert.equal(SHARED.ReminderSchema.safeParse({
    id: 'r1', kind: 'night', title: '该睡了', fireAt: 1, createdAt: 1, updatedAt: 2,
  }).success, true)
  assert.equal(SHARED.PermissionSchema.safeParse({
    kind: 'payment', label: '支付', tier: 'blocked', effective: 'blocked', enabled: false,
  }).success, true)
  assert.equal(SHARED.QuietHoursSchema.safeParse({}).success, true)
  assert.equal(SHARED.ReminderPolicySchema.safeParse({}).success, true)
})

test('时间格式被正则钉死（25:99 / 8:30 都不接受）', () => {
  assert.equal(SHARED.TimeOfDaySchema.safeParse('23:59').success, true)
  assert.equal(SHARED.TimeOfDaySchema.safeParse('00:00').success, true)
  assert.equal(SHARED.TimeOfDaySchema.safeParse('24:00').success, false)
  assert.equal(SHARED.TimeOfDaySchema.safeParse('8:30').success, false, '必须两位小时（否则排序会错）')
  assert.equal(SHARED.TimeOfDaySchema.safeParse('23:60').success, false)
})

test('inTimeRange 支持跨午夜（23:30–07:00 这类静音时段）', () => {
  assert.equal(SHARED.inTimeRange('23:45', '23:30', '07:00'), true)
  assert.equal(SHARED.inTimeRange('00:30', '23:30', '07:00'), true)
  assert.equal(SHARED.inTimeRange('06:59', '23:30', '07:00'), true)
  assert.equal(SHARED.inTimeRange('07:00', '23:30', '07:00'), false, '右开区间')
  assert.equal(SHARED.inTimeRange('12:00', '23:30', '07:00'), false)
  // 同日区间
  assert.equal(SHARED.inTimeRange('09:00', '08:00', '18:00'), true)
  assert.equal(SHARED.inTimeRange('07:59', '08:00', '18:00'), false)
  // 零长度区间不该"永远静音"
  assert.equal(SHARED.inTimeRange('09:00', '09:00', '09:00'), false)
})

// ───────────────────────────────────────────────────────── ③ 出网闸门（SSRF 兜底）

test('★ checkEgressTarget：拒绝内网 / 明文 / 异常端口（防 renderer 借 baseUrl 打内网）', () => {
  const g = SHARED.checkEgressTarget
  // 允许：公网 https
  assert.equal(g('https://api.deepseek.com/v1').ok, true)
  // 允许：环回（本地 Ollama 的常见形态）
  assert.equal(g('http://127.0.0.1:11434/v1').ok, true)
  assert.equal(g('http://localhost:8080/v1').ok, true)
  // 拒绝：明文公网
  assert.equal(g('http://api.deepseek.com/v1').ok, false)
  assert.equal(g('http://api.deepseek.com/v1').reason, 'insecure-url')
  // 拒绝：内网段
  for (const u of [
    'https://10.0.0.5/v1', 'https://192.168.1.1/v1', 'https://172.16.0.1/v1',
    'https://169.254.169.254/latest/meta-data',   // 云元数据端点（SSRF 的经典目标）
    'https://100.64.0.1/v1',                       // CGNAT
    'https://0.0.0.0/v1',
  ]) {
    assert.equal(g(u).ok, false, `必须拒绝 ${u}`)
  }
  // 拒绝：非常规端口（公网）
  assert.equal(g('https://api.deepseek.com:8443/v1').ok, false)
  assert.equal(g('https://api.deepseek.com:8443/v1').reason, 'blocked-port')
  // 拒绝：带用户名密码
  assert.equal(g('https://user:pass@api.deepseek.com/v1').ok, false)
  // 拒绝：非 http(s)
  assert.equal(g('file:///C:/Windows/win.ini').ok, false)
  assert.equal(g('ftp://example.com/x').ok, false)
  // 拒绝：解析不了的 URL
  assert.equal(g('%%%').ok, false)
  assert.equal(g('%%%').reason, 'bad-url')
})

test('checkEgressTarget 的 host 已规范化（大小写 / IPv6 方括号）', () => {
  assert.equal(SHARED.checkEgressTarget('https://API.DeepSeek.COM/v1').host, 'api.deepseek.com')
  assert.equal(SHARED.checkEgressTarget('http://[::1]:11434/v1').host, '::1')
  assert.equal(SHARED.checkEgressTarget('http://[::1]:11434/v1').ok, true, 'IPv6 环回应被允许')
})

// ───────────────────────────────────────────────────────── ④ 权限硬下限

test('★★ PERMISSION_TIER_FLOOR 把"禁止自动支付 / 改系统 / 读凭据"钉死在数据层', () => {
  const F = SHARED.PERMISSION_TIER_FLOOR
  assert.equal(F.payment, 'blocked')
  assert.equal(F['credential-access'], 'blocked')
  assert.equal(F['system-settings'], 'blocked')
  assert.equal(F['input-simulate'], 'blocked')
  // 写类至少 confirm
  assert.equal(F['file-write'], 'confirm')
  assert.equal(F['shell-exec'], 'confirm')
  assert.equal(F['app-launch'], 'confirm')
  // 读类可以是只读
  assert.equal(F['screen-capture'], 'read-only')
  assert.equal(F['file-read'], 'read-only')
})

test('★ effectiveTier：请求值不得宽于硬下限（唯一实现，主进程与 UI 共用）', () => {
  // 用户"想要"支付免确认 ⇒ 仍然被收紧到 blocked
  assert.equal(SHARED.effectiveTier('payment', 'read-only'), 'blocked')
  assert.equal(SHARED.effectiveTier('payment', 'confirm'), 'blocked')
  assert.equal(SHARED.effectiveTier('payment', 'blocked'), 'blocked')
  // 写类不能被放宽到只读
  assert.equal(SHARED.effectiveTier('file-write', 'read-only'), 'confirm')
  assert.equal(SHARED.effectiveTier('file-write', 'confirm'), 'confirm')
  // 读类可以被收紧（用户更保守）
  assert.equal(SHARED.effectiveTier('file-read', 'confirm'), 'confirm')
  assert.equal(SHARED.effectiveTier('file-read', 'blocked'), 'blocked')
  assert.equal(SHARED.effectiveTier('file-read', 'read-only'), 'read-only')
})

test('PermissionKind 枚举与硬下限表**完全对应**（漏一个就会有一条能力没有下限）', () => {
  const kinds = SHARED.PermissionKindSchema.options
  const floored = Object.keys(SHARED.PERMISSION_TIER_FLOOR)
  assert.deepEqual([...kinds].sort(), [...floored].sort())
})

// ───────────────────────────────────────────────────────── ⑤ 主动事件契约

test('ProactiveEvent：focus 必须是布尔（且引擎侧恒为 false）；ttlMs 有上下界', () => {
  const e = SHARED.ProactiveEventSchema.parse({
    id: 'pe1', kind: 'greeting', priority: 'normal', title: 't', text: 'x', at: 1,
  })
  assert.equal(e.focus, false, '缺省必须是"不抢焦点"')
  assert.equal(e.speak, false, '缺省必须是"不发声"')
  assert.equal(SHARED.ProactiveEventSchema.safeParse({
    id: 'pe1', kind: 'greeting', priority: 'normal', title: 't', text: 'x', at: 1, ttlMs: 999,
  }).success, false, 'ttlMs 下界 1000')
})

test('RadioContent：口播稿与来源字段是必需的（不允许"没有来源的热点"）', () => {
  const base = {
    id: 'radio_2026-01-01', day: '2026-01-01', weekday: '星期四', greeting: '早上好',
    weather: { available: false }, schedule: [], news: [], advice: [], encouragement: '加油',
    script: '早上好。', estimatedSeconds: 3, generatedAt: 1,
  }
  assert.equal(SHARED.RadioContentSchema.safeParse(base).success, true)
  // 资讯条目必须带 source 与 url（空 source 直接失败）
  const bad = { ...base, news: [{ title: 'x', source: '', url: 'https://a', fetchedAt: 1 }] }
  assert.equal(SHARED.RadioContentSchema.safeParse(bad).success, false)
  const good = { ...base, news: [{ title: 'x', source: 'Hacker News', url: 'https://a', date: '2026-01-01', fetchedAt: 1 }] }
  assert.equal(SHARED.RadioContentSchema.safeParse(good).success, true)
})

test('ActivityDayStats：hourlyActiveMinutes 恒为 24 格（少一格会让"工作节奏"图错位）', () => {
  const d = SHARED.ActivityDayStatsSchema.parse({ day: '2026-01-01' })
  assert.equal(d.hourlyActiveMinutes.length, 24)
  assert.equal(SHARED.ActivityDayStatsSchema.safeParse({ day: '2026-01-01', hourlyActiveMinutes: [1, 2, 3] }).success, false)
})

test('OnboardingStep 的顺序是冻结的（UI 与主进程判据共用同一份顺序）', () => {
  assert.deepEqual(SHARED.OnboardingStepSchema.options, ['provider', 'test', 'model', 'persona', 'permission', 'schedule', 'done'])
})

test('隐私清除必须带确认串（防误触）', () => {
  assert.equal(SHARED.PrivacyWipeRequestSchema.safeParse({ confirm: 'DELETE-ALL-PERSONAL-DATA' }).success, true)
  assert.equal(SHARED.PrivacyWipeRequestSchema.safeParse({ confirm: 'yes' }).success, false)
  assert.equal(SHARED.PrivacyWipeRequestSchema.safeParse({}).success, false)
})

// ───────────────────────────────────────────────────────── ③ 桌宠常驻与启动行为（2026-10-09 完善轮）
/**
 * ★★ 这一组守的是本轮最容易被"静默丢掉"的东西。
 *
 * 为什么单独成组：`mergeSettings()` 用 `AppSettingsSchema.parse()` **重建整个对象** ——
 * 没在 schema 里声明的字段会被 zod 静默丢弃（本项目反复踩过这个坑，
 * 表现为"设置面板里改了、重启后又是默认值"）。
 * 所以"新增了设置项"这件事**必须有单测兜住**，不能只靠代码里写了。
 */
test('★★ petResident / startupOpenChat **必须**在 AppSettingsSchema 里，且默认值就是新口径', () => {
  const d = SHARED.AppSettingsSchema.parse({ version: 1 })
  // 默认：非常驻（启动不自动出现桌宠）+ 打开对话窗口 ⇒ 「打开软件只出现对话窗口」
  assert.equal(d.petResident, false, 'petResident 默认必须是 false（非常驻）')
  assert.equal(d.startupOpenChat, true, 'startupOpenChat 默认必须是 true（启动打开对话窗口）')
  // 关键：**经过 mergeSettings 的重建路径之后仍然在**（这正是被静默丢掉的形态）
  const merged = SHARED.AppSettingsSchema.parse({ ...d, petResident: true })
  assert.equal(merged.petResident, true, 'petResident=true 必须能穿过 schema 重建')
  assert.equal(merged.startupOpenChat, true, 'startupOpenChat 不能在重建时丢失')
  // 显式写入方向
  const off = SHARED.AppSettingsSchema.parse({ ...d, petResident: false, startupOpenChat: false })
  assert.equal(off.petResident, false)
  assert.equal(off.startupOpenChat, false)
})

test('★★ 两个开关都能经 SettingsPatchSchema 写入（renderer 侧可改）', () => {
  assert.equal(SHARED.SettingsPatchSchema.safeParse({ petResident: true }).success, true)
  assert.equal(SHARED.SettingsPatchSchema.safeParse({ startupOpenChat: false }).success, true)
  assert.equal(SHARED.SettingsPatchSchema.safeParse({ petResident: 'yes' }).success, false)
})

test('★ ConversationStateSchema 带 pet 快照；**老证据（没有该键）仍能解析**', () => {
  /**
   * ⚠ 这一条是"历史证据仍可作为历史被引用"的机械保证：
   *   2026-10-08 那批 `chatwindow.json` 里没有 `pet` 键，若这里判定失败，
   *   那份证据就变成"无法解析" —— 而它记录的是当时真实的实测读数。
   */
  const old = {
    open: true, layout: 'pet', mode: 'pet',
    bounds: { x: 0, y: 0, width: 340, height: 420 },
    chat: {
      id: 2, visible: true, focused: true, minimized: false,
      bounds: { x: 1, y: 2, width: 720, height: 560 },
      alwaysOnTop: false, createdCount: 1, readyToShow: true, boundsSource: 'centered',
    },
    hotkey: { accelerator: 'Ctrl+Alt+Space', enabled: true, registered: true, error: null },
    openCount: 1, closeCount: 0, lastSource: 'wheel',
  }
  const parsed = SHARED.ConversationStateSchema.safeParse(old)
  assert.equal(parsed.success, true, '老形状（无 pet 键）必须仍能解析')
  assert.equal(parsed.data.pet.resident, false)
  const now = SHARED.ConversationStateSchema.safeParse({
    ...old,
    pet: { resident: true, visible: false, created: true, windowId: 1, minimized: false, statusText: '桌宠已收回' },
  })
  assert.equal(now.success, true)
  assert.equal(now.data.pet.resident, true)
  assert.equal(now.data.pet.statusText, '桌宠已收回')
})

test('★ 桌宠控制的入参白名单：action 与 source 都是**闭合枚举**（不能塞任意值）', () => {
  assert.equal(SHARED.PetControlRequestSchema.safeParse({ action: 'show' }).success, true)
  assert.equal(SHARED.PetControlRequestSchema.safeParse({ action: 'toggle' }).success, true)
  assert.equal(SHARED.PetControlRequestSchema.safeParse({ action: 'open-panel', source: 'chat-menu' }).success, true)
  assert.equal(SHARED.PetControlRequestSchema.safeParse({ action: 'delete-everything' }).success, false)
  assert.equal(SHARED.PetControlRequestSchema.safeParse({ action: 'show', source: 'somewhere-else' }).success, false)
  assert.equal(SHARED.PetResidentRequestSchema.safeParse({ resident: true }).success, true)
  assert.equal(SHARED.PetResidentRequestSchema.safeParse({ resident: 'true' }).success, false)
})

test('★ ui:action 的**入参**白名单不含单向状态通知（renderer 不能假装自己被收回）', () => {
  const ok = SHARED.UiActionRequestInputSchema.safeParse({ action: 'memory' })
  assert.equal(ok.success, true)
  assert.equal(SHARED.UiActionRequestInputSchema.safeParse({ action: 'voice' }).success, true)
  // `pet-hidden` / `pet-shown` 只允许**主进程单向下发** ⇒ 入参侧必须被拒
  assert.equal(SHARED.UiActionRequestInputSchema.safeParse({ action: 'pet-hidden' }).success, false)
  assert.equal(SHARED.UiActionRequestInputSchema.safeParse({ action: 'pet-shown' }).success, false)
  // 出参侧（广播载荷）两者都必须合法
  assert.equal(SHARED.UiActionRequestSchema.safeParse({ action: 'pet-hidden', at: 1 }).success, true)
  assert.equal(SHARED.UiActionRequestSchema.safeParse({ action: 'pet-shown', at: 1 }).success, true)
})
