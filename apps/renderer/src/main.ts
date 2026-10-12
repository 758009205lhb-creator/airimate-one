/**
 * apps/renderer/src/main.ts —— 渲染层入口（单一 Vue 应用、单一 Pinia、**按 surface 分支**）
 *
 * ⚠ 2026-10-08 返工轮：应用现在有**两个**窗口，它们加载**同一份** renderer 构建，
 *   靠 URL 查询参数区分要渲染哪个界面：
 *
 *     · `?surface=chat` ⇒ 动态 import `ChatWindow.vue`（**只有对话**）
 *     · 缺省            ⇒ 动态 import `PetShell.vue`（角色 + 面板，**唯一**渲染角色的窗口）
 *
 * 为什么用**动态** import 而不是在根组件里 `v-if` 两个静态 import：
 *   静态 import 会把 `AvatarStage.vue`（进而把 three / three-vrm / 动画运行时）
 *   拉进 chat 窗口的**模块图**。虽然"没挂载就不会创建 WebGLRenderer"，
 *   但那是一条**靠行为保证**的边界；动态 import 把它变成**靠结构保证**的边界 ——
 *   chat 窗口的代码路径里根本不存在 stage 模块。
 *   判据 §7.2（chat 窗口 canvas = 0、全应用 WebGLRenderer = 1）因此不依赖任何人的自觉。
 *
 * 安全：本文件**不**直接触碰 `window.airimate`，也不触碰 node/electron；
 *   契约版本自检走 `./bridge` —— renderer 侧只有 `bridge.ts` 允许访问 preload API。
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { bridge } from './bridge'
import './styles.css'

/** 当前窗口的界面（`chat` = 独立对话窗口；其它一律按角色窗口处理） */
const surface = new URLSearchParams(location.search).get('surface') === 'chat' ? 'chat' : 'pet'

/**
 * 契约版本自检：preload 与 renderer 不同版本 / 桥没加载起来时立即报警（不静默）。
 *
 * ⚠ 必须放在 `mount` **之前**：桥不可用时挂载任何界面都只会白屏，
 *   而白屏是最难归因的一种失败（看起来像"渲染坏了"，其实是契约断了）。
 */
function contractCheckFailed(): string | null {
  try {
    if (typeof bridge.contractVersion() !== 'string') throw new Error('contractVersion 不是字符串')
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const failure = contractCheckFailed()
if (failure) {
  document.title = surface === 'chat' ? 'AiriMate One · 对话（桥未就绪）' : 'AiriMate One（桥未就绪）'
  document.body.innerHTML = '<div style="padding:24px;font:14px/1.6 system-ui;color:#f66">'
    + `<b>preload 桥未就绪（surface=${surface}）</b><br/>`
    + `读取契约版本失败：${failure}<br/>`
    + '请检查 preload 是否加载成功（安全策略问题会让它整体失效）。'
    + '</div>'
} else {
  /**
   * 动态 import：**结构性地**保证 chat 窗口的模块图里没有 stage / three / VRM。
   * ⚠ 刻意不用 top-level await：`vite.config.ts` 的 build.target 是 `chrome128`，
   *   默认并不承诺支持 TLA（它需要 `build.target: 'esnext'` 或显式开启）。
   *   用 `.then()` 一样是"S 分支之后才发生"，且不引入构建配置的额外假设。
   */
  const load = surface === 'chat'
    ? import('./components/ChatWindow.vue')
    : import('./components/PetShell.vue')
  void load.then((mod) => {
    /**
     * 标题由这里定：主进程建窗时给的标题是 `AiriMate One · 对话`，
     * 但页面里的 `<title>` 会覆盖它 —— 而桌面枚举（`Get-DesktopState.ps1`）
     * 正是按**窗口标题**区分"角色窗口 / 对话窗口"的，所以两者必须一致。
     */
    document.title = surface === 'chat' ? 'AiriMate One · 对话' : 'AiriMate One'
    const app = createApp(mod.default)
    app.use(createPinia())
    app.mount('#app')
  }).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e)
    document.body.innerHTML = '<div style="padding:24px;font:14px/1.6 system-ui;color:#f66">'
      + `<b>界面加载失败（surface=${surface}）</b><br/>${msg}</div>`
  })
}
