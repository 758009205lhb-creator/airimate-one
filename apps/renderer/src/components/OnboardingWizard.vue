<script setup lang="ts">
/**
 * OnboardingWizard.vue —— 首次运行向导（M1 配置闭环）
 *
 * 设计纪律（三条，都很容易被"顺手优化"掉，所以写在这里）：
 *
 * 1. **每一步能不能离开，主进程说了算**。本组件只读 `app.onboarding.satisfied` /
 *    `blockedBy` / `hint`，**不自己判断**"供应商填了就能下一步"——
 *    否则一个前端 bug 就能让用户带着没验证过的配置进入日常使用。
 *    `hint` 是主进程给的一句话解释，**必须原样显示**（它就是"为什么按钮是灰的"）。
 *
 * 2. **它必须是覆盖层，不能影响 `<AvatarStage/>`**。向导是 `App.vue` 里一个绝对定位的
 *    兄弟节点，`v-if` 只作用于自己；绝不 `v-if`/`v-show` 包住 `AvatarStage`
 *    （同一 window / 同一 renderer / 同一 Scene 是硬约束，重建角色会黑屏且丢状态）。
 *
 * 3. **不伪造成功**。所有保存动作都走 store 的动作（内部 `reportFailure`），
 *    本组件只用**返回值**决定要不要继续；失败时停在原地并把错误留在 toast 里。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { PERMISSION_TIER_FLOOR, effectiveTier } from '@airimate/shared'
import type { OnboardingStep, PermissionKind, ProviderKind } from '@airimate/shared'
import { useApp } from '../store'

const app = useApp()

/** 供应商类型的可见标签（值必须与 `ProviderKindSchema` 完全一致，否则主进程 zod 直接拒） */
const KIND_OPTIONS: Array<{ value: ProviderKind, label: string }> = [
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic-compatible', label: 'Anthropic 兼容' },
  { value: 'ollama', label: '本机 Ollama' },
  { value: 'custom', label: '自定义' },
]

const STEP_LABELS: Array<{ step: OnboardingStep, label: string }> = [
  { step: 'provider', label: '供应商' },
  { step: 'test', label: '测试' },
  { step: 'model', label: '模型' },
  { step: 'persona', label: '人设' },
  { step: 'permission', label: '权限' },
  { step: 'schedule', label: '日程' },
]

/** 预设人设：一键填满"性格 / 说话风格 / 问候"三个框，用户可继续手改 */
const PERSONA_PRESETS: Array<{ label: string, name: string, personality: string, speakingStyle: string, greeting: string }> = [
  {
    label: '温柔陪伴',
    name: '小满',
    personality: '温柔、耐心，会先回应情绪再谈事情；不夸张、不说教。',
    speakingStyle: '口语化短句，偶尔用叠词；一次说一到两句，不用列表。',
    greeting: '你回来啦，先坐下歇会儿吧。',
  },
  {
    label: '轻快搭档',
    name: '阿柚',
    personality: '爽快、爱开玩笑但知道分寸，正事上很靠谱。',
    speakingStyle: '节奏快，短句多，会主动把话题推进一小步。',
    greeting: '来啦！今天想先干哪件？',
  },
  {
    label: '冷静助手',
    name: '青禾',
    personality: '克制、准确，重视事实与边界；不知道就直说不知道。',
    speakingStyle: '陈述句为主，先给结论再给一句理由，不说废话。',
    greeting: '我在。需要我做什么？',
  },
]

const step = computed<OnboardingStep>(() => app.onboarding?.state.step ?? 'provider')
const satisfied = computed(() => app.onboarding?.satisfied ?? null)
const hint = computed(() => app.onboarding?.hint ?? '')
const completed = computed(() => app.onboarding?.completed === true)

/**
 * 显示条件。四项缺一不可：
 *   · 向导状态已从主进程拿到（否则"没数据"会被误当成"没配置"而闪一下）；
 *   · 未完成；
 *   · 用户没有关掉自动弹出（`onboardingAutoStart === false` 时只在设置里手动开）；
 *   · ★ **用户没有显式说过"稍后再说"**（`settings.onboarded === true`）。
 *
 * 第 4 条是 2026-10-08 补的（用户裁定），理由是"跳过"以前只是一句文案、没有落点：
 *   主进程的 `onboarding.completed` 要求"供应商已配置 + 测试通过"，
 *   没有密钥的用户**永远**满足不了它 ⇒ 覆盖层永久驻留，在 pet 模式下把角色整个盖住。
 *   现在底部有了「稍后再说」按钮写 `onboarded`，这里就必须认它 ——
 *   否则按钮点了、界面却不消失（那是比没有按钮更坏的体验）。
 *   ⚠ 它**只**决定"还弹不弹"：不代替用户填任何配置，也不让任何判据变成满足。
 */
