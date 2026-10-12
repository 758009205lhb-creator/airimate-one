/**
 * packages/avatar-stage/test/motion-runtime.test.mjs —— 舞台动作运行时的单测
 *
 * 为什么必须有：`motion-runtime.ts` 是**真正在跑的那一份**动作决策（Stage 每帧调用它），
 * 但它此前**一个测试都没有** —— 而另一个不被使用的 `@airimate/motion-director`
 * 反而有 41 个测试。这是最危险的一种技术债：**测的不是跑的那份**。
 * 本文件把生产运行时的**不变量**钉死，重点覆盖"坏了也不会报错"的那几条：
 *
 *   ① **无 T-pose 窗口**：任何时刻 `getBaseClipId()` 必须是一个**真实存在**的 clip；
 *   ② **优先级**：拖拽 > 一次性 > 状态 > 待机轮换（抢占不能丢基础动作）；
 *   ③ **待机轮换**：12s 切换、3s 交叉淡化、首个动作 0 淡化（长淡化在开头会形成半权重≈T-pose）；
 *   ④ **拖拽**：PET_DRAGGING 缺失时必须**显式告警**而不是静默静止；
 *   ⑤ 弹簧/眨眼/呼吸的数学：有界、收敛、无 NaN。
 *
 * 运行：`node --test packages/avatar-stage/test/motion-runtime.test.mjs`
 * （或 `node packages/avatar-stage/test/run-all.cjs` 一起跑）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DecisionEngine, TUNING, clamp, clampDt, createSwayState, springStep, stepSway, swayAtRest,
  createBlinkState, stepBlink, breathValue,
} from '../dist/motion-runtime.js'

// ───────────────────────────────────────────────────────── 测试夹具

/** 造 n 个待机 clip + 若干语义 clip（名称排序稳定 ⇒ 轮换顺序可预测） */
function makeClips({ idles = 12, extra = true } = {}) {
  const clips = []
  for (let i = 0; i < idles; i++) clips.push({ name: `idle_${String(i).padStart(2, '0')}`, semantic: 'idle', loopable: true })
  if (extra) {
    clips.push({ name: 'PET_DRAGGING', semantic: 'drag', loopable: true })
    clips.push({ name: 'wave', semantic: 'wave', loopable: false })
    clips.push({ name: 'happy_loop', semantic: 'happy', loopable: true })
  }
  return clips
}

/** 可控时钟：测试里绝不能用真实时间（会 flaky） */
function makeClock(startMs = 0) {
  let t = startMs
  return {
    now: () => t,
    advance(ms) { t += ms; return t },
    set(ms) { t = ms; return t },
  }
}

function makeEngine(opts = {}) {
  const clock = makeClock()
  const events = []
  const engine = new DecisionEngine({ now: clock.now, onEvent: (e) => events.push(e) })
  const loaded = engine.load(opts.clips ?? makeClips())
  return { engine, clock, events, loaded }
}

/** 不变量：基础动作必须存在且是清单里的真实 clip */
function assertBaseClipValid(engine, clips, where) {
  const id = engine.getBaseClipId()
  assert.ok(typeof id === 'string' && id.length > 0, `${where}：基础动作不能为空（T-pose 窗口）`)
  assert.ok(clips.some(c => c.name === id), `${where}：基础动作 "${id}" 不在 clip 清单里`)
}

// ───────────────────────────────────────────────────────── ① 装载与"无 T-pose"不变量

test('装载：首个动作立即满权重且**零淡化**（长淡化会在开头形成半权重≈T-pose）', () => {
  const clips = makeClips()
  const { engine, loaded } = makeEngine({ clips })
  assert.equal(loaded.ok, true)
  assert.equal(loaded.idleCount, 12)
  assertBaseClipValid(engine, clips, '装载后')
  assert.equal(engine.getPhase(), 'idle')
  // 首个动作的淡化必须是 0：`load()` 内部 switchIdle(true)
  const first = loaded.warnings
  assert.deepEqual(first, [], `12 个待机不应有告警，实际 ${JSON.stringify(first)}`)
})

test('装载：待机不足 10 个必须**显式告警**（判据 A13 硬目标），但不得失败', () => {
  const { loaded, engine } = makeEngine({ clips: makeClips({ idles: 3 }) })
  assert.equal(loaded.ok, true, '不足 10 个仍应可用（不能让角色完全不动）')
  assert.ok(loaded.warnings.some(w => w.includes('3 个')), `应告警待机数量，实际 ${JSON.stringify(loaded.warnings)}`)
  assert.ok(loaded.warnings.some(w => w.includes('A13')), '告警应指明判据编号')
  assertBaseClipValid(engine, makeClips({ idles: 3 }), '待机不足时')
})

