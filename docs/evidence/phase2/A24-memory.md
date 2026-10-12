# A24 —— 长期记忆层端到端验收（阶段 2）

**结论：PASS（12/12 判据），`pass: true`。**
证据文件：`新工程/docs/evidence/phase2/A24-memory-e2e.json`（由应用自己写出的原始 JSON，非手工整理）

---

## 1. 为什么"记忆层"需要单独一轮验收

记忆层是**唯一一个"错了不会报错"的子系统**：召回排序错了、注入根本没发生、
或者只写在内存里没落盘 —— 界面上一切正常，只是角色开始记错事。
所以验收不能只测存储层，必须**按证据链的每一跳分别取数**：

| 跳 | 要证明的事 | 判据字段 | 结果 |
|---|---|---|---|
| ① | IPC 通道真的注册了（合约没漏） | `passIpcAdd` | ✅ |
| ② | 真的**落盘**（不是只在内存缓存里） | `passPersisted` | ✅ |
| ③ | 冷读（丢缓存后从磁盘读）能读回 | `passColdRead` | ✅ |
| ④ | IPC 召回通道可用且排序正确 | `passIpcRecall` | ✅ |
| ⑤ | main 侧入参校验**真的拒绝**越界输入 | `passSchemaReject` / `passSchemaRejectEmpty` | ✅ |
| ⑥ | `chat:send` 真的走到注入那一步 | `passChatAccepted` | ✅ |
| ⑦ | 记忆**真的进了系统提示** | `passInjected` | ✅ |
| ⑧ | 无相关记忆时**不塞空段落** | `passNoInjectionWhenIrrelevant` | ✅ |
| ⑨ | 注入次数被如实计数 | `passInjectionCounted` | ✅ |
| ⑩ | IPC 删除可用 | `passIpcDelete` | ✅ |
| ⑪ | 删除后**磁盘上也没了** | `passGoneFromDisk` | ✅ |

第 ⑤ 跳值得单独说：只测"合法输入能过"证明不了校验存在（没有校验也照样过）。
所以探针故意发**超长文本（5000 字符，上限 4000）**与**空查询**，必须被拒且
`code === 'IPC_SCHEMA'`。实测两条都被拒。

---

## 2. 关键实现（本轮新增/修正）

### 2.1 本轮**修掉的两个真实缺陷**（由单测暴露，非猜测）

这两条都不是"顺手重构"，是**测试跑出来的红**：

**缺陷 1 — 中英混排导致召回永久失效。**
`tokenize('很长的星空记忆条目0')` 的旧实现先按"拉丁/数字/中文"切出一个混排段，
再对混排段按字符类型二次切分，于是中文部分被切成**单字**，随后被
"长度 ≥ 2" 的过滤条件**全部丢弃**：

```
旧：tokenize('很长的星空记忆条目0') → ["长","星","空","记","忆","条","目"]   ← 全被过滤 ⇒ [""]
     tokenize('星空')                → ["星空","星空"]
     ⇒ 查询能切出 `星空`，记忆切不出 `星空` ⇒ 该记忆**永远召不回**
```

修法：混排段与纯中文段走**完全相同**的切法（`pushCjkRun`，只切中文连续段、切二元组）。

```
新：tokenize('很长的星空记忆条目0') → ["很长","长的","的星","星空","空记","记忆","忆条","条目"]  ✅
```

**缺陷 2 — 去重时返回了一个"列表里不存在"的 id。**
`addMemory()` 命中重复文本时更新了存储，却 `return entry`（那个刚构造、从未落盘的临时对象）。
调用方拿到的 id 在 `listMemory()` 里查不到 —— 一个会静默传播的契约违背。
修法：去重分支返回**存储里真实存在的那一条**（保留 id / tags / 使用统计，只更新重要度与时间）。

