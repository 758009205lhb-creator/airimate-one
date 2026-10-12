/**
 * apps/desktop/test/tts.test.cjs —— TTS 引擎单测（分块 / 载荷安全 / 声音挑选 / 取消状态机）
 *
 * 为什么必须有单测：这条链上**每一环都能静默出错**，而错了都"看起来像成功"——
 *   · 分块写错 ⇒ 长回复被截断或死循环（渲染管线直接挂住）；
 *   · 载荷构造写错 ⇒ 正文进命令行（隐私事故，且不报错）；
 *   · 选声写错 ⇒ 中文角色用英文声音念，用户只听到"怪"，没有任何错误；
 *   · 取消状态机写错 ⇒ speak promise 悬挂，停止按钮点了没反应。
 * 端到端都很难定位，所以这里把这些**可观察行为**钉死。
 *
 * ⚠ 本测试**绝不发出声音**：只覆盖纯逻辑（分块 / 清洗 / 载荷 / 选声 / 状态机）。
 *   真实 SAPI 调用在 `--probe tts` 里做（那是可显式运行、可关掉的探针）。
 *
 * 隔离：`electron` 被最小打桩（`paths.ts` 需要 `app.getPath('userData')`），
 *       `userData` 指向临时目录，绝不碰真实用户数据。
 * 运行：`node --test apps/desktop/test/tts.test.cjs`
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'airimate-tts-'))

// 在加载业务模块之前打桩 electron
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath: () => TMP,
        getAppPath: () => path.resolve(__dirname, '..'),
        isPackaged: false,
        setName: () => {},
        setPath: () => {},
      },
    }
  }
  return origLoad.call(this, request, parent, isMain)
}

const tts = require('../dist/main/tts-engine.js')

const MAX = tts.TTS_MAX_CHUNK_CHARS

/** 拼回原文 —— 分块的硬契约（不能丢字、不能加字） */
const rejoin = (chunks) => chunks.join('')

// ═════════════════════════════════════════════════ ① 分块

test('短文本不分块（一块原样返回）', () => {
  const chunks = tts.chunkText('你好呀。')
  assert.deepEqual(chunks, ['你好呀。'])
})

test('中英句末标点都是句子边界：超长时在标点处断开，标点留在前一块', () => {
  // 每句约 66 字 ⇒ 两句装不进 120，必定在句末标点处断
  const sentence = `${'甲'.repeat(64)}。`
  const text = sentence + 'Really? Yes; ok!' + sentence
  const chunks = tts.chunkText(text)
  assert.equal(rejoin(chunks), text, '拼回必须等于原文')
  assert.ok(chunks.length >= 2, `应至少切成 2 块，实际 ${chunks.length}`)
  for (const c of chunks) assert.ok(c.length <= MAX, `块超长：${c.length}`)
  // 标点必须归前一块：块首不应是句末标点
  for (const c of chunks) assert.equal('。！？；!?;'.includes(c[0]), false, `标点不应另起一块：${JSON.stringify(c)}`)
  /**
   * 真正的判据：除最后一块外，每块都必须在**标点边界**结束。
   * 这正是"取消响应快"的前提 —— 断点落在标点上，合成器不会停在一句话中间。
   * （不写成"第一块必须以 。 结尾"：装箱会把相邻短句并进同一块，
   *   第一块可能以 `ok!` 这类更靠后的边界结束，那同样是合法的边界。）
   */
  for (const c of chunks.slice(0, -1)) {
    assert.equal(/[。！？；!?;，、,：:\n]$/.test(c), true, `块未在标点边界结束：${JSON.stringify(c.slice(-8))}`)
  }
})

test('句子能装进一块时合并（减少子进程往返：短句不该一句一块）', () => {
  const text = '一。二。三。四。五。'
  const chunks = tts.chunkText(text)
  assert.deepEqual(chunks, [text], '短句应合并为一块')
})

test('每块长度都不超过 120（判据：SAPI 阻塞 ⇒ 单块必须可控）', () => {
  const text = '这是一句普通的话。'.repeat(60)   // 540 字
  const chunks = tts.chunkText(text)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.length <= MAX, `块超长：${c.length} > ${MAX}`)
  assert.equal(rejoin(chunks), text)
})

test('长句无标点：靠子句标点（，、）在 120 内断开', () => {
  const text = '甲'.repeat(60) + '，' + '乙'.repeat(60) + '，' + '丙'.repeat(60)
  const chunks = tts.chunkText(text)
  for (const c of chunks) assert.ok(c.length <= MAX, `块超长：${c.length}`)
  assert.equal(rejoin(chunks), text)
})

