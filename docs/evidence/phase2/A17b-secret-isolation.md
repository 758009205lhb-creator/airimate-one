# 阶段 2-A · 供应商层与密钥隔离（通过）

| 字段 | 值 |
|---|---|
| 覆盖的硬目标 | PRD FR-4.1/FR-4.2 的**供应商侧**；Tech-Spec §7.3 的**密钥不进 renderer / 不落明文** |
| 命令 | `electron apps/desktop --dev --probe secret --probe-out docs/evidence/phase2/A17b-secret-isolation.json --probe-exit` |
| 结果 | **PASS** |

## 原始输出

```json
{
  "backend": "safeStorage",
  "encryptionAvailable": true,
  "publicMeta": { "hasKey": true, "fingerprint": "9fa4ba7b", "len": 41 },
  "publicMetaHasNoPlaintext": true,
  "rendererSeesNoPlaintext": true,
  "diskHasPlaintext": false,
  "pass": true,
  "connectivity": { "code": "auth", "ok": false, "latencyMs": 185, "message": "鉴权失败（HTTP 401）" },
  "connectivityReachedServer": true,
  "cleanedUp": true
}
```

## 逐条断言（每一条都是硬约束）

| # | 断言 | 实测 | 结论 |
|---|---|---|---|
| ① | 密钥后端可用 | `backend = safeStorage`、`encryptionAvailable = true` | ✅ |
| ② | 保存后只暴露指纹与长度 | `{ hasKey: true, fingerprint: "9fa4ba7b", len: 41 }`，**无明文** | ✅ |
| ③ | **renderer 拿不到明文** | `rendererSeesNoPlaintext = true`（直接调 `window.airimate.listProviders()` 检查） | ✅ |
| ④ | **磁盘密文里没有明文** | `diskHasPlaintext = false`（逐字节搜索 `secrets/` 下所有文件） | ✅ |
| ⑤ | 连通性链路真的到达服务端 | 故意用无效密钥 ⇒ 服务端返回 **HTTP 401**（185ms） | ✅ |
| ⑥ | 清理无残留 | `cleanedUp = true`（测试供应商与密钥都已删除） | ✅ |

> 第 ⑤ 条的设计要点：**用无效密钥测连通性**，期望"鉴权失败"而不是"成功"——
> 这既证明了请求真的到达了服务端（DNS/TLS/路径/Bearer 头都正确），
> 又不消耗真实配额、也不会把有效密钥写进任何证据文件。

## 本轮实现的模块

| 文件 | 职责 |
|---|---|
| `apps/desktop/src/main/provider-store.ts` | **非机密**供应商配置（baseUrl/model/kind/label）+ 原子写 + schema 校验 + **连通性测试**（15s 超时、`redirect:'error'` 防密钥被带到第三方主机、失败只记 code 与主机名） |
| `apps/desktop/src/main/ipc.ts` | `provider:list/upsert/delete/test` 四条通道落地：出参**永不含 apiKey**；`apiKey` 单向传入、加密后立即丢弃明文；后端不可用时**拒绝保存**（绝不降级明文） |

## 安全设计的三个关键点（代码内已注释）

1. **`redirect: 'error'`**：不跟随重定向。否则一个恶意/被劫持的 baseUrl 可以把 `Authorization` 头转发到第三方。
2. **日志只记主机名**：`hostOf(baseUrl)` 而不是完整 URL，避免把查询串里的东西写进日志。
3. **密钥后端不可用即拒绝**：`store.set` 抛错时返回 `SECRET_BACKEND` 错误，**不写明文兜底**。

## 仍未做（阶段 2 的其余部分）

- **聊天流式会话**（`chat:send` 仍是显式 `NOT_IMPLEMENTED`）：需要 LLM 流式客户端 + 动作事件解析
- **人设 / 记忆 / TTS**：接口已冻结（API-Contract §2），实现未开始
- **智能体工具调用框架**：未开始

> 这三块**不依赖 AIRI 源码**（都可基于已发布的 MIT 依赖与 OpenAI 兼容协议实现），
> 但按你的硬规则，我仍把 **BLOCKER-1 的裁定**作为阶段 2 全面展开的前置条件；
> 本轮只推进了 Tech-Spec **已冻结**、且与 AIRI 源码无关的供应商与密钥安全部分。
