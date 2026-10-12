<#
  tools/qa/soak-2h.ps1 —— 长稳浸泡回归（判据 A15 / A16）

  设计要点（都是踩过坑之后的取舍）：

  ① **采样在应用内部，不在本脚本**（`--probe soak`）。原因：真正的判据是 17 根骨骼、
     场景/渲染器/混音器/VRM 计数、`baseClipId`、`fps`、`heapMB` —— 这些只在 renderer 快照里；
     而用 CDP 去取会给生产代码引入一条调试通道，与"生产禁用 CDP 注入"的红线冲突。
     应用内采样走既有的只读探针通道，不新增攻击面。

  ② **本脚本只做"分析与判定"**，不负责起进程。这样它可以**事后**在任何时候重跑，
     同一份 JSONL 反复出报告（证据可复核），而不必再等 2 小时。

  ③ **"还在动"用 `activeTimeSec` 判定，不用骨骼四元数**。实测骨骼
     （`getNormalizedBoneNode()` 与 `getRawBoneNode()` 两条源）在 5 秒内每 500ms
     只有**恒定 0.026°** 的变化，无法区分"在动"与"卡死"。
     `activeTimeSec` 随 mixer 推进并回绕，是直接、不可伪装的证据。

  ④ **T-pose 判定用"任何采样点都必须有有效 baseClipId"**，而不是四元数比对 ——
     理由同上：四元数在这个工程里不是可靠信号。

  用法：
    # 1) 先跑浸泡（2 小时，30 秒一采）
    node_modules\electron\dist\electron.exe apps\desktop --dev --mode=panel --no-dialogs `
      --probe soak --soak-minutes 120 --soak-sample-sec 30 `
      --probe-out docs\evidence\phase8\A15-soak.jsonl --probe-exit

    # 2) 再分析（可反复重跑）
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\soak-2h.ps1 `
      -Jsonl docs\evidence\phase8\A15-soak.jsonl -OutDir docs\evidence\phase8

    # 2b) ★ 2026-10-08 返工轮：正式浸泡**必须**带 `--soak-with-chat`
    #     新窗口判据是「角色窗口 = 1 **且** 对话窗口 ≤ 1」，而不开对话窗口时
    #     "对话窗口 ≤ 1"这一半**根本没被测到**。带上它才有两窗口并存的样本：
    node_modules\electron\dist\electron.exe apps\desktop --dev --mode=panel --no-dialogs `
      --no-proactive --soak-with-chat --probe soak --soak-minutes 120 --soak-sample-sec 30 `
      --probe-out docs\evidence\phase16\A15-soak-run6.jsonl --probe-exit

    # 2c) 短程集成验证（2 分钟 × 5 秒 ≈ 24 样本，用来验"新判据在两种窗口数下都跑得通"，
    #     它**不是** A15 的证据 —— 时长门槛在分析器的 -MinSoakSec）
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\soak-2h.ps1 `
      -Jsonl docs\evidence\phase16\soak-windowcheck.jsonl -OutDir docs\evidence\phase16 `
      -SummaryName soak-windowcheck-summary.json -MinSoakSec 90
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Jsonl,
  [string]$OutDir = 'docs\evidence\phase8',
  [string]$Root = '',
  # 要求的最短浸泡时长（秒）。默认 7200 = 2 小时（判据 A15）
  [int]$MinSoakSec = 7200,
  # 允许的最长采样间隔（秒）——超过说明采样器本身卡过
  [int]$MaxSampleGapSec = 90,
  <#
    `-SummaryName`：汇总文件名（默认 `A15-soak-summary.json`）。
    为什么需要它：同一判据可能跑**多次**（第一次被系统睡眠打断，见
    `phase8/A15-soak-run1-sleep.md`）。如果每次都写同一个文件名，
    后一次会**覆盖**前一次的证据 —— 而"那次为什么不算通过"恰恰需要留证。
  #>
  # 默认空 ⇒ 由输入文件名派生（A15-soak-run3.jsonl -> A15-soak-run3-summary.json），
  # 这样同一判据跑多次不会互相覆盖证据。
  [string]$SummaryName = '',
  # 空闲帧率下限（判据 A16）
  [double]$MinFps5s = 50
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$jsonlPath = if ([System.IO.Path]::IsPathRooted($Jsonl)) { $Jsonl } else { Join-Path $Root $Jsonl }
if (-not (Test-Path $jsonlPath)) { throw "找不到浸泡数据：$jsonlPath" }

$outFull = if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $Root $OutDir }
New-Item -ItemType Directory -Force -Path $outFull | Out-Null

$raw = Get-Content $jsonlPath
if ($raw.Count -eq 0) { throw "浸泡数据为空：$jsonlPath（空数据不得当作通过）" }

$meta = $null
$samples = New-Object System.Collections.Generic.List[object]
$endRec = $null
$badLines = 0
foreach ($line in $raw) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try { $o = $line | ConvertFrom-Json } catch { $badLines++; continue }
  switch ($o.kind) {
    'meta'   { $meta = $o }
    'sample' { $samples.Add($o) }
    'end'    { $endRec = $o }
    default  { $badLines++ }
  }
}

if ($samples.Count -eq 0) { throw "没有任何采样点：$jsonlPath" }

# ── 不变量检查（A15 的核心）
$violations = New-Object System.Collections.Generic.List[string]
$tposeSamples = 0
$nullSnapshots = 0
$windowViolations = 0
# 旧采样计数：没有按身份计数字段的样本数（如实进报告，不当成新口径的证据）
$legacyWindowSamples = 0
# ★ 2026-10-09：**不是违规**但值得人看的窗口读数（例如"全程桌宠已收回"）
$windowNotes = New-Object System.Collections.Generic.List[string]
$gapViolations = New-Object System.Collections.Generic.List[string]
$lastT = $null

foreach ($s in $samples) {
  if ($s.error) { $violations.Add("n=$($s.n) t=$($s.tSec) 采样错误：$($s.error)"); continue }
  if ($s.snapshotNull) { $nullSnapshots++; $violations.Add("n=$($s.n) t=$($s.tSec) 快照为 null（renderer 没响应）"); continue }

  # ── 窗口与单角色（★ 2026-10-08 返工轮：口径改成**按身份**计数）
  #
  # ⚠ 旧判据 `windowCount -ne 1` / `visibleWindows -ne 1` 是「只创建一个 BrowserWindow」
  #   时代的产物。本应用现在**恰好两个**窗口（角色 + 独立对话窗口），
  #   chat 打开时正确的可见窗口数就是 **2** ⇒ 照旧跑会在 chat 一开就**假失败**。
  #
  # 新口径（`docs/Acceptance-Matrix.md` §0.5.2）：
  #   · **角色窗口 = 1**（恒真；这一条才是"单角色"的落点）；
  #   · **对话窗口 ≤ 1**（关/开两个合法状态）；
  #   · 总数只记录，不作判据。
  #
  # 兼容：旧采样（没有新字段）落回"总数 ≤ 2"这一条保守判据，
  #       并在报告里**如实标注**"该样本没有按身份计数"——不假装它是新口径的证据。
  if ($null -ne $s.characterWindowCount -or $null -ne $s.chatWindowCount) {
    if ($s.characterWindowCount -ne 1) {
      $windowViolations++
      $violations.Add("n=$($s.n) t=$($s.tSec) characterWindowCount=$($s.characterWindowCount)（角色窗口应为 1）")
    }
    if ($s.chatWindowCount -gt 1) {
      $windowViolations++
      $violations.Add("n=$($s.n) t=$($s.tSec) chatWindowCount=$($s.chatWindowCount)（对话窗口至多 1）")
    }
    if ($s.characterVisibleWindowCount -ne 1) {
      <#
        ⚠ **2026-10-09 完善轮：这一条从"违规"降级为"记录"**（必须留档）。

        为什么：本轮改了启动行为 —— 默认 `petResident=false` ⇒
        **桌宠窗口创建但不显示**（"打开软件只出现对话窗口"）。
        于是一份按默认设置跑的浸泡**全程** `characterVisibleWindowCount = 0`，
        而那是**正确**的产品行为。继续把它算作 `windowViolations`，
        会把一份完全正常的 2 小时数据判成"角色窗口不见了"。

        真正的**不变量**是那一行没有变的：`characterWindowCount == 1`
        （窗口**对象**恒为一个 —— 这才是"不许有第二个角色窗口"的落点）。
        可见性只是状态，不是不变量。
        ⇒ 这里只把"不等于 1"如实记进 `windowNotes`（人看），不增计数。
      #>
      $windowNotes.Add("n=$($s.n) t=$($s.tSec) characterVisibleWindowCount=$($s.characterVisibleWindowCount)（可见角色窗口：0 = 桌宠已收回/非常驻，1 = 已呼出；**两者都合法**）")
    }
  } else {
    $legacyWindowSamples++
    if ($s.windowCount -gt 2) {
      $windowViolations++
      $violations.Add("n=$($s.n) t=$($s.tSec) windowCount=$($s.windowCount)（旧采样无按身份计数；总数至多 2）")
    }
  }
  if ($s.sceneCount -ne 1)    { $violations.Add("n=$($s.n) t=$($s.tSec) sceneCount=$($s.sceneCount)（应为 1）") }
  if ($s.rendererCount -ne 1) { $violations.Add("n=$($s.n) t=$($s.tSec) rendererCount=$($s.rendererCount)（应为 1）") }
  if ($s.mixerCount -ne 1)    { $violations.Add("n=$($s.n) t=$($s.tSec) mixerCount=$($s.mixerCount)（应为 1）") }
  if ($s.vrmCount -ne 1)      { $violations.Add("n=$($s.n) t=$($s.tSec) vrmCount=$($s.vrmCount)（应为 1，多角色）") }
  if ($s.live2dCount -ne 0)   { $violations.Add("n=$($s.n) t=$($s.tSec) live2dCount=$($s.live2dCount)（必须为 0）") }
  if ($s.boneCount -lt 17)    { $violations.Add("n=$($s.n) t=$($s.tSec) boneCount=$($s.boneCount)（应 ≥17）") }
  # 无 T-pose：任何时刻都必须有一个有效的基础动作
  if ([string]::IsNullOrEmpty($s.baseClipId)) { $tposeSamples++ }

  if ($null -ne $lastT) {
    $gap = $s.tSec - $lastT
    if ($gap -gt $MaxSampleGapSec) { $gapViolations.Add("n=$($s.n) 采样间隔 $([math]::Round($gap,1))s > 上限 ${MaxSampleGapSec}s") }
  }
  $lastT = $s.tSec
}
foreach ($g in $gapViolations) { $violations.Add($g) }

# ── 可见性分类（run4 实测踩到，必须分开）
#
# 背景：Chromium 对**被遮挡/被隐藏**的窗口会把 rAF 节流到 ≈1 Hz，而本应用
# 自身的 `visibilitychange` 处理**故意**在隐藏时暂停渲染（正确行为，省电）。
# 于是"窗口被盖住/用户锁屏"期间的 `fps5s ≈ 1`、`activeTimeSec` 冻结
# **既不是应用缺陷，也不是帧率证据** —— 把它算进 `fps5sMin` 会把
# "用户离开了机器"误报成"应用帧率不达标"（run4 就是这样：6.5 分钟 fps≈1）。
#
# 规则：
#   · 帧率与动画时钟**只在可见样本上统计**；
#   · 并且要求**可见样本占比 ≥ 95%** —— 否则这一轮**无效**（无法判定），
#     而不是"失败"；无法判定时给出明确结论"请在没有其他窗口遮挡、机器空闲的 2 小时重跑"。
#   · 老数据没有 `visibilityState` 字段 ⇒ 视为可见（保持向后兼容），并在报告里注明。
$visibleSamples = @($samples | Where-Object { $null -eq $_.visibilityState -or $_.visibilityState -eq 'visible' })
$hiddenSamples = @($samples | Where-Object { $_.visibilityState -eq 'hidden' })
$visibilityInstrumented = @($samples | Where-Object { $null -ne $_.visibilityState }).Count -gt 0
$visibleRatio = if ($samples.Count) { [math]::Round($visibleSamples.Count / $samples.Count, 4) } else { 0 }
$passVisibilityCoverage = (-not $visibilityInstrumented) -or ($visibleRatio -ge 0.95)

# ── 动画时钟（A15 的"还在动"判据）—— **只在可见样本之间**比较
<#
  ⚠ **口径在 2026-10-06 被用户裁定修改过一次**，原委与理由必须留在这里，
    否则后来者只会看到"标准被放宽了"，而不知道放宽的**代价被另一条更硬的断言补上了**。

  原判据（run2 时代加入，用来挡 run2 的 `fps5s≈1` 时钟冻结）：
      `$changes -ge ($clockSamples.Count - 1)`
  即**要求每对相邻样本的 `activeTimeSec` 都不相等**。

  它挡 run2 是正确的。但 run7（2026-10-05，7206s / 241 样本 / 0 不变量违规 /
  100% 可见 / fps 均值 66.5 / 堆斜率 0.035 MB/min / 6 个 clip 正常轮换 /
  `passBoneMotion=True`）被它判 FAIL，而**失败完全来自采样混叠**：

    · 236 个相邻对里只有 **5 对**取值相同 ⇒ 相异率 **97.88%**；
    · 「最长连续相同」只有 **2 个样本**，且那 2 个的值**并不相同**；
    · `activeTimeSec` 在 237 个样本里有 **225 个不同取值**；
    · **5 对全部是同一形态**：`idle_pet_idle_8 → idle_pet_idle_10` 的交界
      （n=19→20、147→148、159→160、207→208、219→220），两样本恰好落在同一 clip 的同一相位。

  为什么必然出现：`采样 30s ÷ 轮换周期 12s = 2.497 个 index/样本`
  ⇒ 每 4 个样本循环一次，`_8→_10` 这个交界**必然**反复落在采样点上。
  对照 run5（同样参数、同样间隔分布）0 对相同 —— **差别只是混叠相位上的运气**。
  ⇒ 也就是说 `>= 100%` 这条在**本采样参数下**是**偶发不稳定**的：同一产品状态下
    一轮过、一轮不过，而两轮的真实行为没有区别。

  ★ 处置（用户 2026-10-06 裁定方案 ①）：**加混叠容差，同时补更硬的守卫**。
    "真卡住"的形态是 **run-length**（连续几十个样本恒定），不是"偶发一对同相"。

  ⚠⚠ **负向验证的实测结果（2026-10-06，必须原样保留，含对我自己说法的纠正）**

    我构造了 3 个人造变体（只改 `activeTimeSec`，其余一字不动）来测新判据，
    结果**推翻了我最初写在注释里的一句过度声称**（原话是"run-length 才是真正防卡死的
    那一条，净效果是判据整体变强"）——**那句话不成立**：

      | 变体 | 形态 | 相异率 | 最长连续相同 | 不同取值 | 新判据判定 |
      |---|---|---|---|---|---|
      | 原始 run7 | 真实数据 | 97.88% | 2 | 225 | **PASS**（正确） |
      | **A** | 时钟彻底冻死（全样本恒定） | 0% | 237 | 1 | **FAIL**（抓住 ✅） |
      | **B** | 每 10 个样本循环同一批值 | 100% | **1** | 10 | **PASS**（❌ 漏了） |
      | **C** | 每样本 +0.001 缓慢蠕变 | 100% | **1** | 237 | **PASS**（❌ 漏了） |

    ⇒ **run-length 抓不住 B/C**：它们的相邻取值**永远不相等**（B 周期 10、
      C 单调递增），所以 run-length 恒为 1。而"不同取值 ≥3"这种下限对 B（10 个）也拦不住。

    实测出的**有效**区分器是**相异取值个数**：`采样数 × 0.4` 是理论下限
    （采样 30s ÷ 周期 12s ⇒ 相邻样本应落到不同相位；真实值 225 ≈ 237×0.95，
    远高于下限）⇒ 取 `distinctValues ≥ 30% × 样本数` 即可拦住 B（10 ≪ 71）。
    但**C 仍然拦不住**：237 个单调递增值是**规则合法但物理上不可能**的序列
    （真实 `activeTimeSec` 会被 clip 时长截断并回绕），要拦它得再加"值域 ≤ 最大 clip 时长"
    这类断言。**本轮不追加**（理由见下）。

  ★ 我最终保留的判据与**它到底保证了什么**（不过度声称）：
      ① 相异率 ≥95%（挡"大段冻结"）—— 本文件的历史价值在这里（run2 的 `fps5s≈1` 就是它挡的）
      ② 最长连续相同 ≤3 样本（挡"连续几十个样本恒定"，即 A 与真实冻结形态）
      ③ 相异取值 ≥30% 样本数（挡 B 这类"低基数循环"）
    **它不能证明**时钟"以正确速率推进"（C 能骗过它）——
    那件事由**独立证据**负责：`passBoneMotion`（骨骼四元数每对样本都在变）
    与 `uniqueClips`（clip 真的在轮换）。
    B/C 属于**人造对抗样本**：真实的 `AnimationMixer` 不会产生"每 10 个样本循环一批值"
    或"单调递增且不回绕"的时钟读数 —— 那不是本判据的威胁模型。
    这一段的用意就是让后来者**不必重新发现一遍**：别把这条判据当成"时钟健康"的证明。
#>
$clockSamples = @($visibleSamples | Where-Object { $null -ne $_.activeTimeSec })
$clockAdvancing = $false
$clockPairs = 0
$clockChanges = 0
$clockSamePairs = 0
$clockMaxStuckRun = 0      # 最长「连续相同取值」的样本数（1 = 从未连续相同）
$clockDistinctValues = 0
$clockDistinctClips = 0
$clockChangeRatio = $null
# 相异率容差：允许 ≤5% 的相邻对因混叠落在同一相位
$MinClockChangeRatio = 0.95
# ★ 真正的"卡住"守卫：连续相同取值的样本数上限。
#   折算：3 个样本 × 30s = 90s —— 一个 3.7~11s 的 clip 绝不可能 90 秒不推进。
#   实测噪声是 2（且那 2 个取值不同），留一档余量。
$MaxClockStuckRun = 3
# ★ 相异取值个数下限（占样本数比例）—— 挡"低基数循环"这类卡死形态。
#   理论依据：采样 30s ÷ 轮换周期 12s ⇒ 相邻样本应落在不同相位，
#   真实数据里不同取值 ≈ 95% 的样本数；取 30% 是很宽的余量，但足以拦住
#   "只有 10 个取值在循环"（负向验证变体 B：10 ≪ 71）。
$MinClockDistinctRatio = 0.30
if ($clockSamples.Count -ge 3) {
  for ($i = 1; $i -lt $clockSamples.Count; $i++) {
    $clockPairs++
    if ($clockSamples[$i].activeTimeSec -ne $clockSamples[$i-1].activeTimeSec) { $clockChanges++ }
    else { $clockSamePairs++ }
  }
  # run-length：连续相同取值的最大长度
  $run = 1
  for ($i = 1; $i -lt $clockSamples.Count; $i++) {
    if ($clockSamples[$i].activeTimeSec -eq $clockSamples[$i-1].activeTimeSec) { $run++ }
    else { if ($run -gt $clockMaxStuckRun) { $clockMaxStuckRun = $run }; $run = 1 }
  }
  if ($run -gt $clockMaxStuckRun) { $clockMaxStuckRun = $run }

  # 独立证据：取值多样性（真卡住 ⇒ 只有 1~2 个取值）
  $clockDistinctValues = @($clockSamples | ForEach-Object { $_.activeTimeSec } | Sort-Object -Unique).Count
  $clockDistinctClips = @($clockSamples | ForEach-Object { $_.activeClip } | Sort-Object -Unique).Count

  if ($clockPairs -gt 0) { $clockChangeRatio = [math]::Round($clockChanges / $clockPairs, 4) }
  $minDistinct = [math]::Ceiling($clockSamples.Count * $MinClockDistinctRatio)
  $clockAdvancing = ($null -ne $clockChangeRatio) -and
                    ($clockChangeRatio -ge $MinClockChangeRatio) -and
                    ($clockMaxStuckRun -le $MaxClockStuckRun) -and
                    ($clockDistinctValues -ge $minDistinct)
}

<#
  ── 骨骼运动的**交叉验证**（run5 加入）

  为什么要它：`activeTimeSec` 在约 1/4 的样本上读到 `null`，且这些样本的 `n` **严格每 4 个一次**
  （run2 也一样，n = 0,4,8,…）⇒ 采样网格 30s 与轮换周期 12s 的最小公倍数是 120s = 4 个样本，
  于是总有一个固定的采样点落在**交叉淡化的某个相位**上；在那个相位里没有任何 action 的
  `getEffectiveWeight() > 0`（新动作刚 reset、旧动作已淡出），`runningActionClock()` 返回 null。

  这本身不是缺陷（时钟读数无效 ≠ 动画停了），但**不能因此漏判"卡死"**：
  如果没有交叉验证，一个"时钟恒为 null 的卡死"会被 `clockSamples.Count < 3` 静默放过。
  所以这里直接拿**骨骼四元数**做独立证据：相邻样本之间 17 根骨的 |Δq| 之和的最大值必须 > 0。
  两个信号一起用：时钟负责"跑得对不对"，骨骼负责"到底有没有动"。
#>
$boneDeltaMin = $null
$boneDeltaMax = $null
$boneFrozenPairs = 0
$bonePairs = 0
$withBones = @($samples | Where-Object { $null -ne $_.bones })
for ($i = 1; $i -lt $withBones.Count; $i++) {
  $prevB = $withBones[$i-1].bones
  $curB = $withBones[$i].bones
  $maxD = 0.0
  foreach ($p in $curB.PSObject.Properties) {
    $qa = $prevB.($p.Name)
    if ($null -eq $qa -or $null -eq $p.Value) { continue }
    $d = [math]::Abs([double]$qa.x - [double]$p.Value.x) +
         [math]::Abs([double]$qa.y - [double]$p.Value.y) +
         [math]::Abs([double]$qa.z - [double]$p.Value.z) +
         [math]::Abs([double]$qa.w - [double]$p.Value.w)
    if ($d -gt $maxD) { $maxD = $d }
  }
  $maxD = [math]::Round($maxD, 5)
  $bonePairs++
  if ($null -eq $boneDeltaMin -or $maxD -lt $boneDeltaMin) { $boneDeltaMin = $maxD }
  if ($null -eq $boneDeltaMax -or $maxD -gt $boneDeltaMax) { $boneDeltaMax = $maxD }
  if ($maxD -le 0) { $boneFrozenPairs++ }
}
$passBoneMotion = ($bonePairs -ge 3) -and ($boneFrozenPairs -eq 0)

# ── A16：帧率与内存（帧率取**可见样本**；堆内存取全部样本——隐藏期间也在涨才算泄漏）
$fps = @($visibleSamples | Where-Object { $null -ne $_.fps5s } | ForEach-Object { [double]$_.fps5s })
$fps1 = @($visibleSamples | Where-Object { $null -ne $_.fps1s } | ForEach-Object { [double]$_.fps1s })
$fpsAllRaw = @($samples | Where-Object { $null -ne $_.fps5s } | ForEach-Object { [double]$_.fps5s })
$heap = @($samples | Where-Object { $null -ne $_.heapMB } | ForEach-Object { [double]$_.heapMB })

$fpsAvg = if ($fps.Count) { [math]::Round(($fps | Measure-Object -Average).Average, 1) } else { $null }
$fpsMin = if ($fps.Count) { [math]::Round(($fps | Measure-Object -Minimum).Minimum, 1) } else { $null }
$heapMin = if ($heap.Count) { [math]::Round(($heap | Measure-Object -Minimum).Minimum, 1) } else { $null }
$heapMax = if ($heap.Count) { [math]::Round(($heap | Measure-Object -Maximum).Maximum, 1) } else { $null }

# 堆增长斜率（MB/分钟）：用最小二乘拟合，比"首尾相减"稳健（不受单点抖动影响）
$heapSlope = $null
if ($heap.Count -ge 5) {
  $n = $heap.Count
  $ts = @($samples | Where-Object { $null -ne $_.heapMB } | ForEach-Object { [double]$_.tSec })
  $meanT = ($ts | Measure-Object -Average).Average
  $meanH = ($heap | Measure-Object -Average).Average
  $num = 0.0; $den = 0.0
  for ($i = 0; $i -lt $n; $i++) { $num += ($ts[$i] - $meanT) * ($heap[$i] - $meanH); $den += [math]::Pow($ts[$i] - $meanT, 2) }
  if ($den -gt 0) { $heapSlope = [math]::Round(($num / $den) * 60, 3) }
}

# ── 轮换覆盖（A13 的持续断言）
#
# ⚠ 这里有一个**必须解释清楚**的采样现象（实测踩到）：
#   采样间隔 30s、轮换周期 12s ⇒ 每个样本之间 index 前进 30/12 = **2.5** 个，
#   而 index 只取整数 ⇒ 观测序列会**混叠**成固定模式（本机实测为 0,3,5,8 循环，
#   周期 120s = 10 个 clip × 12s，恰好一整轮）。
#   所以"观测到的 distinct clip 数"**不等于**"实际轮换了几个" ——
#   把 4 当成"只轮换了 4 个"是**误读**。真正的结论要从 index 的前进规律推：
#   `idleIndex` 按固定步长前进且长期不漂移 ⇒ 轮换在持续发生，且周期正确。
$uniqueClips = @($samples | Where-Object { $_.baseClipId } | ForEach-Object { $_.baseClipId } | Sort-Object -Unique)
$idleIdx = @($samples | Where-Object { $null -ne $_.idleIndex } | ForEach-Object { [int]$_.idleIndex })
$distinctIdx = @($idleIdx | Sort-Object -Unique)
<#
  采样间隔从数据自身推出来，不依赖调用方传参 ——
  证据要能自证，不能靠"我记得当时传了 30"。
#>
# 采样间隔从数据自身推出来，不依赖调用方传参 —— 证据要能自证，
# 不能靠"我记得当时传的是 30"。
# ⚠ 注意这个 if **是表达式**（结果赋给 $everySec），所以 `else` 必须紧跟，
#   中间不能插注释行 —— 否则 else 被注释掉，$everySec 变成 $null，
#   后续 `$everySec / 12` 之类静默算出空值（本项目实测踩到）。
$everySec = if ($samples.Count -ge 2) {
  [double]([math]::Round(([double]$samples[1].tSec - [double]$samples[0].tSec), 1))
} else { 30 }
# 判据 A13 的轮换周期（秒）；写死是为了让'由混叠反推的周期'能与它对比
$IDLE_SWITCH_SEC = 12
# 待机池大小（idleTotal）——回绕判定要用
$IDLE_POOL = if ($samples[0].idleTotal) { [int]$samples[0].idleTotal } else { 10 }

# 混叠判定：把观测序列按"每样本前进 step 个 index"去检验，看是否存在稳定的 step
$aliasStep = $null
$aliasStable = $false
$rotationPeriodFromAlias = $null
$phaseDriftPct = $null
if ($idleIdx.Count -ge 4) {
  $steps = @()
  for ($i = 1; $i -lt $idleIdx.Count; $i++) {
    $d = $idleIdx[$i] - $idleIdx[$i - 1]
    if ($d -lt 0) { $d += $IDLE_POOL }   # 回绕
    $steps += $d
  }
  $uniqSteps = @($steps | Sort-Object -Unique)
  <#
    ⚠ 不要用"步长是否唯一"来判稳定 —— 实测**不成立**：
    采样 30s / 轮换 12s = 每样本 2.5 个 index，而 index 只取整数，
    所以步长会在 **2 与 3 之间交替**（唯一值是 {2,3}），
    用"唯一值个数 = 1"判会得出"轮换不规律"这个**错误结论**。

    正确的判据是**相位漂移**：
      对每个样本算 `phase = (idleIndex - tSec / 12) mod 1`。
      若轮换周期真的是 12s，这个相位应当是**常数**（允许采样抖动带来的固定偏移）；
      周期偏大/偏小都会让相位随时间**单调漂移**。
    这同时把"周期是否准确"也一起验了 —— 而且不受混叠影响。
  #>
  $avgStep = if ($steps.Count) { ($steps | Measure-Object -Average).Average } else { $null }
  if ($null -ne $avgStep -and $avgStep -gt 0) {
    $aliasStep = [math]::Round($avgStep, 2)
    <#
      由**平均步长**反推周期：每样本前进 avgStep 个 index，
      而一个 index = 一个轮换周期 ⇒ 周期 = 采样间隔 / avgStep。
      实测 30 / 2.51 ≈ 11.94s（判据 12s，偏差 0.5%）。

      ⚠ 相位**不能**用 `(index - t/12) mod 1` 去求（我第一版就是这么写的，算出来 99%）：
      采样 30s 对应 2.5 个 index ⇒ 相位本身每两个样本就差 0.5，
      即观测到的是**拍频**而不是漂移。要判漂移必须**先定出周期**，
      再看"实际 index 相对该周期外推值的残差是否随时间漂移"。
    #>
    $rotationPeriodFromAlias = [math]::Round($everySec / $avgStep, 3)
    # 周期的**不确定度**：步长是整数，均值有抽样误差 ⇒ 周期区间应把 12s 包住
    $stepSd = if ($steps.Count -ge 2) { [math]::Sqrt((($steps | ForEach-Object { [math]::Pow($_ - $avgStep, 2) } | Measure-Object -Sum).Sum) / ($steps.Count - 1)) } else { 0 }
    $stepSe = if ($steps.Count -ge 2) { $stepSd / [math]::Sqrt($steps.Count) } else { 0 }
    $periodLow = if (($avgStep + $stepSe) -gt 0) { [math]::Round($everySec / ($avgStep + $stepSe), 3) } else { $null }
    $periodHigh = if (($avgStep - $stepSe) -gt 0) { [math]::Round($everySec / ($avgStep - $stepSe), 3) } else { $null }
    $periodBrackets12 = ($null -ne $periodLow -and $null -ne $periodHigh -and $periodLow -le $IDLE_SWITCH_SEC -and $IDLE_SWITCH_SEC -le $periodHigh)
    # 无累积漂移的独立证据：残差的极差在**前后两半**应当同量级
    $resAll = @()
    foreach ($sm in $samples) { if ($null -ne $sm.idleIndex) { $resAll += ([double]$sm.idleIndex - ([double]$sm.tSec / $rotationPeriodFromAlias)) } }
    $resHalfRange = $null; $resFirstRange = $null; $resSecondRange = $null
    if ($resAll.Count -ge 8) {
      $half = [int][math]::Floor($resAll.Count / 2)
      $f1 = @($resAll[0..($half - 1)]); $f2 = @($resAll[$half..($resAll.Count - 1)])
      $resFirstRange = [math]::Round((($f1 | Measure-Object -Maximum).Maximum - ($f1 | Measure-Object -Minimum).Minimum), 3)
      $resSecondRange = [math]::Round((($f2 | Measure-Object -Maximum).Maximum - ($f2 | Measure-Object -Minimum).Minimum), 3)
      $resHalfRange = [math]::Round([math]::Abs($resFirstRange - $resSecondRange), 3)
    }
    <#
      漂移**不能**用"残差对时间的斜率"或"相位取小数"来判（我试了三版：99%、498%、仍不可用）。
      根因：采样 30s 对应 2.5 个 index ⇒ 残差本身就是 0/±0.5 的**周期性抖动**，
      在欠采样的整数序列上做斜率/相位统计，得到的量没有物理意义。

      改用**模式复现**判定（严谨且直观）：
        周期准确 ⇒ "每样本前进 2.5 个 index"这个规律会让观测序列以固定步数**精确重复**
        （本机为每 4 个样本重复一次的 0,3,5,8）。把序列按 4 个一组切开，
        **各组必须逐元素相同**；周期只要偏一点，若干组之后就会错位 ⇒ 立刻暴露。
        这等价于"在 120s（=10×12s，恰好一整轮）的整数倍窗口内无相位漂移"，
        且完全不受量化抖动影响。

      ★★ **2026-10-08 修正：必须按"窗口数分段"比较，不能拿全程比第一组**。
        实测（run6，带 `--soak-with-chat`）：chat 窗口在 t=720s 打开后，同一份数据的
        `idleIndex` 从 `0,3,5,8` 变成 `1,3,6,8` —— **仍然是每 4 个样本一循环、周期仍是 11.968s**，
        但相位整体平移了 ⇒ 旧实现（全程与"第一组"比）会报
        `36 组中错位 62 处（不匹配率 43%）`，看起来像"轮换坏了"。

        真相：**窗口数变化会改变 rAF 的调度相位**，于是采样相位跟着跳一次。
        这是**正常**的（chat 开关是设计行为，不是故障），而"全程同相位"本来就是
        单窗口基线下的假设 —— 假设变了，判据必须跟着改，否则会把正常现象报成缺陷。
        ⇒ 按 `chatWindowCount` 变化把序列切成若干段，**每段自比**。
          真正的漂移（周期不准）会在**任何一段内部**持续错位，照样抓得住。
    #>
    $periodSamples = if ($avgStep -gt 0) { [int][math]::Round($IDLE_POOL / $avgStep) } else { 0 }
    $mis = 0; $groups = 0; $segCount = 1
    if ($periodSamples -ge 2 -and $idleIdx.Count -ge ($periodSamples * 2)) {
      # 按"窗口数发生变化"的位置切段（只认 chatWindowCount；它缺席时整段不分）
      $segs = New-Object System.Collections.Generic.List[object]
      $cur = New-Object System.Collections.Generic.List[int]
      $prevChat = $null
      for ($i = 0; $i -lt $idleIdx.Count; $i++) {
        $cw = $null
        if ($i -lt $samples.Count) { $cw = $samples[$i].chatWindowCount }
        if ($null -ne $cw -and $null -ne $prevChat -and $cw -ne $prevChat -and $cur.Count -gt 0) {
          $segs.Add(@($cur.ToArray())); $cur.Clear()
        }
        $cur.Add([int]$idleIdx[$i])
        if ($null -ne $cw) { $prevChat = $cw }
      }
      if ($cur.Count -gt 0) { $segs.Add(@($cur.ToArray())) }
      $segCount = $segs.Count
      foreach ($seg in $segs) {
        if ($seg.Count -lt ($periodSamples * 2)) { continue }   # 太短的段不判（样本不足以复现模式）
        $base = @($seg[0..($periodSamples - 1)])
        for ($g = $periodSamples; $g + $periodSamples -le $seg.Count; $g += $periodSamples) {
          $groups++
          for ($j = 0; $j -lt $periodSamples; $j++) {
            if ($seg[$g + $j] -ne $base[$j]) { $mis++ }
          }
        }
      }
    }
    $rotationPatternSamples = $periodSamples
    $rotationPatternGroups = $groups
    $rotationPatternMismatches = $mis
    # 段数进证据：>1 说明这轮中途窗口数变过（新口径下这是**正常**的）
    $rotationPatternSegments = $segCount
    $aliasStable = ($groups -ge 3 -and $mis -eq 0)
    $phaseDriftPct = if ($groups -ge 1) { [math]::Round(($mis / [double]($groups * [math]::Max(1, $periodSamples))) * 100, 3) } else { $null }
  }
}

$rotationNote = if ($null -ne $phaseDriftPct) {
  "采样混叠：采样 ${everySec}s ÷ 轮换 ${IDLE_SWITCH_SEC}s ⇒ 每样本约 $aliasStep 个 index（非整数 ⇒ 步长在整数间交替，" +
  "所以观测到的 $($distinctIdx.Count) 个 index 属**正常混叠**，不代表只轮换了这么多）。" +
  "模式复现：每 $rotationPatternSamples 个样本一循环，$rotationPatternGroups 组中错位 $rotationPatternMismatches 处（不匹配率 ${phaseDriftPct}%）⇒ 由平均步长反推周期 ≈ ${rotationPeriodFromAlias}s（判据 ${IDLE_SWITCH_SEC}s）"
}
elseif ($idleIdx.Count -ge 4) { 'index 序列存在，但不足以计算相位漂移' }
else { '样本数不足，无法判定混叠' }

$actualSoakSec = if ($endRec -and $endRec.soakSec) { [int]$endRec.soakSec } else { [int]($samples[-1].tSec) }
$completedCleanly = $null -ne $endRec

# 堆斜率**只在对足够长的窗口上判定**：
#   实测教训：20 分钟窗口上斜率在 0.39~0.56 之间摆动（阈值 0.5）—— 纯粹是短窗口噪声，
#   会让同一份数据忽而 PASS 忽而 FAIL。判据 A16 本来就是"2 小时无持续增长"，
#   所以在不足 30 分钟的数据上**不下堆增长的结论**（记为"未判定"，而不是假装通过或失败）。
$heapSlopeDecidable = ($null -ne $heapSlope) -and ($actualSoakSec -ge 1800)
$heapSlopeOk = if ($heapSlopeDecidable) { $heapSlope -le 0.5 } else { $null }
$passA16 = ($null -ne $fpsMin) -and ($fpsMin -ge $MinFps5s) -and $heapSlopeDecidable -and ($heapSlopeOk -eq $true)
$passA15 = ($actualSoakSec -ge $MinSoakSec) -and ($violations.Count -eq 0) -and ($tposeSamples -eq 0) -and $clockAdvancing -and $passBoneMotion

<#
  ★ **可见性覆盖闸门**（run4 引入）。
  帧率与动画时钟只在可见样本上有意义（隐藏期间 Chromium 把 rAF 节流到 ≈1Hz，
  且应用自身 `visibilitychange` 会主动暂停渲染 —— 两者都是**正确行为**）。
  如果隐藏样本超过 5%，这一轮**不足以判定** —— 结论既不是 PASS 也不是 FAIL，
  而是 INVALID_VISIBILITY_COVERAGE，并明确写出"请在没有其他窗口遮挡、机器空闲的 2 小时重跑"。
#>
if (-not $passVisibilityCoverage) {
  $passA15 = $false
  $passA16 = $false
}

<#
  ★★ **窗口模型覆盖闸门**（2026-10-08 返工轮引入）。

  为什么必须有它（防止"看起来通过、其实只测了一半"）：
    新窗口判据是「角色窗口 = 1 且 对话窗口 <= 1」。而旧浸泡只跑单窗口 ——
    那种情况下 chatWindowCount 恒为 0，"对话窗口 <= 1"这半条**根本没被测到**，
    但报告会长得和"整条判据都验证过"一模一样。这是本项目最忌讳的那类结论：
    **测试覆盖不到的地方，在报告里和覆盖到的地方长得一样**。

  ⇒ 规则：只有在**同一份 JSONL 里同时出现过** chatWindowCount = 0 与 = 1
    两种状态时，"两窗口并存"才算被测过。
    没测到 ⇒ 不把 A15 判成 PASS，而是给出 INCOMPLETE_WINDOW_COVERAGE，
    并明确写出"请带 --soak-with-chat 重跑"。
#>
$chatCountsSeen = @($samples | ForEach-Object { $_.chatWindowCount } | Where-Object { $null -ne $_ } | Select-Object -Unique)
$windowCoverageInstrumented = @($samples | Where-Object { $null -ne $_.chatWindowCount }).Count -gt 0
$windowCoverageComplete = $windowCoverageInstrumented -and ($chatCountsSeen -contains 0) -and ($chatCountsSeen -contains 1)
if ($windowCoverageInstrumented -and (-not $windowCoverageComplete)) {
  $passA15 = $false
  $passA16 = $false
}

$verdict = if (-not $passVisibilityCoverage) { 'INVALID_VISIBILITY_COVERAGE' }
  elseif ($windowCoverageInstrumented -and (-not $windowCoverageComplete)) { 'INCOMPLETE_WINDOW_COVERAGE' }
  elseif ($passA15 -and $passA16) { 'PASS' }
  elseif ($passA15) { 'A15_PASS_A16_FAIL' }
  elseif ($passA16) { 'A15_FAIL_A16_PASS' }
  else { 'FAIL' }
$passAll = $passA15 -and $passA16

$result = [ordered]@{
  schema            = 'airimate/soak-evidence/1'
  analyzedAt        = (Get-Date).ToString('o')
  jsonl             = $jsonlPath
  meta              = $meta
  completedCleanly  = $completedCleanly
  samples           = $samples.Count
  badLines          = $badLines
  actualSoakSec     = $actualSoakSec
  targetSoakSec     = $MinSoakSec
  passDuration      = ($actualSoakSec -ge $MinSoakSec)

  # ── 可见性分类（帧率与时钟的统计口径）
  visibilityInstrumented = $visibilityInstrumented
  visibleSamples    = $visibleSamples.Count
  hiddenSamples     = $hiddenSamples.Count
  visibleRatio      = $visibleRatio
  passVisibilityCoverage = $passVisibilityCoverage
  visibilityNote    = if (-not $visibilityInstrumented) {
    '该 JSONL 没有 visibilityState 字段（探针在引入该字段之前采集）⇒ 全部样本按"可见"统计'
  } elseif ($passVisibilityCoverage) {
    "可见样本 $($visibleSamples.Count)/$($samples.Count)（$([math]::Round($visibleRatio*100,1))%）⇒ 帧率与动画时钟的口径有效"
  } else {
    "可见样本仅 $($visibleSamples.Count)/$($samples.Count)（$([math]::Round($visibleRatio*100,1))%）< 95% ⇒ 本轮**不足以判定**：隐藏期间 Chromium 会把 rAF 节流到 ≈1Hz 且应用主动暂停渲染（都是正确行为），请在没有其他窗口遮挡、机器空闲的 2 小时重跑"
  }
  fps5sMinRawAllSamples = if ($fpsAllRaw.Count) { [math]::Round(($fpsAllRaw | Measure-Object -Minimum).Minimum, 1) } else { $null }

  invariantViolations = @($violations)
  invariantViolationCount = $violations.Count
  tposeSamples      = $tposeSamples
  nullSnapshots     = $nullSnapshots
  windowViolations  = $windowViolations
  # ★ 2026-10-08 返工轮：窗口判据改成**按身份**计数。
  #   这一行如实说明"有多少样本没有按身份计数字段" —— 旧证据混进来时必须看得见，
  #   否则会把"没测"当成"测过且通过"。
  windowCriterion   = 'characterWindowCount=1 且 chatWindowCount<=1（**窗口对象**的不变量）；characterVisibleWindowCount / chatVisibleWindowCount / 总数都只记录 —— 2026-10-09 起默认桌宠不显示，可见性不是不变量'
  legacyWindowSamplesWithoutIdentityCounts = $legacyWindowSamples
  <#
    ★ 窗口读数里"不是违规、但值得人看"的那些（例如"全程桌宠已收回"）。
      单独一个字段，避免它污染 `violations`（那份是被当作 FAIL 依据的）。
  #>
  windowNotes = @($windowNotes | Select-Object -First 12)
  windowNotesCount = $windowNotes.Count
  windowCriterionNote = if ($legacyWindowSamples -gt 0) {
    "该 JSONL 有 $legacyWindowSamples/$($samples.Count) 个样本**没有**按身份计数字段（采集于 2026-10-08 之前）⇒ 这些样本只用『总数 ≤ 2』的保守判据，**不能**作为新口径的证据"
  } else {
    '全部样本都带按身份计数（characterWindowCount / chatWindowCount）'
  }
  # ★ 窗口模型**覆盖**的机械读数（2026-10-08）：让"两窗口并存到底测没测过"可复核。
  #   为什么单列出来：`verdict` 已经含了这条闸门，但只给一个结论不够 ——
  #   复核者要能区分"测到了且通过"与"根本没测到、所以没通过"。
  chatCountsSeen = @($chatCountsSeen)
  windowCoverageInstrumented = $windowCoverageInstrumented
  windowCoverageComplete = $windowCoverageComplete
  windowCoverageNote = if (-not $windowCoverageInstrumented) {
    '该 JSONL 的样本没有 chatWindowCount 字段（采集于 2026-10-08 之前）⇒ 「对话窗口 <= 1」这半条**没有被测到**；本分析器不因此判失败，但也不得据此声称「两窗口并存」'
  } elseif (-not $windowCoverageComplete) {
    "样本里 chatWindowCount 只出现过 [$(@($chatCountsSeen) -join ',')] ⇒ 「两窗口并存」**没有被覆盖**；请带 --soak-with-chat 重跑"
  } else {
    '样本里同时出现 chatWindowCount=0 与 =1 ⇒「两窗口并存」与「单窗口」两种状态**都覆盖到了**'
  }
  uniqueClipsObserved = $uniqueClips
  uniqueClipCount   = $uniqueClips.Count
  # 采样混叠的判定结果 —— 见上面轮换段的注释：别把"观测到几个 clip"当成"轮换了几个"
  idleIndexSequence = $idleIdx
  distinctIdleIndexCount = $distinctIdx.Count
  aliasStepPerSample = $aliasStep
  aliasStable = $aliasStable
  rotationPeriodFromAliasSec = $rotationPeriodFromAlias
  rotationPeriodIntervalSec = @($periodLow, $periodHigh)
  rotationPeriodBrackets12s = $periodBrackets12
  rotationPatternSamples = $rotationPatternSamples
  rotationPatternGroups = $rotationPatternGroups
  rotationPatternMismatches = $rotationPatternMismatches
  rotationPatternSegments = $rotationPatternSegments
  rotationResidualRangeFirstHalf = $resFirstRange
  rotationResidualRangeSecondHalf = $resSecondRange
  rotationNote = $rotationNote

  clockSamples      = $clockSamples.Count
  clockAdvancing    = $clockAdvancing
  # ★ 时钟判据的**全部中间读数**（口径改过 ⇒ 必须让"容差用了多少"一眼可见，
  #   而不是只给一个 advancing 布尔值让复核者无从判断）
  clockPairs        = $clockPairs
  clockChanges      = $clockChanges
  clockSamePairs    = $clockSamePairs
  clockChangeRatio  = $clockChangeRatio
  clockMinChangeRatio = $MinClockChangeRatio
  clockMaxStuckRun  = $clockMaxStuckRun
  clockMaxStuckRunLimit = $MaxClockStuckRun
  clockDistinctValues = $clockDistinctValues
  clockDistinctClips  = $clockDistinctClips
  clockMinDistinctValues = if ($clockSamples.Count) { [math]::Ceiling($clockSamples.Count * $MinClockDistinctRatio) } else { $null }
  # ⚠ 这条判据**不**证明"时钟以正确速率推进"（人造低基数/蠕变序列能骗过它）——
  #   那件事由 passBoneMotion 与 uniqueClips 负责。详见本文件时钟段的注释。
  clockNote         = if ($clockAdvancing) {
    "时钟推进：相异率 $([math]::Round($clockChangeRatio*100,2))%（门槛 ≥$([math]::Round($MinClockChangeRatio*100,0))%），最长连续相同 $clockMaxStuckRun 样本（上限 $MaxClockStuckRun），$clockDistinctValues 个不同取值（下限 $([math]::Ceiling($clockSamples.Count*$MinClockDistinctRatio))）"
  } else {
    "时钟未推进：相异率 $(if ($null -ne $clockChangeRatio) { [math]::Round($clockChangeRatio*100,2) } else { 'n/a' })% / 最长连续相同 $clockMaxStuckRun 样本（上限 $MaxClockStuckRun）/ 不同取值 $clockDistinctValues 个（下限 $([math]::Ceiling($clockSamples.Count*$MinClockDistinctRatio))）"
  }
  # 骨骼运动交叉验证（时钟读数无效的样本不能变成漏判空间）
  boneMotionPairs   = $bonePairs
  boneMotionMinMaxAbsDelta = $boneDeltaMin
  boneMotionMaxMaxAbsDelta = $boneDeltaMax
  boneMotionFrozenPairs = $boneFrozenPairs
  passBoneMotion    = $passBoneMotion
  boneMotionNote    = if (-not $passBoneMotion) {
    "相邻样本之间出现 **$boneFrozenPairs** 次骨骼完全不动（|Δq| 最大值 = 0）⇒ 渲染/动画确实停过"
  } else {
    "相邻样本之间骨骼**每次都动**（|Δq| 最大值区间 [$boneDeltaMin, $boneDeltaMax]，$bonePairs 对样本，0 次冻结）"
  }

  fps5sAvg          = $fpsAvg
  fps5sMin          = $fpsMin
  fps1sAvg          = if ($fps1.Count) { [math]::Round(($fps1 | Measure-Object -Average).Average, 1) } else { $null }
  heapMinMB         = $heapMin
  heapMaxMB         = $heapMax
  heapSlopeMBPerMin = $heapSlope
  heapSlopeDecidable = $heapSlopeDecidable
  heapSlopeOk = $heapSlopeOk
  heapSlopeNote = if ($heapSlopeDecidable) { "可判定（窗口 $actualSoakSec s >= 1800 s）" } else { "未判定：窗口 $actualSoakSec s < 1800 s，短窗口斜率噪声大于阈值（阈值 0.5 MB/min）" }

  passA15 = $passA15
  passA16 = $passA16
  verdict = $verdict
}

$result.pass = $passAll

$effectiveSummaryName = if ([string]::IsNullOrWhiteSpace($SummaryName)) {
  [System.IO.Path]::GetFileNameWithoutExtension($jsonlPath) + '-summary.json'
} else { $SummaryName }
$summary = Join-Path $outFull $effectiveSummaryName
# ⚠ 必须写**无 BOM** 的 UTF-8：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 总是写 BOM，
#   而 `JSON.parse` 遇 BOM 会直接抛错。本项目的守卫脚本
#   (`tools/qa/check-no-src-artifacts.mjs`) 就是为这个坑加的 —— 它抓到了本文件。
$summaryJson = $result | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($summary, $summaryJson, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host "浸泡时长    : $actualSoakSec s / 目标 $MinSoakSec s   (样本 $($samples.Count)，正常结束=$completedCleanly)"
Write-Host "不变量违规  : $($violations.Count)"
if ($violations.Count) { $violations | Select-Object -First 10 | ForEach-Object { Write-Host "   ✗ $_" -ForegroundColor Red } }
Write-Host "T-pose 采样 : $tposeSamples"
Write-Host "动画时钟    : advancing=$clockAdvancing（样本 $($clockSamples.Count)；相异 $($clockChanges)/$($clockPairs) 对 = $(if ($null -ne $clockChangeRatio) { [math]::Round($clockChangeRatio*100,2) } else { 'n/a' })%，门槛 ≥95%；最长连续相同 $clockMaxStuckRun 样本，上限 $MaxClockStuckRun；$clockDistinctValues 个不同取值）"
Write-Host "clip 观测   : $($uniqueClips.Count) 个不同 clip（$($uniqueClips -join ', ')）"
Write-Host "轮换判定    : $rotationNote"
Write-Host "fps5s       : avg=$fpsAvg  min=$fpsMin  (下限 $MinFps5s)"
Write-Host "heap        : $heapMinMB - $heapMaxMB MB (samples=$($heap.Count)), slope $heapSlope MB/min (limit 0.5) -> $(if ($heapSlopeDecidable) { "可判定, ok=$heapSlopeOk" } else { "未判定（窗口不足 30 分钟）" })"
Write-Host ''
Write-Host "window      : $($result.windowCriterion)"
Write-Host "              $($result.windowCoverageNote)"
Write-Host ''
<#
  ⚠ 控制台那行**必须用 `verdict` 而不是 `$result.pass`**（2026-10-08 实测踩到）。

  `$result.pass` 只看 A15+A16 两个布尔；而 `verdict` 还含两道覆盖闸门
  （可见性 <95% ⇒ INVALID；两窗口并存没覆盖到 ⇒ INCOMPLETE）。
  原来这行打印 `pass` ⇒ 一份**没测到两窗口并存**的数据会看到 "PASS" 四个字母，
  而 JSON 里的 `verdict` 是 `INCOMPLETE_WINDOW_COVERAGE` ——
  只看控制台的人会得出**完全相反**的结论。**结论行必须与 JSON 同源**。
#>
Write-Host "判定        : $($result.verdict)"
if ($result.verdict -eq 'PASS') { Write-Host "A15/A16 浸泡回归：PASS" -ForegroundColor Green }
elseif ($result.verdict -like 'INVALID*' -or $result.verdict -like 'INCOMPLETE*') {
  Write-Host "A15/A16 浸泡回归：$($result.verdict)（本轮**不足以判定**，不是失败 —— 见上面的说明）" -ForegroundColor Yellow
} else { Write-Host "A15/A16 浸泡回归：FAIL（verdict=$($result.verdict)）" -ForegroundColor Red }
Write-Host "汇总证据：$summary"
if ($result.verdict -eq 'PASS') { exit 0 } else { exit 1 }
