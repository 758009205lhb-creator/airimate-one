# Phase 7 —— 打包、安装、卸载、回滚

**当前状态：可交付载荷已能组装（含运行时）；安装/卸载脚本已实现；
「安装→卸载→重启」演练待浸泡测试释放实例锁后执行（见 §6）。**

---

## 0. 本阶段修掉的一个**会让安装包根本起不来**的结构问题

源 `package.json` 的 `main` 写的是 `dist/main/index.js`，而载荷内主进程在
`app/main/index.js` —— 照搬会得到一个"装好了但起不来"的包，而且它的报错
（找不到入口）与应用自身的日志**完全无关**，排查时要绕一圈才会想到"是路径没改写"。

同类问题还有一处更隐蔽的：`paths.ts` 判"打包形态"用的是 `app.isPackaged`，
而它的依据是**"可执行文件是否叫 electron"**。安装形态只是把 `electron.exe`
改名成 `AiriMateOne.exe` ⇒ **它不会变成 true** ⇒ `rendererDist` / `motionDir` /
`catalogFile` 全部指错，表现为"装好了但白屏 / 找不到动作"。

现在的处理：
- `stage-dist.mjs` 在**组装阶段**改写 `app/package.json`（`main` → `main/index.js`，
  并去掉 `scripts` / `devDependencies` / `workspaces` —— 载荷里没有构建工具，
  留着 `postinstall` 会让"顺手 npm install"在无网环境下失败）；
- 新增 `--workspace <dir>` CLI 参数，安装器把它写进**自启项的命令行**里
  （而不是靠环境变量：注册表里能直接看到路径，排障时不用猜环境）。
- `stage-dist.mjs` 增加**自洽性检查**：`main` 指向的文件必须存在、可解析，
  preload 与 renderer 产物必须在位 —— 这四条任何一条不满足就直接 FAIL，
  不会交出一个"装了也起不来"的载荷。

---

## 1. 先明确一个**硬边界**：本构建只做私有自用

Mate Engine 采用 *MateEngine Pro License v2.1*：允许私用与修改、含 copyleft 条款、
**禁止商业与二进制再分发**；其 DLC 资产（VRM）**没有独立许可文件**。

⇒ 本项目的分发包**不包含**角色资产。这不是"暂时没做"，而是**当前许可条件下的正确形态**：
安装器只装**程序本体**，角色模型由使用者自行提供，通过
`assets/models/catalog.json` 里的**路径引用**指定（不复制资产）。

这条约束被**机械检查**了两遍：组装阶段（`FORBIDDEN` 规则）与安装阶段
（`install.ps1` 的载荷校验）。实测载荷里 `.vrma` / `.anim` / `.vrm` 计数为 **0**。

> 注意 `assets/` 目录本身是需要的（sidecar 清单 + 模型路径引用），
> 而 `assets/motion/` 下有 **16 个 `.vrma`** —— 所以组装时对 `assets` 逐文件过滤，
> 而不是整目录复制。整目录复制会触发禁用规则，让人误以为"规则太严"。

## 2. 两种载荷形态

| 形态 | 命令 | 文件数 | 体积 | 用途 |
|---|---|---|---|---|
| **程序本体** | `node tools/qa/stage-dist.mjs --clean` | 64 | **1.82 MB** | 日常迭代、载荷安全扫描 |
| **可交付安装包** | `node tools/qa/stage-dist.mjs --clean --with-runtime` | 252 | **372.15 MB** | 真正能独立安装运行的形态 |

运行时形态的布局**与安装后的结构完全一致**：

```
AiriMateOne.exe                  ← electron.exe 改名（安装器不再需要从开发树复制）
LICENSE                          ← Electron 自身许可（MIT）—— 分发必需
LICENSES.chromium.html           ← Chromium 及组件许可汇编（19.5 MB）—— 分发必需
icudtl.dat / resources.pak / *.pak / *.dll / *.bin / locales/ / version
app/package.json                 ← main 已改写为 main/index.js
app/main/  app/preload/  app/renderer/  app/node_modules/@airimate/{shared,security}/
workspace/assets/                ← 动作清单 + 模型路径引用（**不含** .vrma/.vrm）
THIRD-PARTY-NOTICES.md           ← 111 个第三方依赖的许可声明
README.md
```