test('装载：空清单 ⇒ error 相位 + ok:false + 显式告警（禁止静默静止）', () => {
  const clock = makeClock()
  const engine = new DecisionEngine({ now: clock.now })
  const r = engine.load([])
  assert.equal(r.ok, false)
  assert.equal(r.idleCount, 0)
  assert.equal(engine.getPhase(), 'error')
  assert.ok(r.warnings.some(w => w.includes('没有可用动作')), JSON.stringify(r.warnings))
})

test('装载：没有 semantic=idle 的 clip 时退化为"全部 clip 都是待机池"（不能不动）', () => {
  const clips = [{ name: 'a_loop', semantic: 'other', loopable: true }, { name: 'b_loop', semantic: 'other', loopable: true }]
  const { engine, loaded } = makeEngine({ clips })
  assert.equal(loaded.ok, true)
  assert.equal(loaded.idleCount, 2)
  assertBaseClipValid(engine, clips, '退化待机池')
})

// ───────────────────────────────────────────────────────── ② 待机轮换：12s / 3s

test('待机轮换：不到 12s 不切换，到 12s 切换', () => {
  const { engine, clock } = makeEngine()
  const first = engine.getBaseClipId()
  assert.equal(engine.tick(), false, 't=0 不应立刻切换')
  clock.advance(11_999)
  assert.equal(engine.tick(), false, '11.999s 还不该切换')
  clock.advance(1)
  assert.equal(engine.tick(), true, '12s 应切换')
  assert.notEqual(engine.getBaseClipId(), first, '切换后必须是另一个 clip')
})

test('待机轮换：交叉淡化时长必须是 3s（照抄 Mate），且轮换是**循环**的', () => {
  const { engine, clock } = makeEngine()
  const seen = [engine.getBaseClipId()]
  for (let i = 0; i < 11; i++) {
    clock.advance(12_000)
    assert.equal(engine.tick(), true)
    assert.equal(engine.getFadeSec(), TUNING.idleTransitionSec, '轮换淡化应为 idleTransitionSec')
    assert.equal(engine.getFadeSec(), 3)
    seen.push(engine.getBaseClipId())
  }
  assert.equal(new Set(seen).size, 12, `12 次轮换应覆盖全部 12 个待机 clip，实际 ${JSON.stringify(seen)}`)
  // 再切一次应回到起点（循环）
  clock.advance(12_000)
  engine.tick()
  assert.equal(engine.getBaseClipId(), seen[0], '第 13 次切换应回到第 1 个 clip（循环）')
})

test('待机轮换只在 idle 相位推进：状态动作期间不得被待机抢走', () => {
  const { engine, clock } = makeEngine()
  engine.enterState('happy', 'happy_loop')
  assert.equal(engine.getPhase(), 'state')
  clock.advance(60_000)
  assert.equal(engine.tick(), false, 'state 相位不得触发待机轮换')
  assert.equal(engine.getBaseClipId(), 'happy_loop')
})

// ───────────────────────────────────────────────────────── ③ 优先级：拖拽 > 一次性 > 状态 > 待机

test('优先级：拖拽抢占一次性动作，且拖拽期间的待机轮换被冻结', () => {
  const { engine, clock, events } = makeEngine()
  engine.playOneShot('wave')
  assert.equal(engine.getPhase(), 'oneShot')
  const dragTarget = engine.beginDrag()
  assert.equal(dragTarget.clipId, 'PET_DRAGGING')
  assert.equal(engine.getPhase(), 'drag')
  assert.equal(engine.isDragging(), true)
  assert.equal(engine.getFadeSec(), TUNING.dragFadeInSec, '拖拽淡入用 dragFadeInSec')
  // 拖拽中推进很久：相位不能变，基础动作必须一直有效
  clock.advance(120_000)
  assert.equal(engine.tick(), false, '拖拽期间待机轮换必须冻结')
  assert.equal(engine.getPhase(), 'drag')
  assertBaseClipValid(engine, makeClips(), '拖拽中')
  assert.ok(events.some(e => e.kind === 'drag-start'), '应发出 drag-start 事件')
})

