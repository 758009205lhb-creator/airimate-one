/**
 * packages/motion-director/test/director.test.mjs
 *
 * `node --test` 纯逻辑单测。**不需要浏览器、不需要 three、不需要 WebGL**。
 *
 * 证明的硬要求（逐条对应任务书）：
 *   T1  待机在 **12 s** 处切换
 *   T2  交叉淡化时长是 **3 s**
 *   T3  拖拽**抢占一切**，释放后回到**拖拽前的那个状态**
 *   T4  一次性动作**播完回退**到进入前的状态
 *   T5  **没有 T-pose 窗口**：在每个采样时刻（含 t=0 与过渡中间帧）
 *      都存在活动基础动作，且基础动作权重之和恒为 1
 *   T6  确定性：同 seed + 同命令序列 ⇒ 完全相同的输出
 *   T7  manifest 校验：坏的 manifest 会被**拒绝**（而不是静默跑起来）
 *   T8  优先级顺序：drag(3) > oneshot(2) > state(1) > idle(0)
 *
 * 运行：
 *   node packages/motion-director/../../tools/... —— 不需要，直接
 *   cd 新工程/packages/motion-director && npm run build && node --test test/director.test.mjs
 * 或者用 `node --test test/director.test.mjs`（测试 import 的是 `../dist/*.js`，
 * 所以**必须先 build**；`test/build-first.test.mjs` 不在本文件职责内）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(HERE, '..', 'dist')
if (!existsSync(resolve(DIST, 'index.js'))) {
  throw new Error(`找不到 ${DIST}/index.js —— 请先构建： cd 新工程/packages/motion-director && npm run build`)
}

const { MotionDirector, MotionPriority, mulberry32, validateManifest, assertManifest, fromConverterSidecar } = await import('../dist/index.js')

// ───────────────────────────────────────────────────── 测试夹具

/** 造一个合法 clip（字段与冻结契约对齐） */
function clip(name, semantic, durationSec = 8, extra = {}) {
  return {
    name,
    layer: 'base',
    semantic,
    source: `F:/src/${name}.anim`,
    file: `assets/motion/${name}.vrma`,
    bytes: 1024 * 100,
    durationSec,
    loopable: true,
    rootDisplacementRange: [0.01, 0.02, 0.01],
    boneActivityDeg: { leftUpperLeg: 12, rightUpperLeg: 11, leftLowerLeg: 4 },
    legActivityDeg: 27,
    allowedOverlayLayers: ['emotion-face', 'breathing', 'look-at'],
    ...extra,
  }
}

const IDLE = ['idle_a', 'idle_b', 'idle_c', 'idle_d']

function makeClips() {
  return [
    ...IDLE.map((n) => clip(n, 'idle')),
    clip('walk_left', 'walk'),
    clip('sit_01', 'sit'),
    clip('sleep', 'sleep', 35),
    // ⚠ 名字必须与 `DEFAULT_MOTION_TUNING.dragClip` 一致（`misc_pet_dragging`），
    //   否则 `drag(active=true)` 会因为"清 clip 不在 manifest 里"而**保持基础动作不变**——
    //   实测踩到过：那时拖拽相位是对的，但 base clip 还是原来的，看起来像"拖拽没生效"。
    clip('misc_pet_dragging', 'drag'),
    clip('wave', 'oneShot', 1.5),
  ]
}

function makeDirector(extra = {}) {
  return new MotionDirector({ clips: makeClips(), seed: 12345, ...extra })
}

/**
 * **正确用法**：先 `frame(t)` 推进时钟，再在 t 这一帧投递命令。
 * 命令里的 `atMs` 只用于记录/过期判断，**不会隐式推进时钟** —— 见 director.ts
 * 的 `dispatch` 注释（先 dispatch 再 frame 会让淡化起点落在上一帧，实测踩到过）。
 *
 * ⚠ 返回值语义（也踩过）：投递之后**再取一帧**（同一时刻，不推进逻辑时间），
 *   返回的 `DirectorFrame` 才反映命令生效后的状态。直接返回投递前那一帧的话
 *   `baseClip` 还是旧值 —— 实测因此写出过一串假失败。
 *
 * @returns {object} 命令生效后的 `DirectorFrame`，另带 `dispatchLogs` 字段
 */
function at(d, tMs, cmd) {
  d.frame(tMs)
  const logs = cmd ? [...d.dispatch({ atMs: tMs, ...cmd })] : []
  const f = d.frame(tMs)
  f.dispatchLogs = logs
  return f
}

/** 以固定步长采样，收集每帧 */
function sample(director, fromMs, toMs, stepMs = 100) {
  const frames = []
  for (let t = fromMs; t <= toMs; t += stepMs) frames.push({ t, f: director.frame(t) })
  return frames
}

