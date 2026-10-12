/**
 * @airimate/companion-kit/kit —— 能力注册表（适配层的唯一入口）
 *
 * 业务代码只与它打交道：
 *
 *   const kit = createKit({ profile: 'development' })
 *   kit.register(createSapiTtsAdapter(...))
 *   const tts = kit.select('tts')          // 解释为什么选它
 *   await kit.init()                       // 逐个 init，失败只标不可用
 *
 * 设计要点（都是为了"可替换"与"可解释"）：
 *   · **注册不等于生效**：`register()` 只登记；`select()` 才做选型；
 *   · **选型必须给理由**：`SelectionResult.considered` 列出每个被跳过的候选与原因 ——
 *     "为什么现在用的是这个实现"必须能回答，否则换实现只能靠猜；
 *   · **可用性实测**：`available:false` 的实现**永远不会**被选中（哪怕它是唯一候选）——
 *     宁可返回 null 让上层如实报错，也不返回一个"看起来能用的空壳"；
 *   · **打包形态的许可闸门**：`activate()` 会过 `judgeLicense()`，
 *     私有来源资产在 `packaged` 形态下被**机械拒绝**（不是靠文档约定）。
 */
import type {
  AssetLicense, BaseAdapter, CapabilityKind, RegistryEntry, RegistryOptions,
  RuntimeProfile, SelectionResult,
} from './types.js'
import { CAPABILITY_KINDS, judgeLicense } from './types.js'

export interface KitEvent {
  at: number
  kind: CapabilityKind | 'kit'
  id: string
  event: 'register' | 'activate' | 'select' | 'reject' | 'dispose' | 'init-failed'
  reason: string
}

export interface Kit {
  /** 注册一个适配器（同 id 重复注册会替换并记事件） */
  register: <A extends BaseAdapter>(adapter: A, opts?: { priority?: number }) => void
  /** 取消注册（幂等） */
  unregister: (id: string) => boolean
  /** 列出某类（或全部）能力 */
  list: (kind?: CapabilityKind) => RegistryEntry[]
  /** 选型（默认返回第一个 `available` 且许可通过的实现） */
  select: <A extends BaseAdapter = BaseAdapter>(kind: CapabilityKind, opts?: { id?: string }) => SelectionResult<A>
  /** 取生效实现（未选型时返回 null，**不隐式选型** —— 隐式选型会让"到底在用什么"变得不可追） */
  active: <A extends BaseAdapter = BaseAdapter>(kind: CapabilityKind) => A | null
  /** 显式激活某个实现（会做许可判定；被拒时返回原因） */
  activate: <A extends BaseAdapter = BaseAdapter>(id: string) => SelectionResult<A>
  /** 逐个 init（失败只标不可用，不抛出） */
  init: () => Promise<void>
  /** 释放全部（退出时调；幂等） */
  dispose: () => Promise<void>
  /** 只读诊断（**不含任何用户内容**） */
  diagnostics: () => {
    profile: RuntimeProfile
    requireCommercial: boolean
    total: number
    byKind: Record<string, { registered: number, available: number, activeId: string | null }>
    events: KitEvent[]
  }
  readonly profile: RuntimeProfile
}

const MAX_EVENTS = 200