### 2.2 新增文件与改动

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/main/memory-state.ts` | **新增**。记录"最后一次记忆注入"的可判定证据：条数、字符数、**内容指纹（sha256 前 12 位）**、注入次数。**不保存记忆正文** —— 指纹足以证明"注入的就是这块内容"，但无法从诊断包还原用户说了什么。 |
| `apps/desktop/src/main/memory-store.ts` | 修正分词与去重返回值；新增 `buildMemoryBlock()`（一次召回同时给出块与命中数）、`reloadFromDisk()`、`memoryFileProbe()`。 |
| `apps/desktop/src/main/ipc.ts` | `memory:list/add/delete/recall` 从 `NOT_IMPLEMENTED` 占位改为**真实实现**，入参全部走 zod 校验。 |
| `packages/shared/src/ipc.ts` | 新增 `MemoryAddRequestSchema` / `MemoryDeleteRequestSchema` / `MemoryRecallRequestSchema` / `MemoryRecallHitSchema`（契约真源）。 |
| `packages/shared/src/preload-api.ts` + `apps/desktop/src/preload/index.ts` | 暴露 `recallMemory()`，并收紧 `addMemory` / `deleteMemory` / `listMemory` 的返回类型。 |
| `apps/desktop/src/main/diagnostics.ts` | 诊断快照新增 `memory` 字段（只有长度/条数/指纹）。 |

**为什么要多一个 `buildMemoryBlock()`**：调用方若为了"知道命中几条"再调一次 `recall()`，
会把 `lastUsedAt` / `useCount` **算成两倍**，"最近使用加成"随之失真。命中信息只能从这一次召回里取。

### 2.3 一次真实踩到的顺序陷阱

第一次跑探针时 `pass: false`，失败项集中在注入链路上，原始输出是：

```json
"chatSend": {"ok": false, "code": "PROVIDER_MISSING",
             "message": "还没有配置供应商：请先在设置里添加 baseUrl / 模型 / 密钥"}
```

原因：`chat:send` 在**没有配置供应商时会提前 return**，根本走不到记忆注入那一步。
这不是记忆层的问题，但会让"注入是否发生"这个判据**永远测不出来**。
修法：探针临时建一个供应商 + 一把**故意无效**的密钥（只为让请求真的发出去，
期望链路以 `auth` 失败 —— 这与记忆无关），跑完立即 `deleteProvider` + `clear` 清理。

---

## 3. 运行的命令与原始结果

### 3.1 单元测试（30/30）

```
cd "F:\deepseek harness\AI女友\新工程"
node --test apps/desktop/test/act-parser.test.cjs apps/desktop/test/memory-store.test.cjs
```

```
ℹ tests 30
ℹ pass 30
ℹ fail 0
ℹ duration_ms 3910.8175
```

覆盖：分词（中文二元组 / 中英混排 / 停用词 / 大小写 / 纯符号）、
去重（同文本同 id、重要度取大）、删除（重复删除返回 false）、
容量上限（900 次写入后 ≤ 800）、落盘可解析、召回排序（相关性优先、
重要度加权、降序、分数四舍五入）、空查询、`limit` 生效、使用统计回写、
`recallAsSystemBlock` 无命中返回 `null` 且受 `maxChars` 截断、
**损坏文件降级为空记忆**（写坏 JSON 后仍能启动并继续写入）。

### 3.2 端到端探针

```
.\node_modules\electron\dist\electron.exe apps\desktop --dev --mode=panel --no-dialogs `
  --probe memory --probe-out "docs\evidence\phase2\A24-memory-e2e.json" --probe-exit
```

原始输出（节选，完整见 JSON 证据文件）：

