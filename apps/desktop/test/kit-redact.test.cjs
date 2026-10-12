/**
 * apps/desktop/test/kit-redact.test.cjs —— 投影边界的**路径脱敏**单测
 *
 * 为什么单独测这一条：它是"renderer 拿不到文件路径"这条设计的实际守卫。
 * 实测抓到过一次真实泄漏 —— `catalog.json` 的 `source` 字段写着
 * "Mate Engine DLC（F:\...\Mate-Engine）…"，被 `inferLicense()` 带进
 * `license.note`，然后随 `kit:assets` 出参**回到了 renderer**。
 * 一个说明性字段绕过了整条设计，而探针是靠"投影里不得出现盘符"抓到的。
 *
 * 所以这里把脱敏行为逐条钉死：**宁可少给信息，也不漏路径**。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { tmpdir, stubElectron } = require('./helpers/harness.cjs')

const TMP = tmpdir('kitredact')
stubElectron(TMP)

const { redactPaths, projectLicenseForRenderer } = require('../dist/main/capabilities/asset-adapter.js')

const HAS_DRIVE = /[A-Za-z]:[\\/]/

test('★ 中文 + 空格 + 反斜杠的 Windows 路径被完整吃掉（这是实际泄漏的形态）', () => {
  const input = 'Mate Engine DLC（F:\\deepseek harness\\AI女友\\repos\\Mate-Engine），目录内无独立许可文件'
  const out = redactPaths(input)
  assert.equal(HAS_DRIVE.test(out), false, `仍含盘符：${out}`)
  assert.equal(out.includes('Mate-Engine'), false, '路径段不该残留')
  assert.match(out, /目录内无独立许可文件/, '路径之外的说明必须保留')
})

test('正斜杠形态、UNC、类 Unix 路径都被处理', () => {
  assert.equal(HAS_DRIVE.test(redactPaths('见 C:/Users/someone/secret/file.txt 说明')), false)
  assert.equal(redactPaths('\\\\server\\share\\file.txt').includes('server'), false)
  assert.equal(redactPaths('见 /home/user/secret/file.txt 说明').includes('secret'), false)
})

test('★ 兜底：无论正则怎么改，输出里都不允许残留盘符', () => {
  // 故意构造一个"没有标准分隔符"的畸形串
  const weird = redactPaths('X:\\')
  assert.equal(HAS_DRIVE.test(weird), false)
  const weird2 = redactPaths('a D:\\ b')
  assert.equal(HAS_DRIVE.test(weird2), false)
})

test('不含路径的普通文本**原样保留**（脱敏不该误伤许可说明）', () => {
  const s = 'CC0-1.0 公共领域；允许再分发与商用'
  assert.equal(redactPaths(s), s)
  assert.equal(redactPaths(''), '')
})

test('★ projectLicenseForRenderer 只脱敏自由文本，不动结构化字段', () => {
  const lic = {
    provenance: 'private-only',
    redistributable: false,
    commercialUse: false,
    license: 'upstream-dlc-asset',
    licenseSource: 'F:\\x\\LICENSE.txt',
    author: 'Mate Engine',
    attributionRequired: true,
    note: '见 F:\\deepseek harness\\AI女友\\repos\\Mate-Engine 目录',
  }
  const p = projectLicenseForRenderer(lic)
  assert.equal(p.provenance, 'private-only')
  assert.equal(p.redistributable, false)
  assert.equal(p.commercialUse, false)
  assert.equal(p.attributionRequired, true)
  assert.equal(p.licenseSource, '<path>')
  assert.equal(HAS_DRIVE.test(p.note), false)
  // 原对象不得被就地修改（主进程内的审计仍要看到完整信息）
  assert.equal(lic.note.includes('F:\\'), true, 'projectLicenseForRenderer 不得修改入参')
})

test('licenseSource 为 null 时保持 null（不要变成字符串 "null"）', () => {
  const p = projectLicenseForRenderer({
    provenance: 'licensed', redistributable: true, commercialUse: true, license: 'CC0-1.0',
    licenseSource: null, author: null, attributionRequired: false, note: '',
  })
  assert.equal(p.licenseSource, null)
})

// ───────────────────────────────────────────────────────── 递归清洗（边界守卫）
//
// 这一组是**补第二次同类泄漏**才出现的。
// 第一次修法是逐字段点名（只投影 license.note / licenseSource），
// 结果打包载荷里实测又漏了两个字段：
//   · assets.detail           ← readCatalog() 的「清单不存在：<绝对路径>」
//   · adapters[].unavailableReason ← 同源
// 逐字段修补的病根是"依赖每次加字段都记得再点一次名"。
// 所以现在改成在出口做一次深度清洗，下面把它的行为钉死。

const { redactDeep } = require('../dist/main/capabilities/asset-adapter.js')

test('★★ redactDeep 覆盖**新增**字段（逐字段修补漏掉的正是这一类）', () => {
  const payload = {
    assets: {
      detail: '清单不存在：F:\\deepseek harness\\AI女友\\新工程\\dist-package\\resources\\workspace\\assets\\models\\catalog.json',
      rejected: [
        { id: 'lazuli', reason: 'denied-packaged-non-redistributable', detail: '文件不存在：F:\\x\\y\\Lazuli_VRM.vrm' },
      ],
      // 一个**今天还不存在**的字段：深度清洗必须自动覆盖它，不需要有人记得改代码
      someFutureField: { nested: ['见 C:\\Users\\someone\\AppData\\Local\\secret'] },
    },
    adapters: [{ unavailableReason: '清单不存在：F:\\deepseek harness\\AI女友\\新工程\\assets\\models\\catalog.json' }],
  }
  const out = redactDeep(payload)
  const json = JSON.stringify(out)
  assert.equal(HAS_DRIVE.test(json), false, `仍有盘符：${json}`)
  assert.equal(json.includes('Lazuli_VRM'), false, '路径段不该残留')
  assert.equal(json.includes('someone'), false, '用户名不该残留')
  // 结论性文本必须保留 —— 脱敏不是"把出参删空"
  assert.equal(out.adapters[0].unavailableReason.includes('清单不存在'), true)
  assert.equal(out.assets.rejected[0].reason, 'denied-packaged-non-redistributable')
})

test('★ redactDeep 不改原对象（主进程内的审计仍要看到完整信息）', () => {
  const original = { a: { b: 'F:\\secret\\path.txt' } }
  const out = redactDeep(original)
  assert.equal(out.a.b, '<path>')
  assert.equal(original.a.b, 'F:\\secret\\path.txt', 'redactDeep 不得就地修改入参')
})

test('redactDeep 保留非字符串类型（数字/布尔/null 不是路径）', () => {
  const out = redactDeep({ n: 42, f: false, z: null, s: 'ok', arr: [1, 'two', true] })
  assert.deepEqual(out, { n: 42, f: false, z: null, s: 'ok', arr: [1, 'two', true] })
})

test('redactDeep 对环状结构不爆栈（深度上限兜底）', () => {
  const a = { name: 'root' }
  a.self = a
  const out = redactDeep(a)
  assert.equal(out.name, 'root')
  assert.equal(typeof out.self, 'object', '超过深度上限时原样返回，而不是抛栈溢出')
})

test('redactDeep 对字符串/数组/标量直接可用', () => {
  assert.equal(redactDeep('C:\\x\\y.txt'), '<path>')
  assert.deepEqual(redactDeep(['C:\\x\\y.txt']), ['<path>'])
  assert.equal(redactDeep(7), 7)
  assert.equal(redactDeep(null), null)
})

test('★★ 四个 KIT 通道的出参都走深度清洗（源码级断言：出口只有一处）', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.ts'), 'utf8')
  // 每个 KIT 只读通道的返回值都必须包在 redactDeep 里
  for (const ch of ['KIT_CAPABILITIES', 'KIT_ASSETS', 'KIT_TOOL_AUDIT', 'KIT_STORES']) {
    const at = src.indexOf(`IPC.${ch}`)
    assert.notEqual(at, -1, `${ch} 不存在`)
    // 从通道声明往后 900 字符内必须出现 redactDeep（够覆盖单行 return 的形状）
    const seg = src.slice(at, at + 900)
    assert.equal(seg.includes('redactDeep'), true, `${ch} 的出参没有走 redactDeep（会重新漏路径）`)
  }
})

// ───────────────────────────────────────────────────────── 能力清单"少列一项"的守卫
//
// 这一组补的是一个**在同一轮里犯了三次**的错误：能力种类清单各写一遍，漏一个不报错。
//   ① 探针的 `kinds` 只有 5 类，没有 `motion` ⇒ 缺口永远查不出来；
//   ② `initCapabilityKit()` 的选型清单也没有 `motion` ⇒ 适配器注册了却永不生效
//      （`registered:1, available:true, activeId:null`，日志里一条警告都没有）；
//   ③ `AppDiagnosticsSchema` 里压根没有 motion 这一项 ⇒ 读数无处可放。
// 这类错误的共同点是"没有任何编译错误，也没有任何运行时错误"，
// 所以只能靠**清单之间的一致性断言**来挡。

test('★★ SELECT_KINDS 必须包含 motion，且**不得**包含 storage/privacy', () => {
  const { SELECT_KINDS } = require('../dist/main/capabilities/index.js')
  assert.ok(Array.isArray(SELECT_KINDS) || typeof SELECT_KINDS === 'object')
  const kinds = Array.from(SELECT_KINDS)
  assert.ok(kinds.includes('motion'), `SELECT_KINDS 漏了 motion：${kinds.join(',')}`)
  for (const k of ['avatar', 'tts', 'llm', 'stt', 'wakeword']) {
    assert.ok(kinds.includes(k), `SELECT_KINDS 漏了 ${k}`)
  }
  /**
   * ★ `storage` / `privacy` 属于"框架自身的通道"，语义是**一组库 / 两条通道**，
   *   不是"每类挑一个生效实现" ⇒ 它们**不该**进选型清单（进了会选出个无意义的 activeId）。
   *   但"不选"不等于"不注册"：不注册就等于整类不存在
   *   （实测就是这样：`registered: 0`，界面里根本看不到这两类）。
   */
  for (const k of ['storage', 'privacy']) {
    assert.equal(kinds.includes(k), false, `SELECT_KINDS 不该包含 ${k}（它不是"选一个"的语义）`)
  }
})

