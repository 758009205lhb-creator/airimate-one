/**
 * @airimate/avatar-stage/stage —— **唯一**角色舞台实现
 *
 * 硬约束（PRD FR-5 / 判据 A5–A8）：
 *   一个 `THREE.Scene`、一个 `WebGLRenderer`、一个 `AnimationMixer`、一个 `VRM` 实例。
 *   构造器会做**进程级计数自检**：第二次 `new Stage()` 直接抛错，而不是悄悄产出第二个角色。
 *
 * 每帧固定顺序（Tech-Spec §6.2）：
 *   `mixer.update(dt)` → 摇晃叠加 → 表演叠加（表情/眨眼/口型/视线） → `vrm.update(dt)` → `renderer.render`
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, MToonMaterialLoaderPlugin, type VRM } from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, type VRMAnimation } from '@pixiv/three-vrm-animation'
import type { MotionClipManifest, RequiredBone, StageSnapshot, EmotionName, VisemeName } from '@airimate/shared'
/**
 * ⚠ 这两个取值函数**在本地内联**，不从 `@airimate/shared` 导入。
 *   实测：Vite 打包时持续报 `"manifestClipId" is not exported by packages/shared/src/index.ts`
 *   （清缓存、重建 dist 都无效），而 TypeScript 侧完全正常。
 *   它们是 6 行的纯取值逻辑，内联的代价远小于跟打包器纠缠；
 *   `packages/shared` 里保留同名导出供 Node 侧使用，语义**必须保持一致**（以注释互相指认）。
 */
function manifestClipId(m: MotionClipManifest): string {
  return m.name || m.slug || m.id || ''
}
function manifestSemantic(m: MotionClipManifest): string {
  const legacy = (m as unknown as { semantic?: unknown }).semantic
  if (typeof legacy === 'string' && legacy) return legacy
  if (Array.isArray(legacy) && legacy.length) return String(legacy[0])
  return m.set ?? ''
}
/**
 * 根位移策略（**必须与 `packages/shared/src/ipc.ts` 的
 * `manifestRootMotionMode()` 保持一致**，同样因打包器问题内联）。
 *
 * 缺省保守：只有明确的行走/位移类动作才允许横向位移，其余一律 `none`。
 */
type RootMotionMode = 'none' | 'inPlace' | 'locomotion'
function manifestRootMotionMode(m: MotionClipManifest): RootMotionMode {
  const explicit = (m as unknown as { rootMotionMode?: string }).rootMotionMode
  if (explicit === 'none' || explicit === 'inPlace' || explicit === 'locomotion') return explicit
  const s = `${manifestSemantic(m)} ${m.name ?? ''} ${m.slug ?? ''}`.toLowerCase()
  if (/(walk|run|locomotion|move)/.test(s)) return 'locomotion'
  return 'none'
}

/** 每个 clip 的根位移策略读数（装载时算好，供验收探针直接读取） */
export interface RootMotionRecord {
  id: string
  mode: RootMotionMode
  /** clip 里是否存在 hips 平移轨道 */
  hasPositionTrack: boolean
  /** 模型 rest 姿势下 hips 的局部位置（归一化骨骼空间，米） */
  rest: { x: number, y: number, z: number } | null
  /** 归一化后第 0 帧的 hips 位置 */
  start: { x: number, y: number, z: number } | null
  /** 归一化后 hips 的横向（x）行程，米 */
  horizontalRangeM: number
  /** 归一化后 hips 的纵向（y）行程，米 */
  verticalRangeM: number
  /** 策略是否真的生效（`none` 要求横纵行程都为 0） */
  normalized: boolean
  reason: string | null
}

function round6(v: number): number { return Number((Number(v) || 0).toFixed(6)) }
import { LEG_BONES, REQUIRED_BONES, DISABLED_MOTION_SEMANTICS } from '@airimate/shared'
import {
  DecisionEngine, clamp, createBlinkState, createSwayState, stepBlink, stepSway, swayAtRest, TUNING,
  type MotionTarget,
} from './motion-runtime.js'
import { OverlayController } from './overlays.js'

/**
 * 宽高比变化阈值：小于它就不重算投影。
 *
 * 为什么要阈值而不是"只要变了就重算"：拖动窗口时宽高比每帧都有微小变化，
 * 每帧重算投影会让画面持续抖动；而真正需要重算的场景
 * （panel↔pet 切换、用户手动改窗口尺寸）宽高比变化远超 1%。
 */
export const ASPECT_CHANGE_THRESHOLD = 0.01

/** 进程级计数器：用于"只有一个 Scene/Renderer/Mixer/VRM"的可验证断言 */
export const stageCounters = {
  scenes: 0,
  renderers: 0,
  mixers: 0,
  vrms: 0,
  stages: 0,
  live2d: 0,
}

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}

export interface StageOptions {
  canvas: HTMLCanvasElement
  /** 动作资产基础 URL（app://asset/…） */
  assetBaseUrl: string
  fpsCap?: number
  reducedMotion?: boolean
  onWarning?: (message: string, code: string) => void
}

interface LoadedClip {
  manifest: MotionClipManifest | null
  clip: THREE.AnimationClip
  action: THREE.AnimationAction
  semantic: string
  loopable: boolean
}

export class Stage {
  readonly stageId = nextId('stage')
  private readonly rendererId = nextId('renderer')
  private readonly scene: THREE.Scene
  private readonly renderer: THREE.WebGLRenderer
  private readonly camera: THREE.PerspectiveCamera
  private readonly clock = new THREE.Clock()
  private readonly loader: GLTFLoader
  private readonly canvas: HTMLCanvasElement
  private readonly assetBaseUrl: string
  private readonly fpsCap: number
  private readonly onWarning: (message: string, code: string) => void
  private reducedMotion: boolean

  private vrm: VRM | null = null
  private mixer: THREE.AnimationMixer | null = null
  private mixerId: string | null = null
  private vrmInstanceId: string | null = null

  private readonly clips = new Map<string, LoadedClip>()
  private activeAction: THREE.AnimationAction | null = null
  /**
   * 最近一次**已应用到 mixer** 的目标 clip。
   * 主循环用它判断"director 的待机轮换是否已经落到 mixer 上"（见 `animate()` 的 ①b）。
   */
  private lastAppliedBase: string | null = null
  private readonly director: DecisionEngine
  private readonly overlays = new OverlayController()
  private sway = createSwayState()
  private blink = createBlinkState(0)

  private rafId = 0
  private pumpId = 0
  private ro: ResizeObserver | null = null
  private rafTicks = 0
  private intervalTicks = 0
  private running = false
  private paused = false
  private lastMouseDown = { x: 0, y: 0 }
  private dragging = false
  private windowDelta = { x: 0, y: 0 }
  private mouseDelta = { x: 0, y: 0 }
  private hipsRest: THREE.Quaternion | null = null
  private boneTravel = new Map<string, number>()
  private prevBoneQuat = new Map<string, THREE.Quaternion>()
  private fpsSamples: number[] = []
  private frameTimes: number[] = []
  private modelId: string | null = null
  private modelLoadMs: number | null = null
  private warnings: string[] = []
  private ready = false
  private disposed = false
  private lastFrameAt = 0
  private lastRenderAt: number | null = null
  /** 是否使用不透明清屏（诊断对照实验 / panel 模式） */
  private opaqueBackground = false
  /** 诊断用红方块 */
  private testBox: THREE.Mesh | null = null
  /** 最近一个 VRMA 自报的 rest hips 高度（用于比对模型 rest，定位尺度塌缩） */
  private animationRestHipsY: number | null = null

  constructor(o: StageOptions) {
    if (stageCounters.stages > 0) {
      throw new Error('禁止创建第二个 Stage：一个进程只允许一个 Scene/Renderer/Mixer/VRM（判据 A5–A8）')
    }
    stageCounters.stages += 1
    this.canvas = o.canvas
    this.assetBaseUrl = o.assetBaseUrl
    this.fpsCap = o.fpsCap ?? 60
    this.reducedMotion = o.reducedMotion ?? false
    this.onWarning = o.onWarning ?? (() => { /* noop */ })

    this.scene = new THREE.Scene()
    stageCounters.scenes += 1

    this.renderer = new THREE.WebGLRenderer({
      canvas: o.canvas,
      alpha: true,
      antialias: true,
      /**
       * ⚠ `preserveDrawingBuffer: true` —— **实测必需**。
       *
       * 取证链（本轮把这三点凑齐之后才定位到）：
       *   ① `drawCalls = 24`、`triangles = 130235`（绘制指令确实提交了）；
       *   ② `canvasNonBgRatio = 1`（**从 WebGL 帧缓冲回读**，整片都是非背景色 ⇒ 角色真的被画进了缓冲）；
       *   ③ 屏幕截图里画布区域是**一整片均匀清屏色**，没有任何角色像素。
       *   ⇒ 结论：缓冲里有内容，但内容没有呈现到屏幕上（合成时缓冲已被丢弃）。
       *   这正是 `preserveDrawingBuffer: false`（默认值）在部分 Chromium/Electron 合成路径下的表现。
       *   本工程内**已验证可出图**的那条渲染链（`tools/motion-lab/renderer.html`）
       *   用的就是 `preserveDrawingBuffer: true`，这里与实测可用的取值对齐。
       */
      preserveDrawingBuffer: true,
      /**
       * ⚠ `premultipliedAlpha: false`（旧原型 `build/pet/app/js/vrm.mjs` 实测可用的取值）。
       *   在**透明无边框窗口**上，预乘 alpha 与 Chromium 的合成方式组合起来很容易让
       *   角色整体变成不可见（材质 alpha 被二次相乘）。旧原型用 false 且角色正常显示，
       *   所以这里对齐实测可用的取值。
       */
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    })
    stageCounters.renderers += 1
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.NoToneMapping
    /**
     * ⚠ 显式把 pixelRatio 钉为 1，不再用 `devicePixelRatio`。
     *
     * 为什么（实测踩到，这是"draw call 24 / 三角形 13 万 / 材质正常 / 角色投影矩形在画布内，
     * 屏幕上却一个像素都没有"的最后一个根因）：
     *   本机 `devicePixelRatio = 1.25`。`renderer.setSize(150, 630, false)` + `setPixelRatio(1.25)`
     *   会让 **CSS 尺寸 (150×630) 与实际 drawingBuffer (187×787)** 分成两套坐标。
     *   而 `updateStyle=false` 又意味着 canvas 的 CSS 尺寸由外部样式决定 ⇒ 两者长期不一致，
     *   取景计算、命中区域、屏幕像素采样三套坐标互相错位，视觉表现就是"空的"。
     *
     *   DPR 1.25 在 150 px 宽的画布上只带来极小的清晰度收益，却引入一整类坐标 bug。
     *   ⇒ 取 pixelRatio = 1：CSS 尺寸 === drawingBuffer 尺寸，三者共用一套坐标（可被探针证明）。
     */
    this.renderer.setPixelRatio(1)

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 40)
    this.camera.position.set(0, 1.32, 2.1)
    this.camera.lookAt(0, 1.18, 0)

