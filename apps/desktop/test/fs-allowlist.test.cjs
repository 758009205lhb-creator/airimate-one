/**
 * apps/desktop/test/fs-allowlist.test.cjs —— 文件访问判定的**穷举式**单测（M3 §5）
 *
 * 为什么这组要写得这么密：这是整个产品里**最容易被绕过**的一处。
 *   一旦有一个变体能读到 `.ssh/id_rsa`，其它所有安全设计（三档权限、审计、
 *   密钥不进 renderer）都会变成装饰。所以这里对**每一条规则**都造一个真实变体，
 *   并对**每一种绕过手法**（`..` 穿越、大小写、混合分隔符、白名单是文件、空白名单）
 *   逐个断言。
 *
 * 纪律：**判定是纯函数**（输入路径 + 白名单 → 结论），所以可以穷举，不需要起应用。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { tmpdir, stubElectron } = require('./helpers/harness.cjs')

const TMP = tmpdir('fsallow')
stubElectron(TMP)

const { checkPathAccess, checkAllowlistCandidate, ruleSummary, SENSITIVE_FILE_RULES, SENSITIVE_DIR_RULES } =
  require('../dist/main/fs-allowlist.js')

// ── 真实目录树：在临时目录里造出"授权区"与"敏感区"
const ROOT = path.join(TMP, 'work')          // 授权区
const OUTSIDE = path.join(TMP, 'outside')    // 未授权区
const SECRETS = path.join(ROOT, '.ssh')      // 敏感目录（即使在工作区内也必须拒）
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true })
fs.mkdirSync(SECRETS, { recursive: true })
fs.mkdirSync(OUTSIDE, { recursive: true })

const ALLOW = [ROOT]
function write(p, content = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf8')
  return p
}
write(path.join(ROOT, 'docs', 'readme.md'), 'hello')
write(path.join(ROOT, 'docs', 'notes.txt'), 'hello')
write(path.join(OUTSIDE, 'other.md'), 'nope')
write(path.join(ROOT, '.env'), 'SECRET=1')
write(path.join(ROOT, '.env.local'), 'SECRET=1')
write(path.join(ROOT, 'id_rsa'), 'KEY')
write(path.join(ROOT, 'server.pem'), 'KEY')
write(path.join(ROOT, 'vault.kdbx'), 'DB')
write(path.join(ROOT, 'credentials.json'), '{}')
write(path.join(ROOT, 'Cookies'), 'db')
write(SECRETS + path.sep + 'id_ed25519', 'KEY')

// ───────────────────────────────────────────────────────── 正常路径

test('白名单内的普通文件可读（这是"能用"的底线）', () => {
  const v = checkPathAccess(path.join(ROOT, 'docs', 'readme.md'), ALLOW)
  assert.equal(v.access, 'allow')
  assert.equal(v.code, 'ok')
  assert.ok(v.resolved && v.resolved.endsWith('readme.md'))
})

test('相对路径按 baseDir 解析（模型常给相对路径）', () => {
  const v = checkPathAccess('docs/notes.txt', ALLOW, { baseDir: ROOT })
  assert.equal(v.access, 'allow')
  const bad = checkPathAccess('docs/notes.txt', ALLOW, { baseDir: OUTSIDE })
  assert.equal(bad.access, 'deny')
})

test('未授权目录内的普通文件被拒（白名单真的在起作用）', () => {
  const v = checkPathAccess(path.join(OUTSIDE, 'other.md'), ALLOW)
  assert.equal(v.access, 'deny')
  assert.equal(v.code, 'outside-allowlist')
})

// ───────────────────────────────────────────────────────── 敏感文件（逐条规则）

test('★★ 每一条敏感文件规则都有一个真实变体被拒（逐条点名，规则被删就会红）', () => {
  /**
   * ⚠ 这里的断言口径是**"被拦住了"**，而**不是**"由哪条规则拦住"。
   *   规则是**按顺序短路**的，多条规则命中同一文件名很正常
   *   （`.env.local` 同时符合"dotenv"与"变体"两种描述）。
   *   早期我把断言写成"必须是某条规则"⇒ 四处失败，而实现其实是**对的** ——
   *   那是**过严的断言制造假失败**，比漏报更糟（会让人把这条检查当噪声）。
   *   真正该盯的是"有没有**轮不到**的死规则"，那由下面的用例单独负责。
   */
  const cases = [
    '.env', '.env.local', '.env.production',
    'id_rsa', 'id_ed25519',
    'server.pem', 'client.p12', 'private.key',
    'vault.kdbx',
    'credentials.json', 'secrets.db', 'logins.json',
    'Cookies', 'Login Data',
    'key4.db', 'key4.db-wal',
    '.netrc', '.git-credentials', '.npmrc',
    'credentials', 'api.token', 'service-account-prod.json',
    'wallet.dat', 'shadow', 'secring.gpg',
  ]
  const missed = []
  for (const name of cases) {
    const p = write(path.join(ROOT, 'probe-dir', name))
    const v = checkPathAccess(p, ALLOW)
    /**
     * ⚠ 允许 `sensitive-dir`：像 `credentials` 这种名字**既是敏感文件名、
     *   也是敏感目录名片段**，被目录规则先拦下是**更严**的结果，不是缺陷。
     *   这里要判的是"**被硬拒绝了**"，而不是"由哪一类规则拒绝"。
     */
    if (v.access !== 'deny' || (v.code !== 'sensitive-file' && v.code !== 'sensitive-dir')) {
      missed.push(`${name} → access=${v.access} code=${v.code}`)
    }
    if (!v.rule) missed.push(`${name} → 被拒但没有规则 id（审计无法追溯）`)
  }
  assert.deepEqual(missed, [], `这些敏感文件没被拦住：\n${missed.join('\n')}`)
})

