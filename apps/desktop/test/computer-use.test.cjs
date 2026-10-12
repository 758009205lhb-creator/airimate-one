/**
 * apps/desktop/test/computer-use.test.cjs —— 电脑操作工具的**安全属性**单测（M3 §3/§4/§5/§6）
 *
 * 这个文件也是补缺口才出现的：外部复核指出 `computer-use.ts` 单测覆盖数为 **0** ——
 * 而它恰好是"最有侵入性"的那一块（屏幕、文件、启动应用、剪贴板）。
 *
 * 能单测的部分（不真的截图、不真的启动应用）：
 *   · **脱敏掩码**：排除区与任意格有交叠就打码；没有排除区就一格都不打；
 *   · **屏幕状态**：默认未授权、未截过、暂停开关生效；
 *   · **目录白名单管理**：给界面的条目**只有 id + 末级目录名**；敏感目录加不进去；撤销幂等；
 *   · **id 不可反推**：同一个目录稳定、不同目录不同，且不含路径片段。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir, stubElectron, resetStores } = require('./helpers/harness.cjs')

const TMP = tmpdir('cuse')
stubElectron(TMP)

const cu = require('../dist/main/computer-use.js')
const perm = require('../dist/main/permission-store.js')

const ALL = { cu, perm }

test.beforeEach(() => {
  fs.rmSync(path.join(TMP, 'permissions.json'), { force: true })
  resetStores(ALL)
})

// ───────────────────────────────────────────────────────── 脱敏掩码

test('★ 没有排除区 ⇒ 一格都不打码（不能"默认全打"把画面变成马赛克）', () => {
  const m = cu.buildRedactionMask([])
  assert.equal(m.grid, 16)
  assert.equal(m.cells.length, 256)
  assert.equal(m.maskedCells, 0)
  assert.equal(m.cells.some(Boolean), false)
})

test('★ 排除区覆盖整屏 ⇒ 全打码（保守侧：宁可多打一块，也不漏出一段密码框）', () => {
  const m = cu.buildRedactionMask([{ x: 0, y: 0, w: 1, h: 1 }])
  assert.equal(m.maskedCells, 256)
  assert.equal(m.cells.every(Boolean), true)
})

test('★ 局部排除区：只打与它相交的格（打码范围可解释）', () => {
  // 左上角 1/4 屏 ⇒ 16×16 栅格里应有 8×8 = 64 格
  const m = cu.buildRedactionMask([{ x: 0, y: 0, w: 0.5, h: 0.5 }])
  assert.equal(m.maskedCells, 64, `实际 ${m.maskedCells}`)
})

test('★ 极小的排除区也会打中至少一格（否则密码框可能正好落在一条细缝里）', () => {
  const m = cu.buildRedactionMask([{ x: 0.5, y: 0.5, w: 0.001, h: 0.001 }])
  assert.ok(m.maskedCells >= 1, '再小的排除区也必须至少命中一格')
})

test('多个排除区按并集打码（不重复计数）', () => {
  const a = cu.buildRedactionMask([{ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 0.5, h: 0.5 }])
  const b = cu.buildRedactionMask([{ x: 0, y: 0, w: 0.5, h: 0.5 }])
  assert.equal(a.maskedCells, b.maskedCells, '重叠区域不该被算两次')
  const c = cu.buildRedactionMask([{ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }])
  assert.equal(c.maskedCells, 128)
})

test('栅格尺寸可配，且 cells 长度恒为 grid²', () => {
  for (const g of [4, 8, 32]) {
    const m = cu.buildRedactionMask([{ x: 0, y: 0, w: 0.5, h: 0.5 }], g)
    assert.equal(m.grid, g)
    assert.equal(m.cells.length, g * g)
  }
})

// ───────────────────────────────────────────────────────── 掩码**真的涂到像素上**
//
// 这一组是补一个**实质缺口**才出现的：在此之前，掩码只是个布尔数组 + 统计数字，
// **没有任何一行代码改过像素**（原注释还引用了一个不存在的 `applyMask`），
// 于是"排除区打码/敏感信息脱敏"只是个说法。下面这些用例把"说法"变成可验证的事实。

/** 造一张纯色 BGRA 位图（默认每像素 [1,2,3,255]，便于分辨"被涂过"） */
function makeBitmap(width, height, px = [1, 2, 3, 255]) {
  const b = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    b[i * 4] = px[0]; b[i * 4 + 1] = px[1]; b[i * 4 + 2] = px[2]; b[i * 4 + 3] = px[3]
  }
  return b
}
const BLACK = [0, 0, 0, 255]

