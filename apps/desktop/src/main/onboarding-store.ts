/**
 * apps/desktop/src/main/onboarding-store.ts —— 首次运行向导的状态与**判据**
 *
 * 设计要点（用户 M1 要求：供应商配置 → 连接测试 → 选择模型 → 称呼/人设/声音 → 权限确认 → 日程与隐私）：
 *   · 向导状态（当前步骤 / 是否完成 / 上次测试通过记录）持久化在 `settings.json` 的 `onboarding` 字段；
 *   · **每一步是否满足由主进程判定**，不看 renderer 的自报 —— 否则一个前端 bug 就能让用户
 *     带着"从未验证过的配置"进入日常使用；
 *   · `satisfied` 与 `blockedBy` 让 UI 能如实显示"为什么还不能下一步"，
 *     而不是给一个点了没反应的按钮。
 */
import { z } from 'zod'
import type { OnboardingState, OnboardingStatus, OnboardingStep } from '@airimate/shared'
import { OnboardingStepSchema } from '@airimate/shared'
import { activeProvider, loadProviders } from './provider-store.js'
import { secretStore } from './secrets-store.js'
import { getPersona } from './session-store.js'
import { loadSettings, mergeSettings, flushSettings, __resetSettingsCacheForTest } from './settings-store.js'
import { listPermissions } from './permission-store.js'
import { loadQuietHours } from './quiet-store.js'
import { loadSchedules } from './schedule-store.js'
import { log } from './log.js'

/**
 * 持久化形状（真源在 `packages/shared/src/settings.ts` 的 `AppSettingsSchema.onboarding`）。
 * 这里再声一次是为了**读旧文件时也能收敛**（settings 解析失败会整体回退默认值，
 * 而向导状态不该被别的字段带崩）。
 */
export const OnboardingStateSchema = z.object({
  step: OnboardingStepSchema.default('provider'),
  completedAt: z.number().nullable().default(null),
  lastTestOk: z.object({
    providerId: z.string().max(64),
    at: z.number(),
    code: z.string().max(32),
  }).nullable().default(null),
})

const STEPS: readonly OnboardingStep[] = ['provider', 'test', 'model', 'persona', 'permission', 'schedule', 'done']

export const DEFAULT_ONBOARDING: OnboardingState = {
  step: 'provider',
  completedAt: null,
  lastTestOk: null,
}

/**
 * 读取向导状态。
 *
 * ⚠ 这里**不**把 `settings.onboarding` 直接当类型用 —— `settings.json` 可能是老版本
 *   （没有这个字段）或被人手工改坏，一律经 schema 收敛后再用。
 */
export function loadOnboarding(): OnboardingState {
  const raw = (loadSettings() as unknown as { onboarding?: unknown }).onboarding
  const parsed = OnboardingStateSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  if (raw !== undefined) {
    log().warn('向导状态校验失败 → 回到第一步（其余设置不受影响）', {}, 'onboarding.state.invalid')
  }
  return { ...DEFAULT_ONBOARDING }
}

function saveOnboarding(next: OnboardingState): OnboardingState {
  const parsed = OnboardingStateSchema.parse(next)
  mergeSettings({ onboarding: parsed }, { immediate: true })
  return parsed
}

export function setOnboardingStep(step: OnboardingStep): OnboardingState {
  const cur = loadOnboarding()
  const next: OnboardingState = { ...cur, step }
  log().info('向导步骤变更', { from: cur.step, to: step }, 'onboarding.step')
  return saveOnboarding(next)
}

/** 记录一次连接测试结果（由 `provider:test` 调用；只有真的通过才写 ok= true） */
export function recordOnboardingTest(providerId: string, ok: boolean, code: string): void {
  const cur = loadOnboarding()
  // 失败时**清掉**上一次的成功记录：不能拿旧的"通过"去解锁新配置
  saveOnboarding({ ...cur, lastTestOk: ok ? { providerId, at: Date.now(), code } : null })
}

/**
 * 重置向导。
 *
 * ⚠ 必须走 `completeOnboarding(false)` 而不是只写 `onboarding`：
 *   后者会把 `settings.onboarded` 留在 `true`（界面据此认为"已经走过向导"），
 *   表现就是"点了重置但向导不弹"（单测抓出来的）。
 */
export function resetOnboarding(): OnboardingState {
  log().info('向导已重置（用户显式操作）', {}, 'onboarding.reset')
  completeOnboarding(false)
  return saveOnboarding({ ...DEFAULT_ONBOARDING })
}

export function completeOnboarding(completed: boolean): OnboardingState {
  const cur = loadOnboarding()
  const next: OnboardingState = completed
    ? { ...cur, step: 'done', completedAt: Date.now() }
    : { ...cur, completedAt: null, step: cur.step === 'done' ? 'provider' : cur.step }
  const saved = saveOnboarding(next)
  // 同时同步 `onboarded`（旧字段，界面上仍作为"是否首次运行"的依据）
  mergeSettings({ onboarded: completed }, { immediate: true })
  log().info('向导完成状态变更', { completed }, 'onboarding.complete')
  return saved
}

