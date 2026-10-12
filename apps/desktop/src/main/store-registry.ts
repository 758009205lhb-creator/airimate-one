/**
 * apps/desktop/src/main/store-registry.ts —— 本进程内所有存储实例的**登记表**
 *
 * 为什么需要它：
 *   `createJsonStore()` 是**按需创建**的（各 store 模块顶层调一次），没有全局目录。
 *   于是"迁移到底发生没发生"这件事只有那个实例自己知道 ——
 *   诊断/隐私页/探针要想读，就必须有人把它们登记下来。
 *
 * 纪律：
 *   · 只登记**实例引用与名字**，不读不写任何用户内容；
 *   · `snapshot()` 只回"上次读盘时的迁移结论"（版本号 + 步骤描述），
 *     **不含任何条目内容**；
 *   · `unregistered()` 把"用了 `tag` 但没在 `STORE_DESCRIPTORS` 登记"的存储列出来 ——
 *     那意味着它的**迁移链不生效**（实测踩过：`schedule` vs `schedules` 差一个 s）。
 */
import type { MigrationRecord, MigrationOutcome } from '@airimate/companion-kit'

/**
 * 登记项。
 *
 * ⚠ 这里**故意不引用 `JsonStore`**：本表只需要三样东西 —— 登记名、日志前缀、
 *   一个**纯读**的迁移结论探针。早先写成 `store: JsonStore<unknown>` 会强迫
 *   "不走 `createJsonStore`"的存储（settings / providers / secrets-meta）伪造一个
 *   完整 JsonStore 对象，而 `registeredStores()` 又会去调它的 `filePath()` ⇒ 运行期炸。
 *   收紧成最小接口后，那三个存储只需提供一个读函数，类型上就不可能再出这种事。
 */
interface Registration {
  /** 登记名（`STORE_DESCRIPTORS` 里的名字；空串 = 未登记，迁移链不生效） */
  storeName: string
  /** 日志前缀（用户可读的简称） */
  tag: string
  /** 上次读盘时的迁移结论（**纯读**，不得触发读盘/写盘） */
  lastMigration: () => MigrationOutcome | null
  /** 落盘路径（手写存储可省 —— 它们各有自己的目录约定） */
  filePath?: () => string
}

const registry = new Map<string, Registration>()

/** 由 `createJsonStore()` 调用（不要手工调） */
export function registerStore(r: Registration): void {
  // 以 `tag` 为键：同一个文件不会有两次创建，重复只可能是热重载/测试
  registry.set(r.tag, r)
}

/**
 * 登记一个**不走 `createJsonStore`** 的存储的迁移结论。
 *
 * 为什么需要（本轮实测抓到的缺口）：
 *   `settings` / `providers` / `secrets-meta` 三个存储因为各自的原因（防抖落盘、密钥目录、
 *   兼容旧裸数组格式）**手写**了原子写与校验，它们各自**接了 `migrateStore()`**，
 *   但**从没登记过** ⇒ `kit:stores` / 隐私页 / 诊断里**整个看不到这三个存储**
 *   （不是显示 null，是根本不在）。而本登记表存在的唯一理由就是让界面能区分
 *   "**没登记**"与"**登记了但没迁移**" —— 少了这三个，那个区分对最该被看见的
 *   设置、供应商配置、密钥元数据恰恰失效。
 *
 * `probe` 必须是**纯读**函数：只回"上次读盘时的迁移结论"，不得触发读盘或写盘
 * （它会在诊断/隐私页打开时被调用）。
 */
export function registerMigrationProbe(storeName: string, tag: string, probe: () => MigrationOutcome | null): void {
  registry.set(tag, { storeName, tag, lastMigration: probe })
}

/**
 * 模块加载到此刻为止的登记项（**种子**）。
 *
 * 为什么需要（本轮实测踩到）：三个手写存储的登记发生在**模块顶层**
 * （`settings-store` / `provider-store` / `secrets-store` 被 `require` 的那一刻）。
 * 而单测的 `beforeEach` 会调 `__resetStoreRegistryForTest()` —— 如果它把表**清空**，
 * 那三个常驻登记就永久消失了，表现为"三个存储不见了"的**假失败**。
 * 所以"重置"必须是**回到种子状态**，而不是清空。
 */
const seed: Registration[] = [...registry.values()]

/** 仅供单测：把登记表恢复到**模块已加载完成**时的状态（不是清空 —— 见 `seed` 的说明） */
export function __resetStoreRegistryForTest(): void {
  registry.clear()
  for (const r of seed) registry.set(r.tag, r)
}

/** 每个存储上次读盘时的迁移结论（键 = 登记名） */
export function storeMigrationStates(): Record<string, MigrationRecord | null> {
  const out: Record<string, MigrationRecord | null> = {}
  for (const r of registry.values()) {
    if (!r.storeName) continue
    const m = r.lastMigration()
    out[r.storeName] = m === null
      ? null
      : {
        name: r.storeName,
        fromVersion: m.fromVersion,
        toVersion: m.toVersion,
        steps: m.steps,
        ok: m.ok,
        reason: m.reason,
        at: Date.now(),
      }
  }
  return out
}

/**
 * 用了 `tag` 但**没有登记名**的存储。
 * 非空 ⇒ 这些存储的迁移链不生效（虽然当前全 v1 无害，但升级时会丢数据）。
 * 与 `json-store.ts` 启动时的 warn 日志互补：日志给排障，这里给界面与探针。
 */
export function unregisteredStoreTags(): string[] {
  return [...registry.values()].filter(r => !r.storeName).map(r => r.tag).sort()
}

/** 已登记的存储清单（诊断用；只给名字与映射关系） */
export function registeredStores(): Array<{ tag: string, storeName: string, file: string }> {
  return [...registry.values()]
    // 手写存储（settings / providers / secrets-meta）没有 `filePath` —— 缺省给空串，绝不抛
    .map(r => ({ tag: r.tag, storeName: r.storeName, file: r.filePath ? r.filePath() : '' }))
    .sort((a, b) => a.tag.localeCompare(b.tag))
}
