/**
 * @airimate/security/secrets —— 密钥的唯一入口（Tech-Spec §7.3）
 *
 * 硬要求：
 *   - 明文密钥**只在这一刻存在于内存**，写入后立即丢弃；
 *   - renderer 只能拿到 { hasKey, keyFingerprint, keyLength }；
 *   - 后端不可用（safeStorage 不可用）时**拒绝保存**，绝不降级为明文落盘；
 *   - 密钥不得出现在日志、崩溃转储、进程命令行、诊断包与分发物中。
 *
 * 本模块**不 import electron**：由调用方注入 CryptoBackend，便于单测与静态审计。
 */
import { createHash, timingSafeEqual } from 'node:crypto'

export interface CryptoBackend {
  readonly name: 'safeStorage' | 'credential-manager' | 'unavailable'
  available: () => boolean
  encrypt: (plain: string) => Buffer
  decrypt: (cipher: Buffer) => string
}

export interface StoredSecretMeta {
  providerId: string
  keyFingerprint: string
  keyLength: number
  updatedAt: number
}

/** 密钥指纹：sha256 前 8 位（十六进制）。只用于"是不是同一把钥匙"，不可逆推。 */
export function keyFingerprint(plain: string): string {
  return createHash('sha256').update(plain, 'utf8').digest('hex').slice(0, 8)
}

/** 常量时间比较（避免通过响应时间侧写密钥） */
export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** 入库前的形态校验：拒绝空白、超长、含换行的输入（防注入到配置文件） */
export function validateKeyShape(plain: string): { ok: true } | { ok: false, reason: 'empty' | 'too-long' | 'control-chars' } {
  if (plain.length === 0) return { ok: false, reason: 'empty' }
  if (plain.length > 400) return { ok: false, reason: 'too-long' }
  // 允许可见 ASCII + 常见 Unicode，但拒绝 C0/C1 控制字符与换行
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return { ok: false, reason: 'control-chars' }
  }
  return { ok: true }
}

/**
 * 密钥仓库接口。主进程实现（写文件），renderer **没有**实现也不需要。
 */
export interface SecretStore {
  readonly backendName: CryptoBackend['name']
  isAvailable: () => boolean
  has: (providerId: string) => boolean
  fingerprintOf: (providerId: string) => string | null
  lengthOf: (providerId: string) => number | null
  /** 明文只在参数里；实现方负责加密落盘后不保留任何副本 */
  set: (providerId: string, plain: string) => void
  /** 仅在主进程出网前调用一次；调用方负责不把返回值写进任何日志 */
  get: (providerId: string) => string | null
  clear: (providerId: string) => void
  list: () => StoredSecretMeta[]
}

export interface SecretStoreFs {
  readCipher: (file: string) => Buffer | null
  writeCipher: (file: string, data: Buffer) => void
  removeCipher: (file: string) => void
  readMeta: () => Record<string, StoredSecretMeta>
  writeMeta: (meta: Record<string, StoredSecretMeta>) => void
  cipherFileOf: (providerId: string) => string
}

/** providerId 必须匹配白名单形态，避免路径穿越到 secrets 目录外 */
export function assertSafeProviderId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw new Error(`不安全的 providerId（只允许 [a-z0-9_-]，≤64 字符）`)
  }
}

export function createSecretStore(backend: CryptoBackend, fs: SecretStoreFs): SecretStore {
  const available = (): boolean => backend.name !== 'unavailable' && backend.available()

  return {
    backendName: backend.name,
    isAvailable: available,

    has(providerId) {
      assertSafeProviderId(providerId)
      return fs.readMeta()[providerId] !== undefined && fs.readCipher(fs.cipherFileOf(providerId)) !== null
    },

    fingerprintOf(providerId) {
      assertSafeProviderId(providerId)
      return fs.readMeta()[providerId]?.keyFingerprint ?? null
    },

    lengthOf(providerId) {
      assertSafeProviderId(providerId)
      return fs.readMeta()[providerId]?.keyLength ?? null
    },

    set(providerId, plain) {
      assertSafeProviderId(providerId)
      if (!available()) {
        throw new Error('密钥后端不可用：拒绝保存（绝不降级为明文）')
      }
      const shape = validateKeyShape(plain)
      if (!shape.ok) throw new Error(`密钥形态不合法：${shape.reason}`)
      const cipher = backend.encrypt(plain)
      fs.writeCipher(fs.cipherFileOf(providerId), cipher)
      const meta = fs.readMeta()
      meta[providerId] = {
        providerId,
        keyFingerprint: keyFingerprint(plain),
        keyLength: plain.length,
        updatedAt: Date.now(),
      }
      fs.writeMeta(meta)
    },

    get(providerId) {
      assertSafeProviderId(providerId)
      if (!available()) return null
      const cipher = fs.readCipher(fs.cipherFileOf(providerId))
      if (!cipher) return null
      try {
        return backend.decrypt(cipher)
      } catch {
        return null
      }
    },

    clear(providerId) {
      assertSafeProviderId(providerId)
      fs.removeCipher(fs.cipherFileOf(providerId))
      const meta = fs.readMeta()
      delete meta[providerId]
      fs.writeMeta(meta)
    },

    list() {
      return Object.values(fs.readMeta())
    },
  }
}

/** 内存后端：仅用于单元测试；生产启动时若落到它必须报错退出 */
export function createMemoryBackend(): CryptoBackend & { peek: (p: string) => string | undefined } {
  const map = new Map<string, string>()
  let n = 0
  return {
    name: 'unavailable',
    available: () => false,
    encrypt: (plain) => { const k = `mem-${n++}`; map.set(k, plain); return Buffer.from(k, 'utf8') },
    decrypt: (cipher) => map.get(cipher.toString('utf8')) ?? '',
    peek: (p) => map.get(p),
  }
}
