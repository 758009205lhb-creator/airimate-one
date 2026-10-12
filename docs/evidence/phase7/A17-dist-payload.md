# A17 第 5 面 —— 分发包载荷扫描 + 第三方许可清单

**结论：分发载荷扫描 PASS；第三方许可清单已生成（111 个包，0 个未声明许可）。**
证据：`docs/evidence/phase7/A17-dist-payload.json`、`A17-third-party-licenses.json`、
`THIRD-PARTY-NOTICES.md`（仓库根，308 KB）

---

## 1. 为什么必须单做"分发面"扫描

此前的密钥扫描（`secret-audit.mjs`）扫的是**工作区**。但"工作区干净"**不等于**"分发包干净"：

| 差异 | 说明 |
|---|---|
| 收录范围不同 | 工作区里被开发用的东西（证据截图、日志、QA 工具）**不会**进分发 |
| **形态不同** | 分发里是**打包产物**（minify 后的 bundle、sourcemap 里的原始源码）。源码扫描看不到"打包后是否把某段密钥带进去了" |
| 额外要求 | 分发还有合规要求：许可声明必须在、不得含构建机绝对路径、不得含开发开关 |

所以这一面**只扫将要发布的那批文件**。

## 2. 载荷定义只有一处（这是刻意的）

`tools/qa/stage-dist.mjs` 用一份**显式清单**组装 `dist-package/`，每条都写清"为什么加"；
`tools/qa/scan-dist-payload.mjs` 只扫它的输出。

> 为什么不各自维护一份 glob 列表：**"扫描范围"与"发布范围"一旦各自漂移，
> 扫描就失去意义** —— 你会得到一个"扫了但扫的不是要发的东西"的绿灯。

组装结果：

```
[stage] 载荷目录：dist-package  文件 65 个，1.82 MB
  apps/desktop/dist/main                ->  app/main                                 — 主进程编译产物（入口）
  apps/desktop/dist/preload             ->  app/preload                              — preload（IPC 白名单唯一出口）
  apps/renderer/dist                    ->  app/renderer                             — renderer 打包产物
  packages/shared/dist                  ->  app/node_modules/@airimate/shared/dist   — 共享契约（主进程 require）
  packages/security/dist                ->  app/node_modules/@airimate/security/dist — 安全工具（主进程 require）
  package.json                          ->  app/package.json                         — 包元数据
  THIRD-PARTY-NOTICES.md                ->  THIRD-PARTY-NOTICES.md                   — 第三方许可声明（合规必需）
  README.md                             ->  README.md                                — 使用说明
```

扫描结果：

```
载荷清单：65 个文件，1.82 MB；其中文本 65 个已扫描
✓ 明文密钥：0 命中
✓ 禁用清单：0 命中（VRM/VRMA/.anim/证据/工具/sourcemap 均不在载荷内）
✓ 开发开关：0 命中
许可证声明在载荷内：是

[dist-scan] PASS
```

**机械拦截的禁用项**（每条对应一次真实风险，且在组装阶段就会让构建失败）：

| 禁用 | 为什么 |
|---|---|
| `*.vrm` / `*.vrma` / `*.anim` | Mate Engine 是 *MateEngine Pro License v2.1*，DLC 资产**无独立许可** ⇒ 不得再分发 |
| `*.map` | sourcemap 含**未压缩原始源码**（连注释一起） |
| `docs/` / `tools/` | 证据含机器信息与截图；QA 工具会暴露调试入口 |
| `node_modules/`（整棵） | 手写依赖树既臃肿又无法审计（`app/node_modules/@airimate/*` 是**刻意**的例外） |
| `.env*` / `*.log` / `*.jsonl` / `secrets/` / `*.pdb` | 密钥、日志、采样数据、调试符号 |

---

## 3. 这一面抓出的**两个真实问题**

### 问题 1 —— 默认构建会把 **58 个 sourcemap** 打进载荷

`tsconfig.base.json` 里 `sourceMap: true`，`vite.config.ts` 里 `sourcemap: true` ——
对开发是对的（栈回溯可读），但**分发产物绝不能带 `.map`**：它内含未压缩的原始源码，
等于把实现细节与注释一并发布。

**修法**：生产构建**默认关闭** sourcemap，需要时显式开：

| 构建 | 命令 | sourcemap |
|---|---|---|
| 开发（默认） | `npm run build` | 开（调试需要） |
| 生产主进程 / preload | `npm run build:prod -w @airimate/desktop` | **关** |
| 生产各内部包 | `npm run build:prod -w @airimate/<pkg>` | **关** |
| 生产 renderer | `AIRIMATE_SOURCEMAP=1 npm run build -w @airimate/renderer` 才开 | **默认关** |

修后实测：`apps/desktop/dist`、`apps/renderer/dist` 与 5 个内部包的 `.map` 计数**全为 0**，
而 `.d.ts` 保留（类型检查需要）⇒ `npm run typecheck` 仍为 **0 错误**。