test('★★ 掩码真的改像素：排除区内的像素被涂成不透明填充色', () => {
  const W = 64, H = 64
  const bmp = makeBitmap(W, H)
  // 左上 1/4 区 ⇒ 16×16 栅格里 8×8 格 ⇒ 像素上就是左上 32×32 块
  const mask = cu.buildRedactionMask([{ x: 0, y: 0, w: 0.5, h: 0.5 }])
  const r = cu.paintMaskOnBitmap(bmp, { width: W, height: H }, mask)

  assert.equal(r.cells, 64)
  assert.equal(r.painted, 32 * 32, `实际涂了 ${r.painted} 个像素`)
  // 左上角：被涂
  assert.equal(cu.isPixelFilled(bmp, { width: W, height: H }, 0, 0), true, '排除区内的像素必须被涂')
  assert.equal(cu.isPixelFilled(bmp, { width: W, height: H }, 31, 31), true)
  // 右下角：**必须原样不动**（不能把整屏涂黑）
  assert.equal(cu.isPixelFilled(bmp, { width: W, height: H }, 32, 32), false, '排除区外不许动')
  assert.equal(cu.isPixelFilled(bmp, { width: W, height: H }, W - 1, H - 1), false)
})

test('★ 没有排除区 ⇒ 一个像素都不改（`painted=0` 是"没脱敏"的诚实读数）', () => {
  const W = 32, H = 32
  const bmp = makeBitmap(W, H)
  const before = Uint8Array.from(bmp)
  const r = cu.paintMaskOnBitmap(bmp, { width: W, height: H }, cu.buildRedactionMask([]))
  assert.equal(r.painted, 0)
  assert.deepEqual(Array.from(bmp), Array.from(before), '零掩码不许改任何字节')
})

test('★ 整屏排除 ⇒ 每个像素都被涂（且 painted === 像素总数，不重不漏）', () => {
  const W = 40, H = 24
  const bmp = makeBitmap(W, H)
  const r = cu.paintMaskOnBitmap(bmp, { width: W, height: H }, cu.buildRedactionMask([{ x: 0, y: 0, w: 1, h: 1 }]))
  assert.equal(r.painted, W * H, '整屏打码必须正好覆盖每个像素一次')
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      assert.equal(cu.isPixelFilled(bmp, { width: W, height: H }, x, y), true, `(${x},${y}) 没被涂`)
    }
  }
})

test('★ 极小的排除区在像素上至少涂 1 个像素（细缝里也不能漏）', () => {
  const W = 32, H = 32
  const bmp = makeBitmap(W, H)
  const r = cu.paintMaskOnBitmap(bmp, { width: W, height: H }, cu.buildRedactionMask([{ x: 0.5, y: 0.5, w: 0.001, h: 0.001 }]))
  assert.ok(r.painted >= 1, '极小排除区也必须真的涂到像素')
})

test('★ 位图太小 / 栅格非法 ⇒ 什么都不涂并返回 0（**绝不**越界写）', () => {
  const bmp = makeBitmap(4, 4)
  const before = Uint8Array.from(bmp)
  // 声称是 64×64 但只给了 4×4 的缓冲 ⇒ 必须拒绝，而不是写到别人的内存上
  assert.equal(cu.paintMaskOnBitmap(bmp, { width: 64, height: 64 }, cu.buildRedactionMask([{ x: 0, y: 0, w: 1, h: 1 }])).painted, 0)
  assert.equal(cu.paintMaskOnBitmap(bmp, { width: 4, height: 4 }, { grid: 0, cells: [] }).painted, 0)
  assert.equal(cu.paintMaskOnBitmap(bmp, { width: 0, height: 4 }, { grid: 4, cells: [true, true, true, true] }).painted, 0)
  assert.deepEqual(Array.from(bmp), Array.from(before), '被拒绝的调用不许留下任何修改')
})

