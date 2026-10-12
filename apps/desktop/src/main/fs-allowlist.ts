/**
 * apps/desktop/src/main/fs-allowlist.ts —— 文件访问的**唯一判定**（M3 §5）
 *
 * 用户要求（逐条对应）：
 *   · "文件读取只允许用户授权的目录白名单"        → `checkPathAccess()`
 *   · "默认只读"                                  → 默认可读、写入需 confirm（权限层）
 *   · "拒绝 .env、私钥、token、cookies、凭据数据库和系统敏感目录"
 *                                                 → `SENSITIVE_FILE_RULES` / `SENSITIVE_DIR_RULES`
 *
 * 为什么必须在一个地方判：
 *   一旦"哪些文件不能读"分散到各个工具里，就一定会有一个工具忘了判 ——
 *   那一条就是缺口，而且是最难发现的那种（功能看起来完全正常）。
 *   这里把判定收成**纯函数**（输入路径 + 白名单 → 允许/拒绝 + 原因），
 *   于是它可以被穷举单测，也可以被审计复核。
 *
 * ⚠ 判定必须基于**解析后的真实路径**：
 *   `..` 穿越、`~` 展开、大小写差异、以及**符号链接/junction**都能绕过朴素的前缀比较。
 *   这里用 `realpathSync.native()` 归一化后再比较（目标不存在时退化为字符串归一化，
 *   但那种情况下也无法读，所以不构成绕过）。
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, normalize, resolve, sep } from 'node:path'

export type PathAccess = 'allow' | 'deny'

export interface PathVerdict {
  access: PathAccess
  /** 拒绝原因码（稳定字符串，供 UI/日志/探针使用） */
  code:
    | 'ok'
    | 'not-absolute'
    | 'outside-allowlist'
    | 'empty-allowlist'
    | 'sensitive-file'
    | 'sensitive-dir'
    | 'not-found'
    | 'is-directory'
    | 'too-large'
  /** 面向用户的说明（已脱敏：只说文件名与原因，不回显完整路径） */
  detail: string
  /** 归一化后的真实路径（仅在 allow 时有意义；调用方不要把它交给 renderer） */
  resolved: string | null
  /** 命中的规则名（审计用） */
  rule: string | null
}

/**
 * 敏感**文件名/后缀**规则（不区分大小写）。
 *
 * 这些是"绝不允许读取"的：凭据、密钥、令牌、会话与浏览器数据。
 *
 * 两条维护要求（改这里之前先读）：
 *   ① 规则要**宽到能拦住常见变体**（`.env.local`、`server.pem`），
 *      又**不能宽到误伤**（`environment.md` 不该被 `.env` 规则命中）；
 *   ② **不要写被前面规则完全覆盖的规则**。规则是**按顺序短路**的，
 *      一条永远轮不到的规则是死代码 —— 它会让"哪条规则拦住的"（审计字段）
 *      与实际不符，也会误导后来改这里的人。单测里有穷举用例专门盯这件事。
 */
