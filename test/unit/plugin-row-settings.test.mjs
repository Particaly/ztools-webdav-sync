/**
 * 「ZTools 插件同步」虚拟行的目录级设置路由（store-dirs.ts）单元测试。
 *
 * 背景：虚拟行的身份字段（本地 / 云端 / 方式）不可修改，但「同步设置」弹窗
 * 开放了目录级设置覆盖与服务器 —— 两者都不落 dirs（虚拟行不持久化），唯一
 * 持久化落点是 prefs.ztoolsPluginSyncOverrides / ztoolsPluginSyncServerId，
 * 行字段与 prefs 双写保持即时响应。本文件固化路由口径：
 *   PR1 —— 行合成：overrides / serverId 取自 prefs（缺省 null / null）
 *   PR2 —— setDirOverrides 路由 prefs + 行双写；生效值经 dirIntervalMin 可读
 *   PR3 —— dirSyncPrefs 组装：全局规则 ∪ 记录级默认（运行时数据库三件套）
 *   PR4 —— 全局规则在前、记录级在后（并去重保序）
 *   PR5 —— 记录级 excludePatterns 整体替换默认；其余覆盖字段保留（patch 合并）
 *   PR6 —— updateDir 路由 serverId / overrides 到 prefs；身份字段 patch 被忽略
 *   PR7 —— resetDirOverrides 路由 prefs（回「跟随全局」，排除规则回内置默认）
 *   PR8 —— 历史独立字段 ztoolsPluginSyncExcludePatterns 仍作为记录级回落值
 *
 * 运行：npx vitest run test/unit（或 npm run test:unit）
 * 结构说明：store-core 是模块级单例（reactive state），用例强顺序依赖，保持
 * 单一 test 顺序执行；check() 沿用软失败登记 + 末尾一次性抛出。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'
import { makeCheck, UNIT_HERE as HERE } from '../harness.mjs'

const { check, assertAtEnd } = makeCheck()

const SRC = path.join(HERE, '..', '..', 'src', 'composables')
const PRELOAD = path.join(HERE, '..', '..', 'src-ztools', 'preload')

// ---- 导入前装好 window.services 桩（refreshPluginSyncRow / registryState 的数据源）----
const DESC = { id: 'ztools-plugins', pluginsDir: 'C:/zt/plugins', remotePath: '/ztools-plugins/windows', platformKey: 'windows', available: true }
globalThis.window = {
  services: {
    ztoolsPlugins: {
      describe: () => ({ ...DESC }),
      registryState: () => null,
    },
  },
}

const core = await import(pathToFileURL(path.join(SRC, 'store-core.ts')).href)
const dirs = await import(pathToFileURL(path.join(SRC, 'store-dirs.ts')).href)
const types = await import(pathToFileURL(path.join(PRELOAD, 'types.mts')).href)

const PID = types.ZTOOLS_PLUGINS_DIR_ID
const TRIO = types.PLUGIN_SYNC_DEFAULT_EXCLUDES

test('插件同步虚拟行设置路由（PR1–PR8，强顺序链）', () => {
  const { state } = core
  const findRow = () => state.dirs.find((d) => d.id === PID)

  // PR1 行合成：开启开关 → 虚拟行出现，overrides / serverId 取自 prefs 缺省（null / null）
  state.prefs.ztoolsPluginSync = true
  dirs.refreshPluginSyncRow()
  const row1 = findRow()
  check(
    'PR1 row synthesizes from prefs with default overrides/serverId',
    row1 && row1.overrides == null && row1.serverId == null && row1.localPath === DESC.pluginsDir && row1.remotePath === DESC.remotePath,
    JSON.stringify(row1 ? { overrides: row1.overrides ?? null, serverId: row1.serverId ?? null } : null)
  )

  // PR2 setDirOverrides 路由 prefs + 行双写：生效值可从 dirIntervalMin 读出
  dirs.setDirOverrides(PID, { intervalMin: 30 })
  check(
    'PR2 setDirOverrides lands in prefs and mirrors onto the row',
    state.prefs.ztoolsPluginSyncOverrides?.intervalMin === 30 && row1.overrides?.intervalMin === 30 && dirs.dirIntervalMin(row1) === 30,
    JSON.stringify({ prefs: state.prefs.ztoolsPluginSyncOverrides, row: row1.overrides ?? null })
  )

  // PR3 dirSyncPrefs 组装（未自定义排除规则）：全局规则空 → 只含内置默认三件套；
  // 未覆盖项回落全局（concurrency 4）。intervalMin 是调度层参数（不走
  // resolveDirPrefs），经 dirIntervalMin 读覆盖值
  const p3 = dirs.dirSyncPrefs(row1)
  check(
    'PR3 dirSyncPrefs unions global (empty) with the runtime-db default trio',
    JSON.stringify(p3.excludePatterns) === JSON.stringify(TRIO) && dirs.dirIntervalMin(row1) === 30 && p3.concurrency === 4,
    JSON.stringify({ excludePatterns: p3.excludePatterns, intervalMin: dirs.dirIntervalMin(row1), concurrency: p3.concurrency })
  )

  // PR4 全局规则参与并集且在前（保序去重）
  state.prefs.excludePatterns = ['*.iso']
  const p4 = dirs.dirSyncPrefs(row1)
  check('PR4 global rules come first in the union', JSON.stringify(p4.excludePatterns) === JSON.stringify(['*.iso', ...TRIO]), JSON.stringify(p4.excludePatterns))

  // PR5 记录级 excludePatterns 整体替换默认（log 上行），全局规则仍叠加；patch
  // 合并保留既有覆盖字段（intervalMin 30 不丢，经 dirIntervalMin 读出）
  dirs.setDirOverrides(PID, { excludePatterns: ['*.log'] })
  const p5 = dirs.dirSyncPrefs(row1)
  check(
    'PR5 record-level patterns replace the defaults while global still union in and other overrides persist',
    JSON.stringify(p5.excludePatterns) === JSON.stringify(['*.iso', '*.log']) && dirs.dirIntervalMin(row1) === 30,
    JSON.stringify({ excludePatterns: p5.excludePatterns, intervalMin: dirs.dirIntervalMin(row1) })
  )

  // PR6 updateDir 路由：serverId / overrides 落 prefs，身份字段 patch（本地 / 远端 /
  // 方式）被忽略
  dirs.updateDir(PID, { localPath: 'C:/hack', remotePath: '/hack', mode: 'upload', serverId: 'srv-b', overrides: null })
  check(
    'PR6 updateDir routes serverId/overrides to prefs and ignores identity patches',
    state.prefs.ztoolsPluginSyncServerId === 'srv-b' &&
      row1.serverId === 'srv-b' &&
      state.prefs.ztoolsPluginSyncOverrides === null &&
      row1.overrides == null &&
      row1.localPath === DESC.pluginsDir &&
      row1.remotePath === DESC.remotePath &&
      row1.mode === 'two-way',
    JSON.stringify({ serverId: row1.serverId, overrides: row1.overrides ?? null, localPath: row1.localPath, mode: row1.mode })
  )

  // PR7 resetDirOverrides 路由 prefs：回「跟随全局」，排除规则回内置默认并集
  dirs.setDirOverrides(PID, { concurrency: 2 })
  dirs.resetDirOverrides(PID)
  const p7 = dirs.dirSyncPrefs(row1)
  check(
    'PR7 resetDirOverrides clears prefs and the effective rules fall back to defaults',
    state.prefs.ztoolsPluginSyncOverrides === null && row1.overrides == null && JSON.stringify(p7.excludePatterns) === JSON.stringify(['*.iso', ...TRIO]) && p7.concurrency === 4,
    JSON.stringify({ prefs: state.prefs.ztoolsPluginSyncOverrides, excludePatterns: p7.excludePatterns, concurrency: p7.concurrency })
  )

  // PR8 历史独立字段兼容：记录级覆盖缺省时仍作为回落值（并集口径不变）
  state.prefs.ztoolsPluginSyncExcludePatterns = ['*.legacy']
  const p8 = dirs.dirSyncPrefs(row1)
  check('PR8 legacy standalone field still feeds the union when no overrides set', JSON.stringify(p8.excludePatterns) === JSON.stringify(['*.iso', '*.legacy']), JSON.stringify(p8.excludePatterns))

  assertAtEnd({
    passLine: (passed, total) => `plugin-row-settings: ${passed}/${total} passed`,
    fail: (failed) => '插件行设置路由单元测试失败：\n' + failed.map((r) => `  ❌ ${r.name}`).join('\n'),
  })
})
