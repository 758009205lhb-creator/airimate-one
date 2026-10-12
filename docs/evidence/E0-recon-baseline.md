# E0 · 环境与来源取证基线（AiriMate One）

> 采集人：首席架构师（队长） · 采集方式：本机活体命令 · 本文件只记录**实测原始结果**，不含推测。
> 与本文冲突的旧文档一律作废；以本文为准。

---

## 1. 网络与工具链（决定"能不能拿到 AIRI 源码"）

| 探测目标 | 命令 | 原始结果 | 结论 |
|---|---|---|---|
| GitHub HTTPS | `Invoke-WebRequest -Method Head https://github.com` | `基础连接已经关闭: 发送时发生错误。` | **不可达** |
| GitHub via git | `git ls-remote https://github.com/moeru-ai/airi` | `fatal: unable to access ... schannel: failed to receive handshake, SSL/TLS connection failed`（EXIT=128） | **不可达** |
| GitHub 经本地代理 | `curl.exe -x http://127.0.0.1:7890 https://github.com` | `000` | **代理也不通** |
| raw.githubusercontent | `curl --max-time 20 https://raw.githubusercontent.com/moeru-ai/airi/main/package.json` | `000` | 不可达 |
| cdn.jsdelivr.net | 同上 | `000` | 不可达 |
| unpkg.com | 同上 | `000` | 不可达 |
| ghproxy.net / gh-proxy.com / ghfast.top / hub.fastgit.org / raw.gitmirror.com | `Invoke-WebRequest -Method Head` | 全部 `The operation has timed out.` | 不可达 |
| registry.npmjs.org | `Invoke-WebRequest -Method Head` | `基础连接已经关闭` | 不可达 |
| **registry.npmmirror.com** | `Invoke-WebRequest -Method Head` | **HTTP 200** | **可用（唯一可用依赖通道）** |
| gitee.com | `Invoke-WebRequest -Method Head https://gitee.com/mirrors` | **HTTP 200** | 可用，但检索 `airi` / `moeru-ai` **命中 0 个仓库** |
| 本地代理端口 | `Test-NetConnection 127.0.0.1 7890` | `TcpTestSucceeded = True` | 端口在听，但对以上目标无效 |
| 系统代理设置 | `netsh winhttp show proxy` | `Direct access (no proxy server).` | WinHTTP 直连；IE 设置 `ProxyEnable=1 127.0.0.1:7890` |

**工具链**

| 工具 | 版本 / 路径 |
|---|---|
| Node | `v24.19.0` |
| npm | `11.17.0`（默认 registry 仍是 `https://registry.npmjs.org/`，**必须显式加 `--registry=https://registry.npmmirror.com`**） |
| pnpm | `C:\Users\shiqian\AppData\Local\deepseek-harness\bin\pnpm.ps1` |
| git | `2.55.0.windows.4` |
| PowerShell | `5.1.28000.2952`（**无 PS7**，交付命令一律 5.1 语法；`powershell.exe` = `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`） |
| Electron（已安装，可直接复用） | `44.4.5`，二进制 `F:\deepseek harness\AI女友\node_modules\electron\dist\electron.exe`（246,032,896 B） |

> 这条推翻了旧笔记 §2「npm 直连全断 ⇒ 不得新增任何 npm 依赖」：**npmmirror 现在是通的**，
> 依赖通道恢复；但 **GitHub 仍然全断**，所以"从上游 git 仓库拉 AIRI 源码"这条路依旧不通。

---

## 2. AIRI 可用性（关键阻塞项取证）

### 2.1 本机只有安装版，没有源码 checkout

`F:\AIRI` 根目录实测：

```
airi.exe              235,537,920 B
resources\app.asar  1,367,911,043 B
resources\app.asar.unpacked\  resources\godot-stage\  resources\elevate.exe
LICENSE.electron.txt  LICENSES.chromium.html
```

从 `app.asar` 头（pickle 布局实测：`[0]=4`，`[4]=header 上界长度`，`[12]=header JSON 真实长度`，JSON 起于偏移 16）读出根 `package.json`：