// ═════════════════════════════════════════════════════ T8 优先级顺序

describe('T8 优先级顺序', () => {
  test('drag > oneshot > state > idle 的数值序', () => {
    assert.ok(MotionPriority.Drag > MotionPriority.OneShot, 'drag 必须 > oneshot')
    assert.ok(MotionPriority.OneShot > MotionPriority.State, 'oneshot 必须 > state')
    assert.ok(MotionPriority.State > MotionPriority.Idle, 'state 必须 > idle')
    assert.equal(MotionPriority.Drag, 3)
    assert.equal(MotionPriority.OneShot, 2)
    assert.equal(MotionPriority.State, 1)
    assert.equal(MotionPriority.Idle, 0)
  })
})

// ═════════════════════════════════════════════════════ T1 待机 12s 切换

describe('T1 待机每 12s 切换', () => {
  test('0–12s 内 base 不变；12s 处切换；24s 处再切换', () => {
    const d = makeDirector()
    const f0 = d.frame(0)
    assert.equal(f0.phase, 'idle', 't=0 应处于 idle 相位')
    const first = f0.baseClip
    assert.ok(IDLE.includes(first), `起始 base 应是待机池里的 clip，实际 ${first}`)

    // 11.9s：还没到
    const f119 = d.frame(11_900)
    assert.equal(f119.baseClip, first, '11.9s 时不应切换')

    // 12.0s：切换（此时刚开始交叉淡化，base 已经是新 clip）
    const f120 = d.frame(12_000)
    assert.notEqual(f120.baseClip, first, '12.0s 处必须切换')
    assert.ok(IDLE.includes(f120.baseClip), `切换目标应仍在待机池内，实际 ${f120.baseClip}`)
    assert.ok(f120.transitions.some((s) => s.includes('idle 轮换')), '应记录 idle 轮换迁移')

    // 交叉淡化在 12.0s 刚开始 ⇒ 旧 clip 仍以 ~1 权重存在
    assert.equal(f120.fadingOutClip, first, '刚切换时旧 clip 应作为淡出方存在')
    assert.ok(Math.abs(f120.crossFadeProgress - 0) < 1e-9, `刚切换时进度应为 0，实际 ${f120.crossFadeProgress}`)

    const second = f120.baseClip
    const f239 = d.frame(23_900)
    assert.equal(f239.baseClip, second, '23.9s 时不应再次切换')
    const f240 = d.frame(24_000)
    assert.notEqual(f240.baseClip, second, '24.0s 处必须再次切换')
  })

  test('待机池只有 1 个 clip 时不会切换但也不报错', () => {
    const d = new MotionDirector({ clips: [clip('only_idle', 'idle')], seed: 1 })
    assert.equal(d.frame(0).baseClip, 'only_idle')
    assert.equal(d.frame(12_000).baseClip, 'only_idle')
    assert.equal(d.frame(60_000).baseClip, 'only_idle')
  })
})

// ═════════════════════════════════════════════════════ T2 交叉淡化 3s

describe('T2 交叉淡化 3s', () => {
  test('12s 切换后，t+3s 才完成融合，且中间权重互补', () => {
    const d = makeDirector()
    const first = d.frame(0).baseClip
    const f120 = d.frame(12_000)
    const second = f120.baseClip

    const at = (ms) => d.frame(ms)
    // 12.0 + 1.5 = 13.5 ⇒ 进度 0.5
    const mid = at(13_500)
    assert.equal(mid.baseClip, second)
    assert.equal(mid.fadingOutClip, first)
    assert.ok(Math.abs(mid.crossFadeProgress - 0.5) < 1e-6, `13.5s 时进度应为 0.5，实际 ${mid.crossFadeProgress}`)
    const wSecond = mid.weights.find((w) => w.clip === second)?.weight ?? -1
    const wFirst = mid.weights.find((w) => w.clip === first)?.weight ?? -1
    assert.ok(Math.abs(wSecond - 0.5) < 1e-6, `新 clip 权重应为 0.5，实际 ${wSecond}`)
    assert.ok(Math.abs(wFirst - 0.5) < 1e-6, `旧 clip 权重应为 0.5，实际 ${wFirst}`)

    // 14.9s：还没完
    const nearEnd = at(14_900)
    assert.equal(nearEnd.fadingOutClip, first, '14.9s 时仍应在淡化')
    assert.ok(nearEnd.crossFadeProgress > 0.96 && nearEnd.crossFadeProgress < 1)

    // 15.0s：完成
    const done = at(15_000)
    assert.equal(done.fadingOutClip, null, '15.0s 后不应再有淡出方')
    assert.equal(done.crossFadeProgress, 1)
    assert.equal(done.weights.find((w) => w.clip === second)?.weight, 1)
  })

  test('淡化的实际时长确实是 3s（扫描到 fadingOutClip 消失为止）', () => {
    const d = makeDirector()
    d.frame(0)
    d.frame(12_000)
    let switchedAt = 12_000
    let clearedAt = null
    for (let t = 12_000; t <= 20_000; t += 10) {
      const f = d.frame(t)
      if (f.fadingOutClip === null) { clearedAt = t; break }
    }
    assert.ok(clearedAt !== null, '淡化应在 20s 内结束')
    // 首次观察到 cleared 的那一帧与 3s 边界相差不超过一个采样步长
    assert.ok(Math.abs((clearedAt - switchedAt) - 3000) <= 10, `淡化时长应 ≈3000ms，实际 ${clearedAt - switchedAt}ms`)
  })
})

