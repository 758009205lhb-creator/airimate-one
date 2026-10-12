<script setup lang="ts">
/**
 * VoiceScreenPanel.vue —— M3 语音 / 屏幕理解 / 电脑操作（含三档权限与目录白名单）
 *
 * 这一页存在的意义：M3 的能力是**最有侵入性的**（麦克风、屏幕、文件、启动应用）。
 * 用户要求里反复出现"必须显示状态""必须能一键停用""截图前显示提示"——
 * 这些都不是"顺手做的 UI"，而是**安全设计的一部分**：
 * 一个看不见状态的麦克风，与"后台偷听"在体验上无法区分。
 *
 * 三条纪律：
 *   ① **默认全关**：所有开关初始都是关的，界面如实显示"未启用"而不是给一个假装能用的按钮；
 *   ② **状态来自主进程实测**（识别器数量、麦克风是否占用、截图次数），不是猜的；
 *   ③ **不显示识别正文**：状态里只有长度与计数 —— 用户说的话留在主进程内存里。
 */
import { computed, onMounted, ref } from 'vue'
import { useApp } from '../store'
import { bridge } from '../bridge'

interface VoiceStatus {
  available: boolean
  unavailableReason: string | null
  state: string
  micActive: boolean
  wakeWordEnabled: boolean
  wakeWord: string
  lastWakeAt: number | null
  lastTextChars: number | null
  lastTextAt: number | null
  recognizerCount: number
  utteranceCount: number
  lastError: string | null
}
interface ScreenStatus {
  permitted: boolean
  paused: boolean
  lastCaptureAt: number | null
  captureCount: number
  excludeRegions: Array<{ x: number, y: number, w: number, h: number }>
  redactSensitive: boolean
}
interface VoiceNotice { at: number, kind: string, detail: string }
interface CallState {
  active: boolean
  phase: string
  turn: number
  turnsCompleted: number
  lastHeardChars: number | null
  lastSpokeChars: number | null
  interruptions: number
  silenceTurns: number
  lastError: string | null
  startedAt: number | null
}
interface CallNotice { at: number, kind: string, detail: string, replyText?: string }

const app = useApp()
const busy = ref(false)
const voice = ref<VoiceStatus | null>(null)
const screen = ref<ScreenStatus | null>(null)
const notices = ref<VoiceNotice[]>([])
const allowlist = ref<Array<{ id: string, label: string }>>([])
const rules = ref<{ file: number, dir: number } | null>(null)
const newDir = ref('')
const screenNotice = ref<{ detail: string, at: number } | null>(null)
/** 语音通话（M3 §2 全链路）：状态 + 前置条件 + 事件时间线 */
const call = ref<CallState | null>(null)
const callPreflight = ref<{ ready: boolean, reasons: string[] } | null>(null)
const callLog = ref<CallNotice[]>([])
/** 她最近一句回复（用于气泡；**只在通话事件里出现**） */
const lastReply = ref<string>('')

/** 通话阶段的中文说明（让"她现在在做什么"一眼可见） */
const PHASE_LABEL: Record<string, string> = {
  idle: '未通话',
  listening: '正在听你说',
  thinking: '正在想',
  speaking: '正在说',
  error: '出错了',
}

/** 权限表（三档 + 硬下限由主进程给，界面只显示） */
const perms = computed(() => app.permissions.filter(p =>
  ['screen-capture', 'file-read', 'app-launch', 'clipboard-read', 'window-control', 'file-write', 'shell-exec'].includes(p.kind)))

async function refresh(): Promise<void> {
  busy.value = true
  try {
    const v = await bridge.voiceStatus() as unknown as { status?: VoiceStatus }
    voice.value = v.status ?? null
    const s = await bridge.screenStatus() as unknown as { status?: ScreenStatus }
    screen.value = s.status ?? null
    const a = await bridge.fsAllowlist() as unknown as { entries?: Array<{ id: string, label: string }>, rules?: { file: number, dir: number } }
    allowlist.value = a.entries ?? []
    rules.value = a.rules ?? null
    const n = await bridge.screenNotice() as unknown as { notice?: { detail: string, at: number } | null }
    screenNotice.value = n.notice ?? null
    const c = await bridge.voiceCallState() as unknown as { state?: CallState, preflight?: { ready: boolean, reasons: string[] } }
    call.value = c.state ?? null
    callPreflight.value = c.preflight ?? null
    await app.loadPermissions()
  } catch (e) {
    app.reportFailure('读取语音/屏幕状态失败', e)
  } finally {
    busy.value = false
  }
}