export function createKit(o: RegistryOptions): Kit {
  const entries = new Map<string, RegistryEntry>()
  const activeByKind = new Map<CapabilityKind, string>()
  const events: KitEvent[] = []
  let seq = 0

  const emit = (kind: CapabilityKind | 'kit', id: string, event: KitEvent['event'], reason: string): void => {
    const e: KitEvent = { at: Date.now(), kind, id, event, reason: reason.slice(0, 200) }
    events.push(e)
    if (events.length > MAX_EVENTS) events.shift()
    try { o.onEvent?.({ kind: kind === 'kit' ? 'storage' : kind, id, event, reason }) } catch { /* 回调异常不得影响注册表 */ }
  }

  const register: Kit['register'] = (adapter, opts) => {
    seq += 1
    const existed = entries.has(adapter.id)
    entries.set(adapter.id, {
      adapter,
      active: false,
      priority: opts?.priority ?? seq,
      registeredAt: Date.now(),
    })
    emit(adapter.kind, adapter.id, 'register', existed ? '替换同 id 注册' : `priority=${opts?.priority ?? seq}`)
  }

  const unregister: Kit['unregister'] = (id) => {
    const e = entries.get(id)
    if (!e) return false
    entries.delete(id)
    if (activeByKind.get(e.adapter.kind) === id) activeByKind.delete(e.adapter.kind)
    emit(e.adapter.kind, id, 'dispose', '取消注册')
    return true
  }

  const list: Kit['list'] = (kind) => {
    const all = [...entries.values()]
      .filter(e => (kind ? e.adapter.kind === kind : true))
      .map(e => ({ ...e, active: activeByKind.get(e.adapter.kind) === e.adapter.id }))
    /**
     * 排序：可用在前 → priority 小在前 → 注册早在前。
     *
     * ⚠ 不可用的候选**也要按 priority 排**（不能只按注册顺序）：
     *   否则 `select()` 的 `considered` 列表顺序会让人误以为
     *   "先试了 A 再试 B" —— 而实际上是按优先级试的。
     *   选型的可解释性依赖于这个顺序稳定且与优先级一致。
     */
    return all.sort((a, b) => {
      if (a.adapter.available !== b.adapter.available) return a.adapter.available ? -1 : 1
      if (a.priority !== b.priority) return a.priority - b.priority
      return a.registeredAt - b.registeredAt
    })
  }

  /**
   * 许可闸门：把适配器自报的许可拿去判定。
   *
   * `available` 与"许可允许"是**两件事**：SAPI 在本机可用，但如果某个
   * 声音包是私有的，它照样不能在打包形态下被激活。两者都过才算可选中。
   */
  const licenseGate = (adapter: BaseAdapter): { ok: boolean, reason: string } => {
    const v = judgeLicense(adapter.license, o.profile, o.requireCommercial ?? false)
    return { ok: v.allowed, reason: `${v.reason}: ${v.detail}` }
  }

  const select: Kit['select'] = <A extends BaseAdapter = BaseAdapter>(kind: CapabilityKind, opts?: { id?: string }): SelectionResult<A> => {
    const candidates = list(kind)
    if (candidates.length === 0) {
      emit(kind, '-', 'select', '该类能力没有任何已注册实现')
      return { adapter: null, reason: '没有任何已注册实现', considered: [] }
    }

    /**
     * ★ 先把**每个**候选的"能不能用"算清楚，再挑第一个可用的。
     *
     * 为什么不是"边挑边记"（那种写法踩过）：候选是按"可用优先"排序的，
     * 于是胜出者往往排在**第一个**，`considered` 就会是空的 ——
     * 调用方看到的是"选中了 X"，却看不到"为什么没用 Y、Z"。
     * 选型的可解释性是这一层的核心价值，不能因为排序就丢掉。
     */
    const evaluated = candidates.map((c) => {
      if (opts?.id && c.adapter.id !== opts.id) return { c, usable: false, why: 'id 不匹配（显式指定）' }
      if (!c.adapter.available) return { c, usable: false, why: `不可用：${c.adapter.unavailableReason ?? '未说明'}` }
      const gate = licenseGate(c.adapter)
      if (!gate.ok) return { c, usable: false, why: `许可不允许：${gate.reason}` }
      return { c, usable: true, why: '可用' }
    })

    const winner = evaluated.find(e => e.usable)
    const considered = evaluated
      .filter(e => !(winner && e.c.adapter.id === winner.c.adapter.id))
      .map(e => ({ id: e.c.adapter.id, skipped: e.why }))

    if (!winner) {
      const why = `没有可用的 ${kind} 实现（${candidates.length} 个候选全部被跳过）`
      emit(kind, '-', 'select', why)
      return { adapter: null, reason: why, considered }
    }

    activeByKind.set(kind, winner.c.adapter.id)
    const reason = `选中 ${winner.c.adapter.id}（${winner.c.adapter.label}）；其余 ${considered.length} 个候选：${considered.map(x => `${x.id}=${x.skipped.slice(0, 40)}`).join('; ') || '<无>'}`.slice(0, 400)
    emit(kind, winner.c.adapter.id, 'select', `选中，跳过 ${considered.length} 个候选`)
    return { adapter: winner.c.adapter as A, reason, considered }
  }

  const activate: Kit['activate'] = <A extends BaseAdapter = BaseAdapter>(id: string): SelectionResult<A> => {
    const e = entries.get(id)
    if (!e) return { adapter: null, reason: `没有 id=${id} 的实现`, considered: [] }
    if (!e.adapter.available) {
      const r = `实现不可用：${e.adapter.unavailableReason ?? '未说明'}`
      emit(e.adapter.kind, id, 'reject', r)
      return { adapter: null, reason: r, considered: [{ id, skipped: r }] }
    }
    const gate = licenseGate(e.adapter)
    if (!gate.ok) {
      emit(e.adapter.kind, id, 'reject', gate.reason)
      return { adapter: null, reason: gate.reason, considered: [{ id, skipped: gate.reason }] }
    }
    activeByKind.set(e.adapter.kind, id)
    emit(e.adapter.kind, id, 'activate', '显式激活')
    return { adapter: e.adapter as A, reason: '已激活', considered: [] }
  }

  const init: Kit['init'] = async () => {
    for (const e of entries.values()) {
      if (!e.adapter.init) continue
      try {
        await e.adapter.init()
      } catch (err) {
        // init 失败 ⇒ 标不可用并记原因（**不抛**：一个适配器坏掉不该让整个应用起不来）
        const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
        e.adapter.available = false
        e.adapter.unavailableReason = `初始化失败：${reason}`
        emit(e.adapter.kind, e.adapter.id, 'init-failed', reason)
      }
    }
  }

  const dispose: Kit['dispose'] = async () => {
    for (const e of entries.values()) {
      if (!e.adapter.dispose) continue
      try { await e.adapter.dispose() } catch { /* 退出路径不允许抛 */ }
    }
    activeByKind.clear()
  }

  const diagnostics: Kit['diagnostics'] = () => {
    const byKind: Record<string, { registered: number, available: number, activeId: string | null }> = {}
    for (const k of CAPABILITY_KINDS) {
      const all = [...entries.values()].filter(e => e.adapter.kind === k)
      byKind[k] = {
        registered: all.length,
        available: all.filter(e => e.adapter.available).length,
        activeId: activeByKind.get(k) ?? null,
      }
    }
    return { profile: o.profile, requireCommercial: o.requireCommercial ?? false, total: entries.size, byKind, events: [...events] }
  }

  return {
    register,
    unregister,
    list,
    select,
    active: (kind) => {
      const id = activeByKind.get(kind)
      return id ? (entries.get(id)?.adapter ?? null) as never : null
    },
    activate,
    init,
    dispose,
    diagnostics,
    profile: o.profile,
  }
}