test('★ 10000 字无任何标点：必须终止、每块 ≤120、拼回等于原文（防死循环）', () => {
  const text = '字'.repeat(10000)
  const chunks = tts.chunkText(text)
  assert.equal(chunks.length, Math.ceil(10000 / MAX), `应为 ${Math.ceil(10000 / MAX)} 块，实际 ${chunks.length}`)
  for (const c of chunks) assert.ok(c.length <= MAX && c.length > 0)
  assert.equal(rejoin(chunks), text)
})

test('★ 超长输入 + 混合标点：仍必须终止且 ≤120（硬切兜底生效）', () => {
  const text = ('没有任何标点的超长片段'.repeat(400) + '。').repeat(3)   // 约 3000+ 字
  const chunks = tts.chunkText(text)
  for (const c of chunks) assert.ok(c.length <= MAX, `块超长：${c.length}`)
  assert.equal(rejoin(chunks), text)
})

test('换行是强边界（\r\n 与 \n 都断，且不丢字符）', () => {
  const text = '第一行\r\n第二行\n第三行'
  const chunks = tts.chunkText(text)
  assert.equal(rejoin(chunks), text, '换行字符不能被吞掉')
})

test('maxChars 可注入：上限被尊重（小值压力测试）', () => {
  const text = '一二三四五六七八九十。'.repeat(5)
  for (const limit of [1, 2, 3, 7, 13]) {
    const chunks = tts.chunkText(text, { maxChars: limit })
    for (const c of chunks) assert.ok(c.length <= limit, `limit=${limit} 时块长 ${c.length} 越界`)
    assert.equal(rejoin(chunks), text)
  }
})

test('纯空白 / 空串 / 非字符串返回空数组（不该产生一次合成）', () => {
  assert.deepEqual(tts.chunkText(''), [])
  assert.deepEqual(tts.chunkText('   \t\n  '), [])
  assert.deepEqual(tts.chunkText(null), [])
  assert.deepEqual(tts.chunkText(undefined), [])
})

test('Emoji（代理对）不被从中间切断（断在代理对中间会产生非法字符）', () => {
  const text = '😀'.repeat(100)   // 每个 emoji 是 2 个 UTF-16 码元
  const chunks = tts.chunkText(text)
  assert.equal(rejoin(chunks), text)
  for (const c of chunks) {
    // 首尾都不应是孤立代理项
    const first = c.charCodeAt(0), last = c.charCodeAt(c.length - 1)
    assert.equal(first >= 0xdc00 && first <= 0xdfff, false, '块首不应是孤立低位代理项')
    assert.equal(last >= 0xd800 && last <= 0xdbff, false, '块尾不应是孤立高位代理项')
  }
})

// ═════════════════════════════════════════════════ ② 清洗与载荷安全

test('sanitizeForSpeech 删除控制字符（NUL/ESC 等），保留 \t 与普通换行', () => {
  const out = tts.sanitizeForSpeech('前\u0000中\u001b后\t制表\n换行')
  assert.equal(out.includes('\u0000'), false, 'NUL 必须被删除')
  assert.equal(out.includes('\u001b'), false, 'ESC 必须被删除')
  assert.ok(out.includes('\t'), '制表符应保留（SAPI 当作停顿）')
  assert.ok(out.includes('\n'), '换行应保留')
  assert.ok(out.includes('前') && out.includes('中') && out.includes('后'), '可见字符不得改动')
})

test('sanitizeForSpeech 丢弃孤立代理项、保留成对代理项（否则 JSON 化产生非法转义）', () => {
  const lone = tts.sanitizeForSpeech('a\uD800b\uDC00c')
  assert.equal(lone, 'abc', `孤立代理项应被丢弃，实际 ${JSON.stringify(lone)}`)
  const pair = tts.sanitizeForSpeech('a😀b')
  assert.equal(pair, 'a😀b', '成对代理项必须原样保留')
})

test('sanitizeForSpeech 把 U+2028/U+2029 换成空格（部分解析器视其为换行）', () => {
  const out = tts.sanitizeForSpeech('前\u2028后\u2029尾')
  assert.equal(out.includes('\u2028'), false)
  assert.equal(out.includes('\u2029'), false)
  assert.ok(out.includes('前') && out.includes('后') && out.includes('尾'))
})