test('★★ 没有"轮不到"的死规则（死规则会让审计字段与实际不符）', () => {
  /**
   * 规则按顺序短路 ⇒ 如果 A 与 B 的匹配集有包含关系，B 永远不会命中。
   * 这里用一组"探针文件名"逐个走过规则链，统计哪些**从未**命中过任何探针 ——
   * 死规则一律要求删掉或合并（不是"留着也无害"：它会误导后来改这里的人）。
   *
   * 探针集合刻意覆盖各类命名的形态；新增规则时若忘了给探针，也会在这里暴露。
   */
  const probes = [
    '.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', 'id_rsa.pub',
    'server.pem', 'client.p12', 'private.key', 'a.jks', 'a.ppk',
    'secring.gpg', 'pubring.kbx', 'vault.kdbx',
    'credentials.json', 'secrets.db', 'logins.json', 'keychain.dat', 'credstore.txt',
    '.netrc', '_netrc', '.git-credentials', '.npmrc',
    'credentials', 'api.token', 'api.tokens', 'my.secret', 'my.secrets', 'x.credentials',
    'service-account.json', 'gcloud-creds.json',
    'Cookies', 'Login Data', 'Web Data', 'Cookies-journal', 'key3.db', 'key4.db', 'key4.db-wal',
    'wallet.dat', 'electrum-wallet', 'shadow', 'passwd', 'sudoers',
    'sam', 'system', 'security', 'software',
    'readme.md', 'notes.txt', 'environment.md',
  ]
  const hit = new Set()
  for (const name of probes) {
    for (const r of SENSITIVE_FILE_RULES) {
      if (r.test(name)) { hit.add(r.id); break }   // 短路：与实现一致
    }
  }
  const dead = SENSITIVE_FILE_RULES.map(r => r.id).filter(id => !hit.has(id))
  assert.deepEqual(dead, [], `这些文件规则永远轮不到（请合并或删除）：${dead.join(', ')}`)
})

test('★★ 没有"轮不到"的死目录规则', () => {
  const probeSegments = [
    '.ssh', '.gnupg', 'gnupg', '.aws', '.azure', 'gcloud', '.kube', '.docker', '.npm',
    '.password-store', 'pass', 'User Data', 'Default', 'Profile 3',
    'Credentials', 'Protect', 'secret', 'secrets', 'credential', 'credentials', 'private',
    'AiriMateOne', 'Windows', 'System32', 'Program Files', 'Program Files (x86)',
    'System Volume Information', '$Recycle.Bin', 'etc', 'proc', 'sys', 'dev',
    // AppData 下的凭据类子目录（这几个是"宁可细一点也不要一刀切"的落地）
    'Microsoft', 'Google', 'Mozilla', 'BraveSoftware', 'Chromium',
    'npm-cache', 'pip', 'NuGet', '.config',
    // 反例：这些必须在白名单里可用（过宽的规则会在这里暴露）
    'Users', 'AppData', 'Local', 'Roaming', 'Temp', 'Projects', 'Documents', 'work',
  ]
  const hit = new Set()
  for (const seg of probeSegments) {
    for (const r of SENSITIVE_DIR_RULES) {
      if (r.segment.test(seg)) { hit.add(r.id); break }
    }
  }
  const dead = SENSITIVE_DIR_RULES.map(r => r.id).filter(id => !hit.has(id))
  assert.deepEqual(dead, [], `这些目录规则永远轮不到（请合并或删除）：${dead.join(', ')}`)
})