const visible = computed(() =>
  !!app.onboarding
  && !completed.value
  && app.settings?.onboarded !== true
  && app.settings?.onboardingAutoStart !== false)

/** 上一步按钮：`provider` 之前没有步骤（向导不提供"直接跳过"，跳过由设置项 `onboarded` 负责） */
const canGoBack = computed(() => step.value !== 'provider')
const backStep = computed<OnboardingStep>(() => {
  const i = STEP_LABELS.findIndex(s => s.step === step.value)
  return i > 0 ? (STEP_LABELS[i - 1] as { step: OnboardingStep }).step : 'provider'
})

/**
 * 逐步查判据。
 *
 * ⚠ 不能写成 `satisfied[s.step]`：`satisfied` 里**没有** `done` 这个键
 *   （`OnboardingStep` 有 7 个取值，判据只有 6 个），直接下标会过不了类型检查，
 *   而且 `done` 到达时会在运行期取到 `undefined` —— 那正好会被当成"未满足"而卡死。
 *   所以显式列出 6 个键，`done` 恒为 true。
 */
function satisfiedFor(s: OnboardingStep): boolean {
  const map = satisfied.value
  if (!map) return false
  if (s === 'provider') return map.provider
  if (s === 'test') return map.test
  if (s === 'model') return map.model
  if (s === 'persona') return map.persona
  if (s === 'permission') return map.permission
  if (s === 'schedule') return map.schedule
  return true
}

/** 当前步骤是否可以离开（主进程判据；`satisfied` 缺失时一律不放行） */
const currentSatisfied = computed(() => satisfiedFor(step.value))

/** 1 供应商 ───────────────────────────────────────────── */
const pForm = ref<{ id?: string, label: string, kind: ProviderKind, baseUrl: string, model: string, apiKey: string }>({
  label: 'DeepSeek', kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '',
})
/** 表单只预填一次：步骤来回切换时不覆盖用户已经改了一半的输入 */
const prefilled = ref(false)

function kindLabel(k: string): string {
  return KIND_OPTIONS.find(o => o.value === k)?.label ?? k
}

/** 保存供应商。返回是否成功——只有成功才允许继续（失败原因已在 store 里报出） */
async function saveProvider(): Promise<boolean> {
  if (!pForm.value.label.trim() || !pForm.value.baseUrl.trim() || !pForm.value.model.trim()) {
    app.toast('warn', '请把标签、baseUrl、模型名填完整', '主进程要求三者都非空', false)
    return false
  }
  // 端点必须是合法 URL（主进程用 zod 的 url() 校验；这里先挡一次，省得白跑一趟 IPC）
  try { new URL(pForm.value.baseUrl.trim()) } catch {
    app.toast('warn', 'baseUrl 不是合法 URL', '例：https://api.deepseek.com/v1', false)
    return false
  }
  const payload: { id?: string, label: string, kind: string, baseUrl: string, model: string, apiKey?: string } = {
    label: pForm.value.label.trim(),
    kind: pForm.value.kind,
    baseUrl: pForm.value.baseUrl.trim(),
    model: pForm.value.model.trim(),
  }
  if (pForm.value.id) payload.id = pForm.value.id
  // 空串 = 保持原密钥（省略字段）；非空 = 一次性写入明文，主进程加密后丢弃
  if (pForm.value.apiKey.trim()) payload.apiKey = pForm.value.apiKey.trim()
  const ok = await app.upsertProvider(payload)
  if (ok) pForm.value.apiKey = ''
  return ok
}

/** 2 测试 ────────────────────────────────────────────── */
const testing = ref<string>('')
const testResult = ref<Record<string, { ok: boolean, code: string, message: string, latencyMs: number | null, modelCount: number | null }>>({})

async function test(id: string): Promise<void> {
  testing.value = id
  try {
    const r = await app.testProvider(id)
    // null = 调用本身失败（store 已 reportFailure）；**不**写进结果表，免得看起来像"测过了"
    if (r) testResult.value = { ...testResult.value, [id]: r }
  } finally {
    testing.value = ''
  }
}

/** 3 模型 ────────────────────────────────────────────── */
const modelProviderId = ref('')
const models = ref<string[]>([])
const modelsNote = ref('')
const modelsLoading = ref(false)
const manualModel = ref('')
const selectedModel = ref('')

