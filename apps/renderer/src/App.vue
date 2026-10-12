<script setup lang="ts">
/**
 * apps/renderer/src/App.vue —— 根组件（**按窗口 surface 分派**）
 *
 * ⚠ 2026-10-08 返工轮：本文件从"应用外壳本体"缩减成一个**分派器**，
 *   内容全部搬进 `components/PetShell.vue`。两份界面各自独立：
 *
 *   · `?surface=chat`（**第二个 BrowserWindow**）⇒ `ChatWindow.vue`
 *     —— 输入框与对话内容**只**在这里；
 *   · 缺省 ⇒ `PetShell.vue` —— 角色 + 轮盘 + 气泡 + 管理面板，**没有任何输入框**。
 *
 * 为什么还留这一层（`main.ts` 已经自己做了分派）：
 *   · `main.ts` 的分派是**动态 import**，它保证 chat 窗口的模块图里没有 stage；
 *   · 这一层是**第二道闸门**，而且让"根组件是谁"在 devtools / 源码检索里可见 ——
 *     排查"第二个窗口到底渲染了什么"时，第一眼看的就是它；
 *   · 也保留了"以后加第三个 surface"的落点（虽然第三个窗口是禁止项，
 *     但 surface 的语义本身是"同一份构建渲染不同界面"，与窗口数量无关）。
 *
 * ⛔ 绝对不许在这里 **静态** import `AvatarStage.vue`：那会把它（以及 three / VRM）
 *   拖进 chat 窗口的模块图，"没挂载就不会创建 WebGLRenderer"就退化成一条靠自觉的约定。
 *   本文件只 import 两个**界面壳**，`PetShell.vue` 内部的 stage import 只会在 pet 分支被求值。
 */
import { computed } from 'vue'
import ChatWindow from './components/ChatWindow.vue'
import PetShell from './components/PetShell.vue'

const surface = new URLSearchParams(location.search).get('surface') === 'chat' ? 'chat' : 'pet'
const isChat = computed(() => surface === 'chat')
</script>

<template>
  <ChatWindow v-if="isChat" />
  <PetShell v-else />
</template>