test('★ 过宽的目录规则会被这个反例集抓到（AppData 一刀切就是被它抓出来的）', () => {
  // 这些是**普通工作目录**，必须允许（否则白名单功能形同虚设）
  const mustAllow = ['Users', 'AppData', 'Local', 'Roaming', 'Temp', 'Projects', 'Documents', 'src', 'node_modules', 'work']
  const wronglyDenied = []
  for (const seg of mustAllow) {
    for (const r of SENSITIVE_DIR_RULES) {
      if (r.segment.test(seg)) { wronglyDenied.push(`${seg} 被规则 ${r.id} 命中（${r.why}）`); break }
    }
  }
  assert.deepEqual(wronglyDenied, [], `这些普通目录不该被敏感规则命中：\n${wronglyDenied.join('\n')}`)
})

test('★ 敏感文件即使位于**白名单内**也必须拒（白名单不等于放行凭据）', () => {
  const v = checkPathAccess(path.join(ROOT, '.env'), ALLOW)
  assert.equal(v.access, 'deny')
  assert.equal(v.code, 'sensitive-file')
})

test('★ 脱敏说明里**不回显完整路径**（只说文件名与原因）', () => {
  const v = checkPathAccess(path.join(ROOT, '.env'), ALLOW)
  assert.equal(v.detail.includes(ROOT), false, `说明里不该出现目录：${v.detail}`)
  assert.match(v.detail, /\.env/)
})

test('不该误伤：名字里含 env / key / token 的普通文件仍可读', () => {
  // 这几条是"规则过宽"的反例：过宽会让白名单功能形同虚设（用户什么也读不了）
  for (const name of ['environment.md', 'keyboard.txt', 'tokenizer-notes.md', 'monkey.txt', 'secrets-policy.md']) {
    const p = write(path.join(ROOT, 'docs', name))
    const v = checkPathAccess(p, ALLOW)
    assert.equal(v.access, 'allow', `${name} 不该被敏感规则命中（实际 code=${v.code} rule=${v.rule}）`)
  }
})

// ───────────────────────────────────────────────────────── 敏感目录

test('★★ 敏感目录内的文件被拒（即使整个工作在授权区里）', () => {
  const cases = [
    ['.ssh/id_rsa', 'ssh'],
    ['.aws/credentials', 'aws'],
    ['.kube/config', 'kube'],
    ['.docker/config.json', 'docker'],
    ['.gnupg/secring.gpg', 'gnupg'],
    ['secrets/anything.txt', 'secrets-dir'],
  ]
  const missed = []
  for (const [rel, expectedRule] of cases) {
    const p = write(path.join(ROOT, rel))
    const v = checkPathAccess(p, ALLOW)
    if (v.access !== 'deny' || v.code !== 'sensitive-dir' || v.rule !== expectedRule) {
      missed.push(`${rel} → code=${v.code} rule=${v.rule}（期望 rule=${expectedRule}）`)
    }
  }
  assert.deepEqual(missed, [], `这些敏感目录没被拦住：\n${missed.join('\n')}`)
})

test('★ 系统目录一律拒绝（Windows / System32 / Program Files / etc）', () => {
  const sys = process.env.SystemRoot || 'C:\\Windows'
  const v = checkPathAccess(path.join(sys, 'System32', 'drivers', 'etc', 'hosts'), [sys])
  assert.equal(v.access, 'deny')
  assert.ok(['sensitive-dir', 'sensitive-file'].includes(v.code), `实际 code=${v.code} rule=${v.rule}`)
})

test('★ 授权目录本身也不能是敏感目录（用户在设置页加目录时就被拦）', () => {
  const bad = checkAllowlistCandidate(path.join(ROOT, '.ssh'))
  assert.equal(bad.access, 'deny')
  assert.equal(bad.code, 'sensitive-dir')
  const good = checkAllowlistCandidate(path.join(ROOT, 'docs'))
  assert.equal(good.access, 'allow')
})

// ───────────────────────────────────────────────────────── 绕过手法

test('★★ `..` 穿越被拦住（这是最经典的绕过）', () => {
  const v = checkPathAccess(path.join(ROOT, 'docs', '..', '..', 'outside', 'other.md'), ALLOW)
  assert.equal(v.access, 'deny')
  assert.equal(v.code, 'outside-allowlist')
})

