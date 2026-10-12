<script setup lang="ts">
/**
 * SchedulePanel.vue —— 日程 / 提醒 / 提醒中心（M2）
 *
 * 设计要点（都是"不这么做就会骗人"的地方）：
 *   · **客户端校验必须与主进程同口径**：`weekly` 至少要一个星期几、`once` 必须有日期、
 *     `monthly` 必须有几号 —— 这些在 `packages/shared/src/proactive.ts` 里是 zod refine 的判据。
 *     前端先挡一次只是省一趟 IPC；**主进程仍然会再判**，所以拒绝原因要原样显示出来。
 *   · 被阻断的提醒是**进队列**，不是丢弃。界面上必须写清楚"什么时候会补发"，
 *     否则用户会以为提醒丢了，然后就不再信任这个功能。
 *   · 提醒优先级的三句解释是写给用户看的（重要/普通/静默的行为差异），不写就等于没给选择。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { Priority, RecurrenceKind, ReminderKind, Schedule } from '@airimate/shared'
import { useApp } from '../store'

const app = useApp()

/** 0 = 周日 … 6 = 周六（**必须与 `ScheduleRecurrence.weekdays` 的约定一致**） */
const WEEKDAYS: Array<{ value: number, label: string }> = [
  { value: 1, label: '一' }, { value: 2, label: '二' }, { value: 3, label: '三' },
  { value: 4, label: '四' }, { value: 5, label: '五' }, { value: 6, label: '六' },
  { value: 0, label: '日' },
]

const RECURRENCE_KINDS: Array<{ value: RecurrenceKind, label: string }> = [
  { value: 'once', label: '仅一次' },
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '工作日（周一至周五）' },
  { value: 'weekly', label: '每周（选星期几）' },
  { value: 'monthly', label: '每月（选几号）' },
]

const REMINDER_KINDS: Array<{ value: ReminderKind, label: string }> = [
  { value: 'scheduled', label: '定时提醒' },
  { value: 'custom', label: '自定义提醒' },
  { value: 'continuous', label: '连续使用提醒（引擎按阈值触发）' },
  { value: 'sedentary', label: '久坐提醒（引擎按活动量触发）' },
  { value: 'night', label: '夜间休息提醒（引擎按时间触发）' },
]

/** 三档优先级的行为差异 —— 不解释清楚，用户就没法做选择 */
const PRIORITIES: Array<{ value: Priority, label: string, note: string }> = [
  { value: 'important', label: '重要', note: '会弹窗；被阻断时进队列，条件结束后补发' },
  { value: 'normal', label: '普通', note: '会弹窗；被阻断时进队列' },
  { value: 'silent', label: '静默', note: '只进通知中心，不弹窗、不发声' },
]

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

/* ───────────────────────── 日程表单 */
const sForm = ref({
  id: '' as string,
  title: '',
  start: '09:00',
  end: '',
  leadMinutes: 10,
  kind: 'daily' as RecurrenceKind,
  weekdays: [] as number[],
  dayOfMonth: 1,
  date: '',
  important: false,
  announceInRadio: true,
  note: '',
})
const sError = ref('')

function toggleWeekday(d: number): void {
  const i = sForm.value.weekdays.indexOf(d)
  if (i >= 0) sForm.value.weekdays.splice(i, 1)
  else sForm.value.weekdays.push(d)
}

function resetScheduleForm(): void {
  sForm.value = {
    id: '', title: '', start: '09:00', end: '', leadMinutes: 10, kind: 'daily',
    weekdays: [], dayOfMonth: 1, date: '', important: false, announceInRadio: true, note: '',
  }
  sError.value = ''
}

function editSchedule(s: Schedule): void {
  sForm.value = {
    id: s.id,
    title: s.title,
    start: s.start,
    end: s.end ?? '',
    leadMinutes: s.leadMinutes,
    kind: s.recurrence.kind,
    weekdays: [...s.recurrence.weekdays],
    dayOfMonth: s.recurrence.dayOfMonth ?? 1,
    date: s.recurrence.date ?? '',
    important: s.important,
    announceInRadio: s.announceInRadio,
    note: s.note,
  }
  sError.value = ''
}

