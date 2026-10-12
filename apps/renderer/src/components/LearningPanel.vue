<script setup lang="ts">
/**
 * LearningPanel.vue —— 每日自学习（M4）
 *
 * 这一页要回答用户最该关心的三件事：
 *   ① **她学了什么**（每天的反思结果 + 提取项，含置信度与来源）
 *   ② **哪些还没确认**（低置信度内容必须由你点头才会写进长期记忆）
 *   ③ **怎么关掉 / 怎么删**（默认关闭；可清空反思记录；彻底删除走隐私页）
 *
 * 三条纪律：
 *   · **默认关闭**：开关初始为关，界面如实显示"未启用"；
 *   · **置信度可见**：每条都显示置信度与阈值 —— "多高才算高"不能是黑盒；
 *   · **她不会改你的设置**：这一页明确写出"只影响记忆，不改人设/权限/系统设置"，
 *     因为那是用户最担心的越权行为。
 */
import { computed, onMounted, ref } from 'vue'
import { useApp } from '../store'
import { bridge } from '../bridge'

interface ReflectionItem {
  id: string
  kind: string
  text: string
  confidence: number
  approval: string
  evidence: { messageCount: number, ruleId: string }
  memoryId: string | null
  createdAt: number
  day?: string
}
interface DailyReflection {
  day: string
  generatedAt: number
  dailySummary: string
  stats: {
    messages: number, userMessages: number, assistantMessages: number,
    proactiveMessages: number, memoryHits: number, activeMinutes: number
  }
  items: ReflectionItem[]
  workRhythm: { avgActiveMinutes: number, maxStreakMinutes: number, topHours: number[], sampleDays: number, confident: boolean }
  tomorrowAdvice: string[]
  externalRefs: Array<{ title: string, source: string, date: string | null }>
  method: string
  disclosures: string[]
  autoWritten: number
  pendingApproval: number
}
interface ReflectionStatus {
  enabled: boolean
  at: string
  lastRunAt: number | null
  lastRunDay: string | null
  runs: number
  pendingCount: number
  autoWrittenTotal: number
  rejectedTotal: number
  highConfidence: number
}

const app = useApp()
const busy = ref(false)
const status = ref<ReflectionStatus | null>(null)
const history = ref<DailyReflection[]>([])
const pending = ref<ReflectionItem[]>([])
const openDay = ref<string | null>(null)

/** 类别中文名（与 shared 的 ReflectionItemKind 一一对应） */
const KIND_LABEL: Record<string, string> = {
  preference: '偏好', fact: '重要事实', todo: '待办', emotion: '情绪', habit: '习惯',
}
const APPROVAL_LABEL: Record<string, string> = {
  auto: '已自动写入记忆', pending: '等你确认', rejected: '你已拒绝', skipped: '曾拒绝过，跳过',
}

const current = computed(() => history.value.find(d => d.day === openDay.value) ?? history.value[0] ?? null)
/** 阈值（端点可能还没加载完 ⇒ 给一个与 shared 的 HIGH_CONFIDENCE 一致的缺省值） */
const threshold = computed(() => status.value?.highConfidence ?? 0.75)

async function refresh(): Promise<void> {
  busy.value = true
  try {
    const s = await bridge.reflectionStatus() as unknown as { status?: ReflectionStatus }
    status.value = s.status ?? null
    const h = await bridge.reflectionHistory(30) as unknown as { days?: DailyReflection[] }
    history.value = h.days ?? []
    // `noUncheckedIndexedAccess` 下 `history.value[0]` 是可能 undefined 的 ⇒ 显式判空
    const first = history.value[0]
    if (!openDay.value && first) openDay.value = first.day
    const p = await bridge.reflectionPending() as unknown as { items?: ReflectionItem[] }
    pending.value = p.items ?? []
  } catch (e) {
    app.reportFailure('读取自学习状态失败', e)
  } finally {
    busy.value = false
  }
}

/** 手动跑一次（force：忽略"今天跑过了"）。**不 dryRun** —— 用户点它就是要真的学一次。 */
async function runNow(): Promise<void> {
  busy.value = true
  try {
    const r = await bridge.reflectionRun({ force: true, dryRun: false }) as unknown as {
      ran?: boolean, skippedReason?: string | null, reflection?: DailyReflection
    }
    if (r.ran) {
      const n = r.reflection?.items.length ?? 0
      app.toast('info', '反思完成', `提取 ${n} 条；自动写入记忆 ${r.reflection?.autoWritten ?? 0} 条；待你确认 ${r.reflection?.pendingApproval ?? 0} 条`, false)
    } else {
      app.toast('warn', '这次没有执行', r.skippedReason ?? undefined, false)
    }
    await refresh()
  } catch (e) {
    app.reportFailure('执行反思失败', e)
  } finally {
    busy.value = false
  }
}