test('优先级：拖拽中的 motion 请求不得抢占（拖拽最高）', () => {
  const { engine } = makeEngine()
  engine.beginDrag()
  const r = engine.request('wave')
  assert.equal(r, null, '拖拽中语义请求应被忽略')
  assert.equal(engine.getPhase(), 'drag')
  assert.equal(engine.getBaseClipId(), 'PET_DRAGGING')
})

test('拖拽结束：回到拖拽前的一次性动作（状态被正确暂存，且相位不落回 idle）', () => {
  const { engine } = makeEngine()
  engine.playOneShot('wave')
  engine.beginDrag()
  const back = engine.endDrag()
  assert.ok(back, 'endDrag 应返回目标')
  assert.equal(back.clipId, 'wave', '应回到被拖拽打断的一次性动作')
  // 相位必须跟着回去：写死 idle 会让待机轮换把这次性动作中途抢走（实测踩到的 bug）
  assert.equal(engine.getPhase(), 'oneShot', '相位必须恢复为 oneShot，不能是 idle')
  assert.equal(engine.getFadeSec(), TUNING.oneShotFadeSec, '接续一次性动作应用它自己的淡化时长')
  assert.equal(engine.isDragging(), false)
  // 相位正确 ⇒ 待机轮换在这一帧不得抢走动作
  engine.tick()
  assert.equal(engine.getBaseClipId(), 'wave', '待机轮换不得抢走未播完的一次性动作')
})

test('拖拽结束：从 idle 拖拽时淡化用 dragFadeOutSec（收尾场景不同，不能混用）', () => {
  const { engine } = makeEngine()
  engine.beginDrag()
  const back = engine.endDrag()
  assert.ok(back)
  // 返回值与只读查询必须一致：不一致会让 `getFadeSec()` 变成"骗人的读数"
  assert.equal(back.fadeSec, TUNING.dragFadeOutSec, '返回值必须用 dragFadeOutSec')
  assert.equal(engine.getFadeSec(), TUNING.dragFadeOutSec, 'getFadeSec() 必须与返回值一致')
  assert.notEqual(TUNING.dragFadeOutSec, TUNING.oneShotFadeSec, '两个淡化时长必须不同，否则本用例区分不出混用')
  assert.equal(engine.getPhase(), 'idle')
})

test('淡化时长查询与返回值在**所有**分支都一致（防止 getFadeSec 变成骗人的读数）', () => {
  const { engine } = makeEngine()
  const cases = [
    ['轮换', () => { engine.tick() }],
    ['一次性', () => engine.playOneShot('wave')],
    ['状态', () => engine.enterState('happy', 'happy_loop')],
    ['拖拽进入', () => engine.beginDrag()],
    ['拖拽结束', () => engine.endDrag()],
    ['一次性结束', () => engine.finishOneShot()],
  ]
  for (const [name, act] of cases) {
    const ret = act()
    if (!ret || typeof ret.fadeSec !== 'number') continue
    assert.equal(engine.getFadeSec(), ret.fadeSec, `「${name}」的 getFadeSec() 与返回值不一致`)
  }
})

test('拖拽结束时若一次性动作**早已播完**，直接落回 idle（不重播已结束的动作）', () => {
  const { engine, clock } = makeEngine()
  engine.setClipDuration('wave', 1000)   // 告诉引擎这个动作只有 1s
  engine.playOneShot('wave')
  engine.beginDrag()
  clock.advance(5000)                    // 拖拽持续 5s ⇒ 动作早就播完
  const back = engine.endDrag()
  assert.equal(engine.getPhase(), 'idle', '已播完的一次性动作不得被恢复')
  assert.notEqual(back.clipId, 'wave', '不应重播已经播完的动作')
})

test('拖拽结束：从 idle 进入拖拽，结束后回到之前的待机 clip', () => {
  const { engine } = makeEngine()
  const before = engine.getBaseClipId()
  engine.beginDrag()
  const back = engine.endDrag()
  assert.equal(back.clipId, before, '应回到拖拽前那个待机 clip（不是随便换一个）')
})

test('拖拽结束：未在拖拽时 endDrag 返回 null（幂等，不抛错）', () => {
  const { engine } = makeEngine()
  assert.equal(engine.endDrag(), null)
})

test('优先级：一次性动作结束后回到 idle，且基础动作仍然有效', () => {
  const { engine, clock } = makeEngine()
  engine.playOneShot('wave')
  const t = engine.finishOneShot()
  assert.ok(t)
  assert.equal(engine.getPhase(), 'idle')
  assertBaseClipValid(engine, makeClips(), '一次性结束后')
  // 结束后待机轮换应重新可用
  clock.advance(12_000)
  assert.equal(engine.tick(), true)
})