/** 与主进程同口径的本地校验；返回错误文案（空串 = 通过） */
function validateSchedule(): string {
  const f = sForm.value
  if (!f.title.trim()) return '标题不能为空'
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.start)) return '开始时间必须是 HH:MM'
  if (f.end && !/^([01]\d|2[0-3]):[0-5]\d$/.test(f.end)) return '结束时间必须是 HH:MM'
  if (f.kind === 'weekly' && f.weekdays.length === 0) return '每周重复必须至少选一个星期几'
  if (f.kind === 'once' && !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return '仅一次必须给出日期（YYYY-MM-DD）'
  if (f.kind === 'monthly' && (!Number.isInteger(f.dayOfMonth) || f.dayOfMonth < 1 || f.dayOfMonth > 31)) {
    return '每月重复必须给出 1–31 之间的日期号'
  }
  /**
   * ⚠ `v-model.number` 在输入框被清空时给出的是**空串**（TS 看不出来，因为两边都声明成 number）。
   *   不显式挡一次就会把一个空串当数字发给主进程，换回一条 zod 报错。
   */
  if (!Number.isInteger(f.leadMinutes) || f.leadMinutes < 0 || f.leadMinutes > 720) {
    return '提前提醒分钟数必须是 0–720 的整数'
  }
  return ''
}

async function submitSchedule(): Promise<void> {
  sError.value = validateSchedule()
  if (sError.value) return
  const f = sForm.value
  const payload: Record<string, unknown> = {
    title: f.title.trim(),
    start: f.start,
    end: f.end || null,
    leadMinutes: f.leadMinutes,
    recurrence: {
      kind: f.kind,
      weekdays: f.kind === 'weekly' ? [...f.weekdays].sort((a, b) => a - b) : [],
      dayOfMonth: f.kind === 'monthly' ? f.dayOfMonth : null,
      date: f.kind === 'once' ? f.date : null,
    },
    important: f.important,
    announceInRadio: f.announceInRadio,
    note: f.note,
  }
  if (f.id) payload.id = f.id
  const ok = await app.upsertSchedule(payload)
  // 失败时**不清空表单**：用户不该因为主进程拒绝就丢掉刚敲的内容（原因已在 toast 里）
  if (ok) resetScheduleForm()
}

/* ───────────────────────── 提醒表单 */
const rForm = ref({
  id: '' as string,
  kind: 'scheduled' as ReminderKind,
  title: '',
  body: '',
  priority: 'normal' as Priority,
  atTime: '09:00',
  atDate: '',
  /** `datetime-local` 的值；非空时**优先**换算成 `fireAt`（避开"日期+时间"两段式的心智负担） */
  atLocal: '',
})
const rError = ref('')

const NEEDS_TIME = computed(() => rForm.value.kind === 'scheduled' || rForm.value.kind === 'custom')

function resetReminderForm(): void {
  rForm.value = {
    id: '', kind: 'scheduled', title: '', body: '', priority: 'normal',
    atTime: '09:00', atDate: '', atLocal: '',
  }
  rError.value = ''
}

function editReminder(id: string): void {
  const r = app.reminders.find(x => x.id === id)
  if (!r) return
  const d = new Date(r.fireAt)
  const p = (n: number): string => String(n).padStart(2, '0')
  rForm.value = {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    priority: r.priority,
    atTime: `${p(d.getHours())}:${p(d.getMinutes())}`,
    atDate: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    atLocal: '',
  }
  rError.value = ''
}

async function submitReminder(): Promise<void> {
  rError.value = ''
  const f = rForm.value
  if (!f.title.trim()) { rError.value = '标题不能为空'; return }
  const payload: Record<string, unknown> = {
    kind: f.kind,
    title: f.title.trim(),
    body: f.body,
    priority: f.priority,
  }
  if (f.id) payload.id = f.id
  if (NEEDS_TIME.value) {
    if (f.atLocal) {
      const ts = new Date(f.atLocal).getTime()
      if (!Number.isFinite(ts)) { rError.value = '时间格式无法解析'; return }
      payload.fireAt = ts
    } else if (f.atTime) {
      // 主进程的便捷写法：`atTime`（+ 可选 `atDate`，缺省今天）⇒ 它自己换算成 fireAt
      payload.atTime = f.atTime
      if (f.atDate) payload.atDate = f.atDate
    } else {
      rError.value = '定时提醒必须给出时间（或直接给 fireAt 时间戳）'
      return
    }
  }
  const ok = await app.upsertReminder(payload)
  if (ok) resetReminderForm()
}