test('★★ 探针的能力清单必须**取自 CAPABILITY_KINDS 的全量**，不得再手抄一份', () => {
  const fs = require('node:fs')
  const { SELECT_KINDS } = require('../dist/main/capabilities/index.js')
  const { CAPABILITY_KINDS } = require(path.resolve(__dirname, '..', '..', '..', 'packages', 'companion-kit', 'dist', 'index.js'))
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'bootstrap.ts'), 'utf8')

  /**
   * 这条断言的口径在本轮**升级过**，理由值得记下来：
   *
   *   原口径：抓探针里的 `const kinds = [...]` 字面量，用它和 `SELECT_KINDS` 比。
   *   它挡住了第一次漂移（探针漏 motion），但**没能挡住第二次**：
   *   探针后来写成 6 类硬编码，而 `CAPABILITY_KINDS` 声明的是 **9 类** ——
   *   `tool` / `storage` / `privacy` 三类在探针里从来没被检查过，
   *   这条"防漂移"的断言**照样通过**（因为 `SELECT_KINDS` 也是 6 类，两边一起错）。
   *
   *   ⇒ 根因不是"又漏了一项"，而是**手抄清单**这个做法本身。
   *     所以现在断言改的是**做法**：探针必须从 `CAPABILITY_KINDS` 派生，
   *     并且源码里**不允许**再出现手抄的种类字面量。
   */
  assert.ok(src.includes('const declaredKinds = [...CAPABILITY_KINDS]'),
    '探针的能力清单必须写成 `const declaredKinds = [...CAPABILITY_KINDS]`（单一真源）')

  const hand = src.match(/const kinds\s*=\s*\[([^\]]*)\]/)
  assert.equal(hand, null,
    `bootstrap.ts 里又出现了手抄的能力清单：${hand ? hand[0] : ''} —— 请改为从 CAPABILITY_KINDS 派生`)

  // 单一真源本身必须覆盖 SELECT_KINDS（选型清单是它的子集，不是另一份清单）
  for (const k of Array.from(SELECT_KINDS)) {
    assert.ok(CAPABILITY_KINDS.includes(k), `CAPABILITY_KINDS 漏了 SELECT_KINDS 里的 ${k}`)
  }
  // 并明确：storage / privacy 也在 CAPABILITY_KINDS 里（否则"每类都注册"这条判据查不到它们）
  for (const k of ['tool', 'storage', 'privacy']) {
    assert.ok(CAPABILITY_KINDS.includes(k), `CAPABILITY_KINDS 漏了 ${k}`)
  }
})