const modelProvider = computed(() => app.providers.find(p => p.id === modelProviderId.value) ?? null)

async function fetchModels(): Promise<void> {
  if (!modelProviderId.value) return
  modelsLoading.value = true
  try {
    const r = await app.loadProviderModels(modelProviderId.value)
    models.value = r.models
    /**
     * `supported:false` **不是错误**：很多兼容端点没有 `/models`（用户要求"允许手输"）。
     * 所以这里如实说明并把自由输入框摆在旁边，而不是报一个红色的失败。
     */
    modelsNote.value = r.supported
      ? (r.models.length ? `端点返回 ${r.models.length} 个模型` : '端点返回了空清单')
      : `端点未提供 /models 清单（${r.message || '不支持'}）——请直接手输模型名`
  } finally {
    modelsLoading.value = false
  }
}

/** 保存模型：**把已有供应商的 label/kind/baseUrl 原样透传**，并省略 apiKey（= 保留原密钥） */
async function saveModel(): Promise<boolean> {
  const p = modelProvider.value
  const model = (manualModel.value || selectedModel.value).trim()
  if (!p) {
    app.toast('warn', '还没有可用的供应商', '请先回到第 1 步添加一个', false)
    return false
  }
  if (!model) {
    app.toast('warn', '请选择或手输一个模型名', undefined, false)
    return false
  }
  return await app.upsertProvider({ id: p.id, label: p.label, kind: p.kind, baseUrl: p.baseUrl, model })
}

/** 4 人设 ────────────────────────────────────────────── */
const persona = ref({ name: '', userTitle: '', personality: '', speakingStyle: '', greeting: '', ttsEnabled: false, ttsVoice: '' })
const personaPrefilled = ref(false)
const savingPersona = ref(false)

function applyPreset(p: typeof PERSONA_PRESETS[number]): void {
  persona.value.name = p.name
  persona.value.personality = p.personality
  persona.value.speakingStyle = p.speakingStyle
  persona.value.greeting = p.greeting
}

async function savePersonaStep(): Promise<boolean> {
  if (!persona.value.name.trim()) {
    app.toast('warn', '她得有个名字', undefined, false)
    return false
  }
  savingPersona.value = true
  try {
    // 声音与朗读开关属于 settings，不属于 persona —— 分两条通道写，别混在一起
    await app.patch({ ttsEnabled: persona.value.ttsEnabled, ttsVoice: persona.value.ttsVoice || null })
    await app.savePersona({
      name: persona.value.name.trim(),
      userTitle: persona.value.userTitle.trim() || '你',
      personality: persona.value.personality,
      speakingStyle: persona.value.speakingStyle,
      greeting: persona.value.greeting,
    })
    /**
     * 判"到底存上没有"要看**主进程的判据**，不能看本地变量：
     * `savePersona` 失败时会保留原来的默认值并只报 toast，而 `app.persona` 无论如何
     * 都还是旧对象 —— 用它做对比只会得到一个永远为假的判断。
     * `savePersona` 内部会 `loadOnboarding()`，所以这里读到的 satisfied 是刚更新的。
     */
    return app.onboarding?.satisfied.persona === true
  } finally {
    savingPersona.value = false
  }
}

/** 5 权限 ────────────────────────────────────────────── */

/** store 把 permissions 的 kind 存成 string（preload 契约就是 string）；只在确定是 PermissionKind 时用 */
function asPermissionKind(kind: string): PermissionKind | null {
  return kind in PERMISSION_TIER_FLOOR ? kind as PermissionKind : null
}

/**
 * `effective === 'blocked'` 是**硬下限**的结果，不是用户的选择。
 * UI 上必须显式说明"点不动"是主进程强制的，否则用户会以为是界面坏了。
 */
const blockedPermissions = computed(() => app.permissions.filter(p => p.effective === 'blocked'))

/** 6 日程 / 隐私 ─────────────────────────────────────── */
const quietDraft = ref({ enabled: true, start: '23:00', end: '07:30' })
const policyDraft = ref({ continuousMinutes: 50, sedentaryMinutes: 60, nightRestAt: '23:30' })
const weatherDraft = ref('')
const quietPrefilled = ref(false)
const savingSchedule = ref(false)

/** `HH:MM` 是否合法（与 `TimeOfDaySchema` 的正则同口径） */
function isHHMM(v: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
}

