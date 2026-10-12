<script setup lang="ts">
/**
 * MemoryPanel.vue —— 长期记忆管理（App.vue 的「记忆」tab）
 *
 * 为什么要有「召回预览」这个盒子：记忆层如果只是个黑盒，用户无法判断该记什么、该删什么。
 * 所以这里**同时**给出"命中了哪几条"和"实际会被注入系统提示的那段文本"
 * （`injectedBlock` 来自主进程，renderer 不自己拼装）。
 *
 * 纪律：
 *   · 数据真源只有一个 —— `app.memoryHits`（store 的 `searchMemory` 写入）；
 *     `bridge.listMemory()` **只在首次进入时**用来填充浏览视图，之后一律走检索，
 *     避免出现"两份列表不一致"这种没人能解释的状态。
 *   · 删除/导出/清空都会显式确认或显式回报结果，不做静默动作。
 */
import { computed, onMounted, ref } from 'vue'
import type { MemoryRecallHit } from '@airimate/shared'
import { useApp } from '../store'
import { bridge } from '../bridge'

const app = useApp()

const q = ref('')
const minImportance = ref(0)
const tagFilter = ref('')

const addForm = ref({ text: '', tags: '', importance: 0.6 })
const adding = ref(false)

const editingId = ref('')
const editDraft = ref({ text: '', tags: '', importance: 0.5 })
const confirmDeleteId = ref('')

const recallSentence = ref('')
const recalling = ref(false)

const exportInfo = ref<{ file: string, bytes: number, sections: string[], excluded: string[] } | null>(null)
const exporting = ref(false)

const hits = computed<MemoryRecallHit[]>(() => app.memoryHits)

/**
 * ★ 对话历史（本轮从侧边栏「聊天」页**迁移**过来）。
 *
 * 为什么迁到这里、而且**默认折叠**（规格 §五）：
 *   · 主界面改成"桌宠对话框 + 语音说话"后，不再回放滚动的对话文字记录；
 *   · 但数据层一条都不删（session-store / 记忆照常写入），用户仍然**有权查看**自己的历史 ——
 *     把入口藏起来等于删功能，所以收在记忆页里，且必须手动展开才加载、才显示正文。
 * `chatLoaded` 为假时才拉一次：`init()` 已经拉过，重复拉取没有任何意义。
 */
const historyOpen = ref(false)
const confirmClearHistory = ref(false)

function toggleHistory(): void {
  historyOpen.value = !historyOpen.value
  if (historyOpen.value && !app.chatLoaded) void app.loadChat()
}

/** 清空历史：保持原 ChatPanel 的**两步确认**语义（不可逆动作不许一步完成，也不用原生 confirm） */
async function doClearHistory(): Promise<void> {
  confirmClearHistory.value = false
  await app.clearChat()
}

const historyCount = computed(() => app.chat.length)

/** 逗号分隔 → 去空去重（主进程限制 16 个标签、每个 32 字符） */
function parseTags(s: string): string[] {
  return [...new Set(s.split(/[,，]/).map(x => x.trim()).filter(Boolean))].slice(0, 16)
}

function tagsToText(tags: string[]): string {
  return tags.join('、')
}

function runSearch(): void {
  void app.searchMemory(q.value, {
    minImportance: minImportance.value,
    tag: tagFilter.value.trim() || null,
  })
}

/** 主进程明确回报"一条记忆都没有"时才显示空提示（读失败不算空 —— 失败必须可见，不能被当成空） */
const memoryEmpty = ref(false)

onMounted(async () => {
  /**
   * 首次进入给一个"浏览视图"（空查询 = 按重要度与时间浏览，且**不写使用统计**）。
   *
   * ⚠ 这里额外调 `bridge.listMemory()` 只为判断"要不要提示她还没有任何记忆"，
   *   **不**把结果灌进 `app.memoryHits` —— 否则同一个列表会有两份真源，
   *   用户会看到"检索结果"和"列表"对不上，而这种状态没人能解释。
   */
  if (hits.value.length === 0) runSearch()
  try {
    const r = await bridge.listMemory()
    if ((r.entries ?? []).length === 0) memoryEmpty.value = true
  } catch (e) {
    // 读失败**不**设 memoryEmpty：失败不是"空"，静默当成空就是伪造状态
    app.reportFailure('读取记忆条数失败', e)
  }
})

async function add(): Promise<void> {
  const text = addForm.value.text.trim()
  if (!text) {
    app.toast('warn', '记忆内容不能为空', undefined, false)
    return
  }
  adding.value = true
  try {
    // 只有主进程真的存上了才清空表单（失败时保留用户输入，不伪造成功）
    const ok = await app.addMemory(text, parseTags(addForm.value.tags), addForm.value.importance)
    if (ok) addForm.value = { text: '', tags: '', importance: 0.6 }
  } finally {
    adding.value = false
  }
}