test('★ 填充色可配（便于"红框"式的可视提示），且 alpha 会被写进去', () => {
  const W = 16, H = 16
  const bmp = makeBitmap(W, H)
  const RED = [0, 0, 255, 255] // BGRA ⇒ 红
  const r = cu.paintMaskOnBitmap(bmp, { width: W, height: H }, cu.buildRedactionMask([{ x: 0, y: 0, w: 1, h: 1 }]), RED)
  assert.equal(r.painted, W * H)
  assert.equal(cu.isPixelFilled(bmp, { width: W, height: H }, 8, 8, RED), true)
  assert.equal(cu.isPixelFilled(bmp, { width: W, height: H }, 8, 8, BLACK), false)
})

test('★★ 掩码格与像素块的映射与 `buildRedactionMask` 的比例一致（8/16 栅格对得上）', () => {
  // 这条挡的是"掩码说打了 64 格、实际只涂了 1 格"这类**读数与事实脱节**
  for (const [frac, expectCells] of [[0.5, 64], [0.25, 16], [1, 256]]) {
    const W = 64, H = 64
    const bmp = makeBitmap(W, H)
    const mask = cu.buildRedactionMask([{ x: 0, y: 0, w: frac, h: frac }])
    const r = cu.paintMaskOnBitmap(bmp, { width: W, height: H }, mask)
    assert.equal(mask.maskedCells, expectCells, `frac=${frac} 掩码格数`)
    const side = Math.round(Math.sqrt(expectCells))
    const px = Math.round((side / 16) * W)
    assert.equal(r.painted, px * px, `frac=${frac}: 格数 ${expectCells} 应对应 ${px}×${px} 像素`)
  }
})

test('`isPixelFilled` 越界一律返回 false（不读越界内存）', () => {
  const bmp = makeBitmap(4, 4)
  assert.equal(cu.isPixelFilled(bmp, { width: 4, height: 4 }, -1, 0), false)
  assert.equal(cu.isPixelFilled(bmp, { width: 4, height: 4 }, 4, 0), false)
  assert.equal(cu.isPixelFilled(bmp, { width: 4, height: 4 }, 0, 99), false)
})

// ───────────────────────────────────────────────────────── 屏幕状态

test('★★ 默认：未授权、未截过图、未暂停（"不持续录屏"的直接读数）', () => {
  const s = cu.screenStatus()
  assert.equal(s.permitted, false, '屏幕理解默认未授权')
  assert.equal(s.paused, false)
  assert.equal(s.lastCaptureAt, null, '默认从未截过图')
  assert.equal(s.captureCount, 0)
  assert.equal(s.excludeRegions.length, 0)
  assert.equal(s.redactSensitive, true, '脱敏默认开')
})

test('暂停开关生效且可复位', () => {
  cu.setScreenPaused(true)
  assert.equal(cu.screenStatus().paused, true)
  cu.setScreenPaused(false)
  assert.equal(cu.screenStatus().paused, false)
})

test('★ 授权后 permitted 才为 true（授权 = 权限表里的 screen-capture 启用）', () => {
  perm.setPermission({ kind: 'screen-capture', enabled: true })
  assert.equal(cu.screenStatus().permitted, true)
  perm.setPermission({ kind: 'screen-capture', enabled: false })
  assert.equal(cu.screenStatus().permitted, false)
})

test('★ 设置页的脱敏开关**单向同步进权限表**（避免两个真源漂移）', () => {
  assert.equal(perm.getPermission('screen-capture').redactSensitive, true)
  cu.syncScreenRedactFromSettings(false)
  assert.equal(perm.getPermission('screen-capture').redactSensitive, false, '设置改了权限表要跟着变')
  assert.equal(cu.screenStatus().redactSensitive, false)
  cu.syncScreenRedactFromSettings(true)
  assert.equal(perm.getPermission('screen-capture').redactSensitive, true)
})

test('截图提示默认没有（从未截过）', () => {
  assert.equal(cu.lastCaptureNotice(), null)
})

test('屏幕诊断只给计数与开关，不含画面', () => {
  const d = cu.computerUseDiagnostics()
  assert.equal(typeof d.screen.captureCount, 'number')
  assert.equal(d.allowedApps.length >= 5, true)
  assert.equal('image' in d.screen, false)
  assert.equal('dataUrl' in d.screen, false)
})

// ───────────────────────────────────────────────────────── 目录白名单管理

