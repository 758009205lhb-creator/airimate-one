<script setup lang="ts">
/**
 * SettingsPanel.vue —— 设置面板
 *
 * 已可用：窗口模式、置顶、开机自启（含旧启动项迁移）、动作清单状态、
 *        **语音合成（开关 + 声音选择 + 停止朗读）**、诊断导出触发、
 *        **供应商配置（增删改 + 测试连接 + 设为生效）**、**人设编辑器**、
 *        **主动陪伴开关与实时读数**、**隐私摘要 / 导出 / 彻底清除**。
 *
 * 纪律（与需求一致，改动时别破）：
 *   · 密钥只**单向**进入主进程；界面永远只读 `hasKey` / `keyFingerprint` / `keyLength`；
 *     编辑时密钥框留空 = 保持原密钥，清空密钥要显式勾选后提交**空串**。
 *   · 不伪造成功：一切结果来自 store / bridge 的真实回执，失败走 toast 且不改界面状态。
 */
import { computed, ref, onMounted } from 'vue'
import { manifestClipId, manifestSemantic, PERMISSION_TIER_FLOOR } from '@airimate/shared'
import type { ProviderKind, RadioContent } from '@airimate/shared'
import { useApp } from '../store'
import { bridge } from '../bridge'

const app = useApp()
const busy = ref(false)
const diag = ref<string>('')

/**
 * ⚠ 必须用 shared 的 `manifestSemantic()` / `manifestClipId()` 取字段。
 * 早期这里直接读 `m.semantic` / `m.id`，但 sidecar 的实际字段是 `set` / `name`
 * ⇒ 类型报错，且运行时恒为 0（"待机动作 0/10"看着像资产缺失，其实是取错字段）。
 */
const idleCount = computed(() => app.motion.manifests
  .filter(m => /idle/i.test(manifestSemantic(m)) || /idle/i.test(manifestClipId(m))).length)
const motionOk = computed(() => idleCount.value >= 10)

/** 打开设置面板时懒加载声音清单（只读枚举 SAPI，不解锁音频设备） */
onMounted(() => { void app.loadTtsVoices() })

/** 打开朗读时顺手把声音清单补上（用户可能一上来就勾选） */
async function toggleTts(on: boolean): Promise<void> {
  await app.patch({ ttsEnabled: on })
  if (on && app.ttsVoices === null) await app.loadTtsVoices()
}

/** 空串 = 自动（中文优先）；主进程侧 `ttsVoice: null` */
async function pickVoice(id: string): Promise<void> {
  await app.patch({ ttsVoice: id === '' ? null : id })
}

async function refreshDiag(): Promise<void> {
  busy.value = true
  try {
    const d = await bridge.diagnostics()
    diag.value = JSON.stringify(d, null, 2)
  } catch (e) {
    app.reportFailure('读取诊断失败', e)
  } finally {
    busy.value = false
  }
}

/* ═══════════════════════════════════════════ 供应商配置 */

const KIND_OPTIONS: Array<{ value: ProviderKind, label: string }> = [
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic-compatible', label: 'Anthropic 兼容' },
  { value: 'ollama', label: '本机 Ollama' },
  { value: 'custom', label: '自定义' },
]

const editingId = ref<string>('')
const pForm = ref<{ label: string, kind: ProviderKind, baseUrl: string, model: string, apiKey: string }>({
  label: '', kind: 'openai-compatible', baseUrl: '', model: '', apiKey: '',
})
/** 显式"清除密钥"：不能靠"把框清空"来表达 —— 留空在语义上是**保留**原密钥 */
const clearKey = ref(false)
const testing = ref('')
const testResults = ref<Record<string, { ok: boolean, code: string, message: string, latencyMs: number | null, modelCount: number | null }>>({})

function kindLabel(k: string): string {
  return KIND_OPTIONS.find(o => o.value === k)?.label ?? k
}

/** 编辑：预填**除密钥外**的一切（密钥拿不回来，只能留空表示不改） */
function startEdit(id: string): void {
  const p = app.providers.find(x => x.id === id)
  if (!p) return
  editingId.value = id
  pForm.value = { label: p.label, kind: p.kind, baseUrl: p.baseUrl, model: p.model, apiKey: '' }
  clearKey.value = false
}

function resetForm(): void {
  editingId.value = ''
  pForm.value = { label: '', kind: 'openai-compatible', baseUrl: '', model: '', apiKey: '' }
  clearKey.value = false
}

