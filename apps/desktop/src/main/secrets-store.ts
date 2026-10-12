/**
 * apps/desktop/src/main/secrets-store.ts —— 主进程密钥仓库（safeStorage 后端）
 *
 * 行为：
 *   - `safeStorage.isEncryptionAvailable() === false` ⇒ 后端标记 unavailable，**拒绝保存密钥**（不降级明文）；
 *   - 密文落 `%APPDATA%\AiriMateOne\secrets\<providerId>.bin`，元数据（指纹/长度）落 `secrets/meta.json`
 *     （元数据里**没有**任何可推导出密钥的材料，只有 sha256 前 8 位与长度）；
 *   - 密钥明文只在 `get()` 的一瞬间存在于内存，且调用方（airi-core）不得记录它。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { safeStorage } from 'electron'
import { createSecretStore } from '@airimate/security'
import type { CryptoBackend, SecretStore, SecretStoreFs, StoredSecretMeta } from '@airimate/security'
import { migrateStore, storeDescriptor } from '@airimate/companion-kit'
import type { MigrationOutcome } from '@airimate/companion-kit'
import { appPaths } from './paths.js'
import { registerMigrationProbe } from './store-registry.js'
import { log } from './log.js'

/**
 * 上次读 `meta.json` 时的迁移结论。密钥元数据是"最不能悄悄重置"的东西之一，
 * 所以它也必须出现在 `kit:stores` 里（否则界面无法区分"没登记"与"没迁移"）。
 */
let lastMigration: MigrationOutcome | null = null

/**
 * `secrets/meta.json` 的**版本化形状**。
 *
 * ⚠ 它原来是一个裸的 `Record<providerId, StoredSecretMeta>` —— **没有 version 字段**，
 *   于是"升级时迁移"这条路根本走不通（迁移器无法判断文件是什么形状）。
 *   现在包一层 `{ version, entries }`，并保留对**旧裸格式**的读取
 *   （见 `readMeta()` 的兼容分支）：用户已经存了密钥，绝不能因为格式升级而"密钥不见了"。
 */
const SecretMetaStoreSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string().max(64), z.object({
    providerId: z.string().max(64),
    keyFingerprint: z.string().max(16),
    keyLength: z.number().int().min(0),
    updatedAt: z.number(),
  })),
})
type SecretMetaStore = z.infer<typeof SecretMetaStoreSchema>

function backend(): CryptoBackend {
  const available = (): boolean => {
    try { return safeStorage.isEncryptionAvailable() } catch { return false }
  }
  return {
    name: 'safeStorage',
    available,
    encrypt: (plain: string) => safeStorage.encryptString(plain),
    decrypt: (cipher: Buffer) => safeStorage.decryptString(cipher),
  }
}

function fsAdapter(): SecretStoreFs {
  const p = appPaths()
  const metaFile = join(p.secretsDir, 'meta.json')
  /**
   * ⚠ 每个写操作都先 `mkdirSync(recursive)`。
   *
   * 生产路径上 `ensureRuntimeDirs()` 已经建过目录，但**不能依赖它**：
   * 单测直接调用 store 时目录不存在 ⇒ `openSync` ENOENT ⇒ 密钥保存静默失败
   * （实测踩到：用例报 `ENOENT ... secrets/p_xxx.bin`）。
   * "写之前保证父目录存在"本来就是写操作自己的责任。
   */
  const ensure = (file: string): void => { mkdirSync(dirname(file), { recursive: true }) }
  return {
    cipherFileOf: (providerId: string) => join(p.secretsDir, `${providerId}.bin`),
    readCipher: (file: string) => (existsSync(file) ? readFileSync(file) : null),
    writeCipher: (file: string, data: Buffer) => { ensure(file); writeFileSync(file, data, { mode: 0o600 }) },
    removeCipher: (file: string) => { if (existsSync(file)) rmSync(file, { force: true }) },
    readMeta: () => {
      try {
        if (!existsSync(metaFile)) return {}
        const raw = JSON.parse(readFileSync(metaFile, 'utf8')) as unknown
        /**
         * ① 新格式：`{ version, entries }` ⇒ 过迁移链后取 entries。
         * ② **旧裸格式**：直接就是 `Record<providerId, meta>`。
         *    兼容它不是为了省事，而是因为"升级后密钥不见了"是**不可接受的失败**：
         *    用户得重新去各家后台抄一遍 key。检测方式用形状（有 `version` + `entries`），
         *    不猜、不按文件时间判断。
         */
        const looksVersioned = raw !== null && typeof raw === 'object'
          && typeof (raw as Record<string, unknown>).version === 'number'
          && typeof (raw as Record<string, unknown>).entries === 'object'
        if (looksVersioned) {
          const desc = storeDescriptor('secrets-meta')
          let candidate: unknown = raw
          if (desc) {
            const out = migrateStore(raw, desc)
            lastMigration = out
            if (out.ok) {
              candidate = out.data
              if (out.steps.length > 0) {
                log().info('密钥元数据已迁移', { steps: out.steps.map(s => s.describe).join(' | ').slice(0, 200) }, 'secrets.meta.migrated')
              }
            } else if (!(out.reason === 'no-version-field' && desc.version === 1)) {
              log().warn('密钥元数据无法迁移 → 按空元数据运行（密文文件保留，可重建元数据）', {
                reason: out.reason, detail: out.detail.slice(0, 200),
              }, 'secrets.meta.migration-failed')
              return {}
            }
          }
          const parsed = SecretMetaStoreSchema.safeParse(candidate)
          if (parsed.success) return parsed.data.entries
          log().warn('密钥元数据校验失败 → 按空元数据运行（密文文件保留）', {
            issues: parsed.error.issues.slice(0, 4).map(i => `${i.path.join('.')}:${i.message}`).join(' | '),
          }, 'secrets.meta.invalid')
          return {}
        }
        // 旧裸格式：逐条校验，坏掉的条目丢掉（不让一条坏数据毁掉全部密钥元数据）
        const legacy: Record<string, StoredSecretMeta> = {}
        for (const [k, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
          const one = z.object({
            providerId: z.string().max(64), keyFingerprint: z.string().max(16),
            keyLength: z.number().int().min(0), updatedAt: z.number(),
          }).safeParse(v)
          if (one.success) legacy[k] = one.data
        }
        if (Object.keys(legacy).length > 0) {
          log().info('检测到旧格式密钥元数据，已按兼容路径读取', { count: Object.keys(legacy).length }, 'secrets.meta.legacy-format')
        }
        return legacy
      } catch { return {} }
    },
    writeMeta: (meta: Record<string, StoredSecretMeta>) => {
      ensure(metaFile)
      // 统一写**新格式**（带 version）⇒ 下次升级就有迁移路径了
      const payload: SecretMetaStore = { version: 1, entries: meta }
      writeFileSync(metaFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    },
  }
}

let store: SecretStore | null = null

export function secretStore(): SecretStore {
  if (!store) store = createSecretStore(backend(), fsAdapter())
  return store
}

/** 仅供单测：丢弃实例缓存与上次的迁移结论（否则用例之间会互相污染） */
export function __resetSecretStoreForTest(): void {
  store = null
  lastMigration = null
}

/**
 * ★ 把密钥元数据接进**存储登记表**（本轮补的缺口）。
 * 它没走 `createJsonStore`（密文走独立目录 + 特殊权限），但迁移结论必须可见 ——
 * "升级后密钥不见了"是**不可接受的失败**，界面至少得能如实报出迁移发生了什么。
 */
registerMigrationProbe('secrets-meta', 'secrets-meta', () => lastMigration)