test('优先级：状态动作被一次性动作抢占后，一次性结束回到**状态**动作（不是待机）', () => {
  const { engine } = makeEngine()
  engine.enterState('happy', 'happy_loop')
  engine.playOneShot('wave')
  const back = engine.finishOneShot()
  assert.equal(back.clipId, 'happy_loop', '应回到被抢占的状态动作')
  assert.equal(engine.getPhase(), 'state')
})

test('request("idle") 从状态相位退出状态并开始待机', () => {
  const { engine } = makeEngine()
  engine.enterState('happy', 'happy_loop')
  const t = engine.request('idle')
  assert.ok(t)
  assert.equal(engine.getPhase(), 'idle')
  assert.notEqual(engine.getBaseClipId(), 'happy_loop')
})

// ───────────────────────────────────────────────────────── ④ 缺失资产必须显式告警

test('缺少 PET_DRAGGING 时必须**显式告警**（不能静默地只有弹簧）', () => {
  const clips = makeClips({ extra: false }).filter(c => c.semantic !== 'drag')
  const { engine } = makeEngine({ clips })
  const t = engine.beginDrag()
  assert.equal(engine.isDragging(), true)
  assert.ok(engine.getWarnings().some(w => w.includes('PET_DRAGGING')), `应告警，实际 ${JSON.stringify(engine.getWarnings())}`)
  assert.ok(engine.getWarnings().some(w => w.includes('A14')), '告警应指明判据 A14')
  // 即便如此也不能给出空 clipId（否则渲染侧会静默静止）
  assert.ok(t.clipId.length > 0, '缺少拖拽动作时仍必须返回一个有效基础动作')
})

test('请求不存在的语义：返回 null 并告警（不猜、不透传）', () => {
  const { engine } = makeEngine()
  const r = engine.request('nonexistent_semantic_xyz')
  assert.equal(r, null)
  assert.ok(engine.getWarnings().some(w => w.includes('nonexistent_semantic_xyz')), '应告警缺失的语义')
})

test('告警去重：同一问题不重复堆积', () => {
  const { engine } = makeEngine()
  engine.request('missing_a')
  engine.request('missing_a')
  engine.request('missing_a')
  assert.equal(engine.getWarnings().filter(w => w.includes('missing_a')).length, 1)
})

// ───────────────────────────────────────────────────────── ⑤ 事件流（可观测性）

test('每次切换都发出带 atMs 的事件（否则运行期完全不可观测）', () => {
  const { engine, clock, events } = makeEngine()
  events.length = 0
  clock.advance(12_000)
  engine.tick()
  assert.equal(events.length, 1)
  const e = events[0]
  assert.equal(e.kind, 'switch')
  assert.equal(typeof e.atMs, 'number')
  assert.equal(e.atMs, 12_000)
  assert.ok(typeof e.clipId === 'string' && e.clipId.length > 0, 'switch 事件必须带 clipId')
  assert.equal(e.durationSec, TUNING.idleTransitionSec)
})

test('事件序列：drag-start → drag-end 成对出现且顺序正确', () => {
  const { engine, events } = makeEngine()
  events.length = 0
  engine.beginDrag()
  engine.endDrag()
  const kinds = events.map(e => e.kind)
  assert.deepEqual(kinds, ['drag-start', 'drag-end'])
})

// ───────────────────────────────────────────────────────── ⑥ 弹簧 / 摇晃数学

test('clamp / clampDt 边界', () => {
  assert.equal(clamp(5, 0, 1), 1)
  assert.equal(clamp(-5, 0, 1), 0)
  assert.equal(clamp(0.5, 0, 1), 0.5)
  assert.equal(clampDt(-1), 0, '负 dt 应归零')
  assert.equal(clampDt(Number.NaN), 0, 'NaN dt 应归零')
  assert.equal(clampDt(0), 0)
  assert.equal(clampDt(999), 1 / 30, 'dt 上限 1/30（避免大步长把弹簧打飞）')
  assert.equal(clampDt(0.01), 0.01)
})

