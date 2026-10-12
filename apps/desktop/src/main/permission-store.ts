/**
 * apps/desktop/src/main/permission-store.ts —— 三档权限（M2 / M3 的公共底座）
 *
 * 三档（用户要求）：
 *   · `read-only`  只读，可自动执行；
 *   · `confirm`    普通操作，**必须用户确认**；
 *   · `blocked`    高风险：禁止，或需要二次确认后仍受硬下限约束。
 *
 * ⚠ **硬下限不可被绕过**：`PERMISSION_TIER_FLOOR`（shared）写死了
 *   "禁止自动支付 / 改密码 / 读凭据 / 模拟键鼠 / 改系统设置"。
 *   用户即使把 `tier` 设成 `read-only`，`effective` 仍会被收紧到 `blocked`，
 *   并且 `enabled` 一律强制为 `false`。
 *   这不是提示词里的君子协定，而是**落在数据层**的约束。
 */
import { z } from 'zod'
import type { Permission, PermissionKind, PermissionSet, PermissionTier } from '@airimate/shared'
import {
  PERMISSION_TIER_FLOOR, effectiveTier, PermissionKindSchema, PermissionTierSchema,
} from '@airimate/shared'
import { createJsonStore } from './json-store.js'
import { log } from './log.js'

/** 每个能力的默认档位与说明（默认值：读类只读、写类需确认、危险类禁止） */
const DEFAULTS: Record<PermissionKind, { label: string, tier: PermissionTier, enabled: boolean }> = {
  'screen-capture': { label: '屏幕理解（按需截图）', tier: 'read-only', enabled: false },
  'file-read': { label: '读取授权目录内的文件', tier: 'read-only', enabled: false },
  'file-write': { label: '写入授权目录', tier: 'confirm', enabled: false },
  'app-launch': { label: '启动应用', tier: 'confirm', enabled: false },
  'shell-exec': { label: '执行命令', tier: 'confirm', enabled: false },
  'clipboard-read': { label: '读取剪贴板', tier: 'confirm', enabled: false },
  'window-control': { label: '控制窗口（移动/置顶）', tier: 'read-only', enabled: false },
  'input-simulate': { label: '模拟键鼠（永久禁止自动执行）', tier: 'blocked', enabled: false },
  'system-settings': { label: '修改系统设置（禁止）', tier: 'blocked', enabled: false },
  'credential-access': { label: '读取凭据文件（禁止）', tier: 'blocked', enabled: false },
  'payment': { label: '支付 / 下单（禁止）', tier: 'blocked', enabled: false },
}

export const PermissionSchema = z.object({
  kind: PermissionKindSchema,
  label: z.string().max(60),
  /** 用户请求的档位 */
  tier: PermissionTierSchema,
  /** 实际生效档位（= max(硬下限, 请求值)） */
  effective: PermissionTierSchema,
  enabled: z.boolean(),
  pathAllowlist: z.array(z.string().max(400)).max(64).default([]),
  excludeRegions: z.array(z.object({
    x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    w: z.number().min(0).max(1), h: z.number().min(0).max(1),
  })).max(16).default([]),
  redactSensitive: z.boolean().default(true),
  updatedAt: z.number().default(0),
  grantedBy: z.enum(['onboarding', 'settings', 'default', 'floor']).default('default'),
})

const StoreSchema = z.object({
  version: z.literal(1),
  permissions: z.array(PermissionSchema).max(32),
  updatedAt: z.number().default(0),
})
type Store = z.infer<typeof StoreSchema>

function defaults(): Permission[] {
  return (Object.keys(DEFAULTS) as PermissionKind[]).map((kind) => {
    const d = DEFAULTS[kind]
    const eff = effectiveTier(kind, d.tier)
    return {
      kind,
      label: d.label,
      tier: d.tier,
      effective: eff,
      // 硬下限为 blocked 的能力**永远**不允许启用
      enabled: eff === 'blocked' ? false : d.enabled,
      pathAllowlist: [],
      excludeRegions: [],
      redactSensitive: true,
      updatedAt: 0,
      grantedBy: eff === 'blocked' && d.tier !== 'blocked' ? 'floor' : 'default',
    }
  })
}

const store = createJsonStore<Store>({
  file: 'permissions.json',
  schema: StoreSchema,
  fallback: () => ({ version: 1, permissions: defaults(), updatedAt: 0 }),
  tag: 'permission',
  /** 登记名（迁移链按它查表；**改了它必须同步 STORE_DESCRIPTORS**） */
  storeName: 'permissions',
})

