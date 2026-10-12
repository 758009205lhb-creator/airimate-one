# 阶段 2-B · 动效标记解析器 + 流式聊天客户端（11/11 单测通过）

| 字段 | 值 |
|---|---|
| 覆盖的硬目标 | PRD §6「唯一数据流」的**单一解析点**；FR-4.2 流式回复（客户端侧） |
| 命令 | `node --test apps/desktop/test/act-parser.test.cjs` |
| 结果 | **11 / 11 PASS，0 FAIL** |

## 单测输出

```
ℹ tests 11    ℹ pass 11    ℹ fail 0
```

覆盖：主标记解析、`once` 后缀、表情强度、默认强度、强度夹取、两种简写、
未知标记丢弃并报告、多标记顺序、纯文本不被改动、大小写不敏感、正则状态不跨调用泄漏。

## 单测抓出的两个**真实缺陷**（这正是写单测的价值）

| # | 缺陷 | 症状 | 修法 |
|---|---|---|---|
| ① | **正则少了 `i` 标志** | `[MOTION:Wave]`、`[EMOTION:HAPPY]` **完全不被识别**，用户会直接看到 `[MOTION:Wave]` 这种脏文本 | 显式加 `i` |
| ② | **正则放在模块级常量里共享 `g` 状态** | `lastIndex` 跨调用残留 ⇒ "连续两次解析结果不一致"（间歇性丢标记，最难查的一类 bug） | 改为**每次调用新建** `new RegExp(..., 'gi')` |

另修一处：强度参数不支持负号 ⇒ `[emotion:angry -3]` 整条标记不匹配（现由 `-?[0-9.]+` 支持，并在代码里夹到 `[0,1]`）。

## 产出的两个模块

| 文件 | 职责 |
|---|---|
| `apps/desktop/src/main/act-parser.ts` | **唯一解析点**：把模型回复里的 `[motion:x]` / `[emotion:x 0.8]` / `[[x]]` / `((x))` 解析成 `StageCommand[]`，并从**展示文本**里彻底剥离标记。未知标记**丢弃并报告**（不猜、不透传） |
| `apps/desktop/src/main/chat-client.ts` | OpenAI 兼容的**流式**聊天客户端（SSE 逐块解析、首字节 30s 超时、可中断、`redirect:'error'` 防密钥重定向外泄、失败只记 code 与主机名） |

## 为什么是"OpenAI 兼容"而不是绑定某家

DeepSeek / OpenAI / Ollama / 自建端点都提供 `/chat/completions` 的 SSE 流，
同一份实现覆盖全部——这与 AIRI 侧 `@xsai` 系列的抽象一致，
也是**不依赖 AIRI 源码**就能实现的能力等价路径。

## 仍未接线（下一步）

`chat:send` 通道目前仍是显式 `NOT_IMPLEMENTED`。要接线还差三件（都不受 BLOCKER-1 阻塞）：

1. **会话循环**：把 `chat-client` 的 `onDelta/onDone` 接到 `chat:send` 的 IPC 广播，
   并对 `onDone` 的完整文本跑 `parseReply()` ⇒ 产出 `StageCommand[]` 经**运行时校验**后推给 renderer；
2. **人设注入**：`Persona` 的 `systemPrompt/personality/speakingStyle/performance` 拼成系统消息
   （并在系统消息里告诉模型可用的动作标记词表，词表直接取自 `MotionSemantic`/`EmotionName`，不引入第二套词汇）；
3. **历史持久化**：`ChatMessage[]` 落盘 + 注入上下文（记忆层的雏形）。