async function probeVoice(): Promise<void> {
  busy.value = true
  try {
    const r = await bridge.voiceProbe() as unknown as { probe?: { ok: boolean, count: number, reason: string | null }, status?: VoiceStatus }
    voice.value = r.status ?? voice.value
    const p = r.probe
    if (p) {
      app.toast(p.ok ? 'info' : 'warn', p.ok ? `本机有 ${p.count} 个语音识别器` : '本机语音识别不可用', p.reason ?? undefined, false)
    }
  } catch (e) {
    app.reportFailure('检测语音识别失败', e)
  } finally {
    busy.value = false
  }
}

/** 一键停用（用户硬要求）：停完立刻刷新状态，界面必须显示"麦克风已释放" */
async function stopVoiceNow(): Promise<void> {
  try {
    const r = await bridge.voiceStop() as unknown as { cancelled?: boolean, status?: VoiceStatus }
    voice.value = r.status ?? voice.value
    app.toast('info', r.cancelled ? '已停用语音（麦克风已释放）' : '当前没有在听的语音', undefined, false)
  } catch (e) {
    app.reportFailure('停用语音失败', e)
  }
}

/**
 * 语音识别总开关 = `settings.hearingEnabled`。
 * ⚠ 这是**唯一**能让麦克风被打开的地方（主进程会拒绝未启用时的识别调用）。
 */
async function toggleHearing(on: boolean): Promise<void> {
  await app.patch({ hearingEnabled: on })
  if (on && !app.settings?.voicePrivacyNoticeShown) {
    // 用户要求"明确的录音和隐私提示"：第一次开启时明确告诉他录音范围与边界
    app.toast('warn', '录音与隐私说明', [
      '· 只在你说完一句后把该句交给本机识别（Windows 内置识别器，离线）',
      '· 不录音频文件、不上传音频、不做后台持续监听',
      '· 随时可以点下面的「一键停用」，麦克风立即释放',
      '· 识别到的文字只在主进程内存里使用，不进日志',
    ].join('\n'), true)
    await app.patch({ voicePrivacyNoticeShown: true })
  }
  await refresh()
}

async function setWake(on: boolean): Promise<void> {
  await app.patch({ wakeWordEnabled: on })
  await refresh()
}

/**
 * ★ 说话时可被开口打断（barge-in，2026-10-06 A4）。
 *
 * ⚠ 首次打开时给一次**知情提示**：开着它的时候麦克风在她说话期间也是活的，
 *   扬声器的声音可能被自己的麦克风收进去 ⇒ 她可能把自己打断。
 *   这个风险取决于设备与音量，代码里保证不了，所以必须让用户知情后再开。
 */
async function setBargeIn(on: boolean): Promise<void> {
  await app.patch({ voiceBargeIn: on })
  if (on && !app.settings?.voiceBargeInNoticeShown) {
    app.toast('warn', '开启「开口打断」的代价', [
      '· 她说话期间麦克风保持开启，这样你一开口就能打断她',
      '· 但扬声器的声音**可能被麦克风收进去**，表现为她莫名其妙自己停下',
      '· 若出现这种情况，请关闭本开关（不同设备/音量的表现不一样，代码无法保证）',
    ].join('\n'), true)
    await app.patch({ voiceBargeInNoticeShown: true })
  }
  await refresh()
}

async function saveWakeWord(word: string): Promise<void> {
  const w = word.trim()
  if (w.length === 0 || w.length > 20) {
    app.toast('warn', '唤醒词长度不合法', '请填 1–20 个字（太短会误触发）', false)
    return
  }
  await app.patch({ wakeWord: w })
  await refresh()
}

async function toggleScreenCapture(on: boolean): Promise<void> {
  // 屏幕理解的开关就是权限表的 screen-capture（唯一真源）
  await app.setPermission({ kind: 'screen-capture', enabled: on })
  await refresh()
}

async function pauseScreen(paused: boolean): Promise<void> {
  const r = await bridge.screenPause(paused) as unknown as { status?: ScreenStatus }
  screen.value = r.status ?? screen.value
}

async function addDir(): Promise<void> {
  const p = newDir.value.trim()
  if (!p) return
  try {
    const r = await bridge.fsAllowDir(p) as unknown as { entries?: Array<{ id: string, label: string }> }
    allowlist.value = r.entries ?? allowlist.value
    newDir.value = ''
    app.toast('info', '已授权目录', '只会读取该目录内的文件；敏感文件与系统目录仍会被拒绝', false)
  } catch (e) {
    // 敏感目录被拒是**预期行为**，必须把原因如实显示（而不是静默失败）
    app.reportFailure('授权目录被拒绝', e)
  }
}

