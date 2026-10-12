/**
 * @airimate/motion-director —— 包入口
 *
 * 只再导出 `types` / `manifest` / `director`。
 * 原 `overlay.ts` 已删除：那部分（阻尼弹簧、呼吸、眨眼曲线）属于**表现层数学**，
 * 不属于"冻结的数据契约 + 纯逻辑状态机"这个交付物；留在这里会让
 * "core 不依赖 three" 的边界变得含糊。需要时应在 `avatar-stage` 里实现。
 */
export * from './types.js'
export * from './manifest.js'
export * from './director.js'
