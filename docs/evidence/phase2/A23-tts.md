# 阶段 2-D · TTS 语音合成打通（判据 A23，通过）

| 字段 | 值 |
|---|---|
| 覆盖的硬目标 | `tts:speak` / `tts:stop` / `tts:voices` 三通道端到端可用（原为 `NOT_IMPLEMENTED` 桩） |
| 引擎 | Windows 内置 **SAPI**（`System.Speech.Synthesis.SpeechSynthesizer`），经 `powershell.exe` 子进程调用 |
| 命令 | `node_modules\electron\dist\electron.exe apps\desktop --dev --mode=panel --no-dialogs --probe tts --probe-out docs\evidence\phase2\A23-tts.json --probe-exit` |
| 进程退出码 | **0**（实测 33395ms 墙钟） |
| 结果 | **PASS —— 27/27 检查项通过** |

> 本机声音（实测枚举，非假设）：
> `Microsoft Huihui Desktop (zh-CN, Female, enabled)` / `Microsoft Zira Desktop (en-US, Female, enabled)`
> ⇒ zh-CN 优先策略命中了中文声音。

---

## 1. 交付物

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/main/tts-engine.ts` | **新增**。TTS 引擎：分块 / 清洗 / 载荷构造 / 声音挑选 / 取消状态机 / PowerShell 子进程 |
| `apps/desktop/src/main/ipc.ts` | `tts:speak`（原 `NOT_IMPL` 桩 → 真实实现）、`tts:stop`（原空 `ok()` → 真实 kill）、`tts:voices`（原空数组 → 真实枚举） |
| `apps/desktop/src/main/paths.ts` | 新增 `ttsDir`（受限临时正文目录，唯一路径真源）+ 启动时清理 1 小时前残留 |
| `apps/desktop/src/main/bootstrap.ts` | 新增 `--probe tts` 探针 |
| `packages/shared/src/ipc.ts` | 新增 `TtsSpeakRequestSchema` / `TtsVoiceSchema` / `TtsStateEventSchema`；修正 `StageSnapshotSchema` 缺 `phase`（见 §6） |
| `packages/shared/src/preload-api.ts` | `listVoices` 出参形状与实现对齐（补 `lang` / `gender` / `selected` / `preferred` / `preferredMissing`） |
| `apps/desktop/src/preload/index.ts` | 同步 `listVoices` 的类型标注 |
| `apps/renderer/src/store.ts` | **回复朗读挂载点**：`onChatDone` → 受 `ttsEnabled` 控制调 `tts:speak`；`onTtsState` 驱动"正在说话"状态 |
| `apps/renderer/src/components/SettingsPanel.vue` | TTS 开关 + 声音选择 + 停止朗读（真实可用，不再是"阶段 2 接入"占位） |
| `apps/desktop/test/tts.test.cjs` | **新增** 55 个单测（纯逻辑，不发声） |
| `docs/evidence/phase2/A23-tts.json` | 探针实测证据（3879 字节，机器可读） |

### 设计要点（逐条对应任务约束）

1. **SAPI 为主引擎**：离线、许可干净、零下载、Windows 11 自带。已实测枚举到 2 个声音。
2. **正文绝不进命令行**：脚本经 `-EncodedCommand`（base64(UTF-16LE)）传入，**脚本是常量、不含用户文本**；
   正文只经 **stdin**（`[Console]::In.ReadToEnd()` 读 UTF-8 JSON）。另一条受控通道
   `writeTempUtterance()` 落在 `appPaths().ttsDir`（受限 userData 下）并在用后删除。
3. **分块**：按句子边界（`。！？；!…` / `，、,：:` / 换行）切段后装箱，硬上限 **120 字符**；
   超长无标点段硬切（步长恒为正 ⇒ 数学上不可能死循环，已有 1 万字单测钉死）。
4. **取消真的生效**：`stop()` 杀在飞子进程；speak promise **必定 settle**，
   被取消时 resolve 成 `{ ok:true, completed:false, reason:'cancelled', spokenChunks }`。
5. **渲染进程零合成**：所有 `child_process` 都在主进程；renderer 只调 IPC。
6. **有界可观测**：无声音 / PowerShell 失败 → 结构化 `Result`（`TTS_FAILED`），不跨 IPC 抛异常；
   日志只记 `{ engine, voice, chars, chunks, ms }`，**永不记正文**（§5 有 grep 证据）。
7. **未引入第二个 Web 服务 / 第二个窗口 / 常驻后台守护**：探针是一次性 `--probe tts` 路径，跑完即退。

---

## 2. 实测命令与原始输出

### 2.1 环境前置核实（声音枚举）

```
PS> $PSVersionTable.PSVersion.ToString()
5.1.28000.2952