/** 预览（dryRun）：只看报告，**不写任何记忆** */
async function preview(): Promise<void> {
  busy.value = true
  try {
    const r = await bridge.reflectionRun({ force: true, dryRun: true }) as unknown as { reflection?: DailyReflection }
    if (r.reflection) {
      app.toast('info', '演练完成（未写入任何记忆）', `会提取 ${r.reflection.items.length} 条；其中 ${r.reflection.items.filter(i => i.confidence >= threshold.value).length} 条达到自动写入阈值`, false)
    }
    await refresh()
  } catch (e) {
    app.reportFailure('演练失败', e)
  } finally {
    busy.value = false
  }
}

async function decide(item: ReflectionItem, approve: boolean): Promise<void> {
  try {
    const r = await bridge.reflectionDecide(item.day ?? '', item.id, approve) as unknown as { memoryId?: string | null }
    if (approve && !r.memoryId) {
      app.toast('warn', '确认了但没能写入记忆', '已保持"待确认"状态，稍后再试', false)
    } else {
      app.toast('info', approve ? '已记下了' : '好，不再问这件事', approve ? undefined : '同一件事以后不会再问你', false)
    }
    await refresh()
  } catch (e) {
    app.reportFailure('处理失败', e)
  }
}

async function clearAll(): Promise<void> {
  try {
    const r = await bridge.reflectionClear() as unknown as { removedDays?: number }
    app.toast('info', '已清空反思记录', `删除 ${r.removedDays ?? 0} 天；**已写入的记忆没有动**（要删记忆请到记忆页）`, false)
    openDay.value = null
    await refresh()
  } catch (e) {
    app.reportFailure('清空失败', e)
  }
}

onMounted(() => { void refresh() })

function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}
function fmtTime(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}
/** 是否达到自动写入阈值（UI 用颜色区分，避免"为什么这条没写进去"的困惑） */
function isHigh(item: ReflectionItem): boolean {
  return item.confidence >= threshold.value
}
</script>

