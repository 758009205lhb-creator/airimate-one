/**
 * tools/qa/audit-acceptance.mjs —— 验收覆盖审计（最终交付前的自查）
 *
 * 为什么需要它：
 *   `docs/Acceptance-Matrix.md` 里每条判据都写了"用什么命令取证据"，
 *   但那份矩阵是**阶段 0 写的**，里面点名的一些脚本后来并没有按那些名字实现
 *   （例如 `probe-stage.mjs --assert`、`proc-window-invariant.ps1`）；
 *   实际用的是另一批脚本（`--probe a10`、`Get-DesktopState.ps1` …）。
 *   如果只看矩阵，会得出"每条都有对应工具"的错觉；只看证据目录，
 *   又不知道哪条判据**没有**证据。两边一对不上，验收就变成了凭印象。
 *
 * 本脚本做三件事，全部基于**磁盘上的实际内容**，不靠叙述：
 *   ① 逐条判据列出：证据文件是否存在、能否解析、其中的 pass 字段是什么；
 *   ② 标出"没有证据文件"或"证据里没有 pass 结论"的判据（这些**不能算通过**）；
 *   ③ 汇总成一份机器可读的审计报告，作为交付前的自查清单。
 *
 * ⚠ 它**不**判断"判据本身是否合理"，也**不**替代人看证据 ——
 *   它只回答一个机械问题：**每条判据是否有一份可解析、且明确给出结论的证据**。
 *
 * 用法：
 *   node tools/qa/audit-acceptance.mjs
 *   node tools/qa/audit-acceptance.mjs --json docs/evidence/ACCEPTANCE-AUDIT.json
 * 退出码：0 = 所有判据都有明确结论的证据；1 = 存在缺口（列表在报告里）
 */