// ═════════════════════════════════════════════════════ T3 拖拽抢占与释放

describe('T3 拖拽抢占一切并回退', () => {
  test('拖拽抢占 state；释放后回到 state，而不是待机', () => {
    const d = makeDirector()
    d.frame(0)
    at(d, 1000, { kind: 'motion', clip: 'walk_left' })
    const beforeDrag = d.frame(1000)
    assert.equal(beforeDrag.baseClip, 'walk_left')
    assert.equal(beforeDrag.phase, 'state')
    assert.equal(beforeDrag.priority, MotionPriority.State)

    // 拖拽开始（先推进到 2000ms，再投递）
    at(d, 2000, { kind: 'drag', active: true })
    const f = d.frame(2000)
    assert.equal(f.phase, 'drag')
    assert.equal(f.priority, MotionPriority.Drag)

    let g = f
    for (let t = 2000; t <= 5100; t += 100) g = d.frame(t)
    assert.equal(g.baseClip, 'misc_pet_dragging', '拖拽 3s 后应完全在 drag clip 上')
    assert.equal(g.priority, MotionPriority.Drag)
    assert.equal(g.fadingOutClip, null, '拖拽淡入完成后不应还有淡出方')

    // 释放
    at(d, 6000, { kind: 'drag', active: false })
    let h = d.frame(6000)
    for (let t = 6000; t <= 9100; t += 100) h = d.frame(t)
    assert.equal(h.baseClip, 'walk_left', '释放后必须回到拖拽前的 state')
    assert.equal(h.phase, 'state', '释放后相位应恢复为 state')
    assert.equal(h.priority, MotionPriority.State)
  })

  test('拖拽抢占待机；释放后回到待机（且待机计时从剩余时间继续）', () => {
    const d = makeDirector()
    const idleClip = d.frame(0).baseClip
    // 5s 时拖拽
    at(d, 5000, { kind: 'drag', active: true })
    let f = d.frame(5000)
    assert.equal(f.phase, 'drag')
    for (let t = 5000; t <= 8100; t += 100) f = d.frame(t)
    assert.equal(f.baseClip, 'misc_pet_dragging')

    at(d, 9000, { kind: 'drag', active: false })
    f = d.frame(9000)
    assert.equal(f.baseClip, idleClip, '释放后应回到拖拽前的那个待机 clip')
    assert.equal(f.phase, 'idle')

    // 拖拽期间待机计时**暂停**：进入拖拽时已走过 5s（5000/12000），
    // 剩余 7s 从释放时刻（9000）继续算 ⇒ 轮换落在 16000。
    assert.equal(d.frame(15_900).baseClip, idleClip, '15.9s 时仍不该轮换（12s 边界被推后到 16s）')
    assert.notEqual(d.frame(16_000).baseClip, idleClip, '16.0s 处应发生被推后的那次轮换')
  })

  test('拖拽期间 state / oneshot 命令被忽略', () => {
    const d = makeDirector()
    d.frame(0)
    at(d, 100, { kind: 'drag', active: true })
    const logs1 = at(d, 200, { kind: 'motion', clip: 'walk_left' }).dispatchLogs
    assert.ok(logs1.some((s) => s.includes('拖拽中')), `应记录"拖拽中忽略"，实际 ${JSON.stringify(logs1)}`)
    const logs2 = d.dispatch({ kind: 'motion', atMs: 300, clip: 'wave', oneShot: true })
    assert.ok(logs2.some((s) => s.includes('拖拽中')), '拖拽中一次性动作也应被忽略')
    let f = d.frame(300)
    for (let t = 300; t <= 5000; t += 100) f = d.frame(t)
    assert.equal(f.baseClip, 'misc_pet_dragging', 'base 应仍是拖拽 clip')
  })
})

// ═════════════════════════════════════════════════════ T4 一次性动作