function startEdit(h: MemoryRecallHit): void {
  editingId.value = h.entry.id
  editDraft.value = { text: h.entry.text, tags: tagsToText(h.entry.tags), importance: h.entry.importance }
}

async function saveEdit(id: string): Promise<void> {
  if (!editDraft.value.text.trim()) {
    app.toast('warn', '记忆内容不能为空', undefined, false)
    return
  }
  await app.updateMemory({
    id,
    text: editDraft.value.text.trim(),
    tags: parseTags(editDraft.value.tags),
    importance: editDraft.value.importance,
  })
  editingId.value = ''
}

async function remove(id: string): Promise<void> {
  confirmDeleteId.value = ''
  await app.deleteMemory(id)
}

async function preview(): Promise<void> {
  const s = recallSentence.value.trim()
  if (!s) {
    app.toast('warn', '先写一句话', '例如：明天要早起开会', false)
    return
  }
  recalling.value = true
  try {
    await app.previewRecall(s)
  } finally {
    recalling.value = false
  }
}

async function exportMemory(): Promise<void> {
  exporting.value = true
  try {
    const r = await bridge.privacyExport({ format: 'json', includeChats: false, includeMemory: true })
    exportInfo.value = {
      file: String(r.file ?? ''),
      bytes: Number(r.bytes ?? 0),
      sections: r.sections ?? [],
      excluded: r.excluded ?? [],
    }
  } catch (e) {
    app.reportFailure('导出记忆失败', e)
  } finally {
    exporting.value = false
  }
}

function fmtTime(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}
</script>

