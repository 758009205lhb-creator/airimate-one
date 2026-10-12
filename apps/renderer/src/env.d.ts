/**
 * apps/renderer/src/env.d.ts —— 全局类型：preload 暴露的 `window.airimate`
 */
import type { AiriMateApi } from '@airimate/shared'

declare global {
  interface Window {
    /** preload 通过 contextBridge 暴露的唯一 API（白名单） */
    airimate: AiriMateApi
    /** 验收探针快照（只在页面内维护，process 侧通过 IPC 取） */
    __AIRIMATE_STAGE__?: unknown
    __AIRIMATE_UI__?: unknown
    /**
     * 验收探针钩子。
     *
     * 为什么要显式声明：这些钩子是**跨进程契约**——主进程的 `--probe a10/a11/a12/a13/a14`
     * 直接按名字取用。名字写错时 renderer 侧不会有任何编译期提示，
     * 只会在运行时得到 `Script failed to execute`（已实测踩到：把 A12 的 op
     * 挂到了拖拽探针上，而主进程调的是另一个钩子）。
     * 集中声明后，改名字会被类型检查挡住。
     */
    __AIRIMATE_WHEEL_PROBE__?: (op: string, arg?: unknown) => unknown
    __AIRIMATE_DRAG_PROBE__?: (op: string, arg?: unknown) => unknown
    __AIRIMATE_INPUT_PROBE__?: (op: string) => unknown
    /** A12/A13：动作活性与待机轮换取样（`resetTravel` / `legTravel` / `state`） */
    __AIRIMATE_MOTION_PROBE__?: (op: string) => unknown
    /** 界面读数（只读）：状态栏徽标用的 getter 是否与后端一致 */
    __AIRIMATE_UI_PROBE__?: (op: string) => unknown
  }
}

export {}