```json
{"steps":[{"step":"list-before","ok":true,"total":0},
          {"step":"ipc-add","ok":true,"entryId":"m_muiqx48f_1","total":1},
          {"step":"disk-after-add","exists":true,"bytes":317,"containsTestText":true},
          {"step":"cold-read","count":1,"hits":1,"topText":"用户养了一只叫豆豆的猫，最喜欢抹茶拿铁"},
          {"step":"ipc-recall","ok":true,"count":1,"score":1.415},
          {"step":"schema-reject-oversize","ok":false,"code":"IPC_SCHEMA"},
          {"step":"injection","chars":43,"hits":1,"fingerprint":"4e9588dfdefb","queryChars":10,"totalInjections":1},
          {"step":"ipc-delete","ok":true,"removed":true,"total":0}],
 "passIpcAdd":true,"passPersisted":true,"passColdRead":true,"passIpcRecall":true,
 "passSchemaReject":true,"passSchemaRejectEmpty":true,"passChatAccepted":true,
 "passInjected":true,"passNoInjectionWhenIrrelevant":true,"passInjectionCounted":true,
 "passIpcDelete":true,"passGoneFromDisk":true,
 "injectionNegative":{"chars":0,"hits":0,"fingerprint":null,"queryChars":14,"totalInjections":2},
 "diskAfterDelete":{"exists":true,"bytes":36,"containsTestText":false},
 "cleanedUp":true,"pass":true}
```

读数解释（每条都能被独立复核）：
- `disk-after-add.bytes = 317` → 写入后磁盘文件从 0 涨到 317 字节，`containsTestText = true`；
- `cold-read` 是**丢缓存后**重新读盘得到的结果，所以"落盘"不靠推测；
- `injection.chars = 43` 且 `fingerprint` 非空 → 记忆块真的被拼进了本轮提示；
- `injectionNegative` 的 `chars = 0`、`fingerprint = null` → 无关输入**没有**被注入空段落
  （这条是负例判据：只测正例无法区分"总是注入"和"该注入时才注入"）；
- `diskAfterDelete.bytes = 36` → 删除后只剩 `{"version":1,"entries":[]}` 的空壳，测试文本已消失。

> 说明：探针进程退出码为 `1`。这是 `--probe-exit` 走 `quit('probe')` 路径的既有行为
> （与既往 a10/a11/a14/a19 探针一致），**不是**失败信号；判定以 JSON 里的 `pass` 字段为准。

---

## 4. NOT VERIFIED（明确未验证，不得当作已完成）

| 项 | 状态 | 说明 |
|---|---|---|
| 跨**进程重启**的持久化 | ✅ **PASS**（见 §3.3） | 三趟独立进程，写入进程与读取进程 `bootId` 不同，读回的 `id` 与写入的 `id` 完全一致。 |
| 记忆的**自动写入** | `NOT VERIFIED` | 目前只有显式 `memory:add`（用户/设置面板）写入。**没有**从对话内容自动抽取记忆的实现 —— 这是设计取舍（自动抽取容易记错、且不可解释），但必须说清：**角色目前不会自己记事**。 |
| 嵌入/向量召回 | `NOT VERIFIED` | 当前召回是"中文二元组 + 重要度 + 新近度"的可解释打分。语义相近但用词不同的输入（如"我家猫咪" vs "养了只猫"）**可能召不回**。本机无法确认嵌入模型的可用性与体积，故未引入。 |
| 记忆条数上限的**淘汰策略**实测 | `NOT VERIFIED` | 单测覆盖了"总数 ≤ 800"，但"被淘汰的确实是低重要度 + 最旧的那条"只有代码可读性保证，没有断言。 |
| `memory.json` 的**加密落盘** | `NOT VERIFIED` | 记忆正文目前是**明文** JSON（仅 API 密钥走 safeStorage 密文）。是否为记忆正文也加密，属于待决策项；当前口径是"私密数据只落本地用户目录，不进日志、不进诊断包、不进分发包"。 |

---

## 3.3 跨进程持久化（真正的"重启后还记得"）

`--probe memory` 里的"冷读"是**同一进程内**丢缓存后重读磁盘 —— 它能证明"数据在磁盘上"，
但证明不了"下一个进程读得回来"。所以另做三趟独立启动：

