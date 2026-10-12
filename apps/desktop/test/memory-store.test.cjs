/**
 * apps/desktop/test/memory-store.test.cjs —— 记忆层单测（分词 + 召回排序 + 容量）
 *
 * 为什么必须有单测：召回是**排序逻辑**——错了不会报错，只会让角色"记错事"
 * （把不相关的旧事塞进系统提示、或该记的记不住）。端到端几乎不可能发现，
 * 所以这里把 `tokenize()` 与 `recall()` 的可观察行为钉死。
 *
 * 隔离：`electron` 被最小打桩，`userData` 指向临时目录，绝不碰真实记忆文件。
 * 运行：`node --test apps/desktop/test/memory-store.test.cjs`
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'airimate-mem-'))

// 在加载业务模块之前打桩 electron —— paths.ts 会在首次调用时读 app.getPath('userData')
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

const mem = require('../dist/main/memory-store.js')

const STORE = path.join(TMP, 'memory.json')
const resetStore = () => { fs.rmSync(STORE, { force: true }); mem.__resetCacheForTest?.() }

// 每次测试前清空（不用 hooks，保持用例独立可单跑）
test.beforeEach(() => resetStore())

// ───────────────────────────────────────────────────────── 分词

test('中文无空格也能切出二元组', () => {
  assert.deepEqual(mem.tokenize('我喜欢吃拉面'), ['我喜', '喜欢', '欢吃', '吃拉', '拉面'])
})

test('中英混排：两种语言都进 token，中文部分不漏切', () => {
  const t = mem.tokenize('My favorite food 是拉面')
  assert.ok(t.includes('favorite'), `应含 latin 词，实际 ${JSON.stringify(t)}`)
  assert.ok(t.includes('food'), '应含 latin 词 food')
  assert.ok(t.includes('拉面'), '中文部分应切出二元组')
  assert.ok(t.includes('是拉'), '中文部分应切出二元组（跨字）')
})

test('停用词与单字母被过滤（避免"的/了/a"污染打分）', () => {
  const t = mem.tokenize('a 我 的 bb')
  assert.equal(t.includes('a'), false, '单字母应被过滤')
  assert.equal(t.includes('的'), false, '停用词应被过滤')
  assert.ok(t.includes('bb'))
})

test('纯符号/空白输入产出空 token 列表（不抛错）', () => {
  assert.deepEqual(mem.tokenize('   '), [])
  assert.deepEqual(mem.tokenize('!!!，。？'), [])
})

test('大小写不敏感', () => {
  assert.deepEqual(mem.tokenize('DeepSeek'), mem.tokenize('deepseek'))
})

// ───────────────────────────────────────────────────────── 写入 / 去重 / 容量

test('写入后可列出；相同文本不重复记录（去重）', () => {
  const a = mem.addMemory({ text: '用户最喜欢吃拉面', importance: 0.9 })
  const b = mem.addMemory({ text: '用户最喜欢吃拉面', importance: 0.9 })
  assert.equal(a.id, b.id, '同文本重复写入应返回同一条（去重）')
  const same = mem.listMemory(50).filter(e => e.text === '用户最喜欢吃拉面')
  assert.equal(same.length, 1, '同一文本只能有一条')
  assert.equal(mem.memoryCount(), 1)
})

test('去重时重要度取较大值（后写的高重要度不被丢弃）', () => {
  mem.addMemory({ text: '用户对花生过敏', importance: 0.2 })
  mem.addMemory({ text: '用户对花生过敏', importance: 1.0 })
  const e = mem.listMemory(9).find(x => x.text === '用户对花生过敏')
  assert.equal(e.importance, 1.0)
})

test('删除记忆：成功 true、重复删除 false', () => {
  const e = mem.addMemory({ text: '临时记忆待删除' })
  assert.equal(mem.deleteMemory(e.id), true)
  assert.equal(mem.deleteMemory(e.id), false, '重复删除应返回 false')
  assert.equal(mem.listMemory(99).some(x => x.id === e.id), false)
})

test('容量上限：不会无限增长', () => {
  for (let i = 0; i < 900; i++) mem.addMemory({ text: `批量记忆条目编号 ${i}`, importance: 0.5 })
  assert.ok(mem.memoryCount() <= 800, `上限应为 800，实际 ${mem.memoryCount()}`)
})

test('落盘：文件真实存在且 schema 可解析（重启不丢）', () => {
  mem.addMemory({ text: '这条必须落盘' })
  assert.ok(fs.existsSync(STORE), `记忆文件应存在：${STORE}`)
  const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.entries.length, 1)
  assert.equal(raw.entries[0].text, '这条必须落盘')
})

// ───────────────────────────────────────────────────────── 召回

test('召回：相关的排前面，无关的不返回', () => {
  mem.addMemory({ text: '用户养了一只叫豆豆的猫', importance: 0.6 })
  mem.addMemory({ text: '用户在做 AI 桌面宠物项目', importance: 0.6 })
  const hits = mem.recall('我的猫豆豆还好吗', 5)
  assert.ok(hits.length >= 1, '应召回至少一条')
  assert.ok(hits[0].entry.text.includes('猫'), `最相关应是猫那条，实际：${hits[0].entry.text}`)
  assert.equal(hits.some(h => h.entry.text.includes('桌面宠物')), false, '无关记忆不应被召回')
})

test('召回：重要度参与排序（同等相关度时高重要度在前）', () => {
  mem.addMemory({ text: '用户提到过蓝色杯子（随手一说）', importance: 0.1 })
  mem.addMemory({ text: '用户提到过蓝色杯子是他最喜欢的礼物', importance: 1.0 })
  const hits = mem.recall('蓝色杯子', 5)
  assert.ok(hits.length >= 2, `应召回两条，实际 ${hits.length}`)
  assert.ok(hits[0].entry.importance >= hits[1].entry.importance, '高重要度应排在前面')
})

test('召回为空查询返回空数组（不抛错、不打分）', () => {
  mem.addMemory({ text: '随便一条记忆' })
  assert.deepEqual(mem.recall('   ', 5), [])
  assert.deepEqual(mem.recall('的 了 是', 5), [])
})

test('召回结果按分数降序且分数已四舍五入', () => {
  mem.addMemory({ text: '用户喜欢抹茶拿铁', importance: 0.5 })
  mem.addMemory({ text: '用户喜欢抹茶', importance: 0.5 })
  mem.addMemory({ text: '用户喜欢拿铁', importance: 0.5 })
  const hits = mem.recall('抹茶拿铁', 5)
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score, '必须降序')
  for (const h of hits) assert.equal(h.score, Number(h.score.toFixed(4)), '分数应保留 4 位')
})

test('召回会回写 lastUsedAt / useCount（供后续权重使用）', () => {
  mem.addMemory({ text: '用户喜欢喝茉莉花茶' })
  assert.equal(mem.recall('茉莉花茶', 5).length, 1)
  const e = mem.listMemory(9).find(x => x.text === '用户喜欢喝茉莉花茶')
  assert.ok(e.lastUsedAt !== null, 'lastUsedAt 应被写入')
  assert.equal(e.useCount, 1)
})

test('limit 生效（最多返回 limit 条）', () => {
  for (let i = 0; i < 8; i++) mem.addMemory({ text: `关于星空的记忆第 ${i} 条`, importance: 0.5 })
  assert.equal(mem.recall('星空', 3).length, 3)
})

// ───────────────────────────────────────────────────────── 系统提示片段

test('recallAsSystemBlock：无命中返回 null（绝不塞空段落污染提示）', () => {
  mem.addMemory({ text: '用户喜欢喝茉莉花茶' })
  assert.equal(mem.recallAsSystemBlock('完全不相关的词汇 zzqqxx', 5), null)
})

test('recallAsSystemBlock：有命中时返回可注入文本，且受 maxChars 限制', () => {
  mem.addMemory({ text: '用户喜欢喝茉莉花茶', importance: 0.8 })
  const b = mem.recallAsSystemBlock('茉莉花茶', 5)
  assert.ok(typeof b === 'string' && b.includes('茉莉花茶'), `实际：${b}`)

  for (let i = 0; i < 40; i++) mem.addMemory({ text: `很长的星空记忆条目${i}${'填'.repeat(60)}`, importance: 0.5 })
  const long = mem.recallAsSystemBlock('星空', 5, 200)
  assert.ok(long.length <= 201, `应被截断到 ~200 字符，实际 ${long.length}`)
})

// ───────────────────────────────────────────────────────── 损坏恢复

test('记忆文件损坏 → 以空记忆启动，不抛错（原文件行为不阻塞启动）', () => {
  fs.writeFileSync(STORE, '{ this is not json', 'utf8')
  mem.__resetCacheForTest?.()
  assert.equal(mem.memoryCount(), 0, '损坏文件应降级为空记忆')
  mem.addMemory({ text: '恢复后仍可写入' })
  assert.equal(mem.memoryCount(), 1)
})
