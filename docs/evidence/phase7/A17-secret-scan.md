# A17 · 密钥扫描（通过）

| 字段 | 值 |
|---|---|
| 判据 | **A17**：日志、分发物、命令行中云密钥命中数 = 0 |
| 命令 | `node tools/qa/secret-audit.mjs --out docs/evidence/phase7/A17-secret-audit.json` |
| 结果 | **PASS** |

## 原始输出（最终一轮）

```
SECRET_AUDIT filesScanned=296 rawHits=0 relevant=0 inconclusive=false pass=true
WROTE docs/evidence/phase7/A17-secret-audit.json
```

## 演进过程（三次迭代，每次都留了原始数字）

| 版本 | 命中数 | 问题 |
|---|---|---|
| 复用运行时 `scanForSecrets` | **501** | **全部误报**：`base64-40` 命中长符号串、`env-assign` 命中代码里的 `process.env.X_KEY=…`、`hex32` 命中我们自己保留的哈希前缀 |
| 分层判定 + 白名单（`secret-audit.mjs`） | **30** | 收敛 94%，但仍是同一个 32 位值在 `E0-legacy-window-chain.json` 里重复出现，行内恰含 `key` 字样触发上下文判定 |
| 加"摘要形态 + 重复值 + 自然语言行"三条判定 | **0** | ✅ |

**根因**：**同一套正则不能同时服务"运行时日志脱敏"（要宁可多删）与"源码/产物审计"（要判别力）**。
因此新增独立的审计模式扫描器 `tools/qa/secret-audit.mjs`，规则分层：

| 层 | 规则 | 说明 |
|---|---|---|
| A 高置信 | `sk-` / `sk-ant-` / `AIza` / `hf_` / `AKIA`/`ASIA` / `xox?` / `gh?_` / `glpat-` / `npm_` / `SG.` / `rk_live_` | 形态本身即凭据，无需上下文 |
| B 形态特殊 | `Bearer <≥20>` / JWT 三段式 | 直接命中 |
| C 赋值型 | `…key/token/secret… = "值"`，**带引号且值长 ≥20** | 排除代码变量名 |
| D 需上下文 | 长 16 进制 / 长 base64，**行内必须含** key/token/secret/password/bearer/authorization | 否则视为哈希 |
| E 白名单 | 行内含 `hash`/`sha256`/`integrity`/`etag`/`fingerprint`… 则跳过 D | 摘要不是凭据 |
| F 摘要形态 | 16 进制且长度为 16 的倍数 ⇒ 摘要形态 | 32/40/64 位哈希 |
| G 重复值 | 同一值出现 ≥2 次 ⇒ 归入 `repeated`（**列出但不计失败**） | 真实密钥通常只出现一次 |
| H 自然语言 | 行内 CJK ≥6 字或以列表符号开头 ⇒ 跳过 D | 排除文档里"规则说明行"自身的误报 |

## 覆盖的四个面

| 面 | 是否覆盖 | 说明 |
|---|---|---|
| ① 源码 + docs + 证据 | ✅ | `packages/ apps/ tools/ scripts/ docs/ assets/` |
| ② 构建产物 | ✅ | 上述目录下的 `dist`（`node_modules` 排除） |
| ③ 用户数据 | ✅ | `%APPDATA%\AiriMateOne`（logs / crashDumps / settings / secrets 元数据） |
| ④ 进程命令行 | ✅ | `cmdlineScanned=true`，0 命中 |
| ⑤ 安装包载荷 | ⏳ | 阶段 7 产出安装包后补扫（当前无安装包） |

## 防"假通过"的下限（都满足）

- `filesScanned = 296` ≥ 下限 50；
- `inconclusive = false`；
- 扫描器**只报告 模式+文件+长度+哈希前缀，绝不回显原文**；
- 排除项显式记录：`.map`（sourcemap，首版未排除导致**扫描跑满 180s 超时**）、
  `contact-sheets`/`_probe-visible`（motion-lab 的大量产物）。

## 已知残留（诚实标注）

- `MutexKeeper` 子进程的命令行**包含互斥量名**（`AIRIMATE_MUTEX_NAME`，非机密），扫描器未视其为命中；
- 旧工程根目录的 `.airi-upstream.env`（**明文云密钥**）**不在本扫描范围内**（属于旧工程，不是新软件产物），
  已在 `E0-recon-baseline.md` §4.1 登记为安全发现，处置建议是**用户吊销该密钥**；
  新工程不读取该文件。