async function submitProvider(): Promise<void> {
  if (!pForm.value.label.trim() || !pForm.value.model.trim() || !pForm.value.baseUrl.trim()) {
    app.toast('warn', '标签 / baseUrl / 模型都要填', undefined, false)
    return
  }
  const payload: { id?: string, label: string, kind: string, baseUrl: string, model: string, apiKey?: string } = {
    label: pForm.value.label.trim(),
    kind: pForm.value.kind,
    baseUrl: pForm.value.baseUrl.trim(),
    model: pForm.value.model.trim(),
  }
  if (editingId.value) payload.id = editingId.value
  /**
   * 三条互斥语义，顺序不能乱：
   *   · 勾了"清除密钥" ⇒ 传**空串**（主进程据此删除密钥）；
   *   · 输了新密钥     ⇒ 传新明文（一次性）；
   *   · 都没做         ⇒ **省略 apiKey 字段**（= 保留原密钥）。
   */
  if (clearKey.value) payload.apiKey = ''
  else if (pForm.value.apiKey.trim()) payload.apiKey = pForm.value.apiKey.trim()
  const ok = await app.upsertProvider(payload)
  if (ok) resetForm()
}

async function runTest(id: string): Promise<void> {
  testing.value = id
  try {
    const r = await app.testProvider(id)
    if (r) testResults.value = { ...testResults.value, [id]: r }
  } finally {
    testing.value = ''
  }
}

/* ═══════════════════════════════════════════ 人设 */

const personaDraft = ref({
  name: '', userTitle: '', systemPrompt: '', personality: '', speakingStyle: '', greeting: '',
  expressiveness: 0.6, gestureFrequency: 0.5, idleChatter: false,
})

function hydratePersona(): void {
  const p = app.persona
  if (!p) return
  personaDraft.value = {
    name: p.name, userTitle: p.userTitle, systemPrompt: p.systemPrompt, personality: p.personality,
    speakingStyle: p.speakingStyle, greeting: p.greeting,
    expressiveness: p.performance.expressiveness,
    gestureFrequency: p.performance.gestureFrequency,
    idleChatter: p.performance.idleChatter,
  }
}

async function savePersona(): Promise<void> {
  const patch = {
    name: personaDraft.value.name.trim(),
    userTitle: personaDraft.value.userTitle.trim(),
    systemPrompt: personaDraft.value.systemPrompt,
    personality: personaDraft.value.personality,
    speakingStyle: personaDraft.value.speakingStyle,
    greeting: personaDraft.value.greeting,
    performance: {
      expressiveness: personaDraft.value.expressiveness,
      gestureFrequency: personaDraft.value.gestureFrequency,
      idleChatter: personaDraft.value.idleChatter,
    },
  }
  await app.savePersona(patch)
  // 主进程校验失败时会**保留默认值**（不改 persona）；回填一次让界面与真实值一致
  hydratePersona()
}

/* ═══════════════════════════════════════════ 主动陪伴（M2） */

/** 开关项：key 必须是 `SettingsPatch` 里真实存在的字段（写错会在 zod 那里被静默丢掉） */
const PROACTIVE_TOGGLES: Array<{ key: 'proactiveEnabled' | 'greetingEnabled' | 'scheduleBriefEnabled' | 'morningRadioEnabled' | 'morningRadioSpeak' | 'continuousReminderEnabled' | 'sedentaryReminderEnabled' | 'nightReminderEnabled' | 'userSilent' | 'activitySamplingEnabled', label: string, note: string }> = [
  { key: 'proactiveEnabled', label: '主动陪伴总开关', note: '关掉后引擎不再主动说话（提醒仍会按设定触发）' },
  { key: 'greetingEnabled', label: '开机问候', note: '网络与供应商就绪后的一次问候' },
  { key: 'scheduleBriefEnabled', label: '日程播报', note: '当天有日程时提醒你' },
  { key: 'morningRadioEnabled', label: '早安电台', note: '每天一次：天气 / 日程 / 资讯 / 建议' },
  { key: 'morningRadioSpeak', label: '电台朗读', note: '静音时段由引擎拦下，不会强行发声' },
  { key: 'continuousReminderEnabled', label: '连续使用提醒', note: '阈值见主进程的 reminder policy' },
  { key: 'sedentaryReminderEnabled', label: '久坐提醒', note: '按活动量判定，只统计计数不记内容' },
  { key: 'nightReminderEnabled', label: '夜间休息提醒', note: '到点提醒你收工' },
  { key: 'userSilent', label: '静默模式', note: '手动"别烦我"：一切主动行为降级为进队列' },
  { key: 'activitySamplingEnabled', label: '活动采样', note: '只读空闲毫秒与事件**计数**；不记按键内容' },
]

