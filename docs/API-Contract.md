# API Contract · AiriMate One

> 与 `PRD.md` / `Tech-Spec.md` / `Acceptance-Matrix.md` 配套。本文冻结**跨层接口**：
> 主进程 ↔ 渲染进程、会话层 → 动作层、动作层 → 舞台层、以及资源与配件的路径契约。
> **唯一真源是代码**：`packages/shared/src/*.ts`（类型 + zod 运行时校验）。
> 本文只做索引与语义说明；若本文与代码冲突，**以代码为准**并立即修文档。

---

## 1. 分层与依赖方向（不可反转）

```
apps/desktop (main)  ──IPC(白名单+schema)──►  apps/renderer
        │                                          │
        │ 读清单 / 读设置 / 管窗口                  │
        ▼                                          ▼
  packages/shared ◄──────── 双方共同依赖 ────────► packages/shared
        ▲                                          ▲
        │                                          │
 packages/security                        packages/avatar-stage
 (路径/脱敏/密钥/CSP)                      packages/radial-menu
                                          packages/motion-director（纯决策）
```

- **依赖只能向下**：`shared` 不依赖任何包；`security` 只依赖 `shared`；
  `avatar-stage` / `radial-menu` 依赖 `shared`；`renderer` 依赖以上全部；`desktop` 依赖 `shared` + `security`。
- **禁止**：`avatar-stage` 反向依赖 `renderer`；`shared` 依赖 `electron` 或 `three`。

---

## 2. IPC 通道（白名单，50 条）

通道名常量：`packages/shared/src/ipc.ts` 的 `IPC`。**preload 内联了一份副本**，
由 `assertContract()` 逐条比对（防漂移）。渲染进程**只能**通过 `window.airimate`（`AiriMateApi`）访问。

### 2.1 调用类（`invoke`，有返回值）

| 通道 | 入参 schema | 出参（`Result & …`） | 说明 |
|---|---|---|---|
| `app:diagnostics` | — | `{ ok, diagnostics }` | 只读诊断快照（含 `stage`） |
| `app:show` / `app:hide` | — | `Result` | 显示 / 隐藏窗口 |
| `app:quit` | — | `Result` | 真正退出（唯一入口之一） |
| `app:startup:get` | — | `{ enabled, entries }` | 开机自启状态 + 自启项盘点 |
| `app:startup:set` | `{ enabled }` | `{ ok, detail, legacyMoved, backupDir }` | 写入唯一启动项并备份/迁移旧项 |
| `legacy:scan` | — | `{ result: LegacyScanResult }` | 只读扫描旧实例 |
| `window:get-mode` | — | `{ mode, bounds }` | 当前模式（**会话级覆盖优先**） |
| `window:set-mode` | `SetModeRequest` | `{ mode, bounds }` | 同窗切换（不重建窗口/renderer/角色） |
| `window:set-always-on-top` | `{ on }` | `Result` | |
| `window:center` | — | `Result` | 移到主屏工作区中央 |
| `window:drag-begin` | `DragBeginRequest` | `Result` | 开始拖拽（主进程以 60Hz 自行推进） |
| `window:drag-end` | `DragEndRequest` | `{ moved, distance, bounds }` | 结束并**一次性**记录几何 |
| `window:auto-resize` | `AutoResizeRequest` | `{ applied, reason }` | pet 模式按角色需要调整尺寸（拖拽中拒绝） |
| `settings:get` | — | `{ settings }` | |
| `settings:patch` | `SettingsPatch` | `{ settings }` | 会话级模式覆盖生效时**忽略 `mode` 回写** |
| `motion:list` | — | `{ manifests, failed, clipIds }` | 清单 + 磁盘上实际存在的 clip id |
| `motion:reload` | — | 同上 | 重新扫描并显式告警 |
| `avatar:catalog` | — | `{ catalog }` | 角色清单（**只含路径引用**） |
| `provider:list` | — | `{ backend, providers }` | **永不返回 apiKey**，只有指纹+长度 |
| `provider:upsert` | `ProviderUpsert` | `Result` | apiKey 单向传入，主进程加密后丢弃明文 |
| `provider:delete` / `provider:test` | `{ id }` | `Result` | |
| `persona:get` / `persona:set` | `Persona` | `Result` | |
| `chat:send` | `ChatSendRequest` | `{ requestId }` | 触发一轮会话 |
| `chat:abort` / `chat:history` / `chat:clear` | — | `Result` / `{messages,total}` | |
| `memory:list` / `memory:add` / `memory:delete` | — | `Result` / `{entries}` | |
| `tts:speak` / `tts:stop` / `tts:voices` | — | `Result` / `{voices}` | |
| `telemetry:report` | — | `Result` | |

