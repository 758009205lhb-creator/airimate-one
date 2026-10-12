/**
 * apps/desktop/src/main/json-store.ts —— 主进程小 JSON 存储的公共骨架
 *
 * 为什么抽出来：M2 一口气新增 6 个存储（日程 / 提醒 / 静音 / 权限 / 活动 / 引擎状态），
 * 每个都手写一遍"原子写 + schema 校验 + 损坏回退 + 内存缓存"必然会漂移
 * （本项目已经因为"同一个语义两处实现"踩过坑）。这里把**唯一正确写法**固化一次。
 *
 * 纪律：
 *   · 原子写：临时文件 → fsync → rename（断电不会留下半个文件）；
 *   · 校验失败**不覆盖原文件**，回退默认值并记脱敏日志（用户数据比"能启动"重要）；
 *   · 所有日志只记长度 / 计数 / 错误码；
 *   · ★ **升级路径**（M5 适配层）：`version` 不是 `1` 时先走 `companion-kit` 的迁移链；
 *     迁移不了（版本更新/缺步骤）就**保留原文件并回退默认值**，绝不清空用户数据。
 */
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { z } from 'zod'
import { migrateStore, storeDescriptor, type MigrationOutcome } from '@airimate/companion-kit'
import { appPaths } from './paths.js'
import { registerStore } from './store-registry.js'
import { log } from './log.js'

export interface JsonStoreOptions<T> {
  /** 文件名（落在 `%APPDATA%\AiriMateOne\` 下） */
  file: string
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
  /** 文件不存在或损坏时的默认值（必须是**新对象**，避免调用方共享同一引用） */
  fallback: () => T
  /** 日志事件前缀，如 `schedule` */
  tag: string
  /**
   * 存储的逻辑名（用于在 `STORE_DESCRIPTORS` 里查迁移链）。
   *
   * ⚠ **必须与登记名逐字一致**（`schedules` / `reminders` / `permissions` / `knowledge-cache` …），
   *   不要图省事复用 `tag`：`tag` 是日志前缀（`schedule` / `reminder` / `permission` / `knowledge`），
   *   两者差一个 `s` 就会让 `storeDescriptor()` 返回 null ⇒ **整段迁移链被跳过**。
   *   这个坑真的踩到过（外部复核指出）：今天无害（全 v1、无迁移步骤），
   *   但 M3/M4 一旦给 `schedules` 加 v2，老数据就会**回退默认值**。
   */
  storeName?: string
  /**
   * 该存储当前声明的 schema 版本（默认 1）。
   * 与 `AppSettingsSchema.version` 一样是**常量字面量**：只有真的改了形状才允许 +1，
   * 并且必须同时在 `STORE_DESCRIPTORS` 里加一条迁移。
   */
  schemaVersion?: number
}

export interface JsonStore<T> {
  load: () => T
  save: (next: T) => void
  /** 丢弃内存缓存并重新读盘（也用于"冷启动读取"的验收） */
  reload: () => { ok: boolean, bytes: number }
  filePath: () => string
  /** 清空文件（数据主体权利：彻底删除） */
  destroy: () => { removed: boolean, bytes: number }
  /** 上次读盘时的迁移结论（`null` = 未发生迁移 / 尚未读盘）；诊断与探针读它 */
  lastMigration: () => MigrationOutcome | null
  /** 仅供单测 */
  __reset: () => void
}

export function atomicWriteJson(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w')
  try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
}