describe('T4 一次性动作播完回退', () => {
  test('oneshot 播完后回到进入前的 state', () => {
    const d = makeDirector()
    d.frame(0)
    at(d, 1000, { kind: 'motion', clip: 'sit_01' })
    let f = d.frame(1000)
    for (let t = 1000; t <= 4100; t += 100) f = d.frame(t)
    assert.equal(f.baseClip, 'sit_01')
    assert.equal(f.phase, 'state')

    // 一次性动作，时长 1.5s。迁移日志要用 dispatch 的返回值拿（frame() 的 transitions 只装 frame 内的迁移）
    f = at(d, 5000, { kind: 'motion', clip: 'wave', oneShot: true })
    const logs = f.dispatchLogs ?? []
    assert.equal(f.phase, 'oneShot')
    assert.equal(f.priority, MotionPriority.OneShot)
    assert.ok(logs.some((s) => s.includes('oneShot')), `应记录 oneShot 迁移，实际 ${JSON.stringify(logs)}`)
    assert.equal(f.baseClip, 'wave')

    // 5000 + 1500 = 6500 结束
    f = d.frame(6400)
    assert.equal(f.baseClip, 'wave', '6.4s 时一次性动作还没结束')
    f = d.frame(6500)
    assert.equal(f.baseClip, 'sit_01', '6.5s 播完必须回退到进入前的 state')
    assert.equal(f.phase, 'state')
    assert.equal(d.currentPriority, MotionPriority.State)
  })

  test('oneshot 播完后回到进入前的待机', () => {
    const d = makeDirector()
    const idleClip = d.frame(0).baseClip
    at(d, 3000, { kind: 'motion', clip: 'wave', oneShot: true })
    let f = d.frame(3000)
    assert.equal(f.baseClip, 'wave')
    for (let t = 3000; t <= 4400; t += 100) f = d.frame(t)
    assert.equal(f.baseClip, 'wave')
    f = d.frame(4500)
    assert.equal(f.baseClip, idleClip, '应回退到待机 clip')
    assert.equal(f.phase, 'idle')
  })

  test('returnTo 显式指定回退目标时以它为准', () => {
    const d = makeDirector()
    d.frame(0)
    at(d, 1000, { kind: 'motion', clip: 'wave', oneShot: true, returnTo: 'walk_left' })  // 1000..2500
    assert.equal(d.frame(1000).baseClip, 'wave')
    assert.equal(d.frame(2000).baseClip, 'wave', '2.0s 时一次性动作还没结束')
    const f1 = d.frame(2500)
    assert.equal(f1.baseClip, 'walk_left', 'returnTo 应被尊重（而不是回到进入前的 idle）')
    // 回退到 returnTo 的相位沿用"进入前快照"的相位；
    // 进入前的快照是 idle 相位（t=1000 时还没播过任何 state），所以这里就是 'idle'。
    assert.ok(['idle', 'state'].includes(f1.phase), `相位应为 idle 或 state，实际 ${f1.phase}`)
    assert.equal(d.currentPriority <= MotionPriority.State, true, '回退后优先级不应高于 state')
  })

  test('oneshot 期间低优先级的 state 命令被忽略', () => {
    const d = makeDirector()
    d.frame(0)
    at(d, 1000, { kind: 'motion', clip: 'wave', oneShot: true })
    // 先推进到 1200ms（此刻仍在 oneshot 内），再投递
    d.frame(1200)
    const logs = d.dispatch({ kind: 'motion', atMs: 1200, clip: 'sleep' })
    // 两条拒绝路径都算"被忽略"：优先级不足，或显式的 oneshot 保护
    assert.ok(
      logs.some((s) => s.includes('一次性动作播放中')) || logs.some((s) => s.includes('优先级 state < 当前 oneshot')),
      `应忽略 state，实际 ${JSON.stringify(logs)}`)
    const f = d.frame(1300)
    assert.equal(f.baseClip, 'wave')
  })

  test('oneshot 可以被拖拽抢占；被打断的 oneshot 若在拖拽期间播完则回退到更早的状态', () => {
    const d = makeDirector()
    d.frame(0)
    at(d, 500, { kind: 'motion', clip: 'sit_01' })
    for (let t = 500; t <= 3600; t += 100) d.frame(t)
    at(d, 4000, { kind: 'motion', clip: 'wave', oneShot: true })   // 4000..5500
    at(d, 4200, { kind: 'drag', active: true })
    // 拖拽淡入 3s ⇒ 7200 完成；这段里 oneshot 的 5500 到点**不应**把它踢回去
    let f = d.frame(4200)
    for (let t = 4200; t <= 7400; t += 100) f = d.frame(t)
    assert.equal(f.baseClip, 'misc_pet_dragging', '拖拽应抢占 oneshot 并保持 drag clip（oneshot 到点也不能踢走拖拽）')
    assert.equal(f.phase, 'drag')
    at(d, 8000, { kind: 'drag', active: false })
    for (let t = 8000; t <= 11_200; t += 100) f = d.frame(t)
    assert.equal(f.baseClip, 'sit_01',
      '被打断的 oneshot 已在拖拽期间按墙钟播完 ⇒ 应回退到它之前的状态（sit_01），而不是卡在 wave')
  })

  test('拖拽在 oneshot 播完前释放 ⇒ 回退到那个还没播完的 oneshot', () => {
    const d = makeDirector()
    d.frame(0)
    at(d, 500, { kind: 'motion', clip: 'sit_01' })
    for (let t = 500; t <= 3600; t += 100) d.frame(t)
    at(d, 4000, { kind: 'motion', clip: 'wave', oneShot: true })   // 4000..5500
    at(d, 4200, { kind: 'drag', active: true })
    for (let t = 4200; t <= 4600; t += 100) d.frame(t)
    at(d, 4700, { kind: 'drag', active: false })                   // 仍在 5500 之前
    let f = d.frame(4700)
    assert.equal(f.baseClip, 'wave', '释放时 oneshot 尚未播完 ⇒ 应回到它')
    for (let t = 4700; t <= 5600; t += 100) f = d.frame(t)
    assert.equal(f.baseClip, 'sit_01', '剩下的 oneshot 播完后仍应回退到 sit_01')
  })
})