test('★ 载荷构造：正文在 payload.text 里，且 payload 是**合法 JSON**（子进程要 ConvertFrom-Json）', () => {
  const p = tts.buildSpeakPayload({ text: '带"双引号"和\\反斜杠的文本', voice: 'Microsoft Huihui Desktop' })
  assert.notEqual(p, null)
  const parsed = JSON.parse(p)                       // 不合法就会抛
  assert.equal(parsed.text, '带"双引号"和\\反斜杠的文本', '正文必须原样往返')
  assert.equal(parsed.voice, 'Microsoft Huihui Desktop')
  assert.deepEqual(Object.keys(parsed).sort(), ['output', 'rate', 'text', 'voice', 'volume'], '只暴露子进程需要的字段')
  assert.equal(parsed.output, 'device', '缺省输出目标必须是 device（真的出声）')
})

test('载荷构造：output 只能是 device/null，缺省与非法值都落回 device', () => {
  assert.equal(JSON.parse(tts.buildSpeakPayload({ text: '嗯', voice: null })).output, 'device')
  assert.equal(JSON.parse(tts.buildSpeakPayload({ text: '嗯', voice: null, output: 'null' })).output, 'null')
  assert.equal(JSON.parse(tts.buildSpeakPayload({ text: '嗯', voice: null, output: 'speaker' })).output, 'device')
  assert.equal(JSON.parse(tts.buildSpeakPayload({ text: '嗯', voice: null, output: null })).output, 'device')
})

test('★ 载荷构造：控制字符已被清洗（保证 ConvertFrom-Json 不会失败）', () => {
  const p = tts.buildSpeakPayload({ text: '坏\u0000字符\u001b[31m', voice: null })
  const parsed = JSON.parse(p)
  assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(parsed.text), false)
  assert.ok(parsed.text.startsWith('坏'), '可见前缀应保留')
})

test('载荷构造：空文本 / 纯空白 / 超长返回 null（调用方据此报结构化失败）', () => {
  assert.equal(tts.buildSpeakPayload({ text: '', voice: null }), null)
  assert.equal(tts.buildSpeakPayload({ text: '   \n ', voice: null }), null)
  assert.equal(tts.buildSpeakPayload({ text: '啊'.repeat(tts.TTS_MAX_TEXT_CHARS + 1), voice: null }), null)
  assert.notEqual(tts.buildSpeakPayload({ text: '啊'.repeat(tts.TTS_MAX_TEXT_CHARS), voice: null }), null)
})

test('载荷构造：非法 / 超长声音名降级为 null（不把脏值透给 SelectVoice）', () => {
  assert.equal(JSON.parse(tts.buildSpeakPayload({ text: '嗯', voice: '' })).voice, null)
  assert.equal(JSON.parse(tts.buildSpeakPayload({ text: '嗯', voice: 'x'.repeat(65) })).voice, null)
  assert.equal(JSON.parse(tts.buildSpeakPayload({ text: '嗯', voice: 'ok' })).voice, 'ok')
})

test('载荷构造：rate/volume 被夹到 SAPI 合法区间', () => {
  assert.equal(JSON.parse(tts.buildSpeakPayload({ text: '嗯', voice: null, rate: 999 })).rate, 10)
  assert.equal(JSON.parse(tts.buildSpeakPayload({ text: '嗯', voice: null, rate: -999 })).rate, -10)
  assert.equal(JSON.parse(tts.buildSpeakPayload({ text: '嗯', voice: null, rate: 2.7 })).rate, 2)
  assert.equal(JSON.parse(tts.buildSpeakPayload({ text: '嗯', voice: null, volume: 500 })).volume, 100)
  assert.equal(JSON.parse(tts.buildSpeakPayload({ text: '嗯', voice: null, volume: -5 })).volume, 0)
})

test('★ 子进程脚本里**不含**任何用户正文的插值点（正文只走 stdin）', () => {
  // 脚本是常量：不得出现 $args（命令行参数）读取正文的模式
  assert.equal(/\$args\b/.test(tts.PS_SPEAK_SCRIPT), false, '正文不得经命令行参数传入')
  assert.ok(tts.PS_SPEAK_SCRIPT.includes('[Console]::In.ReadToEnd()'), '正文必须从 stdin 读')
})

// ═════════════════════════════════════════════════ ③ stdout JSON 提取

