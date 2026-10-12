/**
 * electron-main.cjs —— 用 Electron 的**真 WebGL**（无 GUI）渲染 VRM + VRMA 验证帧
 *
 * 由 `render-contact-sheet.mjs` 拉起：
 *   electron.exe electron-main.cjs <config.json>
 * config.json: { width, height, outDir, fileStem, view, keepMaterials, timeoutMs,
 *                vrmPath, vrmaPath, times:number[], httpPort? }
 *
 * ── 为什么用**本地 HTTP 服务**而不是把资产内联进 HTML ──
 *   实测：`.vrm` 59 MB，base64 后 79 MB。无论是否剥掉贴图（本模型的 bulk 在
 *   mesh/skin 顶点数据上，剥贴图只从 59.2 MB 降到 59.2 MB），把 79 MB 内联进
 *   HTML 都会让 Chromium 的 HTML 解析器吃掉几分钟 —— 表现是页面永远停在
 *   `stage: 'boot'`，主进程只能等到超时（实测 180s 白等）。
 *   ⇒ 改成：主进程起一个只监听 127.0.0.1 的迷你 HTTP 服务，
 *     页面用 `fetch('/asset/vrm')` 拿 ArrayBuffer（响应里带 `Content-Length`），
 *     HTML 本身只有几十 KB，秒开。
 *   顺带解决了模块解析：http:// 源下 ES module 是标准行为，
 *   不需要 file:// 的那些开关。
 *
 * ── 其他必须的细节（各对应一个真实失败模式）──
 *   · `show:false` 的 BrowserWindow 仍会创建 GL 上下文，不需要可见窗口。
 *   · **不要** `app.disableHardwareAcceleration()` —— 它会把 SwiftShader 一起废掉。
 *     改用 `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`。
 *   · 剥贴图时必须同时清掉材质里的贴图**引用**，否则 GLTFLoader 会查已删除的
 *     `json.textures[...]` 并抛 `Cannot read properties of undefined (reading '0')`。
 *   · 必须等页面设的 `window.__RENDER_READY__`，并有超时兜底 + 每 5s 打 stage。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const cfgPath = process.argv[process.argv.length - 1]
if (!cfgPath || !fs.existsSync(cfgPath)) {
  console.error(`[main] 找不到配置：${cfgPath}`)
  process.exit(2)
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''))   // 容忍 UTF-8 BOM（实测：PS 的 Set-Content 会加 BOM，JSON.parse 直接抛）

app.commandLine.appendSwitch('use-gl', cfg.useGl || 'angle')
app.commandLine.appendSwitch('use-angle', cfg.useAngle || 'swiftshader')
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('no-sandbox')

const TIMEOUT_MS = Number(cfg.timeoutMs || 300000)

/**
 * 剥掉 GLB 里的贴图，只留**骨架 + 网格几何**。
 *
 * ⚠ 只删 `images/samplers/textures` 而不清材质里的贴图引用的话，
 *   GLTFLoader 会去查已删除的 `json.textures[...]` 并抛
 *   `Cannot read properties of undefined (reading '0')`。两件事必须一起做。
 */