test('★★ 诊断报文里必须有 motion 这一项（否则动作许可无处上报）', () => {
  const { AppDiagnosticsSchema } = require(path.resolve(__dirname, '..', '..', '..', 'packages', 'shared', 'dist', 'index.js'))
  const shape = AppDiagnosticsSchema.shape
  assert.ok(shape.motion, 'AppDiagnosticsSchema 缺 motion')
  const parsed = shape.motion.parse({ clipCount: 0, manifestCount: 0, failed: [] })
  assert.equal(parsed.license, null, '缺省应为 null，而不是 undefined（UI 要能直接显示）')
  assert.deepEqual(parsed.clipIds, [])
})

// ───────────────────────────────────────────────────────── 授权根与判定必须一致
//
// 这一组挡的是一处"说了拒、其实还读得到"的不一致：
//   `asset-protocol.ts` 原来无条件把 `motionDir` 注册成 `app://asset/` 的授权根，
//   而动作适配器在打包形态下会判定"这些动作不可再分发 ⇒ 不可用"。
//   两条结论同时成立就是矛盾 —— 适配器说不能用，协议层却照样愿意把文件喂出去。
//   正常路径下 renderer 拿不到 clip id、不会去请求，但"授权根"是**独立防线**，
//   不该依赖"调用方不知道 id"这种默契。

