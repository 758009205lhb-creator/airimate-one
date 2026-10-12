/**
 * tools/qa/check-claims.mjs —— 交付文档里的**静态断言**机械校验
 *
 * 为什么单独一个脚本（与探针互补）：
 *   探针验证的是**运行期行为**（窗口数、帧率、骨骼…）。
 *   但交付文档里还有一批断言是**静态性质**，运行期看同样"没有"是因为没触发，
 *   不等于"不存在"：
 *     · "无 Live2D" —— 运行期 `live2dCount=0` 可能只是因为没加载；要证明的是
 *       "工程里根本没有 live2d 依赖"；
 *     · "生产不用 eval / new Function / CDP 注入 / SetParent" —— 这些只能靠
 *       **源码与产物的静态检查**证明；
 *     · "不加载远程资源" —— 要扫产物里的 http(s) 字面量，而不是看运行时是否发请求。
 *
 * 判据分两类，避免误报：
 *   · 源码类：扫 apps slash src、packages slash src，**剔除注释**（注释里提到
 *     "不要用 eval" 是正常的，不该被判成违规）；
 *   · 产物类：扫 dist/，同样剔除 sourcemap 注释。
 *
 * 用法：`node tools/qa/check-claims.mjs`
 *   `node tools/qa/check-claims.mjs --json docs/evidence/CLAIMS-CHECK.json`
 * 退出码：0 = 全部成立；1 = 有断言不成立（列出位置）
 */
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const ROOT = process.cwd()
const args = process.argv.slice(2)
const jsonIdx = args.indexOf('--json')
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null

/** 源码根 */
const SRC_DIRS = [
  'apps/desktop/src', 'apps/renderer/src',
  'packages/shared/src', 'packages/security/src', 'packages/avatar-stage/src',
  'packages/motion-director/src', 'packages/radial-menu/src',
]
/** 产物根（存在才扫） */
const DIST_DIRS = [
  'apps/desktop/dist', 'apps/renderer/dist',
  'packages/shared/dist', 'packages/security/dist', 'packages/avatar-stage/dist',
  'packages/motion-director/dist', 'packages/radial-menu/dist',
]

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === 'node_modules') continue
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out)
    else out.push({ path: full, size: st.size })
  }
  return out
}

const TEXT_EXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.vue', '.json', '.css', '.html'])

/**
 * 去掉注释，避免把"注释里提到某个危险 API"判成违规。
 * 字符串字面量**保留** —— 我们关心的危险用法（eval/new Function/远程 URL）
 * 恰恰可能出现在字符串里。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ') // 行注释（避开 http:// 里的 //）
}

function collect(dirs, { skipDts = false } = {}) {
  const out = []
  for (const d of dirs) {
    const full = join(ROOT, d)
    if (!existsSync(full)) continue
    for (const f of walk(full)) {
      const ext = extname(f.path).toLowerCase()
      if (!TEXT_EXT.has(ext)) continue
      if (skipDts && f.path.endsWith('.d.ts')) continue
      if (f.size > 6 * 1024 * 1024) continue
      let text
      try { text = readFileSync(f.path, 'utf8') } catch { continue }
      out.push({ rel: relative(ROOT, f.path).split('\\').join('/'), code: stripComments(text) })
    }
  }
  return out
}

const srcFiles = collect(SRC_DIRS, { skipDts: true })
const distFiles = collect(DIST_DIRS)

/**
 * ── 「不加载远程资源」这一族断言的**具名豁免**（用户 2026-10-06 裁定，A9 方案 ①）
 *
 * 为什么需要具名豁免，而不是继续用一条粗正则：
 *   原断言用 `["'`(]https?://…` 扫 renderer 产物，把**默认值字面量**也算成"远程资源引用"，
 *   于是常驻 5 处假阳性（DeepSeek baseUrl 占位符 + 两个 Open-Meteo 端点）。
 *   实测那些命中的真实形态是"设置项的默认值"与**表单 placeholder**，不是资源加载。
 *
 * 但**不能只是把正则改窄就算了** —— 那样会把"某个新依赖真的开始拉远程脚本"这类
 * 真问题一起放过。所以豁免**逐条具名**：每一条都要写清"它是什么、为什么不是出网"，
 * 新增任何一条都必须由人显式添加，并在这里留下理由。
 */
