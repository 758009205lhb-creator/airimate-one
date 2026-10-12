# 阶段 2-C · 聊天主链打通（通过）

| 字段 | 值 |
|---|---|
| 覆盖的硬目标 | PRD §6「唯一数据流」全链；FR-4.1–FR-4.3（供应商/流式/人设） |
| 命令 | `electron apps/desktop --dev --probe chat --probe-out docs/evidence/phase2/A22-chat-chain.json --probe-exit` |
| 结果 | **PASS** |

## 原始输出

```json
{
  "sendResult": { "ok": true, "requestId": "req_muiqq181_1" },
  "sendAccepted": true,
  "notImplemented": false,
  "events": [
    { "kind": "error",
      "e": { "requestId": "req_muiqq181_1", "code": "auth",
             "message": "鉴权失败（HTTP 401）", "retryable": false } }
  ],
  "errorCode": "auth",
  "passChainWired": true,
  "passReachedServer": true,
  "cleanedUp": true
}
```

| 检查 | 期望 | 实测 | 结论 |
|---|---|---|---|
| `chat:send` 被接受 | `ok=true` 且返回 `requestId` | `req_muiqq181_1` | ✅ |
| **不再是 NOT_IMPLEMENTED** | `notImplemented=false` | `false` | ✅ |
| 链路真的发到了服务端 | 无效密钥 ⇒ `code=auth` | **`auth`（HTTP 401）** | ✅ |
| 错误经 `evt:chat-error` 回到 renderer | 事件被页面内监听捕获 | 捕获到 `{kind:'error', code:'auth'}` | ✅ |
| 测试残留清理 | 供应商与密钥删除 | `cleanedUp=true` | ✅ |

> 与之前那轮"密钥隔离"探针同一设计思路：**用无效密钥打通链路**，
> 期望"鉴权失败"而不是"成功"——既证明 DNS/TLS/路径/Bearer/SSE 全链正确，
> 又不消耗配额、不把有效密钥写进任何证据文件。

## 本轮实现的完整链路

```
renderer: window.airimate.sendChat(text, clientId)
   │  IPC chat:send（schema 校验）
   ▼
main:  appendMessage(user) ─► buildPrompt(人设 + 最近 20 轮历史 + 本轮)
   │                              ▲ getPersona()（DEFAULT_PERSONA 内置默认人设）
   ▼
     startChat()（主进程出网，OpenAI 兼容 SSE 流）
   │  ├─ onDelta ─► evt:chat-delta（增量显示）
   │  └─ onDone  ─► parseReply()  ← ★ **唯一解析点**
   │                   └─ StageCommand[] 经 parseStageCommand() 运行时校验
   │                        └─ evt:chat-done { text(已剥离标记), commands, usage }
   ▼
renderer: 只显示 displayText；commands 交给 MotionDirector（不二次解析）
```

## 新增模块

| 文件 | 职责 |
|---|---|
| `session-store.ts` | 会话历史 + 人设（原子写 + schema 校验 + **400 条上限**）；`DEFAULT_PERSONA` 内置默认人设，并在系统提示里**声明可用动作词表**（词表取自 `MotionSemantic`/`EmotionName`，不引入第二套词汇） |
| `chat-client.ts` | OpenAI 兼容流式客户端（上一轮） |
| `act-parser.ts` | 唯一解析点（上一轮，11/11 单测） |
| `ipc.ts` | `chat:send/abort/clear/history` + `persona:get/set` 全部落地 |

**隐私纪律**：对话正文只落本地 `session.json`；日志只记 `{ role, chars, commands }`，**不记正文**。

## 仍未做（阶段 2 剩余）

- **TTS**（`tts:speak` 仍是 NOT_IMPLEMENTED）—— 需要本地/云端语音合成与音频回传通道
- **记忆层**：`memory:*` 仍是空实现；`buildPrompt` 已预留 `extraSystem` 注入位
- **智能体工具调用框架**：未开始
- 上述三项都可基于已发布的 MIT 依赖实现（`unspeech` 等），**不受 BLOCKER-1 阻塞**；
  但若要"源码级集成 AIRI"，仍需你对 BLOCKER-1 的裁定。