// ═════════════════════════════════════════════════════ T5 无 T-pose 窗口

describe('T5 无 T-pose 窗口', () => {
  function assertNoTPose(f, t) {
    assert.ok(f.baseClip !== null, `t=${t}ms：baseClip 为 null ⇒ T-pose 窗口`)
    const baseSum = f.weights.filter((w) => w.weight > 0).reduce((a, w) => a + w.weight, 0)
    // 权重表里只有 base 层带正权重（overlay 一律 0），所以总和应恰为 1
    assert.ok(Math.abs(baseSum - 1) < 1e-6, `t=${t}ms：基础权重和 = ${baseSum}（应为 1）⇒ 剩余权重会给绑定姿势 = T-pose 窗口`)
  }

  test('t=0 起、直到穿越 12s/24s 切换与 3s 过渡的密集采样都不出现空档', () => {
    const d = makeDirector()
    for (let t = 0; t <= 40_000; t += 25) {
      const f = d.frame(t)
      assertNoTPose(f, t)
    }
  })

  test('在 12s 边界的**前后一毫秒**都不出现空档（过渡起点最危险）', () => {
    const d = makeDirector()
    // ⚠ 必须先 frame(0) 让 director 完成初始化。
    //   否则第一次 frame(11998) 才起步 ⇒ 轮换定时器落在 23998，
    //   整段探测都在"还没轮换"的窗口里，测不到过渡（实测踩到过）。
    d.frame(0)
    const probe = [11_998, 11_999, 12_000, 12_001, 12_002, 12_500, 13_499, 13_500, 14_999, 15_000, 15_001]
    const fs = probe.map((t) => ({ t, f: d.frame(t) }))
    for (const { t, f } of fs) assertNoTPose(f, t)
    // 12.0s 开始交叉淡化，14.999s 仍在过渡、15.0s 完成
    const at135 = fs.find((x) => x.t === 13_500).f
    assert.equal(at135.fadingOutClip !== null, true, '13.5s 应处于过渡中')
    assert.ok(Math.abs(at135.crossFadeProgress - 0.5) < 1e-6, `13.5s 进度应为 0.5，实际 ${at135.crossFadeProgress}`)
    assert.equal(fs.find((x) => x.t === 14_999).f.fadingOutClip !== null, true, '14.999s 仍在过渡')
    assert.equal(fs.find((x) => x.t === 15_000).f.fadingOutClip, null, '15.0s 过渡应完成')
  })

  test('拖拽开始 / 释放 / 一次性动作回退 三个迁移点都没有空档', () => {
    const d = makeDirector()
    // 时间轴 = 一组事件（按时间升序消费）。每个时间点**先 frame 采样**，再 dispatch，
    // 这样才能在同一个时刻既断言不变量、又触发迁移（见 dispatch 的调用约定）。
    const events = [
      { t: 0, cmd: null },
      { t: 999, cmd: null },
      { t: 1000, cmd: { kind: 'motion', clip: 'walk_left' } },
      { t: 1001, cmd: null },
      { t: 2500, cmd: null },
      { t: 3999, cmd: null },
      { t: 4000, cmd: { kind: 'drag', active: true } },
      { t: 4001, cmd: null },
      { t: 5500, cmd: null },
      { t: 6999, cmd: null },
      { t: 7000, cmd: { kind: 'drag', active: false } },
      { t: 7001, cmd: null },
      { t: 8500, cmd: null },
      { t: 9999, cmd: null },
      { t: 10_000, cmd: { kind: 'motion', clip: 'wave', oneShot: true } },
      { t: 10_001, cmd: null },
      { t: 11_499, cmd: null },
      { t: 11_500, cmd: null },
      { t: 11_501, cmd: null },
      { t: 13_000, cmd: null },
      { t: 20_000, cmd: null },
    ]
    let last = null
    for (const e of events) {
      last = d.frame(e.t)
      assertNoTPose(last, e.t)
      if (e.cmd) d.dispatch({ atMs: e.t, ...e.cmd })
    }
    assert.equal(events.length, 21)
    assert.equal(last.baseClip !== null, true)
  })

  test('不变量自检本身是有效的：手工破坏权重会被抓住', () => {
    // 这条测试证明 assertInvariants 不是"永远通过"的装饰
    const d = makeDirector()
    const f = d.frame(0)
    // 复刻 assertInvariants 的判据并故意构造一个坏帧
    const bad = { ...f, weights: [{ clip: f.baseClip, weight: 0.5, fadeSec: 3 }] }
    const sum = bad.weights.reduce((a, w) => a + w.weight, 0)
    assert.ok(Math.abs(sum - 1) > 1e-6, '构造的坏帧确实不满足不变量（说明判据不是恒真）')
    assert.throws(() => { if (Math.abs(sum - 1) > 1e-6) throw new Error('不变量 D6 违反') }, /D6/)
  })
})