/**
 * 构造一个"本项目自研"的许可对象（省得每个适配器重复写）。
 * 自研实现默认可再分发可商用 —— 这是**唯一**能这么写的来源。
 */
export function firstPartyLicense(note = '本项目自研实现'): AssetLicense {
  return {
    provenance: 'licensed',
    redistributable: true,
    commercialUse: true,
    license: 'first-party',
    licenseSource: null,
    author: 'AiriMate One',
    attributionRequired: false,
    note,
  }
}

/** 平台能力许可（如 Windows SAPI：操作系统自带，随系统分发，不属于本应用载荷） */
export function platformLicense(name: string, note = '随操作系统提供，不进入本应用分发载荷'): AssetLicense {
  return {
    provenance: 'licensed',
    redistributable: false,   // 我们不分发它 —— 由平台提供
    commercialUse: true,      // 但可以商用（系统组件）
    license: name,
    licenseSource: null,
    author: 'Microsoft',
    attributionRequired: false,
    note,
  }
}

/** 私有自用资产许可（Mate DLC 一类；本机可用、禁止分发） */
export function privateOnlyLicense(name: string, note: string, author: string | null = null): AssetLicense {
  return {
    provenance: 'private-only',
    redistributable: false,
    commercialUse: false,
    license: name,
    licenseSource: null,
    author,
    attributionRequired: true,
    note,
  }
}
