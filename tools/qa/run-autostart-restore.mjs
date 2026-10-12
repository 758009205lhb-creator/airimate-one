/**
 * tools/qa/run-autostart-restore.mjs —— 直接调用生产代码的回滚函数（A19 演练用）
 *
 * 为什么要单独一个入口，而不是让应用自己"调一次回滚"：
 *   回滚是**卸载器**才会触发的动作。如果为了验收而在应用里加一个
 *   "请回滚"的 IPC 或 CLI 开关，那这个开关本身就成了一个新的攻击面
 *   （任何能传参的东西都能删掉本应用的自启项）。
 *   所以 QA 直接 require 编译产物、在**同一条生产代码路径**上执行，
 *   既不新增入口，也不改变生产行为。
 *
 * 用法：`node tools/qa/run-autostart-restore.mjs <备份目录绝对路径>`
 * 退出码：0 = 回滚成功；1 = 回滚失败或参数缺失（**不静默**）。
 */
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'

const backupDir = process.argv[2]
if (!backupDir) {
  console.error('用法：node tools/qa/run-autostart-restore.mjs <备份目录>')
  process.exit(1)
}
const abs = resolve(backupDir)
if (!existsSync(abs)) {
  console.error(`备份目录不存在：${abs}`)
  process.exit(1)
}

/**
 * `autostart.ts` 编译为 CommonJS，但它 `require('electron')` —— 在纯 node 下会失败。
 * 这里用最小打桩：回滚路径只需要 `paths.ts` 的 `appPaths().migrationDir`，
 * 而备份目录是我们**显式传入**的，所以桩只需要让模块能被加载。
 */
const Module = (await import('node:module')).default
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath: () => join(process.env.APPDATA ?? process.cwd(), 'AiriMateOne'),
        getAppPath: () => process.cwd(),
        isPackaged: false,
        setName: () => {},
        setPath: () => {},
      },
    }
  }
  return origLoad.call(this, request, parent, isMain)
}

const modPath = resolve(process.cwd(), 'apps/desktop/dist/main/autostart.js')
const mod = await import(pathToFileURL(modPath).href)
const restore = mod.restoreLegacyAutostart ?? mod.default?.restoreLegacyAutostart
if (typeof restore !== 'function') {
  console.error(`production 模块里没有 restoreLegacyAutostart（检查 ${modPath}）`)
  process.exit(1)
}

const r = restore(abs)
console.log(JSON.stringify({ backupDir: abs, ok: r.ok, detail: r.detail, plan: r.plan ?? null }))
process.exit(r.ok ? 0 : 1)