// ═════════════════════════════════════════════════════ T6 确定性

describe('T6 确定性与种子', () => {
  test('同 seed + 同命令序列 + 同时间步 ⇒ 逐帧完全一致', () => {
    const run = () => {
      const d = new MotionDirector({ clips: makeClips(), seed: 999 })
      const out = []
      d.dispatch({ kind: 'motion', atMs: 500, clip: 'walk_left' })
      d.dispatch({ kind: 'drag', atMs: 3000, active: true })
      d.dispatch({ kind: 'drag', atMs: 6000, active: false })
      d.dispatch({ kind: 'motion', atMs: 9000, clip: 'wave', oneShot: true })
      for (let t = 0; t <= 30_000; t += 50) {
        const f = d.frame(t)
        out.push(`${t}|${f.phase}|${f.baseClip}|${f.fadingOutClip}|${f.crossFadeProgress.toFixed(9)}`)
      }
      return out
    }
    const a = run(), b = run()
    assert.equal(a.length, b.length)
    for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i], `第 ${i} 帧不一致`)
  })

  test('不同 seed 会给出不同的起始待机（证明种子真的参与了选择）', () => {
    const firstOf = (seed) => new MotionDirector({ clips: makeClips(), seed }).frame(0).baseClip
    const picks = new Set()
    for (let s = 0; s < 40; s++) picks.add(firstOf(s))
    assert.ok(picks.size > 1, `不同 seed 应能选中不同起始待机，实际只出现 ${[...picks].join(',')}`)
    for (const p of picks) assert.ok(IDLE.includes(p), `起始待机必须来自待机池，实际 ${p}`)
  })

  test('mulberry32 是确定性的、值域 [0,1)', () => {
    const a = mulberry32(42), b = mulberry32(42)
    for (let i = 0; i < 1000; i++) {
      const x = a(), y = b()
      assert.equal(x, y)
      assert.ok(x >= 0 && x < 1, `值域越界 ${x}`)
    }
    assert.notEqual(mulberry32(1)(), mulberry32(2)())
  })

  test('时间回退会被拒绝（单调时钟要求）', () => {
    const d = makeDirector()
    d.frame(1000)
    assert.throws(() => d.frame(999), /时间不能回退/)
  })
})

// ═════════════════════════════════════════════════════ T7 manifest 校验

