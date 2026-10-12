/**
 * apps/desktop/test/act-parser.test.cjs —— 动作标记解析器的单元测试
 *
 * 为什么必须有单测：这是**唯一解析点**（PRD §6 禁止双驱动）。
 * 它一旦解析错，要么用户看到 `[motion:wave]` 这种脏文本，要么角色做错动作，
 * 而这两类问题都很难在端到端里定位。
 *
 * 运行：`node --test apps/desktop/test/act-parser.test.cjs`
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseReply } = require('../dist/main/act-parser.js')

test('解析 [motion:wave] 并把它从展示文本里删掉', () => {
  const r = parseReply('你好呀 [motion:wave] 今天过得怎么样？')
  assert.equal(r.displayText, '你好呀  今天过得怎么样？')
  assert.equal(r.commands.length, 1)
  assert.deepEqual(r.commands[0], {
    type: 'motion', motion: 'wave', layer: 'base', once: false, interrupt: true, origin: 'llm',
  })
  assert.deepEqual(r.unknown, [])
})

test('`once` 后缀 = 一次性动作', () => {
  const r = parseReply('[motion:dance once] 一起跳舞吧')
  assert.equal(r.commands.length, 1)
  assert.equal(r.commands[0].motion, 'dance')
  assert.equal(r.commands[0].once, true)
})

test('解析 [emotion:happy 0.8]：强度被采用', () => {
  const r = parseReply('太好了！[emotion:happy 0.8]')
  assert.equal(r.displayText, '太好了！')
  assert.equal(r.commands.length, 1)
  assert.equal(r.commands[0].type, 'emotion')
  assert.equal(r.commands[0].emotion, 'happy')
  assert.equal(r.commands[0].intensity, 0.8)
})

test('表情省略强度时默认 0.8', () => {
  const r = parseReply('[emotion:sad]嗯…')
  assert.equal(r.commands[0].intensity, 0.8)
})

test('强度越界被夹到 [0,1]', () => {
  assert.equal(parseReply('[emotion:angry 5]').commands[0].intensity, 1)
  assert.equal(parseReply('[emotion:angry -3]').commands[0].intensity, 0)
})

test('简写 [[wave]] 与 ((happy)) 都支持', () => {
  const a = parseReply('嗨 [[wave]]')
  assert.equal(a.commands[0].motion, 'wave')
  const b = parseReply('开心 ((happy))')
  assert.equal(b.commands[0].emotion, 'happy')
  assert.equal(b.displayText, '开心')
})

test('未知标记被**丢弃并报告**（不猜、不透传）', () => {
  const r = parseReply('测试 [motion:fly] 和 [emotion:confused] 和 [[teleport]]')
  assert.equal(r.commands.length, 0)
  assert.deepEqual(r.unknown.sort(), ['emotion:confused', 'motion:fly', 'short:teleport'])
  // 标记必须从展示文本里彻底消失，不能把方括号内容漏给用户
  assert.equal(r.displayText.includes('['), false)
  assert.equal(r.displayText.includes('('), false)
})

test('一句话里多个标记按出现顺序产出命令', () => {
  const r = parseReply('[emotion:happy] 好耶 [motion:wave] 再见 [motion:sit]')
  assert.deepEqual(r.commands.map(c => c.type), ['emotion', 'motion', 'motion'])
  assert.deepEqual(r.commands.filter(c => c.type === 'motion').map(c => c.motion), ['wave', 'sit'])
})

test('纯文本回复不被改动（除首尾空白）', () => {
  const r = parseReply('这是一段没有任何标记的普通回复。\n第二行也保留。')
  assert.equal(r.displayText, '这是一段没有任何标记的普通回复。\n第二行也保留。')
  assert.equal(r.commands.length, 0)
})

test('大小写不敏感', () => {
  const r = parseReply('[MOTION:Wave] [EMOTION:HAPPY]')
  assert.equal(r.commands[0].motion, 'wave')
  assert.equal(r.commands[1].emotion, 'happy')
})

test('正则状态不跨调用泄漏（连续两次解析结果一致）', () => {
  const a = parseReply('[motion:wave] 一')
  const b = parseReply('[motion:wave] 一')
  assert.deepEqual(a.commands, b.commands)
  assert.equal(a.displayText, b.displayText)
})