test('★★ 给界面的条目**只有 id 与末级目录名**（renderer 拿不到完整路径）', () => {
  const dir = path.join(TMP, 'projects', 'notes')
  fs.mkdirSync(dir, { recursive: true })
  const r = cu.addAllowlistedDir(dir)
  assert.equal(r.ok, true, r.detail)
  const entries = cu.allowlistEntriesForUi()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].label, 'notes', '只给末级目录名')
  assert.equal(entries[0].id.length, 12)
  const json = JSON.stringify(entries)
  assert.equal(new RegExp(String.raw`[A-Za-z]:[\\/]`).test(json), false, `条目里不该出现盘符：${json}`)
  assert.equal(json.includes('projects'), false, '不该出现上级目录名')
})

test('★ 敏感目录加不进去（`.ssh`），且给出原因码', () => {
  const ssh = path.join(TMP, '.ssh')
  fs.mkdirSync(ssh, { recursive: true })
  const r = cu.addAllowlistedDir(ssh)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SENSITIVE-DIR')
  assert.equal(cu.allowlistEntriesForUi().length, 0, '被拒的目录不得进入白名单')
})

test('★ 不存在的目录加不进去（避免白名单里塞进无效路径）', () => {
  const r = cu.addAllowlistedDir(path.join(TMP, 'no-such-dir-xyz'))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NOT-FOUND')
})

test('★ 重复授权同一目录只留一条（界面不该出现两条一样的）', () => {
  const dir = path.join(TMP, 'dupdir')
  fs.mkdirSync(dir, { recursive: true })
  assert.equal(cu.addAllowlistedDir(dir).ok, true)
  const again = cu.addAllowlistedDir(dir)
  assert.equal(again.ok, true, '重复授权不算错误')
  assert.equal(again.code, 'OK')
  assert.equal(cu.allowlistEntriesForUi().length, 1, '去重后只应有一条')
})

test('★ 撤销幂等：存在返回 true，第二次返回 false', () => {
  const dir = path.join(TMP, 'revoke-me')
  fs.mkdirSync(dir, { recursive: true })
  cu.addAllowlistedDir(dir)
  const id = cu.allowlistEntriesForUi()[0].id
  assert.equal(cu.revokeAllowlistedDir(id), true)
  assert.equal(cu.revokeAllowlistedDir(id), false)
  assert.equal(cu.allowlistEntriesForUi().length, 0)
})

test('★ id 稳定且不可反推（同目录同 id；不同目录不同 id；不含路径片段）', () => {
  const a = path.join(TMP, 'aaa')
  const b = path.join(TMP, 'bbb')
  fs.mkdirSync(a, { recursive: true })
  fs.mkdirSync(b, { recursive: true })
  cu.addAllowlistedDir(a)
  const idA1 = cu.allowlistEntriesForUi().find(e => e.label === 'aaa').id
  cu.addAllowlistedDir(b)
  const idA2 = cu.allowlistEntriesForUi().find(e => e.label === 'aaa').id
  const idB = cu.allowlistEntriesForUi().find(e => e.label === 'bbb').id
  assert.equal(idA1, idA2, '同一个目录的 id 必须稳定')
  assert.notEqual(idA1, idB)
  for (const id of [idA1, idB]) {
    assert.match(id, /^[0-9a-f]{12}$/)
    assert.equal(id.includes('aaa'), false)
    assert.equal(id.includes(TMP.slice(0, 3)), false)
  }
})

// ───────────────────────────────────────────────────────── 工具清单

test('★ 六个 M3 工具都登记了权限种类与超时（缺任一项等于没有约束）', () => {
  const tools = cu.computerUseTools()
  const names = tools.map(t => t.name).sort()
  assert.deepEqual(names, ['app.launch', 'clipboard.read', 'file.list', 'file.read', 'screen.capture', 'window.list'])
  for (const t of tools) {
    assert.ok(t.permissionKind.length > 0, `${t.name} 缺 permissionKind`)
    assert.ok(t.timeoutMs > 0, `${t.name} 缺 timeoutMs`)
    assert.ok(t.description.length > 0, `${t.name} 缺说明`)
  }
})

test('★ 启动应用是**白名单化的 id**，不接受任意路径（否则等于绕过 shell-exec 的硬下限）', async () => {
  const t = cu.computerUseTools().find(x => x.name === 'app.launch')
  const r = await t.run({ app: 'C:\\Windows\\System32\\cmd.exe' }, { callId: 'x', signal: new AbortController().signal, confirmed: true })
  assert.equal(r.ok, false)
  assert.match(r.message, /白名单/)
  assert.deepEqual(cu.ALLOWED_APPS.map(a => a.id).includes('explorer'), true)
})