PS> Add-Type -AssemblyName System.Speech
PS> $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
PS> $s.GetInstalledVoices() | ForEach-Object { $i=$_.VoiceInfo; "enabled=$($_.Enabled) name=$($i.Name) culture=$($i.Culture) gender=$($i.Gender) age=$($i.Age)" }
enabled=True name=Microsoft Huihui Desktop culture=zh-CN gender=Female age=Adult
enabled=True name=Microsoft Zira Desktop culture=en-US gender=Female age=Adult
```

### 2.2 构建（全部成功，无告警）

```
PS> npm run build -w @airimate/shared
> @airimate/shared@1.0.0 build
> tsc -p tsconfig.json

PS> npm run build -w @airimate/desktop
> @airimate/desktop@1.0.0 build
> npm run build:main && npm run build:preload
> @airimate/desktop@1.0.0 build:main
> tsc -p tsconfig.main.json
> @airimate/desktop@1.0.0 build:preload
> tsc -p tsconfig.preload.json

PS> npm run build -w @airimate/renderer
vite v7.3.6 building client environment for production...
✓ 56 modules transformed.
dist/index.html                   1.46 kB │ gzip:   0.82 kB
dist/assets/index-LfFhu2Vi.css    7.59 kB │ gzip:   2.25 kB
dist/assets/vendor-JnVurErG.js   69.91 kB │ gzip:  27.75 kB
dist/assets/vrm-DyXoMEXQ.js     156.39 kB │ gzip:  38.90 kB
dist/assets/index-Cdr_NLJW.js   187.10 kB │ gzip:  56.64 kB
dist/assets/three-BVQP6t8l.js   588.63 kB │ gzip: 147.76 kB
✓ built in 4.18s

PS> npm run typecheck -w @airimate/renderer
> vue-tsc --noEmit -p tsconfig.json
（无输出 = 通过）
```

### 2.3 单元测试

```
PS> node --test apps/desktop/test/tts.test.cjs
ℹ tests 55
ℹ pass 55
ℹ fail 0

PS> node --test apps/desktop/test/act-parser.test.cjs      （回归，未被我改动影响）
ℹ tests 11
ℹ pass 11
ℹ fail 0

PS> node --test apps/desktop/test/memory-store.test.cjs     （回归）
ℹ tests 19
ℹ pass 19
ℹ fail 0
```

### 2.4 真实 SAPI 冒烟（手动，确认真的出声并返回声音名）

用**与产品同一条** `PS_SPEAK_SCRIPT`：正文经 stdin、`-EncodedCommand` 传脚本、回报声音名与耗时。

```
PS> # payload via stdin: {"text":"你好，这是一次语音合成自检。","voice":"Microsoft Huihui Desktop","rate":0,"volume":100}
PS> $payload | & powershell.exe -NoProfile -NonInteractive -Command $code
EXIT=0
WALL_MS=4884
STDOUT={"voice":"Microsoft Huihui Desktop","ms":4156,"spoken":true}
```

取消实测（起头 2.5s 后 `Process.Kill()`）：

```
KILL_OK=True
EXIT_CODE=-1
KILL_TO_SETTLE_MS=23
HAS_EXITED=True
STDOUT={started:true}
```

### 2.5 探针（判据 A23 的正式证据）

```
PS> node_modules\electron\dist\electron.exe apps\desktop --dev --mode=panel --no-dialogs `
      --probe tts --probe-out docs\evidence\phase2\A23-tts.json --probe-exit
===ELECTRON_EXIT=0 WALL_MS=33395===
```

