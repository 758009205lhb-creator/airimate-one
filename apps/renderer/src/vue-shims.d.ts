/**
 * apps/renderer/src/vue-shims.d.ts —— `*.vue` 模块声明
 *
 * 为什么需要：`tsc` 不认识 `.vue` 文件（那要 `vue-tsc`）。没有这个声明时，
 * `main.ts` 的 `import App from './App.vue'` 会报 `TS2307: Cannot find module`，
 * 于是 `npm run typecheck` 永远有一堆"假错误"，真正的类型问题就被淹没了
 * —— 这正是它此前长期没被用起来的原因之一。
 *
 * 这里给出**最小可用**的类型：`DefineComponent`，让 `.vue` 能被当作组件使用。
 * 组件**内部**模板/脚本的类型由 Vite 构建与编辑器各自的工具链负责。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