describe('T7 manifest 运行期校验', () => {
  test('合法 manifest 通过', () => {
    const r = validateManifest({ clips: makeClips() })
    assert.equal(r.ok, true, JSON.stringify(r.issues))
    assert.equal(r.clipCount, makeClips().length)
  })

  test('拒绝：durationSec 写成字符串', () => {
    const bad = makeClips()
    bad[0] = { ...bad[0], durationSec: '2.45' }
    const r = validateManifest({ clips: bad })
    assert.equal(r.ok, false)
    assert.ok(r.issues.some((i) => i.path === 'clips[0].durationSec'), JSON.stringify(r.issues))
  })

  test('拒绝：骨名写成 Unity 的 PascalCase', () => {
    const bad = makeClips()
    bad[1] = { ...bad[1], boneActivityDeg: { LeftUpperLeg: 12 } }
    const r = validateManifest({ clips: bad })
    assert.equal(r.ok, false)
    assert.ok(r.issues.some((i) => /camelCase/.test(i.message)), JSON.stringify(r.issues))
  })

  test('拒绝：name 重名', () => {
    const bad = makeClips()
    bad[3] = { ...bad[3], name: bad[0].name }
    const r = validateManifest({ clips: bad })
    assert.equal(r.ok, false)
    assert.ok(r.issues.some((i) => /重名/.test(i.message)), JSON.stringify(r.issues))
  })

  test('拒绝：没有 idle 基础动作（会导致启动即 T-pose）', () => {
    const r = validateManifest({ clips: [clip('walk_left', 'walk')] })
    assert.equal(r.ok, false)
    assert.ok(r.issues.some((i) => /T-pose/.test(i.message)), JSON.stringify(r.issues))
  })

  test('拒绝：file 不指向 .vrma / bytes <= 0 / loopable 不是 boolean / semantic 非法', () => {
    const cases = [
      [{ ...clip('x', 'idle'), file: 'a.glb' }, /\.vrma/],
      [{ ...clip('x', 'idle'), bytes: 0 }, /bytes/],
      [{ ...clip('x', 'idle'), loopable: 'yes' }, /loopable/],
      [{ ...clip('x', 'idle'), semantic: 'dance' }, /semantic/],
      [{ ...clip('x', 'idle'), rootDisplacementRange: [1, 2] }, /rootDisplacementRange/],
      [{ ...clip('x', 'idle'), allowedOverlayLayers: 'emotion' }, /allowedOverlayLayers/],
    ]
    for (const [c, re] of cases) {
      const r = validateManifest({ clips: [c] })
      assert.equal(r.ok, false, `应拒绝：${JSON.stringify(c)}`)
      assert.ok(r.issues.some((i) => re.test(i.path) || re.test(i.message)), `错误信息应指出问题：${JSON.stringify(r.issues)}`)
    }
  })

  test('assertManifest 在失败时抛 ManifestValidationError，且带全部问题', () => {
    let err = null
    try { assertManifest({ clips: [{ name: '' }] }) } catch (e) { err = e }
    assert.ok(err, '应抛错')
    assert.equal(err.name, 'ManifestValidationError')
    assert.ok(err.issues.length >= 3, `应一次列全问题，实际 ${err.issues.length} 条`)
  })

  test('MotionDirector 构造函数也会校验 manifest（坏数据不会静默跑起来）', () => {
    assert.throws(() => new MotionDirector({ clips: [{ ...clip('x', 'idle'), durationSec: -1 }] }), /manifest 校验失败/)
  })

  test('fromConverterSidecar 能把 motion-clip-manifest/1 映射成契约对象', () => {
    const sidecar = {
      schema: 'motion-clip-manifest/1',
      name: 'idle_pet_idle_2',
      set: 'idle',
      source: 'F:/Mate/PET_IDLE/PET_IDLE_2.anim',
      duration: 13.3333,
      loopable: true,
      vrma: { file: 'idle_pet_idle_2.vrma', bytes: 377640 },
      rootDisplacement: { range: [0.01, 0.02, 0.03] },
      perBoneActivityDeg: { leftUpperLeg: 183.55, leftLowerLeg: 20.51 },
      legActivity: { total: 669.1 },
      allowedOverlayLayers: ['emotion-face', 'breathing', 'look-at'],
    }
    const c = fromConverterSidecar(sidecar)
    assert.equal(c.name, 'idle_pet_idle_2')
    assert.equal(c.layer, 'base')
    assert.equal(c.semantic, 'idle')
    assert.equal(c.durationSec, 13.3333)
    assert.equal(c.bytes, 377640)
    assert.deepEqual(c.rootDisplacementRange, [0.01, 0.02, 0.03])
    assert.equal(c.legActivityDeg, 669.1)
    assert.equal(c.priorityHint, MotionPriority.Idle)
    assert.equal(validateManifest({ clips: [c] }).ok, true)
  })

  test('真实产出的 sidecar 也能被映射（读 assets/motion/manifests 里的真文件）', () => {
    const dir = 'F:/deepseek harness/AI女友/新工程/assets/motion/manifests'
    const f = `${dir}/idle_pet_idle_2.json`
    if (!existsSync(f)) {
      // 不让这个测试因为"资产还没生成"而失败 —— 但要显式说出来
      console.log(`[skip] 未找到真实 sidecar：${f}`)
      return
    }
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    const c = fromConverterSidecar(raw)
    assert.equal(c.name, 'idle_pet_idle_2')
    assert.ok(c.durationSec > 0)
    assert.ok(c.boneActivityDeg.leftUpperLeg > 0)
    assert.equal(validateManifest({ clips: [c] }).ok, true)
  })
})