/* ───────────────────────── 静音时段 */
const quietDraft = ref({ enabled: true, start: '23:00', end: '07:30' })
/** 只灌一次草稿：用户改了一半时绝不能被主进程推来的更新冲掉 */
const quietHydrated = ref(false)

function hydrateQuiet(): void {
  if (quietHydrated.value || !app.quiet) return
  quietDraft.value = { enabled: app.quiet.enabled, start: app.quiet.start, end: app.quiet.end }
  quietHydrated.value = true
}

async function refreshActivity(): Promise<void> {
  await app.loadActivity()
  hydrateQuiet()
}

onMounted(() => {
  hydrateQuiet()
  void app.loadActivity()
  void app.loadInbox()
  void app.loadProactiveStatus()
})

// 静音设置是异步加载的；到齐了就补一次预填（之后不再动草稿）
watch(() => app.quiet?.updatedAt ?? 0, () => hydrateQuiet())

/** 静音时段改动 = 动到 `quiet.updatedAt` ⇒ 向导"日程"步骤也会随之满足（判据在主进程） */
async function saveQuiet(): Promise<void> {
  await app.setQuiet({
    enabled: quietDraft.value.enabled,
    start: quietDraft.value.start,
    end: quietDraft.value.end,
  })
}

function fmtTs(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

const queued = computed(() => app.inbox?.queued ?? [])
const unacked = computed(() => app.inbox?.unacked ?? [])
const recent = computed(() => app.inbox?.recent ?? [])
</script>

<template>
  <div class="sched">
    <!-- 静音时段 + 实时阻断读数 -->
    <section class="card">
      <h3>静音时段与当前阻断</h3>
      <label class="row"><span>启用</span><input v-model="quietDraft.enabled" type="checkbox" @change="saveQuiet()" /></label>
      <label class="row"><span>开始</span><input v-model="quietDraft.start" type="time" @change="saveQuiet()" /></label>
      <label class="row"><span>结束</span><input v-model="quietDraft.end" type="time" @change="saveQuiet()" /></label>
      <p class="muted">
        支持跨午夜（例 23:00 → 07:30）。静音时段内**不弹窗、不发声、不抢焦点**；
        该送达的提醒会进队列，等静音结束后补发。
      </p>
      <div class="row">
        <span>现在是否会被拦下</span>
        <b :class="app.activity?.blocked ? 'warn' : 'ok'">
          {{ app.activity ? blockText(app.activity.blockReason) : '读数未加载' }}
        </b>
      </div>
      <p v-if="app.activity && !app.activity.available" class="muted warn">
        活动采样不可用：{{ app.activity.unavailableReason ?? '原因未给出' }}
        —— 这种情况下引擎不会瞎猜状态，只会保守地不打扰。
      </p>
      <button class="tbtn tbtn--mini" @click="refreshActivity()">刷新读数</button>
    </section>

    <!-- 日程 CRUD -->
    <section class="card">
      <h3>日程{{ sForm.id ? '（编辑）' : '' }}</h3>
      <label class="row"><span>标题</span><input v-model="sForm.title" type="text" placeholder="例：周会" /></label>
      <label class="row"><span>开始</span><input v-model="sForm.start" type="time" /></label>
      <label class="row"><span>结束（可空）</span><input v-model="sForm.end" type="time" /></label>
      <label class="row">
        <span>提前提醒（分钟）</span>
        <input v-model.number="sForm.leadMinutes" type="number" min="0" max="720" />
      </label>
      <label class="row">
        <span>重复</span>
        <select v-model="sForm.kind">
          <option v-for="k in RECURRENCE_KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
        </select>
      </label>
      <div v-if="sForm.kind === 'once'" class="row">
        <span>日期</span>
        <input v-model="sForm.date" type="date" />
      </div>
      <div v-if="sForm.kind === 'weekly'" class="row">
        <span>星期几</span>
        <span class="sched__weekdays">
          <label v-for="d in WEEKDAYS" :key="d.value" class="sched__wd">
            <input type="checkbox" :checked="sForm.weekdays.includes(d.value)" @change="toggleWeekday(d.value)" />
            {{ d.label }}
          </label>
        </span>
      </div>
      <label v-if="sForm.kind === 'monthly'" class="row">
        <span>每月几号</span>
        <input v-model.number="sForm.dayOfMonth" type="number" min="1" max="31" />
      </label>
      <label class="row"><span>重要（静音时段也允许弹窗）</span><input v-model="sForm.important" type="checkbox" /></label>
      <label class="row"><span>参与早安电台播报</span><input v-model="sForm.announceInRadio" type="checkbox" /></label>
      <label class="row"><span>备注</span><textarea v-model="sForm.note" rows="2" /></label>
      <p v-if="sError" class="warn">表单校验未通过：{{ sError }}</p>
      <div class="row">
        <span class="muted">共 {{ app.schedules.length }} 条日程</span>
        <span class="sched__actions">
          <button class="tbtn tbtn--mini tbtn--primary" @click="submitSchedule()">{{ sForm.id ? '保存日程' : '添加日程' }}</button>
          <button v-if="sForm.id" class="tbtn tbtn--mini" @click="resetScheduleForm()">取消编辑</button>
        </span>
      </div>

      <div v-if="app.schedules.length === 0" class="muted">还没有日程。</div>
      <div v-for="s in app.schedules" :key="s.id" class="sched__item">
        <div class="row">
          <span>
            <b>{{ s.title }}</b>
            <span class="badge">{{ s.start }}{{ s.end ? `–${s.end}` : '' }}</span>
            <span class="badge">{{ RECURRENCE_KINDS.find(k => k.value === s.recurrence.kind)?.label ?? s.recurrence.kind }}</span>
            <span v-if="s.recurrence.kind === 'weekly'" class="badge">{{ s.recurrence.weekdays.join('、') }}</span>
            <span v-if="s.recurrence.kind === 'monthly'" class="badge">{{ s.recurrence.dayOfMonth }} 号</span>
            <span v-if="s.recurrence.date" class="badge">{{ s.recurrence.date }}</span>
            <span v-if="s.important" class="badge badge--warn">重要</span>
            <span v-if="s.leadMinutes" class="badge">提前 {{ s.leadMinutes }} 分钟</span>
          </span>
          <span class="sched__actions">
            <button class="tbtn tbtn--mini" @click="editSchedule(s)">编辑</button>
            <button class="tbtn tbtn--mini tbtn--danger" @click="app.deleteSchedule(s.id)">删除</button>
          </span>
        </div>
        <div v-if="s.note" class="muted">{{ s.note }}</div>
      </div>
    </section>

    <!-- 提醒 CRUD -->
    <section class="card">
      <h3>提醒{{ rForm.id ? '（编辑）' : '' }}</h3>
      <label class="row">
        <span>种类</span>
        <select v-model="rForm.kind">
          <option v-for="k in REMINDER_KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
        </select>
      </label>
      <label class="row"><span>标题</span><input v-model="rForm.title" type="text" placeholder="例：站起来走两分钟" /></label>
      <label class="row"><span>正文（可空）</span><textarea v-model="rForm.body" rows="2" /></label>
      <label class="row">
        <span>优先级</span>
        <select v-model="rForm.priority">
          <option v-for="p in PRIORITIES" :key="p.value" :value="p.value">{{ p.label }} —— {{ p.note }}</option>
        </select>
      </label>
      <template v-if="NEEDS_TIME">
        <label class="row"><span>时刻（HH:MM）</span><input v-model="rForm.atTime" type="time" /></label>
        <label class="row"><span>日期（可空 = 今天）</span><input v-model="rForm.atDate" type="date" /></label>
        <label class="row"><span>或：具体时间点</span><input v-model="rForm.atLocal" type="datetime-local" /></label>
        <p class="muted">给了右边这个具体时间点就优先用它（渲染层直接换算成 `fireAt` 时间戳）。</p>
      </template>
      <p v-else class="muted">
        这一类的触发时刻由**引擎按阈值**写入（连续使用 / 久坐 / 夜间），所以这里不需要给时间。
      </p>
      <p v-if="rError" class="warn">表单校验未通过：{{ rError }}</p>
      <div class="row">
        <span class="muted">共 {{ app.reminders.length }} 条提醒</span>
        <span class="sched__actions">
          <button class="tbtn tbtn--mini tbtn--primary" @click="submitReminder()">{{ rForm.id ? '保存提醒' : '添加提醒' }}</button>
          <button v-if="rForm.id" class="tbtn tbtn--mini" @click="resetReminderForm()">取消编辑</button>
        </span>
      </div>

      <div v-if="app.reminders.length === 0" class="muted">还没有提醒。</div>
      <div v-for="r in app.reminders" :key="r.id" class="sched__item">
        <div class="row">
          <span>
            <b>{{ r.title }}</b>
            <span class="badge">{{ r.kind }}</span>
            <span class="badge">{{ r.priority }}</span>
            <span class="badge">{{ r.state }}</span>
            <span class="badge">{{ fmtTs(r.fireAt) }}</span>
            <span v-if="r.state === 'queued'" class="badge badge--warn">{{ blockText(r.blockReason) }}</span>
          </span>
          <span class="sched__actions">
            <button v-if="!r.ackedAt" class="tbtn tbtn--mini" @click="app.ackReminder(r.id)">标记已读</button>
            <button class="tbtn tbtn--mini" @click="editReminder(r.id)">编辑</button>
            <button class="tbtn tbtn--mini tbtn--danger" @click="app.deleteReminder(r.id)">删除</button>
          </span>
        </div>
        <div v-if="r.body" class="muted">{{ r.body }}</div>
        <div v-if="r.lastError" class="muted warn">上次错误：{{ r.lastError }}（已尝试 {{ r.attempts }} 次）</div>
      </div>
    </section>

    <!-- 提醒中心 -->
    <section class="card">
      <h3>提醒中心</h3>
      <p class="muted">
        被阻断的提醒是**进队列，不是被丢掉**：等阻断条件（静音时段 / 全屏 / 会议 / 游戏 / 专注）结束后
        由引擎补发，补发时也会再判一次能不能打扰。
      </p>
      <div class="row">
        <span>队列 {{ queued.length }} · 待确认 {{ unacked.length }} · 最近送达 {{ recent.length }}</span>
        <button class="tbtn tbtn--mini" @click="app.loadInbox()">刷新</button>
      </div>

      <b class="sched__h4">排队待补发</b>
      <div v-if="queued.length === 0" class="muted">队列为空。</div>
      <div v-for="q in queued" :key="q.reminder.id" class="sched__item">
        <div class="row">
          <span>
            <b>{{ q.reminder.title }}</b>
            <span class="badge">{{ q.reminder.priority }}</span>
            <span class="badge">计划 {{ fmtTs(q.reminder.fireAt) }}</span>
          </span>
        </div>
        <!-- 主进程给的"为什么现在才补发"，原样显示 -->
        <div class="muted">{{ q.blockedReasonText }}</div>
      </div>

      <b class="sched__h4">已送达待确认</b>
      <div v-if="unacked.length === 0" class="muted">没有待确认的提醒。</div>
      <div v-for="r in unacked" :key="r.id" class="sched__item">
        <div class="row">
          <span>
            <b>{{ r.title }}</b>
            <span class="badge">{{ r.priority }}</span>
            <span class="badge">送达 {{ fmtTs(r.firedAt) }}</span>
          </span>
          <button class="tbtn tbtn--mini" @click="app.ackReminder(r.id)">知道了</button>
        </div>
        <div v-if="r.body" class="muted">{{ r.body }}</div>
      </div>

      <b class="sched__h4">最近送达</b>
      <div v-if="recent.length === 0" class="muted">暂无记录。</div>
      <div v-for="e in recent" :key="e.id" class="sched__item">
        <div class="row">
          <span><b>{{ e.title }}</b> <span class="badge">{{ e.kind }}</span> <span class="badge">{{ e.priority }}</span></span>
          <span class="muted">{{ fmtTs(e.at) }}</span>
        </div>
      </div>
    </section>
  </div>
</template>