const radioOpen = ref(false)
const radio = computed<RadioContent | null>(() => app.radio)

/** 阻断原因 → 人话。**只有这里做翻译**，界面上不出现英文原因码（除非用户点开诊断） */
const BLOCK_TEXT: Record<string, string> = {
  none: '未阻断',
  'quiet-hours': '静音时段',
  fullscreen: '全屏应用 / 演示中',
  game: '检测到游戏',
  meeting: '会议中（摄像头/麦克风被占用）',
  focus: '系统专注助手 / 免打扰',
  'user-silent': '你手动开了静默模式',
  disabled: '该能力开关已关闭',
  cooldown: '冷却中（防重复轰炸）',
}
function blockText(r: string | null | undefined): string {
  if (!r) return '未知'
  return BLOCK_TEXT[r] ?? r
}

/**
 * `HH:MM` 的时间框改动。
 *
 * ⚠ 必须挡一次"空值 / 半截值"：`<input type="time">` 在用户清空时会给出空串，
 *   而 `SettingsPatchSchema.morningRadioAt` 是**正则钉死**的 —— 直接透传会得到一个
 *   主进程的校验失败 toast。用一个"用户只是清空了输入框"的操作换来一条红色报错，
 *   只会让人以为软件坏了。所以非法值一律忽略并如实提示，不改任何设置。
 */
function patchTime(key: 'morningRadioAt', value: string): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    app.toast('warn', '时间格式无效，未保存', '需要 HH:MM（00:00–23:59）', false)
    return
  }
  void app.patch({ [key]: value })
}

/** 首屏把活动 / 引擎状态拉一次（只读，不改任何设置） */
onMounted(() => {
  hydratePersona()
  void app.loadActivity()
  void app.loadProactiveStatus()
  void app.loadInbox()
})

async function refreshProactive(): Promise<void> {
  await app.loadActivity()
  await app.loadProactiveStatus()
  await app.loadInbox()
}

/* ═══════════════════════════════════════════ 隐私与数据 */

const exportInfo = ref<{ file: string, bytes: number, sections: string[], excluded: string[] } | null>(null)
const wipePhrase = ref('')
const wipeKeepingSettings = ref(true)
const wipeRevokeKeys = ref(false)
const wipeResult = ref<{ removedFiles: string[], removedBytes: number, kept: string[] } | null>(null)
const summary = ref<{ userDataDir: string, files: Array<{ name: string, exists: boolean, bytes: number, kind: string }>, secretFiles: number, telemetryEnabled: boolean, logFiles: number, exportFiles: number } | null>(null)
const privacyBusy = ref(false)

const WIPE_PHRASE = 'DELETE-ALL-PERSONAL-DATA'

async function loadSummary(): Promise<void> {
  privacyBusy.value = true
  try {
    const r = await bridge.privacySummary()
    summary.value = r.summary ?? null
  } catch (e) {
    app.reportFailure('读取隐私摘要失败', e)
  } finally {
    privacyBusy.value = false
  }
}

async function exportData(includeMemory: boolean): Promise<void> {
  privacyBusy.value = true
  try {
    const r = await bridge.privacyExport({ format: 'json', includeChats: true, includeMemory })
    exportInfo.value = {
      file: String(r.file ?? ''),
      bytes: Number(r.bytes ?? 0),
      sections: r.sections ?? [],
      excluded: r.excluded ?? [],
    }
  } catch (e) {
    app.reportFailure('导出数据失败', e)
  } finally {
    privacyBusy.value = false
  }
}