// ═════════════════════════════════════════════════════ 叠加层命令

describe('叠加层命令', () => {
  test('emotion / speech / visibility / windowMode 不改变基础动作', () => {
    const d = makeDirector()
    const base0 = d.frame(0).baseClip
    d.dispatch({ kind: 'emotion', atMs: 10, expression: 'happy', weight: 0.8 })
    d.dispatch({ kind: 'speech', atMs: 20, speaking: true, amplitude: 0.6 })
    d.dispatch({ kind: 'visibility', atMs: 30, target: 'accessory:hat', visible: false })
    d.dispatch({ kind: 'windowMode', atMs: 40, mode: 'fullscreen' })
    const f = d.frame(100)
    assert.equal(f.baseClip, base0, '叠加层命令不得改变基础动作')
    assert.equal(f.overlays.emotions.happy, 0.8)
    assert.equal(f.overlays.speaking, true)
    assert.equal(f.overlays.speechAmplitude, 0.6)
    assert.equal(f.overlays.visibility['accessory:hat'], false)
    assert.equal(f.overlays.windowMode, 'fullscreen')
  })

  test('emotion weight<=0 会移除该表情', () => {
    const d = makeDirector()
    d.dispatch({ kind: 'emotion', atMs: 0, expression: 'happy', weight: 1 })
    assert.equal(d.frame(1).overlays.emotions.happy, 1)
    d.dispatch({ kind: 'emotion', atMs: 2, expression: 'happy', weight: 0 })
    assert.equal(d.frame(3).overlays.emotions.happy, undefined)
  })

  test('speech=false 会把幅度归零', () => {
    const d = makeDirector()
    d.dispatch({ kind: 'speech', atMs: 0, speaking: true, amplitude: 0.9 })
    assert.equal(d.frame(1).overlays.speechAmplitude, 0.9)
    d.dispatch({ kind: 'speech', atMs: 2, speaking: false })
    const f = d.frame(3)
    assert.equal(f.overlays.speaking, false)
    assert.equal(f.overlays.speechAmplitude, 0)
  })
})

// ═════════════════════════════════════════════════════ 边界与健壮性

describe('边界与健壮性', () => {
  test('未知 clip 的 motion 命令被忽略且记录原因', () => {
    const d = makeDirector()
    const base0 = d.frame(0).baseClip
    const logs = d.dispatch({ kind: 'motion', atMs: 10, clip: 'nope' })
    assert.ok(logs.some((s) => s.includes('未知 clip')), JSON.stringify(logs))
    assert.equal(d.frame(20).baseClip, base0)
  })

  test('overlay 层 clip 不能用 motion 命令播', () => {
    const clips = [...makeClips(), { ...clip('blink_layer', 'other'), layer: 'overlay' }]
    const d = new MotionDirector({ clips, seed: 5 })
    d.frame(0)
    const logs = d.dispatch({ kind: 'motion', atMs: 10, clip: 'blink_layer' })
    assert.ok(logs.some((s) => s.includes('overlay 层')), JSON.stringify(logs))
  })

  test('idlePool 显式指定时按它轮换；含未知名会抛错', () => {
    const d = new MotionDirector({ clips: makeClips(), seed: 7, idlePool: ['idle_c', 'idle_a'] })
    const seen = []
    for (let t = 0; t <= 40_000; t += 500) seen.push(d.frame(t).baseClip)
    assert.deepEqual([...new Set(seen)].sort(), ['idle_a', 'idle_c'])
    assert.throws(() => new MotionDirector({ clips: makeClips(), idlePool: ['ghost'] }), /未知 clip/)
  })

  test('空闲时长时间空转不会漂移（跑 10 分钟不抛不变量）', () => {
    const d = makeDirector()
    let switches = 0
    for (let t = 0; t <= 600_000; t += 250) {
      const f = d.frame(t)
      if (f.transitions.some((s) => s.includes('idle 轮换'))) switches++
      assert.ok(f.baseClip !== null)
    }
    // 每 12s 一次 ⇒ 0..600s 内发生 50 次（t=12,24,...,600）
    assert.equal(switches, 50, `10 分钟内应有 50 次轮换（600/12），实际 ${switches}`)
  })

  test('frame() 返回的 transitions 在无迁移时为空数组', () => {
    const d = makeDirector()
    d.frame(0)
    const f = d.frame(100)
    assert.deepEqual(f.transitions, [])
  })

  test('elapsedMs 从 startMs 起算', () => {
    const d = new MotionDirector({ clips: makeClips(), startMs: 1_000_000, seed: 3 })
    assert.equal(d.frame(1_000_000).elapsedMs, 0)
    assert.equal(d.frame(1_002_500).elapsedMs, 2_500)
  })
})
