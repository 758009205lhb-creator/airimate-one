<script setup lang="ts">
/**
 * CapabilityPanel.vue —— 适配层与隐私边界（M5 §1/§2/§3 的可视化）
 *
 * 存在的意义：适配层最大的风险是**变成黑盒** —— "现在到底在用哪个实现、
 * 为什么没用别的、哪些能力其实没做、模型能看到哪些工具"，
 * 如果只写在文档里，用户与验收者都只能选择相信。
 *
 * 这一页把这四件事变成**可读的实测读数**（数据全部来自主进程的只读通道）：
 *   · 每一类能力的候选、生效项、被跳过的原因
 *   · 角色资产的许可判定（含被拒条目与原因）
 *   · 工具的权限处置 + "给模型看的清单"（禁止项必须不在里面）
 *   · 存储清单与迁移状态
 *
 * ⚠ 纪律：本页**只读**。它不提供"切换适配器"这类操作 ——
 *   选型涉及许可判定，必须走主进程（且当前没有这种需求）；
 *   加一个能改实现的下拉框只会让"到底在用什么"更难追。
 */
import { computed, onMounted, ref } from 'vue'
import { useApp } from '../store'
import { bridge } from '../bridge'

interface AdapterRow {
  id: string
  kind: string
  label: string
  origin: string
  available: boolean
  unavailableReason: string | null
  capabilities: string[]
  active: boolean
  requiresNetwork: boolean
  writesUserContent: boolean
  license: {
    provenance: string
    redistributable: boolean
    commercialUse: boolean
    license: string
    attributionRequired: boolean
  }
}

interface ToolRow {
  name: string
  description: string
  permissionKind: string
  timeoutMs: number
  readOnly: boolean
  decision: string
}

const app = useApp()
const busy = ref(false)
const adapters = ref<AdapterRow[]>([])
const tools = ref<ToolRow[]>([])
const modelVisible = ref<string[]>([])
const byKind = ref<Record<string, { registered: number, available: number, activeId: string | null }>>({})
const profile = ref<string>('unknown')
const requireCommercial = ref(false)
const events = ref<Array<{ at: number, kind: string, id: string, event: string, reason: string }>>([])
const assets = ref<{
  detail: string
  selectedId: string | null
  usable: Array<{ id: string, license: { provenance: string, license: string, redistributable: boolean, note: string }, verdict: { allowed: boolean, reason: string, detail: string } }>
  rejected: Array<{ id: string, reason: string, detail: string }>
  total: number
} | null>(null)
const stores = ref<Array<{ name: string, personal: boolean, version: number, description: string, migrations: number }>>([])
const personalStores = ref<string[]>([])
const audit = ref<{ calls?: unknown[], digest?: { total?: number, byDecision?: Record<string, number>, neverExecuted?: number, executedOk?: number, executedFailed?: number } } | null>(null)
const callSample = ref<unknown[]>([])

/** 能力类别的中文名（UI 用；与 shared 的 CapabilityKind 一一对应） */
const KIND_LABEL: Record<string, string> = {
  avatar: '角色', motion: '动作', tts: '语音合成', stt: '语音识别', wakeword: '语音唤醒',
  llm: '语言模型', tool: '工具', storage: '存储', privacy: '隐私',
}

const blockedTools = computed(() => tools.value.filter(t => t.decision === 'denied'))
const allowedTools = computed(() => tools.value.filter(t => t.decision !== 'denied'))
/** ★ 核心判据的界面表达：禁止项**绝不能**出现在给模型的清单里 */
const forbiddenLeakedToModel = computed(() => blockedTools.value.filter(t => modelVisible.value.includes(t.name)))

async function load(): Promise<void> {
  busy.value = true
  try {
    const cap = await bridge.kitCapabilities() as unknown as { kit?: Record<string, unknown> }
    const k = (cap.kit ?? {}) as Record<string, unknown>
    adapters.value = (k.adapters ?? []) as AdapterRow[]
    tools.value = (k.tools ?? []) as ToolRow[]
    modelVisible.value = (k.modelVisibleTools ?? []) as string[]
    byKind.value = (k.byKind ?? {}) as Record<string, { registered: number, available: number, activeId: string | null }>
    profile.value = String(k.profile ?? 'unknown')
    requireCommercial.value = k.requireCommercial === true
    events.value = (k.events ?? []) as typeof events.value

    const a = await bridge.kitAssets() as unknown as { assets?: typeof assets.value }
    assets.value = a.assets ?? null

    const s = await bridge.kitStores() as unknown as { stores?: typeof stores.value, personal?: string[] }
    stores.value = s.stores ?? []
    personalStores.value = s.personal ?? []

    const au = await bridge.kitToolAudit() as unknown as { calls?: unknown[], digest?: typeof audit.value extends null ? never : NonNullable<typeof audit.value>['digest'] }
    audit.value = { calls: au.calls, digest: au.digest }
    // 审计样本只展示**摘要字段**（本来就不含正文）
    callSample.value = (au.calls ?? []).slice(0, 12)
  } catch (e) {
    app.reportFailure('读取适配层信息失败', e)
  } finally {
    busy.value = false
  }
}

