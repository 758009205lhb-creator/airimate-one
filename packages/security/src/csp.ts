/**
 * @airimate/security/csp —— Content-Security-Policy（Tech-Spec §7.2）
 *
 * 说明：
 *   - `script-src 'self'` 严格，不允许内联脚本（Vue 生产构建不产生内联脚本）；
 *   - `style-src` 需要 'unsafe-inline'，因为 Vue 组件与 UnoCSS 会写内联样式；
 *   - `connect-src` 只放行环回：**出网请求全部在主进程发出**，renderer 不直连外网，
 *     这样密钥永远不会进入 renderer（PRD FR-8）。
 */

export interface CspOptions {
  /** 开发期 Vite dev server 源（形如 http://127.0.0.1:5173），生产传 null */
  devServerOrigin?: string | null
  /** 额外的图片源（默认 self + data + blob） */
  extraImgSrc?: readonly string[]
}

export function buildCsp(o: CspOptions = {}): string {
  const dev = o.devServerOrigin ? ` ${o.devServerOrigin}` : ''
  const devWs = o.devServerOrigin ? ` ws://127.0.0.1:*` : ''
  const img = ['\'self\'', 'data:', 'blob:', ...(o.extraImgSrc ?? [])].join(' ')
  /**
   * ⚠ 环回放行**只在开发期**出现。
   *
   * 这里曾经**无条件**写着 `http://127.0.0.1:* ws://127.0.0.1:*`，于是**生产 CSP 也放行
   * 任意本地端口**：renderer 里任何一处注入都能拿它去探/打本机上的其它服务
   * （本机有旧方案的宿主、各类本地工具）。而这条放行对生产**毫无用处** ——
   * renderer 的所有出网请求都经主进程发出（密钥不进 renderer，PRD FR-8），
   * 唯一需要直连环回的是**开发期的 Vite dev server**。
   *
   * 修法：把两个环回源挪到 `dev`/`devWs` 里，与 dev server 源同生共死。
   * 证据（分发载荷扫描 A17 第 5 面）：生产载荷里不应再出现任何 `127.0.0.1:<port>`。
   */
  return [
    `default-src 'self'`,
    `script-src 'self'${dev}`,
    `style-src 'self' 'unsafe-inline'${dev}`,
    `img-src ${img} app:`,
    `font-src 'self' data:`,
    /**
     * ⚠ 必须放行 `app:`：renderer 的文档源是 `app://bundle`，而模型/动作来自另一个
     *   `app://` 主机名（`app://model`、`app://asset`）。CSP 的 `'self'` 只在**同源**时生效，
     *   不同 host 会被判定为跨源从而拦掉 fetch（实测踩到：模型加载被 CSP 拒绝）。
     *   放行的是**我们自己的协议**，仍然禁止任何外部连接。
     */
    `connect-src 'self' app: blob: data:${dev}${devWs}`,
    `media-src 'self' blob: data:`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `frame-src 'none'`,
    `frame-ancestors 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `manifest-src 'self'`,
  ].join('; ')
}

/** 供主进程 onHeadersReceived 使用的响应头集合 */
export function securityHeaders(o: CspOptions = {}): Record<string, string> {
  return {
    'Content-Security-Policy': buildCsp(o),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), usb=(), serial=(), hid=()',
  }
}

/**
 * 危险全局符号清单：验收探针用它证明"没有 eval / new Function / remote"。
 * （探针只读检查，不在生产代码里拦截。）
 */
export const FORBIDDEN_GLOBALS = ['require', 'process', 'module', 'global', 'Buffer', '__dirname', '__filename'] as const