export const SENSITIVE_FILE_RULES: ReadonlyArray<{ id: string, test: (name: string) => boolean, why: string }> = [
  {
    id: 'dotenv',
    // 一次性覆盖 `.env` / `.env.local` / `.env.production` 等全部变体
    test: n => /^\.env(\..+)?$/i.test(n),
    why: '.env 环境变量文件（含各种变体，通常含密钥）',
  },
  { id: 'private-key', test: n => /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i.test(n), why: '私钥 / 证书私钥文件' },
  { id: 'ssh-key', test: n => /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i.test(n), why: 'SSH 私钥（含公钥，成对出现时一并拒绝）' },
  { id: 'pgp-key', test: n => /^(secring|pubring)\.(gpg|pgp|kbx)$/i.test(n), why: 'PGP 密钥环' },
  { id: 'kdbx', test: n => /\.kdbx$/i.test(n), why: 'KeePass 数据库' },
  {
    id: 'credential-db',
    // 覆盖 credentials.json / secrets.db / logins.json / keychain.dat 等命名族
    test: n => /^(credentials?|credstore|logins?|keychain|secrets?)\.(json|db|sqlite|sqlite3|kdbx|dat|txt)$/i.test(n),
    why: '凭据数据库 / 密钥库',
  },
  { id: 'netrc', test: n => /^(_?netrc|\.netrc)$/i.test(n), why: '.netrc 明文凭据' },
  { id: 'git-credentials', test: n => /^\.git-credentials$/i.test(n), why: 'git 明文凭据' },
  { id: 'npmrc-token', test: n => /^\.npmrc$/i.test(n), why: '.npmrc（常含 registry token）' },
  { id: 'aws-credentials', test: n => /^credentials$/i.test(n), why: 'AWS 凭据文件（无扩展名）' },
  { id: 'browser-cookies', test: n => /^(cookies|login data|web data|cookies-journal)$/i.test(n), why: '浏览器 cookie / 登录数据' },
  { id: 'browser-logins', test: n => /^(key[34]\.db|key[34]\.db-wal)$/i.test(n), why: '浏览器保存的密码库（SQLite）' },
  { id: 'token-file', test: n => /\.(token|tokens|secret|secrets|credentials)$/i.test(n), why: '令牌 / 密钥文件' },
  { id: 'service-account', test: n => /^(service[-_]?account|gcloud[-_]?creds).*\.json$/i.test(n), why: '云服务账号密钥' },
  { id: 'wallet', test: n => /^(wallet\.dat|electrum.*|keystore)$/i.test(n), why: '加密钱包文件' },
  { id: 'shadow-passwd', test: n => /^(shadow|passwd|sudoers)$/i.test(n), why: '系统账号数据库' },
  { id: 'sam-hive', test: n => /^(sam|system|security|software)$/i.test(n), why: 'Windows 注册表配置单元（可能含凭据）' },
]

/**
 * 敏感**目录**规则（路径片段匹配，不区分大小写）。
 * 命中即拒（即使它在白名单里 —— 白名单是"用户授权"，但凭据类目录是**硬拒绝**）。
 *
 * ⚠ 同样是**按顺序短路**：`^Windows$` 会拦住 `C:\Windows\...` 的**每一个**片段比较
 *   （因为 `Windows` 本身是一个路径段），所以 `System32` 那条其实是轮不到的 ——
 *   保留它只会误导。这类"死规则"由单测的穷举用例盯着。
 */