```json
{
  "name": "ai.moeru.airi",
  "version": "0.12.0-beta.5",
  "private": true,
  "main": "out/main/index.js",
  "repository": "https://github.com/moeru-ai/airi",
  "license": "MIT",
  "dependencies": { "@proj-airi/stage-ui": "workspace:^", "@proj-airi/stage-ui-three": "workspace:^",
                   "@proj-airi/ccc": "workspace:^", "@xsai/stream-text": "catalog:", ... }
}
```

**实测结论：**
- 许可证 = **MIT**（`license: "MIT"`，`repository = github.com/moeru-ai/airi`），著作权归 Moeru AI。来源级使用在许可上**没有障碍**，义务是随分发保留 MIT 声明与版权声明。
- 版本 = `0.12.0-beta.5`；但 asar 内**没有任何 git 元数据**（root entries 只有 `node_modules, out, package.json, resources`），
  因此**无法从本机确定对应的上游 commit/tag**。
- 关键依赖全部以 `workspace:^` 声明 —— 即 **AIRI 的核心源码（stage-ui / stage-ui-three / ccc / audio / pipelines-audio / model-driver-lipsync / plugin-sdk-tamagotchi）不在 npm 上发布**。

### 2.2 npm 镜像上能拿到的 @proj-airi / @xsai 包（实测查询结果）

已发布（`registry.npmmirror.com` 可解析）：`@proj-airi/server-sdk@0.12.0-beta.5`、`@proj-airi/server-shared`、
`@proj-airi/server-runtime`、`@proj-airi/ui@0.12.0-beta.5`、`@proj-airi/plugin-protocol`、`@proj-airi/i18n` 系字体包、
`@proj-airi/unplugin-live2d-sdk` 等 24 个；`@xsai/stream-text@0.5.0`、`@xsai/generate-text`、`@xsai/utils-chat`、
`@xsai/shared-chat`、`@xsai-ext/providers@0.5.0`、`unspeech@0.1.16`、`@moeru/eventa@1.0.1`。

**404（未发布）**：`@proj-airi/stage-ui`、`@proj-airi/airi`、`@proj-airi/ccc`、`@proj-airi/audio`、
`@proj-airi/pipelines-audio`、`@proj-airi/model-driver-lipsync`、`@proj-airi/plugin-sdk-tamagotchi`。

### 2.3 判定

> 用户硬规则：「如果 AIRI 源码、许可证或许可范围无法确认，停止实现并给出明确阻塞项；
> 不得继续修改或重打包 F:\AIRI 安装目录。」

- **许可证：已确认（MIT）** ⇒ 不构成阻塞。
- **源码 pin（明确 tag/commit）：无法确认** ⇒ 构成阻塞。
  原因链：GitHub 与全部 GitHub 镜像不可达 → 本机无源码 checkout → asar 内无 git 元数据 →
  `workspace:` 包未发布到 npm → 无法取得「某个确定 commit」的 AIRI 源码树。
- **未违反禁止项**：本轮**没有**修改、重打包、复制 `F:\AIRI`，也没有改动 `repos\Mate-Engine`。

**最小解阻路径（交给用户裁定的唯一一个决定点）**，三选一：

| 选项 | 做法 | 代价 |
|---|---|---|
| **A（推荐，不阻塞）** | 不做 AIRI 源码级集成，改为**能力等价重实现**：用 AIRI 同源、且**已发布在 npm 上的 MIT 依赖**（`@xsai/*`、`unspeech`、`@proj-airi/server-sdk`、`@proj-airi/ui`）自建会话/人设/记忆/TTS/供应商层。AI 后端协议本身就是 OpenAI 兼容，功能可完全覆盖。 | 不是"AIRI 的代码"，是"AIRI 的能力"；不会触碰 `F:\AIRI` |
| **B** | 用户把 AIRI 源码（`moeru-ai/airi` 的 zip 或 `git bundle`）离线放到本机，我按其中 `package.json` 的版本与 lockfile 固定 commit 后做真正的源码级集成 | 需要用户提供离线包；集成工作量大于 A |
| **C** | 用户本机开一个可达 GitHub 的出口（代理/VPN 让 `git ls-remote https://github.com/moeru-ai/airi` 成功），我拉取并固定 commit | 需要用户改网络环境 |

