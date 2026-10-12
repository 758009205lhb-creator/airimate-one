/**
 * @airimate/security/redact —— 日志/诊断包/分发物的统一脱敏
 *
 * 硬要求（PRD FR-8 / Tech-Spec §7.4）：
 *   - 任何 token 只保留**长度 + 哈希前缀**；
 *   - 日志不得包含对话正文；
 *   - 分发前扫描：云密钥 / Bearer / JWT / 长十六进制凭据 / 对话正文，命中数必须为 0。
 */

/** 命中即脱敏的敏感模式（顺序敏感：先长后短，避免局部替换） */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string, re: RegExp }> = [
  // 云供应商密钥前缀
  { name: 'openai-style', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'google-ai', re: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { name: 'huggingface', re: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { name: 'aws-akid', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  // 授权头与 JWT
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // 长十六进制 / 长 base64 凭据（≥32 hex / ≥40 base64）
  { name: 'hex32', re: /\b[0-9a-fA-F]{32,}\b/g },
  { name: 'base64-40', re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g },
  // 形如 KEY=... 的赋值（含 .env 正文）
  { name: 'env-assign', re: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*[^\s"'`]{6,}/gi },
]

export interface RedactionHit {
  pattern: string
  length: number
  sha8: string
}

export interface RedactResult {
  text: string
  hits: RedactionHit[]
}

/** 简易稳定哈希（FNV-1a 64bit，用十六进制输出前 8 位）——不引入 crypto 依赖，避免在 renderer 侧不可用 */
function fnv1a64Hex(input: string): string {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i))
    h = (h * prime) & mask
  }
  return h.toString(16).padStart(16, '0')
}

export function fingerprint(value: string): { length: number, sha8: string } {
  return { length: value.length, sha8: fnv1a64Hex(value).slice(0, 8) }
}

/**
 * 文本脱敏。命中项替换为 `«redacted:<pattern>:len=<n>,h=<sha8>»`。
 */
export function redactText(input: string): RedactResult {
  let text = input
  const hits: RedactionHit[] = []
  for (const { name, re } of SECRET_PATTERNS) {
    text = text.replace(re, (m) => {
      // env-assign 的捕获组 1 是变量名，替换时保留变量名
      const value = name === 'env-assign' ? (m.split('=').slice(1).join('=')) : m
      const fp = fingerprint(value)
      hits.push({ pattern: name, length: fp.length, sha8: fp.sha8 })
      return name === 'env-assign'
        ? `${m.split('=')[0]}=«redacted:env-assign:len=${fp.length},h=${fp.sha8}»`
        : `«redacted:${name}:len=${fp.length},h=${fp.sha8}»`
    })
  }
  return { text, hits }
}

/**
 * 结构化字段脱敏：只保留**键名**与值的指纹，值的原文不落盘。
 * 用于对话正文、记忆正文、密钥等。
 */
export function redactValue(label: string, value: string): string {
  const fp = fingerprint(value)
  return `«${label}:len=${fp.length},h=${fp.sha8}»`
}

/**
 * 诊断包 / 分发物扫描。返回命中清单（不含原文），命中数 > 0 即**阻断导出**。
 */
export function scanForSecrets(files: ReadonlyArray<{ path: string, content: string }>): Array<{ path: string, pattern: string, length: number, sha8: string }> {
  const out: Array<{ path: string, pattern: string, length: number, sha8: string }> = []
  for (const f of files) {
    for (const { name, re } of SECRET_PATTERNS) {
      // 每次都重置 lastIndex（带 g 的正则是有状态的）
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(f.content)) !== null) {
        const raw = name === 'env-assign' ? m[0].split('=').slice(1).join('=') : m[0]
        const fp = fingerprint(raw)
        out.push({ path: f.path, pattern: name, length: fp.length, sha8: fp.sha8 })
        if (out.length > 500) return out    // 防御性上限
      }
    }
  }
  return out
}

/** 进程命令行脱敏（用于诊断导出） */
export function redactCommandLine(cmd: string): string {
  return redactText(cmd).text
}