两种形态的分发载荷扫描都是 **PASS**：

```
程序本体：65 文件 / 1.82 MB   —— 0 密钥 / 0 禁用项 / 0 开发开关 / 许可证在包内
含运行时：253 文件 / 372.18 MB —— 0 密钥 / 0 禁用项 / 0 开发开关 / 许可证在包内
```

## 3. 安装形态：按用户、无需管理员

选择"按用户安装"而不是"机器级安装"，理由不是省事：

| | 按用户（本实现） | 机器级 |
|---|---|---|
| 写注册表位置 | `HKCU\...\Run` | `HKLM\...\Run` |
| 是否需要 UAC | **不需要** | 需要 |
| 影响范围 | 当前用户 | 所有用户 |
| 能否在自动化里可靠演练 | **能** | 不能（UAC 交互式提权） |

**"没演练过的提权路径不该交付"** —— 本机环境的 UAC 交互式提权无法在自动化里走通，
所以机器级安装不是"以后再说"，而是**明确不做**。

```
%LOCALAPPDATA%\Programs\AiriMateOne\     程序本体（含运行时）
%APPDATA%\AiriMateOne\                   用户数据（设置/记忆/密钥）——**卸载默认保留**
HKCU\...\Run\AiriOne                     自启项（`--autostart --workspace "<安装目录>"`）
%APPDATA%\Microsoft\Windows\Start Menu\Programs\AiriMate One.lnk
<桌面>\AiriMate One.lnk
```

**自启项值名为什么必须是 `AiriOne`**：E0 取证实测旧工程卸载器会删除
`HKCU\...\Run` 下所有匹配 `^(AI女友|AiriMate|airi-brain)` 的值（PowerShell 的
`-match` **大小写不敏感**）。任何以 `AiriMate` 开头的名字（含 `AiriMateOne`）
都会被旧卸载器**静默删除**。代码用 `AiriOne`，并固化为机械校验
`assertNameSafeFromLegacyUninstaller()`（有单测覆盖）。

## 4. 回滚入口原本是**不可达**的（已修）

`autostart.ts` 的文件头注释早就写着"卸载时恢复（`--restore-legacy`）"，
但 **CLI 里根本没有实现这个开关** —— 回滚能力在交付形态上不可达。

现已接成真实入口（**不建窗口、不建托盘、在单实例锁之前**），并约定结果文件：

```
--restore-legacy <备份目录> --restore-legacy-out <json>
```

> **为什么必须落文件而不是读控制台**：实测这条路径下 Electron 会把 stdio 从父 shell
> 摘掉 —— 重定向文件 0 字节、`$LASTEXITCODE` 为空（而回滚其实成功了）。
> 卸载器若依赖"读控制台输出"会拿到一片空白。

## 5. 本阶段新增的脚本

| 脚本 | 作用 |
|---|---|
| `tools/qa/stage-dist.mjs` | 按**显式清单**组装载荷（含改写 `package.json`、自洽性检查、逐文件过滤） |
| `tools/qa/scan-dist-payload.mjs` | 只扫组装产物（扫描范围与发布范围不各自漂移） |
| `tools/qa/gen-third-party-licenses.mjs` | 离线生成 `THIRD-PARTY-NOTICES.md`（111 个包） |
| `tools/qa/shortcut.ps1` | 创建/删除 `.lnk`（安装器与卸载器**共用**，保证两边路径规则互逆） |
| `tools/qa/install.ps1` | 按用户安装：预检 → 载荷校验 → 复制 → 自启项 → 快捷方式 → 安装清单 |
| `tools/qa/uninstall.ps1` | 按用户卸载：**先关自启** → 删快捷方式 → 旧自启回滚 → 删目录 → 用户数据默认保留 |
| `tools/qa/check-install-cycle.ps1` | 「安装 → 卸载 → 重启（等价）」三时点演练 |