test('★★ 大小写差异不能绕过（Windows 大小写不敏感）', () => {
  // 授权 ROOT，用大小写变体访问 outside —— 归一化后仍应在白名单外
  const upper = path.join(TMP, 'OUTSIDE', 'OTHER.MD')
  const v = checkPathAccess(upper, ALLOW)
  assert.equal(v.access, 'deny', `大小写变体不该放行：${JSON.stringify(v)}`)
})

test('★★ 混合分隔符不能绕过（`/` 与 `\\` 混用）', () => {
  const mixed = `${ROOT}/docs\\${'..'}/../outside/other.md`
  const v = checkPathAccess(mixed, ALLOW)
  assert.equal(v.access, 'deny')
})

test('★ 前缀相似的兄弟目录不能绕过（`work` vs `work-evil`）', () => {
  const evil = path.join(TMP, 'work-evil')
  fs.mkdirSync(evil, { recursive: true })
  const p = write(path.join(evil, 'x.md'))
  const v = checkPathAccess(p, ALLOW)
  assert.equal(v.access, 'deny', '前缀匹配必须按"路径段"而不是"字符串前缀"')
})

test('★ 空白名单 = 全部拒绝（安全缺省，而不是"默认允许"）', () => {
  const v = checkPathAccess(path.join(ROOT, 'docs', 'readme.md'), [])
  assert.equal(v.access, 'deny')
  assert.equal(v.code, 'empty-allowlist')
  assert.match(v.detail, /默认拒绝/)
})

test('白名单里的空串与非法项被忽略（不会意外放行根目录）', () => {
  const v = checkPathAccess(path.join(OUTSIDE, 'other.md'), ['', '   ', ROOT])
  assert.equal(v.access, 'deny')
})

// ───────────────────────────────────────────────────────── 其它守卫

test('不存在的文件与目录分别给出可区分的拒绝码', () => {
  assert.equal(checkPathAccess(path.join(ROOT, 'docs', 'nope.md'), ALLOW).code, 'not-found')
  assert.equal(checkPathAccess(path.join(ROOT, 'docs'), ALLOW).code, 'is-directory')
  // wantDirectory 时目录本身合法
  assert.equal(checkPathAccess(path.join(ROOT, 'docs'), ALLOW, { wantDirectory: true }).access, 'allow')
})

test('★ 大小上限：超限文件被拒（防止把大文件读进内存）', () => {
  const big = write(path.join(ROOT, 'docs', 'big.txt'), 'y'.repeat(5000))
  assert.equal(checkPathAccess(big, ALLOW, { maxBytes: 1000 }).code, 'too-large')
  assert.equal(checkPathAccess(big, ALLOW, { maxBytes: 10_000 }).access, 'allow')
})

test('空路径 / 非字符串被拒（不抛错）', () => {
  assert.equal(checkPathAccess('', ALLOW).access, 'deny')
  assert.equal(checkPathAccess('   ', ALLOW).access, 'deny')
  assert.equal(checkPathAccess(undefined, ALLOW).access, 'deny')
  assert.equal(checkPathAccess(null, ALLOW).access, 'deny')
})

test('规则摘要只给数量与 id（不给任何用户路径）', () => {
  const s = ruleSummary()
  assert.ok(s.fileRules >= 15)
  assert.ok(s.dirRules >= 12)
  assert.equal(JSON.stringify(s).includes(TMP.replace(/\\/g, '\\\\')), false)
  assert.equal(JSON.stringify(s).includes('work'), false)
})

test('规则本身的自检：没有空规则 / 没有永远不匹配的规则', () => {
  for (const r of SENSITIVE_FILE_RULES) {
    assert.ok(r.id.length > 0)
    assert.ok(r.why.length > 0)
  }
  for (const r of SENSITIVE_DIR_RULES) {
    assert.ok(r.id.length > 0)
    assert.ok(r.why.length > 0)
    assert.equal(r.segment.test(''), false, `${r.id} 不该匹配空片段`)
  }
})

test('真实符号链接/junction 不能绕过白名单（若本机允许创建）', () => {
  const linkPath = path.join(ROOT, 'link-to-outside')
    try {
      fs.symlinkSync(OUTSIDE, linkPath, 'junction')
    } catch {
      // 无权限创建链接（或已存在）⇒ 跳过而不是假通过
      return
    }
  const v = checkPathAccess(path.join(linkPath, 'other.md'), ALLOW)
  assert.equal(v.access, 'deny', 'junction 必须被 realpath 解析后判定')
  try { fs.rmSync(linkPath, { recursive: true, force: true }) } catch { /* ignore */ }
})