function strippedVrmBuffer(pathIn) {
  const buf = fs.readFileSync(pathIn)
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  const stats = {
    images: json.images?.length ?? 0, textures: json.textures?.length ?? 0,
    samplers: json.samplers?.length ?? 0, meshes: json.meshes?.length ?? 0,
    materials: json.materials?.length ?? 0, skins: json.skins?.length ?? 0,
  }
  // ── 三档"渲染载荷"（由 cfg.meshMode 决定）
  //   'original' : 原样（保留贴图 + MToon）—— 最重，SwiftShader 下最容易失败
  //   'flat'     : 保留网格几何，但**删掉全部材质**（GLTFLoader 会用默认材质）
  //   'bones'    : 连网格一起删，只剩骨架 —— 由页面用方块把骨头画出来。
  //                这一档在任何环境下都能出图，是"骨架对不对"最可靠的证据。
  const mode = cfg.meshMode || 'bones'
  if (mode !== 'original') { delete json.images; delete json.samplers; delete json.textures }
  if (mode === 'bones') { delete json.meshes; delete json.skins; for (const n of json.nodes ?? []) { delete n.mesh; delete n.skin } }
  if (mode === 'flat') {
    // 删材质：GLTFLoader 在 material 为 undefined 时用默认 MeshStandardMaterial
    delete json.materials
    for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) delete p.material
    // 贴图引用一并清掉（虽然材质没了）
    const TEXTURE_KEYS = new Set(['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture', 'textureProperties', 'texture'])
    const scrub = (o, d = 0) => {
      if (!o || typeof o !== 'object' || d > 8) return
      if (Array.isArray(o)) { for (const v of o) scrub(v, d + 1); return }
      for (const k of Object.keys(o)) { if (TEXTURE_KEYS.has(k)) { delete o[k]; continue } if (o[k] && typeof o[k] === 'object') scrub(o[k], d + 1) }
    }
    scrub(json.extensions ?? {})
    scrub(json.materials ?? [])
  }
  stats.mode = mode
  const rest = buf.subarray(20 + jsonLen)
  let jb = Buffer.from(JSON.stringify(json), 'utf8')
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
  const head = Buffer.alloc(20)
  head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4)
  head.writeUInt32LE(12 + 8 + jb.length + rest.length, 8)
  head.writeUInt32LE(jb.length, 12); head.writeUInt32LE(0x4e4f534a, 16)
  const out = Buffer.concat([head, jb, rest])
  return { buf: out, before: buf.length, after: out.length, stats }
}