export const SENSITIVE_DIR_RULES: ReadonlyArray<{ id: string, segment: RegExp, why: string }> = [
  { id: 'ssh', segment: /^\.ssh$/i, why: 'SSH 目录（私钥）' },
  { id: 'gnupg', segment: /^(\.gnupg|gnupg)$/i, why: 'GnuPG 目录（密钥环）' },
  { id: 'aws', segment: /^\.aws$/i, why: 'AWS 凭据目录' },
  { id: 'azure', segment: /^\.azure$/i, why: 'Azure 凭据目录' },
  { id: 'gcloud', segment: /^gcloud$/i, why: 'Google Cloud 凭据目录' },
  { id: 'kube', segment: /^\.kube$/i, why: 'kubeconfig（含集群凭据）' },
  { id: 'docker', segment: /^\.docker$/i, why: 'Docker 配置（含 registry 凭据）' },
  { id: 'npm', segment: /^\.npm$/i, why: 'npm 配置（含 token）' },
  { id: 'password-store', segment: /^(\.password-store|pass)$/i, why: 'pass 密码库' },
  { id: 'browser-profile', segment: /^(User Data|Default|Profile \d+)$/i, why: '浏览器用户数据目录（cookie / 密码 / 会话）' },
  { id: 'credentials-dir', segment: /^(Credentials|Protect)$/i, why: 'Windows 凭据目录' },
  { id: 'secrets-dir', segment: /^(secrets?|credentials?|private)$/i, why: '名为 secrets / credentials / private 的目录' },
  { id: 'app-data', segment: /^AiriMateOne$/i, why: '本应用自己的数据目录（含加密密钥文件）' },
  { id: 'windows', segment: /^Windows$/i, why: 'Windows 系统目录（含 System32）' },
  { id: 'program-files', segment: /^Program Files( \(x86\))?$/i, why: 'Program Files' },
  { id: 'system-volume', segment: /^(System Volume Information|\$Recycle\.Bin)$/i, why: '系统卷信息 / 回收站' },
  { id: 'etc', segment: /^etc$/i, why: '/etc 系统配置' },
  { id: 'proc-sys', segment: /^(proc|sys|dev)$/i, why: '内核伪文件系统' },
  /**
   * ⚠ **不要写 `^AppData$`**。
   *
   * 实测踩到：加了这条之后**所有用例全红** —— 因为临时目录本身就在
   * `C:\Users\<user>\AppData\Local\Temp\...` 下，连"正常的普通文件可读"都被拒了。
   * 更重要的是它**语义上也错**：AppData 下面绝大多数是合法的工作数据
   * （用户完全可能授权 `AppData\Roaming\<app>\data`）；
   * 真正该拒的是**其中的凭据子目录**（下面这几条）。
   *
   * 教训：目录规则的作用域要落在"确实只装敏感东西"的那一层，
   * 一刀切到父目录会把功能一起砍掉（过宽 = 白名单形同虚设，和过松一样是缺陷）。
   */
  { id: 'appdata-credentials', segment: /^(Microsoft|Credentials|Protect)$/i, why: 'Windows 凭据/系统配置子目录' },
  { id: 'appdata-browser', segment: /^(Google|Mozilla|Microsoft\\Edge|BraveSoftware|Chromium)$/i, why: '浏览器厂商数据目录（含 cookie/密码/会话）' },
  { id: 'appdata-tokens', segment: /^(npm-cache|pip|NuGet|gcloud|\.config)$/i, why: '包管理器/云 CLI 缓存（含 token）' },
]

/**
 * 归一化路径用于比较：`realpath` 解析（穿透符号链接/junction）+ 去尾分隔符 + 小写。
 *
 * Windows 大小写不敏感 ⇒ 必须统一小写比较；但**返回给调用方的 `resolved`
 * 保留真实大小写**（否则读文件会失败）。
 */
function canonical(p: string): { real: string, compare: string } {
  const abs = resolve(p)
  let real = abs
  try {
    // 目标不存在时 realpathSync 会抛 —— 那就退化为字符串归一化（无害：读不到）
    if (existsSync(abs)) real = realpathSync.native(abs)
  } catch { real = normalize(abs) }
  return { real, compare: real.replace(/[\\/]+$/, '').toLowerCase() }
}

function isInside(child: string, root: string): boolean {
  if (child === root) return true
  return child.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** 取路径的所有片段（用于目录规则） */
function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean)
}

/**
 * ★ **唯一**的文件访问判定。
 *
 * @param target    用户/模型给出的路径（可以是相对的；相对于 `baseDir` 解析）
 * @param allowlist 用户授权的目录白名单（**空 = 什么都不许读**，这是安全缺省）
 * @param opts      `wantDirectory`：允许目录本身（列目录用）；`maxBytes`：大小上限检查
 */