/**
 * 规范化：补齐缺失的能力、重算 `effective`、强制硬下限。
 * 每次读盘都过一遍 —— 这样**手工编辑过的 `permissions.json` 也无法放宽**危险能力。
 */
function normalize(p: Permission[]): Permission[] {
  const byKind = new Map(p.map(x => [x.kind, x]))
  const out: Permission[] = []
  for (const kind of Object.keys(DEFAULTS) as PermissionKind[]) {
    const d = DEFAULTS[kind]
    const cur = byKind.get(kind)
    const requested = cur?.tier ?? d.tier
    const eff = effectiveTier(kind, requested)
    out.push({
      kind,
      label: cur?.label ?? d.label,
      tier: requested,
      effective: eff,
      enabled: eff === 'blocked' ? false : (cur?.enabled ?? d.enabled),
      pathAllowlist: cur?.pathAllowlist ?? [],
      excludeRegions: cur?.excludeRegions ?? [],
      redactSensitive: cur?.redactSensitive ?? true,
      updatedAt: cur?.updatedAt ?? 0,
      grantedBy: cur?.grantedBy ?? 'default',
    })
  }
  return out
}

export function listPermissions(): Permission[] {
  return normalize(store.load().permissions)
}

export function getPermission(kind: PermissionKind): Permission {
  const found = listPermissions().find(p => p.kind === kind)
  // normalize 保证了每种 kind 都存在；这里只是消掉类型上的 undefined
  return found ?? normalize([]).find(p => p.kind === kind) as Permission
}

export function setPermission(input: PermissionSet): Permission {
  const cur = listPermissions()
  const target = cur.find(p => p.kind === input.kind)
  if (!target) throw new Error(`未知能力：${input.kind}`)
  const requestedTier = input.tier ?? target.tier
  const eff = effectiveTier(input.kind, requestedTier)
  const floorApplied = eff !== requestedTier
  const next: Permission = {
    ...target,
    tier: requestedTier,
    effective: eff,
    enabled: eff === 'blocked' ? false : (input.enabled ?? target.enabled),
    pathAllowlist: input.pathAllowlist ?? target.pathAllowlist,
    excludeRegions: input.excludeRegions ?? target.excludeRegions,
    redactSensitive: input.redactSensitive ?? target.redactSensitive,
    updatedAt: Date.now(),
    grantedBy: floorApplied ? 'floor' : 'settings',
  }
  const permissions = cur.map(p => (p.kind === next.kind ? next : p))
  store.save({ version: 1, permissions, updatedAt: Date.now() })
  log().info('权限已更新', {
    kind: next.kind,
    tierRequested: requestedTier,
    tierEffective: eff,
    enabled: next.enabled,
    floorApplied,
    allowlist: next.pathAllowlist.length,
    excludeRegions: next.excludeRegions.length,
  }, 'permission.set')
  if (floorApplied) {
    log().warn('权限请求宽于硬下限，已被收紧', {
      kind: next.kind, requested: requestedTier, effective: eff, floor: PERMISSION_TIER_FLOOR[next.kind],
    }, 'permission.floor-applied')
  }
  return next
}

/** 权限判定（执行器唯一入口；**不允许**调用方自己看 `tier` 做决定） */
export type PermissionDecision = 'allow' | 'needs-confirm' | 'denied'

export function decidePermission(kind: PermissionKind): { decision: PermissionDecision, permission: Permission } {
  const p = getPermission(kind)
  if (p.effective === 'blocked') return { decision: 'denied', permission: p }
  if (!p.enabled) return { decision: 'denied', permission: p }
  return { decision: p.effective === 'confirm' ? 'needs-confirm' : 'allow', permission: p }
}

/** 重置为出厂默认（**不会**把 blocked 变成允许 —— 见 `defaults()`） */
export function resetPermissions(): Permission[] {
  store.save({ version: 1, permissions: defaults(), updatedAt: Date.now() })
  return listPermissions()
}

/** `privacy:wipe` 用 */
export function destroyPermissionStore(): { removed: boolean, bytes: number } {
  return store.destroy()
}

export function permissionStorePath(): string {
  return store.filePath()
}

/** 供诊断使用（不暴露白名单内容，只给计数） */
export function permissionDigest(): { total: number, enabled: number, blocked: number, allowlistedDirs: number } {
  const all = listPermissions()
  return {
    total: all.length,
    enabled: all.filter(p => p.enabled).length,
    blocked: all.filter(p => p.effective === 'blocked').length,
    allowlistedDirs: all.reduce((n, p) => n + p.pathAllowlist.length, 0),
  }
}

/** 仅供单测：丢弃缓存 */
export function __resetPermissionStoreForTest(): void {
  store.__reset()
}