test('★ 嵌套 JSON 提取：取完整顶层对象，而不是数组里最后一个元素（实测踩过的坑）', () => {
  // 这是 powershell 真实回包的形状；用 lastIndexOf('{') 会切出畸形片段
  const raw = '{"ok":true,"voices":[{"name":"Microsoft Zira Desktop","culture":"en-US","gender":"Female","enabled":true}]}'
  const parsed = tts.extractPsJson(raw)
  assert.notEqual(parsed, null)
  assert.equal(parsed.ok, true)
  assert.equal(Array.isArray(parsed.voices), true)
  assert.equal(parsed.voices.length, 1)
  assert.equal(parsed.voices[0].name, 'Microsoft Zira Desktop')
})

test('JSON 提取：容忍前导 BOM 与夹带的噪声行', () => {
  const parsed = tts.extractPsJson('\uFEFFWARNING: 一些噪声\r\n{"spoken":true,"voice":"Microsoft Huihui Desktop","ms":123}\r\n')
  assert.equal(parsed.spoken, true)
  assert.equal(parsed.voice, 'Microsoft Huihui Desktop')
  assert.equal(parsed.ms, 123)
})

test('JSON 提取：正文里的花括号/引号不会骗到扫描器', () => {
  const parsed = tts.extractPsJson('{"spoken":false,"reason":"文本 \\"a{b}\\" 含括号"}')
  assert.equal(parsed.spoken, false)
  assert.equal(parsed.reason, '文本 "a{b}" 含括号')
})

test('JSON 提取：空 / 无 JSON / 数组根 一律返回 null（不抛）', () => {
  assert.equal(tts.extractPsJson(''), null)
  assert.equal(tts.extractPsJson('no json here'), null)
  assert.equal(tts.extractPsJson('[1,2,3]'), null, '数组根不是本模块的载荷形状')
  assert.equal(tts.extractPsJson('{"unterminated":'), null)
})

// ═════════════════════════════════════════════════ ④ 声音挑选

const V = (name, culture, enabled = true) => ({ name, culture, gender: 'Female', enabled })

test('★ 默认优先 zh-CN（中文角色必须用中文声音）', () => {
  const voices = [V('Microsoft Zira Desktop', 'en-US'), V('Microsoft Huihui Desktop', 'zh-CN')]
  assert.equal(tts.chooseVoice(voices), 'Microsoft Huihui Desktop')
})

test('首选语言取第一个 zh-CN（顺序敏感）', () => {
  const voices = [V('zh-A', 'zh-CN'), V('zh-B', 'zh-CN'), V('en-A', 'en-US')]
  assert.equal(tts.chooseVoice(voices), 'zh-A')
})

test('★ 用户显式选择优先于语言偏好（设置必须被尊重）', () => {
  const voices = [V('Microsoft Huihui Desktop', 'zh-CN'), V('Microsoft Zira Desktop', 'en-US')]
  assert.equal(tts.chooseVoice(voices, 'Microsoft Zira Desktop'), 'Microsoft Zira Desktop')
})

test('偏好的声音不存在 → 回退 zh-CN（不报错：设置可能来自另一台机器）', () => {
  const voices = [V('Microsoft Zira Desktop', 'en-US'), V('Microsoft Huihui Desktop', 'zh-CN')]
  assert.equal(tts.chooseVoice(voices, '不存在的引擎'), 'Microsoft Huihui Desktop')
})

test('偏好匹配大小写不敏感', () => {
  const voices = [V('Microsoft Huihui Desktop', 'zh-CN')]
  assert.equal(tts.chooseVoice(voices, 'microsoft huihui desktop'), 'Microsoft Huihui Desktop')
})

test('没有 zh-CN → 回退到第一个可用声音（有声音就要能出声）', () => {
  const voices = [V('English One', 'en-US'), V('English Two', 'en-GB')]
  assert.equal(tts.chooseVoice(voices), 'English One')
})

test('zh 主干前缀匹配（zh-TW / zh_HK 也算中文，容忍下划线与大小写）', () => {
  assert.equal(tts.chooseVoice([V('A', 'en-US'), V('TW', 'zh-TW')]), 'TW')
  assert.equal(tts.chooseVoice([V('A', 'en-US'), V('HK', 'zh_HK')]), 'HK')
})

test('★ 被禁用的声音不参与挑选（禁用声音调用会失败）', () => {
  const voices = [V('DisabledZh', 'zh-CN', false), V('EnabledEn', 'en-US', true)]
  assert.equal(tts.chooseVoice(voices), 'EnabledEn')
})