async function revokeDir(id: string): Promise<void> {
  const r = await bridge.fsRevokeDir(id) as unknown as { entries?: Array<{ id: string, label: string }> }
  allowlist.value = r.entries ?? allowlist.value
}

async function togglePermission(kind: string, enabled: boolean): Promise<void> {
  await app.setPermission({ kind, enabled })
  await refresh()
}

// ── 语音通话（M3 §2 全链路：听 → 想 → 说，可打断、连续对话）

async function callStart(): Promise<void> {
  try {
    const r = await bridge.voiceCallStart() as unknown as { state?: CallState }
    call.value = r.state ?? call.value
  } catch (e) {
    // 未启用语音 / 未配置供应商时会**结构化拒绝**（不是静默失败）
    app.reportFailure('无法开始语音通话', e)
    await refresh()
  }
}

async function callStop(): Promise<void> {
  const r = await bridge.voiceCallStop() as unknown as { state?: CallState }
  call.value = r.state ?? call.value
  await refresh()
}

/** 打断：停止朗读并继续听（不结束通话）——用户要求里的"打断"就是它 */
async function callInterrupt(): Promise<void> {
  const r = await bridge.voiceCallInterrupt() as unknown as { interrupted?: boolean, state?: CallState }
  call.value = r.state ?? call.value
  if (r.interrupted !== true) app.toast('info', '当前没有在说的话可以打断', undefined, false)
}

onMounted(() => {
  void refresh()
  // 语音事件（**不含识别正文**）：只把"开始了/停了/听到一句"记成一条时间线
  bridge.onVoiceNotice((n) => {
    notices.value = [n, ...notices.value].slice(0, 12)
    void refresh()
  })
  // 通话事件：**`replyText` 是唯一带回复正文的字段**（只用于气泡）
  bridge.onVoiceCall((n) => {
    callLog.value = [n, ...callLog.value].slice(0, 20)
    if (n.replyText) {
      lastReply.value = n.replyText
      app.chat.push({
        id: `vc${n.at.toString(36)}`, role: 'assistant', text: n.replyText,
        createdAt: n.at, commands: [], origin: 'user',
      })
    }
    void refresh()
  })
  // 截图前提示（用户要求"截图前显示提示"）
  bridge.onScreenNotice((n) => {
    screenNotice.value = { detail: n.detail, at: n.at }
    app.toast('warn', '即将截取屏幕', n.detail, false)
    void refresh()
  })
})

function fmtTime(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString()
}
</script>