> 踩坑记录：我第一版把 `.d.ts` 也一起关了，结果 `typecheck` 冒出 **108 个错误**
> （找不到 `@airimate/shared` 的类型声明）。**关 sourcemap 与关声明文件是两件事** ——
> 前者影响调试，后者影响类型。已改为只关 sourcemap。

### 问题 2 —— 生产 CSP **无条件**放行 `127.0.0.1:*`（真安全问题）

`packages/security/src/csp.ts` 的 `connect-src` 里写死了
`http://127.0.0.1:* ws://127.0.0.1:*`，**生产也生效**。含义是：
renderer 里任何一处注入都能拿它去探/打本机上的其它服务。

而这条放行对生产**毫无用处** —— renderer 的所有出网请求都经主进程发出
（密钥不进 renderer，PRD FR-8），唯一需要直连环回的是**开发期的 Vite dev server**。

**修法**：把两个环回源挪进 `dev` / `devWs`，与 dev server 源**同生共死**：

```ts
const dev   = o.devServerOrigin ? ` ${o.devServerOrigin}` : ''
const devWs = o.devServerOrigin ? ` ws://127.0.0.1:*` : ''
// connect-src 'self' app: blob: data:${dev}${devWs}
```

收紧后实测：应用正常启动、无任何 CSP 拒绝（`--probe a19` 跑通，日志无 CSP 报错），
且生产载荷里不再出现任何 `127.0.0.1:<port>`。

---

## 4. 顺带发现并修掉的配置债

| 位置 | 问题 |
|---|---|
| `vite.config.ts` 的 `resolve.alias` | 有一行 `'@airimate/airi-core'` 指向 `packages/airi-core/src/index.ts`，而该包**根本不存在**。指向不存在路径的别名不会报错，只在真正 import 时以"解析失败"暴露 ⇒ 已删除（根 `package.json` 的 build 脚本里也有同样的悬空引用，早前已修）。 |

---

## 5. 第三方许可清单

`tools/qa/gen-third-party-licenses.mjs` **离线**读取 `node_modules`（本机 GitHub 与 npm 主站
均不可达，故绝不联网），收集每个包的许可类型与包内自带的许可正文，生成
`THIRD-PARTY-NOTICES.md`。

```
共 111 个包；许可类型 7 种
MIT 91 | (private) 8 | ISC 4 | Apache-2.0 3 | BSD-2-Clause 2 | BSD-3-Clause 2 | (MPL-2.0 OR Apache-2.0) 1

⚠ copyleft 类：1 个  → dompurify 3.4.16，许可写作 "(MPL-2.0 OR Apache-2.0)"
ℹ 包内无许可正文：13 个（分发前需从上游补齐）
未声明许可：0 个
依赖集合指纹：a6cb2cb4a85ec861（依赖变化后此值会变，可据此判断清单是否过期）
```

两点说明：
- `dompurify` 是**双许可**（`MPL-2.0 OR Apache-2.0`）⇒ 可选择 **Apache-2.0**，
  从而**不引入 copyleft 义务**。清单里如实标出，便于决策与留痕。
- `(private) 8` 是本仓库自己的 7 个 workspace 包 + 1 个内部包，`private: true`。
- 13 个"包内无许可正文"的包里，多数是平台相关的二进制包（`@esbuild/win32-x64` 等）；
  **对外分发前必须从上游补齐正文**（多数许可要求再分发时附上许可文本）。

---

## 6. NOT VERIFIED

| 项 | 状态 | 说明 |
|---|---|---|
| **真正的对外分发包** | `NOT VERIFIED`（且**当前不允许产出**） | 由于 Mate 的许可约束，本构建只做**私有自用**。本轮验证的是"将要发布的那批文件"这一**载荷定义**与"资产不得进入"这条约束；真正的安装包/分发物**尚未产出**。 |
| Electron 运行时的分发 | `NOT VERIFIED` | 载荷目前**不含** Electron 二进制（367 MB）。真正的分发需要把 `electron.exe` 与运行时一起打包，并附上 Electron 自身的许可（`LICENSE` / `LICENSES.chromium.html`）。**未做**。 |
| `package.json` 的 `main` 指向 | 需注意 | 载荷里 `app/package.json` 的 `main` 仍写 `dist/main/index.js`，而载荷内路径是 `app/main/index.js`。真正打包时需要一个 release 步骤改写它（或用 electron-builder 的 `extraMetadata`）。**未做**。 |
| 安装器 / 卸载器 | `NOT VERIFIED` | 阶段 7 的安装包尚未产出。卸载器实际会调用的 `--restore-legacy` 入口**已实现并实测通过**（见 `A19-rollback.md`）。 |
| 13 个缺许可正文的依赖 | 待补 | 对外分发前需逐一从上游取回许可文本。 |
| 构建机绝对路径 | 本轮扫描 0 命中 | 扫描规则已加，但只覆盖 `Users` / `deepseek` / `Projects` 三类前缀；其它自定义目录名可能漏过。 |