test('★ 全部被禁用 / 空列表 → null（调用方据此报 NO_VOICE，不假装成功）', () => {
  assert.equal(tts.chooseVoice([V('A', 'zh-CN', false)]), null)
  assert.equal(tts.chooseVoice([]), null)
  assert.equal(tts.chooseVoice(null), null)
  assert.equal(tts.chooseVoice(undefined), null)
})

test('偏好命中被禁用的声音 → 不选它，回退到可用的', () => {
  const voices = [V('Want', 'en-US', false), V('Zh', 'zh-CN', true)]
  assert.equal(tts.chooseVoice(voices, 'Want'), 'Zh')
})

test('名称为空的声音被忽略', () => {
  assert.equal(tts.chooseVoice([V('', 'zh-CN'), V('Real', 'en-US')]), 'Real')
})

test('toVoiceInfo：出参不含任何本机路径字段', () => {
  const info = tts.toVoiceInfo({ name: 'Microsoft Huihui Desktop', culture: 'zh-CN', gender: 'Female', enabled: true })
  assert.deepEqual(Object.keys(info).sort(), ['gender', 'id', 'label', 'lang'])
  assert.equal(info.id, 'Microsoft Huihui Desktop')
  assert.equal(info.lang, 'zh-CN')
  assert.equal(info.label.includes('zh-CN'), true)
})

// ═════════════════════════════════════════════════ ⑤ 取消状态机

test('初始状态：未完成、未取消、无 kill 记录', () => {
  const s = new tts.TtsRunState()
  assert.equal(s.finished, false)
  assert.equal(s.cancelled, false)
  assert.equal(s.state, null)
  assert.equal(s.killCount, 0)
})

test('★ cancel 幂等：第二次返回 false 且不再计数（重复点停止不该重复杀）', () => {
  const s = new tts.TtsRunState()
  assert.equal(s.cancel(), true, '首次取消应返回 true')
  assert.equal(s.cancel(), false, '重复取消应返回 false')
  assert.equal(s.cancel(), false)
  assert.equal(s.cancelled, true)
  assert.equal(s.state, 'cancelled')
})

test('★ cancel 后 complete 不生效（终态只能写一次，避免"取消了却报完成"）', () => {
  const s = new tts.TtsRunState()
  s.cancel()
  assert.equal(s.complete(), false, '已取消后 complete 必须失败')
  assert.equal(s.state, 'cancelled', '终态不得被覆盖')
})

test('★ complete 后 cancel 不生效（正常说完后再点停止不该改终态）', () => {
  const s = new tts.TtsRunState()
  assert.equal(s.complete(), true)
  assert.equal(s.cancel(), false)
  assert.equal(s.state, 'completed')
  assert.equal(s.killCount, 0, '正常完成不该杀任何进程')
})

test('fail 后可观测，且 cancel 不再生效', () => {
  const s = new tts.TtsRunState()
  assert.equal(s.fail(), true)
  assert.equal(s.state, 'failed')
  assert.equal(s.cancel(), false)
  assert.equal(s.finished, true)
})

test('★ 取消发生在 spawn 之前：随后 attach 的子进程必须被立即杀掉（防漏杀）', () => {
  const s = new tts.TtsRunState()
  s.cancel()
  const fake = { exitCode: null, signalCode: null, kill() { this.killed = true } }
  s.attach(fake)
  assert.equal(fake.killed, true, '取消后才 spawn 的子进程必须立刻被杀')
  assert.equal(s.killCount, 1)
})

test('★ 取消发生在 spawn 之后：attach 中的子进程被 kill', () => {
  const s = new tts.TtsRunState()
  const fake = { exitCode: null, signalCode: null, kill() { this.killed = true } }
  s.attach(fake)
  assert.equal(fake.killed, undefined)
  s.cancel()
  assert.equal(fake.killed, true)
  assert.equal(s.killCount, 1)
})

test('已退出的子进程不被重复 kill（detach 后 killCount 不增长）', () => {
  const s = new tts.TtsRunState()
  const fake = { exitCode: null, signalCode: null, kill() { this.killed = true } }
  s.attach(fake)
  fake.exitCode = 0          // 子进程已退出
  s.detach(fake)
  s.cancel()
  assert.equal(s.killCount, 0, '已退出的进程不该被计入 kill')
})

test('kill() 抛异常不拖住 cancel（cancel 必须永远能返回）', () => {
  const s = new tts.TtsRunState()
  s.attach({ exitCode: null, signalCode: null, kill() { throw new Error('EPERM') } })
  assert.equal(s.cancel(), true, 'kill 抛错也必须完成取消')
  assert.equal(s.cancelled, true)
})