### 2.2 高频单向（`send`，无返回值）

| 通道 | 入参 schema | 说明 |
|---|---|---|
| `window:drag-move` | `DragMove` | 兼容路径（主进程自己有定时器驱动） |
| `hitregions:update` | `HitRegions` | renderer 上报可交互区域 ⇒ 主进程决定 `setIgnoreMouseEvents` |
| `stage:snapshot` | `StageSnapshot` | renderer 主动推送舞台快照（主进程据此回答 `app:diagnostics`，**不用 `executeJavaScript` 取数**） |

### 2.3 广播类（main → renderer）

`evt:stage-command`（`StageCommand`）、`evt:alert`（`Alert`）、`evt:chat-delta` / `evt:chat-done` / `evt:chat-error`、
`evt:mode-changed`、`evt:window-state`、`evt:drag-pos`（拖拽期**真实窗口位移**，驱动摇晃）、
`evt:tts-state`、`evt:settings-changed`。

> **纪律**：任何未在 `IPC` 常量里列出的通道都不会被监听；
> 入站消息在**两侧**都用 zod 校验，失败即拒绝并**脱敏**记日志（只记通道名与字段路径）。

---

## 3. 统一动作事件（唯一数据流）

定义：`packages/shared/src/commands.ts`。会话层产出 → `MotionDirector` 消费 → `AvatarStage` 执行。

| 命令 | 关键字段 | 语义 |
|---|---|---|
| `EmotionCommand` | `emotion`(6 种 VRM 标准名) / `intensity` / `durationMs` / `fadeInMs` | 表情叠加层 |
| `MotionCommand` | `motion`(13 种语义) / `layer` / `once` / `fadeMs` / `interrupt` | 基础或叠加动作 |
| `SpeechCommand` | `text` / `speak` / `visemeSource` / `utteranceId` | 口型 + 可选 TTS |
| `VisibilityCommand` | `target`(character/chatPanel/bubble/wheel) / `visible` | |
| `WindowModeCommand` | `mode`(panel/pet) / `center` | 同窗切换 |

**优先级（不可协商）**：拖拽 > 一次性 > 状态（走/坐/睡）> 待机轮换。
**禁止**：DOM 层再解析一次动作标记；两处各驱动一次。

---

## 4. 动作清单（manifest）契约

`MotionClipManifestSchema`（`packages/shared/src/ipc.ts`）。**已按动作管线的真实 sidecar 收敛**（16/16 通过校验）。

| 字段 | 类型 | 来源 |
|---|---|---|
| `name` | string | **唯一标识**（= `.vrma` 文件名去扩展名） |
| `slug` / `set` / `clip` / `vrma` | 可选 | 管线附加信息（`clip`/`vrma` 容忍字符串或对象） |
| `source` / `sourceRelative` / `sourceBytes` | | 源 `.anim` 可追溯信息 |
| `duration` | number | 时长（秒） |
| `loopable` / `loop` | 布尔或对象 | 是否可无缝循环 |
| `rootDisplacement` | unknown | 根位移范围 |
| `perBoneActivityDeg` | record | 逐骨总角行程（度） |
| `legActivity` | number 或 record | 腿活动量 |
| `allowedOverlayLayers` | string[] | 允许叠加的层 |
| `curveStats` / `warnings` / `outOfRangeMuscles` / `unverified` | | 管线自报的诊断与未验证项 |

统一取值入口：`manifestClipId()` / `manifestSemantic()`（Node 侧在 `shared`；renderer 侧在 `stage.ts` 内联，语义一致）。

---

## 5. 舞台只读快照（验收探针的唯一数据源）

`StageSnapshot`（`packages/shared/src/ipc.ts`），由 renderer 每 200ms 推送给主进程：

- **实例计数**：`sceneCount` / `rendererCount` / `mixerCount` / `vrmCount` / `live2dCount`
- **动作状态**：`baseClipId` / `activeClip` / `activeWeight` / `crossfade` / `idleIndex` / `idleTotal` / `dragging`
- **骨骼**：`bones`（17 根必需骨的四元数）+ `boneTravelAccum`（逐骨累计角位移，度）
- **性能**：`fps{avg1s,avg5s}` / `heapMB` / `wheel{open,cx,cy,scale}`
- **取景与渲染实测**（`view`）：canvas CSS/buffer 尺寸、`rendererSize`、`pixelRatio`、相机位姿、`modelBox`、
  `inFrustum`、`visibleMeshes`/`mtoonMeshes`/`skinnedMeshes`、`drawCalls`/`triangles`、
  `rafTicks`/`intervalTicks`/`paused`、`screenRect`、`canvasNonBgRatio`、`pixelStats`（众数背景基准）、
  `meshDraw`（逐 mesh 绘制可行性）、`modelHealth`（尺度/骨骼高度/顶点数/清屏色/像素采样/蒙皮/`skinProbe`）

