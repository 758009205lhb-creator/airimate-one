# 一键启动 / 安装（桌面图标）

本目录是 **AiriMate One 的落地入口**：装一次、桌面出现图标、以后点图标就能打开。

```
tools/runtime/
  install-airimate.ps1   安装器（复制程序 + 补资产 + **自动创建桌面图标** + 自检）
  launch-airimate.ps1    启动器（图标/快捷方式出问题时的可重放入口，带诊断读数）
  launch.log             每次启动的一行留痕（pid / 锁 / 窗口 / profile / 角色 / 动作数）
  install-evidence.json  最近一次安装的完整证据（pass / failures / 各步读数）
```

---

## 一、日常使用：点桌面图标

桌面上有一个 **`AiriMate One`** 图标，**双击即打开**。它指向：

```
目标  : %LOCALAPPDATA%\Programs\AiriMateOne\AiriMateOne.exe
参数  : "<安装目录>\app" --workspace "<安装目录>\workspace"
工作目录: <安装目录>
```

> ★ **参数为什么会是两段**（这不是冗余，缺一段图标就废了）
>
> `AiriMateOne.exe` 只是被改名的 `electron.exe`，它按 Electron 的规矩把
> **第一个非开关参数**当"应用目录"。少了那一段，Electron 会把 `--workspace`
> 的**值**当应用去加载，双击后弹一个标题为 `[Error]` 的对话框：
>
> ```
> Error launching app
> Unable to find Electron app at <workspace>
> Cannot find module '<workspace>'
> ```
>
> 而 `--workspace` 这一段同样不能少：少了它，`resolveRuntimeProfile()` 会落到
> `packaged` 分支，**私有 VRM 会被许可闸门机械拒绝** ⇒ 能打开但**没有角色**。
> 安装器与启动器现在写的是**同一套**参数，并且安装后会**读回 .lnk 逐项核对**。

装好之后的行为（由应用设置决定，不是写死的）：

| 设置 | 启动后看到 |
|---|---|
| `petResident=true` + `startupOpenChat=true`（当前） | 桌宠 + 独立对话窗口 |
| `petResident=false` + `startupOpenChat=true` | 只有对话窗口 |
| 两个都 false | 什么都不显示，**只留托盘图标**（合法状态，不是故障） |

托盘菜单随时可以「显示桌宠 / 收回桌宠 / 开始对话」；全局快捷键 `Ctrl+Alt+Space` 开对话。

---

## 二、重装 / 换位置 / 换工作区

```powershell
cd "F:\deepseek harness\AI女友\新工程"

# 干跑：只报告计划，不落盘
powershell -NoProfile -ExecutionPolicy Bypass -File tools\runtime\install-airimate.ps1 -DryRun

# 正常安装（桌面图标 + 安装后自动启动验证）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\runtime\install-airimate.ps1

# 装到别处（演练）
powershell ... -File tools\runtime\install-airimate.ps1 -InstallDir D:\AiriMateOne

# 快捷方式放开始菜单，或两处都放，或都不放
powershell ... -File tools\runtime\install-airimate.ps1 -ShortcutTarget both
powershell ... -File tools\runtime\install-airimate.ps1 -ShortcutTarget none

# 工作区指向工程根（改完代码重新构建即可生效，不必重装）
powershell ... -File tools\runtime\install-airimate.ps1 -WorkspaceMode project

# 装完不启动验证（例如你正忙着用电脑）
powershell ... -File tools\runtime\install-airimate.ps1 -NoVerify
```

安装器的 7 步：**复制程序 → 补 workspace 包清单 → 复制动作资产 → 复制 renderer →
建快捷方式（并读回核对）→ 写 LAUNCH.cmd → 写安装清单**，最后启动一次读回适配层读数。

### 卸载

用项目已有的卸载器（本安装的清单与它同 schema，可安全逆操作）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\uninstall.ps1
```

用户数据（`%APPDATA%\AiriMateOne`：设置/记忆/密钥）**默认保留**。

---

## 三、出问题时怎么查

### 1. 先跑启动器，它会把读数摆出来

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\runtime\launch-airimate.ps1
```