test('elapsedMs 单调不减（供日志记录取消耗时）', async () => {
  const s = new tts.TtsRunState()
  const a = s.elapsedMs
  await new Promise(r => setTimeout(r, 15))
  assert.ok(s.elapsedMs >= a)
})

// ═════════════════════════════════════════════════ ⑥ 临时正文文件（受限目录 + 必删）

test('★ 临时正文文件写在受限 ttsDir 下，且文件名里的路径穿越字符被清理', () => {
  const f = tts.writeTempUtterance('../../evil/../x', '不应该残留的正文')
  try {
    assert.ok(fs.existsSync(f), '文件应被写入')
    assert.equal(path.dirname(f), path.join(TMP, 'tts'), `必须落在 ttsDir 内，实际 ${path.dirname(f)}`)
    assert.equal(path.basename(f).includes('..'), false, '文件名不得含路径穿越序列')
    assert.equal(path.basename(f).includes('/'), false)
    assert.equal(fs.readFileSync(f, 'utf8'), '不应该残留的正文')
  } finally {
    fs.rmSync(f, { force: true })
  }
})

test('★ 删除临时文件：成功后文件不存在，重复删除返回 false（幂等）', () => {
  const f = tts.writeTempUtterance('utt-1', '正文')
  assert.equal(tts.removeTempUtterance(f), true)
  assert.equal(fs.existsSync(f), false, '正文文件必须被删除')
  assert.equal(tts.removeTempUtterance(f), false, '重复删除应返回 false')
  assert.equal(tts.removeTempUtterance(null), false)
})

test('★ 安全闸：拒绝删除 ttsDir 之外的文件（防误删）', () => {
  const outside = path.join(TMP, 'must-not-delete.txt')
  fs.writeFileSync(outside, '受保护', 'utf8')
  assert.equal(tts.removeTempUtterance(outside), false, 'ttsDir 外的路径必须被拒绝')
  assert.ok(fs.existsSync(outside), '该文件必须仍然存在')
  fs.rmSync(outside, { force: true })
})

// ═════════════════════════════════════════════════ ⑦ 常量与契约

test('常量契约：单块上限 120，引擎名为 windows-sapi', () => {
  assert.equal(MAX, 120)
  assert.equal(tts.TTS_ENGINE, 'windows-sapi')
  assert.equal(tts.TTS_PREFERRED_LANG, 'zh-CN')
})

test('引擎实例：接口形状齐全（speak/stop/speaking/currentUtteranceId）', () => {
  const e = tts.createTtsEngine({})
  assert.equal(typeof e.speak, 'function')
  assert.equal(typeof e.stop, 'function')
  assert.equal(e.speaking, false)
  assert.equal(e.currentUtteranceId, null)
  assert.equal(e.stop(), false, '空闲时 stop 应返回 false')
})

test('引擎实例：空文本**同步**返回结构化失败（不 spawn 任何进程、不抛）', async () => {
  const states = []
  const e = tts.createTtsEngine({ onState: s => states.push(s) })
  const r = await e.speak('   ', 'empty-1')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'failed')
  assert.equal(r.error.code, 'EMPTY_TEXT')
  assert.equal(r.chunks, 0)
  assert.deepEqual(states.map(s => s.state), ['start', 'error'], '状态机应报 start → error')
})

test('引擎实例：超长文本同步失败（TEXT_TOO_LONG），且不悬挂', async () => {
  const e = tts.createTtsEngine({})
  const r = await e.speak('啊'.repeat(tts.TTS_MAX_TEXT_CHARS + 1), 'long-1')
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'TEXT_TOO_LONG')
})

test('引擎实例：取消发生在 spawn 之前时，speak 仍**必定 settle**（绝不悬挂）', async () => {
  const e = tts.createTtsEngine({})
  const p = e.speak('一些要朗读的文本。', 'race-1')
  // 立刻取消：此时引擎还在枚举声音，尚未 spawn
  const stopped = e.stop()
  assert.equal(stopped, true, '同步登记后 stop 必须能看到这次运行')
  const r = await Promise.race([
    p,
    new Promise(res => setTimeout(() => res({ timeout: true }), 5000)),
  ])
  assert.equal(r.timeout, undefined, 'speak promise 悬挂了（5s 未 settle）')
  assert.equal(r.ok, true)
  assert.equal(r.completed, false)
  assert.equal(r.reason, 'cancelled')
})

// 收尾：临时目录
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }) })