test('★ 未授权时 file.read / screen.capture **不执行**并如实说明原因', async () => {
  const read = cu.computerUseTools().find(x => x.name === 'file.read')
  const r1 = await read.run({ path: path.join(TMP, 'x.txt') }, { callId: 'x', signal: new AbortController().signal, confirmed: false })
  assert.equal(r1.ok, false)
  assert.match(r1.message, /未启用/)

  const cap = cu.computerUseTools().find(x => x.name === 'screen.capture')
  const r2 = await cap.run({}, { callId: 'x', signal: new AbortController().signal, confirmed: false })
  assert.equal(r2.ok, false)
  assert.match(r2.message, /未启用|暂停/)
})

test('★ 暂停时即使已授权也不截图（"暂停"必须真的挡住）', async () => {
  perm.setPermission({ kind: 'screen-capture', enabled: true })
  cu.setScreenPaused(true)
  try {
    const cap = cu.computerUseTools().find(x => x.name === 'screen.capture')
    const r = await cap.run({}, { callId: 'x', signal: new AbortController().signal, confirmed: false })
    assert.equal(r.ok, false)
    assert.match(r.message, /暂停/)
    assert.equal(cu.screenStatus().captureCount, 0, '暂停期间不该产生任何截图计数')
  } finally {
    cu.setScreenPaused(false)
  }
})

test('★ 授权目录后 file.read 仍拒绝白名单外的文件（白名单真的在起作用）', async () => {
  const allowed = path.join(TMP, 'allowed')
  const outside = path.join(TMP, 'outside')
  fs.mkdirSync(allowed, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  /**
   * ⚠ 文件名要**避开敏感规则**：我第一版用了 `secret.txt`，它被
   *   `credential-db` / `token-file` 规则先拦下了 —— 于是断言"必须报白名单"
   *   失败，而实现其实是**对的**（更严的规则先命中）。
   *   测"白名单"这件事就得用一个完全普通的文件名，否则测的是别的规则。
   */
  fs.writeFileSync(path.join(outside, 'plain-note.txt'), 'nope', 'utf8')
  perm.setPermission({ kind: 'file-read', enabled: true, pathAllowlist: [allowed] })
  const read = cu.computerUseTools().find(x => x.name === 'file.read')
  const r = await read.run({ path: path.join(outside, 'plain-note.txt') }, { callId: 'x', signal: new AbortController().signal, confirmed: false })
  assert.equal(r.ok, false)
  assert.match(r.message, /白名单/, `实际：${r.message}`)
})

test('★ file.read 默认**不返回正文**（只给摘要），显式请求才给', async () => {
  const dir = path.join(TMP, 'readable')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'note.txt')
  fs.writeFileSync(file, '这是正文内容', 'utf8')
  perm.setPermission({ kind: 'file-read', enabled: true, pathAllowlist: [dir] })
  const read = cu.computerUseTools().find(x => x.name === 'file.read')

  const summary = await read.run({ path: file }, { callId: 'x', signal: new AbortController().signal, confirmed: false })
  assert.equal(summary.ok, true)
  assert.equal(JSON.stringify(summary.data).includes('这是正文内容'), false, '默认不该带正文')

  const withText = await read.run({ path: file, includeText: true }, { callId: 'x', signal: new AbortController().signal, confirmed: false })
  assert.equal(withText.ok, true)
  assert.equal(JSON.stringify(withText.data).includes('这是正文内容'), true, '显式请求时才给正文')
})

test('★ 已授权目录里的敏感文件仍被拒（白名单不等于放行凭据）', async () => {
  const dir = path.join(TMP, 'with-secrets')
  fs.mkdirSync(dir, { recursive: true })
  const env = path.join(dir, '.env')
  fs.writeFileSync(env, 'SECRET=1', 'utf8')
  perm.setPermission({ kind: 'file-read', enabled: true, pathAllowlist: [dir] })
  const read = cu.computerUseTools().find(x => x.name === 'file.read')
  const r = await read.run({ path: env }, { callId: 'x', signal: new AbortController().signal, confirmed: false })
  assert.equal(r.ok, false)
  assert.match(r.message, /敏感文件/)
})