test('★★ 动作来源未接线 ⇒ 授权根为 null（不假装有动作，也不放开目录）', () => {
  const motionState = require('../dist/main/motion-state.js')
  motionState.setMotionSource(null)
  assert.equal(motionState.motionSourceWired(), false)
  assert.equal(motionState.motionAssetRoot(), null, '没接线时必须 null（而不是指向 motionDir）')
  const st = motionState.refreshMotionStatus()
  assert.equal(st.clipCount, 0)
  assert.match(st.failed.join(' '), /未接入/, '没接线要如实说明，而不是静默空列表')
})

test('★★ 适配器判定"无可用动作" ⇒ 授权根为 null（判定结论与能不能读是同一件事）', () => {
  const motionState = require('../dist/main/motion-state.js')
  const ROOT = 'F:\\some\\motion-dir'
  // 模拟打包形态：清单不可再分发 ⇒ clips 为空
  motionState.setMotionSource({
    resolve: () => ({
      clips: [], rejected: [{ id: 'a', reason: 'denied-packaged-non-redistributable' }],
      totalClipFiles: 3, detail: '动作资产为私有来源（x），当前形态下不可用（3 个全部被拒）',
      license: { license: 'x', redistributable: false },
    }),
    manifests: () => ({ manifests: [], failed: [] }),
    assetRoot: () => ROOT,
  })
  assert.equal(motionState.motionAssetRoot(), null,
    '适配器说没有可用动作，授权根就必须是 null（否则协议层还能把文件喂出去）')
  assert.equal(motionState.refreshMotionStatus().clipCount, 0)

  // 对照：有可用动作时才给出授权根
  motionState.setMotionSource({
    resolve: () => ({
      clips: [{ id: 'idle' }], rejected: [],
      totalClipFiles: 1, detail: '可用 1 / 1',
      license: { license: 'CC0-1.0', redistributable: true },
    }),
    manifests: () => ({ manifests: [], failed: [] }),
    assetRoot: () => ROOT,
  })
  assert.equal(motionState.motionAssetRoot(), ROOT)
  assert.equal(motionState.refreshMotionStatus().clipCount, 1)
  motionState.setMotionSource(null)
})