async function wipe(): Promise<void> {
  if (wipePhrase.value !== WIPE_PHRASE) {
    app.toast('warn', '确认串不匹配', `必须逐字输入 ${WIPE_PHRASE}`, false)
    return
  }
  privacyBusy.value = true
  try {
    const r = await bridge.privacyWipe({
      confirm: 'DELETE-ALL-PERSONAL-DATA',
      keepSettings: wipeKeepingSettings.value,
      revokeKeys: wipeRevokeKeys.value,
    })
    wipeResult.value = {
      removedFiles: r.removedFiles ?? [],
      removedBytes: Number(r.removedBytes ?? 0),
      // `kept` 必须原样渲染给用户看（"哪些没删"和"删了什么"一样重要）
      kept: r.kept ?? [],
    }
    wipePhrase.value = ''
    await loadSummary()
    await app.loadProviders()
  } catch (e) {
    app.reportFailure('清除个人数据失败', e)
  } finally {
    privacyBusy.value = false
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

const blockedCount = computed(() => app.permissions.filter(p => p.effective === 'blocked').length)

/**
 * 硬下限表里登记的能力总数。
 * 从 `@airimate/shared` 的**真实常量**算出，而不是写死数字 —— 写死就会在有人
 * 新增能力时悄悄变成假读数（本项目已经因为"契约漂移"踩过好几次）。
 */
const tierFloorCount = Object.keys(PERMISSION_TIER_FLOOR).length
</script>

<template>
  <div class="settings">
    <section class="card">
      <h3>窗口</h3>
      <label class="row">
        <span>模式</span>
        <select :value="app.mode" @change="app.setMode(($event.target as HTMLSelectElement).value as 'panel' | 'pet')">
          <option value="panel">面板</option>
          <option value="pet">桌宠</option>
        </select>
      </label>
      <label class="row">
        <span>窗口置顶</span>
        <input
          type="checkbox"
          :checked="app.settings?.alwaysOnTop ?? true"
          @change="app.patch({ alwaysOnTop: ($event.target as HTMLInputElement).checked })"
        />
      </label>
      <label class="row">
        <span>开机自动启动</span>
        <input type="checkbox" :checked="app.autoStart" @change="app.toggleAutoStart()" />
      </label>
      <p class="muted">启用时会先备份再迁移旧启动项，只保留本应用一项（判据 A19）。</p>
    </section>

    <section class="card">
      <h3>对话（桌宠对话框 + 语音说话）</h3>
      <label class="row">
        <span>全局快捷键</span>
        <input
          type="text"
          :value="app.settings?.conversationHotkey ?? 'Ctrl+Alt+Space'"
          placeholder="Ctrl+Alt+Space"
          @change="app.patch({ conversationHotkey: ($event.target as HTMLInputElement).value.trim() || 'Ctrl+Alt+Space' })"
        />
      </label>
      <label class="row">
        <span>启用全局快捷键</span>
        <input
          type="checkbox"
          :checked="app.settings?.conversationHotkeyEnabled ?? true"
          @change="app.patch({ conversationHotkeyEnabled: ($event.target as HTMLInputElement).checked })"
        />
      </label>
      <!--
        ⚠ 注册结果**如实显示**（本轮硬要求：注册失败必须可见，不许静默失效）。
        这里的读数是主进程 `globalShortcut` 的真实结论，不是"设置里写了就算数"。
      -->
      <p
        class="muted"
        :class="{ warn: app.conversationHotkey.error }"
      >
        <template v-if="!app.conversationHotkey.enabled">
          快捷键已关闭（不占用系统热键）。
        </template>
        <template v-else-if="app.conversationHotkey.registered">
          已注册：<b>{{ app.conversationHotkey.accelerator }}</b>（按下即可开/关对话框）。
        </template>
        <template v-else>
          <b>未注册成功</b>：{{ app.conversationHotkey.error ?? '主进程还没有回报结果' }}
        </template>
      </p>
      <label class="row">
        <span>气泡自动消失（秒）</span>
        <input
          type="range"
          min="1"
          max="30"
          step="1"
          :value="app.settings?.bubbleAutoHideSec ?? 3"
          @input="app.patch({ bubbleAutoHideSec: Number(($event.target as HTMLInputElement).value) })"
        />
        <b>{{ app.settings?.bubbleAutoHideSec ?? 3 }}s</b>
      </label>
      <label class="row">
        <span>显示对话气泡</span>
        <input
          type="checkbox"
          :checked="app.settings?.bubbleEnabled ?? true"
          @change="app.patch({ bubbleEnabled: ($event.target as HTMLInputElement).checked })"
        />
      </label>
      <p class="muted">
        语音为主：朗读开着时她的回复会**说**出来，头顶气泡在朗读结束后
        {{ app.settings?.bubbleAutoHideSec ?? 3 }} 秒自动消失（鼠标悬停暂停、点击展开全文）。
        关掉气泡只会不显示文字，**朗读仍然照常**。
        进入对话时若朗读是关闭的，会**明确问一次**要不要开启 —— 不会静默打开，也不会静默不出声。
      </p>
      <p class="muted">
        入口：轮盘「对话」项 · 托盘「开始 / 结束对话」 · 上面的全局快捷键 · 语音唤醒词 ·
        双击角色。
      </p>
    </section>

    <section class="card">
      <h3>角色</h3>
      <label class="row">
        <span>大小</span>
        <input
          type="range"
          min="0.70"
          max="1.40"
          step="0.05"
          :value="app.settings?.avatarScale ?? 1"
          @input="app.patch({ avatarScale: Number(($event.target as HTMLInputElement).value) })"
        />
        <b>{{ Math.round((app.settings?.avatarScale ?? 1) * 100) }}%</b>
      </label>
      <p class="muted">
        这是**唯一**改变角色大小的入口：围绕固定舞台锚点缩放，中心与底部基线不动。
        单击、拖动、滚轮、轮盘、动作切换都不会改变它。
      </p>
    </section>

    <section class="card">
      <h3>动作资产</h3>
      <div class="row">
        <span>待机动作</span>
        <b :class="motionOk ? 'ok' : 'warn'">{{ idleCount }} / 10</b>
      </div>
      <div class="row">
        <span>清单总数</span><b>{{ app.motion.manifests.length }}</b>
      </div>
      <div v-if="app.motion.failed.length" class="fail">
        <b>异常项</b>
        <pre>{{ app.motion.failed.join('\n') }}</pre>
      </div>
      <button class="tbtn" :disabled="busy" @click="app.loadMotion()">重新加载清单</button>
    </section>

    <section class="card">
      <h3>语音合成（TTS）</h3>
      <label class="row">
        <span>回复时朗读</span>
        <input
          type="checkbox"
          :checked="app.settings?.ttsEnabled ?? false"
          @change="toggleTts(($event.target as HTMLInputElement).checked)"
        />
      </label>
      <label class="row">
        <span>声音</span>
        <select
          :value="app.settings?.ttsVoice ?? ''"
          :disabled="!app.settings?.ttsEnabled"
          @change="pickVoice(($event.target as HTMLSelectElement).value)"
        >
          <option value="">自动（中文优先）</option>
          <option v-for="v in app.ttsVoices ?? []" :key="v.id" :value="v.id">{{ v.label }}</option>
        </select>
      </label>
      <div v-if="app.speaking" class="row">
        <span>正在朗读</span>
        <button class="tbtn" @click="app.stopSpeaking()">停止</button>
      </div>
      <p class="muted">
        引擎为 Windows 内置 SAPI（离线、无需下载）。正文经 stdin 交给子进程，**不进命令行**；
        日志只记长度与耗时，不记内容。
      </p>
      <p v-if="app.ttsVoices && app.ttsVoices.length === 0" class="muted warn">
        本机没有可用的语音合成声音：朗读会返回结构化失败（不会静默假装成功）。
      </p>
    </section>

    <!-- ═══════════════════════════════ 供应商配置（完整版） -->
    <section class="card">
      <h3>供应商配置</h3>
      <p class="muted">
        密钥后端：<b>{{ app.backend }}</b>。密钥只在"保存"那一刻经 IPC 单向进入主进程，
        由操作系统密钥库加密落盘；<b>本界面永远只显示 hasKey / 指纹 / 长度，无法取回明文</b>。
      </p>

      <div v-if="app.providers.length === 0" class="muted">还没有供应商。用下面的表单添加第一个。</div>
      <div v-for="p in app.providers" :key="p.id" class="prov">
        <div class="row">
          <span class="prov__title">
            <b>{{ p.label }}</b>
            <span class="badge">{{ kindLabel(p.kind) }}</span>
            <span v-if="p.active" class="badge badge--ok">生效中</span>
            <span :class="['badge', p.hasKey ? 'badge--ok' : 'badge--warn']">{{ p.hasKey ? '有密钥' : '无密钥' }}</span>
          </span>
          <span class="prov__actions">
            <button class="tbtn tbtn--mini" :disabled="testing === p.id" @click="runTest(p.id)">
              {{ testing === p.id ? '测试中…' : '测试连接' }}
            </button>
            <button class="tbtn tbtn--mini" :disabled="p.active" @click="app.selectProvider(p.id)">设为生效</button>
            <button class="tbtn tbtn--mini" @click="startEdit(p.id)">编辑</button>
            <button class="tbtn tbtn--mini tbtn--danger" @click="app.deleteProvider(p.id)">删除</button>
          </span>
        </div>
        <div class="muted prov__meta">
          <div>baseUrl：{{ p.baseUrl }}</div>
          <div>模型：{{ p.model }}</div>
          <div>
            密钥：{{ p.hasKey ? `指纹 ${p.keyFingerprint ?? '—'} · 长度 ${p.keyLength ?? '—'}` : '未设置' }}
            <span class="muted">（指纹 = sha256 前 8 位 + 长度，只够判断"是不是同一把钥匙"）</span>
          </div>
        </div>
        <div v-if="testResults[p.id]" class="prov__result">
          <span :class="testResults[p.id]!.ok ? 'ok' : 'warn'">{{ testResults[p.id]!.ok ? '✓ 连通' : '✗ 失败' }}</span>
          <span class="badge">code {{ testResults[p.id]!.code }}</span>
          <span class="badge">延迟 {{ testResults[p.id]!.latencyMs ?? '—' }} ms</span>
          <span class="badge">模型数 {{ testResults[p.id]!.modelCount ?? '—' }}</span>
          <pre v-if="testResults[p.id]!.message" class="prov__msg">{{ testResults[p.id]!.message }}</pre>
        </div>
      </div>

      <div class="subform">
        <b>{{ editingId ? `编辑供应商 ${editingId}` : '添加 / 更新供应商' }}</b>
        <label class="row"><span>标签</span><input v-model="pForm.label" type="text" placeholder="例：DeepSeek" /></label>
        <label class="row">
          <span>类型</span>
          <select v-model="pForm.kind">
            <option v-for="k in KIND_OPTIONS" :key="k.value" :value="k.value">{{ k.label }}</option>
          </select>
        </label>
        <label class="row"><span>baseUrl</span><input v-model="pForm.baseUrl" type="text" placeholder="https://api.deepseek.com/v1" /></label>
        <label class="row"><span>模型</span><input v-model="pForm.model" type="text" placeholder="deepseek-chat" /></label>
        <label class="row">
          <span>API 密钥{{ editingId ? '（留空 = 不改）' : '' }}</span>
          <input v-model="pForm.apiKey" type="password" placeholder="sk-…" autocomplete="off" :disabled="clearKey" />
        </label>
        <label v-if="editingId" class="row">
          <span>清除已保存的密钥</span>
          <input v-model="clearKey" type="checkbox" />
        </label>
        <p class="muted">
          留空 = <b>保留现有密钥</b>（提交时不带 apiKey 字段）；要清除密钥请勾选上面的复选框
          —— 那会提交空串，主进程据此删除密钥。密钥由主进程用操作系统密钥库加密，
          **永远不会回到这个界面**。
        </p>
        <div class="row">
          <span />
          <span class="prov__actions">
            <button class="tbtn tbtn--primary" @click="submitProvider()">{{ editingId ? '保存修改' : '添加' }}</button>
            <button v-if="editingId" class="tbtn" @click="resetForm()">取消编辑</button>
          </span>
        </div>
      </div>
    </section>

    <!-- ═══════════════════════════════ 人设 -->
    <section class="card">
      <h3>人设</h3>
      <div v-if="!app.persona" class="muted">人设还没加载出来（失败原因见右下角告警）。</div>
      <template v-else>
        <label class="row"><span>名字</span><input v-model="personaDraft.name" type="text" /></label>
        <label class="row"><span>她怎么称呼你</span><input v-model="personaDraft.userTitle" type="text" /></label>
        <label class="row"><span>系统提示词</span><textarea v-model="personaDraft.systemPrompt" rows="5" /></label>
        <label class="row"><span>性格</span><textarea v-model="personaDraft.personality" rows="3" /></label>
        <label class="row"><span>说话风格</span><textarea v-model="personaDraft.speakingStyle" rows="2" /></label>
        <label class="row"><span>开场问候</span><textarea v-model="personaDraft.greeting" rows="2" /></label>
        <label class="row">
          <span>表现力</span>
          <input v-model.number="personaDraft.expressiveness" type="range" min="0" max="1" step="0.05" />
          <b>{{ Math.round(personaDraft.expressiveness * 100) }}%</b>
        </label>
        <label class="row">
          <span>手势频率</span>
          <input v-model.number="personaDraft.gestureFrequency" type="range" min="0" max="1" step="0.05" />
          <b>{{ Math.round(personaDraft.gestureFrequency * 100) }}%</b>
        </label>
        <label class="row">
          <span>空闲时会主动搭话</span>
          <input v-model="personaDraft.idleChatter" type="checkbox" />
        </label>
        <p class="muted">
          ⚠ 主进程会对人设做校验（长度上限、必填项）。**校验失败时它会保留原来的默认值**，
          不会写入半截数据 —— 所以保存后请以界面回填的内容为准。
        </p>
        <button class="tbtn tbtn--primary" @click="savePersona()">保存人设</button>
        <p class="muted">更新时间：{{ new Date(app.persona.updatedAt).toLocaleString() }}</p>
      </template>
    </section>

    <!-- ═══════════════════════════════ 主动陪伴（M2） -->
    <section class="card">
      <h3>主动陪伴（M2）</h3>
      <label v-for="t in PROACTIVE_TOGGLES" :key="t.key" class="row">
        <span>{{ t.label }}<span class="muted"> · {{ t.note }}</span></span>
        <input
          type="checkbox"
          :checked="app.settings?.[t.key] ?? false"
          @change="app.patch({ [t.key]: ($event.target as HTMLInputElement).checked })"
        />
      </label>
      <label class="row">
        <span>早安电台时间</span>
        <input
          type="time"
          :value="app.settings?.morningRadioAt ?? '08:30'"
          @change="patchTime('morningRadioAt', ($event.target as HTMLInputElement).value)"
        />
      </label>

      <div class="row">
        <span>手动触发</span>
        <span class="prov__actions">
          <button class="tbtn tbtn--mini" @click="app.tickEngine()">现在检查一次</button>
          <button class="tbtn tbtn--mini" @click="app.triggerRadio(false)">生成早安电台</button>
          <button class="tbtn tbtn--mini" @click="refreshProactive()">刷新读数</button>
        </span>
      </div>

      <div class="readout">
        <div class="row"><span>引擎</span>
          <b :class="app.proactive?.running ? 'ok' : 'warn'">{{ app.proactive?.running ? '运行中' : '未运行' }}</b>
        </div>
        <div class="row"><span>tick 次数</span><b>{{ app.proactive?.ticks ?? '—' }}</b></div>
        <div class="row"><span>距下次检查</span><b>{{ app.proactive ? `${Math.round(app.proactive.nextTickInMs / 1000)} s` : '—' }}</b></div>
        <div class="row"><span>队列长度</span><b>{{ app.proactive?.queueLength ?? '—' }}</b></div>
        <div class="row"><span>开机问候</span>
          <b>{{ app.proactive?.startupGreeted ? `已发（${app.proactive?.startupGreetedAt ? new Date(app.proactive.startupGreetedAt).toLocaleTimeString() : '—'}）` : '未发' }}</b>
        </div>
        <div class="row"><span>今天的活动时长</span>
          <b>{{ app.activityToday ? `${app.activityToday.activeMinutes} 分钟` : '—' }}</b>
        </div>
        <div class="row"><span>最长连续一段</span>
          <b>{{ app.activityToday ? `${app.activityToday.longestStreakMinutes} 分钟` : '—' }}</b>
        </div>
        <div class="row"><span>采样次数</span><b>{{ app.activityToday?.samples ?? '—' }}</b></div>
      </div>
      <p v-if="app.activity" class="muted">
        当前阻断判定：<b :class="app.activity.blocked ? 'warn' : 'ok'">{{ blockText(app.activity.blockReason) }}</b>
        {{ app.activity.blocked ? '（提醒会进队列，等条件结束后补发，不会丢）' : '' }}
      </p>
      <p v-if="app.activity && !app.activity.available" class="muted warn">
        活动采样不可用：{{ app.activity.unavailableReason ?? '原因未给出' }}
        —— 久坐/连续使用提醒在这种情况下不会瞎猜，只会沉默。
      </p>
      <p v-if="app.activityAdvice.length" class="muted">建议：{{ app.activityAdvice.join('；') }}</p>
    </section>

    <!-- ═══════════════════════════════ 隐私与数据（M5 铺垫） -->
    <section class="card">
      <h3>隐私与数据（M5 铺垫）</h3>
      <p class="muted">
        <b>只存在本机的东西</b>：设置、供应商配置（密钥单独加密存放）、对话历史、长期记忆、
        日程与提醒、活动**计数**（活跃分钟数 / 采样次数）。
      </p>
      <p class="muted">
        <b>明确不做</b>：不记录键盘输入内容、不持续录屏、不后台偷听、不做不可见自动化。
        活动采样只读"空闲了多少毫秒"与"这一分钟有多少次输入事件"这类**计数**；
        前台窗口标题默认只存哈希与长度，且默认关闭。
        遥测<b>默认关闭</b>，关闭时不发送任何数据。
      </p>

      <div class="row">
        <span>读取本地数据摘要</span>
        <button class="tbtn tbtn--mini" :disabled="privacyBusy" @click="loadSummary()">读取</button>
      </div>
      <div v-if="summary" class="readout">
        <div class="muted">目录：{{ summary.userDataDir }}</div>
        <div class="row"><span>密钥文件</span><b>{{ summary.secretFiles }}</b></div>
        <div class="row"><span>日志文件</span><b>{{ summary.logFiles }}</b></div>
        <div class="row"><span>导出文件</span><b>{{ summary.exportFiles }}</b></div>
        <div class="row"><span>遥测</span><b :class="summary.telemetryEnabled ? 'warn' : 'ok'">{{ summary.telemetryEnabled ? '开启' : '关闭' }}</b></div>
        <pre>{{ summary.files.map(f => `${f.exists ? '✓' : '✗'} ${f.name}  ${fmtBytes(f.bytes)}  [${f.kind}]`).join('\n') }}</pre>
      </div>

      <div class="row">
        <span>导出我的数据</span>
        <span class="prov__actions">
          <button class="tbtn tbtn--mini" :disabled="privacyBusy" @click="exportData(true)">含记忆</button>
          <button class="tbtn tbtn--mini" :disabled="privacyBusy" @click="exportData(false)">不含记忆</button>
        </span>
      </div>
      <div v-if="exportInfo" class="readout">
        <div class="row"><span>文件</span><b>{{ exportInfo.file }}</b></div>
        <div class="row"><span>大小</span><b>{{ fmtBytes(exportInfo.bytes) }}（{{ exportInfo.bytes }} 字节）</b></div>
        <div class="muted">包含：{{ exportInfo.sections.join('、') || '（无）' }}</div>
        <div class="muted">已剔除 / 占位：{{ exportInfo.excluded.join('、') || '（无）' }}</div>
      </div>

      <div class="danger">
        <b>彻底清除个人数据</b>
        <p class="muted">
          这一步会删除对话历史、记忆、日程、提醒队列与活动统计。
          请输入确认串 <code>{{ WIPE_PHRASE }}</code> 后执行；执行结果（删了什么、**留下了什么**）会原样列在下面。
        </p>
        <label class="row">
          <span>保留设置与供应商配置</span>
          <input v-model="wipeKeepingSettings" type="checkbox" />
        </label>
        <label class="row">
          <span>同时吊销已保存的密钥</span>
          <input v-model="wipeRevokeKeys" type="checkbox" />
        </label>
        <label class="row">
          <span>确认串</span>
          <input v-model="wipePhrase" type="text" :placeholder="WIPE_PHRASE" autocomplete="off" />
        </label>
        <button class="tbtn tbtn--danger" :disabled="privacyBusy || wipePhrase !== WIPE_PHRASE" @click="wipe()">
          彻底清除个人数据
        </button>
        <div v-if="wipeResult" class="readout">
          <div class="row"><span>已删除文件</span><b>{{ wipeResult.removedFiles.length }} 个 · {{ fmtBytes(wipeResult.removedBytes) }}</b></div>
          <pre>{{ wipeResult.removedFiles.join('\n') || '（没有删除任何文件）' }}</pre>
          <b>保留未删（原样列出，不省略）</b>
          <pre>{{ wipeResult.kept.join('\n') || '（无）' }}</pre>
        </div>
      </div>

      <div class="row">
        <span>重新走一次首次运行向导</span>
        <button class="tbtn tbtn--mini" @click="app.resetOnboarding()">重置向导</button>
      </div>
      <p class="muted">
        权限硬下限（本界面**无法**放宽）：当前 {{ blockedCount }} 项能力的生效档位是 blocked
        —— 支付 / 改密码 / 读凭据 / 模拟键鼠 / 改系统设置由
        `PERMISSION_TIER_FLOOR`（共 {{ tierFloorCount }} 项能力登记在案）钉死，
        主进程在执行前还会再判一次，界面改不动它。
      </p>
    </section>

    <section class="card">
      <h3>诊断</h3>
      <button class="tbtn" :disabled="busy" @click="refreshDiag()">读取只读诊断快照</button>
      <pre v-if="diag" class="diag">{{ diag }}</pre>
    </section>
  </div>
</template>