> 设计要点：**探针全部返回 plain 对象**（`executeJavaScript` 走 IPC，返回类实例会
> `An object could not be cloned.` 而**静默失败**——实测踩到过）。

---

## 6. QA 探针入口（主进程 CLI）

| 参数 | 作用 |
|---|---|
| `--diagnostics <file>` | 启动 4s 后写一次诊断快照，之后每 8s 刷新（**原子写**） |
| `--diag-once[=ms]` | 到点导出诊断并退出 |
| `--taskbox` / `--testbox` | 红方块对照实验（V1 相机/投影判据） |
| `--selfcap <png>` | renderer 自拍当前帧落盘 + 两条像素读数 |
| `--probe a10 --probe-out <json> [--probe-shot <png>] [--probe-exit]` | 轮盘锚点精度 + 命中一致性 + 不越界 |
| `--probe a11 --probe-out <json>` | 输入语义（**短按不动 / 越 4 CSS px 阈值且命中角色才拖 / 右键·F1·Esc 开合轮盘**；判据 2026-09-27 重写） |
| `--probe a12 / a13 / a14 --probe-out <json>` | 腿部运动（任一根 >5° 且 4 骨总行程 >20°）/ 待机轮换 / 拖拽（窗口跟随 + **尺寸读数恒定** + 动作切换 + 弹簧回正） |
| `--probe clickOnly / clickRepeated20 / dragStart / dragEnd / dragRepeated50` | 交互细项（单击无副作用 / 连点 20 次 / 进入拖拽 / 松手复位 / 50 次拖动零漂移） |
| `--probe idleAnchor60s / clipSwitchCamera / clipPoses / avatarVisible / wheelStable / rootMotionIdle / layoutDiag / sizeDiag` | 取景与稳定性（60s 锚点与相机 / 10 clip 相机不变 / 动作转换 / 可见性 / 轮盘三次开合 / 根位移策略 / DOM 布局 / 窗口尺寸地面真值） |
| `tools/qa/run-probe.ps1 -Name <探针名> [-Mode panel\|pet]` | **推荐的探针入口**：自动清理遗留实例/互斥体/锁 → 跑 → 落盘 JSON → 打印 `pass` |
| `--mode panel\|pet` | **会话级**模式覆盖（不写回设置） |
| `--no-dialogs` | QA/自动化专用：不弹阻断对话框，避免脚本挂住 |

---

## 7. 资源与路径契约

| 协议 | 授权根 | 扩展名白名单 | 单文件上限 |
|---|---|---|---|
| `app://bundle/` | `apps/renderer/dist` | web 类 | 64 MB |
| `app://asset/` | `assets/motion` | 资产类 | 256 MB |
| `app://model/` | 由 `assets/models/catalog.json` 的 `avatar.path` **动态授权其所在目录** | 资产类 | 256 MB |

**每次请求都必须过** `resolveWithinGrants()`：拒绝 NUL、`..`、Windows 驱动器/UNC 路径、ADS、设备名；
`realpath` 后再判一次（防 symlink/junction 逃逸）；失败一律 404 且**不回显绝对路径**。

**分发纪律**：`assets/models/catalog.json` 只含**路径引用与完整性信息**；
`.vrm` / `.vrma` / `.anim` **不得进入分发包**。

---

## 8. 错误与日志契约

- `AiriMateError { code, message, detail }`，`code` 取自 `ErrorCode` 枚举（`packages/shared/src/errors.ts`）。
- `Result = { ok: true } | { ok: false, code, message }`：**所有 IPC 出参**都用它表达失败，
  不允许用异常跨进程传递。
- `LogRecord { ts, level, scope, msg, fields, event? }`；写入前经 `redactText()`
  （云密钥前缀 / Bearer / JWT / 长 hex / 长 base64 / `KEY=…` 赋值）。
- **对话正文不进日志**：只记长度与哈希。

---

## 9. 版本与兼容

- `CONTRACT_VERSION = '1.0.0'`：preload 暴露给 renderer，renderer 启动时自检；
  不一致即显示阻断告警（不静默）。
- IPC 通道名与 schema 的变更属于**契约变更**：必须同时改
  `packages/shared/src/ipc.ts`、preload 的内联副本、以及本文档。