<template>
  <div class="voice-screen">
    <!-- ── 语音 -->
    <section class="card">
      <h3>语音（默认关闭）</h3>
      <div class="row">
        <span>识别能力</span>
        <b :class="voice?.available ? 'ok' : 'warn'">
          {{ voice?.available ? `可用（${voice.recognizerCount} 个识别器）` : '不可用' }}
        </b>
        <button class="tbtn" :disabled="busy" @click="probeVoice">重新检测</button>
      </div>
      <p v-if="voice && !voice.available" class="muted warn">{{ voice.unavailableReason }}</p>
      <p class="muted">
        使用 Windows 内置识别器（离线、无需联网、无需密钥）。检测只枚举识别器，**不会打开麦克风**。
      </p>

      <label class="row">
        <span>启用语音识别</span>
        <input type="checkbox" :checked="app.settings?.hearingEnabled ?? false" @change="toggleHearing(($event.target as HTMLInputElement).checked)" />
      </label>
      <label class="row">
        <span>语音唤醒</span>
        <input type="checkbox" :checked="app.settings?.wakeWordEnabled ?? false" :disabled="!app.settings?.hearingEnabled" @change="setWake(($event.target as HTMLInputElement).checked)" />
      </label>
      <label class="row">
        <span>唤醒词</span>
        <input
          type="text"
          maxlength="20"
          :value="app.settings?.wakeWord ?? ''"
          :disabled="!app.settings?.wakeWordEnabled"
          @change="saveWakeWord(($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="row">
        <span>她说话时，我开口可以打断</span>
        <input
          type="checkbox"
          :checked="app.settings?.voiceBargeIn ?? false"
          :disabled="!app.settings?.hearingEnabled"
          @change="setBargeIn(($event.target as HTMLInputElement).checked)"
        />
      </label>
      <div class="row muted">
        <!--
          ⚠ 这条说明是**刻意的**：开着它的时候麦克风在她说的时候也是活的，
             扬声器的声音可能被自己的麦克风收进去 ⇒ 她可能把自己打断。
             这个风险取决于设备与音量，代码里保证不了 ⇒ 必须让用户知情。
             （默认关闭，所以不写清楚的话用户不会知道开了会有什么代价。）
        -->
        <span>开启后她说话期间麦克风保持开启，声音可能被扬声器回授而自己打断；如遇此现象请关闭。</span>
      </div>

      <div class="row">
        <span>麦克风状态</span>
        <b :class="voice?.micActive ? 'warn' : 'ok'">{{ voice?.micActive ? '正在使用（监听中）' : '未占用' }}</b>
        <span class="muted">状态：{{ voice?.state ?? '—' }}</span>
        <button class="tbtn tbtn--danger" @click="stopVoiceNow">一键停用</button>
      </div>
      <div class="row muted">
        <span>上次唤醒 {{ fmtTime(voice?.lastWakeAt ?? null) }}</span>
        <span>累计识别 {{ voice?.utteranceCount ?? 0 }} 句</span>
        <span v-if="voice?.lastTextChars !== null">上次长度 {{ voice?.lastTextChars }} 字</span>
      </div>
      <p v-if="voice?.lastError" class="muted warn">最近错误：{{ voice.lastError }}</p>
      <p class="muted">
        边界：只在你说完一句后识别该句；**不录音频文件、不上传音频、不做后台持续监听**。
        识别文字只进主进程内存，日志只记长度。下方时间线也只有事件与长度，**没有内容**。
      </p>
      <div v-if="notices.length" class="sub">
        <b>语音事件时间线</b>
        <div v-for="(n, i) in notices" :key="i" class="muted mono">
          {{ fmtTime(n.at) }} · {{ n.kind }} · {{ n.detail }}
        </div>
      </div>
    </section>

    <!-- ── 语音通话（全链路：听 → 想 → 说，可打断、连续对话） -->
    <section class="card">
      <h3>语音通话（STT → LLM → TTS 全链路）</h3>
      <div class="row">
        <span>当前阶段</span>
        <b :class="call?.active ? 'warn' : 'muted'">{{ PHASE_LABEL[call?.phase ?? 'idle'] ?? call?.phase }}</b>
        <span class="muted">第 {{ call?.turn ?? 0 }} 轮 · 已完成 {{ call?.turnsCompleted ?? 0 }} 轮</span>
      </div>
      <div class="row">
        <button class="tbtn" :disabled="call?.active || !(callPreflight?.ready ?? false)" @click="callStart">开始通话</button>
        <button class="tbtn tbtn--danger" :disabled="!call?.active" @click="callInterrupt">打断</button>
        <button class="tbtn" :disabled="!call?.active" @click="callStop">结束通话</button>
      </div>
      <p v-if="callPreflight && !callPreflight.ready" class="muted warn">
        还不能通话：{{ callPreflight.reasons.join('；') }}
      </p>
      <p v-else-if="callPreflight" class="muted">
        就绪。{{ callPreflight.reasons.length ? `注意：${callPreflight.reasons.join('；')}` : '' }}
      </p>
      <div class="row muted">
        <span>静音轮次 {{ call?.silenceTurns ?? 0 }}</span>
        <span>被打断 {{ call?.interruptions ?? 0 }} 次</span>
        <span v-if="call?.lastHeardChars !== null">上次听到 {{ call?.lastHeardChars }} 字</span>
        <span v-if="call?.lastSpokeChars !== null">上次说 {{ call?.lastSpokeChars }} 字</span>
      </div>
      <p v-if="call?.lastError" class="muted warn">最近错误：{{ call.lastError }}</p>
      <p class="muted">
        链路：**听**（本机识别器自带静音断句）→ **想**（与打字同一条链路：人设 + 记忆 + 历史）
        → **说**（TTS）。点「打断」会立刻停止朗读并继续听你说，而不是等她说完。
        静音轮次会单独计数 —— "没反应"必须能区分"没人说话"与"出错了"。
      </p>
      <p v-if="lastReply" class="muted">
        她最近一句：{{ lastReply }}
      </p>
      <div v-if="callLog.length" class="sub">
        <b>通话时间线</b>
        <div v-for="(n, i) in callLog" :key="i" class="muted mono">
          {{ fmtTime(n.at) }} · {{ n.kind }} · {{ n.detail }}
        </div>
      </div>
    </section>

    <!-- ── 屏幕理解 -->
    <section class="card">
      <h3>屏幕理解（按需触发，非持续录屏）</h3>
      <div class="row">
        <span>是否授权</span>
        <b :class="screen?.permitted ? 'warn' : 'ok'">{{ screen?.permitted ? '已授权' : '未授权（默认）' }}</b>
        <span class="muted">累计截图 {{ screen?.captureCount ?? 0 }} 次</span>
        <span class="muted">上次 {{ fmtTime(screen?.lastCaptureAt ?? null) }}</span>
      </div>
      <label class="row">
        <span>允许按需截图</span>
        <input type="checkbox" :checked="screen?.permitted ?? false" @change="toggleScreenCapture(($event.target as HTMLInputElement).checked)" />
      </label>
      <label class="row">
        <span>暂停屏幕理解</span>
        <input type="checkbox" :checked="screen?.paused ?? false" :disabled="!screen?.permitted" @change="pauseScreen(($event.target as HTMLInputElement).checked)" />
      </label>
      <label class="row">
        <span>敏感信息脱敏</span>
        <input
          type="checkbox"
          :checked="app.settings?.screenRedactSensitive ?? true"
          @change="app.patch({ screenRedactSensitive: ($event.target as HTMLInputElement).checked }).then(refresh)"
        />
      </label>
      <div class="row">
        <span>排除区域</span><b>{{ screen?.excludeRegions.length ?? 0 }} 块</b>
        <span class="muted">（在权限页可编辑；有交叠的区域整块打码）</span>
      </div>
      <p v-if="screenNotice" class="muted">
        最近一次截图提示：{{ screenNotice.detail }}
      </p>
      <p class="muted">
        边界：**没有任何定时器** —— 只在模型显式调用 `screen.capture` 时截一次；
        截图前会先弹提示；排除区按 16×16 栅格打码；
        画面**保留在主进程**，界面与模型只拿到尺寸与打码统计。
      </p>
    </section>

    <!-- ── 工具权限（三档） -->
    <section class="card">
      <h3>电脑操作权限（三档）</h3>
      <table class="cap-table">
        <thead><tr><th>能力</th><th>档位</th><th>实际生效</th><th>启用</th></tr></thead>
        <tbody>
          <tr v-for="p in perms" :key="p.kind">
            <td>{{ p.label }}<div class="muted mono">{{ p.kind }}</div></td>
            <td>{{ p.tier }}</td>
            <td>
              <span v-if="p.effective === 'blocked'" class="badge badge--danger">禁止（硬下限）</span>
              <span v-else-if="p.effective === 'confirm'" class="badge badge--warn">需确认</span>
              <span v-else class="badge badge--ok">只读</span>
            </td>
            <td>
              <input
                type="checkbox"
                :checked="p.enabled"
                :disabled="p.effective === 'blocked'"
                @change="togglePermission(p.kind, ($event.target as HTMLInputElement).checked)"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <p class="muted">
        「禁止（硬下限）」的能力**无法被开启**（支付 / 改系统设置 / 读凭据 / 模拟键鼠 / 执行任意命令）。
        这不是界面限制 —— 主进程的数据层每次读盘都会重算，手改配置文件也会被收紧。
      </p>
      <p class="muted">
        `needs-confirm` 档在执行前会弹确认框；**没有确认通道或你超时未回应一律按"不执行"处理**
        （不会因为缺少入口就放行）。
      </p>
    </section>

    <!-- ── 文件目录白名单 -->
    <section class="card">
      <h3>文件读取的授权目录</h3>
      <div class="row">
        <span>已授权</span><b>{{ allowlist.length }}</b>
        <span class="muted">硬拒绝规则：文件 {{ rules?.file ?? 0 }} 条 · 目录 {{ rules?.dir ?? 0 }} 条</span>
      </div>
      <div v-if="allowlist.length" class="sub">
        <div v-for="e in allowlist" :key="e.id" class="row">
          <span class="mono">{{ e.label }}</span>
          <span class="muted">id {{ e.id }}</span>
          <button class="tbtn tbtn--mini" @click="revokeDir(e.id)">撤销</button>
        </div>
      </div>
      <div class="row">
        <input v-model="newDir" type="text" placeholder="要授权的目录完整路径（例如 D:\Projects\notes）" />
        <button class="tbtn" :disabled="!newDir.trim()" @click="addDir">授权</button>
      </div>
      <p class="muted">
        默认**只读**。无论是否授权，下列都会被硬拒绝：`.env`、私钥（`.pem`/`id_rsa`/`.kdbx`）、
        token、cookies、凭据数据库、`.ssh`/`.aws`/`.kube`/`.docker` 等凭据目录、系统目录。
        授权一个危险目录会在这一步就被拒（不是等读的时候才拒）。
      </p>
      <p class="muted">
        ⚠ 界面**故意不显示完整路径**（按设计 renderer 拿不到任意文件路径）：
        上面每条只给末级目录名与一个不可反推的 id。
      </p>
    </section>
  </div>
</template>
