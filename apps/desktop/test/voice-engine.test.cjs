/**
 * apps/desktop/test/voice-engine.test.cjs —— 语音识别/唤醒的**纯逻辑**单测（M3 §1/§2）
 *
 * 这里只测**不依赖麦克风与 PowerShell**的部分：唤醒词剥离、状态投影、配置校验、
 * 一键停用的幂等性。识别本身要真麦克风，属集成探针的职责（见 `--probe m3`）。
 *
 * 为什么唤醒词剥离值得单测：它是"用户说了什么"与"要发给模型什么"的分界。
 * 剥错了两头都糟 —— 多剥一个字会让用户的话少一截，少剥会把控制指令发进对话。
 * 识别的标点/空格不可控，所以这里必须对"带标点""夹在中间""只说唤醒词"逐个覆盖。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { tmpdir, stubElectron } = require('./helpers/harness.cjs')

const TMP = tmpdir('voice')
stubElectron(TMP)

const voice = require('../dist/main/voice-engine.js')

// ───────────────────────────────────────────────────────── 唤醒词剥离

test('★ 剥掉句首唤醒词（最常见的形态）', () => {
  const r = voice.stripWakeWord('你好助手今天天气怎么样', '你好助手')
  assert.equal(r.isWake, true)
  assert.equal(r.text, '今天天气怎么样')
})

test('★ 识别插入的标点/空格不影响剥离', () => {
  for (const raw of [
    '你好助手，今天天气怎么样',
    '你好助手, 今天天气怎么样',
    '你好 助手 今天天气怎么样',
    '你好助手。今天天气怎么样',
    '你好助手！今天天气怎么样',
  ]) {
    const r = voice.stripWakeWord(raw, '你好助手')
    assert.equal(r.isWake, true, `未识别出唤醒词：${raw}`)
    assert.equal(r.text, '今天天气怎么样', `剥离结果不对：${raw} → ${r.text}`)
  }
})

test('唤醒词夹在中间也能剥掉', () => {
  const r = voice.stripWakeWord('那个你好助手帮我看看', '你好助手')
  assert.equal(r.isWake, true)
  assert.equal(r.text, '那个帮我看看')
})

test('★ 只说唤醒词 ⇒ 文本为空但 isWake 为 true（要能区分"叫我了但没说话"）', () => {
  const r = voice.stripWakeWord('你好助手', '你好助手')
  assert.equal(r.isWake, true)
  assert.equal(r.text, '')
})

test('没命中唤醒词 ⇒ 原样返回（不能误伤正常对话）', () => {
  const r = voice.stripWakeWord('今天天气怎么样', '你好助手')
  assert.equal(r.isWake, false)
  assert.equal(r.text, '今天天气怎么样')
})

test('★ 未启用唤醒词时**完全不剥**（启用前后行为必须可区分）', () => {
  const r = voice.stripWakeWord('你好助手今天天气', null)
  assert.equal(r.isWake, false)
  assert.equal(r.text, '你好助手今天天气')
  const r2 = voice.stripWakeWord('你好助手今天天气', '')
  assert.equal(r2.isWake, false)
})

test('唤醒词比文本长 / 部分匹配不误判', () => {
  assert.equal(voice.stripWakeWord('你好', '你好助手').isWake, false, '部分匹配不该算命中')
  assert.equal(voice.stripWakeWord('', '你好助手').isWake, false)
})

test('★ 自定义唤醒词（英文/带数字）也能剥', () => {
  const a = voice.stripWakeWord('hey airi what is the time', 'hey airi')
  assert.equal(a.isWake, true)
  assert.equal(a.text, 'what is the time')
  const b = voice.stripWakeWord('小爱2号放首歌', '小爱2号')
  assert.equal(b.isWake, true)
  assert.equal(b.text, '放首歌')
})

// ───────────────────────────────────────────────────────── 状态与配置

test('★★ 默认状态：唤醒**关闭**、麦克风**未占用**、不可用（未检测）——"默认关闭"是硬要求', () => {
  const s = voice.voiceStatus()
  assert.equal(s.wakeWordEnabled, false)
  assert.equal(s.micActive, false)
  assert.equal(s.state, 'idle')
  assert.equal(s.utteranceCount, 0)
})

test('配置：唤醒词可设置，且**长度被限制**（太短会误触发）', () => {
  const s = voice.setVoiceConfig({ wakeWordEnabled: true, wakeWord: '  你好小助手  ' })
  assert.equal(s.wakeWordEnabled, true)
  assert.equal(s.wakeWord, '你好小助手', '首尾空白应被去掉')
  const long = voice.setVoiceConfig({ wakeWord: 'x'.repeat(50) })
  assert.equal(long.wakeWord.length, 20, '超长唤醒词应被截断到 20 字')
  // 复位（避免影响后续用例与真实使用）
  voice.setVoiceConfig({ wakeWordEnabled: false, wakeWord: '你好助手' })
})

test('★ 一键停用是幂等的，并且**必定释放麦克风状态**', () => {
  voice.setVoiceConfig({ wakeWordEnabled: true })
  // 没有真正开监听时调 stop 应返回 false（没东西可停），但状态必须被复位
  const had = voice.stopVoice('user')
  assert.equal(had, false, '没有在飞进程时应返回 false')
  const s = voice.voiceStatus()
  assert.equal(s.micActive, false)
  assert.equal(s.state, 'stopped')
  // 再来一次仍然安全
  assert.equal(voice.stopVoice('user'), false)
})

test('未检测时 listenOnce **如实失败**（不假装在听）', async () => {
  const r = await voice.listenOnce({ timeoutMs: 1000 })
  assert.equal(r.ok, false)
  assert.equal(r.text, '')
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, '必须给出原因')
})

test('VoiceConfigSchema 只接受两个字段且唤醒词有长度上限', () => {
  assert.equal(voice.VoiceConfigSchema.safeParse({ wakeWordEnabled: true }).success, true)
  assert.equal(voice.VoiceConfigSchema.safeParse({ wakeWord: 'x'.repeat(20) }).success, true)
  assert.equal(voice.VoiceConfigSchema.safeParse({ wakeWord: 'x'.repeat(21) }).success, false)
  assert.equal(voice.VoiceConfigSchema.safeParse({ wakeWordEnabled: 'yes' }).success, false)
})

test('状态投影里**没有识别正文**（只有长度与计数）', () => {
  const s = voice.voiceStatus()
  const keys = Object.keys(s).sort()
  assert.deepEqual(keys, [
    'available', 'lastError', 'lastTextAt', 'lastTextChars', 'lastWakeAt',
    'micActive', 'recognizerCount', 'state', 'unavailableReason',
    'utteranceCount', 'wakeWord', 'wakeWordEnabled',
  ].sort())
  assert.equal('text' in s, false, '状态里绝不能有识别正文')
})

test('disposeVoice 幂等（退出路径不允许抛）', () => {
  assert.doesNotThrow(() => voice.disposeVoice())
  assert.doesNotThrow(() => voice.disposeVoice())
})

test('PowerShell 脚本是常量且**不含任何用户文本**（正文只走 stdin）', () => {
  // 脚本里出现用户数据就意味着"命令行可能带出内容"，这是明令禁止的
  for (const script of [voice.PS_VOICE_PROBE_SCRIPT, voice.PS_LISTEN_ONCE_SCRIPT, voice.PS_VOICE_LISTEN_SCRIPT]) {
    assert.equal(typeof script, 'string')
    assert.ok(script.length > 50)
    assert.equal(script.includes('{{'), false, '不该有未替换的模板占位符')
  }
  // 探测脚本**不得**打开麦克风（只读枚举识别器）
  assert.equal(/SetInputToDefaultAudioDevice/.test(voice.PS_VOICE_PROBE_SCRIPT), false, '检测不该占用麦克风')
})