/**
 * 逐步判据（**都在主进程可验证**）。
 *
 * | 步骤 | 判据 |
 * |---|---|
 * | provider | 至少一个供应商，且**生效的那个**有密钥 |
 * | test | 存在一次针对**当前生效供应商**的成功测试记录 |
 * | model | 生效供应商的 `model` 非空（可来自手输或 `/models` 列表） |
 * | persona | 人设名字非空，且用户已设置称呼（`userTitle` 非默认空值） |
 * | permission | 权限表已初始化且**高风险项仍是 blocked**（即用户确实看过这一页） |
 * | schedule | 静音时段已落盘（默认值也算，但要有 `updatedAt` ⇒ 用户至少确认过一次） |
 */
export function onboardingStatus(): OnboardingStatus {
  const cur = loadOnboarding()
  const cfg = loadProviders()
  const active = activeProvider()
  const store = secretStore()
  const hasProvider = cfg.providers.length > 0 && active !== null && store.has(active.id)
  // 密钥后端不可用时**不阻塞**向导（否则用户永远出不去这一页），但 `hint` 会如实说明
  const keyBackendOk = store.backendName === 'safeStorage'
  const testOk = cur.lastTestOk !== null && active !== null && cur.lastTestOk.providerId === active.id
  const modelOk = active !== null && active.model.trim().length > 0
  const p = getPersona()
  const personaOk = p.name.trim().length > 0 && p.userTitle.trim().length > 0
  const perms = listPermissions()
  const permissionOk = perms.length > 0 && perms.every(x => x.effective === 'blocked' ? x.enabled === false : true)
  const quiet = loadQuietHours()
  const schedules = loadSchedules()
  const scheduleOk = quiet.updatedAt > 0 || schedules.schedules.length > 0

  const satisfied = {
    provider: hasProvider,
    test: testOk,
    model: modelOk,
    persona: personaOk,
    permission: permissionOk,
    schedule: scheduleOk,
  } as const

  const order: readonly Exclude<OnboardingStep, 'done'>[] = ['provider', 'test', 'model', 'persona', 'permission', 'schedule']
  let blockedBy: OnboardingStep | null = null
  let hint = '全部就绪'
  for (const s of order) {
    if (satisfied[s]) continue
    blockedBy = s
    hint = HINTS[s]
    break
  }
  // 密钥后端不可用是**必须可见**的（它决定密钥是否加密落盘）
  if (blockedBy === null && !keyBackendOk) {
    hint = `注意：密钥后端为 ${store.backendName}，密钥无法加密保存（拒绝降级为明文）`
  }

  return {
    state: cur,
    satisfied,
    blockedBy,
    hint,
    completed: cur.completedAt !== null,
  }
}

const HINTS: Record<Exclude<OnboardingStep, 'done'>, string> = {
  provider: '请先添加一个供应商（baseURL + 模型 + API Key），密钥只在本机加密保存',
  test: '请点「测试连接」——必须真的连通才能继续（未验证的配置不会进入日常使用）',
  model: '请选择或填写模型名',
  persona: '请设置她的名字，以及她怎么称呼你',
  permission: '请确认权限页：高风险能力（支付/改密码/读凭据）永远是「禁止」，无法被开启',
  schedule: '请确认静音时段与隐私设置（哪段时间不打扰你）',
}

/** 向导的步骤顺序（UI 与探针共用，避免两处各写一份） */
export const ONBOARDING_STEPS = STEPS

/**
 * 判断某一步的**下一步**应该去哪：满足就前进，不满足就停在原地。
 * `done` 只有在 `completeOnboarding(true)` 之后才会被设置。
 */
export function advanceOnboarding(from: OnboardingStep): OnboardingStatus {
  const st = onboardingStatus()
  const idx = STEPS.indexOf(from)
  if (idx < 0) return st
  if (st.blockedBy !== null && STEPS.indexOf(st.blockedBy) <= idx) {
    // 当前步还没满足：留在原地（并把它写回，纠正手工改坏的步骤值）
    setOnboardingStep(st.blockedBy)
    return onboardingStatus()
  }
  const next = STEPS[Math.min(STEPS.length - 1, idx + 1)] ?? 'done'
  setOnboardingStep(next)
  return onboardingStatus()
}

/** 退出前确保落盘（向导状态是"用户走过了没有"的唯一证据，不能丢） */
export function flushOnboarding(): void {
  flushSettings()
}

/**
 * **仅供单测**：丢弃内存缓存，让下一次访问重新从磁盘读取。
 *
 * 为什么需要它：向导状态存在 `settings.json` 里，而 `loadSettings()` 有内存缓存 ——
 * 只删文件、不清缓存，"重启后不再弹向导"这条判据就**测不出来**
 * （读到的还是进程里那份旧数据）。
 */
export function __resetCacheForTest(): void {
  __resetSettingsCacheForTest()
}