/** 迷你静态服务：只服务 3 个东西 */
function startServer(vrmBuf, vrmaBuf) {
  const page = fs.readFileSync(path.join(__dirname, 'renderer.html'), 'utf8')
  const pageWithCfg = page.replace('__CONTACT_SHEET_CONFIG_JSON__', () =>
    JSON.stringify({
      width: cfg.width, height: cfg.height, view: cfg.view,
      keepMaterials: !!cfg.keepMaterials, times: cfg.times,
      // ⚠ 这三个以前没传，导致页面里 `cfg.meshMode` 永远是 undefined，
      //   `bones` 档的骨块一块都没建出来 —— 出图只有地面网格（实测）。
      meshMode: cfg.meshMode || 'bones', textureStripped: cfg.textureStripped !== false,
      hipsOriginMode: cfg.hipsOriginMode || 'relative',
    }).replace(/<\//g, '<\\/'))
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0]
    console.log(`[http] ${req.method} ${url}`)
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' })
      res.end(body)
    }
    if (url === '/' || url === '/index.html') return send(200, 'text/html; charset=utf-8', Buffer.from(pageWithCfg, 'utf8'))
    if (url === '/asset/vrm') return send(200, 'model/gltf-binary', vrmBuf)
    if (url === '/asset/vrma') return send(200, 'model/gltf-binary', vrmaBuf)
    // 模块：从 tools/motion-lab 下按相对路径读（限制了目录遍历）
    const rel = decodeURIComponent(url.replace(/^\//, ''))
    const abs = path.resolve(__dirname, rel)
    if (!abs.startsWith(path.resolve(__dirname)) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return send(404, 'text/plain', Buffer.from('not found: ' + rel))
    }
    const type = abs.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : abs.endsWith('.json') ? 'application/json; charset=utf-8'
        : 'application/octet-stream'
    return send(200, type, fs.readFileSync(abs))
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(cfg.httpPort || 0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** 每 5s 打一次页面 stage，便于定位"卡在哪一步" */
function startStageLogger(win) {
  const t = setInterval(async () => {
    try {
      const s = await win.webContents.executeJavaScript('JSON.stringify({ stage: window.__RENDER_REPORT__?.stage, ready: window.__RENDER_READY__ === true, errors: window.__RENDER_REPORT__?.errors ?? [], frames: window.__RENDER_REPORT__?.frames?.length ?? 0, gl: !!window.__RENDER_REPORT__?.gl })')
      console.log(`[main][stage] ${s}`)
    } catch (e) { console.log(`[main][stage] (读取失败：${e.message})`) }
  }, 5000)
  return () => clearInterval(t)
}

app.whenReady().then(async () => {
  // ── 准备资产
  let vrmBuf, strip = null
  try {
    if (cfg.textureStripped === false) { vrmBuf = fs.readFileSync(cfg.vrmPath) }
    else { const s = strippedVrmBuffer(cfg.vrmPath); vrmBuf = s.buf; strip = { beforeBytes: s.before, afterBytes: s.after, removed: s.stats } }
  } catch (e) { console.error(`[main] 读取/剥离 VRM 失败：${e.message}`); app.exit(2); return }
  const vrmaBuf = fs.readFileSync(cfg.vrmaPath)
  console.log(`[main] 资产就绪：vrm=${Math.round(vrmBuf.length / 1024)}KB${strip ? `（原始 ${Math.round(strip.beforeBytes / 1024)}KB，删 images=${strip.removed.images} textures=${strip.removed.textures} samplers=${strip.removed.samplers}）` : '（未剥贴图）'}  vrma=${Math.round(vrmaBuf.length / 1024)}KB`)

  let srv
  try { srv = await startServer(vrmBuf, vrmaBuf) } catch (e) { console.error(`[main] 起服务失败：${e.message}`); app.exit(2); return }
  const base = `http://127.0.0.1:${srv.port}`
  console.log(`[main] 本地服务：${base}`)

  const win = new BrowserWindow({
    width: cfg.width, height: cfg.height,
    /**
     * `cfg.showWindow === true` 时用**可见窗口**跑同一条渲染链 —— 对照实验用。
     * 目的：把"应用里角色看不见"这件事一分为二 ——
     *   可见窗口下这条链仍然能出图 ⇒ 差异在我的应用窗口/会话配置（可二分）；
     *   可见窗口下也不出图 ⇒ 差异在"可见窗口 + WebGL 呈现"这条路径本身。
     */
    show: cfg.showWindow === true,
    webPreferences: { offscreen: false, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
  })
  win.webContents.on('render-process-gone', (_e, d) => console.error(`[main] 渲染进程结束：${JSON.stringify(d)}`))
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error(`[main] 载入失败 ${code} ${desc} ${url}`))

  try { await win.loadURL(base + '/') } catch (e) { console.error(`[main] 载入页面失败：${e.message}`); app.exit(2); return }

  const start = Date.now()
  let reportJson = null
  const stopLogger = startStageLogger(win)
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const ready = await win.webContents.executeJavaScript('window.__RENDER_READY__ === true')
      if (ready) { reportJson = await win.webContents.executeJavaScript('JSON.stringify(window.__RENDER_REPORT__)'); break }
    } catch { /* 页面还没跑起来时会抛，忽略 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  stopLogger()

  const finish = (summary, code) => {
    try { fs.mkdirSync(cfg.outDir, { recursive: true }) } catch { /* ignore */ }
    try { fs.writeFileSync(path.join(cfg.outDir, `${cfg.fileStem}_render.json`), JSON.stringify(summary, null, 2), 'utf8') } catch { /* ignore */ }
    try { srv.server.close() } catch { /* ignore */ }
    console.log(`[main] RESULT ${JSON.stringify({ ok: summary.ok, gl: summary.gl?.renderer ?? null, webgl2: summary.gl?.webgl2 ?? null, clip: summary.clip ?? null, errors: summary.errors ?? [], files: summary.written ? summary.written.length : 0, probe: summary.probe ?? null, json: path.join(cfg.outDir, `${cfg.fileStem}_render.json`) })}`)
    app.exit(code)
  }

  if (!reportJson) {
    let diag = 'n/a', stageInfo = 'n/a'
    try { diag = await win.webContents.executeJavaScript(`(() => { try { const c=document.createElement('canvas'); const g=c.getContext('webgl2')||c.getContext('webgl'); return g ? g.getParameter(g.VERSION) : 'NO-GL-CONTEXT' } catch(e){ return 'ERR:'+e.message } })()`) } catch (e) { diag = 'ERR:' + e.message }
    try { stageInfo = await win.webContents.executeJavaScript(`JSON.stringify({ stage: window.__RENDER_REPORT__?.stage ?? null, errors: window.__RENDER_REPORT__?.errors ?? null, frames: window.__RENDER_REPORT__?.frames?.length ?? null })`) } catch (e) { stageInfo = 'ERR:' + e.message }
    console.error(`[main] 超时（${TIMEOUT_MS}ms）未收到 __RENDER_READY__；诊断 GL = ${diag}；页面状态 = ${stageInfo}`)
    return finish({ ok: false, timeout: true, glDiagnostic: diag, pageState: stageInfo, strip }, 3)
  }

  const parsed = JSON.parse(reportJson)

  /**
   * 呈现探针（`cfg.probeVisible === true`）：把页面里的 WebGL 画布**拷到 2D canvas**，
   * 再从 2D canvas 取像素。这条路径与 three 的 `readPixels` 是**两条独立证据**：
   *   · 页面能拷到内容 ⇒ 画布的"可读内容"健康；
   *   · 再与屏幕像素探针（tools/qa/Probe-StagePixels.ps1）对照，
   *     就能判定问题在"画布里没内容"还是"内容没呈现到屏幕"。
   */
  let probe = null
  if (cfg.probeVisible === true) {
    try {
      const r = await win.webContents.executeJavaScript(`
        (() => {
          const src = document.querySelector('canvas');
          if (!src) return { error: 'no-canvas' };
          const c2 = document.createElement('canvas');
          c2.width = src.width; c2.height = src.height;
          const ctx = c2.getContext('2d');
          ctx.drawImage(src, 0, 0);
          const d = ctx.getImageData(0, 0, c2.width, c2.height).data;
          let nonBg = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i+3] > 8 && (d[i] > 24 || d[i+1] > 24 || d[i+2] > 24)) nonBg++;
          return { glSize: [src.width, src.height], cssSize: [src.clientWidth, src.clientHeight],
                   copyNonBgRatio: nonBg / (c2.width * c2.height), dataUrl: c2.toDataURL('image/png') };
        })()
      `, true)
      if (r && r.dataUrl) {
        fs.mkdirSync(cfg.outDir, { recursive: true })
        const pp = path.join(cfg.outDir, `${cfg.fileStem}_visible-copy.png`)
        fs.writeFileSync(pp, Buffer.from(String(r.dataUrl).split(',')[1], 'base64'))
        probe = { glSize: r.glSize, cssSize: r.cssSize, copyNonBgRatio: r.copyNonBgRatio, png: pp }
        console.log(`[main] 呈现探针：copyNonBgRatio=${r.copyNonBgRatio} gl=${JSON.stringify(r.glSize)} css=${JSON.stringify(r.cssSize)} → ${pp}`)
      } else {
        probe = { error: r && r.error ? r.error : 'unknown' }
        console.log(`[main] 呈现探针失败：${JSON.stringify(probe)}`)
      }
    } catch (e) {
      probe = { error: e.message }
      console.log(`[main] 呈现探针异常：${e.message}`)
    }
  }

  const written = []
  if (parsed.ok) {
    fs.mkdirSync(cfg.outDir, { recursive: true })
    for (const fr of parsed.frames) {
      const p = path.join(cfg.outDir, `${cfg.fileStem}_f${String(fr.i).padStart(2, '0')}_t${fr.t.toFixed(3)}.png`)
      fs.writeFileSync(p, Buffer.from(fr.base64, 'base64'))
      written.push({ path: p, t: fr.t, bones: fr.bones, bytes: fs.statSync(p).size })
    }
  }
  finish({
    ok: parsed.ok, gl: parsed.gl, clip: parsed.clip, vrmLoaded: parsed.vrmLoaded,
    meshCount: parsed.meshCount, boneCubeCount: parsed.boneCubeCount, materialMode: parsed.materialMode,
    elapsedMs: parsed.elapsedMs, lastBounds: parsed.lastBounds,
    hipsTrack: parsed.hipsTrack, vrmAnimation: parsed.vrmAnimation, loaderScale: parsed.loaderScale,
    modelNormalizedHipsY: parsed.modelNormalizedHipsY, hipsRealign: parsed.hipsRealign,
    assetSource: parsed.assetSource,
    config: parsed.config, strip, errors: parsed.errors, written,
    probe,
  }, parsed.ok ? 0 : 4)
})

app.on('window-all-closed', () => app.quit())
