/**
 * @airimate/companion-kit/index —— 适配层框架的唯一入口
 *
 * 框架回答四个问题（对应 M5 §1 的六格）：
 *   ① **用哪个实现** —— `createKit()` 注册表 + `select()`/`activate()`（含许可闸门）
 *   ② **角色与动作从哪来** —— `resolveAvatars()` / `resolveMotions()` / `toLegacyCatalog()`
 *      （许可可判定）。动作那一类此前**没有适配器**，业务代码直接读私有目录 ⇒
 *      它是唯一能绕过许可闸门的一类资产；`motion-resolver.ts` 补上了这个缺口。
 *   ③ **电脑操作怎么做** —— `createToolRegistry()`（三档权限 + 超时 + 校验 + 审计）
 *   ④ **数据怎么升级** —— `migrateStore()` + `STORE_DESCRIPTORS`（迁移链，不丢用户数据）
 *
 * 纪律：本包**不 import 任何业务模块**（不依赖 `apps/desktop`），
 * 只依赖 `zod` 的类型与 `node:crypto`；具体适配器实现由主进程注入。
 */
export * from './types.js'
export * from './kit.js'
export * from './asset-resolver.js'
export * from './motion-resolver.js'
export * from './tool-registry.js'
export * from './store-migrator.js'
export * from './store-descriptors.js'