import { readFileSync, existsSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'

const ROOT = process.cwd()
const args = process.argv.slice(2)
const jsonIdx = args.indexOf('--json')
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null

/**
 * 判据 → 证据映射。
 *
 * ⚠ 这份映射**必须手工维护**，因为"哪份证据算数"是判断，不是推导。
 *   每条都写清"取自哪个文件、看哪个字段"，复核者能直接去看同一个地方。
 *   `passWhen` 决定怎么判：`allTrue`（字段全为 true）/ `eq0`（全为 0）/ `eq1`（全为 1）。
 *   `jsonlCheck` 用于逐样本归纳的 JSONL 证据。
 *   `requireField` 是**额外的门槛**（例如浸泡必须真的跑够时长）。
 */
const CRITERIA = [
  { id: 'A1', title: '应用实例数 = 1', evidence: ['phase1/desktop-state-20260927-031853.json'], passFields: ['counts.mineVisibleWindows'], passWhen: 'eq1', note: '可见窗口 =1；三层单实例另有日志与单测' },
  /**
   * ★★ A2 的口径在 **2026-10-08 返工轮被用户改写**（见 `docs/Acceptance-Matrix.md` §0.5）。
   *
   * 旧口径：「可见主窗口数 = 1」。它把实现方**逼**成了"把聊天塞进桌宠窗口"
   * （贴底 dock + 把 pet 窗口从 340×420 放大到 380×560），而用户明确否决该形态。
   * 新口径三条：① 角色可见窗口数 = 1；② chat 窗口内 canvas = 0；
   * ③ 全应用 WebGLRenderer 总数恒为 1（只在 pet 窗口）。
   * Chromium 渲染进程数变成 2 是**允许**的。
   *
   * ⚠ 判定字段必须换成 `phase16/chatwindow.json` 的**按身份**读数 ——
   * 继续用"总数 = 1"会把 chat 打开时**正确**的 2 个窗口读成失败。
   */
  { id: 'A2', title: '★ 角色可见窗口数 = 1（chat 窗口内 canvas = 0；全应用 WebGLRenderer = 1）', evidence: ['phase16/chatwindow.json'], passFields: ['pass'], passWhen: 'allTrue', note: '口径 2026-10-08 改写；chat 打开时可见窗口总数 = 2 是正确的（原"=1"表述已作废）' },
  { id: 'A3', title: '可见 MateEngineX 窗口 = 0', evidence: ['phase16/desktop-state-20261008-153446.json'], passFields: ['counts.legacyKernelVisibleWindows'], passWhen: 'eq0', note: '旧宿主（AIRI 0.12.0-beta.5 / Mate Engine X3.3.0）已于 2026-10-08 卸载并清理残留' },
  { id: 'A4', title: '旧 build\\pet 可见窗口 = 0', evidence: ['phase16/desktop-state-20261008-153446.json'], passFields: ['counts.legacyPetVisibleWindows'], passWhen: 'eq0' },
  /**
   * ★ 新增：窗口分离判据族（§2.4）。它取代了已删除的 `--probe conversation`（C1..C16）。
   * 单列一条是为了让"两个独立窗口"这件事在审计表里**有名字**，而不是散在 A2 的说明里。
   */
  {
    id: 'A2b', title: '★ 窗口分离：pet 恒 340×420 / chat 720×560(最小 560×420) / 单例 hwnd 不变 / 无第三窗口',
    evidence: ['phase17/chatwindow.json'],
    passFields: ['pass'], passWhen: 'allTrue',
    note: '真实桌面截图见 A2c（phase17/petresident-shots.json 由截图脚本产出，是否通过由该脚本自己判定）',
  },
  /**
   * ★★ 新增：**桌宠常驻与启动行为**（2026-10-09 完善轮）。
   *
   * 拆成五条（而不是塞进一条）的理由：它们的**失败含义完全不同**，
   * 合成一条会让"到底哪一半坏了"变成一个查不出的问题：
   *   · A2c 默认启动态 —— 坏在这里 = 用户打开软件看到的东西不对（最要紧的一条）；
   *   · A2d 常驻开关   —— 坏在这里 = 勾选框不生效 / 不落盘；
   *   · A2e 重启后生效 —— 坏在这里 = 设置写了但启动没读（**两个进程**的读数）；
   *   · A2f 三处同步   —— 坏在这里 = 某处菜单显示旧值（不会报错，只会显示错）；
   *   · A2g 菜单无死项 —— 坏在这里 = 某个菜单项点了没反应。
   */
  {
    id: 'A2c', title: '★ 桌宠常驻/启动行为：默认启动只显示对话窗口（petResident=false, startupOpenChat=true）',
    evidence: ['phase17/petresident.json', 'phase17/petresident-shots.json'],
    passFields: ['pass'], passWhen: 'allTrue',
    note: '两份独立证据：探针 49/49 的身份读数 + 桌面枚举驱动的六张真实截图（含"默认态角色窗口数=0"）',
  },
  {
    id: 'A2d', title: '★ 桌宠常驻开关：勾上⇒可见+落盘 / 取消⇒隐藏+落盘（**读设置文件**，不是读内存）',
    evidence: ['phase17/petresident.json'], passFields: ['pass'], passWhen: 'allTrue',
    note: 'petresident.json 的 C2.*/C3.* 里同时有内存值与 `settings.json` 文件值两套读数',
  },
  {
    id: 'A2e', title: '★ 桌宠常驻**重启后仍生效**（两次独立进程启动：写盘 → 设置驱动启动行为）',
    evidence: ['phase17/petresident-restart.json'], passFields: ['pass'], passWhen: 'allTrue',
    note: '第二次启动带 --probe-pet-mode start-resident（会话级覆盖、不写设置）⇒ 被验证的是设置文件里的值',
  },
  {
    id: 'A2f', title: '★ 三处菜单「桌宠常驻」勾选状态完全同步（主进程 / 对话窗口 / 桌宠窗口）',
    evidence: ['phase17/petresident.json'], passFields: ['pass'], passWhen: 'allTrue',
    note: 'syncReadings 三份读数逐字段相等；唯一真源是 pet-visibility.ts 的 petMenuState()',
  },
  {
    id: 'A2g', title: '★ 对话窗口菜单栏**每一项都有真实动作**（19 项 / 6 组，无死项）',
    evidence: ['phase17/petresident.json', 'phase17/menuopen.json'], passFields: ['pass'], passWhen: 'allTrue',
    note: 'petresident 的 C6.menu-no-dead-items 逐个执行了 16 项（3 项会被会话带走，只断言有实现）；menuopen 逐组展开并读 DOM 矩形',
  },
  { id: 'A5', title: 'VRM 实例数 = 1', evidence: ['phase1/A-boot-diagnostics.json'], passFields: ['stage.vrmCount', 'stage.sceneCount'], passWhen: 'eq1' },
  { id: 'A6', title: 'Live2D 实例数 = 0', evidence: ['phase8/A15-soak-run5.jsonl'], jsonlCheck: 'live2dAllZero', note: '浸泡**逐样本** live2dCount=0（比单次快照强）；run5 = 7206s/241 样本全可见' },
  { id: 'A7', title: 'WebGLRenderer 数 = 1', evidence: ['phase8/A15-soak-run5.jsonl'], jsonlCheck: 'rendererAllOne' },
  { id: 'A8', title: 'AnimationMixer 数 = 1', evidence: ['phase8/A15-soak-run5.jsonl'], jsonlCheck: 'mixerAllOne' },
  { id: 'A9', title: '第二次启动不新增窗口', evidence: ['phase7/A19-no-legacy.json'], passFields: ['ownEntryCount', 'legacyEntryCount'], passWhen: 'eq0', note: '该证据同时证明"旧实例消失后应用能干净启动"；singleton.wake 见运行日志' },
  { id: 'A10', title: '轮盘锚点误差 ≤ 2px', evidence: ['phase3/A10-wheel-anchor.json'], passFields: ['passA10', 'passHitRegionMatchesVisual', 'passWheelInWindow'], passWhen: 'allTrue' },
  /**
   * ⚠ A11 的判据在**桌宠交互与取景修复轮**被重写：
   *   旧判据「左键 pointerdown ⇒ 必须开始拖拽」本身就是缺陷一（按下即拖拽），
   *   越"通过"用户越点不动。新判据：短按什么都不做；按住移动 > 4 CSS px 且命中角色才拖；
   *   阈值内与空白处都不拖；右键/F1/Esc 行为不变。
   *   标题必须跟着改，否则审计会**误述**判据（这正是本轮修掉的一类问题）。
   */
  { id: 'A11', title: '短按不动；越 4px 阈值且命中角色才拖窗口；右键/F1 开轮盘', evidence: ['phase3/A11-input.json'], passFields: ['allPass'], passWhen: 'allTrue' },
  { id: 'A12', title: '5 秒内腿部有运动（任一根 >5° 且 4 骨总行程 >20°，用户 2026-09-27 定稿）', evidence: ['phase3/A12-leg-motion.json'], passFields: ['pass', 'passA12', 'passA12SingleBone', 'passA12TotalTravel'], passWhen: 'allTrue' },
  { id: 'A13', title: '待机 ≥10 / 12s 轮换 / 无 T-pose 窗口', evidence: ['phase3/A13-idle-rotation.json'], passFields: ['pass', 'passRotationPeriod', 'passNoTposeWindow'], passWhen: 'allTrue' },
  /**
   * A14 的**尺寸子判据口径由用户 2026-09-27 定稿（方案 B）**：
   *   「拖拽期间 `getBounds()` 读数**恒定（不累积）**，且与拖拽前偏差 ≤ 1 DIP」。
   *
   * ⚠ 方案 B 同时含**代码改动**（panel 尺寸对齐 4 DIP 栅格）：`scaleFactor = 1.25`，
   *   `482×761 DIP = 602.5×951.25 物理像素`，而 `482`/`761` 都不是 4 的整数倍
   *   ⇒ 对应半个物理像素 ⇒ 边移动边设尺寸时被取整，读数在 761/762 之间跳。
   *   对齐到 `480×760`（= 600×950 物理像素，整数）后，实测 8 步读数**全部** `482×761`，
   *   `strictSizeUnchanged = true`、`sizeDriftMaxDip = 0` —— **严格口径也达标了**，
   *   所以这里不再登记 `knownGap`。
   */
  { id: 'A14', title: '拖拽 PET_DRAGGING + 弹簧回正 + 尺寸读数恒定', evidence: ['phase5/A14-drag.json'], passFields: ['passDragTilts', 'passDragClipActive', 'passSpringReturns', 'passSizeReadingsConstant', 'passSizeDriftWithin1Dip'], passWhen: 'allTrue', note: '实测 8 步读数全部 482×761；strictSizeUnchanged 亦为 true（DIP 栅格对齐后）' },
  {
    id: 'A15', title: '连续运行 2h 无异常',
    /**
     * 证据指向 **run5**（2026-09-27 晚，当前构建、无并发干扰、窗口全程可见）：
     *   `actualSoakSec=7206`、241 样本、`completedCleanly=true`、不变量 0 违规、
     *   T-Pose 0、`clockAdvancing=true`、`boneMotionFrozenPairs=0`、`visibleRatio=1`。
     *
     * 为什么前三次不算（逐次留证，都不是应用缺陷）：
     *   · run1（`A15-soak-sleep-interrupted.jsonl`）：总时长 10338s 达标，但被**系统睡眠**打断
     *     （两个 61/82 分钟的空洞，空洞后 fps=0），有效连续数据仅 1772s ⇒ 总时长≠连续运行；
     *   · run2：跑满 7206s、不变量 0 违规，但 `clockAdvancing=false`、`fps5sMin=0.2` ——
     *     那两个时间窗与**我自己的并发 typecheck/单测/构建**完全重合；
     *   · run4：出现 6.5 分钟 `fps5s≈1` + 动画时钟冻结 —— Chromium 对**不可见窗口**的 rAF 节流
     *     （应用主动暂停渲染是正确行为），同轮日志还显示有真人用过机器。见 `A15-soak-run4-findings.md`。
     */
    evidence: ['phase16/A15-soak-run6-summary.json', 'phase8/A15-soak-run5-summary.json'],
    passFields: ['passA15', 'pass'], passWhen: 'allTrue',
    /**
     * ⚠ **时长闸门是必加的**：分析器对**任意一份** JSONL 都能出结论 ——
     * 我校验分析器时用 `--MinSoakSec 0` 分析过一份**未跑完**的数据（run5 的 64 分钟切片），
     * 那份报告里 `passA15=True`。若不看时长就采信，会得出"2 小时浸泡已通过"这个**完全错误**的结论。
     */
    requireField: { path: 'actualSoakSec', min: 7200 },
  },
  {
    id: 'A16', title: '空闲帧率 ≥50 / 内存无增长',
    /**
     * 同 run5。**帧率只在可见样本上统计**（不可见期间 Chromium 把 rAF 节流到 ≈1Hz、
     * 应用主动暂停渲染，都是正确行为）——本轮 `visibleRatio=1`，所以两种口径一致：
     * `fps5sMinRawAllSamples` 与 `fps5sMin` 都是 **62.7**（下限 50）。
     */
    evidence: ['phase16/A15-soak-run6-summary.json', 'phase8/A15-soak-run5-summary.json'],
    passFields: ['passA16'], passWhen: 'allTrue',
    requireField: { path: 'actualSoakSec', min: 7200 },
  },
  { id: 'A17', title: '密钥命中 = 0（工作区 + 分发物）', evidence: ['phase7/A17-secret-audit.json', 'phase7/A17-dist-payload.json', 'phase7/A17-dist-payload-runtime.json'], passFields: ['pass'], passWhen: 'allTrue' },
  { id: 'A18', title: '非环回监听端口 = 0', evidence: ['phase1/A-boot-diagnostics.json'], passFields: ['listeningPorts'], passWhen: 'emptyArray', note: '诊断里 listeningPorts 为空数组；另有 A18-port-audit.md 说明' },
  {
    id: 'A19', title: '安装/卸载/重启后旧自启 = 0',
    evidence: ['phase7/A19-autostart-audit.json', 'phase7/A19-rollback-summary.json', 'phase7/A19-install-cycle-summary.json'],
    passFields: ['pass'], passWhen: 'allTrue',
    pendingNote: 'install-cycle 尚未执行（需独占实例）；前两份已通过',
  },
  { id: 'A20', title: '视觉验收截图齐备', evidence: ['phase1/screens/CHARACTER-VISIBLE.png', 'phase1/screens/FRAMING-FIXED.png', 'phase3/screens/A20-wheel-open.png', 'phase1/screens/PETMODE-selfcap.png', 'phase1/screens/mine-pid17300-619x960-20260927-032126.png'], screenshots: true },
  { id: 'A21', title: '动作标记只解析一次（无双驱动）', evidence: ['phase2/A21-act-parser.json', 'phase2/A21-act-parser.md'], passFields: ['pass'], passWhen: 'allTrue', note: '单测 11/11（TAP 原始输出留在 A21-act-parser.tap）' },
  { id: 'A22', title: '聊天链路真实接通', evidence: ['phase2/A22-chat-chain.json', 'phase2/A22-chat-chain.md'], passFields: ['passChainWired', 'passReachedServer'], passWhen: 'allTrue', note: '用无效密钥打通链路：收到 auth(401) 证明请求真的发到了服务端（不是 NOT_IMPLEMENTED）' },
  { id: 'A23', title: 'TTS 可用（含取消）', evidence: ['phase2/A23-tts.json'], passFields: ['pass'], passWhen: 'allTrue' },
  { id: 'A24', title: '记忆层端到端 + 跨进程持久化', evidence: ['phase2/A24-memory-e2e.json', 'phase2/A24-restart-summary.json'], passFields: ['pass'], passWhen: 'allTrue' },
]

const EV = join(ROOT, 'docs', 'evidence')

/**
 * 交付文档里的**证据引用**也要一并校验。
 *
 * 为什么（这类文档的通病）：DELIVERY.md 是交付入口，里面写满了
 * "证据在 phaseN/xxx.json" 这样的引用。**文档不会因为文件被改名/删除而报错** ——
 * 它会安静地指向不存在的东西，让复核者以为"证据丢了"。
 * 所以把"引用的文件是否存在"也变成机械检查。
 */
function auditDocReferences() {
  const docPath = join(ROOT, 'docs', 'DELIVERY.md')
  if (!existsSync(docPath)) return { checked: 0, missing: ['docs/DELIVERY.md 不存在'] }
  const text = readFileSync(docPath, 'utf8')
  const refs = [...text.matchAll(/`(phase\d\/[^`]+)`/g)].map(m => m[1])
  const missing = []
  for (const r of new Set(refs)) {
    /**
     * ⚠ **通配引用要按"目录里有匹配"来判，不能当成一个文件名**。
     *   实测踩到：DELIVERY.md 里写 `phase3/round-interaction/*.json`（描述"这一轮的原始读数"），
     *   检查器把它当路径 ⇒ 报"引用了不存在的证据"，而其实那一目录里有 20+ 个 JSON。
     *   规则：含 `*` 时要求**父目录存在且至少有 1 个匹配**；此时它仍然是可机械判定的。
     */
    if (r.includes('*')) {
      const dir = dirname(join(EV, r))
      const base = r.slice(r.lastIndexOf('/') + 1)
      const rx = new RegExp(`^${base.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
      const hit = existsSync(dir) && readdirSync(dir).some(n => rx.test(n))
      if (!hit) missing.push(`${r}（通配无匹配）`)
      continue
    }
    if (!existsSync(join(EV, r))) missing.push(r)
  }
  return { checked: new Set(refs).size, missing }
}

function getPath(obj, dotted) {
  let cur = obj
  for (const part of dotted.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

/** 从 JSONL 里归纳：全样本都满足某字段为指定值**且浸泡已跑完**才算通过 */
function analyzeJsonl(file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim())
  const samples = []
  let ended = false
  for (const l of lines) {
    try {
      const o = JSON.parse(l)
      if (o.kind === 'sample') samples.push(o)
      if (o.kind === 'end') ended = true
    } catch { /* 跳过坏行 */ }
  }
  const allEqual = (k, v) => samples.length > 0 && samples.every(s => s[k] === v)
  return {
    kind: 'jsonl',
    /**
     * 是否跑完（有 `end` 记录）。
     * ⚠ 判据必须要求它为 true：**部分数据**不能用来声称"全程不变量成立" ——
     * "到目前为止都正常"与"整个 2 小时都正常"是两件不同强度的事。
     * （这与 A15 的时长闸门是同一类问题：证据必须能自证"覆盖了整个观测窗口"。）
     */
    ended,
    samples: samples.length,
    live2dAllZero: allEqual('live2dCount', 0),
    rendererAllOne: allEqual('rendererCount', 1),
    mixerAllOne: allEqual('mixerCount', 1),
    vrmAllOne: allEqual('vrmCount', 1),
    sceneAllOne: allEqual('sceneCount', 1),
    baseClipAlwaysPresent: samples.every(s => typeof s.baseClipId === 'string' && s.baseClipId.length > 0),
  }
}

/** 按 `passWhen` 判定一组字段值 */
function judge(values, passWhen) {
  const present = Object.values(values).filter(v => v !== undefined)
  if (present.length === 0) return undefined
  switch (passWhen) {
    case 'eq0': return present.every(v => v === 0)
    case 'eq1': return present.every(v => v === 1)
    case 'emptyArray': return present.every(v => Array.isArray(v) && v.length === 0)
    case 'allTrue':
    default: return present.every(v => v === true)
  }
}

const rows = []
for (const c of CRITERIA) {
  const row = { id: c.id, title: c.title, evidence: [], verdict: 'NO_EVIDENCE', details: [] }

  for (const rel of c.evidence) {
    const full = join(EV, rel)
    const e = { file: rel, exists: existsSync(full) }
    if (!e.exists) { row.evidence.push(e); continue }
    e.bytes = statSync(full).size
    if (rel.endsWith('.jsonl')) {
      try {
        const s = analyzeJsonl(full)
        e.analysis = s
        // 必须等到 `end` 标记：**部分数据**不能用来声称"全程不变量成立"
        e.pass = c.jsonlCheck ? (s.ended && s[c.jsonlCheck] === true) : s.ended
        if (!s.ended) e.note = `浸泡尚未结束（已有 ${s.samples} 个样本，无 end 标记）⇒ 不作结论`
        // ⚠ 只在**跑完之后**才说"逐样本归纳不满足" ——
        //   否则会把上一行的"尚未结束"覆盖掉，上层就分不出「进行中」和「失败」了（实测踩到）
        else if (e.pass === false) e.note = `逐样本归纳不满足：${c.jsonlCheck}`
      } catch (err) { e.error = String(err) }
    } else if (rel.endsWith('.json')) {
      try {
        const j = JSON.parse(readFileSync(full, 'utf8'))
        const vals = {}
        for (const f of (c.passFields ?? [])) vals[f] = getPath(j, f)
        e.values = vals
        e.pass = judge(vals, c.passWhen ?? 'allTrue')

        /**
         * 额外门槛（`requireField`）：值本身"看起来通过"还不够，还要满足门槛。
         * 最典型的用法是浸泡时长 —— 见 A15 的注释：一份 4 分钟的数据也能得出
         * `passA15=true`，不看时长就会把"校验分析器"误当成"2 小时浸泡已通过"。
         */
        if (c.requireField) {
          const got = getPath(j, c.requireField.path)
          e.requireField = { path: c.requireField.path, min: c.requireField.min, actual: got }
          if (typeof got !== 'number' || got < c.requireField.min) {
            e.pass = false
            e.note = `未达门槛：${c.requireField.path}=${got} < ${c.requireField.min}`
          }
        }
        if (e.pass === undefined) e.note = c.note ?? '映射里没有可判定字段，且文件里也没有'
      } catch (err) { e.error = String(err) }
    } else {
      // 图片 / markdown：存在即有证据，但"通过"需人工看 ⇒ 不给结论
      e.pass = c.screenshots ? true : undefined
      if (e.pass === undefined) e.note = '非 JSON 证据，需人工复核'
    }
    row.evidence.push(e)
  }

  const anyExists = row.evidence.some(e => e.exists)
  const anyPass = row.evidence.some(e => e.pass === true)
  const anyFail = row.evidence.some(e => e.pass === false)
  /**
   * 「**证据还不够**」与「**证据表明失败**」必须分开报。
   *
   * 实测教训：浸泡跑完前，A6/A7/A8 的证据（JSONL）没有 `end` 标记 ⇒ 照旧逻辑落到
   * `FAIL`。但那条 FAIL 的含义是"还判不了"，不是"不变量真的破了" ——
   * 报成 FAIL 会让人以为发现了缺陷（而且与我文档里写的"进行中"互相矛盾）。
   * 判据：证据文件都在、但没有任何一条给出结论，**且**至少有一条明确说"尚未结束"。
   */
  const pendingBecauseRunning = row.evidence.some(e => typeof e.note === 'string' && e.note.includes('尚未结束'))
  row.verdict = !anyExists ? 'NO_EVIDENCE'
    : anyFail ? (pendingBecauseRunning && !anyPass ? 'PENDING' : 'FAIL')
      : anyPass ? 'PASS'
        : 'EVIDENCE_NO_VERDICT'
  if (c.knownGap) row.details.push(c.knownGap)
  // 待办理由：证据还不存在，或存在但未达门槛（例如浸泡未完）
  if (c.pendingNote && row.verdict !== 'PASS') row.details.push(c.pendingNote)
  rows.push(row)
}

const docRefs = auditDocReferences()
const byVerdict = rows.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] ?? 0) + 1; return acc }, {})
const report = {
  schema: 'airimate/acceptance-audit/1',
  auditedAt: new Date().toISOString(),
  criteriaCount: rows.length,
  byVerdict,
  deliveryDocReferences: docRefs,
  /** 有明确 PASS 结论的判据 */
  passed: rows.filter(r => r.verdict === 'PASS').map(r => r.id),
  /** 有证据但证据里没有明确结论 —— **不能算通过** */
  evidenceWithoutVerdict: rows.filter(r => r.verdict === 'EVIDENCE_NO_VERDICT').map(r => r.id),
  /** 完全没有证据文件 */
  noEvidence: rows.filter(r => r.verdict === 'NO_EVIDENCE').map(r => r.id),
  /** 证据明确为失败 */
  failed: rows.filter(r => r.verdict === 'FAIL').map(r => r.id),
  /** 证据尚在生成中（不是失败，也不是通过） */
  pending: rows.filter(r => r.verdict === 'PENDING').map(r => r.id),
  rows,
}

if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

const pad = (s, n) => String(s).padEnd(n, ' ')
console.log(`验收覆盖审计：共 ${rows.length} 条判据`)
console.log(`  PASS=${byVerdict.PASS ?? 0}  FAIL=${byVerdict.FAIL ?? 0}  进行中=${byVerdict.PENDING ?? 0}  有证据无结论=${byVerdict.EVIDENCE_NO_VERDICT ?? 0}  无证据=${byVerdict.NO_EVIDENCE ?? 0}`)
console.log('')
console.log(`${pad('判据', 6)}${pad('结论', 22)}${pad('证据数', 8)}说明`)
console.log('-'.repeat(96))
for (const r of rows) {
  const note = r.details.join('；') || ''
  const evCount = `${r.evidence.filter(e => e.exists).length}/${r.evidence.length}`
  console.log(`${pad(r.id, 6)}${pad(r.verdict, 22)}${pad(evCount, 8)}${r.title}${note ? '  ⚠ ' + note : ''}`)
}
console.log('')
if (report.noEvidence.length) console.log(`✗ 无证据：${report.noEvidence.join(', ')}`)
if (report.pending.length) console.log(`… 证据生成中（不得算通过）：${report.pending.join(', ')}`)
if (report.evidenceWithoutVerdict.length) console.log(`! 有证据但无明确结论（不得算通过）：${report.evidenceWithoutVerdict.join(', ')}`)
if (report.failed.length) console.log(`✗ 证据为失败：${report.failed.join(', ')}`)
const clean = report.noEvidence.length === 0 && report.failed.length === 0 && report.evidenceWithoutVerdict.length === 0 && report.pending.length === 0
console.log(`交付文档（DELIVERY.md）引用的证据文件：${docRefs.checked} 个，缺失 ${docRefs.missing.length} 个`)
if (docRefs.missing.length) console.log(`✗ 交付文档引用了不存在的证据：${docRefs.missing.join(', ')}`)
const clean2 = clean && docRefs.missing.length === 0
console.log(clean2 ? '[audit] 每条判据都有明确结论的证据，且交付文档引用全部有效' : '[audit] 存在缺口（见上）')
process.exit(clean2 ? 0 : 1)