async function saveScheduleStep(): Promise<boolean> {
  /**
   * ⚠ 先挡一次"被清空 / 半截"的时间值：`<input type="time">` 在用户清空时给出空串，
   *   而主进程的 `QuietHoursSetSchema` / `ReminderPolicySchema` 用正则钉死了 `HH:MM`。
   *   直接透传只会换回一条校验失败 toast —— 那既没保存成功，也说不清该改哪一项。
   */
  if (!isHHMM(quietDraft.value.start) || !isHHMM(quietDraft.value.end)) {
    app.toast('warn', '静音时段的开始/结束必须是 HH:MM', '例：23:00 与 07:30', false)
    return false
  }
  if (!isHHMM(policyDraft.value.nightRestAt)) {
    app.toast('warn', '夜间休息时间必须是 HH:MM', '例：23:30', false)
    return false
  }
  if (!Number.isInteger(policyDraft.value.continuousMinutes) || policyDraft.value.continuousMinutes < 5 || policyDraft.value.continuousMinutes > 600) {
    app.toast('warn', '连续使用提醒阈值必须是 5–600 的整数分钟', undefined, false)
    return false
  }
  if (!Number.isInteger(policyDraft.value.sedentaryMinutes) || policyDraft.value.sedentaryMinutes < 5 || policyDraft.value.sedentaryMinutes > 600) {
    app.toast('warn', '久坐提醒阈值必须是 5–600 的整数分钟', undefined, false)
    return false
  }
  savingSchedule.value = true
  try {
    await app.setQuiet({ enabled: quietDraft.value.enabled, start: quietDraft.value.start, end: quietDraft.value.end })
    await app.setReminderPolicy({
      continuousMinutes: policyDraft.value.continuousMinutes,
      sedentaryMinutes: policyDraft.value.sedentaryMinutes,
      nightRestAt: policyDraft.value.nightRestAt,
    })
    /**
     * ⚠ 这里**只**写 weatherCity：`telemetryEnabled` 一律由上面那个复选框自己写
     *   （它的 `@change` 直接落盘）。保存按钮顺手"确认"一次遥测开关是个陷阱 ——
     *   万一 settings 还没加载完，`?? false` 就会把用户已经打开的遥测**悄悄关掉**，
     *   而用户根本没碰那个开关。
     */
    await app.patch({ weatherCity: weatherDraft.value.trim() })
    /**
     * ⚠ `setQuiet` / `setReminderPolicy` **不会**刷新向导状态（它们只回写自己那两块）。
     *   而"日程步骤已满足"的判据是主进程记的 `quiet.updatedAt`。
     *   所以这里必须补一次 `loadOnboarding()`，否则用户保存成功、按钮却还是灰的。
     */
    await app.loadOnboarding()
    return app.onboarding?.satisfied.schedule === true
  } finally {
    savingSchedule.value = false
  }
}

/**
 * 每个步骤的"保存并继续"：**先保存，成功了才走**。
 * 保存失败（或主进程判定未满足）时停在原地——绝不让失败的保存看起来像成功了。
 */
async function next(): Promise<void> {
  let ok = true
  if (step.value === 'provider') ok = await saveProvider()
  else if (step.value === 'model') ok = await saveModel()
  else if (step.value === 'persona') ok = await savePersonaStep()
  else if (step.value === 'schedule') ok = await saveScheduleStep()
  if (!ok) return
  const i = STEP_LABELS.findIndex(s => s.step === step.value)
  if (i >= 0 && i < STEP_LABELS.length - 1) {
    await app.setOnboardingStep((STEP_LABELS[i + 1] as { step: OnboardingStep }).step)
  }
}

/** 最后一步：`completeOnboarding()` 会被主进程拒绝（有步骤没满足），必须把拒绝显示出来 */
async function finish(): Promise<void> {
  const ok = await saveScheduleStep()
  if (!ok) return
  await app.completeOnboarding()
}

/** 「稍后再说」按钮的进行中标志（防连点；失败时**不静默**） */
const skipping = ref(false)

/**
 * 「稍后再说」：把向导收起来，但**不代替用户做任何配置**。
 *
 * 它做的事只有一件：`patch({ onboarded: true })` —— 影响的是"还弹不弹"。
 * ⚠ 明确**不做**的事（写在这里，防止以后有人"顺手"扩大它的语义）：
 *   · 不写供应商 / 不填密钥 / 不选模型 / 不改人设；
 *   · 不调用 `onboarding:complete`（那条通道会被主进程的判据拒绝——这是**正确的**，
 *     我们不去绕过它，也不假装完成）；
 *   · 不隐藏任何告警：没配密钥时聊天仍然会如实报"还没有配置供应商"。
 * 失败时它把原因交给 store 的 `reportFailure`（可见告警），
 * 且**不会**乐观隐藏自己 —— 覆盖层还在，用户能看出"点了没用"。
 */