export function createJsonStore<T>(o: JsonStoreOptions<T>): JsonStore<T> {
  const file = (): string => join(appPaths().userData, o.file)
  let cache: T | null = null
  let lastMigration: MigrationOutcome | null = null
  /** 登记名对不上就等于迁移链不生效；启动时会在 `load()` 里吵一次 */
  const registeredName = storeDescriptor(o.storeName ?? o.tag)?.name ?? ''

  /**
   * 把落盘对象里的 `version` 归一化成**当前版本**。
   *
   * ★ 为什么是"归一化"而不是"删掉"（两次实测踩坑换来的）：
   *   各 store 的 schema 里写的是 `version: z.literal(1)`（**必需字段**）。
   *   · 直接删掉 `version` ⇒ schema 报"必须提供 version" ⇒ 校验失败；
   *   · 原样保留 ⇒ 迁移到 v2 后 `version=2` 不匹配 `literal(1)` ⇒ 同样失败。
   *   两条路都通向"回退默认值 = 用户数据消失"。
   *   归一化成当前版本则两种输入都通过：schema 只负责**形状**，
   *   版本由本模块（写）与迁移链（读）统一掌管。
   *   内存里的对象仍带 `version` —— 与各 store 现有代码（`{ version: 1, ... }`）
   *   完全兼容，不必改任何调用点。
   */
  const normalizeVersion = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
    return { ...(v as Record<string, unknown>), version: o.schemaVersion ?? 1 }
  }

  const load = (): T => {
    if (cache) return cache
    const f = file()
    try {
      if (existsSync(f)) {
        const raw = JSON.parse(readFileSync(f, 'utf8')) as unknown
        /**
         * ★ 先过迁移链（如果这个存储登记了迁移）。
         *
         * 为什么要在这里而不是各 store 自己写：M1/M2 的存储都是
         * `version: z.literal(1)` —— 一旦版本变 2，老文件会**直接校验失败**
         * 并回退默认值，也就是**用户的记忆/日程/提醒全部消失**。
         * 迁移链把"升级"变成声明式的一件事，且失败时保留原文件。
         */
        const desc = storeDescriptor(o.storeName ?? o.tag)
        let candidate: unknown = raw
        if (!desc) {
          /**
           * ⚠ 查不到描述子 = **这个存储没有登记** ⇒ 迁移链整体不生效。
           *   今天（全 v1、无迁移步骤）无害，但一旦有人给它加 v2 就会丢数据。
           *   所以这里**必须吵**：`tag` 与登记名差一个字母就会走到这条路径
           *   （实测：`schedule` vs `schedules`）。
           */
          log().warn(`${o.tag} 未在 STORE_DESCRIPTORS 登记 → 迁移链不生效（请检查 storeName 拼写）`, {
            lookupKey: o.storeName ?? o.tag,
          }, `${o.tag}.store-unregistered`)
        }
        if (desc) {
          const out = migrateStore(raw, desc)
          lastMigration = out
          if (out.ok) {
            candidate = out.data
            if (out.steps.length > 0) {
              log().info(`${o.tag} 数据已迁移`, {
                from: out.fromVersion ?? -1, to: out.toVersion, steps: out.steps.length,
                describes: out.steps.map(s => s.describe).join(' | ').slice(0, 200),
              }, `${o.tag}.migrated`)
            }
          } else if (out.reason === 'no-version-field' && desc.version === 1) {
            // 老文件没写版本，但当前就是 v1 ⇒ 当作 v1 接受（下面 schema 会校验形状）
            candidate = raw
          } else {
            /**
             * ⚠ 迁移不了（版本更新 / 缺步骤 / 迁移抛错）⇒ **保留原文件**，
             *   以默认值运行，并把原因**如实**记日志。
             *   绝不清空、绝不覆盖 —— 用户降级安装后不该丢数据。
             */
            log().warn(`${o.tag} 数据无法迁移 → 以默认值运行（原文件保留）`, {
              from: out.fromVersion ?? -1, to: out.toVersion, reason: out.reason, detail: out.detail.slice(0, 200),
            }, `${o.tag}.migration-failed`)
            cache = o.fallback()
            return cache
          }
        }
        const parsed = o.schema.safeParse(normalizeVersion(candidate))
        if (parsed.success) { cache = parsed.data; return cache }
        log().warn(`${o.tag} 文件校验失败 → 使用默认值（原文件保留）`, {
          issues: parsed.error.issues.slice(0, 5).map(i => `${i.path.join('.')}:${i.message}`).join(' | '),
        }, `${o.tag}.invalid`)
      }
    } catch (e) {
      log().warn(`${o.tag} 文件读取失败 → 使用默认值`, { err: e instanceof Error ? e.message : String(e) }, `${o.tag}.read-failed`)
    }
    cache = o.fallback()
    return cache
  }

  const save = (next: T): void => {
    cache = next
    try {
      /**
       * ★ 落盘时**保证 `version` 与声明的 schema 版本一致**。
       *
       * 为什么要在这里补：调用方拼对象时可能漏写 `version`（多数 store 的
       * `save()` 只拼 `{ version: 1, ... }`，但手工构造的路径迟早会漏），
       * 而漏了 `version` 的文件在**下次升级时会被判成"没有版本字段"** ⇒ 拒绝迁移。
       * 统一在这里兜底，比要求每个调用点都记得写要可靠。
       */
      const version = o.schemaVersion ?? 1
      const stamped = (next !== null && typeof next === 'object' && !Array.isArray(next) && (next as Record<string, unknown>).version !== version)
        ? { ...(next as Record<string, unknown>), version }
        : next
      atomicWriteJson(file(), `${JSON.stringify(stamped, null, 2)}\n`)
    } catch (e) {
      log().warn(`${o.tag} 写入失败`, { err: e instanceof Error ? e.message : String(e) }, `${o.tag}.write-failed`)
    }
  }

  const api: JsonStore<T> = {
    load,
    save,
    filePath: file,
    reload: () => {
      cache = null
      const f = file()
      let bytes = 0
      try { bytes = existsSync(f) ? statSync(f).size : 0 } catch { bytes = 0 }
      load()
      return { ok: true, bytes }
    },
    destroy: () => {
      cache = null
      lastMigration = null
      const f = file()
      let bytes = 0
      let removed = false
      try {
        if (existsSync(f)) { bytes = statSync(f).size; rmSync(f, { force: true }); removed = true }
      } catch (e) {
        log().warn(`${o.tag} 文件删除失败`, { err: e instanceof Error ? e.message : String(e) }, `${o.tag}.destroy-failed`)
      }
      return { removed, bytes }
    },
    lastMigration: () => lastMigration,
    __reset: () => { cache = null; lastMigration = null },
  }
  // 登记到全局表：诊断/隐私页/探针要能读到"迁移到底发生没发生"
  // （只登记**纯读**的探针与路径，不把整个 store 交出去 —— 见 store-registry.ts 的说明）
  registerStore({
    storeName: registeredName,
    tag: o.tag,
    lastMigration: () => lastMigration,
    filePath: file,
  })
  return api
}