<template>
  <div class="learning">
    <!-- ── 开关与状态 -->
    <section class="card">
      <h3>自学习（默认关闭）</h3>
      <label class="row">
        <span>启用每日反思</span>
        <input
          type="checkbox"
          :checked="status?.enabled ?? false"
          @change="app.patch({ selfLearningEnabled: ($event.target as HTMLInputElement).checked }).then(refresh)"
        />
      </label>
      <label class="row">
        <span>每天执行时间</span>
        <input
          type="time"
          :value="status?.at ?? '22:30'"
          :disabled="!status?.enabled"
          @change="app.patch({ selfLearningAt: ($event.target as HTMLInputElement).value || '22:30' }).then(refresh)"
        />
      </label>
      <div class="row">
        <span>置信度阈值</span><b>{{ pct(status?.highConfidence ?? 0.75) }}</b>
        <span class="muted">达到它才自动写入记忆；低于它一律等你确认</span>
      </div>
      <div class="row">
        <span>已运行</span><b>{{ status?.runs ?? 0 }}</b>
        <span class="muted">上次 {{ fmtTime(status?.lastRunAt ?? null) }}</span>
      </div>
      <div class="row">
        <span>自动写入记忆</span><b>{{ status?.autoWrittenTotal ?? 0 }}</b>
        <span>待你确认</span><b :class="(status?.pendingCount ?? 0) > 0 ? 'warn' : ''">{{ status?.pendingCount ?? 0 }}</b>
        <span>你拒绝过</span><b>{{ status?.rejectedTotal ?? 0 }}</b>
      </div>
      <div class="row">
        <button class="tbtn" :disabled="busy" @click="runNow">现在反思一次</button>
        <button class="tbtn" :disabled="busy" @click="preview">只看报告（不写记忆）</button>
        <button class="tbtn" :disabled="busy" @click="refresh">刷新</button>
      </div>
      <p class="muted">
        边界（重要）：自学习**只影响记忆** —— 它**不会**修改代码、系统提示词、权限或任何电脑设置。
        每次反思会同时生成"今日总结"和"明日建议"，建议只基于真实读数（说话条数、活跃分钟、连续时长），读数不足时它不会硬给建议。
      </p>
    </section>

    <!-- ── 待确认（M4 的核心交互） -->
    <section class="card">
      <h3>等她确认的（低置信度）</h3>
      <p class="muted">
        这些是她**不确定**的推断（置信度低于 {{ pct(status?.highConfidence ?? 0.75) }}），所以**没有**写进长期记忆。
        你点「记下来」才会真的记住；点「不用了」之后，同一件事不会再问你第二遍。
      </p>
      <p v-if="pending.length === 0" class="muted">（暂时没有待确认的）</p>
      <div v-for="it in pending" :key="it.id" class="pending-item">
        <div class="row">
          <span class="badge">{{ KIND_LABEL[it.kind] ?? it.kind }}</span>
          <b>{{ it.text }}</b>
        </div>
        <div class="row muted">
          <span>置信度 {{ pct(it.confidence) }}</span>
          <span>依据：命中规则 <span class="mono">{{ it.evidence.ruleId }}</span> × {{ it.evidence.messageCount }}</span>
          <span>{{ it.day }}</span>
        </div>
        <div class="row">
          <button class="tbtn" @click="decide(it, true)">记下来</button>
          <button class="tbtn tbtn--mini" @click="decide(it, false)">不用了，别再问</button>
        </div>
      </div>
    </section>

    <!-- ── 历史 -->
    <section class="card">
      <h3>反思历史</h3>
      <div class="row">
        <select :value="openDay ?? ''" @change="openDay = ($event.target as HTMLSelectElement).value">
          <option v-for="d in history" :key="d.day" :value="d.day">
            {{ d.day }}（{{ d.items.length }} 条 · 自动 {{ d.autoWritten }} · 待确认 {{ d.pendingApproval }}）
          </option>
        </select>
        <button class="tbtn tbtn--danger" :disabled="busy || history.length === 0" @click="clearAll">清空反思记录</button>
      </div>
      <p v-if="history.length === 0" class="muted">（还没有反思记录）</p>

      <template v-if="current">
        <div class="sub">
          <b>今日总结（{{ current.day }}）</b>
          <p>{{ current.dailySummary }}</p>
          <div class="row muted">
            <span>消息 {{ current.stats.messages }}</span>
            <span>你说了 {{ current.stats.userMessages }}</span>
            <span>我回了 {{ current.stats.assistantMessages }}</span>
            <span>主动 {{ current.stats.proactiveMessages }}</span>
            <span>活跃 {{ current.stats.activeMinutes }} 分钟</span>
            <span>提取方式 {{ current.method }}</span>
          </div>
        </div>

        <div class="sub">
          <b>工作节奏</b>
          <div class="row muted">
            <span>样本 {{ current.workRhythm.sampleDays }} 天</span>
            <span>平均活跃 {{ current.workRhythm.avgActiveMinutes }} 分钟</span>
            <span>最长连续 {{ current.workRhythm.maxStreakMinutes }} 分钟</span>
            <span>活跃时段 {{ current.workRhythm.topHours.length ? current.workRhythm.topHours.map(h => h + '点').join('、') : '—' }}</span>
          </div>
          <p v-if="!current.workRhythm.confident" class="muted warn">
            样本不足 {{ current.workRhythm.sampleDays }} 天 ⇒ **不下结论**（三天数据推不出你的工作节奏）。
          </p>
        </div>

        <div class="sub">
          <b>提取项（{{ current.items.length }}）</b>
          <div v-for="it in current.items" :key="it.id" class="learned-item">
            <span class="badge" :class="isHigh(it) ? 'badge--ok' : 'badge--muted'">{{ KIND_LABEL[it.kind] ?? it.kind }}</span>
            <span>{{ it.text }}</span>
            <span class="muted">置信度 {{ pct(it.confidence) }} · {{ APPROVAL_LABEL[it.approval] ?? it.approval }}</span>
            <span v-if="it.memoryId" class="muted mono">memory {{ it.memoryId }}</span>
          </div>
        </div>

        <div v-if="current.tomorrowAdvice.length" class="sub">
          <b>明日建议</b>
          <ul>
            <li v-for="(a, i) in current.tomorrowAdvice" :key="i">{{ a }}</li>
          </ul>
        </div>

        <div v-if="current.externalRefs.length" class="sub">
          <b>参考的外部资料（含来源与日期）</b>
          <div v-for="(r, i) in current.externalRefs" :key="i" class="muted">
            · {{ r.title }} <span class="mono">— {{ r.source }}{{ r.date ? ` · ${r.date}` : '' }}</span>
          </div>
        </div>

        <div v-if="current.disclosures.length" class="sub">
          <b>说明</b>
          <div v-for="(d, i) in current.disclosures" :key="i" class="muted">· {{ d }}</div>
        </div>
      </template>
    </section>
  </div>
</template>
