/**
 * apps/desktop/test/helpers/harness.cjs —— 单测公共底座（M1/M2 测试共用）
 *
 * 为什么必须有它：主进程模块**大量依赖 `electron`**（`app.getPath('userData')`、
 * `safeStorage`）。每个测试文件各写一遍打桩必然会漂移 —— 本项目已经因为
 * "同一个语义两处实现"踩过不止一次坑，所以这里固化一次。
 *
 * 用法（**必须在 require 业务模块之前**调用）：
 *
 *   const { tmpdir, stubElectron, resetStores } = require('./helpers/harness.cjs')
 *   const TMP = tmpdir('pe')
 *   stubElectron(TMP)
 *   const perm = require('../../dist/main/permission-store.js')
 *
 * 关键点：`paths.ts` 会缓存 `appPaths()`，所以 userData 一旦确定就不能再变；
 * 每个测试文件用**自己的**临时目录（`tmpdir(prefix)` 带随机后缀），互不干扰。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

/** 建一个只属于本测试文件的临时 userData 目录 */
function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `airimate-${prefix}-`))
}

/**
 * 打桩 `electron`。
 *
 * `safeStorage` 默认**可用**（熵源固定，仅用于单测；真实后端是 DPAPI）。
 * `encryptString` 返回一个可逆的伪密文（前缀 + base64），这样"写进去再读出来"的
 * 往返能被真实验证，同时**任何断言都不该看到明文** —— 这正是我们要测的性质。
 */
function stubElectron(userData, opts = {}) {
  const files = new Map()
  const safeStorageAvailable = opts.safeStorageAvailable !== false
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath: (name) => (name === 'userData' ? userData : userData),
          getAppPath: () => path.resolve(__dirname, '..', '..'),
          isPackaged: false,
          setName: () => {},
          setPath: () => {},
          getVersion: () => '1.0.0-test',
          on: () => {},
          whenReady: async () => {},
          quit: () => {},
          exit: () => {},
        },
        safeStorage: {
          isEncryptionAvailable: () => safeStorageAvailable,
          encryptString: (plain) => Buffer.from(`ENC:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8'),
          decryptString: (buf) => {
            const s = Buffer.from(buf).toString('utf8')
            if (!s.startsWith('ENC:')) throw new Error('not our ciphertext')
            return Buffer.from(s.slice(4), 'base64').toString('utf8')
          },
        },
        dialog: { showMessageBox: async () => ({ response: 0 }) },
        screen: { getDisplayMatching: () => ({ scaleFactor: 1 }), getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
        BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
        ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
        webContents: { getAllWebContents: () => [] },
        contextBridge: { exposeInMainWorld: () => {} },
        ipcRenderer: {
          invoke: async () => ({ ok: false, code: 'NO_IPC', message: 'test stub' }),
          on: () => {},
          send: () => {},
          removeListener: () => {},
        },
        __files: files,
      }
    }
    return origLoad.call(this, request, parent, isMain)
  }
  return { files }
}

/**
 * 清掉某一批存储的内存缓存 + 磁盘文件。
 *
 * ⚠ 为什么不能只删文件：这些 store 都是**内存缓存优先**的，删了文件但缓存还在，
 *   下一个用例会读到上一个用例写入的数据（"测试互相污染"最典型的形态）。
 *   所以必须同时调各 store 的 `__reset*ForTest()`。
 */
function resetStores(mods) {
  for (const m of Object.values(mods)) {
    if (!m || typeof m !== 'object') continue
    for (const [name, fn] of Object.entries(m)) {
      if (name.startsWith('__reset') && typeof fn === 'function') {
        try { fn() } catch { /* 单个 store 失败不影响其它 */ }
      }
    }
  }
}

/** 删除 userData 下的某些文件（保留目录本身） */
function rmFiles(userData, names) {
  for (const n of names) {
    try { fs.rmSync(path.join(userData, n), { force: true }) } catch { /* ignore */ }
  }
}

/** 读 JSON（不存在/损坏返回 null，测试里据此断言"真的落盘了"） */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

module.exports = { tmpdir, stubElectron, resetStores, rmFiles, readJson }