```
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\check-memory-restart.ps1
```

```
[qa] 运行探针 1-write ...
  写入 id=m_muir0ycr_1 pass=True exitCode=0
[qa] 运行探针 2-read ...
  写入 id= pass=True exitCode=0
[qa] 运行探针 3-cleanup ...
  写入 id= pass=True exitCode=0

bootId(写) = efe9bfdd-8db0-4eee-9b6b-21f534f34731
bootId(读) = ac87553a-be0f-4144-a64b-6fc09506ce32
写入 id    = m_muir0ycr_1
读回 id    = m_muir0ycr_1
读回正文   = AIRIMATE_MEMPROBE_跨进程持久化标记（写入进程 bootId=efe9bfdd-8db0-4eee-9b6b-21f534f34731）
清场后残留 = 0

A24 跨进程持久化：PASS
```

可复核点：
- **两个 `bootId` 不同** ⇒ 确实是两个进程，不是同一进程跑两遍（这是本判据唯一有效的证据形式）；
- 读回正文里嵌着**写入进程的 bootId**，与第一趟的 `bootId(写)` 逐字符一致 ⇒ 读到的就是那一趟写的那条；
- 清场后残留 0 ⇒ 探针不污染用户真实记忆。

证据文件：
- `docs/evidence/phase2/A24-restart-summary.json`（汇总）
- `docs/evidence/phase2/A24-restart-1-write.json` / `-2-read.json` / `-3-cleanup.json`（三趟原始输出）
- `docs/evidence/phase2/A24-restart-*.stderr.log`（各趟 stderr，用于失败时排障）

### 本脚本踩到的两个环境坑（已写进脚本注释，避免重犯）

1. `& $electron @args 2>&1 | Select-String ...` 会让脚本**当场中断**：
   electron 的应用日志走 **stderr**，在 `$ErrorActionPreference='Stop'` 下
   PowerShell 5.1 把原生命令的 stderr 当作终止性错误（`NativeCommandError`），
   探针根本没跑完 —— 而输出被管道过滤后看起来"什么都没发生"。
2. `Start-Process -RedirectStandardError` 在本机**起不来**：环境里同时存在
   `NO_PROXY` 与 `no_proxy`，5.1 构造环境块时抛 `Item has already been added. Key: 'NO_PROXY'`。

最终采用：调用运算符 + **PowerShell 原生文件重定向** `2> file`，并把
`$ErrorActionPreference` 临时降为 `Continue`（只作用于这一次调用），
退出码单独记录，**判定只认 JSON 的 `pass` 字段**。

### 一个必须先说清的行为：探针是在"旧实例告警被忽略"的状态下跑的

本机旧方案（MateEngineX / airi / host）**当前仍在运行**，所以每次启动都会命中
`legacy.hits` 且 `blocking: true`；因为 QA 传了 `--no-dialogs`，应用按既有设计
**覆盖阻断并继续启动**，日志留痕：

```json
{"msg":"检测到旧实例","fields":{"count":4,"blocking":true,
  "kinds":"legacy-bridge,mate-engine-kernel,legacy-brain,legacy-airi-combo"},"event":"legacy.hits"}
{"msg":"用户选择忽略旧实例告警继续启动（已记录）","fields":{"noDialogs":true},"event":"legacy.block.overridden"}
```

这不影响记忆层判据的有效性（记忆层与旧实例无关），但**必须记录**：
本轮所有证据都产自"旧实例仍在运行"的环境，`A3`（旧窗口为 0）因此仍为 `NOT VERIFIED`。

---

## 5. 下一步

1. ~~补"跨进程重启持久化"证据（两次启动对照）。~~ ✅ 已完成，见 §3.3。
2. 决定是否为记忆正文加密（若需要，复用 `secrets-store` 的 safeStorage 通道）。
3. 记忆管理 UI（设置面板里列出/删除/查看召回结果）—— 通道已就绪，界面未接。