    // 灯光：柔和三点光，避免 PBR 死黑（MToon 对光照敏感，给足环境光）
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.35)
    this.scene.add(hemi)
    const key = new THREE.DirectionalLight(0xffffff, 1.25)
    key.position.set(1.1, 1.9, 1.6)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.45)
    fill.position.set(-1.4, 1.0, 0.8)
    this.scene.add(fill)

    this.loader = new GLTFLoader()
    this.loader.register((parser) => new VRMLoaderPlugin(parser))
    this.loader.register((parser) => new MToonMaterialLoaderPlugin(parser))
    this.loader.register((parser) => new VRMAnimationLoaderPlugin(parser))

    this.director = new DecisionEngine({
      now: () => performance.now(),
      onEvent: (e) => {
        if (e.kind === 'noop' && e.detail) this.warn(e.detail, 'MOTION_WARN')
      },
    })

    window.addEventListener('resize', this.onResize, { passive: true })
    document.addEventListener('visibilitychange', this.onVisibility, { passive: true })
    this.onResize()
    /**
     * ⚠ 必须用 `ResizeObserver` 跟随画布的真实布局尺寸。
     *
     * 实测踩到（这是"draw call 有 24 个、三角形 13 万、材质正常、角色投影矩形也在画布内，
     * 但屏幕上一个像素都没有"的**根因**）：
     *   构造与首次 layout 之间存在时序差 —— `queueMicrotask` / 首个 `requestAnimationFrame`
     *   回调跑的时候 canvas 的 CSS 尺寸还没被 flex 布局定下来，`setSize` 无效；
     *   结果 drawingBuffer 长期停在 187×787，而 CSS 显示尺寸是 150×630 ⇒
     *   两者坐标系不一致，画面内容与命中区域/取景计算全部错位，视觉上就是"空的"。
     *   ResizeObserver 对"布局变化"是最可靠的信号（也覆盖 panel↔pet 切换与窗口拉伸）。
     */
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => { try { this.onResize() } catch { /* ignore */ } })
      /**
       * ⚠ 观察**容器**而不是 canvas 本身：canvas 的内联尺寸一旦被写过，它的盒子就
       *   不再随布局变化 ⇒ 观察它等于观察一个常量（本轮实测：panel→pet 切换后
       *   canvas 永远停在 90×289）。容器是布局真正的承受者。
       */
      this.ro.observe(this.canvas.parentElement ?? this.canvas)
    }
  }

  // ───────────────────────────────────────────────────── 加载

  /** 加载 VRM 角色。失败时抛错（由调用方显示可见告警，禁止静默） */
  async loadAvatar(url: string, id = 'avatar'): Promise<VRM> {
    const t0 = performance.now()
    const gltf = await this.loader.loadAsync(url)
    const vrm = gltf.userData.vrm as VRM | undefined
    if (!vrm) throw new Error('该文件不是有效的 VRM（缺少 VRMC_vrm 扩展）')

    // 优化：视锥剔除 + 冻结世界矩阵（three-vrm 官方建议）
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    // `combineSkeletons` 比已弃用的 `removeUnnecessaryJoints` 性能收益更大（旧原型实测可用）
    try { VRMUtils.combineSkeletons(gltf.scene) } catch { /* 版本差异容忍 */ }
    VRMUtils.rotateVRM0(vrm)

    vrm.scene.traverse((obj) => { obj.frustumCulled = false })

    this.scene.add(vrm.scene)
    /**
     * ⚠ 必须先更新世界矩阵再算包围盒/取景。
     *   否则 `Box3.setFromObject` 读到的是**未更新的**矩阵（可能是单位矩阵或上一次的值），
     *   取景距离就会算错 —— 这是"渲染有 draw call 但画面看不到角色"的典型成因之一。
     */
    vrm.scene.updateMatrixWorld(true)
    this.vrm = vrm
    this.vrmInstanceId = nextId('vrm')
    stageCounters.vrms += 1

    this.mixer = new THREE.AnimationMixer(vrm.scene)
    this.mixerId = nextId('mixer')
    stageCounters.mixers += 1

    this.overlays.attach(vrm, this.reducedMotion)

    const hips = vrm.humanoid?.getNormalizedBoneNode('hips' as RequiredBone)
    this.hipsRest = hips ? hips.quaternion.clone() : null

    // 绑定自检：17 根必需骨骼必须全部存在（判据 A12 的采样基础）
    const missing = REQUIRED_BONES.filter(b => !vrm.humanoid?.getNormalizedBoneNode(b))
    if (missing.length) {
      this.warn(`模型缺少 ${missing.length} 根必需骨骼：${missing.join(', ')}`, 'AVATAR_BONES_MISSING')
    }

    this.frameCamera(vrm)
    this.modelId = id
    this.modelLoadMs = Math.round(performance.now() - t0)
    this.ready = true
    return vrm
  }

  /** 按模型包围盒框住角色（同时满足垂直与水平方向；见下方注释） */
  private frameCamera(vrm: VRM): void {
    this.reframe(vrm)
    this.dumpMaterialSample(vrm)
  }

  /**
   * ★ **固定舞台锚点与一次性取景**（本轮重构的核心）。
   *
   * 规格要求：角色必须**常驻**舞台锚点，不得随每次动作改变位置；
   * 相机只在固定 rest 姿势上算一次，clip 切换 / resize 都不得重取景。
   *
   * 旧实现的两个动态量互相影响（实测根因）：
   *   · `autoCenterOnSkinnedContent()` 按**当前动画帧**的蒙皮中心平移 `vrm.scene.position`；
   *   · `reframe()` 又按**当前动画帧**的蒙皮顶点决定相机 `position/lookAt`；
   *   · 而 `reframe()` 挂在 `onResize()` 上 ⇒ 拖动改窗口尺寸时**持续重取景**。
   *   ⇒ 待机动作切换、根位移变化、resize 都会让角色在画布里移动，且不收敛。
   *
   * 新做法：
   *   ① 用**固定 rest 骨架**（`revertToRestPose()` 之后）测一次内容包围盒；
   *   ② 把"内容包围盒中心对齐到舞台锚点"这件事**固化到模型根节点**，
   *      此后**永不**再改 `vrm.scene.position`；
   *   ③ 相机水平朝向（`lookAt.y = 内容中心 y`）与锚点高度一致 ⇒
   *      **投影中心恰好落在 `(ANCHOR_X, BASELINE_Y)`**；
   *   ④ resize 只改 `camera.aspect` + 重算距离（保持投影中心不变），
   *      **不再追当前动画包围盒**。
   */
  /** 舞台横向锚点（画布宽度比例，0.5 = 正中） */
  /** 上一次的宽高比（用于"只在大幅变化时才重算投影"） */
  private lastAspect = 0
  private anchorXRatio = 0.50
  /** 舞台底部基线（画布高度比例，0.92 = 靠下） */
  private anchorYRatio = 0.92
  /** 是否已完成"固定锚点 + 一次性取景"。完成后不再重算。 */
  private anchoredOnce = false
  /** 设置舞台锚点（画布尺寸变化后会按比例重新落位） */
  setStageAnchor(xRatio: number, yRatio: number): void {
    this.anchorXRatio = Math.min(0.95, Math.max(0.05, xRatio))
    this.anchorYRatio = Math.min(0.98, Math.max(0.05, yRatio))
  }

  /** 当前锚点的画布像素坐标（供探针与命中测试使用，与相机无关） */
  stageAnchorPx(): { x: number, y: number } {
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: rect.width * this.anchorXRatio,
      y: rect.height * this.anchorYRatio,
    }
  }

  /**
   * **一次性**建立固定锚点与取景。幂等：只有第一次真正生效。
   *
   * 为什么在 rest 姿势上算：rest 骨架是**固定**的，与当前在播哪个 clip 无关。
   * 用当前动画帧去算，就等于把"动作的瞬时姿态"固化进锚点 —— 那正是旧的缺陷。
   */
  private anchorAndFrameOnce(vrm: VRM): void {
    if (this.anchoredOnce) return
    this.anchoredOnce = true

    /**
     * ① 先回到 rest 姿势再测量。
     *
     * `humanoid.resetNormalizedPose()` 把归一化骨骼恢复成模型自带的参考姿态
     * （**位置与旋转都复位**，见 three-vrm-core `resetPose()`）——
     * 与"当前在播哪个 clip"无关，因此测出来的尺寸是**固定**的。
     *
     * ⚠ **绝不能在这里调 `mixer.update(0)`**：那会把当前活动动作重新写进同一批
     *   归一化骨骼，覆盖掉刚复位的 rest 姿势 —— 测量值就又变成"当前动画帧的姿态"
     *   （抬手的待机动作会改变包围盒宽度/高度），锚点于是重新开始漂移。
     *   旧代码正是这么写的。这里只复位、不喂动画；下一帧 `mixer.update(dt)`
     *   自然会把动作写回去，用户看不到跳变。
     */
    try { vrm.humanoid?.resetNormalizedPose?.() } catch { /* 老版本没有该方法时忽略 */ }
    vrm.update(0)
    try { this.vrm?.scene.updateMatrixWorld(true) } catch { /* ignore */ }

    // 测量固定 rest 内容包围盒（蒙皮顶点路径；失败则退回 Box3 并告警）
    const b = this.skinnedBounds(60, 900)
    let size = { x: 1.2, y: 1.45, z: 0.7 }
    let center = { x: 0, y: 0.72, z: 0 }
    if (b.ok) {
      size = { x: b.size.x, y: b.size.y, z: b.size.z }
      center = { x: b.center.x, y: b.center.y, z: b.center.z }
    } else {
      this.warn(`固定锚点：rest 蒙皮包围盒不可用（${b.reason ?? 'unknown'}）→ 退回 Box3`, 'ANCHOR_BOUNDS_FALLBACK')
    }
    const height = Number.isFinite(size.y) && size.y > 0.3 && size.y < 20 ? size.y : 1.6

    /**
     * ② 把内容包围盒中心**固化**到模型根节点：让内容中心落在世界原点正上方。
     *    之后只有 `setAvatarScale()` 会再动 `vrm.scene` 的变换，
     *    且它是**围绕锚点**缩放的（见 `applySceneTransform()`）。
     *
     * ⚠ 测量前把根缩放复位到 1：否则"局部量 / 世界量"的换算会带一个比例因子，
     *   而后续每次缩放都要按它反推 —— 那是漂移的温床。用户缩放值记在
     *   `this.avatarScale` 里，测完之后由 `applySceneTransform()` 重新施加。
     */
    const s0 = Number(vrm.scene.scale.x)
    if (Number.isFinite(s0) && Math.abs(s0 - 1) > 1e-6) {
      vrm.scene.scale.setScalar(1)
      vrm.scene.updateMatrixWorld(true)
      this.warn(`建立锚点前把模型根缩放从 ${s0} 复位为 1（用户缩放值 ${this.avatarScale} 会在之后重新施加）`, 'ANCHOR_SCALE_RESET')
    }
    const p0 = vrm.scene.position.clone()
    this.restLocalCenter = { x: center.x - p0.x, y: center.y - p0.y, z: center.z - p0.z }
    this.restLocalBaselineY = this.restLocalCenter.y - height / 2
    this.restWorldBaselineY = center.y - height / 2
    this.applySceneTransform()
    /** 舞台基线 = 内容的**底部**（不是中心）；锚点 `anchorYRatio` 指的是它 */
    const baseY = this.restWorldBaselineY

    /**
     * ③ 相机：按锚点把内容**基线**投影到 `(anchorX, anchorY)`（推导见 `freezeCameraOnRestPose`）。
     */
    this.restHeightForReframe = height
    this.restBaseYForReframe = baseY
    this.freezeCameraOnRestPose(vrm, height, baseY)
    this.anchoredOnce = true
    this.notice(
      `固定舞台锚点已建立（rest 身高 ${height.toFixed(3)}m；锚点 ${(this.anchorXRatio * 100).toFixed(0)}% / ${(this.anchorYRatio * 100).toFixed(0)}%）`,
      'STAGE_ANCHOR_FIXED',
    )
  }

  /**
   * 把"内容中心对齐世界原点 + 基线钉在锚点"这件事写进模型根节点的变换。
   *
   * 只有两处会调用它：建立锚点时、以及用户**显式**改缩放时。
   * 缩放**围绕锚点**：局部中心/基线各自乘以 `s`，再反向平移回去，
   * 于是世界坐标下的内容中心与基线**不随 `s` 变化**。
   */
  private applySceneTransform(): void {
    const vrm = this.vrm
    if (!vrm) return
    const s = this.avatarScale
    vrm.scene.scale.setScalar(s)
    vrm.scene.position.set(
      -s * this.restLocalCenter.x,
      this.restWorldBaselineY - s * this.restLocalBaselineY,
      -s * this.restLocalCenter.z,
    )
    vrm.scene.updateMatrixWorld(true)
  }

  /** 建立锚点时记下的**局部**内容中心与局部基线（缩放时按它们反推平移） */
  private restLocalCenter = { x: 0, y: 0, z: 0 }
  private restLocalBaselineY = 0
  /** 建立锚点时记下的**世界**基线（相机取景就是按它算的） */
  private restWorldBaselineY = 0

  /**
   * 依据固定 rest 尺寸摆相机；`aspect` 变化时**只重算距离**，投影中心保持不动。
   *
   * 与旧 `reframe()` 的区别：入参是**常量**（rest 身高 + 基线高度），
   * 不是"当前动画帧的包围盒" ⇒ 不会随动作切换而变。
   *
   * ⚠ **投影公式（本轮修正过一次符号错误，务必按下面的推导核对）**：
   *   相机位于 `(0, lookY, dist)`，看向 `(tx, lookY, 0)`，两者等高 ⇒ 视线水平。
   *   记 `tanθv = tan(fov/2)`、`tanθh = tanθv · aspect`，内容高 `h`、基线 `baseY`、内容中心 `x = 0`。
   *   · 纵向：屏幕 y（自顶向下）`= (1 − NDC_y)/2 · H`，而 `NDC_y = (p_y − lookY)/(dist·tanθv)`。
   *     要求**基线**落在 `anchorY` ⇒ `NDC_y = 1 − 2·anchorY`
   *     ⇒ `lookY = baseY + (2·anchorY − 1)·dist·tanθv`。
   *   · 横向：`NDC_x = −tx/(dist·tanθh)`，要求内容中心落在 `anchorX`
   *     ⇒ `tx = (1 − 2·anchorX)·dist·tanθh`（`anchorX = 0.5` 时 `tx = 0`，即正对中心）。
   *
   * 旧代码把这写成"相机横向平移 `xOffset` 且 `lookAt` 原点"：那是**无效的** ——
   * 视线水平时，正对 target 上方的点**永远**投影在水平中心，横向平移相机不改变它
   * （`v·right ≡ 0`）。同理旧代码的 `lookY = 中心 + yOffset` 把锚点方向**弄反了**
   * （`anchorY = 0.92` 会把角色中心送到画面顶部 8% 处）。
   */
  private freezeCameraOnRestPose(vrm: VRM, height: number, baseY: number): void {
    const rect = this.canvas.getBoundingClientRect()
    const cw = Math.max(1, rect.width || this.canvas.clientWidth || 1)
    const ch = Math.max(1, rect.height || this.canvas.clientHeight || 1)
    const aspect = cw / ch
    const fovDeg = this.camera.fov
    const vFov = (fovDeg * Math.PI) / 180
    const tanV = Math.tan(vFov / 2)
    const tanH = tanV * Math.max(0.01, aspect)

    // 距离：同时满足垂直与水平两个方向（取较大者），再乘实测标定的退距系数
    const objW = Math.max(height * 0.45, 0.4)
    const margin = 0.20
    const dV = (height * (1 + margin)) / (2 * tanV)
    const dH = (objW * (1 + margin)) / (2 * tanH)
    /**
     * 退距系数：角色在画面里占的高度比例 `= 1 / ((1+margin) · DOLLY_K)`。
     *   1.20 ⇒ 约 **69%** 画布高（头部上方留约 23% 余量）。
     * 取 1.20 而不是更大的值：底部基线固定在 92%，退得太远会让角色缩在画面下沿、
     * 上方大片空白。换模型或改取景意图时**必须用截图重新标定**这个数。
     */
    const DOLLY_K = 1.20
    const dist = Math.max(dV, dH) * DOLLY_K

    const lookY = baseY + (2 * this.anchorYRatio - 1) * dist * tanV
    const tx = (1 - 2 * this.anchorXRatio) * dist * tanH

    this.camera.position.set(0, lookY, dist)
    this.camera.lookAt(tx, lookY, 0)
    this.camera.near = Math.max(0.05, dist * 0.05)
    this.camera.far = Math.max(20, dist * 12)
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()
    this.cameraDist = dist
    this.cameraLookAt = { x: tx, y: lookY, z: 0 }
  }

  /** 相机 lookAt 目标（精确记账，`cameraSignature()` 用它做"相机有没有变过"的断言） */
  private cameraLookAt = { x: 0, y: 0, z: 1 }

  /** 相机的 lookAt 点（诊断与"相机是否变过"的断言用） */
  private lookAtPoint(): { x: number, y: number, z: number } {
    // 直接返回记账值，不用"位置 + 朝向 × 距离"反算：后者在有横向偏转时会有微小误差，
    // 而"切换 10 个动作相机完全不变"的判据要求的是**逐位相等**。
    return { ...this.cameraLookAt }
  }

  /** 相机参数快照（用于断言"切换动作时相机完全没变"） */
  cameraSignature(): {
    position: { x: number, y: number, z: number }
    lookAt: { x: number, y: number, z: number }
    fov: number, near: number, far: number
  } {
    const l = this.lookAtPoint()
    return {
      position: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
      lookAt: l,
      fov: this.camera.fov, near: this.camera.near, far: this.camera.far,
    }
  }

  private cameraDist = 7

  /**
   * 重新取景。`loadAvatar` 之后、以及**每次画布尺寸变化**都要调用。
   *
   * ⚠ 本轮已把"追当前动画帧"的做法移除：
   *   本函数**只**依据固定 rest 尺寸与锚点重算投影，**不读**当前动画的包围盒/蒙皮顶点。
   *   参数 `vrm` 仅用于建立首次锚点（幂等）。
   */
  private reframe(vrm: VRM): void {
    if (!this.anchoredOnce) { this.anchorAndFrameOnce(vrm); return }
    /**
     * 已建立锚点 ⇒ 只更新投影，**不动投影中心**。
     * 距离随宽高比变化是必要的（否则窄画布会把角色裁掉），
     * 但 `lookAt` 与锚点投影位置保持不变 —— 这正是"resize 不重取景"的含义。
     */
    const restHeight = this.restHeightForReframe
    this.freezeCameraOnRestPose(vrm, restHeight, this.restBaseYForReframe)
  }

  /** 建立锚点时记下的固定 rest 尺寸（后续 resize 复用，不再重新测量） */
  private restHeightForReframe = 1.6
  private restBaseYForReframe = 0.72

  /** 材质/可见性实测（一次性打印，便于定位"渲染了但看不见"） */
  private dumpMaterialSample(vrm: VRM): void {
    const mats: Array<Record<string, unknown>> = []
    vrm.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      const arr = Array.isArray(mat) ? mat : (mat ? [mat] : [])
      for (const m of arr) {
        if (mats.length >= 6) break
        const anyM = m as unknown as {
          isMToonMaterial?: boolean, opacity?: number, transparent?: boolean, alphaTest?: number,
          visible?: boolean, colorWrite?: boolean, side?: number, depthWrite?: boolean, color?: { getHexString?: () => string }
        }
        mats.push({
          type: m.type,
          isMToon: anyM.isMToonMaterial === true,
          opacity: anyM.opacity,
          transparent: anyM.transparent,
          alphaTest: anyM.alphaTest,
          visible: anyM.visible,
          colorWrite: anyM.colorWrite,
          depthWrite: anyM.depthWrite,
          side: anyM.side,
          color: anyM.color?.getHexString?.(),
        })
      }
    })
    console.debug(`[stage] 材质采样 ${JSON.stringify({
      canvasCss: `${this.canvas.clientWidth}x${this.canvas.clientHeight}`,
      camDist: Number(this.camera.position.distanceTo(new THREE.Vector3()).toFixed(3)),
      materials: mats,
    })}`)
  }

  /**
   * 加载动作。
   *
   * 契约说明：主进程下发的 `MotionClipManifest` 是**跨进程契约**；动作管线导出的
   * sidecar 清单与它字段不同（见 docs/Tech-Spec.md §6.1），因此这里做**双向容忍**：
   *   ① manifest 里给出可用文件名 → 用 manifest；
   *   ② 没有 manifest（或字段不匹配）→ 由调用方给出的 `availableIds`（主进程扫目录得到）
   *      直接按 `<id>.vrma` 加载，并标注 `manifest: null`（诊断里可见，不假装有清单）。
   */
  async loadMotions(
    manifests: readonly MotionClipManifest[],
    availableIds: readonly string[] = [],
  ): Promise<{ loaded: number, failed: Array<{ id: string, error: string }>, clips: string[] }> {
    if (!this.mixer || !this.vrm) throw new Error('必须先加载角色再加载动作')
    const failed: Array<{ id: string, error: string }> = []
    const jobs: Array<{ id: string, manifest: MotionClipManifest | null }> = []
    const seen = new Set<string>()
    for (const m of manifests) {
      const id = manifestClipId(m)
      if (!id || seen.has(id)) continue
      seen.add(id)
      jobs.push({ id, manifest: m })
    }
    for (const id of availableIds) {
      if (seen.has(id)) continue
      seen.add(id)
      jobs.push({ id, manifest: null })
    }

    for (const job of jobs) {
      try {
        const url = `${this.assetBaseUrl}/${job.id}.vrma`
        const gltf = await this.loader.loadAsync(url)
        const vrmAnim = gltf.userData.vrmAnimations?.[0] as VRMAnimation | undefined
        if (!vrmAnim) throw new Error('不是有效的 VRMA（缺少 VRMC_vrm_animation 扩展）')
        // 记录 VRMA 自报的 rest hips 高度：three-vrm 会用它算 `loaderScale`
        // （`modelRestHipsY / animationRestHipsY`），两者差得越多，位移被放大得越狠。
        const animRest = (vrmAnim as unknown as { restHipsPosition?: { y?: number } }).restHipsPosition?.y
        if (typeof animRest === 'number' && Number.isFinite(animRest)) this.animationRestHipsY = Number(animRest.toFixed(4))
        const clip = createVRMAnimationClip(vrmAnim, this.vrm)
        if (!clip.tracks.length) throw new Error('VRMA 没有解析出任何 humanoid 轨道')
        clip.name = job.id
        /**
         * ★ **根位移归一化**（必须有，且必须在 `clipAction()` **之前**）。
         *
         * 为什么必须在建 action 之前：`AnimationMixer.clipAction()` 会立刻为每条轨道
         * 创建 interpolant 并持有 `values` 引用。归一化放在前面就不必依赖
         * "in-place 改写能被 interpolant 看到"这一实现细节。
         *
         * 策略来源：`manifestRootMotionMode()`（见 `docs/evidence/phase3/INTERACTION-ROOT-CAUSE.md`）。
         * 失败（无法归一化）时**抛出** ⇒ 进入 `failed[]` ⇒ 调用方弹可见告警，
         * 不允许"静默带着 4.6 m 的根偏移继续跑"。
         */
        this.applyRootMotionPolicy(
          clip,
          manifestRootMotionMode(job.manifest ?? ({ name: job.id } as MotionClipManifest)),
          job.id,
        )
        const action = this.mixer.clipAction(clip)
        const loopable = job.manifest ? Boolean((job.manifest as unknown as { loopable?: boolean, loop?: boolean }).loopable ?? (job.manifest as unknown as { loop?: boolean }).loop) : true
        action.loop = loopable ? THREE.LoopRepeat : THREE.LoopOnce
        action.clampWhenFinished = !loopable
        action.enabled = false
        action.setEffectiveWeight(0)
        this.clips.set(job.id, {
          manifest: job.manifest,
          clip,
          action,
          semantic: this.semanticOf(job.id, job.manifest),
          loopable,
        })
      } catch (e) {
        failed.push({ id: job.id, error: e instanceof Error ? e.message : String(e) })
      }
    }

    if (failed.length) {
      this.warn(`动作加载失败 ${failed.length} 个：${failed.slice(0, 4).map(f => `${f.id}(${f.error})`).join('; ')}`, 'MOTION_CLIP_FAILED')
    }

    const records = [...this.clips.entries()].map(([name, c]) => ({ name, semantic: c.semantic, loopable: c.loopable }))
    const r = this.director.load(records)
    if (!r.ok) this.warn('没有可用动作，角色将无法播放动画（原因见上）', 'MOTION_NONE')
    else {
      const t = this.director.getBaseClipId()
      if (t) this.applyTarget({ clipId: t, weight: 1, fadeSec: 0 })
    }

    /**
     * ★ **收口点**：建立**固定锚点 + 一次性取景**。
     *
     * 这里必须放在动作装载之后（`applyTarget` 刚调用过，骨架已被驱动），
     * 但**测量基准仍用固定 rest 姿势**（`anchorAndFrameOnce` 内部会
     * `resetNormalizedPose()` 再测），所以结果与"当前在播哪个 clip"无关 ——
     * 这正是"角色不再随动作漂移"的关键。
     *
     * 旧代码在这里调 `autoCenterOnSkinnedContent()`：它按当前动画帧的蒙皮中心
     * 平移 `vrm.scene.position`，是漂移的根源。本轮已不再调用它。
     */
    if (this.vrm) {
      try { this.vrm.update(0) } catch { /* ignore */ }
      this.reframe(this.vrm)
    }
    return { loaded: this.clips.size, failed, clips: [...this.clips.keys()] }
  }

  /**
   * ★ **根位移策略**（本轮新增的核心修正之一）。
   *
   * 问题（实测）：Mate 的 `.anim` 里 `RootT` 是一个**常量级偏移**
   * （idle 系列 `rest.x ≈ 0.965–1.16`，与身高同量级），而 three-vrm 会把整条
   * hips 平移轨道乘以 `modelRestHipsY / animationRestHipsY`（实测 ≈ 4.85）
   * ⇒ 角色根节点被推到 `x ≈ −4.6 m`，**完全离开视锥**（录像里舞台全空白）。
   *
   * 修法：在**装载时**按策略改写 hips 平移轨道的**数值**（不动资产字节）：
   *   · `none`       x/y/z 全部钉到模型 rest 位置 ⇒ 根位移恒为零；
   *   · `inPlace`    x/z 钉到 rest，y 保留（原地起伏）；
   *   · `locomotion` x/z 按"相对本 clip 起始姿势"的位移播放（去掉常量偏移）。
   *
   * 为什么基准是 `normalizedRestPose.hips.position` 而不是"clip 第一帧"：
   *   rest 姿势正是**取景时用的那个姿势**（见 `anchorAndFrameOnce`），
   *   所以"钉到 rest"== "角色永远站在被框住的那个位置"，两者天然自洽。
   */
  private applyRootMotionPolicy(clip: THREE.AnimationClip, mode: RootMotionMode, id: string): RootMotionRecord {
    const humanoid = this.vrm?.humanoid
    const rawRest = (humanoid as unknown as { normalizedRestPose?: { hips?: { position?: unknown } } } | undefined)
      ?.normalizedRestPose?.hips?.position
    /**
     * ⚠ `normalizedRestPose.hips.position` 是**三元数组** `[x, y, z]`，不是 `{x,y,z}`。
     *   旧诊断代码里按 `.y` 读它，于是 `vrmRestHipsY` 恒为 `null`（本轮一并修正）。
     */
    const rest = Array.isArray(rawRest) && rawRest.length >= 3
      ? { x: Number(rawRest[0]) || 0, y: Number(rawRest[1]) || 0, z: Number(rawRest[2]) || 0 }
      : null

    /**
     * hips 平移轨道名：three-vrm-animation 用 `${normalizedNode.name}.position`，
     * 而 three-vrm-core 把归一化骨骼命名为 `Normalized_<bone>`（实测源码 L1821）。
     * 先按精确名找，找不到再退化为"任意 `.position` 轨道"。
     */
    const hipsNode = humanoid?.getNormalizedBoneNode('hips' as RequiredBone)
    const exact = hipsNode ? `${hipsNode.name}.position` : null
    const track = (exact ? clip.tracks.find(t => t.name === exact) : undefined)
      ?? clip.tracks.find(t => t.name.endsWith('.position'))

    const rec: RootMotionRecord = {
      id,
      mode,
      hasPositionTrack: Boolean(track),
      rest,
      start: null,
      horizontalRangeM: 0,
      verticalRangeM: 0,
      normalized: false,
      reason: null,
    }
    this.rootMotionRecords.push(rec)

    if (!track) {
      // 没有平移轨道 ⇒ 根位移本来就为零。`locomotion` 声明了要走却没得走，要显式记因。
      rec.normalized = mode !== 'locomotion'
      if (mode === 'locomotion') rec.reason = 'clip 没有 hips 平移轨道，locomotion 未生效（按原地处理）'
      return rec
    }
    if (!rest) {
      if (mode !== 'locomotion') {
        // 规格：归一化不可能时**拒绝装载并给出可见错误**，不允许静默带偏移运行。
        throw new Error(`根位移归一化失败：模型缺少 normalizedRestPose.hips.position（策略 ${mode} 需要它作基准）`)
      }
      rec.reason = '模型缺少 normalizedRestPose.hips.position，locomotion 未做常量偏移归零'
      return rec
    }

    const src = track.values
    if (!src || src.length < 3) {
      rec.reason = 'hips 平移轨道为空'
      return rec
    }

    /**
     * ★ **合理性闸门**（本轮实测发现，必须挡住）。
     *
     * 每个 VRMA 的 `restHipsPosition.y` 差别极大（本资产包：idle 0.0052、walk 0.0050、
     * sleep 0.0955），而 three-vrm 按 `modelRestHipsY / animationRestHipsY` **逐 clip**
     * 放大 ⇒ 同一批"零点几个单位"的位移会被放大成米级
     * （`--probe rootMotionIdle` 实测：`locomotion_pet_walk_left`
     * 横向 **4.380 m**、纵向 **2.607 m**，而角色髋高只有 0.834 m）。
     * 这样的位移一旦播放，角色会瞬间飞出画布 —— 与待机漂移是同一类故障。
     *
     * 规则（阈值以**角色髋高**为尺度，不用魔法数）：
     *   · 横向行程 > 髋高 25% ⇒ 钉死横向；
     *   · 纵向行程 > 髋高 40% ⇒ 钉死纵向。
     * 触发时把原因写进 `reason` 并**发可见告警**（不静默、也不假装归一化成功）。
     */
    let pinXZ = mode !== 'locomotion'
    let pinY = mode === 'none'
    const hipH = Math.abs(rest.y) || 1
    let lo = Infinity; let hi = -Infinity; let vlo = Infinity; let vhi = -Infinity
    for (let i = 0; i + 2 < src.length; i += 3) {
      const x = Number(src[i]); const y = Number(src[i + 1])
      if (x < lo) lo = x
      if (x > hi) hi = x
      if (y < vlo) vlo = y
      if (y > vhi) vhi = y
    }
    const hRange = hi - lo
    const vRange = vhi - vlo
    if (!pinXZ && hRange > hipH * 0.25) {
      pinXZ = true
      rec.reason = `横向根位移 ${hRange.toFixed(3)} m 超过髋高的 25%（${(hipH * 0.25).toFixed(3)} m）⇒ 钉死横向`
      /**
       * ⚠ 用 `notice` 而**不是** `warn`：这是"已自动处理好的资产属性"，
       *   不是运行故障。用 `warn` 会让状态栏长期显示「舞台告警 N」——
       *   那会把真正的告警淹没（本轮实测：状态栏出现"舞台告警 2"，而两条都不是故障）。
       *   完整原因仍然写入 `RootMotionRecord.reason`，探针与日志都读得到。
       */
      this.notice(`${id}：${rec.reason}`, 'ROOT_MOTION_HORIZONTAL_REJECTED')
    }
    if (!pinY && vRange > hipH * 0.40) {
      pinY = true
      const msg = `纵向根位移 ${vRange.toFixed(3)} m 超过髋高的 40%（${(hipH * 0.40).toFixed(3)} m）⇒ 钉死纵向`
      rec.reason = rec.reason ? `${rec.reason}；${msg}` : msg
      this.notice(`${id}：${msg}`, 'ROOT_MOTION_VERTICAL_REJECTED')
    }
    /** 最终生效的策略由"哪几个轴被钉死"决定（闸门可能把 locomotion 降级） */
    const effectiveMode: RootMotionMode = pinXZ && pinY ? 'none' : (pinXZ ? 'inPlace' : 'locomotion')
    rec.mode = effectiveMode

    const out = new Float32Array(src.length)
    const baseX = Number(src[0]) || 0
    const baseZ = Number(src[2]) || 0
    for (let i = 0; i + 2 < src.length; i += 3) {
      out[i] = pinXZ
        ? rest.x
        : rest.x + (Number(src[i]) - baseX)
      out[i + 1] = pinY ? rest.y : Number(src[i + 1])
      out[i + 2] = pinXZ
        ? rest.z
        : rest.z + (Number(src[i + 2]) - baseZ)
    }
    // 整体替换 `values`（而不是就地改写）：`clipAction()` 还没调用，没有 interpolant 持有旧引用
    track.values = out

    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity
    for (let i = 0; i + 2 < out.length; i += 3) {
      const x = out[i] ?? 0; const y = out[i + 1] ?? 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    rec.start = { x: round6(out[0] ?? 0), y: round6(out[1] ?? 0), z: round6(out[2] ?? 0) }
    rec.horizontalRangeM = Number((maxX - minX).toFixed(6))
    rec.verticalRangeM = Number((maxY - minY).toFixed(6))
    rec.normalized = rec.mode === 'none'
      ? rec.horizontalRangeM === 0 && rec.verticalRangeM === 0
      : true
    /**
     * `none` 却仍有行程 ⇒ 归一化**没生效**。这是必须显式失败的：
     * 它的症状就是"角色跑到画布外"，而状态栏一切正常（最危险的一类故障）。
     */
    if (rec.mode === 'none' && !rec.normalized) {
      throw new Error(`根位移归一化未生效：策略 none 但仍有横向 ${rec.horizontalRangeM} m / 纵向 ${rec.verticalRangeM} m 行程`)
    }
    return rec
  }

  /** 每个 clip 的根位移策略读数（验收探针 `rootMotionIdle` 用） */
  rootMotion(): RootMotionRecord[] { return this.rootMotionRecords }

  private readonly rootMotionRecords: RootMotionRecord[] = []

  /** 从 id/manifest 推断语义（id 形如 `idle_pet_idle_2`、`misc_pet_dragging`） */
  private semanticOf(id: string, m: MotionClipManifest | null): string {
    if (m) {
      const s = manifestSemantic(m)
      if (s) return s
    }
    const l = id.toLowerCase()
    if (l.includes('drag')) return 'drag'
    if (l.includes('idle')) return 'idle'
    if (l.includes('walk')) return 'walk'
    if (l.includes('sit')) return 'sit'
    if (l.includes('sleep')) return 'sleep'
    if (l.includes('pose')) return 'pose'
    return 'other'
  }

  private warn(message: string, code: string): void {
    const line = `[${code}] ${message}`
    if (!this.warnings.includes(line)) this.warnings.push(line)
    this.onWarning(message, code)
  }

  /**
   * 提示级记录（**不进 `warnings`**）：用于"已自动做对的事"，
   * 例如运行时自动居中 —— 它不该让 UI 显示"舞台告警"。
   */
  private notice(message: string, code: string): void {
    console.debug(`[stage][${code}] ${message}`)
  }

  // ───────────────────────────────────────────────────── 渲染循环

  start(): void {
    if (this.running) return
    this.running = true
    this.clock.start()
    this.lastFrameAt = 0
    console.debug('[stage] start(): 装载阶段完成，进入渲染循环', {
      clips: this.clips.size,
      base: this.director.getBaseClipId(),
      canvasCss: `${this.canvas.clientWidth}x${this.canvas.clientHeight}`,
      canvasBuffer: `${this.canvas.width}x${this.canvas.height}`,
    })
    const loop = (): void => {
      this.rafId = requestAnimationFrame(loop)
      this.rafTicks += 1
      this.frame()
    }
    this.rafId = requestAnimationFrame(loop)
    /**
     * 兜底泵（**实测必需**）：
     *   当窗口被遮挡、最小化或被 Chromium 判定为不可见时，`requestAnimationFrame`
     *   会被节流甚至完全停发。桌宠场景下窗口经常被别的窗口盖住，所以必须有一个
     *   不依赖 RAF 的驱动源。两条驱动都进 `frame()`，由内部的 `lastFrameAt` +
     *   fpsCap 保证不会重复渲染。
     */
    this.pumpId = window.setInterval(() => {
      this.intervalTicks += 1
      this.frame()
    }, 8)
    /**
     * ⚠ 兜底泵间隔用 **8ms** 而不是 16ms。
     *
     * 实测（A16 采样 60s）：16ms 泵 + `fpsCap=60` 时实测 fps 稳定在 **47–50**，
     * 低于"空闲 ≥50fps"的判据门槛。原因是 16ms 与 vsync 的 16.67ms 错位：
     * 泵触发时若距上一帧不足 `1000/60`，`frame()` 会直接 return，
     * 于是**跳过整帧**、实际只有 ~50fps。
     * 8ms 泵让"检查"足够密，`frame()` 内部仍由 `lastFrameAt + fpsCap` 去重，
     * 不会重复渲染，但不会再白白跳帧。
     */

    // 立刻画一帧：这样"有没有渲染"这件事在第一帧就有证据（而不是等下一个 RAF）
    this.frame()
  }

  stop(): void {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    if (this.pumpId) { window.clearInterval(this.pumpId); this.pumpId = 0 }
  }

  /** 窗口不可见时暂停渲染（判据 A16：空闲帧率与内存） */
  private onVisibility = (): void => {
    this.paused = document.visibilityState === 'hidden'
  }

  private onResize = (): void => {
    /**
     * ⚠ **必须量"容器"而不是 canvas 自身**（本轮实测踩到的真实缺陷）：
     *
     * 旧实现用 `canvas.getBoundingClientRect()` 并 `setSize(cw, ch, true)`。
     * `updateStyle = true` 会让 three 把 canvas 的 CSS 尺寸**写成内联样式**
     * （`canvas.style.width = '90px'`），内联样式**压过** `.stage-canvas{width:100%}`
     * ⇒ canvas 的尺寸不再跟随布局，而 `getBoundingClientRect()` 又只会读回这个被钉死的值
     * ⇒ `ResizeObserver(canvas)` 永远看不到"布局变了"，**尺寸再也长不回去**。
     *
     * 实测症状（`--probe layoutDiag -Mode pet`，原始 JSON 见证据目录）：
     *   `.stage-slot` = **340×420**，而 `canvas` = **90×289**（= panel 布局下"窗口 340 宽 −
     *   侧栏 250"与"420 高 − 标题栏/状态栏 131"的残留值），角色因此缩在窗口左上角。
     *
     * 现在：量 `parentElement`（布局盒），并 `setSize(..., false)` 不写内联样式，
     * 同时观察容器 —— 画布尺寸**只能**由布局决定。
     */
    const host = this.canvas.parentElement ?? this.canvas
    const rect = host.getBoundingClientRect()
    const cw = Math.max(1, Math.round(rect.width || host.clientWidth || this.canvas.clientWidth || 1))
    const ch = Math.max(1, Math.round(rect.height || host.clientHeight || this.canvas.clientHeight || 1))
    // 清掉历史遗留的内联尺寸（旧版本写入过），让 CSS 的 100% 重新生效
    if (this.canvas.style.width || this.canvas.style.height) {
      this.canvas.style.width = ''
      this.canvas.style.height = ''
    }
    this.renderer.setSize(cw, ch, false)
    this.camera.aspect = cw / ch
    this.camera.updateProjectionMatrix()
    /**
     * ★ 尺寸/宽高比变化：**只更新投影**，不再重取景。
     *
     * 规格要求"ResizeObserver 只能更新 canvas 尺寸和 projection aspect；
     * 只有画布宽高比变化超过明确阈值，才允许重新计算投影，不得重新追逐当前动画包围盒"。
     *
     * 旧实现在这里无条件调 `reframe()`，而 `reframe()` 会按**当前动画帧**的
     * 蒙皮顶点重摆相机 ⇒ 拖动改变窗口尺寸时**持续重取景**，角色在画布中漂移。
     * 现在：宽高比变化 < 阈值直接返回；≥ 阈值才重算距离（投影中心保持不动，
     * 因为 `reframe()` 已改为只用固定 rest 尺寸 + 锚点）。
     */
    const prevAspect = this.lastAspect
    this.lastAspect = this.camera.aspect
    if (this.vrm && Math.abs(this.camera.aspect - prevAspect) >= ASPECT_CHANGE_THRESHOLD) {
      this.reframe(this.vrm)
    }
  }

  private frame(): void {
    if (this.disposed) return
    const now = performance.now()
    if (this.paused) { this.lastFrameAt = now; return }
    // 帧率上限（省电；判据 A16 要求空闲 ≥50fps，60 上限安全）
    if (this.lastFrameAt && now - this.lastFrameAt < 1000 / this.fpsCap) return
    const dtRaw = (now - this.lastFrameAt) / 1000 || this.clock.getDelta()
    this.lastFrameAt = now
    const dt = clamp(dtRaw, 0, 1 / 15)

    // ① 状态机时间轴
    this.director.tick()

    /**
     * ①b **把决策落到 mixer 上**。
     *
     * ⚠ 这是一个**真实缺陷的修复**（由 2 小时浸泡回归的"动画时钟"读数暴露）：
     * `director.tick()` 每 12 秒就会把 `baseClipId` 轮换到下一个待机动作，
     * 但在此之前**没有任何地方把轮换结果应用到 mixer** —— 只有
     * `requestMotion` / `setDragging` 这类**显式请求**才会调 `applyTarget`。
     * 后果：`baseClipId` 每 12 秒变一次（状态栏、探针、验收读数全都"正常"），
     * 而实际播放的始终是最初那个动作。
     *
     * 铁证（修复前，2 小时浸泡的 9 个采样点，跨 120 秒、clip 已轮换 6 次）：
     * `activeTimeSec` 与 `activeDurationSec` **恒为 2.45** —— 说明 action 停在片尾不动。
     * 这类"读数在动、画面没动"的故障最容易骗过验收，因为它让所有既有断言都通过。
     *
     * 判据用"决策的目标 clip 是否已应用过"（`lastAppliedBase`），而不是每帧调一次 ——
     * 后者会每帧重置一次交叉淡化，动作永远淡不完。
     */
    const wantedBase = this.director.getBaseClipId()
    if (wantedBase && wantedBase !== this.lastAppliedBase) {
      this.applyTarget({ clipId: wantedBase, weight: 1, fadeSec: this.director.getFadeSec() })
    }

    // ② 基础动作：mixer
    if (this.mixer) this.mixer.update(dt)

    /**
     * ②b 锚点兜底。
     *
     * 历史背景（为什么这里曾有一整段"重取景"）：装载时算包围盒时还没有任何动作生效，
     * 而待机动作会改变 hips 根位移与全身姿态 ⇒ 那时算出的取景在动作生效后不再成立
     * （实测：装载时包围盒在视锥内，运行后 `screenRect.x = -43`，角色左半身被推出画布）。
     * 旧代码的解法是"每帧按当前动画帧重算"，于是引入了不收敛的漂移。
     */
    if (!this.anchoredOnce && this.vrm && this.activeAction) {
      /**
       * ★ 本轮**移除了**"首个活动动画生效后再居中 + 重取景"这段。
       *
       * 为什么必须移除（实测根因）：它按**当前动画帧**的蒙皮顶点去
       * ① 平移 `vrm.scene.position`、② 重摆相机 —— 两个动态量互相影响。
       * 待机动作切换、根位移变化、resize 都会让它重算 ⇒ 角色在画布里不断移动，
       * 最终跑出视锥（诊断：`inFrustum=false`、`screenRect.x≈-940`）。
       *
       * 现在：锚点与取景在 `anchorAndFrameOnce()` 里用**固定 rest 姿势**算一次，
       * 此后 `vrm.scene.position` 与相机参数都不再随帧变化。
       * 这里只保留"锚点尚未建立就补建"的兜底（正常装载阶段已建立）。
       */
      this.reframe(this.vrm)
    }

    // ③ 摇晃叠加（拖拽弹簧）—— 乘在骨骼**之上**
    this.applySway(dt)

    // ④ 表演叠加：表情 / 眨眼 / 口型 / 视线
    const nowSec = now / 1000
    this.overlays.setBlink(stepBlink(this.blink, nowSec, dt, this.reducedMotion))
    this.overlays.update(dt)

    // ⑤ 物理（springBone）
    if (this.vrm) this.vrm.update(dt)

    // ⑥ 渲染
    this.renderer.render(this.scene, this.camera)
    this.lastRenderAt = Date.now()

    // ⑦ 统计
    this.accountFrame(now, dt)
  }

  private applySway(dt: number): void {
    const hips = this.vrm?.humanoid?.getNormalizedBoneNode('hips' as RequiredBone)
    const dx = this.dragging ? this.windowDelta.x : 0
    const dy = this.dragging ? this.windowDelta.y : 0
    this.windowDelta = { x: 0, y: 0 }
    this.mouseDelta = { x: 0, y: 0 }
    this.sway = stepSway(this.sway, { dx, dy, dragging: this.dragging, dtSec: dt })
    if (!hips || !this.hipsRest) return
    const w = this.sway.weight
    const xDeg = this.sway.leanX.x * w
    const zDeg = this.sway.leanZ.x * w
    if (Math.abs(xDeg) < 0.01 && Math.abs(zDeg) < 0.01) return
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((xDeg * Math.PI) / 180, 0, (zDeg * Math.PI) / 180))
    // **右乘**：叠加在基础动作之上，不覆盖主动作
    hips.quaternion.multiply(q)
  }

  private accountFrame(now: number, dt: number): void {
    this.frameTimes.push(now)
    while (this.frameTimes.length && now - (this.frameTimes[0] ?? now) > 5000) this.frameTimes.shift()
    const last1s = this.frameTimes.filter(t => now - t <= 1000).length
    this.fpsSamples.push(last1s)
    if (this.fpsSamples.length > 600) this.fpsSamples.shift()
    // 骨骼活动量（判据 A12）
    const vrm = this.vrm
    if (!vrm) return
    for (const b of REQUIRED_BONES) {
      const node = vrm.humanoid?.getNormalizedBoneNode(b)
      if (!node) continue
      const prev = this.prevBoneQuat.get(b)
      if (prev) {
        const dot = Math.abs(prev.dot(node.quaternion))
        const angle = (2 * Math.acos(clamp(dot, 0, 1)) * 180) / Math.PI
        if (Number.isFinite(angle)) this.boneTravel.set(b, (this.boneTravel.get(b) ?? 0) + angle)
      }
      this.prevBoneQuat.set(b, node.quaternion.clone())
    }
    void dt
  }

  // ───────────────────────────────────────────────────── 动作控制

  /** 把 director 的目标落实到 mixer（交叉淡化） */
  private applyTarget(target: MotionTarget): void {
    const entry = this.clips.get(target.clipId)
    if (!entry || !this.mixer) return
    const { action } = entry
    if (this.activeAction === action) {
      action.setEffectiveWeight(target.weight)
      this.lastAppliedBase = target.clipId
      return
    }
    action.reset()
    action.enabled = true
    action.setEffectiveWeight(target.weight)
    if (target.fadeSec > 0) action.fadeIn(target.fadeSec)
    action.play()
    if (this.activeAction && this.activeAction !== action) {
      if (target.fadeSec > 0) this.activeAction.fadeOut(target.fadeSec)
      else this.activeAction.stop()
    }
    this.activeAction = action
    /**
     * 记录"已应用的目标 clip"。主循环据此判断待机轮换是否已经落到 mixer 上
     * （见 `animate()` 里 ①b 的注释：漏掉这一步会导致"读数在轮换、画面没动"）。
     */
    this.lastAppliedBase = target.clipId
  }

  requestMotion(motion: string, opts: { once?: boolean, fadeMs?: number, interrupt?: boolean } = {}): boolean {
    /**
     * ★ **单点屏蔽**（用户 2026-09-27 决定，方案 C）。
     *
     * 屏蔽 `sleep` 的唯一原因：该 clip 的 hips 平移放大后行程 y 4.53 m / z 10.30 m
     * （荒谬值），钉死根位移后"躺下"分量丢失 ⇒ 呈现**站姿抱臂**这一明显错误的姿态。
     * 放在这里而不是放在轮盘里，是为了让**轮盘、聊天 Act 标记、验收探针**三条入口同时生效
     * —— 只挡轮盘的话，聊天里一句 `[motion:sleep]` 就能把它放出来。
     *
     * 恢复步骤见 `packages/shared/src/settings.ts` 的 `DISABLED_MOTION_SEMANTICS`。
     */
    const blocked = (DISABLED_MOTION_SEMANTICS as readonly string[]).includes(motion)
    if (blocked) {
      this.disabledMotionHits.push({ motion, at: Date.now() })
      this.notice(
        `动作语义 "${motion}" 已被临时屏蔽（资产姿态不正确，见 DISABLED_MOTION_SEMANTICS）⇒ 忽略本次请求`,
        'MOTION_SEMANTIC_DISABLED',
      )
      return false
    }
    const t = this.director.request(motion, { once: opts.once, fadeMs: opts.fadeMs })
    if (!t) return false
    this.applyTarget(t)
    return true
  }

  /**
   * 被屏蔽语义的请求记录（探针 `clipPoses` 用它证明"确实被挡住了"，
   * 而不是"调用方忘了发请求"）。
   */
  disabledMotionHits: Array<{ motion: string, at: number }> = []

  /**
   * 验收探针：**强制切到待机池里的下一个动作**。
   *
   * 为什么需要它（而不是用 `requestMotion(id)`）：`DecisionEngine.request()` 是按
   * **语义或正则**匹配的，`idle_pet_idle_1` 的正则会先命中 `idle_pet_idle_10` ⇒
   * 无法用它逐个遍历 10 个待机动作（判据"切换 10 个动作相机不变"）。
   * 这里走 `nextIdle()` + `applyTarget()`，与**自然轮换完全同一条路径**，
   * 只跳过"什么时候切"的时间策略。
   */
  probeNextIdle(): { clipId: string | null, applied: boolean, baseClipId: string | null } {
    const t = this.director.nextIdle(false)
    if (!t.clipId) return { clipId: null, applied: false, baseClipId: this.director.getBaseClipId() }
    this.applyTarget(t)
    return { clipId: t.clipId, applied: true, baseClipId: this.director.getBaseClipId() }
  }

  setDragging(on: boolean): void {
    if (this.dragging === on) return
    this.dragging = on
    const t = on ? this.director.beginDrag() : this.director.endDrag()
    if (t) this.applyTarget(t)
  }

  /** 主进程回报的窗口位移（驱动摇晃；与 Mate 一致用真实位移） */
  onWindowDelta(dx: number, dy: number): void {
    this.windowDelta = { x: this.windowDelta.x + dx, y: this.windowDelta.y + dy }
  }

  /**
   * 验收探针：直接喂入窗口位移并推进 N 帧，读出摇晃叠加层的实际状态。
   *
   * 为什么需要它（判据 A14 的"确定性测量"）：
   *   A14 要求"拖拽期间 PET_DRAGGING 生效、松手后弹簧回正"。
   *   若靠真实鼠标注入，位移取决于光标真实轨迹，**不可复现**；
   *   这里直接喂入已知位移序列，得到的是可复现的数字。
   *   喂入的位移与真实拖拽走的是**同一条代码路径**（`onWindowDelta` → `stepSway` → 骨骼右乘）。
   */
  probeSway(deltas: Array<[number, number]>, dragging: boolean, fps = 60): {
    maxAbsLeanZ: number
    maxAbsLeanX: number
    limbZ: number
    limbX: number
    weight: number
    atRest: boolean
    baseClipId: string | null
    hipsQuatAfter: { x: number, y: number, z: number, w: number } | null
  } {
    const dt = 1 / Math.max(1, fps)
    let maxZ = 0
    let maxX = 0
    for (const [dx, dy] of deltas) {
      this.windowDelta = { x: this.windowDelta.x + dx, y: this.windowDelta.y + dy }
      // 复用真实帧里的同一条路径：推 mixer（若在播）→ 应用摇晃
      this.applySway(dt)
      maxZ = Math.max(maxZ, Math.abs(this.sway.leanZ.x))
      maxX = Math.max(maxX, Math.abs(this.sway.leanX.x))
    }
    void dragging
    const hips = this.vrm?.humanoid?.getNormalizedBoneNode('hips' as RequiredBone)
    return {
      maxAbsLeanZ: Number(maxZ.toFixed(3)),
      maxAbsLeanX: Number(maxX.toFixed(3)),
      limbZ: Number(this.sway.limbZ.toFixed(3)),
      limbX: Number(this.sway.limbX.toFixed(3)),
      weight: Number(this.sway.weight.toFixed(3)),
      atRest: swayAtRest(this.sway),
      baseClipId: this.director.getBaseClipId(),
      hipsQuatAfter: hips
        ? { x: Number(hips.quaternion.x.toFixed(5)), y: Number(hips.quaternion.y.toFixed(5)), z: Number(hips.quaternion.z.toFixed(5)), w: Number(hips.quaternion.w.toFixed(5)) }
        : null,
    }
  }

  onMouseDelta(dx: number, dy: number): void {
    this.mouseDelta = { x: this.mouseDelta.x + dx * TUNING.mouseSensitivity, y: this.mouseDelta.y + dy * TUNING.mouseSensitivity }
  }

  setEmotion(name: EmotionName, intensity: number, durationMs: number | null): void {
    this.overlays.setEmotion(name, intensity, durationMs)
  }

  setViseme(name: VisemeName, weight: number): void {
    this.overlays.setViseme(name, weight)
  }

  setLookTarget(x: number | null, y: number | null): void {
    this.overlays.setLookTarget(x, y)
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on
    this.overlays.setReducedMotion(on)
  }

  /**
   * 切换"不透明背景"模式（**诊断/对照实验用**，也用于 panel 模式）。
   *
   * 为什么需要它：当"draw call 正常、材质正常、取景正常、坐标三方一致，但屏幕上没有像素"时，
   * 剩下的唯一嫌疑就是**透明合成路径**（Chromium 合成透明 WebGL canvas 到透明无边框窗口）。
   * 把清屏色改成不透明，可以把"取景/材质问题"与"合成问题"一刀切开：
   *   · 不透明时角色可见 ⇒ 问题在透明合成；
   *   · 不透明时仍不可见 ⇒ 问题在取景或材质。
   */
  setOpaqueBackground(on: boolean, color = 0x101018): void {
    if (on) this.renderer.setClearColor(color, 1)
    else this.renderer.setClearColor(0x000000, 0)
    this.opaqueBackground = on
  }

  // ───────────────────────────────────────────────────── 诊断

  /**
   * **固定锚点命中椭圆**（画布 CSS 像素）。
   *
   * 与 `avatarBox()` 的关键区别：这里**不使用**当前动画帧的 `skinnedBounds()`
   * —— 那个量会随动作切换与根位移漂移，导致"角色明明在视觉中心、却点不到"
   * 或"点在空白处却被判定命中角色"。改为由**固定锚点 + 固定比例 + 显式缩放**推出：
   *   · 圆心 = 舞台锚点（横向 `anchorXRatio`；纵向按基线往上抬一个纵向半轴）；
   *   · 半径 = rest 身高 × 固定比例 × 用户缩放，再按当前投影换算成画布像素。
   * 这样命中的是"角色的**驻留区域**"，与在播哪个 clip 无关（正是规格要求）。
   */
  avatarHitEllipse(): { cx: number, cy: number, rx: number, ry: number } | null {
    const rect = this.canvas.getBoundingClientRect()
    if (!(rect.width > 0 && rect.height > 0)) return null
    const h = this.restHeightForReframe
    const pxPerMeter = this.pixelsPerMeterAtAnchor()
    const rx = Math.max(18, h * 0.30 * pxPerMeter * this.avatarScale)
    const ry = Math.max(30, h * 0.52 * pxPerMeter * this.avatarScale)
    const a = this.stageAnchorPx()
    // 锚点是"底部基线"，所以圆心要往上抬一个纵向半轴
    return { cx: a.x, cy: a.y - ry, rx, ry }
  }

  /**
   * **固定锚点包围盒**（画布 CSS 像素）—— 轮盘锚点的唯一来源。
   *
   * 为什么轮盘不能用 `avatarBox()`（动态蒙皮包围盒）：
   * A10 要求"开→关→开三次锚点误差 ≤ 2px"，而动态包围盒会随在播动作的关节姿态
   * 每帧变几个像素 ⇒ 三次开合读到三个不同的锚点，判据必然不过。
   * 这里由固定锚点椭圆推出，与在播哪个 clip **完全无关**。
   */
  avatarAnchorBox(): { x: number, y: number, w: number, h: number } | null {
    const e = this.avatarHitEllipse()
    if (!e) return null
    return { x: e.cx - e.rx, y: e.cy - e.ry, w: e.rx * 2, h: e.ry * 2 }
  }

  /**
   * 锚点处的"每米多少 CSS 像素"。
   * 用相机参数实测而不是靠固定常数 —— fov / 距离 / aspect 都会影响它。
   */
  private pixelsPerMeterAtAnchor(): number {
    const rect = this.canvas.getBoundingClientRect()
    const h = Math.max(1, rect.height)
    const vFov = (this.camera.fov * Math.PI) / 180
    const worldHeightAtDist = 2 * Math.max(0.001, this.cameraDist) * Math.tan(vFov / 2)
    return h / Math.max(0.001, worldHeightAtDist)
  }

  /**
   * **显式缩放**（只由设置/缩放控件修改；单击、拖动、轮盘、动作切换都不得改）。
   *
   * 为什么围绕锚点缩放是安全的：模型内容中心已被固化到世界原点
   * （见 `anchorAndFrameOnce`），而相机水平朝向该原点 ⇒ 缩放时
   * **投影中心不动**，只有尺寸变化 ⇒ 满足"中心点与底部基线保持不变"。
   */
  setAvatarScale(scale: number): void {
    const clamped = Math.min(1.40, Math.max(0.70, Number.isFinite(scale) ? scale : 1))
    if (clamped === this.avatarScale) return
    this.avatarScale = clamped
    /**
     * 锚点还没建立时**只记值**：此时 `restLocalCenter` / `restWorldBaselineY`
     * 还是默认零值，直接套用会把模型根节点平移到错误位置。
     * 建立锚点的 `anchorAndFrameOnce()` 末尾会调 `applySceneTransform()` 施加它。
     */
    if (!this.anchoredOnce) return
    this.applySceneTransform()
    this.notice(`角色缩放 → ${(clamped * 100).toFixed(0)}%（围绕固定锚点，中心与基线不动）`, 'AVATAR_SCALE_APPLIED')
  }

  getAvatarScale(): number { return this.avatarScale }

  private avatarScale = 1

  /**
   * 角色在画布内的包围盒（CSS 像素）—— 轮盘锚点与命中区域**同源**。
   *
   * ⚠ 必须优先使用**实测蒙皮内容包围盒**（`skinnedBounds()`），不能用 `Box3.setFromObject`：
   *   后者对 `SkinnedMesh` 用几何局部坐标过 `matrixWorld`，**不经过蒙皮矩阵**，
   *   也**不含运行时自动居中的位移** ⇒ 会给出 `x=-589` 这种"角色在窗口外"的错误结果，
   *   进而把轮盘锚点推到屏幕外（实测：`anchorX=-496`，命中测试 8 个方向全 false）。
   *
   * ⚠ 但**不要**用它做命中判定 —— 它是动态量，会随动作漂移。命中请用
   *   `avatarHitEllipse()`（固定锚点）。
   */
  avatarBox(): { x: number, y: number, w: number, h: number } | null {
    const vrm = this.vrm
    if (!vrm) return null
    const rect = this.canvas.getBoundingClientRect()
    const b = this.skinnedBounds(60, 600)
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
    if (b.ok) {
      // 实测世界包围盒的 8 个角点投影
      for (const x of [b.min.x, b.max.x]) {
        for (const y of [b.min.y, b.max.y]) {
          for (const z of [b.min.z, b.max.z]) {
            const v = new THREE.Vector3(x, y, z).project(this.camera)
            const sx = (v.x * 0.5 + 0.5) * rect.width
            const sy = (-v.y * 0.5 + 0.5) * rect.height
            if (sx < minX) minX = sx
            if (sx > maxX) maxX = sx
            if (sy < minY) minY = sy
            if (sy > maxY) maxY = sy
          }
        }
      }
    } else {
      // 兜底：旧的包围盒路径（已知对蒙皮网格不准，仅当日志已告警时使用）
      const box = new THREE.Box3().setFromObject(vrm.scene)
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            const v = new THREE.Vector3(x, y, z).project(this.camera)
            const sx = (v.x * 0.5 + 0.5) * rect.width
            const sy = (-v.y * 0.5 + 0.5) * rect.height
            if (sx < minX) minX = sx
            if (sx > maxX) maxX = sx
            if (sy < minY) minY = sy
            if (sy > maxY) maxY = sy
          }
        }
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
    return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) }
  }

  /** 只读诊断快照（验收探针的唯一数据源） */
  snapshot(): StageSnapshot {
    const vrm = this.vrm
    const bones: Record<string, { x: number, y: number, z: number, w: number }> = {}
    if (vrm) {
      for (const b of REQUIRED_BONES) {
        const node = vrm.humanoid?.getNormalizedBoneNode(b)
        if (node) bones[b] = { x: node.quaternion.x, y: node.quaternion.y, z: node.quaternion.z, w: node.quaternion.w }
      }
    }
    const ds = {
      phase: this.director.getPhase(),
      baseClipId: this.director.getBaseClipId(),
      crossfade: { from: null as string | null, to: this.director.getBaseClipId(), t: 1 },
      idleIndex: this.director.getIdleIndex(),
      idleTotal: this.director.getIdleTotal(),
      dragging: this.director.isDragging(),
      warnings: this.director.getWarnings(),
    }
    const fps1 = this.frameTimes.filter(t => performance.now() - t <= 1000).length
    const fps5 = this.frameTimes.length > 1
      ? this.frameTimes.length / Math.max(0.001, (performance.now() - (this.frameTimes[0] ?? performance.now())) / 1000)
      : 0
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    return {
      stageId: this.stageId,
      rendererId: this.rendererId,
      mixerId: this.mixerId ?? 'none',
      vrmInstanceId: this.vrmInstanceId ?? 'none',
      sceneCount: stageCounters.scenes,
      rendererCount: stageCounters.renderers,
      mixerCount: stageCounters.mixers,
      vrmCount: stageCounters.vrms,
      live2dCount: stageCounters.live2d,
      activeClip: this.activeAction ? (this.activeAction.getClip().name || ds.baseClipId) : null,
      activeWeight: this.activeAction?.getEffectiveWeight() ?? 0,
      /**
       * **动画时钟**：所有**正在跑**的动作里最大的播放时间，与它自己的时长（秒）。
       *
       * 为什么不是 `this.activeAction.time`（实测踩到）：那个引用是**陈旧的** ——
       * 实测它在 9 个采样点（跨 120 秒、clip 已轮换 6 次）里恒为 `2.45`，
       * 而 `activeDurationSec` 也恒为 `2.45`，看上去"正好播到结尾"，
       * 极易被当成正常。它能骗过任何"看数值是否合理"的检查。
       *
       * 真相：交叉淡化期间同时有多个 action 在跑，`this.activeAction` 只是其中一个
       * 早期赋值的引用。所以这里改成遍历 mixer 的全部 action，取**权重 > 0 且时间最大**的那个 ——
       * 这个值随 `mixer.update()` 单调推进并回绕，不推进就只能说明渲染循环或 mixer 停了。
       */
      activeTimeSec: (() => {
        const running = this.runningActionClock()
        return running ? Number(running.time.toFixed(3)) : null
      })(),
      activeDurationSec: (() => {
        const running = this.runningActionClock()
        return running ? Number(running.duration.toFixed(3)) : null
      })(),
      /**
       * 动作相位。`ds.phase` 一直由决策引擎提供，但 `StageSnapshot` 的
       * 返回类型一度漏了这个字段 —— 类型检查（`npm run typecheck`）抓到后补上。
       * 相位的价值：`idle` 与 `oneShot` 的行为不同（前者会 12s 轮换、后者不会），
       * 出问题时"现在是什么相位"往往比"在播哪个 clip"更直接。
       */
      phase: ds.phase,
      baseClipId: ds.baseClipId,
      crossfade: ds.crossfade,
      idleIndex: ds.idleIndex,
      idleTotal: ds.idleTotal,
      dragging: ds.dragging,
      bones,
      boneTravelAccum: Object.fromEntries(this.boneTravel),
      fps: { avg1s: fps1, avg5s: Number(fps5.toFixed(1)) },
      heapMB: mem ? Number((mem.usedJSHeapSize / 1048576).toFixed(1)) : 0,
      wheel: { open: false, cx: 0, cy: 0, scale: 0 },
      modelId: this.modelId,
      modelLoadMs: this.modelLoadMs,
      warnings: [...this.warnings, ...ds.warnings],
      view: this.viewDiagnostics(),
    }
  }

  /**
   * 取景/渲染实测诊断。
   *
   * 为什么需要它（实测教训）："模型加载成功但画面里看不见"这类问题，
   * 靠看代码猜（相机距离？材质？视锥？）会连续猜错。这里一次性把
   * canvas 尺寸、相机位姿、包围盒、视锥判定、可见网格数、draw call 全部测出来，
   * 让判据落在数据上。
   */
  private viewDiagnostics(): StageSnapshot['view'] {
    const rect = this.canvas.getBoundingClientRect()
    const cssW = Math.round(rect.width) || this.canvas.clientWidth || this.canvas.width
    const cssH = Math.round(rect.height) || this.canvas.clientHeight || this.canvas.height
    const bufW = this.canvas.width
    const bufH = this.canvas.height
    const rs = new THREE.Vector2()
    this.renderer.getSize(rs)
    let min = { x: 0, y: 0, z: 0 }
    let max = { x: 0, y: 0, z: 0 }
    let size = { x: 0, y: 0, z: 0 }
    let inFrustum = false
    let visibleMeshes = 0
    let mtoonMeshes = 0
    let skinnedMeshes = 0

    if (this.vrm) {
      const box = new THREE.Box3().setFromObject(this.vrm.scene)
      /**
       * ⚠ `Box3.setFromObject` **不经过蒙皮矩阵**：对 `SkinnedMesh` 它用的是几何局部坐标
       *   过 `matrixWorld`，于是包围盒停在原点附近（实测：真实蒙皮顶点在 x≈4.6m，
       *   而它给 x≈0）。用它做视锥判定会把"角色在画外"判成"在画内"——
       *   这正是录像里"舞台全空白、状态栏一切正常"能骗过检查的原因。
       * 因此视锥判定优先用**实测蒙皮顶点**包围盒（`skinnedBounds()`）。
       */
      const sk = this.skinnedBounds(60, 900)
      const vis = sk.ok ? sk : null
      const vmin = vis ? vis.min : box.min
      const vmax = vis ? vis.max : box.max
      const s = new THREE.Vector3(vmax.x - vmin.x, vmax.y - vmin.y, vmax.z - vmin.z)
      min = { x: vmin.x, y: vmin.y, z: vmin.z }
      max = { x: vmax.x, y: vmax.y, z: vmax.z }
      size = { x: s.x, y: s.y, z: s.z }

      // 视锥判定：包围盒 8 角点做投影，任一落在 NDC [-1,1] 内即认为可见
      const corners: THREE.Vector3[] = []
      for (const x of [vmin.x, vmax.x]) {
        for (const y of [vmin.y, vmax.y]) {
          for (const z of [vmin.z, vmax.z]) corners.push(new THREE.Vector3(x, y, z))
        }
      }
      this.camera.updateMatrixWorld()
      const frustum = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse),
      )
      inFrustum = corners.some(c => frustum.containsPoint(c))
        || frustum.intersectsBox(new THREE.Box3(
          new THREE.Vector3(vmin.x, vmin.y, vmin.z),
          new THREE.Vector3(vmax.x, vmax.y, vmax.z),
        ))

      this.vrm.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return
        if (obj.visible) visibleMeshes++
        if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) skinnedMeshes++
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
        const arr = Array.isArray(mat) ? mat : (mat ? [mat] : [])
        if (arr.some(m => (m as unknown as { isMToonMaterial?: boolean }).isMToonMaterial)) mtoonMeshes++
      })
    }

    const camPos = this.camera.position
    const target = this.vrm ? new THREE.Box3().setFromObject(this.vrm.scene).getCenter(new THREE.Vector3()) : new THREE.Vector3()
    return {
      canvasCss: { w: cssW, h: cssH },
      canvasBuffer: { w: bufW, h: bufH },
      rendererSize: { w: Math.round(rs.x), h: Math.round(rs.y) },
      pixelRatio: this.renderer.getPixelRatio(),
      devicePixelRatio: window.devicePixelRatio || 1,
      cameraPos: { x: Number(camPos.x.toFixed(3)), y: Number(camPos.y.toFixed(3)), z: Number(camPos.z.toFixed(3)) },
      cameraDist: Number(camPos.distanceTo(target).toFixed(3)),
      near: this.camera.near,
      far: this.camera.far,
      fov: this.camera.fov,
      modelBox: this.vrm ? { min, max, size } : null,
      inFrustum,
      visibleMeshes,
      mtoonMeshes,
      skinnedMeshes,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      lastRenderAt: this.lastRenderAt,
      rafTicks: this.rafTicks,
      intervalTicks: this.intervalTicks,
      paused: this.paused,
      /** 角色投影到画布内的屏幕矩形（CSS 像素）—— 证明"角色落在画布内的哪个位置" */
      screenRect: this.screenRect(),
      /** WebGL 帧缓冲回读：画布中心 1/4 区域里"非清屏色"像素比例 */
      canvasNonBgRatio: this.canvasNonBgRatio(),
      /**
       * 模型自身的健康度读数（plain 对象，供 IPC 取用）。
       * 这是"相机正常但模型看不见"的定位依据：
       *   · `meshWorldScale` 近乎 0 ⇒ 蒙皮/归一化骨骼尺度塌缩（VRMA hips rest 与模型 rest 不匹配的典型症状）；
       *   · `headWorldY < hipsWorldY` ⇒ 骨架上下颠倒（RootQ 未丢弃的症状）；
       *   · `maxVertices` 极小而 `skinnedMeshes` 正常 ⇒ 几何被优化掉/索引失效。
       */
      modelHealth: this.modelHealth(),
    }
  }

  /** 模型健康度快照（全部为 plain 值，可安全跨 IPC） */
  private modelHealth(): {
    meshWorldScale: number
    hipsWorldY: number | null
    headWorldY: number | null
    leftFootWorldY: number | null
    vrmRestHipsY: number | null
    maxVertices: number
    animationRestHipsY: number | null
    clearColorRgb: { r: number, g: number, b: number, a: number }
    /** 画布中心 3×3 采样点的 RGBA（分辨"到底画了什么颜色"） */
    pixelSamples: Array<{ x: number, y: number, rgba: [number, number, number, number] }>
    /** 蒙皮自检：骨骼数 / 反绑定矩阵前 2 项 / 首顶点蒙皮索引与权重 */
    skin: {
      skinnedMeshCount: number
      boneCount: number
      boneInversesSample: number[]
      firstVertexSkinIndex: number[]
      firstVertexSkinWeight: number[]
      hasSkinAttribute: boolean
    }
    /** 可信像素统计（众数颜色为背景基准） */
    pixelStats: {
      total: number
      nonBg: number
      ratio: number
      bgMode: [number, number, number]
      contentBox: { x: number, y: number, w: number, h: number } | null
    }
    /** 逐 mesh 绘制可行性 */
    meshDraw: Array<{
      name: string, visible: boolean, materialVisible: boolean, hasIndex: boolean,
      indexCount: number, positionCount: number, drawRangeCount: number, inScene: boolean,
    }>
    /**
     * **蒙皮顶点实测**：手动按 three.js 的蒙皮公式算若干顶点的世界坐标。
     * 这是"提交了 draw call 但一个像素都没覆盖"的最终判据 ——
     * 若顶点算出来落在视锥外或 NaN，就直接证明是蒙皮环节。
     */
    skinProbe: {
      meshName: string
      vertexCount: number
      /** 探针自身的失败原因（null = 成功） */
      reason: string | null
      attrNames: string[]
      boneMatrixCount: number
      samples: Array<{
        i: number
        local: [number, number, number]
        world: [number, number, number]
        ndc: [number, number, number]
        skinIndex: [number, number, number, number]
        skinWeight: [number, number, number, number]
        weightSum: number
      }>
    } | null
  } {
    const vrm = this.vrm
    const clearColor = this.clearColorRgb()
    const empty = {
      meshWorldScale: 0, hipsWorldY: null, headWorldY: null, leftFootWorldY: null,
      vrmRestHipsY: null, maxVertices: 0, animationRestHipsY: null,
      clearColorRgb: clearColor,
      pixelSamples: [] as Array<{ x: number, y: number, rgba: [number, number, number, number] }>,
      skin: {
        skinnedMeshCount: 0, boneCount: 0, boneInversesSample: [] as number[],
        firstVertexSkinIndex: [] as number[], firstVertexSkinWeight: [] as number[], hasSkinAttribute: false,
      },
      pixelStats: {
        total: 0, nonBg: 0, ratio: -1,
        bgMode: [0, 0, 0] as [number, number, number], contentBox: null,
      },
      meshDraw: [] as Array<{
        name: string, visible: boolean, materialVisible: boolean, hasIndex: boolean,
        indexCount: number, positionCount: number, drawRangeCount: number, inScene: boolean,
      }>,
      skinProbe: null,
    }
    if (!vrm) return empty

    // ── 实际像素采样（这是判定基准的唯一可信来源）
    const pixelSamples: Array<{ x: number, y: number, rgba: [number, number, number, number] }> = []
    try {
      const gl = this.renderer.getContext()
      const w = gl.drawingBufferWidth
      const h = gl.drawingBufferHeight
      for (const [fx, fy] of [[0.5, 0.45], [0.5, 0.3], [0.5, 0.6], [0.3, 0.5], [0.7, 0.5], [0.5, 0.1], [0.5, 0.9]] as Array<[number, number]>) {
        const px = new Uint8Array(4)
        gl.readPixels(Math.floor(w * fx), Math.floor(h * (1 - fy)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
        pixelSamples.push({ x: Math.floor(w * fx), y: Math.floor(h * (1 - fy)), rgba: [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, px[3] ?? 0] })
      }
    } catch { /* ignore */ }

    let maxVertices = 0
    let scaleAccum = 0
    let scaleCount = 0
    vrm.scene.updateMatrixWorld(true)
    const v = new THREE.Vector3()
    const skin = {
      skinnedMeshCount: 0, boneCount: 0, boneInversesSample: [] as number[],
      firstVertexSkinIndex: [] as number[], firstVertexSkinWeight: [] as number[], hasSkinAttribute: false,
    }
    vrm.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if ((mesh as unknown as { isMesh?: boolean }).isMesh) {
        const geo = mesh.geometry as THREE.BufferGeometry | undefined
        const pos = geo?.getAttribute('position') as { count?: number } | undefined
        if (pos?.count && pos.count > maxVertices) maxVertices = pos.count
        obj.getWorldScale(v)
        scaleAccum += Math.abs(v.x)
        scaleCount++
      }
      const sm = obj as THREE.SkinnedMesh
      if ((sm as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh && skin.skinnedMeshCount === 0) {
        skin.skinnedMeshCount++
        const sk = sm.skeleton
        skin.boneCount = sk?.bones?.length ?? 0
        const bi = sk?.boneInverses ?? []
        // 只取前两个矩阵的前 4 个元素，够判断"是不是单位矩阵/全零"
        for (let i = 0; i < Math.min(2, bi.length); i++) {
          const el = bi[i]?.elements ?? []
          skin.boneInversesSample.push(...Array.from(el.slice(0, 4)).map(n => Number(n.toFixed(3))))
        }
        const geo = sm.geometry as THREE.BufferGeometry | undefined
        const si = geo?.getAttribute('skinIndex') as { count?: number, getX?: (i: number) => number, getY?: (i: number) => number, getZ?: (i: number) => number, getW?: (i: number) => number } | undefined
        const sw = geo?.getAttribute('skinWeight') as { getX?: (i: number) => number, getY?: (i: number) => number, getZ?: (i: number) => number, getW?: (i: number) => number } | undefined
        skin.hasSkinAttribute = Boolean(si && sw)
        if (si && sw) {
          skin.firstVertexSkinIndex = [si.getX?.(0) ?? -1, si.getY?.(0) ?? -1, si.getZ?.(0) ?? -1, si.getW?.(0) ?? -1].map(n => Number(n))
          skin.firstVertexSkinWeight = [sw.getX?.(0) ?? -1, sw.getY?.(0) ?? -1, sw.getZ?.(0) ?? -1, sw.getW?.(0) ?? -1].map(n => Number(n.toFixed(3)))
        }
      }
    })
    const boneWorldY = (name: string): number | null => {
      const n = vrm.humanoid?.getNormalizedBoneNode(name as RequiredBone)
      if (!n) return null
      const w = new THREE.Vector3()
      n.getWorldPosition(w)
      return Number(w.y.toFixed(4))
    }
    /**
     * ⚠ `normalizedRestPose.hips.position` 是**三元数组** `[x, y, z]`。
     *   旧代码按 `.y` 读它 ⇒ 这里一直返回 `null`（本轮修正为按索引读）。
     */
    const restHipsArr = (vrm.humanoid as unknown as { normalizedRestPose?: { hips?: { position?: unknown } } } | undefined)
      ?.normalizedRestPose?.hips?.position
    const restHips = Array.isArray(restHipsArr) && restHipsArr.length >= 2 ? Number(restHipsArr[1]) : NaN
    return {
      meshWorldScale: scaleCount ? Number((scaleAccum / scaleCount).toFixed(5)) : 0,
      hipsWorldY: boneWorldY('hips'),
      headWorldY: boneWorldY('head'),
      leftFootWorldY: boneWorldY('leftFoot'),
      vrmRestHipsY: typeof restHips === 'number' ? Number(restHips.toFixed(4)) : null,
      maxVertices,
      animationRestHipsY: this.animationRestHipsY,
      clearColorRgb: clearColor,
      pixelSamples,
      skin,
      pixelStats: this.pixelStats(),
      meshDraw: this.meshDrawReport(),
      skinProbe: this.skinVertexProbe(),
    }
  }

  /**
   * 蒙皮顶点实测：按 three.js 的公式手动算顶点世界坐标。
   *
   * 公式依据（three.js `Skinning_vertex.glsl.js`）：
   *   `skinned = bindMatrixInverse · Σ( wᵢ · boneMatrices[i] ) · bindMatrix · position`
   * 其中 `Skeleton.update()` 里 `boneMatrices[i] = bone.matrixWorld · boneInverses[i]`。
   * ⚠ **不要再乘一次 `bone.matrixWorld`** —— `boneMatrices` 已经包含了它，
   *    多乘一次会把顶点推到很远处（这是我在设计这条探针时先写错、后对照源码修正的地方）。
   */
  private skinVertexProbe(): {
    meshName: string
    vertexCount: number
    /** 探针自身的失败原因（**不允许静默**：本项目已多次因静默 catch 让诊断失效） */
    reason: string | null
    attrNames: string[]
    boneMatrixCount: number
    samples: Array<{
      i: number
      local: [number, number, number]
      world: [number, number, number]
      ndc: [number, number, number]
      skinIndex: [number, number, number, number]
      skinWeight: [number, number, number, number]
      weightSum: number
    }>
  } | null {
    const vrm = this.vrm
    if (!vrm) return null
    let target: THREE.SkinnedMesh | null = null
    vrm.scene.traverse((obj) => {
      if (target) return
      const sm = obj as THREE.SkinnedMesh
      if ((sm as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) target = sm
    })
    const mesh = target as THREE.SkinnedMesh | null
    if (!mesh) return null
    const geo = mesh.geometry as THREE.BufferGeometry
    const attrNames = geo ? Object.keys(geo.attributes) : []
    const fail = (reason: string): {
      meshName: string, vertexCount: number, reason: string, attrNames: string[], boneMatrixCount: number, samples: []
    } => ({ meshName: String(mesh?.name || mesh?.type || '?').slice(0, 40), vertexCount: 0, reason, attrNames, boneMatrixCount: 0, samples: [] })
    try {
      /**
       * ⚠ 先把骨架推到最新：`skeleton.boneMatrices` 只有在 `update()`（或渲染）之后才有效。
       *   诊断期它恰好已被渲染更新过，所以在诊断里能读到正确值；
       *   而在装载期（本函数被 `loadMotions` 调用）必须自己推一次，否则读到的是上一帧/未初始化状态
       *   —— 这正是"诊断里能算对、取景里算不出"的原因。
       */
      try { this.mixer?.update(0) } catch { /* ignore */ }
      try { this.vrm?.update(0) } catch { /* ignore */ }
      mesh.skeleton.update()
      mesh.updateMatrixWorld(true)
      const boneMatrixCountNow = (mesh.skeleton as unknown as { boneMatrices?: Float32Array }).boneMatrices?.length ?? 0
      const boneMatrixCount = boneMatrixCountNow
      if (!geo) return fail('no-geometry')
      if (!mesh.skeleton) return fail('no-skeleton')
      const pos = geo.getAttribute('position')
      const si = geo.getAttribute('skinIndex')
      const sw = geo.getAttribute('skinWeight')
      if (!pos) return fail('no-position-attribute')
      if (!si) return fail('no-skinIndex-attribute')
      if (!sw) return fail('no-skinWeight-attribute')
      /**
       * ⚠ `skeleton.boneMatrices` 是**扁平的 Float32Array**（长度 = 骨骼数 × 16），
       *   不是 `Matrix4` 数组。按 `Matrix4[]` 取值会得到 `undefined`，
       *   随后读 `.elements` 直接抛 `Cannot read properties of undefined (reading '0')`（实测踩到）。
       *   正确做法：按 `bi * 16` 偏移读 16 个 float。
       */
      const bm = (mesh.skeleton as unknown as { boneMatrices: Float32Array }).boneMatrices
      if (!bm || !bm.length) return fail('empty-boneMatrices')
      const boneCount = Math.floor(bm.length / 16)
      const count = pos.count
      const idxs = [0, Math.floor(count / 3), Math.floor((2 * count) / 3), count - 1]
      const samples: Array<{
        i: number
        local: [number, number, number]
        world: [number, number, number]
        ndc: [number, number, number]
        skinIndex: [number, number, number, number]
        skinWeight: [number, number, number, number]
        weightSum: number
      }> = []
      for (const i of idxs) {
        if (i < 0 || i >= count) continue
        const pi = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))
        const indices = [si.getX(i), si.getY(i), si.getZ(i), si.getW(i)]
        const weights = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)]
        const weightSum = weights.reduce((a, b) => a + b, 0)
        // 累加蒙皮矩阵：按 `bi * 16` 偏移从扁平 Float32Array 读，再按权重求和
        // （three.js 的 Matrix4 没有 add()，只能逐元素累加）
        const accEl = new Float32Array(16)
        for (let k = 0; k < 4; k++) {
          const bi = indices[k] ?? 0
          const w = weights[k] ?? 0
          if (w === 0 || bi < 0 || bi >= boneCount) continue
          const off = bi * 16
          for (let n = 0; n < 16; n++) accEl[n] = (accEl[n] ?? 0) + (bm[off + n] ?? 0) * w
        }
        const acc = new THREE.Matrix4().fromArray(Array.from(accEl))
        const world = pi.clone().applyMatrix4(mesh.bindMatrix as THREE.Matrix4).applyMatrix4(acc).applyMatrix4(mesh.bindMatrixInverse as THREE.Matrix4)
        // 该顶点最终写进世界空间时还要经过蒙皮网格自身的 matrixWorld
        world.applyMatrix4(mesh.matrixWorld)
        const ndcV = world.clone().project(this.camera)
        samples.push({
          i,
          local: [Number(pi.x.toFixed(3)), Number(pi.y.toFixed(3)), Number(pi.z.toFixed(3))],
          world: [Number(world.x.toFixed(3)), Number(world.y.toFixed(3)), Number(world.z.toFixed(3))],
          ndc: [Number(ndcV.x.toFixed(3)), Number(ndcV.y.toFixed(3)), Number(ndcV.z.toFixed(3))],
          skinIndex: [indices[0] ?? -1, indices[1] ?? -1, indices[2] ?? -1, indices[3] ?? -1],
          skinWeight: weights.map(w => Number(w.toFixed(3))) as [number, number, number, number],
          weightSum: Number(weightSum.toFixed(3)),
        })
      }
      return { meshName: String(mesh.name || mesh.type).slice(0, 40), vertexCount: count, reason: null, attrNames, boneMatrixCount, samples }
    } catch (e) {
      // ⚠ 不静默：把真实异常带回诊断（本项目多次因静默 catch 让诊断自己失效）
      return fail(`threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * **蒙皮内容包围盒**：遍历全部 `SkinnedMesh`，对顶点做**均匀抽样**并按 three.js 蒙皮公式算世界坐标。
   *
   * 为什么必须抽样算（本项目的核心教训）：`Box3.setFromObject` 对蒙皮网格用的是**几何局部坐标**
   * 过 `matrixWorld`，不经过蒙皮矩阵 ⇒ 它说"角色在原点"，而真实渲染顶点在 4.6 米外。
   * 抽样 40 点/网格（默认上限 400 点）在 150×630 的桌宠画布上完全够用，且不会拖慢装载。
   */
  private skinnedBounds(maxPerMesh = 40, maxTotal = 400): {
    ok: boolean
    reason?: string
    center: { x: number, y: number, z: number }
    min: { x: number, y: number, z: number }
    max: { x: number, y: number, z: number }
    size: { x: number, y: number, z: number }
    sampled: number
    meshes: number
  } {
    const vrm = this.vrm
    const empty = {
      ok: false, center: { x: 0, y: 0, z: 0 }, min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 },
      size: { x: 0, y: 0, z: 0 }, sampled: 0, meshes: 0,
    }
    if (!vrm) return { ...empty, reason: 'no-vrm' }    // 先让骨架/动画生效，boneMatrices 才代表屏幕上会画出来的位置
    try { this.mixer?.update(0) } catch { /* ignore */ }
    try { vrm.update(0) } catch { /* ignore */ }
    vrm.scene.updateMatrixWorld(true)

    let minX = Infinity; let minY = Infinity; let minZ = Infinity
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity
    let sampled = 0
    let meshes = 0
    let firstReason: string | undefined

    vrm.scene.traverse((obj) => {
      if (sampled >= maxTotal) return
      const sm = obj as THREE.SkinnedMesh
      if (!(sm as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return
      const geo = sm.geometry as THREE.BufferGeometry | undefined
      if (!geo) { firstReason ??= 'no-geometry'; return }
      const pos = geo.getAttribute('position')
      const si = geo.getAttribute('skinIndex')
      const sw = geo.getAttribute('skinWeight')
      if (!pos || !si || !sw) { firstReason ??= 'missing-skin-attributes'; return }
      const skel = sm.skeleton as unknown as { boneMatrices?: Float32Array, update?: () => void }
      skel.update?.()
      const bm = skel.boneMatrices
      if (!bm || !bm.length) { firstReason ??= 'empty-boneMatrices'; return }
      const boneCount = Math.floor(bm.length / 16)
      meshes++
      const count = pos.count
      const step = Math.max(1, Math.floor(count / maxPerMesh))
      const v = new THREE.Vector3()
      const accEl = new Float32Array(16)
      for (let i = 0; i < count && sampled < maxTotal; i += step) {
        const px = pos.getX(i); const py = pos.getY(i); const pz = pos.getZ(i)
        const idx = [si.getX(i), si.getY(i), si.getZ(i), si.getW(i)]
        const wts = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)]
        accEl.fill(0)
        for (let k = 0; k < 4; k++) {
          const bi = idx[k] ?? 0
          const w = wts[k] ?? 0
          if (w === 0 || bi < 0 || bi >= boneCount) continue
          const off = bi * 16
          for (let n = 0; n < 16; n++) accEl[n] = (accEl[n] ?? 0) + (bm[off + n] ?? 0) * w
        }
        v.set(px, py, pz)
          .applyMatrix4(sm.bindMatrix as THREE.Matrix4)
          .applyMatrix4(new THREE.Matrix4().fromArray(Array.from(accEl)))
          .applyMatrix4(sm.bindMatrixInverse as THREE.Matrix4)
          .applyMatrix4(sm.matrixWorld)
        if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) continue
        if (v.x < minX) minX = v.x
        if (v.y < minY) minY = v.y
        if (v.z < minZ) minZ = v.z
        if (v.x > maxX) maxX = v.x
        if (v.y > maxY) maxY = v.y
        if (v.z > maxZ) maxZ = v.z
        sampled++
      }
    })

    if (!sampled || !Number.isFinite(minX)) return { ...empty, reason: firstReason ?? 'no-samples', meshes }
    return {
      ok: true,
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
      size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
      sampled,
      meshes,
    }
  }

  /**
   * **运行时自动居中**（治标且立即可用）。
   *
   * 背景（本项目的最终根因，两条独立证据链吻合）：
   *   Mate 的 `.anim` 里 `RootT.x ≈ 0.966`，VRMA 的 rest hips（0.0955）与模型 rest 不匹配时，
   *   three-vrm 按 `loaderScale = modelRestHipsY / animationRestHipsY ≈ 4.85` 放大位移，
   *   于是蒙皮顶点被推到 **x ≈ 4.64 米** 处（实测），而相机横向可视半宽只有 0.63 米
   *   ⇒ 角色整体在画外 ⇒ 画布 0 个非背景像素。
   *
   * 做法：用**实测蒙皮顶点中心**算出侧向/前后偏移，把它作为常量补偿写进 `vrm.scene.position`。
   *   为什么这是正确的（而不是"猜一个魔法数字"）：偏移对所有关键帧都是同一常量，
   *   它来自两套 rest 姿势的坐标系差，不代表角色在走动；把坐标系差补掉，
   *   角色的**相对运动完全保留**。
   *
   * 治本方案仍是资产侧重新导出（归一化 `RootT`），见 `docs/交接-阶段0-1实况.md`。
   */
  /**
   * **取景自查**：把"模型根节点在哪 / 实测内容中心在哪 / 相机在看哪"一次报出来。
   *
   * 为什么需要它（实测踩到的困境）：光看 `inFrustum=false` + `screenRect.x=-940`
   * 只知道"角色不在画面里"，无法区分下面三种完全不同的原因：
   *   ① 根节点没被平移（`autoCenterOnSkinnedContent` 没生效）；
   *   ② 平移了，但**后续某一帧把 `vrm.scene.position` 重置**了（动画/RootT 覆盖）；
   *   ③ 位置对，但相机距离/朝向错。
   * 这三者的修法完全不同，所以必须把三个量分开测。
   */
  framingDiagnostics(): {
    rootPosition: { x: number, y: number, z: number }
    rootScale: { x: number, y: number, z: number }
    skinnedCenter: { x: number, y: number, z: number } | null
    skinnedOk: boolean
    skinnedReason: string | null
    /** 固定锚点是否已建立（旧的 `centeredOnce` 已随自动居中一起删除） */
    anchoredOnce: boolean
    /** 舞台锚点的画布像素坐标与命中椭圆 */
    anchorPx: { x: number, y: number }
    hitEllipse: { cx: number, cy: number, rx: number, ry: number } | null
    avatarScale: number
    restHeightM: number
    restWorldBaselineY: number
    cameraPos: { x: number, y: number, z: number }
    cameraLookAt: { x: number, y: number, z: number }
    /** 相机当前朝向（世界方向），用于判断它在看哪 */
    cameraDir: { x: number, y: number, z: number }
  } {
    const vrm = this.vrm
    const b = this.skinnedBounds()
    const dir = new THREE.Vector3()
    this.camera.getWorldDirection(dir)
    return {
      rootPosition: vrm
        ? { x: vrm.scene.position.x, y: vrm.scene.position.y, z: vrm.scene.position.z }
        : { x: 0, y: 0, z: 0 },
      rootScale: vrm ? { x: vrm.scene.scale.x, y: vrm.scene.scale.y, z: vrm.scene.scale.z } : { x: 0, y: 0, z: 0 },
      skinnedCenter: b.ok ? { x: b.center.x, y: b.center.y, z: b.center.z } : null,
      skinnedOk: b.ok,
      skinnedReason: b.ok ? null : (b.reason ?? null),
      anchoredOnce: this.anchoredOnce,
      anchorPx: this.stageAnchorPx(),
      hitEllipse: this.avatarHitEllipse(),
      avatarScale: this.avatarScale,
      restHeightM: this.restHeightForReframe,
      restWorldBaselineY: this.restWorldBaselineY,
      cameraPos: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
      cameraLookAt: { ...this.cameraLookAt },
      cameraDir: { x: dir.x, y: dir.y, z: dir.z },
    }
  }

  /**
   * ⛔ **已删除**：`autoCenterOnSkinnedContent()`。
   *
   * 它是缺陷三（角色随动作漂移）的直接成因：按**当前动画帧**的蒙皮中心平移
   * `vrm.scene.position`，于是每换一个 clip、每推进一帧，根节点都可能被改动。
   * 本轮改为「固定锚点 + 一次性取景」（`anchorAndFrameOnce` / `applySceneTransform`），
   * 根节点变换**只在建立锚点与用户显式改缩放时**被写入。
   *
   * 保留这段说明而不是直接删掉：这是本项目反复踩过的坑，注释比代码更值钱。
   */

  /** 逐 mesh 的绘制可行性报告（找"有顶点却什么都不画"的病因） */
  private meshDrawReport(): Array<{    name: string, visible: boolean, materialVisible: boolean, hasIndex: boolean,
    indexCount: number, positionCount: number, drawRangeCount: number, inScene: boolean,
  }> {
    const out: Array<{
      name: string, visible: boolean, materialVisible: boolean, hasIndex: boolean,
      indexCount: number, positionCount: number, drawRangeCount: number, inScene: boolean,
    }> = []
    const vrm = this.vrm
    if (!vrm) return out
    vrm.scene.updateMatrixWorld(true)
    vrm.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return
      const geo = mesh.geometry as THREE.BufferGeometry | undefined
      const pos = geo?.getAttribute('position') as { count?: number } | undefined
      const idx = geo?.getIndex()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      const mats = Array.isArray(mat) ? mat : (mat ? [mat] : [])
      // 是否真的在场景里（沿父链上溯）
      let inScene = false
      let cur: THREE.Object3D | null = obj
      while (cur) { if (cur === this.scene) { inScene = true; break } cur = cur.parent }
      out.push({
        name: String(obj.name || obj.type).slice(0, 40),
        visible: obj.visible,
        materialVisible: mats.length > 0 && mats.every(m => m.visible),
        hasIndex: Boolean(idx),
        indexCount: idx?.count ?? 0,
        positionCount: pos?.count ?? 0,
        drawRangeCount: geo?.drawRange?.count ?? -1,
        inScene,
      })
      if (out.length >= 8) return
    })
    return out
  }

  /**
   * 诊断探针：世界原点附近的红方块（返回 **plain 对象**）。
   *
   * ⚠ 必须返回可结构化克隆的普通对象：`executeJavaScript` 走 IPC，返回类实例/含方法的对象
   *   会报 `An object could not be cloned.`（实测踩到，害我丢了一轮证据）。
   *   同理 `THREE.Vector3` 不能直接返回，必须拆成 `{x,y,z}`。
   */
  addTestBox(size = 0.6, at = { x: 0, y: 1.2, z: 0 }): { added: boolean, ndc?: { x: number, y: number, z: number } } {
    if (this.testBox) return { added: false }
    const geo = new THREE.BoxGeometry(size, size, size)
    const mat = new THREE.MeshBasicMaterial({ color: 0xff2d55 })
    const box = new THREE.Mesh(geo, mat)
    box.position.set(at.x, at.y, at.z)
    box.frustumCulled = false
    box.name = '__airimate_test_box__'
    this.scene.add(box)
    this.testBox = box
    const ndcV = new THREE.Vector3(at.x, at.y, at.z).project(this.camera)
    return { added: true, ndc: { x: ndcV.x, y: ndcV.y, z: ndcV.z } }
  }

  removeTestBox(): void {
    if (!this.testBox) return
    try {
      this.scene.remove(this.testBox)
      const m = this.testBox as THREE.Mesh
      m.geometry?.dispose?.()
      const mm = m.material as THREE.Material | undefined
      mm?.dispose?.()
    } catch { /* ignore */ }
    this.testBox = null
  }

  /** 诊断探针：临时隐藏/显示 VRM（用于"红方块看得见、模型看不见"的隔离实验） */
  setModelVisible(on: boolean): void {
    if (this.vrm) this.vrm.scene.visible = on
  }

  /**
   * 诊断探针：停掉全部动画，让模型回到绑定姿态（bind pose）。
   *
   * 为什么这条判据关键（本轮的定位逻辑）：
   *   模型健康度读数显示 `meshWorldScale=1`、`maxVertices=13014`、骨骼高度正常
   *   （hips 0.717 → head 1.108 → leftFoot 0.048），而画面里仍然没有角色。
   *   唯一还没被排除的环节是**蒙皮矩阵**：如果皮肤矩阵算出来的位移把所有顶点压到一个点，
   *   几何就在、材质也在、draw call 也在，但屏幕上什么都没有。
   *   ⇒ 停掉动画看绑定姿态：
   *     · 绑定姿态可见 ⇒ 问题在 **VRMA 剪辑对骨骼的作用**（动画数据/尺度）；
   *     · 绑定姿态仍不可见 ⇒ 问题在**模型的蒙皮/骨骼绑定**本身。
   */
  stopAnimationForProbe(): { stopped: boolean } {
    try {
      this.mixer?.stopAllAction()
      this.activeAction = null
    } catch { /* ignore */ }
    return { stopped: true }
  }

  /** 统计画面里"接近指定颜色"的像素比例（用于验证红方块是否真的被画出来） */
  colorRatio(rgb: { r: number, g: number, b: number }, tolerance = 60): number {
    try {
      const gl = this.renderer.getContext()
      const w = gl.drawingBufferWidth
      const h = gl.drawingBufferHeight
      const px = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
      const c = this.clearColorRgb()
      const bgIsTarget = Math.abs(c.r - rgb.r) < 10 && Math.abs(c.g - rgb.g) < 10 && Math.abs(c.b - rgb.b) < 10
      let hit = 0
      for (let i = 0; i < w * h; i++) {
        const a = px[i * 4 + 3] ?? 0
        if (a < 8) continue
        const pr = px[i * 4] ?? 0
        const pg = px[i * 4 + 1] ?? 0
        const pb = px[i * 4 + 2] ?? 0
        // 若目标色恰好等于清屏色，则"命中"意味着"仍是背景" —— 这种情况返回 0（视为没画出来）
        if (!bgIsTarget) {
          if (Math.abs(pr - rgb.r) < tolerance && Math.abs(pg - rgb.g) < tolerance && Math.abs(pb - rgb.b) < tolerance) hit++
        } else if (Math.abs(pr - c.r) > 10 || Math.abs(pg - c.g) > 10 || Math.abs(pb - c.b) > 10) {
          hit++
        }
      }
      return Number((hit / Math.max(1, w * h)).toFixed(4))
    } catch {
      return -1
    }
  }

  /**
   * **可信的像素统计**：以整幅像素的**众数颜色**为背景基准。
   *
   * 为什么必须这样（实测教训）：`renderer.getClearColor()` 返回的是**线性空间**颜色
   * （设 `0x151824` 读回来是 `rgb(2,2,4)`），而实际写入帧缓冲的是 sRGB `(21,24,36)`。
   * 拿线性值当基准 ⇒ 每个像素都"不同于背景" ⇒ 比例恒为 1，制造假证据。
   * 众数颜色与色彩空间无关，是最稳的背景基准。
   *
   * 返回：非背景像素比例 + 它们的包围盒（能直接看出"内容在画面哪个位置、有多大"）。
   */
  pixelStats(): {
    total: number
    nonBg: number
    ratio: number
    bgMode: [number, number, number]
    contentBox: { x: number, y: number, w: number, h: number } | null
  } {
    try {
      const gl = this.renderer.getContext()
      const w = gl.drawingBufferWidth
      const h = gl.drawingBufferHeight
      const px = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
      const hist = new Map<number, number>()
      for (let i = 0; i < w * h; i++) {
        const key = ((px[i * 4] ?? 0) << 16) | ((px[i * 4 + 1] ?? 0) << 8) | (px[i * 4 + 2] ?? 0)
        hist.set(key, (hist.get(key) ?? 0) + 1)
      }
      let bgKey = 0
      let bgCount = -1
      for (const [k, c] of hist) if (c > bgCount) { bgCount = c; bgKey = k }
      const bgMode: [number, number, number] = [(bgKey >> 16) & 255, (bgKey >> 8) & 255, bgKey & 255]
      let nonBg = 0
      let minX = w; let minY = h; let maxX = -1; let maxY = -1
      for (let i = 0; i < w * h; i++) {
        const key = ((px[i * 4] ?? 0) << 16) | ((px[i * 4 + 1] ?? 0) << 8) | (px[i * 4 + 2] ?? 0)
        if (key === bgKey) continue
        nonBg++
        const x = i % w
        const y = Math.floor(i / w)
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      return {
        total: w * h,
        nonBg,
        ratio: Number((nonBg / Math.max(1, w * h)).toFixed(4)),
        bgMode,
        contentBox: maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
      }
    } catch {
      return { total: 0, nonBg: 0, ratio: -1, bgMode: [0, 0, 0], contentBox: null }
    }
  }

  /**
   * 从 WebGL 帧缓冲**回读像素**，统计"**不同于清屏色**"的比例。
   *
   * ⚠ 判定基准必须是**清屏色本身**，不能用固定阈值。
   *   实测踩到：早期用 `alpha>8 && 任一通道>24` 做判定，而清屏色 `#151824` = (21,24,36)
   *   恰好满足 G 通道 >24 ⇒ **整片清屏色被算成"非背景"**，
   *   于是 `canvasNonBgRatio` 恒等于 1，制造了"帧缓冲里有角色"的假证据，
   *   把我误导了好几轮。这里改为与清屏色逐通道比较（容差 10）。
   */
  private canvasNonBgRatio(): number {
    try {
      const gl = this.renderer.getContext()
      const w = gl.drawingBufferWidth
      const h = gl.drawingBufferHeight
      const rw = Math.max(2, Math.floor(w / 2))
      const rh = Math.max(2, Math.floor(h / 2))
      const x0 = Math.floor((w - rw) / 2)
      const y0 = Math.floor((h - rh) / 2)
      const px = new Uint8Array(rw * rh * 4)
      gl.readPixels(x0, y0, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, px)
      const c = this.clearColorRgb()
      let nonBg = 0
      const total = rw * rh
      for (let i = 0; i < total; i++) {
        const a = px[i * 4 + 3] ?? 0
        // 透明画布：alpha 本身就能区分（清屏 alpha=0）
        if (a < 8) continue
        const dr = Math.abs((px[i * 4] ?? 0) - c.r)
        const dg = Math.abs((px[i * 4 + 1] ?? 0) - c.g)
        const db = Math.abs((px[i * 4 + 2] ?? 0) - c.b)
        if (dr > 10 || dg > 10 || db > 10) nonBg++
      }
      return Number((nonBg / Math.max(1, total)).toFixed(4))
    } catch {
      return -1
    }
  }

  /** 当前清屏色（0-255 分量）——所有像素判定的基准 */
  private clearColorRgb(): { r: number, g: number, b: number, a: number } {
    const c = new THREE.Color()
    this.renderer.getClearColor(c)
    return {
      r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255),
      a: Math.round(this.renderer.getClearAlpha() * 255),
    }
  }

  /**
   * **自拍**：把当前帧从画布导出成 PNG dataURL，并同时给出两条独立读数。
   *
   * 为什么需要（本轮把问题逼到墙角）：`gl.readPixels` 已证明帧缓冲里有角色，
   * 但屏幕上看不到。`drawImage(webglCanvas → 2D canvas)` 走的是**另一条**读取路径
   * （与"浏览器把画布内容交给合成器"更接近）。两条读数一对照就能定位：
   *   · readPixels 有、drawImage 无 ⇒ 画布的"可呈现内容"是空的（呈现层问题）；
   *   · 两者都有 ⇒ 内容健康，问题在窗口合成。
   * 该函数只读，不改任何状态；容器规格里也用它做"离屏兜底"方案的素材来源。
   */
  selfCapture(): { png: string | null, readPixelsNonBg: number, copyNonBg: number, size: { w: number, h: number } } {
    const readPixelsNonBg = this.canvasNonBgRatio()
    const size = { w: this.canvas.width, h: this.canvas.height }
    try {
      const c2 = document.createElement('canvas')
      c2.width = this.canvas.width
      c2.height = this.canvas.height
      const ctx = c2.getContext('2d')
      if (!ctx) return { png: null, readPixelsNonBg, copyNonBg: -1, size }
      ctx.drawImage(this.canvas, 0, 0)
      const d = ctx.getImageData(0, 0, c2.width, c2.height).data
      // 与 `canvasNonBgRatio` 同源：判定基准是**清屏色本身**，不用固定阈值
      const col = this.clearColorRgb()
      let nonBg = 0
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] ?? 0
        if (a < 8) continue
        if (Math.abs((d[i] ?? 0) - col.r) > 10 || Math.abs((d[i + 1] ?? 0) - col.g) > 10 || Math.abs((d[i + 2] ?? 0) - col.b) > 10) nonBg++
      }
      const copyNonBg = Number((nonBg / Math.max(1, c2.width * c2.height)).toFixed(4))
      return { png: c2.toDataURL('image/png'), readPixelsNonBg, copyNonBg, size }
    } catch {
      return { png: null, readPixelsNonBg, copyNonBg: -1, size }
    }
  }

  /**
   * 角色在画布内的**屏幕矩形**（CSS 像素）—— 用于证明"角色确实落在画布内"。
   *
   * ⚠ **必须用实测蒙皮顶点**（`skinnedBounds()`），不能用 `Box3.setFromObject`：
   *   后者对 `SkinnedMesh` 用的是几何绑定姿态的局部坐标 ⇒ 结果**与动画无关、恒定不变**。
   *   拿它做"60 秒漂移"的读数会得到漂亮的 `drift = 0.00`，
   *   但那**测的是一个常量**，不是"角色有没有动" —— 属于自欺型证据（本轮实测发现并修掉）。
   */
  screenRect(): { x: number, y: number, w: number, h: number, source: 'skinned' | 'box3' } | null {
    const vrm = this.vrm
    if (!vrm) return null
    const sk = this.skinnedBounds(60, 600)
    let lo = { x: 0, y: 0, z: 0 }
    let hi = { x: 0, y: 0, z: 0 }
    let source: 'skinned' | 'box3' = 'skinned'
    if (sk.ok) {
      lo = sk.min; hi = sk.max
    } else {
      const box = new THREE.Box3().setFromObject(vrm.scene)
      lo = { x: box.min.x, y: box.min.y, z: box.min.z }
      hi = { x: box.max.x, y: box.max.y, z: box.max.z }
      source = 'box3'
    }
    const rect = this.canvas.getBoundingClientRect()
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
    for (const x of [lo.x, hi.x]) {
      for (const y of [lo.y, hi.y]) {
        for (const z of [lo.z, hi.z]) {
          const v = new THREE.Vector3(x, y, z).project(this.camera)
          const sx = (v.x * 0.5 + 0.5) * rect.width
          const sy = (-v.y * 0.5 + 0.5) * rect.height
          minX = Math.min(minX, sx); maxX = Math.max(maxX, sx)
          minY = Math.min(minY, sy); maxY = Math.max(maxY, sy)
        }
      }
    }
    if (!Number.isFinite(minX)) return null
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, source }
  }

  /**
   * **锚点几何自检**：把"应当落在舞台锚点上的那个世界点"投影回画布像素，
   * 与锚点目标 `(0.50·W, 0.92·H)` 对比。
   *
   * 世界点取 `(0, restWorldBaselineY, 0)` —— 建立锚点时把内容包围盒中心对齐到了
   * 世界原点、基线记在 `restWorldBaselineY`，所以"这个点投影到哪"就是
   * "角色站在画布哪里"，且**与在播哪个 clip 无关**（不读任何蒙皮/动画量）。
   */
  anchorProjection(): {
    /** 投影得到的画布像素坐标 */
    projected: { x: number, y: number }
    /** 锚点目标像素坐标 */
    target: { x: number, y: number }
    /** 误差（像素） */
    error: { x: number, y: number }
    restWorldBaselineY: number
    canvas: { w: number, h: number }
  } | null {
    const rect = this.canvas.getBoundingClientRect()
    if (!(rect.width > 0 && rect.height > 0)) return null
    const v = new THREE.Vector3(0, this.restWorldBaselineY, 0).project(this.camera)
    const projected = {
      x: Number(((v.x * 0.5 + 0.5) * rect.width).toFixed(3)),
      y: Number(((-v.y * 0.5 + 0.5) * rect.height).toFixed(3)),
    }
    const target = this.stageAnchorPx()
    return {
      projected,
      target: { x: Number(target.x.toFixed(3)), y: Number(target.y.toFixed(3)) },
      error: { x: Number((projected.x - target.x).toFixed(3)), y: Number((projected.y - target.y).toFixed(3)) },
      restWorldBaselineY: Number(this.restWorldBaselineY.toFixed(6)),
      canvas: { w: Number(rect.width.toFixed(2)), h: Number(rect.height.toFixed(2)) },
    }
  }

  /**
   * 关键骨骼的**画布内屏幕坐标**（CSS 像素）。
   *
   * 这是"角色锚点有没有漂"最直接的读数：`rootMotionMode = none` 把 hips 平移钉在
   * rest 位置 ⇒ 投影后的 hips 屏幕坐标应当是**逐位常量**；而头部/脚部会因关节姿态
   * 变化而小幅移动（那是动作本身，不是漂移）。两者分开测，才能区分
   * "根位移没被钉住"与"动作幅度大"。
   */
  boneScreenPositions(names: readonly string[] = ['hips', 'head', 'leftFoot', 'rightFoot']): Record<string, { x: number, y: number } | null> {
    const out: Record<string, { x: number, y: number } | null> = {}
    const vrm = this.vrm
    const rect = this.canvas.getBoundingClientRect()
    for (const n of names) {
      const node = vrm?.humanoid?.getNormalizedBoneNode(n as RequiredBone)
      if (!node) { out[n] = null; continue }
      const w = new THREE.Vector3()
      node.getWorldPosition(w)
      const v = w.project(this.camera)
      out[n] = {
        x: Number((((v.x * 0.5 + 0.5) * rect.width)).toFixed(3)),
        y: Number((((-v.y * 0.5 + 0.5) * rect.height)).toFixed(3)),
      }
    }
    return out
  }

  /** 每条腿部骨骼的活动量（判据 A12 的读数） */
  legTravel(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const b of LEG_BONES) out[b] = Number((this.boneTravel.get(b) ?? 0).toFixed(2))
    return out
  }

  /**
   * "正在跑的动作里，播放时间最大的那个"的时钟读数。
   *
   * 为什么不能用 `this.activeAction`：那是个**陈旧引用**（实测它在 clip 轮换 6 次、
   * 跨 120 秒的 9 个采样点里恒为 2.45s）。交叉淡化期间有多个 action 同时有效，
   * 必须遍历真实的 action 列表，按"权重 > 0"筛选后取时间最大者。
   */
  private runningActionClock(): { time: number, duration: number } | null {
    const mixer = this.mixer
    if (!mixer) return null
    let best: { time: number, duration: number } | null = null
    // `AnimationMixer` 的 `_actions` 是内部字段；这里只读，且带类型兜底
    const actions = (mixer as unknown as { _actions?: THREE.AnimationAction[] })._actions
    if (!Array.isArray(actions)) return null
    for (const a of actions) {
      if (!a || !a.isRunning()) continue
      const w = a.getEffectiveWeight()
      if (!(w > 0)) continue
      const dur = a.getClip().duration
      if (!Number.isFinite(dur) || dur <= 0) continue
      if (!best || a.time > best.time) best = { time: a.time, duration: dur }
    }
    return best
  }

  resetBoneTravel(): void {
    this.boneTravel.clear()
    this.prevBoneQuat.clear()
  }

  isReady(): boolean { return this.ready }
  getVrm(): VRM | null { return this.vrm }

  dispose(): void {
    this.disposed = true
    this.stop()
    try { this.ro?.disconnect(); this.ro = null } catch { /* ignore */ }
    window.removeEventListener('resize', this.onResize)
    document.removeEventListener('visibilitychange', this.onVisibility)
    try { this.mixer?.stopAllAction() } catch { /* ignore */ }
    this.renderer.dispose()
    stageCounters.stages = Math.max(0, stageCounters.stages - 1)
    stageCounters.scenes = Math.max(0, stageCounters.scenes - 1)
    stageCounters.renderers = Math.max(0, stageCounters.renderers - 1)
    if (this.mixer) stageCounters.mixers = Math.max(0, stageCounters.mixers - 1)
    if (this.vrm) stageCounters.vrms = Math.max(0, stageCounters.vrms - 1)
  }
}