export function checkPathAccess(
  target: string,
  allowlist: readonly string[],
  opts: { baseDir?: string, wantDirectory?: boolean, maxBytes?: number } = {},
): PathVerdict {
  const deny = (code: PathVerdict['code'], detail: string, rule: string | null = null): PathVerdict =>
    ({ access: 'deny', code, detail, resolved: null, rule })

  if (typeof target !== 'string' || target.trim().length === 0) return deny('not-absolute', '路径为空', null)

  /**
   * ⚠ 空白名单 = **什么都不许读**。
   *   这是刻意的安全缺省：用户没授权任何目录时，"默认允许"会让整个白名单形同虚设。
   */
  if (allowlist.length === 0) return deny('empty-allowlist', '尚未授权任何目录（默认拒绝全部文件访问）', null)

  const raw = target.trim()
  const abs = isAbsolute(raw) ? raw : resolve(opts.baseDir ?? process.cwd(), raw)
  const { real, compare } = canonical(abs)

  // ① 目录规则（硬拒绝，优先于白名单）：命中即拒，即使该目录在白名单里
  const segs = segments(compare)
  for (const s of segs) {
    for (const rule of SENSITIVE_DIR_RULES) {
      if (rule.segment.test(s)) return deny('sensitive-dir', `拒绝访问系统/凭据目录（${rule.why}）`, rule.id)
    }
  }

  // ② 文件名规则（硬拒绝）
  const name = basename(compare)
  for (const rule of SENSITIVE_FILE_RULES) {
    if (rule.test(name)) return deny('sensitive-file', `拒绝读取敏感文件（${rule.why}）`, rule.id)
  }

  // ③ 白名单（**所有**白名单根都过一遍，命中任一即通过）
  let insideRoot: string | null = null
  for (const root of allowlist) {
    if (typeof root !== 'string' || root.trim().length === 0) continue
    const c = canonical(root)
    if (isInside(compare, c.compare)) { insideRoot = c.real; break }
  }
  if (insideRoot === null) {
    return deny('outside-allowlist', '该路径不在你授权的目录白名单内', null)
  }

  // ④ 存在性与类型
  if (!existsSync(real)) return deny('not-found', '文件不存在', null)
  let st
  try { st = statSync(real) } catch { return deny('not-found', '无法读取文件信息', null) }
  if (st.isDirectory() && !opts.wantDirectory) return deny('is-directory', '这是一个目录，不是文件', null)

  // ⑤ 大小上限（防止把整个大文件读进内存）
  if (opts.maxBytes !== undefined && st.isFile() && st.size > opts.maxBytes) {
    return deny('too-large', `文件过大（${st.size} 字节 > 上限 ${opts.maxBytes}）`, null)
  }

  return { access: 'allow', code: 'ok', detail: '在白名单内且不是敏感文件', resolved: real, rule: null }
}

/** 只判断"这个目录能不能被加进白名单"（用户在设置页添加目录时调） */
export function checkAllowlistCandidate(dir: string): PathVerdict {
  if (typeof dir !== 'string' || dir.trim().length === 0) {
    return { access: 'deny', code: 'not-absolute', detail: '路径为空', resolved: null, rule: null }
  }
  const abs = resolve(dir.trim())
  if (!existsSync(abs)) return { access: 'deny', code: 'not-found', detail: '目录不存在', resolved: null, rule: null }
  try {
    if (!statSync(abs).isDirectory()) return { access: 'deny', code: 'is-directory', detail: '不是目录', resolved: null, rule: null }
  } catch { return { access: 'deny', code: 'not-found', detail: '无法读取目录信息', resolved: null, rule: null } }
  const { compare, real } = canonical(abs)
  for (const s of segments(compare)) {
    for (const rule of SENSITIVE_DIR_RULES) {
      if (rule.segment.test(s)) return { access: 'deny', code: 'sensitive-dir', detail: `不能授权该目录（${rule.why}）`, resolved: null, rule: rule.id }
    }
  }
  return { access: 'allow', code: 'ok', detail: '可以作为授权目录', resolved: real, rule: null }
}

/** 供 UI 展示的规则摘要（**只给数量与说明，不给任何用户路径**） */
export function ruleSummary(): { fileRules: number, dirRules: number, fileRuleIds: string[], dirRuleIds: string[] } {
  return {
    fileRules: SENSITIVE_FILE_RULES.length,
    dirRules: SENSITIVE_DIR_RULES.length,
    fileRuleIds: SENSITIVE_FILE_RULES.map(r => r.id),
    dirRuleIds: SENSITIVE_DIR_RULES.map(r => r.id),
  }
}