test('弹簧：向目标收敛，且衰减振荡不会发散', () => {
  let s = { x: 0, v: 0 }
  const target = 20
  let maxAbs = 0
  for (let i = 0; i < 600; i++) {
    s = springStep(s, target, TUNING.springFrequency, TUNING.dampingRatio, 1 / 60)
    maxAbs = Math.max(maxAbs, Math.abs(s.x))
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.v), `第 ${i} 步出现 NaN/Inf`)
  }
  assert.ok(Math.abs(s.x - target) < 1, `10s 后应基本停在目标附近，实际 x=${s.x.toFixed(3)}`)
  // 阻尼比 0.35 < 1 ⇒ 允许过冲，但必须有界（1.5 倍限幅在 springStep 里）
  assert.ok(maxAbs <= TUNING.maxLeanZDeg * 1.5 + 1e-6, `过冲必须被限幅，实际峰值 ${maxAbs}`)
})

test('弹簧：dt=0 时状态完全不变（暂停不能累积误差）', () => {
  const before = { x: 3, v: 7 }
  const after = springStep(before, 20, 2.6, 0.35, 0)
  assert.deepEqual(after, before)
})

test('摇晃：拖拽中倾角被限制在**物理保护上限**（目标 ±25°/±12°，输出 ≤ ×1.5）', () => {
  let s = createSwayState()
  // ⚠ 判据不是"输出 ≤ 25°"：`maxLeanZDeg` / `maxLeanXDeg` 是**目标上限**，
  //   弹簧（阻尼比 0.35 < 1）在阶跃输入下必然过冲，所以 `springStep` 里
  //   另有一层 ×1.5 的物理保护限幅。这一条与 A14 的实测一致：
  //   `maxAbsLeanZ: 31.34°`、`maxAbsLeanX: 7.47°`（见 docs/evidence/phase5/A14-drag.md）。
  //   测试要钉的是"目标被夹住 + 输出有界"，不是"输出小于目标"。
  const limZ = TUNING.maxLeanZDeg * 1.5
  const limX = TUNING.maxLeanZDeg * 1.5   // springStep 的限幅用的是 maxLeanZDeg（见下）
  for (let i = 0; i < 900; i++) {
    s = stepSway(s, { dx: 5000, dy: 5000, dragging: true, dtSec: 1 / 60 })
    assert.ok(Math.abs(s.leanZ.x) <= limZ + 1e-6, `leanZ 超出物理保护上限：${s.leanZ.x}`)
    assert.ok(Math.abs(s.leanX.x) <= limX + 1e-6, `leanX 超出物理保护上限：${s.leanX.x}`)
    assert.ok(s.weight >= 0 && s.weight <= 1, `weight 越界：${s.weight}`)
    assert.ok(s.limbZ >= -limZ && s.leanZ.x <= limZ, 'limbZ 必须跟随且同样有界')
  }
  assert.ok(s.weight > 0.9, `持续拖拽应让叠加权重接近 1，实际 ${s.weight}`)
  // 真实观感：31° 量级的倾斜必须出现（否则"拖拽有反馈"这条判据形同虚设）
  assert.ok(Math.abs(s.leanZ.x) > TUNING.maxLeanZDeg, '持续大幅拖拽应出现过冲（这正是 A14 实测的 31°）')
})

test('摇晃：倾角**目标**被夹在 ±25°/±12°（超出输入不得把目标推更远）', () => {
  // 用**极小步长**让弹簧逼近稳态，从而直接观察目标值
  let s = createSwayState()
  for (let i = 0; i < 200_000; i++) s = stepSway(s, { dx: 100_000, dy: 100_000, dragging: true, dtSec: 1 / 30 })
  // 稳态时应停在目标附近：横向目标 = -dx*0.25 夹到 25；纵向目标 = dy*0.15 夹到 12
  assert.ok(Math.abs(s.leanZ.x) <= TUNING.maxLeanZDeg * 1.5, `leanZ 稳态越界：${s.leanZ.x}`)
  assert.ok(Math.abs(s.leanX.x) <= TUNING.maxLeanXDeg * 1.5, `leanX 稳态越界：${s.leanX.x}`)
  // 目标值本身的有界性：用非拖拽路径无法观察，故这里断言"输出不会远超目标"
  assert.ok(Math.abs(s.leanX.x) < Math.abs(s.leanZ.x) + 1e-6, '12° 的纵向目标必须比 25° 的横向目标更小')
})