onMounted(() => { void load() })
</script>

<template>
  <div class="capabilities">
    <section class="card">
      <h3>适配层（能力与实现）</h3>
      <p class="muted">
        每一类能力都可以有多个实现；这里显示**当前生效的是哪一个**、以及其它候选为什么没被选中。
        运行形态：<b>{{ profile }}</b>
        <span v-if="requireCommercial">（要求商用权利）</span>
        <span v-else>（不要求商用权利）</span>
      </p>
      <p class="muted">
        形态决定**许可闸门**的严格度：<b>development</b> 允许本机使用任意来源资产（私有自用的正常形态）；
        <b>packaged</b> 会机械拒绝任何不可再分发或来源不明的资产。
      </p>
      <div class="row">
        <button class="tbtn" :disabled="busy" @click="load">重新读取</button>
        <span class="muted">共 {{ adapters.length }} 个适配器</span>
      </div>

      <table class="cap-table">
        <thead>
          <tr><th>类别</th><th>适配器</th><th>状态</th><th>来源</th><th>网络</th><th>写内容</th><th>许可</th></tr>
        </thead>
        <tbody>
          <tr v-for="a in adapters" :key="a.id" :class="{ 'is-active': a.active }">
            <td>{{ KIND_LABEL[a.kind] ?? a.kind }}</td>
            <td>
              <b>{{ a.label }}</b>
              <div class="muted mono">{{ a.id }}</div>
              <div v-if="!a.available" class="muted warn">不可用：{{ a.unavailableReason ?? '未说明' }}</div>
            </td>
            <td>
              <span v-if="a.active" class="badge badge--ok">生效</span>
              <span v-else-if="a.available" class="badge badge--muted">可用</span>
              <span v-else class="badge badge--warn">不可用</span>
            </td>
            <td class="muted">{{ a.origin }}</td>
            <td>{{ a.requiresNetwork ? '是' : '否' }}</td>
            <td>{{ a.writesUserContent ? '是' : '否' }}</td>
            <td>
              <div>{{ a.license.license }}</div>
              <div class="muted">{{ a.license.provenance }}</div>
              <div class="muted">
                再分发 {{ a.license.redistributable ? '允许' : '禁止' }} ·
                商用 {{ a.license.commercialUse ? '允许' : '禁止' }}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="muted">
        「不可用」是**如实告知**，不是隐藏：M3 的语音识别 / 语音唤醒目前就是占位实现，
        界面显示为不可用，而不是给一个点了没反应的开关。
      </p>
    </section>

    <section class="card">
      <h3>角色资产与许可判定</h3>
      <p class="muted">{{ assets?.detail ?? '（未读到）' }}</p>
      <div class="row">
        <span>清单条目</span><b>{{ assets?.total ?? 0 }}</b>
        <span>可用</span><b>{{ assets?.usable.length ?? 0 }}</b>
        <span>被拒</span><b>{{ assets?.rejected.length ?? 0 }}</b>
      </div>
      <div v-if="assets?.usable.length" class="sub">
        <b>可用</b>
        <div v-for="u in assets.usable" :key="u.id" class="kv">
          <span class="mono">{{ u.id }}</span>
          <span class="muted">{{ u.license.license }} · {{ u.license.provenance }} ·
            再分发 {{ u.license.redistributable ? '允许' : '禁止' }}</span>
          <div class="muted">{{ u.verdict.detail }}</div>
        </div>
      </div>
      <div v-if="assets?.rejected.length" class="sub">
        <b>被拒（含原因）</b>
        <div v-for="r in assets.rejected" :key="r.id" class="kv">
          <span class="mono">{{ r.id }}</span>
          <span class="warn">{{ r.reason }}</span>
          <div class="muted">{{ r.detail }}</div>
        </div>
      </div>
      <p class="muted">
        本构建为**私有自用**：Mate 的 VRM/VRMA/.anim 不进分发载荷（另有
        <span class="mono">scan-dist-payload.mjs</span> 机械拦截）。
        商业版必须替换为允许再分发与商用的资产 —— 换了之后这里的 provenance 会变成 licensed。
      </p>
    </section>

    <section class="card">
      <h3>工具权限与"模型能看到什么"</h3>
      <div class="row">
        <span>已登记工具</span><b>{{ tools.length }}</b>
        <span>可被调用</span><b>{{ allowedTools.length }}</b>
        <span>禁止</span><b>{{ blockedTools.length }}</b>
      </div>
      <p :class="forbiddenLeakedToModel.length ? 'warn' : 'muted'">
        <template v-if="forbiddenLeakedToModel.length">
          ✗ 异常：有 {{ forbiddenLeakedToModel.length }} 个禁止项出现在了给模型的清单里
          （{{ forbiddenLeakedToModel.map(t => t.name).join('、') }}）
        </template>
        <template v-else>
          ✓ 给模型的清单里**没有**任何禁止项（{{ modelVisible.length }} 个可见）
          —— 模型看不到它不能用的工具，也就不会反复尝试并制造"我做不到"的假象。
        </template>
      </p>
      <table class="cap-table">
        <thead><tr><th>工具</th><th>权限种类</th><th>处置</th><th>只读</th><th>超时</th></tr></thead>
        <tbody>
          <tr v-for="t in tools" :key="t.name">
            <td><span class="mono">{{ t.name }}</span><div class="muted">{{ t.description }}</div></td>
            <td class="mono">{{ t.permissionKind }}</td>
            <td>
              <span v-if="t.decision === 'allow'" class="badge badge--ok">可直接执行</span>
              <span v-else-if="t.decision === 'needs-confirm'" class="badge badge--warn">需确认</span>
              <span v-else class="badge badge--danger">禁止</span>
            </td>
            <td>{{ t.readOnly ? '是' : '否' }}</td>
            <td class="muted">{{ t.timeoutMs }}ms</td>
          </tr>
        </tbody>
      </table>
      <p class="muted">
        支付 / 改密码 / 读凭据 / 模拟键鼠 / 改系统设置是**权限硬下限**：任何设置都无法放宽，
        手改配置文件也会在读盘时被收紧。
      </p>
    </section>

    <section class="card">
      <h3>工具调用审计（只有摘要）</h3>
      <div class="row">
        <span>记录</span><b>{{ audit?.digest?.total ?? 0 }}</b>
        <span>未执行</span><b>{{ audit?.digest?.neverExecuted ?? 0 }}</b>
        <span>成功</span><b>{{ audit?.digest?.executedOk ?? 0 }}</b>
        <span>失败</span><b>{{ audit?.digest?.executedFailed ?? 0 }}</b>
      </div>
      <p class="muted">
        「未执行」与「执行失败」是两件事：前者 `ok=null`（被权限挡住或用户拒绝），
        后者 `ok=false`（真的跑了但失败）。参数与结果都只记
        <span class="mono">sha256:前12位:原长</span>，**不记原文**。
      </p>
      <pre v-if="callSample.length" class="diag">{{ JSON.stringify(callSample, null, 2) }}</pre>
    </section>

    <section class="card">
      <h3>数据存储与迁移</h3>
      <div class="row">
        <span>已登记存储</span><b>{{ stores.length }}</b>
        <span>个人数据</span><b>{{ personalStores.length }}</b>
      </div>
      <table class="cap-table">
        <thead><tr><th>名称</th><th>版本</th><th>个人数据</th><th>迁移步骤</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="s in stores" :key="s.name">
            <td class="mono">{{ s.name }}</td>
            <td>v{{ s.version }}</td>
            <td>{{ s.personal ? '是' : '否' }}</td>
            <td class="muted">{{ s.migrations }}</td>
            <td class="muted">{{ s.description }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted">
        升级时数据走**声明式迁移链**：能迁就逐级迁；迁不了（数据比程序新 / 缺少步骤）
        就**保留原文件并用默认值运行**，绝不用默认值覆盖用户数据。
      </p>
    </section>

    <section class="card">
      <h3>选型事件（最近 40 条）</h3>
      <p class="muted">只记 id / 类别 / 事件 / 原因码 —— 用于回答"为什么现在用的是这个实现"。</p>
      <pre v-if="events.length" class="diag">{{ events.map(e => `${e.event} ${e.kind} ${e.id} — ${e.reason}`).join('\n') }}</pre>
      <p v-else class="muted">（暂无事件）</p>
    </section>
  </div>
</template>