async function skip(): Promise<void> {
  if (skipping.value) return
  skipping.value = true
  try {
    await app.patch({ onboarded: true })
  } finally {
    skipping.value = false
  }
}

/**
 * 打开时把已有的 persona / quiet / policy 灌进草稿。
 *
 * 为什么在 `onMounted` 里做而不用 watch 直接覆盖：`App.vue` 的 `app.init()` 在
 * `onMounted` 里 await 完才挂载子组件，所以这里读到的通常就是真实值；
 * 下面的 watch 只在"数据还没到"时补一次预填，一旦灌过（`*Prefilled`）就不再动草稿，
 * 否则主进程推来一条 settings 更新就会把用户正在编辑的内容冲掉。
 */
onMounted(async () => {
  // 声音清单是懒加载的（null = 还没问过主进程）
  if (app.ttsVoices === null) await app.loadTtsVoices()
  hydrateFromStore()
})

function hydrateFromStore(): void {
  if (!prefilled.value) {
    const first = app.providers[0]
    if (first) {
      pForm.value = { id: first.id, label: first.label, kind: first.kind, baseUrl: first.baseUrl, model: first.model, apiKey: '' }
    }
    prefilled.value = true
  }
  if (!modelProviderId.value) {
    modelProviderId.value = (app.providers.find(p => p.active) ?? app.providers[0])?.id ?? ''
    const m = modelProvider.value?.model ?? ''
    selectedModel.value = m
    manualModel.value = ''
  }
  if (!personaPrefilled.value && app.persona) {
    persona.value = {
      name: app.persona.name,
      userTitle: app.persona.userTitle,
      personality: app.persona.personality,
      speakingStyle: app.persona.speakingStyle,
      greeting: app.persona.greeting,
      ttsEnabled: app.settings?.ttsEnabled ?? false,
      ttsVoice: app.settings?.ttsVoice ?? '',
    }
    personaPrefilled.value = true
  }
  if (!quietPrefilled.value && app.quiet && app.reminderPolicy) {
    quietDraft.value = { enabled: app.quiet.enabled, start: app.quiet.start, end: app.quiet.end }
    policyDraft.value = {
      continuousMinutes: app.reminderPolicy.continuousMinutes,
      sedentaryMinutes: app.reminderPolicy.sedentaryMinutes,
      nightRestAt: app.reminderPolicy.nightRestAt,
    }
    weatherDraft.value = app.settings?.weatherCity ?? ''
    quietPrefilled.value = true
  }
}

// 供应商/人设是异步加载的，第一次进向导时可能还没到位 ⇒ 到齐了就补一次预填
watch(() => [app.providers.length, app.persona?.id ?? '', app.quiet?.updatedAt ?? 0], () => hydrateFromStore())
</script>

