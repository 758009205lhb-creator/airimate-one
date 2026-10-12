/**
 * apps/desktop/src/main/capabilities/data-adapters.ts —— `storage` 与 `privacy` 两类适配器
 *
 * 为什么需要它们（`--probe kit` 的实测读数）：
 *   `CAPABILITY_KINDS` 里声明了 9 类，而注册表里 `storage` 与 `privacy` 是
 *   **`registered: 0`** —— 界面枚举能力时这两类整个不出现。
 *   这与 `motion` 当年的缺口**同源**：类型里声明了，却从来没人注册，
 *   而探针的 `kinds` 清单也漏列了它们 ⇒ 缺口永远不会被断言发现。
 *
 * 这两类不是"再选一个实现"的语义（对比 avatar/tts/llm），而是**框架自身的两条通道**：
 *   · `storage` —— 本机存了哪些库、迁移链是否生效（决定"升级会不会丢数据"）；
 *   · `privacy` —— 数据主体权利（导出 / 删除）与"本机存了什么"的边界读数。
 *   所以它们不进 `SELECT_KINDS`（那里是"每类挑一个生效实现"），
 *   但仍必须**注册**：否则能力枚举会漏掉整类，用户与探针都看不到。
 *
 * ⚠ 三条纪律（都写进代码而不是注释里靠人记）：
 *   ① **绝不外泄绝对路径**。`privacySummary()` 返回 `userDataDir`，`registeredStores()`
 *      返回每个库的 `file` —— 它们**不得**进入适配器的 `capabilities` / `note` /
 *      诊断输出。这里只输出**布尔与计数**，`--probe kit` 的
 *      `kit.no-abs-path-in-output` 才是可机械验证的。
 *   ② **`init()` 不得有副作用**。它们会被诊断与隐私页调用 ⇒ 注入的读数必须是**纯读**的。
 *      这里不做任何 mkdir / 读盘触发，只消费注入进来的函数（单测传纯假函数即可）。
 *   ③ **"可用"要如实**。注入的读数为空 ⇒ `available:false` 并写清原因；
 *      绝不乐观写 `true`（那会让"框架坏了"看起来像"一切正常"）。
 *
 * ⚠ 许可为什么是 `firstPartyLicense`：这两类是**自研逻辑**（不是第三方资产、不是平台组件），
 *   所以它们在 `packaged` 形态下也能通过许可闸门 —— 这是正确的：
 *   存储与隐私通道本来就该在任何形态下可用。
 *   （对比 `packaged` 下被正确拒掉的私有 VRM：那是**资产**，这两类是**代码**。）
 */
import type { AssetLicense, BaseAdapter } from '@airimate/companion-kit'
import { firstPartyLicense } from '@airimate/companion-kit'

/** 只读摘要：存储通道一次采样能看到的全部事实（**都不含用户内容**） */
export interface StorageReadout {
  /** `STORE_DESCRIPTORS` 的条数（本应用声明了多少个库） */
  descriptorCount: number
  /** 其中标注为"含个人数据"的条数 */
  personalCount: number
  /** 迁移链上有步骤的库数（v1 全是 0 —— 一旦 >0 说明真的升过级） */
  storesWithMigrations: number
  /** 已登记的库数（登记 = 迁移链生效） */
  registeredCount: number
  /** **用了 tag 但没登记**的存储（非空 ⇒ 那些库的迁移链不生效 ⇒ 升级会丢数据） */
  unregistered: string[]
  /** 已经跑过迁移步骤的库数（读"上次读盘时的迁移结论"得到） */
  migratedCount: number
  /** 用户数据目录是否已存在（**只给布尔，不给路径**） */
  userDataDirExists: boolean
}

export interface StorageAdapter extends BaseAdapter {
  kind: 'storage'
  /** 存储通道的只读摘要（任意时刻可调；不触发读盘/写盘） */
  readout: () => StorageReadout
}

