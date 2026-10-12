/**
 * apps/desktop/test/autostart-restore.test.cjs —— 开机自启**回滚路径**的单测（判据 A19）
 *
 * 为什么必须有：回滚是**只在卸载时跑一次**的路径，平时永远不会被执行到。
 * 它的缺陷只会在"用户真的要卸载"那一刻暴露 —— 那时已经无法挽回。
 * 所以这里用**合成备份**把各种边界情况跑一遍。
 *
 * 写这些测试时发现并修掉了两个真实缺陷：
 *   ① **过度恢复**：原实现遍历备份里全部 `hkcu-run` 条目逐个写回，而备份是
 *      `inventoryAutostart()` 的**完整快照**（含本应用自己的 `AiriOne`）
 *      ⇒ 会把本应用自启项也恢复回去，**卸载后仍然开机自启**。
 *   ② **静默丢失**：旧项原本在 HKLM Run / 启动文件夹 / 计划任务时，
 *      原实现什么都不恢复，却返回 `ok: true`。
 *
 * 隔离：只测**纯函数** `planRestoreFromBackup()`；不碰真实注册表。
 * 运行：`node --test apps/desktop/test/autostart-restore.test.cjs`
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

// autostart.ts 依赖 electron（app）+ paths；纯函数路径不需要它们，但要能加载模块
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => 'C:\\tmp\\airimate-test', isPackaged: false, getAppPath: () => process.cwd() } }
  }
  return origLoad.call(this, request, parent, isMain)
}

const { planRestoreFromBackup, assertNameSafeFromLegacyUninstaller } = require('../dist/main/autostart.js')

/** 造一条备份条目 */
function entry(o) {
  return { scope: 'hkcu-run', name: 'x', command: 'cmd', target: null, exists: true, legacy: true, ...o }
}

// ───────────────────────────────────────────────────────── 缺陷 ①：不得恢复本应用自己

test('★ 回滚**不得**恢复本应用自己的自启项（否则卸载后仍然开机自启）', () => {
  const plan = planRestoreFromBackup([
    entry({ name: 'AiriOne', command: '"C:\\App\\AiriMateOne.exe"', legacy: false }),
    entry({ name: 'MateEngineX', command: '"C:\\Mate\\MateEngineX.exe"' }),
  ])
  assert.equal(plan.toRemoveOwn, 'AiriOne')
  assert.deepEqual(plan.toRestore.map(r => r.name), ['MateEngineX'], '只应恢复旧项')
  assert.equal(plan.toRestore.some(r => r.name === 'AiriOne'), false, '绝不能把自己写回去')
  // 本应用的值名出现在 notOurs 里（便于人工核对，但不恢复）
  assert.ok(plan.notOurs.includes('AiriOne'))
})

test('回滚**大小写不敏感**地识别本应用值名', () => {
  const plan = planRestoreFromBackup([
    entry({ name: 'airione', command: 'x', legacy: false }),
    entry({ name: 'AIRIONE', command: 'x', legacy: false }),
  ])
  assert.deepEqual(plan.toRestore, [], '任何大小写变体都不得被恢复')
})

// ───────────────────────────────────────────────────────── 缺陷 ②：其它位置必须报告

test('★ 旧项在 HKLM Run / 启动文件夹 / 计划任务 ⇒ 必须报告"无法自动恢复"，不得静默成功', () => {
  const plan = planRestoreFromBackup([
    entry({ name: 'MateEngineX', scope: 'hklm-run', command: 'a' }),
    entry({ name: 'AI女友', scope: 'startup-user', command: 'b' }),
    entry({ name: 'airi-brain', scope: 'startup-common', command: 'c' }),
    entry({ name: 'AiriBrainTask', scope: 'scheduled-task', command: 'd' }),
    entry({ name: 'HkcuLegacy', scope: 'hkcu-run', command: 'e' }),
  ])
  assert.deepEqual(plan.toRestore.map(r => r.name), ['HkcuLegacy'], '只有 HKCU Run 里的能恢复')
  assert.equal(plan.unsupported.length, 4, '其余 4 个位置必须被列为无法恢复')
  assert.deepEqual(plan.unsupported.map(u => u.scope).sort(),
    ['hklm-run', 'scheduled-task', 'startup-common', 'startup-user'])
})

// ───────────────────────────────────────────────────────── 边界情况

test('回滚：不恢复**非旧项**（绝不静默动用户的其它启动项）', () => {
  const plan = planRestoreFromBackup([
    entry({ name: 'Steam', command: 'steam.exe', legacy: false }),
    entry({ name: 'OneDrive', command: 'onedrive.exe', legacy: false }),
    entry({ name: 'MateEngineX', command: 'mate.exe', legacy: true }),
  ])
  assert.deepEqual(plan.toRestore.map(r => r.name), ['MateEngineX'])
  assert.deepEqual(plan.notOurs.sort(), ['OneDrive', 'Steam'])
})