const URL_LITERAL_EXEMPTIONS = [
  {
    url: 'https://api.deepseek.com/v1',
    kind: '默认值与占位符',
    why: '供应商 baseUrl 的设置项默认值 + 表单 placeholder。它只是**字符串**，'
      + '真正的出网发生在**主进程**（`egress-guard.ts` 白名单）；renderer 拿到它只用于显示与编辑。',
  },
  {
    url: 'https://api.open-meteo.com/v1/forecast',
    kind: '默认值',
    why: '天气端点默认值（用户可在设置里改）。同样只是设置项字符串；抓取在主进程并过 egress-guard。',
  },
  {
    url: 'https://geocoding-api.open-meteo.com/v1/search',
    kind: '默认值',
    why: '地理编码端点默认值，同上。',
  },
]

/**
 * ── renderer 产物里**允许存在**的出网原语（逐条具名，逐条给理由）
 *
 * 背景（这一条纠正过我自己的一次错判）：我曾据"renderer **源码**里 fetch/XHR/WS 命中 0"
 * 推断"renderer 没有出网原语"。**源码是对的，产物不是** —— 产物里确实有 `fetch`：
 *   · 1 处来自 **Vite 的 dynamic-import 预加载 helper**；
 *   · 3 处来自 **three.js 的 `FileLoader` / `ImageBitmapLoader`**（库的加载器本体）。
 * ⇒ 把"无出网原语"写成产物的性质就是**假断言**。所以这里拆成两条：
 *   源码级的"没有任何出网原语"（严格，命中 0），
 *   产物级的"只有这些具名的库级原语，且都是本地路径形态"。
 *
 * 为什么这些原语**够不成出网**（两道锁，缺一不可）：
 *   ① 跑不出远程 —— CSP `default-src 'self'` / `script-src 'self'` /
 *      `connect-src 'self' app: blob: data: http://127.0.0.1:* ws://127.0.0.1:*`
 *      （见 `apps/renderer/index.html`）。就算代码去 fetch 一个外域，也会被 CSP 拦掉。
 *   ② 没有远程地址可去 —— renderer 只从主进程拿到 `app://model` / `app://asset` 这类本地 URL；
 *      远程 URL 不在任何出站投影里（`redactDeep` 与适配层投影的职责）。
 */
const NETWORK_TOKEN_EXEMPTIONS = [
  {
    token: 'fetch(',
    count: 1,
    what: 'Vite 的 dynamic-import 预加载 helper',
    why: '形态是 `function n(a){if(a.ep)return;a.ep=!0;const o=t(a);fetch(a.href,o)}`；'
      + '`a` 是**构建产物里的本地模块描述符**（`href` 指向本包 assets），不是外部地址。',
  },
  {
    token: 'fetch(',
    count: 3,
    what: 'three.js 的 FileLoader / ImageBitmapLoader',
    why: '库的加载器本体（喂什么 URL 取什么）。本应用只用它加载 `app://model` 的 VRM 与 '
      + '`app://asset` 的动作；即使被喂外域也会被 CSP 拦下。',
  },
]