export function createStorageAdapter(o: {
  /** 只读：库的声明式登记表摘要 */
  catalog: () => Array<{ name: string, personal: boolean, version: number, migrations: number }>
  /** 只读：用了 tag 但没登记名的存储 */
  unregistered: () => string[]
  /** 只读：已登记的存储（**实现里带 file 字段，这里只数个数，不取路径**） */
  registered: () => unknown[]
  /** 只读：每个库上次读盘时的迁移结论（`steps` 是**步骤数组**，不是数字 —— 类型系统挡下过一次误读） */
  migrationStates: () => Record<string, { steps?: Array<{ from: number, to: number, describe: string }> } | null>
  /** 只读：用户数据目录是否存在 */
  userDataDirExists: () => boolean
}): StorageAdapter {
  /** 采样一次（每次调用都重新取，避免把陈旧的读数缓存成"当前状态"） */
  const sample = (): StorageReadout => {
    const catalog = o.catalog()
    const unregistered = o.unregistered()
    const registered = o.registered()
    const states = o.migrationStates()
    const migrated = Object.values(states).filter(s => s && (s.steps?.length ?? 0) > 0).length
    return {
      descriptorCount: catalog.length,
      personalCount: catalog.filter(c => c.personal).length,
      storesWithMigrations: catalog.filter(c => c.migrations > 0).length,
      registeredCount: registered.length,
      unregistered,
      migratedCount: migrated,
      userDataDirExists: o.userDataDirExists(),
    }
  }

  const adapter: StorageAdapter = {
    id: 'storage.json-descriptor-registry',
    kind: 'storage',
    label: '本地 JSON 存储与迁移链',
    origin: 'first-party',
    // 初始 false：只有 init() 实测通过才置 true
    available: false,
    unavailableReason: '尚未检测（未读取存储登记表）',
    capabilities: ['local-only', 'no-network'],
    license: firstPartyLicense('存储登记表与迁移链为本项目自研；数据只落本机用户目录'),
    requiresNetwork: false,
    /** 会写用户目录（对话/记忆/日程…）⇒ 如实标 true */
    writesUserContent: true,
    note: '声明式存储登记表 + 迁移链；`privacy:wipe` 据此删净。只读摘要只给计数与布尔，**不外泄任何路径或内容**',
    init() {
      /**
       * ⚠ `init()` 必须是**纯读**的（原因见文件头纪律②）。
       *   这里只做一次采样，用它来判"存储通道是否真的有内容可报告"。
       */
      const r = sample()
      if (r.descriptorCount <= 0) {
        adapter.available = false
        adapter.unavailableReason = '存储登记表为空 ⇒ 迁移链无从谈起（框架未正确接线）'
        adapter.capabilities = ['local-only', 'no-network', 'unavailable']
        return
      }
      adapter.available = true
      adapter.unavailableReason = null
      adapter.capabilities = [
        'local-only',
        'no-network',
        `stores:${r.descriptorCount}`,
        `personal:${r.personalCount}`,
        // 未登记的存储是**真缺口**，让它出现在能力标记里（界面与探针都能一眼看到）
        ...(r.unregistered.length > 0 ? [`unregistered:${r.unregistered.length}`] : []),
        ...(r.storesWithMigrations > 0 ? [`with-migrations:${r.storesWithMigrations}`] : ['all-v1']),
      ]
    },
    readout: sample,
  }
  return adapter
}

// ───────────────────────────────────────────────────────────────── 隐私

/** 只读摘要：数据主体权利的可用性（**不含任何内容，路径只以布尔形式出现**） */
export interface PrivacyReadout {
  /** 导出通道是否可用 */
  exportAvailable: boolean
  /** 删除通道是否可用 */
  wipeAvailable: boolean
  /** 本机已存在的数据文件个数（含配置） */
  filesPresent: number
  /** 其中"含个人数据"且已存在的个数 */
  personalFilesPresent: number
  /** 已存在的密钥文件个数（**只给计数**） */
  secretFilesPresent: number
  /** 已产出的导出文件个数 */
  exportFiles: number
  /** 源码级事实：renderer 是否有出网原语（本项目恒为 false） */
  rendererCanReachNetwork: false
}

export interface PrivacyAdapter extends BaseAdapter {
  kind: 'privacy'
  readout: () => PrivacyReadout
}

export function createPrivacyAdapter(o: {
  /** 只读：数据主体权利清单（导出 / 删除）是否已接线 */
  channels: () => { exportAvailable: boolean, wipeAvailable: boolean }
  /** 只读：隐私摘要（**实现返回里带路径，这里只取计数与布尔，路径不进适配器**） */
  summary: () => {
    files: Array<{ exists: boolean, kind: string }>
    secretFiles: number
    exportFiles: number
  }
}): PrivacyAdapter {
  const sample = (): PrivacyReadout => {
    const ch = o.channels()
    const s = o.summary()
    const files = s.files ?? []
    return {
      exportAvailable: ch.exportAvailable,
      wipeAvailable: ch.wipeAvailable,
      filesPresent: files.filter(f => f.exists).length,
      personalFilesPresent: files.filter(f => f.exists && f.kind === 'personal').length,
      secretFilesPresent: s.secretFiles ?? 0,
      exportFiles: s.exportFiles ?? 0,
      rendererCanReachNetwork: false,
    }
  }

  const adapter: PrivacyAdapter = {
    id: 'privacy.data-subject-rights',
    kind: 'privacy',
    label: '数据主体权利（导出 / 删除）',
    origin: 'first-party',
    available: false,
    unavailableReason: '尚未检测（未读取隐私通道接线状态）',
    capabilities: ['export', 'wipe', 'local-only'],
    license: firstPartyLicense('隐私导出/删除为本项目自研；不引入任何第三方数据处理方'),
    requiresNetwork: false,
    /** 会读并删用户数据 ⇒ 如实标 true */
    writesUserContent: true,
    note: '导出与删除两条通道；界面只显示计数与布尔（含密钥文件个数），**不回显路径与内容**',
    init() {
      const r = sample()
      /**
       * 可用性判据：**两条权利里至少有一条真的接着**。
       * 两条都没有 ⇒ 这不是"隐私功能降级"，而是"用户无法行使数据主体权利" ⇒ 如实报不可用。
       */
      if (!r.exportAvailable && !r.wipeAvailable) {
        adapter.available = false
        adapter.unavailableReason = '导出与删除两条通道都没有接线（未在 IPC 就绪后注入）'
        adapter.capabilities = ['local-only', 'unavailable']
        return
      }
      adapter.available = true
      adapter.unavailableReason = null
      adapter.capabilities = [
        'local-only',
        ...(r.exportAvailable ? ['export'] : []),
        ...(r.wipeAvailable ? ['wipe'] : []),
        `personal-files:${r.personalFilesPresent}`,
        `secret-files:${r.secretFilesPresent}`,
        'renderer-no-network',
      ]
    },
    readout: sample,
  }
  return adapter
}
