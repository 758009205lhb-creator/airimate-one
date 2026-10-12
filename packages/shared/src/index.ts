/**
 * @airimate/shared/index —— 对外唯一入口
 *
 * ⚠ **加载顺序有意义**（见 `proactive.ts` 顶部注释）：
 *   `commands` / `settings` 是最底层（无 shared 内部依赖）⇒ 先加载；
 *   `proactive` 只依赖 zod（刻意不反向 import）⇒ 第三；
 *   `ipc` 会 import 上面三者 ⇒ 第四；`preload-api` 只 `import type` ⇒ 最后。
 *   顺序错了会在模块求值期踩 TDZ（zod schema 是**顶层常量**，在 import 时就求值）。
 */
export * from './commands.js'
export * from './settings.js'
export * from './proactive.js'
export * from './ipc.js'
export * from './errors.js'
export * from './preload-api.js'