读数的含义（`launch.log` 里也有一行）：

| 读数 | 正常值 | 说明 |
|---|---|---|
| `profile` | `development` | 是 `packaged` ⇒ `--workspace` 没传对，角色会被拒 |
| `角色` | `lazuli` | 空 ⇒ 模型路径引用读不到（看 `assets\models\catalog.json`） |
| `动作` | `16` | `0` ⇒ 工作区 `assets\motion` 里没有 `.vrma`（角色会静止） |
| `可见窗口` | 1～2 个 | `无` 且上面三项正常 ⇒ 两个显示开关都关了（合法） |
| 渲染进程退出 | 不出现 | 一旦出现即判**失败**：界面会一闪就没 |

### 2. 日志

```
%APPDATA%\AiriMateOne\logs\airimate-<日期>.jsonl    应用结构化日志
tools\runtime\launch.log                            每次启动一行的留痕
%LOCALAPPDATA%\Programs\AiriMateOne\LAUNCH-诊断.cmd  带控制台输出的启动（排障用）
```

### 3. 这次落地时踩到的坑（都已修，记在这里省下第二次）

- **`[Error] Unable to find Electron app`**：快捷方式/`LAUNCH.cmd` 漏了 `app` 目录那一段参数。
  ⇒ 安装器现在会**读回 .lnk** 核对"目标 + app 目录 + `--workspace`"三段齐全。
- **`Cannot find module '@airimate/shared'`（装了就跑不起来）**：
  `tools/qa/stage-dist.mjs` 只把 `packages/*/dist` 打进 `app\node_modules\@airimate\<pkg>\dist`，
  **没打 `package.json`** ⇒ 载荷一离开开发树（workspace 软链不再兜底）就解析不到包。
  ⇒ 安装器第 2 步补这三个清单，并用 `require.resolve` **实测**能否解析。
  顺带说明：`dist-package\` **原地**跑是发现不了这个缺口的（软链会兜住）。
- **白屏**：安装形态的工作区里没有 `apps\renderer\dist`。
  ⇒ 安装器第 4 步把 renderer 产物复制进安装工作区。
- **窗口判据假阴性**：用 `MainWindowHandle` 判"有没有窗口"会误报 ——
  Electron 是多进程的，可见窗口常挂在**非主进程**上；而按"只认顶层根窗口"过滤
  又会把**带 owner 的 pet 窗口**（Electron 就是这么建的）全部排除。
  ⇒ 判据改为"属于本安装的进程 + `IsWindowVisible` + 标题非空"。
- **崩溃被读成成功**：渲染进程崩溃后主进程仍在、实例锁仍在，
  只看"进程活/锁在"会报成功，而用户看到的是"一闪就没"。
  ⇒ 判据里 `renderer.gone` 一票否决。

---

## 四、发布侧注意（改载荷时看）

- **载荷内容真源是 `tools/qa/stage-dist.mjs`**，不是本目录的安装器。
  本安装器只做"把载荷落到本机 + 补齐许可不允许进载荷的私有资产"。
- **动作资产（`.vrma`）与角色（`.vrm`）不进载荷**：Mate Engine DLC 无独立许可。
  安装器第 3 步是从**本机工程**复制到安装工作区 —— 只在本机复制，不对外分发。
- 改了代码之后要重新组装载荷，图标才会用上新版本：

  ```powershell
  npm run build:dist          # 构建 + 组装 + 扫描 + 完整性校验
  powershell ... -File tools\runtime\install-airimate.ps1
  ```

  ⚠ **只跑 `npm run build` 不会更新 `dist-package\`**。本次落地就遇到过：
  `dist-package\` 停在 10-06 的构建，而源码是 10-09 的 ⇒
  装出来的应用**缺少后续功能**（例如"启动即打开对话窗口"），
  表现为"装好了但打开什么都没发生"。