<template>
  <div class="memory">
    <!-- 检索 -->
    <section class="card">
      <h3>检索记忆</h3>
      <label class="row"><span>关键词</span><input v-model="q" type="text" placeholder="留空 = 按重要度与时间浏览" @keydown.enter="runSearch()" /></label>
      <label class="row">
        <span>重要度下限</span>
        <input v-model.number="minImportance" type="range" min="0" max="1" step="0.05" />
        <b>{{ minImportance.toFixed(2) }}</b>
      </label>
      <label class="row"><span>标签</span><input v-model="tagFilter" type="text" placeholder="单个标签，如 工作" @keydown.enter="runSearch()" /></label>
      <div class="row">
        <span class="muted">命中 {{ hits.length }} 条</span>
        <span class="mem__actions">
          <button class="tbtn tbtn--mini" @click="runSearch()">检索</button>
          <button class="tbtn tbtn--mini" :disabled="exporting" @click="exportMemory()">导出记忆</button>
        </span>
      </div>
      <p v-if="memoryEmpty" class="muted">本机还没有任何记忆条目。</p>
    </section>

    <!--
      ★ 对话历史（本轮从「聊天」页迁移过来；**默认折叠**）。
      纪律：这里只是"查看与清理"的入口，主界面不再回放这些文字（规格 §五）。
      展开才加载、才显示正文 —— 默认折叠是为了让"记忆页"的主职责（长期记忆）不被流水淹没。
    -->
    <section class="card">
      <h3>对话历史（默认折叠）</h3>
      <div class="row">
        <span class="muted">
          对话仍照常写入本机会话与记忆，只是主界面不再逐条回放。
        </span>
        <span class="mem__actions">
          <button class="tbtn tbtn--mini" @click="toggleHistory()">
            {{ historyOpen ? '收起' : `展开（${historyCount} 条）` }}
          </button>
          <template v-if="!confirmClearHistory">
            <button
              class="tbtn tbtn--mini"
              :disabled="historyCount === 0"
              @click="confirmClearHistory = true"
            >清空历史</button>
          </template>
          <template v-else>
            <span class="muted warn">确认清空？不可撤销</span>
            <button class="tbtn tbtn--mini tbtn--danger" @click="doClearHistory()">确认清空</button>
            <button class="tbtn tbtn--mini" @click="confirmClearHistory = false">取消</button>
          </template>
        </span>
      </div>
      <template v-if="historyOpen">
        <div v-if="historyCount === 0" class="muted">还没有对话记录。</div>
        <div v-for="m in app.chat" :key="m.id" class="mem__row">
          <div class="mem__text">{{ m.text }}</div>
          <div class="mem__meta muted">
            <span>{{ m.role === 'user' ? '我' : '她' }}</span>
            <span v-if="m.origin && m.origin !== 'user'">· {{ m.origin }}</span>
            <span>· {{ fmtTime(m.createdAt) }}</span>
          </div>
        </div>
      </template>
    </section>

    <!-- 新增 -->
    <section class="card">
      <h3>让她记住一件事</h3>
      <label class="row"><span>内容</span><textarea v-model="addForm.text" rows="2" placeholder="例：我周六上午要去体检" /></label>
      <label class="row"><span>标签（逗号分隔）</span><input v-model="addForm.tags" type="text" placeholder="健康, 日程" /></label>
      <label class="row">
        <span>重要度</span>
        <input v-model.number="addForm.importance" type="range" min="0" max="1" step="0.05" />
        <b>{{ addForm.importance.toFixed(2) }}</b>
      </label>
      <button class="tbtn tbtn--primary" :disabled="adding || !addForm.text.trim()" @click="add()">记住</button>
      <p class="muted">记忆只存本机；日志与诊断包里对正文一律脱敏。</p>
    </section>

    <!-- 列表 -->
    <section class="card">
      <h3>条目</h3>
      <div v-if="hits.length === 0" class="muted">没有命中的记忆条目。</div>
      <div v-for="h in hits" :key="h.entry.id" class="mem__row">
        <template v-if="editingId === h.entry.id">
          <label class="row"><span>内容</span><textarea v-model="editDraft.text" rows="2" /></label>
          <label class="row"><span>标签</span><input v-model="editDraft.tags" type="text" /></label>
          <label class="row">
            <span>重要度</span>
            <input v-model.number="editDraft.importance" type="range" min="0" max="1" step="0.05" />
            <b>{{ editDraft.importance.toFixed(2) }}</b>
          </label>
          <div class="row">
            <span />
            <span class="mem__actions">
              <button class="tbtn tbtn--mini tbtn--primary" @click="saveEdit(h.entry.id)">保存</button>
              <button class="tbtn tbtn--mini" @click="editingId = ''">取消</button>
            </span>
          </div>
        </template>
        <template v-else>
          <div class="mem__text">{{ h.entry.text }}</div>
          <div class="mem__meta muted">
            <span class="badge">重要度 {{ h.entry.importance.toFixed(2) }}</span>
            <span class="badge">打分 {{ h.score.toFixed(2) }}</span>
            <span v-for="t in h.entry.tags" :key="t" class="badge">{{ t }}</span>
            <span>建立 {{ fmtTime(h.entry.createdAt) }}</span>
            <span>被用过 {{ h.entry.useCount }} 次（上次 {{ fmtTime(h.entry.lastUsedAt) }}）</span>
          </div>
          <div class="row">
            <span />
            <span class="mem__actions">
              <button class="tbtn tbtn--mini" @click="startEdit(h)">编辑</button>
              <template v-if="confirmDeleteId === h.entry.id">
                <span class="muted warn">确认删除？</span>
                <button class="tbtn tbtn--mini tbtn--danger" @click="remove(h.entry.id)">删除</button>
                <button class="tbtn tbtn--mini" @click="confirmDeleteId = ''">取消</button>
              </template>
              <button v-else class="tbtn tbtn--mini tbtn--danger" @click="confirmDeleteId = h.entry.id">删除</button>
            </span>
          </div>
        </template>
      </div>
    </section>

    <!-- 召回预览 -->
    <section class="card">
      <h3>召回预览 · 这句话会让她想起什么</h3>
      <label class="row">
        <span>输入一句话</span>
        <input v-model="recallSentence" type="text" placeholder="例：明天要早起" @keydown.enter="preview()" />
      </label>
      <button class="tbtn" :disabled="recalling" @click="preview()">{{ recalling ? '计算中…' : '预览召回' }}</button>
      <div v-if="app.recallPreview" class="recall">
        <div class="muted">查询：{{ app.recallPreview.query }} · 命中 {{ app.recallPreview.hits.length }} 条 · 注入 {{ app.recallPreview.injectedChars }} 字</div>
        <div v-for="h in app.recallPreview.hits" :key="h.entry.id" class="recall__hit">
          <span class="badge">打分 {{ h.score.toFixed(2) }}</span>
          <span class="badge">重要度 {{ h.entry.importance.toFixed(2) }}</span>
          <span>{{ h.entry.text }}</span>
        </div>
        <b>实际注入的系统提示片段</b>
        <pre v-if="app.recallPreview.injectedBlock">{{ app.recallPreview.injectedBlock }}</pre>
        <p v-else class="muted">无命中 ⇒ 不会注入任何记忆段落（模型不会看到任何"记忆"内容）。</p>
      </div>
    </section>

    <!-- 导出结果 -->
    <section v-if="exportInfo" class="card">
      <h3>导出结果</h3>
      <div class="row"><span>文件</span><b>{{ exportInfo.file }}</b></div>
      <div class="row"><span>大小</span><b>{{ exportInfo.bytes }} 字节</b></div>
      <div class="muted">包含：{{ exportInfo.sections.join('、') || '（无）' }}</div>
      <div class="muted">已剔除 / 占位：{{ exportInfo.excluded.join('、') || '（无）' }}</div>
    </section>
  </div>
</template>
