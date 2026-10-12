<script setup lang="ts">
/**
 * ProactiveToast.vue —— 主动事件气泡（M2）
 *
 * **它必须是"被动"的**（这是硬约束，不是风格偏好）：
 *   · 不抢焦点：没有 `autofocus`、没有 `focus()` 调用，`ProactiveEvent.focus` 恒为 false；
 *   · `role="status"`（礼貌级）而不是 `role="alert"` —— 只有 `important` 才升格成 alert，
 *     否则屏幕阅读器会在用户打字时突然打断（主动陪伴的第一原则是"不打扰"）；
 *   · 关闭动作**只**清 `app.lastProactive` 这一个显示项：不删聊天记录、不 ack 提醒
 *     （提醒有没有被读是主进程的事实，不该被"关掉一个气泡"顺手改掉）。
 *
 * 早安电台额外给「查看全文」：`disclosures` 要**原样**渲染 —— 那是用户验证
 * "拿不到的数据被如实声明了，而不是编出来"的唯一途径。
 */
import { computed, ref } from 'vue'
import { useApp } from '../store'

const app = useApp()
const showRadio = ref(false)

const event = computed(() => app.lastProactive)
const priorityLabel: Record<string, string> = { important: '重要', normal: '普通', silent: '静默' }

/** 只有重要级才用 alert；其余一律 status（不打断屏幕阅读器） */
const role = computed(() => (event.value?.priority === 'important' ? 'alert' : 'status'))

function dismiss(): void {
  app.lastProactive = null
  showRadio.value = false
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}
</script>

<template>
  <div v-if="event" class="ptoa">
    <div :class="['ptoa__card', `ptoa__card--${event.priority}`]" :role="role">
      <div class="ptoa__head">
        <span class="badge">{{ event.kind }}</span>
        <b>{{ event.title }}</b>
        <span :class="['badge', event.priority === 'important' ? 'badge--warn' : 'badge--muted']">
          {{ priorityLabel[event.priority] ?? event.priority }}
        </span>
        <span class="muted">{{ fmtTime(event.at) }}</span>
        <button class="tbtn tbtn--mini" title="只关闭这张卡片，不影响其它状态" @click="dismiss()">关闭</button>
      </div>
      <div class="ptoa__text">{{ event.text }}</div>
      <div class="ptoa__foot">
        <span class="muted">朗读：{{ event.speak ? '允许' : '不允许' }} · 抢焦点：{{ event.focus ? '是' : '否' }}</span>
        <button v-if="event.kind === 'morning-radio'" class="tbtn tbtn--mini" @click="showRadio = !showRadio">
          {{ showRadio ? '收起全文' : '查看全文' }}
        </button>
      </div>

      <!-- 早安电台全文：脚本 / 日程 / 资讯 / 建议 / 鼓励 / **披露** -->
      <div v-if="showRadio && app.radio" class="ptoa__radio">
        <b>{{ app.radio.day }} {{ app.radio.weekday }} · 预计朗读 {{ Math.round(app.radio.estimatedSeconds) }} 秒</b>
        <p class="muted">{{ app.radio.greeting }}</p>

        <h4>口播稿</h4>
        <pre>{{ app.radio.script }}</pre>

        <h4>天气</h4>
        <p v-if="app.radio.weather.available" class="muted">
          {{ app.radio.weather.city ?? '—' }} · {{ app.radio.weather.summary ?? '—' }}
          {{ app.radio.weather.tempC ?? '—' }}°C（体感 {{ app.radio.weather.feelsLikeC ?? '—' }}°C）
          来源：{{ app.radio.weather.source ?? '—' }}
        </p>
        <p v-else class="muted warn">
          天气不可用：{{ app.radio.weather.unavailableReason ?? '原因未给出' }}（**没有编造天气**）
        </p>

        <h4>今日日程</h4>
        <p v-if="app.radio.schedule.length === 0" class="muted">没有日程。</p>
        <ul v-else>
          <li v-for="s in app.radio.schedule" :key="s.id">
            {{ s.start }} {{ s.title }}
            <span v-if="s.minutesFromNow !== null" class="muted">（{{ s.minutesFromNow }} 分钟后）</span>
          </li>
        </ul>

        <h4>资讯（每条都带来源与日期）</h4>
        <p v-if="app.radio.news.length === 0" class="muted">没有可用资讯。</p>
        <ul v-else>
          <li v-for="(n, i) in app.radio.news" :key="i">
            {{ n.title }}
            <span class="muted">— {{ n.source }} · {{ n.date ?? '日期未知' }} · {{ n.provenance }}</span>
            <a v-if="n.url" :href="n.url" target="_blank" rel="noreferrer noopener">{{ n.url }}</a>
          </li>
        </ul>

        <h4>建议</h4>
        <ul>
          <li v-for="(a, i) in app.radio.advice" :key="i">{{ a }}</li>
        </ul>

        <h4>鼓励</h4>
        <p class="muted">{{ app.radio.encouragement }}</p>

        <h4>披露（哪些数据没拿到 —— 原样显示，不做润色）</h4>
        <ul v-if="app.radio.disclosures.length">
          <li v-for="(d, i) in app.radio.disclosures" :key="i">{{ d }}</li>
        </ul>
        <p v-else class="muted">没有需要披露的缺失项。</p>
      </div>
      <p v-else-if="showRadio" class="muted">电台内容尚未生成（可到「设置 → 主动陪伴」点「生成早安电台」）。</p>
    </div>
  </div>
</template>