`docs/evidence/phase2/A23-tts.json` 实际落盘（3879 字节）关键片段：

```json
{
  "engine": "windows-sapi",
  "maxChunkChars": 120,
  "voicesOk": true,
  "voiceCount": 2,
  "voices": [
    { "name": "Microsoft Huihui Desktop", "culture": "zh-CN", "gender": "Female", "enabled": true },
    { "name": "Microsoft Zira Desktop", "culture": "en-US", "gender": "Female", "enabled": true }
  ],
  "chosenVoice": "Microsoft Huihui Desktop",
  "chosenCulture": "zh-CN",
  "voiceSelectionStrategy": "zh-CN 优先（命中中文声音）",
  "audibleUtterance": {
    "ok": true, "completed": true, "reason": "completed", "engine": "windows-sapi",
    "voice": "Microsoft Huihui Desktop", "chars": 7, "chunks": 1,
    "durationMs": 5300, "wallMs": 5302, "echoedText": false
  },
  "multiChunkUtterance": {
    "ok": true, "completed": true, "reason": "completed",
    "chars": 420, "chunks": 4, "durationMs": 4644,
    "inputChars": 420, "plannedChunks": 4, "maxPlannedChunkChars": 105
  },
  "cancel": {
    "stopAccepted": true, "stopReturnLatencyMs": 2, "speakingBeforeStop": true, "spokenChunks": 1,
    "result": { "ok": true, "completed": false, "reason": "cancelled",
                "chars": 2100, "chunks": 20, "spokenChunks": 1, "durationMs": 2548 },
    "speakingAfter": false
  },
  "ipcSpeak": {
    "ok": true, "completed": true, "reason": "completed", "engine": "windows-sapi",
    "voice": "Microsoft Huihui Desktop", "chars": 5, "chunks": 1,
    "durationMs": 3375, "activeVoice": "Microsoft Huihui Desktop", "wallMs": 3378
  },
  "ipcStop": {
    "ipcStop": { "ok": true, "cancelled": true, "engine": "windows-sapi" },
    "ipcStopLatencyMs": 6,
    "ipcCancel": { "ok": true, "completed": false, "reason": "cancelled",
                   "chars": 700, "chunks": 7, "spokenChunks": 0, "durationMs": 1445 }
  },
  "tempFile": { "underTtsDir": true, "removed": true, "deletedAfterUse": true },
  "passedChecks": 27,
  "totalChecks": 27,
  "pass": true
}
```

### 2.6 逐块合成实测（`tts.chunk.done`，证明"真的顺序切块"）

同一 boot 的分块日志（`--dev` 开 debug 级）：

```
index=1/1 chars=7   ms=4274 output=device      ← 真实出声
index=1/4 chars=105 ms=972  output=null
index=2/4 chars=105 ms=826  output=null
index=3/4 chars=105 ms=937  output=null
index=4/4 chars=105 ms=924  output=null
index=1/20 chars=105 ms=987 output=null        ← 第 2 块处理中被取消
```

---

## 3. 27 项检查逐条对照

