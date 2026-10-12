/**
 * apps/desktop/src/main/egress-guard.ts —— 主进程出网的**统一闸门**
 *
 * 为什么需要单独一层：
 *   · M1 的供应商测试与 M2 的天气/资讯都要出网，各自写一遍校验必然漂移；
 *   · 出网目标必须**用户显式配置**（供应商 baseUrl / 天气城市），否则 renderer
 *     只要写个字段就能让主进程去打内网（SSRF）；
 *   · 一眼能看出"这个应用会往哪些主机发请求"，是隐私审查的最低要求。
 *
 * 规则：
 *   · 一律先过 shared 的 `checkEgressTarget()`（协议 / 内网 / 端口）；
 *   · 需要**固定白名单**的场景（天气/资讯）额外校验主机名在允许集合内；
 *     用户改了端点 ⇒ 主机名也得在集合内，否则拒绝（**不**因为"用户配的"就放行）。
 */
import { checkEgressTarget } from '@airimate/shared'
import { log } from './log.js'

export interface EgressVerdict {
  ok: boolean
  reason: 'ok' | 'bad-url' | 'insecure-url' | 'blocked-host' | 'blocked-ip' | 'blocked-port' | 'not-allowlisted'
  detail: string
  host: string
}

/** 内置资讯/天气允许的主机（不含供应商 —— 供应商由用户配置 + `checkEgressTarget` 兜底） */
export const BUILTIN_EGRESS_ALLOWLIST: readonly string[] = [
  'api.open-meteo.com',
  'geocoding-api.open-meteo.com',
  'hacker-news.firebaseio.com',
  'hnrss.org',
  'www.infoq.cn',
  'www.ithome.com',
  'feeds.arstechnica.com',
  'techcrunch.com',
]

export function checkEgress(rawUrl: string, allowlist?: readonly string[]): EgressVerdict {
  const base = checkEgressTarget(rawUrl)
  if (!base.ok) return { ok: false, reason: base.reason, detail: base.detail, host: base.host }
  if (allowlist && allowlist.length > 0) {
    const host = base.host
    const hit = allowlist.some(a => host === a || host.endsWith(`.${a}`))
    if (!hit) {
      return { ok: false, reason: 'not-allowlisted', detail: `主机不在允许列表内：${host}`, host }
    }
  }
  return { ok: true, reason: 'ok', detail: 'ok', host: base.host }
}

/**
 * 带闸门的 `fetch`。
 * `redirect:'error'`：不跟随重定向（避免把请求/凭据带到未授权主机）。
 */
export async function guardedFetch(
  url: string,
  init: RequestInit & { allowlist?: readonly string[] },
  timeoutMs = 8000,
): Promise<{ ok: true, res: Response } | { ok: false, verdict: EgressVerdict }> {
  const v = checkEgress(url, init.allowlist)
  if (!v.ok) {
    log().warn('出网被闸门拒绝', { host: v.host, reason: v.reason }, 'egress.blocked')
    return { ok: false, verdict: v }
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal, redirect: 'error' })
    return { ok: true, res }
  } finally {
    clearTimeout(timer)
  }
}