<template>
  <!-- 覆盖层：绝对定位盖在面板上，<AvatarStage/> 仍然挂在它下面，不会被卸载 -->
  <div v-if="visible" class="wizard" role="dialog" aria-modal="true" aria-label="首次运行向导">
    <div class="wizard__card card">
      <header class="wizard__head">
        <div>
          <b>欢迎使用 · 先花两分钟把她配好</b>
          <p class="muted">每一步能否继续由**主进程**判定；界面只如实转述它给的理由。</p>
        </div>
        <span class="badge">{{ STEP_LABELS.findIndex(s => s.step === step) + 1 }} / {{ STEP_LABELS.length }}</span>
      </header>

      <nav class="wizard__steps">
        <span
          v-for="(s, i) in STEP_LABELS"
          :key="s.step"
          :class="['wizard__step', s.step === step ? 'is-on' : '', satisfiedFor(s.step) ? 'is-done' : '']"
        >{{ i + 1 }}. {{ s.label }}</span>
      </nav>

      <!-- ① 供应商 -->
      <section v-if="step === 'provider'" class="wizard__body">
        <label class="row"><span>标签</span><input v-model="pForm.label" type="text" placeholder="例：DeepSeek" /></label>
        <label class="row">
          <span>类型</span>
          <select v-model="pForm.kind">
            <option v-for="k in KIND_OPTIONS" :key="k.value" :value="k.value">{{ k.label }}</option>
          </select>
        </label>
        <label class="row"><span>baseUrl</span><input v-model="pForm.baseUrl" type="text" placeholder="https://api.deepseek.com/v1" /></label>
        <label class="row"><span>模型</span><input v-model="pForm.model" type="text" placeholder="deepseek-chat" /></label>
        <label class="row"><span>API 密钥</span><input v-model="pForm.apiKey" type="password" placeholder="sk-…" autocomplete="off" /></label>
        <p class="muted">
          密钥经 IPC 单向送到主进程，用操作系统密钥库（{{ app.backend }}）加密后落盘；
          <b>界面此后只能看到 hasKey / 指纹 / 长度，永远拿不回明文</b>。
          留空 = 保持已有密钥不变。
        </p>
        <p v-if="pForm.id" class="muted">正在编辑已有供应商 <b>{{ pForm.id }}</b>（密钥框留空即不改动它）。</p>
      </section>

      <!-- ② 测试 -->
      <section v-else-if="step === 'test'" class="wizard__body">
        <div v-if="app.providers.length === 0" class="muted">还没有供应商，请回到第 1 步添加。</div>
        <div v-for="p in app.providers" :key="p.id" class="wizard__item">
          <div class="row">
            <span>
              <b>{{ p.label }}</b>
              <span class="muted"> · {{ kindLabel(p.kind) }} · {{ p.model }}</span>
              <span :class="['badge', p.hasKey ? 'badge--ok' : 'badge--warn']">{{ p.hasKey ? '有密钥' : '无密钥' }}</span>
              <span v-if="p.active" class="badge badge--ok">生效中</span>
            </span>
            <span class="wizard__actions">
              <button class="tbtn tbtn--mini" :disabled="testing === p.id" @click="test(p.id)">
                {{ testing === p.id ? '测试中…' : '测试连接' }}
              </button>
              <button class="tbtn tbtn--mini" :disabled="p.active" @click="app.selectProvider(p.id)">设为生效</button>
            </span>
          </div>
          <div v-if="testResult[p.id]" class="wizard__result">
            <!-- 结果逐字段照抄主进程出参，不做任何美化或推断 -->
            <span :class="testResult[p.id]!.ok ? 'ok' : 'warn'">{{ testResult[p.id]!.ok ? '✓ 连通' : '✗ 失败' }}</span>
            <span class="badge">code {{ testResult[p.id]!.code }}</span>
            <span class="badge">延迟 {{ testResult[p.id]!.latencyMs ?? '—' }} ms</span>
            <span class="badge">模型数 {{ testResult[p.id]!.modelCount ?? '—' }}</span>
            <pre v-if="testResult[p.id]!.message" class="wizard__msg">{{ testResult[p.id]!.message }}</pre>
          </div>
        </div>
      </section>

      <!-- ③ 模型 -->
      <section v-else-if="step === 'model'" class="wizard__body">
        <label class="row">
          <span>供应商</span>
          <select v-model="modelProviderId">
            <option v-for="p in app.providers" :key="p.id" :value="p.id">{{ p.label }}（{{ p.model }}）</option>
          </select>
        </label>
        <button class="tbtn" :disabled="modelsLoading || !modelProviderId" @click="fetchModels()">
          {{ modelsLoading ? '拉取中…' : '从端点拉取模型' }}
        </button>
        <p v-if="modelsNote" class="muted">{{ modelsNote }}</p>
        <div v-if="models.length" class="wizard__models">
          <button
            v-for="m in models"
            :key="m"
            :class="['wizard__model', selectedModel === m ? 'is-on' : '']"
            @click="selectedModel = m; manualModel = ''"
          >{{ m }}</button>
        </div>
        <label class="row">
          <span>手输模型名</span>
          <input v-model="manualModel" type="text" placeholder="端点没有 /models 时直接写这里" @input="selectedModel = ''" />
        </label>
        <p class="muted">
          保存时只改 <b>model</b>：label / kind / baseUrl 原样透传，且**不带 apiKey 字段**（= 保留原密钥）。
          当前选中：<b>{{ manualModel || selectedModel || '（未选）' }}</b>
        </p>
      </section>

      <!-- ④ 人设 -->
      <section v-else-if="step === 'persona'" class="wizard__body">
        <div class="wizard__presets">
          <button v-for="p in PERSONA_PRESETS" :key="p.label" class="tbtn tbtn--mini" @click="applyPreset(p)">
            预设：{{ p.label }}
          </button>
        </div>
        <label class="row"><span>她的名字</span><input v-model="persona.name" type="text" placeholder="例：小满" /></label>
        <label class="row"><span>她怎么称呼你</span><input v-model="persona.userTitle" type="text" placeholder="例：你 / 主人 / 老板" /></label>
        <label class="row"><span>性格</span><textarea v-model="persona.personality" rows="3" /></label>
        <label class="row"><span>说话风格</span><textarea v-model="persona.speakingStyle" rows="2" /></label>
        <label class="row"><span>开场问候</span><textarea v-model="persona.greeting" rows="2" /></label>
        <label class="row">
          <span>回复时朗读</span>
          <input v-model="persona.ttsEnabled" type="checkbox" />
        </label>
        <label class="row">
          <span>声音</span>
          <select v-model="persona.ttsVoice" :disabled="!persona.ttsEnabled">
            <option value="">自动（中文优先）</option>
            <option v-for="v in app.ttsVoices ?? []" :key="v.id" :value="v.id">{{ v.label }}</option>
          </select>
        </label>
        <p v-if="app.ttsVoices && app.ttsVoices.length === 0" class="muted warn">
          本机没有可用的语音合成声音：朗读会返回结构化失败，不会假装成功。
        </p>
      </section>

      <!-- ⑤ 权限 -->
      <section v-else-if="step === 'permission'" class="wizard__body">
        <div v-if="blockedPermissions.length" class="wizard__floor">
          <b>以下能力永远无法启用（不是界面限制，是主进程的硬下限）</b>
          <ul>
            <li v-for="p in blockedPermissions" :key="p.kind">
              {{ p.label }} —— 硬下限 <code>{{ PERMISSION_TIER_FLOOR[asPermissionKind(p.kind) ?? 'payment'] }}</code>
              （实际生效：{{ p.effective }}）
            </li>
          </ul>
          <p class="muted">
            支付 / 改密码 / 读凭据 / 模拟键鼠 / 改系统设置由 `PERMISSION_TIER_FLOOR` + `effectiveTier()` 钉死，
            任何设置、任何模型输出都放宽不了它。勾选框是灰的，那是**正确**行为。
          </p>
        </div>
        <div v-for="p in app.permissions" :key="p.kind" class="wizard__item">
          <label class="row">
            <span>
              {{ p.label }}
              <span class="badge">{{ p.tier }}</span>
              <span :class="['badge', p.effective === 'blocked' ? 'badge--warn' : 'badge--ok']">生效 {{ p.effective }}</span>
              <span class="muted"> · {{ p.grantedBy }}</span>
            </span>
            <input
              type="checkbox"
              :checked="p.enabled"
              :disabled="p.effective === 'blocked'"
              @change="app.setPermission({ kind: p.kind, enabled: ($event.target as HTMLInputElement).checked })"
            />
          </label>
          <p v-if="asPermissionKind(p.kind) && effectiveTier(asPermissionKind(p.kind) as PermissionKind, p.tier as 'read-only'|'confirm'|'blocked') !== p.tier" class="muted">
            你请求的是 {{ p.tier }}，被硬下限收紧成了 {{ p.effective }}。
          </p>
        </div>
        <p class="muted">这一步存在的意义就是让你**实际看过一遍**这些开关，而不是闭着眼点下一步。</p>
      </section>

      <!-- ⑥ 日程 / 隐私 -->
      <section v-else class="wizard__body">
        <h4 class="wizard__h4">静音时段</h4>
        <label class="row"><span>启用</span><input v-model="quietDraft.enabled" type="checkbox" /></label>
        <label class="row"><span>开始</span><input v-model="quietDraft.start" type="time" /></label>
        <label class="row"><span>结束</span><input v-model="quietDraft.end" type="time" /></label>
        <p class="muted">支持跨午夜（例 23:00 → 07:30）。静音时段内提醒只进队列，不弹窗、不发声、不抢焦点。</p>

        <h4 class="wizard__h4">提醒阈值</h4>
        <label class="row"><span>连续使用提醒（分钟）</span><input v-model.number="policyDraft.continuousMinutes" type="number" min="5" max="600" /></label>
        <label class="row"><span>久坐提醒（分钟）</span><input v-model.number="policyDraft.sedentaryMinutes" type="number" min="5" max="600" /></label>
        <label class="row"><span>夜间休息时间</span><input v-model="policyDraft.nightRestAt" type="time" /></label>

        <h4 class="wizard__h4">天气与遥测</h4>
        <label class="row"><span>城市</span><input v-model="weatherDraft" type="text" placeholder="例：杭州（留空 = 不播报天气）" /></label>
        <p class="muted">
          **留空就是"没有天气"**：早安电台会如实标注"本机未配置城市"，
          绝不会编一个天气出来。天气不需要密钥（Open-Meteo）。
        </p>
        <label class="row">
          <span>遥测（默认关闭）</span>
          <input
            type="checkbox"
            :checked="app.settings?.telemetryEnabled ?? false"
            @change="app.patch({ telemetryEnabled: ($event.target as HTMLInputElement).checked })"
          />
        </label>
        <p class="muted">关闭时不发送任何数据，只保留本机日志。这段设置随时可在「设置 → 隐私与数据」里改。</p>
      </section>

      <!-- 主进程给的阻塞原因：**永远显示**（它就是"为什么按钮灰着"的答案） -->
      <p v-if="hint" :class="['wizard__hint', currentSatisfied ? 'muted' : 'warn']">
        主进程：{{ hint }}
      </p>

      <footer class="wizard__foot">
        <button class="tbtn" :disabled="!canGoBack" @click="app.setOnboardingStep(backStep)">上一步</button>
        <span class="muted">
          第 {{ STEP_LABELS.findIndex(s => s.step === step) + 1 }} 步 ·
          {{ currentSatisfied ? '判据已满足' : `未满足${app.onboarding?.blockedBy ? `（${app.onboarding.blockedBy}）` : ''}` }}
        </span>
        <!--
          ★★ 2026-10-06 修掉一个**死锁**（用户实际卡在这里，无法开始使用）：

          原来两个分支都写 `:disabled="!currentSatisfied"`。而第一步（provider）的判据是
          "**存在供应商且它有密钥**"，而**保存供应商的唯一入口就是这个按钮**：

              判据要先满足 ⇒ 才让你点保存
              而要满足判据 ⇒ 得先点保存
              ⇒ **永远出不去**（按钮恒灰，providers.json 永远是空的）

          为什么第一步必须放开：它的"保存"动作**就是创建那个判据本身**（`saveProvider()`
          → `provider:upsert`），所以不可能拿判据来挡它。校验仍然**由 `next()` 承担**：
            · `saveProvider()` 在字段不全 / baseUrl 非法时返回 false 并弹可见告警 ⇒ 停在原地；
            · 保存成功但主进程判据仍不满足（例如密钥后端不可用）时，
              `setOnboardingStep` 会走 `advanceOnboarding`，主进程**把你退回未满足的步骤** ⇒ 仍出不去。
          ⇒ 放开禁用**不会**让任何未满足的状态被当成满足，只是把"判定权"从禁用态还给主进程。

          其余步骤保持原样：它们的判据（测试通过 / 模型已选 / 人设已填）由**各自步骤内的动作**
          产生（如「测试连接」按钮），用 disabled 先挡一层是合适的。
        -->
        <button v-if="step !== 'schedule'" class="tbtn tbtn--primary" :disabled="step !== 'provider' && !currentSatisfied" @click="next()">保存并继续</button>
        <button v-else class="tbtn tbtn--primary" :disabled="savingSchedule" @click="finish()">完成设置</button>
      </footer>
      <!--
        ★★ 2026-10-08：把"跳过"从**文案**变成**真的按钮**。

        为什么必须补（实测踩到，而且后果很重）：
          下面这句文案一直写着"不想现在配？到「设置」里可以随时回来"——**承诺了一条跳过路径**。
          但代码里根本没有跳过的入口（上面的 `next()`/`finish()` 都会被主进程的判据挡住），
          而 `ipc.ts` 的 `onboarding:complete` **明确拒绝**"未满足的步骤"（`blockedBy !== null` ⇒ err）。
          ⇒ 没有供应商密钥的用户**永远出不去这个覆盖层**。
          它在 **pet 模式**下尤其致命：向导是 `position:absolute; inset:0` 的全屏覆盖层
          （`rgba(8,9,14,.72)` + 模糊），会把**角色整个盖住** —— 桌宠的核心体验直接没了。
          用户实测表现就是"桌宠看不见了"（本轮我就是先把它误判成"窗口不上屏"才查到这里）。

        语义边界（**非常重要，不许含糊**）：
          · 它**只**把 `settings.onboarded` 置真 ⇒ 影响的是"**还弹不弹**"；
          · 它**不**代替用户配置任何东西：不写供应商、不填密钥、不选模型、不改人设；
          · 它**不**让任何"未满足的判据"变成满足（`app.onboarding.blockedBy` 不会因此变化）；
          · "设置 → 隐私与数据 → 重置首次运行向导"随时可以把它请回来。
        也就是说：这个按钮兑现的是那句文案，而不是在绕过验收。
      -->
      <p class="muted wizard__skip">
        不想现在配？
        <button class="tbtn tbtn--mini" :disabled="skipping" @click="skip()">稍后再说</button>
        · 到「设置」里可以随时回来（重置向导：设置 → 隐私与数据 → 重置首次运行向导）
      </p>
    </div>
  </div>
</template>