> 在用户裁定前，**阶段 1/3/4/5/6/7 全部可以并行推进**（它们不依赖 AIRI 源码）：
> 单实例单窗口骨架、VRM 舞台、`.anim→VRMA` 动捕管线、MotionDirector、径向轮盘、安全与启动项迁移。
> 阶段 2（AI 会话层）按 **选项 A** 的接口契约先冻结，实现可在裁定后落地。

---

## 3. Mate Engine 侧（角色与动作来源）

| 项 | 实测值 |
|---|---|
| 源码 checkout | `F:\deepseek harness\AI女友\repos\Mate-Engine`（**真 git 仓库**） |
| remote | `https://github.com/shinyflvre/Mate-Engine.git` |
| 本仓 HEAD | `db0cf0f392c5c399758347c91fcbe3dd3c844af6`，信息：`baseline: upstream shinyflvre/Mate-Engine @ 2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4 (Prepare 3.4 Features, 2026-01-20)` |
| 许可证 | `LICENSE.md` = **MateEngine Pro License (v2.1)**，`Copyright © 2025 Johnson Jason` |
| 许可证关键条款 | §1 允许**私下**使用/研究/修改；§2 **Copyleft**：修改、把其源码并入其它项目、或创作衍生作品，必须把完整对应源码**以同一许可证**发布在**公开且非商业**的代码托管平台；§3 **禁止**在任何商业/二进制分发平台（Steam、itch.io、Microsoft Store 等）分发 MateEngine 或其衍生作品；§4 允许制作 mod/扩展并附条件 |
| 动作资产 | `Assets\MATE ENGINE - Animations\` 共 **162 个 `.anim`**（Unity YAML，动捕级，单个 0.9–51 MB）。含 `PET_IDLE\PET_IDLE.anim` … `PET_IDLE_22.anim`、`PET_IDLE\ME_02\PET_IDLE_16..22.anim`、`PET_MISC\PET_DRAGGING.anim`、`PET_POSE\PET_POSE_1..4.anim`、`PET_LOCOMOTION\*`、`PET_SITTING\ME_02\*`、`PET_SLEEPING\*` 等 |
| 角色 VRM | `Assets\MATE ENGINE - Avatar\DLCs\Lazuli_VRM.vrm` = **60,609,288 B**（另 `aldina.vrm` 12,843,164 B；`Assets\MATE ENGINE - Avatar\Zome.vrm` 27,407,996 B） |
| DLC 目录内许可文件 | **0 个**（对 `MATE ENGINE - Avatar` 递归匹配 `licen|readme|credit|term` 命中 0） |
| 官方安装目录 | `E:\EdGe下载\Public.Release.X3.3.0-HOTFIX-1`（逐字节不许变，本轮未触碰） |

### 3.1 许可合规判定（必须写进分发纪律）

1. **动作资产（`.anim`）与 DLC VRM 都是上游美术/动捕资产，不得打进未经许可的分发包**。
   本项目按用户硬规则执行：**分发物只放"路径引用 + 缺失告警位"**，转换产物只落本地工作区。
2. **Copyleft 传染风险**：MateEngine Pro License v2.1 §2 的措辞包含"把其源码并入另一个项目"。
   本项目**不复制 MateEngine 的 C# 源码**，只读取其**美术/动作资产**并做格式转换，且不公开分发——
   §1「private use, study, modify」覆盖本用途。**但若将来公开发布本软件，必须先做一次许可证评审**；
   这条在 PRD 里登记为 `LICENSE-RISK-1`，不是本轮阻塞。
3. **不得修改** `repos\Mate-Engine`（本轮只读）。

---

## 4. 旧工程现状（只作原型/资产来源/取证资料）

| 项 | 实测值 |
|---|---|
| 旧桌宠（**禁止再启动**） | `F:\deepseek harness\AI女友\build\pet\app`，`package.json.name = airi-mate-pet`，`main = main.mjs`；含 `js\{boot,chat,gateway,icons,pose,settings,vrm,wheel}.mjs` + `main.mjs`(33 KB) + `pet.css`(11.4 KB) |
| 旧内核工作副本 | `build\workcopy-airi\MateEngineX.exe`（667,648 B）+ `UnityPlayer.dll`(34 MB) + `MateEngineX_Data\` |
| 旧启动脚本 | 根目录 `start-airi-brain.ps1`(24 KB)、`autostart-airi-brain.ps1`、`install-shortcuts.ps1`、`airi-brain.mjs`、`mate-engine-airi-bridge.mjs`、`llm-capture-proxy.mjs` |
| 旧宿主/桥代码 | `src\host\*`（含 `supervisor.mjs` 86 KB、`airi-gateway-bind.mjs` 68 KB、`window-geometry.mjs` 58 KB、`cli.mjs` 60 KB）、`src\gateway\*`、`src\link\*` —— **这些就是"双窗口对齐"路线的实现，全部作废** |
| 旧笔记里的三条实机基线 | AIRI 主窗 `(1114,547) 320×480`、Mate 内核窗 `(1114,707) 320×320`（**独立可见窗口 = 必须消失的那个**）；`settings.stageModelRenderer="live2d"`（**必须归零的那个**） |
| 已恢复的 AIRI 渲染源码片段（旧取证产物） | `build\recon-invert\airi-renderer-src\@proj-airi\`、`airi-src\@proj-airi\`、以及 `out-provider-store.ts`(38 KB)、`out-types.ts`、`out-deepseek.ts`、`out-oai-compat.ts`、`region-services_airi_gateway*` 等 —— **许可为 MIT，可作参考实现（reference），不作运行时依赖** |
| 旧 workcopy 备份 | `build\workcopy-airi\_baseline_backup\` |

### 4.1 明文密钥（安全发现，必须处理）

`.airi-upstream.env`（仓库根，未被 `.gitignore`？实际 `.gitignore` 第 1 行 **确实** 含 `.airi-upstream.env`）：

```
AIRI_UPSTREAM_URL=https://api.deepseek.com/v1/chat/completions
AIRI_UPSTREAM_KEY=sk-<已实测存在，本文件不复写明文>
AIRI_UPSTREAM_MODEL=deepseek-flash
```

- 结论：**旧工程存在明文云密钥落盘**。新软件的密钥一律走 `safeStorage` / Windows Credential Manager，
  且分发前扫描必须让密钥命中数 = 0。新工程**不读取**该文件；迁移时提示用户吊销并重新录入。
- 证据：`Get-Content .airi-upstream.env` 原始输出（队长亲测），另有快照副本 `.airi-upstream.env.acl-SNAPSHOT-2026-09-22.txt`。

---

## 5. npm 依赖可用性实测（用于新工程选型）

对 `registry.npmmirror.com` 逐一查询，以下**全部可解析**：

```
@xsai/stream-text@0.5.0        @xsai/generate-text@0.5.0    @xsai/utils-chat@0.5.0
@xsai/shared-chat@0.5.0        @xsai-ext/providers@0.5.0    unspeech@0.1.16
@proj-airi/ui@0.12.0-beta.5    @proj-airi/server-sdk@0.12.0-beta.5
@moeru/eventa@1.0.1            three@0.186.1
@pixiv/three-vrm@3.5.5         @pixiv/three-vrm-animation@3.5.5
vue@3.5.43                     pinia@4.0.3                  vue-i18n@11.4.12
vite@8.3.1                     @vitejs/plugin-vue@6.0.9     typescript@7.0.2
electron@44.4.5                electron-builder@26.15.3     better-sqlite3@13.0.3
zod@4.6.5                      valibot@1.5.0                @vueuse/core@15.0.0
reka-ui@2.10.5                 splitpanes@4.1.2             dompurify@3.4.16
marked@18.0.14
```

⇒ 新工程的依赖选型**不受网络限制**（只要走 npmmirror）。

---

## 6. 本轮取证未触碰清单（合规声明）

- 未修改 `F:\AIRI` 任何字节（只做只读 asar 头解析）。
- 未修改 `E:\EdGe下载\Public.Release.X3.3.0-HOTFIX-1` 任何字节。
- 未修改 `F:\deepseek harness\AI女友\repos\Mate-Engine` 任何字节。
- 未启动、未杀死任何旧进程（本子代理的进程/窗口清点由 `E0-legacy-window-chain.json` 记录）。
- 未改动任何注册表项与计划任务（盘点结果见 `E0-autostart-inventory.json`）。
