<script setup lang="ts">
/**
 * ToolConfirmDialog.vue —— `needs-confirm` 档工具的确认弹窗（M3 §4）
 *
 * 为什么这个组件必须存在（不只是"体验问题"）：
 *   主进程的确认通道**没有出口时一律按拒绝处理**。也就是说：
 *   少了这个弹窗，`needs-confirm` 档的所有工具都执行不了 ——
 *   这恰恰是**正确的失败方向**（宁可做不了，也不能未经确认就执行）。
 *   所以这个组件的作用是"让确认这件事真的能发生"，而不是"让功能能跑"。
 *
 * 三条纪律：
 *   ① 弹窗里**只有工具名、权限种类与参数摘要（哈希）**，没有参数原文 ——
 *      "确认"不应该变成把敏感参数又搬到一个可能被截屏的地方；
 *   ② 默认按钮是**拒绝**（危险动作用户必须主动点同意，而不是随手回车）；
 *   ③ 有倒计时：超时由主进程按拒绝结算，界面如实显示剩余时间
 *      （"没回应 = 不执行"这条语义必须让用户看得见）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { bridge } from '../bridge'

interface ConfirmRequest {
  confirmId: string
  tool: string
  permissionKind: string
  paramsDigest: string
  detail: string
  timeoutMs: number
  at: number
}

const req = ref<ConfirmRequest | null>(null)
const now = ref(Date.now())
const submitting = ref(false)
let tick: ReturnType<typeof setInterval> | null = null
let off: (() => void) | null = null

const remainMs = computed(() => {
  if (!req.value) return 0
  return Math.max(0, req.value.at + req.value.timeoutMs - now.value)
})
const remainSec = computed(() => Math.ceil(remainMs.value / 1000))

/** 工具名 → 中文说明（**不给参数原文**） */
const TOOL_LABEL: Record<string, string> = {
  'app.launch': '启动应用',
  'clipboard.read': '读取剪贴板',
  'file.write': '写入文件',
  'shell.exec': '执行命令',
}

async function answer(approved: boolean): Promise<void> {
  const r = req.value
  if (!r || submitting.value) return
  submitting.value = true
  try {
    await bridge.submitToolConfirm(r.confirmId, approved)
  } catch {
    // 回传失败也必须关掉弹窗：主进程会在超时后按拒绝结算，留在屏幕上只会误导用户
  } finally {
    submitting.value = false
    req.value = null
  }
}

onMounted(() => {
  off = bridge.onToolConfirm((r) => {
    // 同时只处理一个（主进程也限制了挂起数）；新的直接覆盖旧的（旧的会超时按拒绝）
    req.value = r as ConfirmRequest
    now.value = Date.now()
  })
  tick = setInterval(() => { now.value = Date.now() }, 500)
})

onUnmounted(() => {
  off?.()
  if (tick) clearInterval(tick)
  tick = null
})
</script>

<template>
  <!--
    role="alertdialog" + aria-modal：这是**阻断式**确认（决策未做出前不继续），
    与主动提醒那种"不能打扰"的被动卡片是相反的东西，所以语义必须不同。
  -->
  <div v-if="req" class="confirm-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
    <div class="confirm-card">
      <h3 id="confirm-title">需要你的确认</h3>
      <p class="confirm-detail">{{ req.detail }}</p>
      <dl class="confirm-meta">
        <dt>工具</dt><dd class="mono">{{ req.tool }}<span v-if="TOOL_LABEL[req.tool]"> · {{ TOOL_LABEL[req.tool] }}</span></dd>
        <dt>权限种类</dt><dd class="mono">{{ req.permissionKind }}</dd>
        <dt>参数摘要</dt><dd class="mono">{{ req.paramsDigest }}</dd>
      </dl>
      <p class="muted">
        只显示参数摘要（哈希），**不显示参数原文** —— 确认框不该成为敏感参数的另一个落点。
      </p>
      <p class="muted" :class="{ warn: remainSec <= 5 }">
        {{ remainSec }} 秒内没有回应将按<b>拒绝</b>处理（不会自动执行）。
      </p>
      <div class="confirm-actions">
        <!-- 危险动作的默认焦点给「拒绝」：随手回车不应该等于同意 -->
        <button class="tbtn" :disabled="submitting" autofocus @click="answer(false)">拒绝</button>
        <button class="tbtn tbtn--danger" :disabled="submitting" @click="answer(true)">允许这一次</button>
      </div>
    </div>
  </div>
</template>