| # | 检查 | 实测 |
|---|---|---|
| 1 | `voicesEnumerated` | 2 个声音 |
| 2 | `zhPreferredWhenAvailable` | 选中 zh-CN |
| 3 | `audibleCompleted` | `completed:true, chunks:1` |
| 4 | `audibleVoiceIsReal` | 声音名 == 枚举值 |
| 5 | `audibleTookRealTime` | 5300ms（非空转） |
| 6 | `noTextEcho` | 结果 JSON 不含正文 |
| 7 | `multiChunkPlanned` | 规划 4 块 |
| 8 | `everyPlannedChunkWithinLimit` | 最大块 105 ≤ 120 |
| 9 | `multiChunkCompleted` | `completed:true` |
| 10 | `chunkCountMatchesPlan` | 实际 4 == 规划 4 |
| 11 | `charsPreserved` | 420 == 420 |
| 12 | `stateEventsOrdered` | `start,end,start,end` 顺序正确 |
| 13 | `stopAccepted` | `true` |
| 14 | `cancelResultShape` | `{ok:true,completed:false,reason:'cancelled'}` |
| 15 | `cancelPrompt` | 2ms |
| 16 | `cancelInterruptedMidSpeech` | 20 块中说完 1 块被截断（`0<1<20`） |
| 17 | `engineIdleAfterCancel` | `speaking:false` |
| 18 | `stopIdempotentWhenIdle` | 空闲 `stop()` 返回 `false` |
| 19 | `ipcVoicesOk` | 经 IPC 拿到 2 个声音 |
| 20 | `ipcVoicesShape` | `engine` + `selected` 齐备 |
| 21 | **`ipcSpeakOk`** | 经 IPC 说完整句（3375ms） |
| 22 | `ipcSpeakReturnedVoice` | 回传真实声音名 |
| 23 | `ipcStopAccepted` | `cancelled:true` |
| 24 | **`ipcCancelSettled`** | 8s 内 settle，`reason:'cancelled'`（**未悬挂**） |
| 25 | `ttsSettingRestored` | 探针还原了 `ttsEnabled`，无副作用 |
| 26 | `tempFileInRestrictedDir` | 落在 `%APPDATA%\AiriMateOne\tts\` |
| 27 | `tempFileDeleted` | 用后即删 |

---

## 4. 隐私核实（本项目日志脱敏纪律）

```
PS> Get-Content $log | Select-String -Pattern '语音合成自检'
matches for probe spoken text: 0
```

朗读正文（`语音合成自检。` 等）**在任何日志行中出现 0 次**；日志只含
`{engine, voice, chars, chunks, ms, index, output}`。`%APPDATA%\AiriMateOne\tts\` 残留文件数 = 0。

载荷形状单测也钉死了"是否泄漏"这一点：`buildSpeakPayload` 只产出
`{text, voice, rate, volume, output}` 五个键，且 `PS_SPEAK_SCRIPT` 中不含 `$args`（正文不可能经命令行传入）。

---

## 5. 过程中发现并修复的两个**真实缺陷**（非本次任务引入，但阻断了它）

### 5.1 `parsePsJson` 用 `lastIndexOf('{')` 切 JSON ⇒ 静默解析失败

PowerShell 的回包是**嵌套**的：`{"ok":true,"voices":[{"name":…},…]}`。
用"最后一个 `{` 到最后一个 `}`"去切，切到的是**数组里最后一个元素**：

```
[dbg] JSON.parse threw: Unexpected non-whitespace character after JSON at position 84
      slice="{\"name\":\"Microsoft Zira Desktop\",...}]}"