test('★ 源码级：asset-protocol 不再无条件把 motionDir 当授权根', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'asset-protocol.ts'), 'utf8')
  assert.equal(/asset:\s*\{\s*root:\s*p\.motionDir/.test(src), false,
    'asset 授权根又写死成 motionDir 了 —— 会与动作适配器的许可判定矛盾')
  assert.match(src, /motionAssetRoot\(\)/, 'asset 授权根必须来自 motionAssetRoot()')
})

// ───────────────────────────────────────────────────────── 运行形态判定

/**
 * ★ 形态判定决定许可闸门的严格度，而它踩过**两次**真实失败：
 *   坑 A：把"有 workspace"直接当成 packaged ⇒ 私有自用安装被判成分发形态 ⇒ 装完没有角色。
 *   坑 B：只看 `app.isPackaged`。本项目把 `electron.exe` 改名成 `AiriMateOne.exe`，
 *         而 Electron 判定"打包"的依据正是可执行文件名 ⇒ 组装出来的
 *         `dist-package\AiriMateOne.exe` 即使跑工作区产物，`isPackaged` 仍为 true
 *         ⇒ **同一个后果**（实测：组装载荷里 `profile=packaged`、`active-avatar=false`）。
 *
 * 所以这条判定的优先级必须被钉死：显式声明 > 有 workspace（私有自用/开发树）> isPackaged。
 */
test('★★ resolveRuntimeProfile 优先级：显式声明 > workspace > isPackaged > development', () => {
  const { resolveRuntimeProfile } = require('../dist/main/capabilities/index.js')
  const saved = { p: process.env.AIRIMATE_PROFILE, w: process.env.AIRIMATE_WORKSPACE }
  try {
    // ① 显式声明最高（发布脚本/商业构建用）
    delete process.env.AIRIMATE_WORKSPACE
    process.env.AIRIMATE_PROFILE = 'packaged'
    assert.equal(resolveRuntimeProfile(), 'packaged')
    process.env.AIRIMATE_PROFILE = 'development'
    assert.equal(resolveRuntimeProfile(), 'development')
    // 显式声明连 workspace 都能压过（有意识的选择优先于推断）
    process.env.AIRIMATE_WORKSPACE = 'F:\\somewhere'
    process.env.AIRIMATE_PROFILE = 'packaged'
    assert.equal(resolveRuntimeProfile(), 'packaged')

    // ② 没有显式声明时：有 workspace ⇒ development（**这正是坑 B 的修法**）
    delete process.env.AIRIMATE_PROFILE
    process.env.AIRIMATE_WORKSPACE = 'F:\\somewhere'
    assert.equal(resolveRuntimeProfile(), 'development', '私有自用安装不该被判成分发形态')

    // ③ 都没有 ⇒ 单测环境没有 electron ⇒ development（不得崩）
    delete process.env.AIRIMATE_WORKSPACE
    assert.equal(resolveRuntimeProfile(), 'development')

    // ④ 空串等同于未设置（env 传空串是常见写法，不该被当成"有 workspace"）
    process.env.AIRIMATE_WORKSPACE = ''
    assert.equal(resolveRuntimeProfile(), 'development')
  } finally {
    if (saved.p === undefined) delete process.env.AIRIMATE_PROFILE; else process.env.AIRIMATE_PROFILE = saved.p
    if (saved.w === undefined) delete process.env.AIRIMATE_WORKSPACE; else process.env.AIRIMATE_WORKSPACE = saved.w
  }
})