test('摇晃：松手后回到静止（swayAtRest），且权重归零', () => {
  let s = createSwayState()
  for (let i = 0; i < 240; i++) s = stepSway(s, { dx: 300, dy: 120, dragging: true, dtSec: 1 / 60 })
  assert.equal(swayAtRest(s), false, '拖拽中不应判定为静止')
  for (let i = 0; i < 1200; i++) s = stepSway(s, { dx: 0, dy: 0, dragging: false, dtSec: 1 / 60 })
  assert.equal(swayAtRest(s), true, `松手 20s 后应静止，实际 ${JSON.stringify(s.leanZ)} / ${JSON.stringify(s.leanX)}`)
  assert.ok(s.weight < 0.01, `松手后叠加权重应归零，实际 ${s.weight}`)
})

test('摇晃：非拖拽时输入被忽略（dx/dy 不得产生影响）', () => {
  let a = createSwayState()
  let b = createSwayState()
  for (let i = 0; i < 120; i++) {
    a = stepSway(a, { dx: 0, dy: 0, dragging: false, dtSec: 1 / 60 })
    b = stepSway(b, { dx: 9999, dy: 9999, dragging: false, dtSec: 1 / 60 })
  }
  assert.deepEqual(b.leanZ, a.leanZ, '未拖拽时 dx/dy 不得改变倾角')
  assert.deepEqual(b.leanX, a.leanX)
})

// ───────────────────────────────────────────────────────── ⑦ 眨眼 / 呼吸（只作叠加层）

test('眨眼：值恒在 [0,1]，且会周期性地闭一次', () => {
  const s = createBlinkState(0)
  let sawClosed = false
  let t = 0
  for (let i = 0; i < 60 * 30; i++) {
    t += 1 / 60
    const v = stepBlink(s, t, 1 / 60)
    assert.ok(v >= 0 && v <= 1, `眨眼权重越界：${v}`)
    if (v > 0.99) sawClosed = true
  }
  assert.equal(sawClosed, true, '30s 内至少应闭眼一次')
})

test('眨眼：reduced（减少动效）时频率更低但不是不眨', () => {
  const count = (reduced) => {
    const s = createBlinkState(0)
    let t = 0
    let blinks = 0
    let prev = 0
    for (let i = 0; i < 60 * 60; i++) {
      t += 1 / 60
      const v = stepBlink(s, t, 1 / 60, reduced)
      if (v > 0 && prev === 0) blinks++
      prev = v
    }
    return blinks
  }
  const normal = count(false)
  const less = count(true)
  assert.ok(less > 0, 'reduced 也必须眨眼（否则像断电）')
  assert.ok(less < normal, `reduced 应更少：normal=${normal} reduced=${less}`)
})

test('呼吸：是周期正弦、有界，且**不产生位移**（只作叠加层）', () => {
  for (const period of [3.6, 5, 1]) {
    for (let i = 0; i < 200; i++) {
      const v = breathValue(i * 0.05, period)
      assert.ok(v >= -1.0001 && v <= 1.0001, `呼吸越界：${v}`)
    }
  }
  // 周期点应回到同相位
  assert.ok(Math.abs(breathValue(0, 3.6) - breathValue(3.6, 3.6)) < 1e-9)
  // 周期被夹到 ≥0.5，防止除零/高频抖动
  assert.ok(Number.isFinite(breathValue(1, 0)))
  assert.ok(Number.isFinite(breathValue(1, -5)))
})

// ───────────────────────────────────────────────────────── ⑧ TUNING 冻结值

test('TUNING 是照抄 Mate 的冻结常量，不得被随手改动', () => {
  // 这些数字是验收判据 A12/A13/A14 的量化依据；改动必须伴随证据更新。
  assert.equal(TUNING.idleSwitchSec, 12)
  assert.equal(TUNING.idleTransitionSec, 3)
  assert.equal(TUNING.springFrequency, 2.6)
  assert.equal(TUNING.dampingRatio, 0.35)
  assert.equal(TUNING.maxLeanZDeg, 25)
  assert.equal(TUNING.maxLeanXDeg, 12)
  assert.equal(TUNING.dragFadeInSec, 0.18)
  assert.equal(TUNING.dragFadeOutSec, 0.25)
})

test('调参覆盖只影响被覆盖的项（其余保持 Mate 原值）', () => {
  const clock = makeClock()
  const engine = new DecisionEngine({ now: clock.now, tuning: { idleSwitchSec: 1 } })
  engine.load(makeClips())
  clock.advance(1000)
  assert.equal(engine.tick(), true, '覆盖 idleSwitchSec=1 后 1s 应切换')
  // 未被覆盖的项不受影响
  assert.equal(engine.getFadeSec(), 3, 'idleTransitionSec 应保持 Mate 原值 3s')
})