/** 资源加载上下文（只有这些才是"真的会去取远方东西"的写法） */
const LOAD_CONTEXTS = [
  { label: '<script src=>', re: /<script[^>]*\ssrc\s*=\s*["'`](https?:\/\/[^"'`\s]+)/gi },
  { label: '<link href=>', re: /<link[^>]*\shref\s*=\s*["'`](https?:\/\/[^"'`\s]+)/gi },
  { label: 'import()', re: /import\s*\(\s*["'`](https?:\/\/[^"'`\s]+)/gi },
  { label: 'new URL(', re: /new\s+URL\s*\(\s*["'`](https?:\/\/[^"'`\s]+)/gi },
  { label: 'src=/href= 属性', re: /(?:^|[\s,{;])(?:src|href)\s*[:=]\s*["'`](https?:\/\/[^"'`\s]+)/gi },
  { label: 'CSS url()', re: /url\(\s*["'`]?(https?:\/\/[^)"'`\s]+)/gi },
]

/** 出网原语（XHR / WebSocket 没有例外的余地，命中即违规） */
const EGRESS_PRIMITIVES = [
  { label: 'XMLHttpRequest', re: /XMLHttpRequest/g },
  { label: 'new WebSocket', re: /new\s+WebSocket\s*\(/g },
  { label: 'new EventSource', re: /new\s+EventSource\s*\(/g },
  { label: 'navigator.sendBeacon', re: /sendBeacon\s*\(/g },
  { label: 'fetch(', re: /(?<![\w.$])fetch\s*\(/g },
  { label: 'importScripts(', re: /importScripts\s*\(/g },
]

/** 单条断言的检查器 */
const CHECKS = [
  {
    id: 'no-live2d-dependency',
    claim: '工程内不存在 live2d 相关依赖（不只是在运行期没加载）',
    run: () => {
      const hits = []
      // package.json 里的依赖声明
      for (const p of ['package.json', ...SRC_DIRS.map(d => `${d.replace('/src', '')}/package.json`)]) {
        const full = join(ROOT, p)
        if (!existsSync(full)) continue
        const txt = readFileSync(full, 'utf8')
        if (/live2d|pixi-live2d|Live2DCubism/i.test(txt)) hits.push({ file: p, what: 'package.json 出现 live2d 字样' })
      }
      // 源码里的 import
      for (const f of srcFiles) {
        if (/from\s+['"][^'"]*live2d/i.test(f.code) || /require\(\s*['"][^'"]*live2d/i.test(f.code)) {
          hits.push({ file: f.rel, what: '源码 import 了 live2d' })
        }
      }
      return hits
    },
  },
  {
    id: 'no-eval',
    claim: '生产源码不使用 eval',
    run: () => {
      const hits = []
      for (const f of srcFiles) {
        // \beval( 且前面不是 . 或字母（排除 obj.eval / retrieve 之类）
        const m = f.code.match(/(^|[^\w.$])eval\s*\(/g)
        if (m) hits.push({ file: f.rel, what: `eval( × ${m.length}` })
      }
      return hits
    },
  },
  {
    id: 'no-new-function',
    claim: '生产源码不使用 new Function（含 setTimeout 字符串形式）',
    run: () => {
      const hits = []
      for (const f of srcFiles) {
        if (/new\s+Function\s*\(/.test(f.code)) hits.push({ file: f.rel, what: 'new Function(' })
        if (/setTimeout\s*\(\s*['"`]/.test(f.code)) hits.push({ file: f.rel, what: 'setTimeout 传字符串（等价 eval）' })
        if (/setInterval\s*\(\s*['"`]/.test(f.code)) hits.push({ file: f.rel, what: 'setInterval 传字符串（等价 eval）' })
      }
      return hits
    },
  },
  {
    id: 'no-cdp-in-production',
    claim: '生产源码不使用 CDP / 远程调试端口',
    run: () => {
      const hits = []
      for (const f of srcFiles) {
        if (/webContents\.debugger/.test(f.code)) hits.push({ file: f.rel, what: 'webContents.debugger' })
        if (/chrome\.debugger|require\(['"]inspector/.test(f.code)) hits.push({ file: f.rel, what: 'CDP 客户端' })
        if (/remote-debugging-port|inspect-brk/.test(f.code)) hits.push({ file: f.rel, what: '调试端口开关' })
      }
      return hits
    },
  },
  {
    id: 'no-setparent',
    claim: '生产源码不调用 SetParent 之类的窗口劫持 API',
    run: () => {
      const hits = []
      for (const f of srcFiles) {
        if (/SetParent|setParent\s*\(/.test(f.code)) hits.push({ file: f.rel, what: 'SetParent' })
      }
      return hits
    },
  },
  {
    id: 'no-remote-resources-in-bundle',
    claim: 'renderer 产物不含**远程资源引用**（只认真正的加载上下文；默认值/占位符逐条具名豁免）',
    run: () => {
      const hits = []
      for (const f of distFiles) {
        if (!f.rel.startsWith('apps/renderer/dist/')) continue
        for (const ctx of LOAD_CONTEXTS) {
          ctx.re.lastIndex = 0
          for (const m of f.code.matchAll(ctx.re)) {
            hits.push({ file: f.rel, what: `${ctx.label} 引用了远程地址：${m[1].slice(0, 70)}` })
          }
        }
      }
      /**
       * ★ 豁免的**活性检查**（这一段第一版写错了，值得记下来）：
       *
       *   错写法：要求豁免的 URL 出现在**加载点**上才算"被用到" ⇒ 永远为假
       *     （豁免的本意恰恰是它**不该**出现在加载点上），于是每次运行都报"豁免过期"。
       *     这是**自相矛盾的判据**：既要求它别在加载点出现，又要求它在加载点出现才算数。
       *
       *   对写法：检查该 URL 字面量**是否还存在于产物里**（任意上下文）。
       *     不存在 ⇒ 源码改了/依赖换了 ⇒ 豁免已成僵尸，必须删除 ——
       *     否则这张表会慢慢退化成"什么都放行"的永久白名单。
       */
      const allBundleText = distFiles
        .filter(f => f.rel.startsWith('apps/renderer/dist/'))
        .map(f => f.code)
        .join('\n')
      for (const e of URL_LITERAL_EXEMPTIONS) {
        if (!allBundleText.includes(e.url)) {
          hits.push({ file: '(豁免表)', what: `豁免已成僵尸：产物里不再出现 ${e.url} ⇒ 请从 URL_LITERAL_EXEMPTIONS 删除该条` })
        }
      }
      return hits
    },
  },
  {
    id: 'renderer-source-has-no-egress-primitive',
    claim: 'renderer **源码**不含任何出网原语（fetch / XHR / WebSocket / EventSource / sendBeacon）',
    run: () => {
      const hits = []
      for (const f of srcFiles) {
        if (!f.rel.startsWith('apps/renderer/src/')) continue
        for (const p of EGRESS_PRIMITIVES) {
          p.re.lastIndex = 0
          const m = f.code.match(p.re)
          if (m) hits.push({ file: f.rel, what: `${p.label} × ${m.length}` })
        }
      }
      return hits
    },
  },
  {
    id: 'bundle-network-primitives-are-known-and-constrained',
    claim: 'renderer 产物里的出网原语**只有已具名的库级那些**，且不存在 XHR/WebSocket/EventSource 等无豁免余地者',
    run: () => {
      const hits = []
      for (const f of distFiles) {
        if (!f.rel.startsWith('apps/renderer/dist/')) continue
        // ① 无豁免余地的原语：命中即违规
        for (const p of EGRESS_PRIMITIVES) {
          if (p.label === 'fetch(') continue
          p.re.lastIndex = 0
          const m = f.code.match(p.re)
          if (m) hits.push({ file: f.rel, what: `${p.label} × ${m.length}（本工程不允许存在）` })
        }
        // ② fetch：必须逐条落在具名豁免的**配额**里
        const fetchCount = (f.code.match(/(?<![\w.$])fetch\s*\(/g) ?? []).length
        if (fetchCount > 0) {
          const declared = NETWORK_TOKEN_EXEMPTIONS
            .filter(e => e.token === 'fetch(')
            .reduce((a, e) => a + e.count, 0)
          if (fetchCount > declared) {
            hits.push({
              file: f.rel,
              what: `fetch( × ${fetchCount} 超出已具名豁免的配额 ${declared} ⇒ `
                + '新增的出网原语必须由人显式登记（NETWORK_TOKEN_EXEMPTIONS）并写明它为何出不了网',
            })
          }
        }
      }
      return hits
    },
  },
  {
    id: 'no-sourcemap-in-dist',
    claim: '构建产物不含 sourcemap（未压缩源码不得进入分发）',
    run: () => {
      const hits = []
      for (const d of DIST_DIRS) {
        const full = join(ROOT, d)
        if (!existsSync(full)) continue
        for (const f of walk(full)) {
          if (f.path.endsWith('.map')) hits.push({ file: relative(ROOT, f.path).split('\\').join('/'), what: 'sourcemap 文件' })
        }
      }
      return hits
    },
  },
  {
    id: 'window-hardening-params',
    claim: '窗口创建显式加固（contextIsolation / nodeIntegration:false / sandbox / webSecurity）',
    run: () => {
      const p = join(ROOT, 'apps/desktop/src/main/window-manager.ts')
      if (!existsSync(p)) return [{ file: 'apps/desktop/src/main/window-manager.ts', what: '文件不存在' }]
      const code = stripComments(readFileSync(p, 'utf8'))
      const need = [
        ['contextIsolation: true', /contextIsolation:\s*true/],
        ['nodeIntegration: false', /nodeIntegration:\s*false/],
        ['sandbox: true', /sandbox:\s*true/],
        ['webSecurity: true', /webSecurity:\s*true/],
        ['webviewTag: false', /webviewTag:\s*false/],
        ['allowRunningInsecureContent: false', /allowRunningInsecureContent:\s*false/],
      ]
      const hits = []
      for (const [label, re] of need) if (!re.test(code)) hits.push({ file: 'window-manager.ts', what: `缺少 ${label}` })
      return hits
    },
  },
  {
    id: 'renderer-csp-blocks-remote-egress',
    claim: 'renderer 的 CSP 把出网堵死，且**源码与产物两份一致**（default-src / script-src / connect-src 都不放行任意远程源）',
    run: () => {
      const hits = []
      /**
       * ⚠ 这里必须**两份都查**，理由是一次实测踩到的：
       *   权威 CSP 在**源码** `apps/renderer/index.html`（Vite 会把它复制进产物）。
       *   我最初只查了源码，于是负向测试往**产物**注入违规时这条断言**照样全绿** ——
       *   看起来像"断言恒真"，实际是**查错了对象**（测试与断言各查一份）。
       *   而"两份不一致"本身就是真问题：产物的 CSP 才是真正生效的那一份，
       *   源码被改而产物没重建 ⇒ 用户跑的东西与审计的东西不是同一个。
       */
      const files = ['apps/renderer/index.html', 'apps/renderer/dist/index.html']
      const csps = new Map()
      for (const rel of files) {
        const p = join(ROOT, rel)
        if (!existsSync(p)) continue // dist 未构建时跳过（源码那份必须存在）
        const html = readFileSync(p, 'utf8')
        const m = html.match(/Content-Security-Policy"[^>]*content="([^"]+)"/i)
        if (!m) { hits.push({ file: rel, what: '找不到 CSP meta（安全基线缺失）' }); continue }
        csps.set(rel, m[1])
        const csp = m[1]
        const need = [
          ['default-src', /default-src\s+'self'/],
          ['script-src', /script-src\s+'self'/],
          ['connect-src', /connect-src\s+'self'/],
          ['object-src', /object-src\s+'none'/],
          ['base-uri', /base-uri\s+'none'/],
        ]
        for (const [label, re] of need) {
          if (!re.test(csp)) hits.push({ file: rel, what: `CSP 缺少 ${label} 的 'self'/'none' 基线` })
        }
        // 危险放行（任意一条命中，都意味着产物里的库级 fetch 可能真的够得着外域）
        if (/script-src[^;]*'unsafe-eval'/.test(csp)) hits.push({ file: rel, what: "script-src 含 'unsafe-eval'" })
        if (/(?:^|[;\s])\*(?=[;\s]|$)/.test(csp)) hits.push({ file: rel, what: 'CSP 放行了通配源 *' })
        if (/connect-src[^;]*https:/.test(csp)) hits.push({ file: rel, what: 'connect-src 放行了任意 https:' })
      }
      if (!csps.has('apps/renderer/index.html')) {
        hits.push({ file: 'apps/renderer/index.html', what: '源码 CSP 缺失（这是权威的那一份）' })
      }
      if (csps.size === 2) {
        const a = csps.get('apps/renderer/index.html')
        const b = csps.get('apps/renderer/dist/index.html')
        if (a !== b) hits.push({ file: 'index.html ↔ dist/index.html', what: '源码与产物的 CSP 不一致 ⇒ 产物需要重建（或有人改了产物）' })
      }
      return hits
    },
  },
  {
    id: 'chat-window-has-native-frame-and-menubar',
    claim: '★ 对话窗口用**系统原生边框**（`frame: true`）且**隐藏 Electron 菜单栏**；窗口内自带一条功能菜单栏（2026-10-09 完善轮）',
    /**
     * 为什么把这三件事写成**一条**断言：
     *   它们是同一个决定的三半，**缺任何一半都会产生"看起来无关"的缺陷**：
     *     · 只有 `frame:true` 没有 `setMenuBarVisibility(false)` ⇒ 客户区顶部多出
     *       Electron 的 `File/Edit/View`，与我们自己的深色菜单栏叠在一起；
     *     · 只有菜单栏没有 `frame:true` ⇒ 又回到自绘标题栏（复刻不出系统菜单与贴边手势）；
     *     · 窗口里有菜单栏数据但模板里没渲染 ⇒ 菜单项"存在但看不见"。
     *   三者一起断言，才等于"用户看到的那一行菜单"。
     */
    run: () => {
      const hits = []
      const p = join(ROOT, 'apps/desktop/src/main/chat-window.ts')
      if (!existsSync(p)) return [{ file: 'apps/desktop/src/main/chat-window.ts', what: '文件不存在' }]
      const code = stripComments(readFileSync(p, 'utf8'))
      if (!/frame:\s*true\b/.test(code)) hits.push({ file: 'chat-window.ts', what: '缺少 frame: true（系统原生边框）' })
      if (/frame:\s*false\b/.test(code)) hits.push({ file: 'chat-window.ts', what: '仍存在 frame: false（自绘标题栏那条路径）' })
      if (!/setMenuBarVisibility\(\s*false\s*\)/.test(code)) hits.push({ file: 'chat-window.ts', what: '缺少 setMenuBarVisibility(false)（Electron 菜单栏会与自绘菜单重叠）' })
      /** 标题必须是「和 {角色名} 聊天」（对齐参考实现 DockPetWin 的 Title） */
      if (!/和\s*\$\{[^}]*\}\s*聊天/.test(readFileSync(p, 'utf8'))) {
        hits.push({ file: 'chat-window.ts', what: '标题不是「和 {角色名} 聊天」的形态' })
      }
      const v = join(ROOT, 'apps/renderer/src/components/ChatWindow.vue')
      if (!existsSync(v)) return [...hits, { file: 'ChatWindow.vue', what: '文件不存在' }]
      const vue = readFileSync(v, 'utf8')
      if (!/chatw__menubar/.test(vue)) hits.push({ file: 'ChatWindow.vue', what: '缺少菜单栏（.chatw__menubar）' })
      /** 六个下拉组必须在（文件/桌宠/对话/记忆/设置/帮助） */
      for (const id of ["id: 'file'", "id: 'pet'", "id: 'chat'", "id: 'memory'", "id: 'settings'", "id: 'help'"]) {
        if (!vue.includes(id)) hits.push({ file: 'ChatWindow.vue', what: `菜单组缺失：${id}` })
      }
      /** 自绘标题栏那条旧路径不许残留（`-webkit-app-region: drag` 的标题栏） */
      if (/class="titlebar chatw__titlebar"/.test(vue)) {
        hits.push({ file: 'ChatWindow.vue', what: '仍在使用自绘标题栏（frame:true 之后不该有）' })
      }
      return hits
    },
  },
  {
    id: 'pet-resident-and-startup-behavior-declared',
    claim: '★ `petResident`（默认 false）与 `startupOpenChat`（默认 true）**写进了 AppSettingsSchema**，且菜单栏每一项都带 action（无死项）',
    /**
     * 为什么必须静态断言"写进了 schema"：
     *   `mergeSettings()` 用 `AppSettingsSchema.parse()` **重建整个对象** ——
     *   没在 schema 里声明的字段会被 zod **静默丢掉**（本项目反复踩过）。
     *   那是运行期才显现的"设置改了、重启又回默认值"，静态断言能在编码期就拦住。
     * 为什么还要断言菜单项都有 `action`：C6 的纪律是"每一个菜单项都必须有真实动作"，
     *   而"漏写 action"在运行期表现为"点了没反应" —— 正是最难查的形态。
     */
    run: () => {
      const hits = []
      const s = join(ROOT, 'packages/shared/src/settings.ts')
      const ipc = join(ROOT, 'packages/shared/src/ipc.ts')
      if (!existsSync(s)) return [{ file: 'packages/shared/src/settings.ts', what: '文件不存在' }]
      const st = stripComments(readFileSync(s, 'utf8'))
      if (!/petResident:\s*z\.boolean\(\)\.default\(false\)/.test(st)) {
        hits.push({ file: 'settings.ts', what: 'petResident 未声明，或默认值不是 false' })
      }
      if (!/startupOpenChat:\s*z\.boolean\(\)\.default\(true\)/.test(st)) {
        hits.push({ file: 'settings.ts', what: 'startupOpenChat 未声明，或默认值不是 true' })
      }
      if (!existsSync(ipc)) return [...hits, { file: 'packages/shared/src/ipc.ts', what: '文件不存在' }]
      const ic = stripComments(readFileSync(ipc, 'utf8'))
      for (const ch of ['PET_SHOW', 'PET_HIDE', 'PET_TOGGLE', 'PET_OPEN_PANEL', 'PET_SET_RESIDENT', 'PET_MENU', 'UI_ACTION', 'CHAT_CONTEXT_RESET', 'CHAT_OPEN_DATA_DIR', 'APP_RESTART']) {
        if (!ic.includes(`${ch}:`)) hits.push({ file: 'ipc.ts', what: `IPC 通道缺失：${ch}` })
      }
      const v = join(ROOT, 'apps/renderer/src/components/ChatWindow.vue')
      if (!existsSync(v)) return [...hits, { file: 'ChatWindow.vue', what: '文件不存在' }]
      const vue = readFileSync(v, 'utf8')
      /** 菜单项字面量：每一项都必须带 `action: '...'`（无 action = 死项） */
      const itemLines = vue.split('\n').filter(l => /id:\s*'[a-z]+\.[a-zA-Z]+',\s*label:/.test(l))
      const noAction = itemLines.filter(l => !/action:\s*'/.test(l))
      if (itemLines.length < 15) hits.push({ file: 'ChatWindow.vue', what: `菜单项字面量只找到 ${itemLines.length} 条（少于 15 条 ⇒ 可能被改成了模板硬编码）` })
      for (const l of noAction) hits.push({ file: 'ChatWindow.vue', what: `菜单项没有 action（死项）：${l.trim().slice(0, 80)}` })
      /** `runAction` 的穷尽 switch 必须在（新增 action 不写实现会编译失败） */
      if (!/const never:\s*never\s*=\s*e\.action/.test(vue)) {
        hits.push({ file: 'ChatWindow.vue', what: 'runAction 缺少穷尽性检查（新增 action 静默无实现）' })
      }
      return hits
    },
  },
  {
    id: 'no-dead-conversation-dock',
    claim: '★ 已删除的 `ConversationDock.vue`（pet 窗口内贴底 dock）**不得回来** —— 它是"聊天塞进桌宠窗口"那条被否决路径的载体',
    run: () => {
      const hits = []
      const dead = join(ROOT, 'apps/renderer/src/components/ConversationDock.vue')
      if (existsSync(dead)) hits.push({ file: 'apps/renderer/src/components/ConversationDock.vue', what: '文件仍然存在（2026-10-08 就该删除，本轮补删）' })
      /** pet 窗口外壳里不许出现任何对话输入/文字流水（判据 §7.5 的结构性保证） */
      const pet = join(ROOT, 'apps/renderer/src/components/PetShell.vue')
      if (existsSync(pet)) {
        const code = stripComments(readFileSync(pet, 'utf8'))
        if (/ConversationDock/.test(code)) hits.push({ file: 'PetShell.vue', what: '仍然引用 ConversationDock' })
        if (/<textarea|<input/.test(code)) hits.push({ file: 'PetShell.vue', what: 'pet 外壳里出现了输入控件（对话输入必须只在 ChatWindow.vue）' })
      }
      return hits
    },
  },
]

const results = []
for (const c of CHECKS) {
  let hits = []
  let error = null
  try { hits = c.run() } catch (e) { error = e instanceof Error ? e.message : String(e) }
  results.push({ id: c.id, claim: c.claim, pass: error === null && hits.length === 0, hits, error })
}

const report = {
  schema: 'airimate/claims-check/1',
  checkedAt: new Date().toISOString(),
  sourceFilesScanned: srcFiles.length,
  distFilesScanned: distFiles.length,
  checks: results,
  passed: results.filter(r => r.pass).length,
  failed: results.filter(r => !r.pass).map(r => r.id),
  pass: results.every(r => r.pass),
}

if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(`静态断言校验：扫源码 ${srcFiles.length} 个文件、产物 ${distFiles.length} 个文件`)
console.log('')
for (const r of results) {
  console.log(`${r.pass ? '✓' : '✗'} ${r.id}  —— ${r.claim}`)
  for (const h of r.hits.slice(0, 8)) console.log(`    ${h.file}  ${h.what}`)
  if (r.hits.length > 8) console.log(`    … 另有 ${r.hits.length - 8} 处`)
  if (r.error) console.log(`    检查本身出错：${r.error}`)
}
console.log('')
console.log(report.pass ? `[claims] 全部 ${results.length} 条断言成立` : `[claims] 不成立：${report.failed.join(', ')}`)
process.exit(report.pass ? 0 : 1)