test('回滚：`exists: false` 的条目跳过（备份里可能出现已被用户手动删掉的项）', () => {
  const plan = planRestoreFromBackup([
    entry({ name: 'Gone', exists: false }),
    entry({ name: 'Present', exists: true }),
  ])
  assert.deepEqual(plan.toRestore.map(r => r.name), ['Present'])
})

test('回滚：同名重复条目只恢复一次（`reg export` 与盘点可能重复）', () => {
  const plan = planRestoreFromBackup([
    entry({ name: 'Dup', command: 'first' }),
    entry({ name: 'Dup', command: 'second' }),
  ])
  assert.equal(plan.toRestore.length, 1, '同名只恢复一次')
  assert.equal(plan.toRestore[0].command, 'first', '保留先出现的那条')
})

test('★ 回滚**必须**恢复值名带旧前缀的旧项 —— 那正是"旧项"的本来名字', () => {
  /**
   * 这条测试记录一个**方向搞反**的真实缺陷：
   * 原实现用 `assertNameSafeFromLegacyUninstaller()` 去卡**被恢复的旧项名**，
   * 而那个断言的适用对象是"**我们要写进去的新值名**"。
   * 旧启动项本来就叫 `AI女友` / `airi-brain` ⇒ 结果"回滚旧项"正好拒绝回滚旧项。
   * 演练（tools/qa/check-autostart-rollback.ps1）实测：3 条旧项只恢复了 1 条。
   */
  const plan = planRestoreFromBackup([
    entry({ name: 'MateEngineX', command: 'mate' }),
    entry({ name: 'airi-brain', command: 'brain' }),
    entry({ name: 'AI女友', command: 'old' }),
  ])
  assert.deepEqual(plan.toRestore.map(r => r.name).sort(), ['AI女友', 'MateEngineX', 'airi-brain'].sort(),
    '三条旧项必须**全部**恢复')
  assert.deepEqual(plan.riskyRestored.sort(), ['AI女友', 'airi-brain'].sort(),
    '命中旧卸载器前缀的应标为"已恢复但有前提条件"，而不是拒绝恢复')
  assert.equal(plan.blocked, undefined, '不应再有 blocked 字段（拒绝恢复是错的）')
})

test('回滚：空备份 ⇒ 空计划（不抛错）', () => {
  const plan = planRestoreFromBackup([])
  assert.deepEqual(plan.toRestore, [])
  assert.deepEqual(plan.unsupported, [])
  assert.equal(plan.toRemoveOwn, 'AiriOne')
})

test('回滚：只有本应用自己一项 ⇒ 恢复 0 条、删自己（卸载后不自启）', () => {
  const plan = planRestoreFromBackup([entry({ name: 'AiriOne', command: 'me', legacy: false })])
  assert.deepEqual(plan.toRestore, [])
  assert.equal(plan.toRemoveOwn, 'AiriOne')
})

test('回滚：命令里的单引号被正确处理（PowerShell 转义的前提是数据本身完整）', () => {
  const cmd = `"C:\\Program Files\\O'Brien\\app.exe" --flag`
  const plan = planRestoreFromBackup([entry({ name: 'Quoted', command: cmd })])
  assert.equal(plan.toRestore[0].command, cmd, '命令必须原样保留（转义在执行层做）')
})

test('回滚：可自定义"本应用值名"（换名后仍不得恢复自己）', () => {
  const plan = planRestoreFromBackup([
    entry({ name: 'AiriOne', command: 'a', legacy: false }),
    entry({ name: 'NewName', command: 'b', legacy: false }),
  ], 'NewName')
  assert.equal(plan.toRemoveOwn, 'NewName')
  // AiriOne 此时既不是自己的名字、也不是旧项 ⇒ 不恢复
  assert.deepEqual(plan.toRestore, [])
  assert.ok(plan.notOurs.includes('AiriOne'))
})

// ───────────────────────────────────────────────────────── 值名安全断言本身

test('值名安全断言：旧卸载器前缀必须被拒绝（大小写不敏感）', () => {
  for (const bad of ['AiriMate', 'airimate', 'AIRIMATEOne', 'AI女友', 'airi-brain', 'aiRI-BRAIN-x']) {
    assert.throws(() => assertNameSafeFromLegacyUninstaller(bad), `"${bad}" 应被拒绝`)
  }
})

test('值名安全断言：实际使用的 `AiriOne` 必须通过', () => {
  assert.doesNotThrow(() => assertNameSafeFromLegacyUninstaller('AiriOne'))
  assert.doesNotThrow(() => assertNameSafeFromLegacyUninstaller('AiriOne-Test'))
})