```

该切片**以 `}` 结尾**，所以既不报错也不报空，只是 `JSON.parse` 抛错被 catch 吞掉，
表现为"声音枚举失败（exit=0）"——**看起来像 PowerShell 的问题，其实是解析器的问题**。
已改为按括号深度扫描（含字符串/转义状态机），并有单测钉死该形状。

### 5.2 `packages/shared/src/` 里的陈旧编译产物遮蔽 TS 源码

`packages/shared/src/` 存在 18 个 0:14 时间戳的编译产物（`.js` / `.js.map` / `.d.ts`）。
`index.ts` 用 ESM 风格的 `export * from './ipc.js'`，于是 Vite / esbuild 的
"先精确匹配再补扩展名"解析规则**优先命中陈旧的 `ipc.js`** 而不是 `ipc.ts`：

```
$ npx esbuild --bundle packages/shared/src/index.ts  →  新导出全部 missing
Error: "manifestSemantic" is not exported by "../../../packages/shared/src/index.ts"
（同一份源码 tsc 构建出的 dist 导出正常 ⇒ 只有源码别名路径受影响）
```

这就是 `packages/avatar-stage/src/stage.ts` 里那条注释记录的现象
（"清缓存、重建 dist 都无效"），上一轮的做法是把两个取值函数**内联**绕过去，
根因一直留着。本次已删除这 18 个陈旧产物（备份在 `%TEMP%\airi-shared-src-artifacts-backup`），
之后 `manifestSemantic` / `manifestClipId` / 新 schema 全部正常导出，renderer 构建通过。

> ⚠ **未做**：清理后 `stage.ts` 里的内联副本仍保留（语义与 shared 一致）。
> 合并它们属于 stage 包的重构，不在本任务范围。

### 5.3 `StageSnapshotSchema` 缺 `phase` ⇒ 字段被静默丢弃

运行时 `stage.ts` 的 `snapshot()` **一直在产出** `phase`（`director.getPhase()`），
但 schema 没有该键 ⇒ zod 默认**静默丢弃**，renderer 读 `snap.phase` 永远 `undefined`
（`vue-tsc` 也报错）。已按 `MotionRuntime` 的真实取值域补为枚举，
并用 `.catch('uninitialized')` 保证未知相位不会让整条快照校验失败。

---

## 6. 未验证 / 已知边界（NOT VERIFIED）

| 项 | 状态 |
|---|---|
| **renderer 端到端"聊天回复自动朗读"** | **NOT VERIFIED**。代码已接通（`store.ts` 的 `onChatDone` → `bridge.speak`，受 `ttsEnabled` 控制），renderer 也构建+类型检查通过；但**没有**用真实供应商跑一轮 `chat:send` 来观察它自动出声——本机无可用 API 密钥，且任务禁止假设密钥存在。已验证的是它依赖的每一环（IPC 三通道、引擎、设置持久化）。 |
| **设置面板 UI 的人工点击验证** | **NOT VERIFIED**。未对 `SettingsPanel.vue` 做点击级验证（无 UI 自动化）。`ttsEnabled` / `ttsVoice` 的持久化字段本身已由 schema 保证，且探针验证了 `ttsEnabled` 的开关-还原往返。 |
| **`evt:tts-state` 在真实渲染进程里的 UI 表现** | **NOT VERIFIED**。主进程侧 `onState` 回调顺序已被探针断言（`stateEventsOrdered`），但 renderer 把它渲染成"正在说话"的视觉表现未截图验证。 |
| **非 zh-CN / 无中文声音机器的行为** | **NOT VERIFIED**（本机有 zh-CN 声音，走了优先分支）。回退分支只有单测覆盖（`没有 zh-CN → 回退第一个可用声音`），无真机实测。 |
| **`ttsProviderId` 设置项** | **未使用**。schema 里有该字段（历史预留，本用于云端 TTS），当前 SAPI 实现不需要它；未删除以免破坏契约。 |
| **长文本完整听完（>120 字）** | 仅以 `null` 输出（合成不播放）验证了多块**顺序合成**；未用扬声器实听完整长段（避免骚扰，且 420 字 ≈ 67s）。单块真实出声已验证。 |
| **`writeTempUtterance` 在产品路径中的使用** | 该通道已实现并单测/探针验证（受限目录 + 用后即删），但**当前 SAPI 路径不经过它**（正文走 stdin 更干净）。保留它作为受控落盘通道备用。 |
| 音频回传到 renderer（`evt:tts-audio`） | **未实现**。当前是主进程直接驱动系统扬声器，不经 renderer 播放音频（无需第二个音频管线）。 |

---

## 7. 无硬阻断

本机 **有** zh-CN 声音（`Microsoft Huihui Desktop`），PowerShell 5.1 未阻止 `System.Speech`，
探针可无头运行（`--no-dialogs`）并成功写盘。**未遇到阻断项**。
若将来在无声卡的机器上运行：`tts:speak` 会返回结构化 `TTS_FAILED`（而不是假装成功），
设置面板会显示"本机没有可用的语音合成声音"。