**三个顺序/边界决定**（每条都有理由）：
① 卸载时**先关自启、再删程序** —— 反过来会留下指向不存在文件的启动项，
用户下次开机看到报错弹窗而程序已"卸载"；
② **用户数据默认保留**（设置/记忆/密钥是用户资产，"卸载程序"不等于"抹掉我记住的事"）；
③ **没有 `install-manifest.json` 就拒绝卸载** —— 照着猜测删文件是卸载器最常见的事故来源。

**重启为什么不用真重启**：重启对启动项的作用可以**等价**检验 ——
① Run 键里是否还有我们的项（有 ⇒ 会被执行）；② 若仍有，其目标文件是否存在
（不存在 ⇒ 必然报错）。两条合起来足以判定"卸载后是否会出现开机报错弹窗"。

**演练过程中修掉自己脚本里的 3 个缺陷**：

| 缺陷 | 现象 | 根因 |
|---|---|---|
| 载荷资产检查把**全部 65 个文件**判成角色资产 | 安装被拒：`x 载荷里出现了角色资产（65 个）` | `Get-ChildItem -Include *.vrm,...` 只在**路径以通配符结尾**时才按预期工作，否则匹配全部 |
| `shortcut.ps1` **整个脚本解析失败** | `The '<' operator is reserved for future use` ×5 | 块注释的结束标记与用法示例里 `-DryRun` 后的文本挨在一起，**注释提前结束** |
| `-DryRun` 下快捷方式被报成"0/2 成功" | 干跑的成功被误判为失败 | `exit` 在 `-File` 脚本里**不保证**把退出码传给调用方 ⇒ 改用 `[Environment]::Exit()` |

安装器还有**预检**：检测到已有 electron 实例就直接报错并给出清理命令
（写自启项需要独占启动应用）—— 把"环境没清干净"与"脚本有缺陷"分开。

## 6. NOT VERIFIED（**必须如实说明**）

| 项 | 状态 | 说明 |
|---|---|---|
| **完整的"安装 → 卸载 → 重启"三时点链路** | **待演练** | 脚本已实现、语法校验通过、`-DryRun` 通过；真实往返需要**独占启动应用**。当前 2 小时浸泡正占用实例，故**尚未执行**；浸泡结束后立即跑 `tools/qa/check-install-cycle.ps1`。 |
| 安装后的应用**能否真的启动并显示角色** | `NOT VERIFIED` | 结构上已自洽（入口存在且可解析、preload/renderer/workspace 在位、`--workspace` 已接入），且实测**已安装形态的入口确实被执行**（日志出现 `singleton.wake`，证明 `main/index.js` 被 Electron 加载并跑到单实例判定）。但"完整起来并渲染出角色"未验证。 |
| 换一台**没有开发树**的机器安装 | `NOT VERIFIED` | 运行时形态已自带 372 MB 运行时，理论上不再依赖开发树；但未在干净机器上验证。 |
| 两次安装（覆盖安装） | `NOT VERIFIED` | `robocopy /MIR` 语义是"目标与源完全一致"，理论上支持覆盖安装，但未演练。 |
| 卸载后用户数据在**重装**后能否正确读取 | `NOT VERIFIED` | 默认保留用户数据，但"保留的数据被新装实例正确读取"未验证。 |
| 13 个依赖缺包内许可正文 | 待补 | 对外分发前需从上游取回许可文本（见 `A17-dist-payload.md`）。 |
| Electron 运行时里的 `resources/default_app.asar` | 已包含、未裁剪 | 它是 Electron 的默认应用占位，不影响本应用（我们的入口在 `app/`），但对外发布前可以裁掉以减小体积。 |
