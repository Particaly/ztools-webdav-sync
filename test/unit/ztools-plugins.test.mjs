/**
 * 发现层（src-ztools/preload/ztools-plugins.mts）独立单元测试。
 * 覆盖：固定 id 契约、平台目录名映射、插件目录发现（homeDir 注入 /
 * ZTOOLS_DATA_ROOT 覆盖 / 现取不缓存）、远端平台隔离路径组装（含可选云端
 * 父目录的组装与规范化）、available 判定。
 * 运行：npx vitest run test/unit（或 npm run test:unit）
 *
 * 结构说明：沿用 store 单测的 check 软失败登记 + 末尾一次性抛出（所有用例
 * 跑完、失败清单一次列出）；ZTOOLS_DATA_ROOT 是进程级环境变量，用例内
 * 设置并保证 finally 恢复，不泄漏给同进程的其余测试。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PRELOAD = path.join(HERE, '..', '..', 'src-ztools', 'preload')

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

const zp = await import(pathToFileURL(path.join(PRELOAD, 'ztools-plugins.mts')).href)

const TMP = path.join(os.tmpdir(), `wdsync-zp-unit-${Date.now()}-${process.pid}`)

test('ZTools 插件同步发现单元（ZP1–ZP8，强顺序链）', async () => {
  const prevEnv = process.env.ZTOOLS_DATA_ROOT
  try {
    // ZP1 固定 id 契约：渲染层 store.ts 的镜像常量与调度器合成项都以此对齐
    check('ZP1 fixed dir id contract', zp.ZTOOLS_PLUGINS_DIR_ID === 'ztools-plugins', zp.ZTOOLS_PLUGINS_DIR_ID)

    // ZP2 平台目录名映射：已知平台转友好名，未知平台原样保留（保持隔离语义不折叠）
    check(
      'ZP2 platform key mapping',
      zp.ztoolsPlatformKey('darwin') === 'mac' && zp.ztoolsPlatformKey('win32') === 'windows' && zp.ztoolsPlatformKey('linux') === 'linux' && zp.ztoolsPlatformKey('freebsd') === 'freebsd',
      `${zp.ztoolsPlatformKey('darwin')}/${zp.ztoolsPlatformKey('win32')}/${zp.ztoolsPlatformKey('linux')}/${zp.ztoolsPlatformKey('freebsd')}`
    )

    // ZP3 目录发现：缺省 ~/.ztools/plugins（homeDir 可注入，测试不依赖真实 HOME）
    const fakeHome = path.join(TMP, 'home')
    const defDir = zp.ztoolsPluginsDir(fakeHome)
    check('ZP3 default discovery is <home>/.ztools/plugins', defDir === path.join(fakeHome, '.ztools', 'plugins'), defDir)

    // ZP4 环境变量覆盖：ZTOOLS_DATA_ROOT 优先于 ~/.ztools（与宿主 appDataPaths 同序）
    process.env.ZTOOLS_DATA_ROOT = path.join(TMP, 'data-root')
    const envDir = zp.ztoolsPluginsDir(fakeHome)
    check('ZP4 ZTOOLS_DATA_ROOT overrides home convention', envDir === path.join(TMP, 'data-root', 'plugins'), envDir)

    // ZP5 describe 组装：远端路径 = 固定根 + 平台段（darwin/win32/linux 三形态抽样）
    const d1 = zp.describeZtoolsPluginsSync()
    const expectRemote = `${zp.ZTOOLS_PLUGINS_REMOTE_BASE}/${zp.ztoolsPlatformKey(process.platform)}`
    check(
      'ZP5 remote path is platform-isolated under fixed base',
      d1.remotePath === expectRemote && d1.id === 'ztools-plugins' && d1.platformKey === zp.ztoolsPlatformKey(process.platform),
      `${d1.remotePath} (expect ${expectRemote})`
    )

    // ZP5b 可选云端父目录：选择路径后固定跟上 ztools-plugins/<平台> 段（本机目录不变）
    const dBase = zp.describeZtoolsPluginsSync('/backup')
    check(
      'ZP5b custom cloud base composes <base>/ztools-plugins/<platform>',
      dBase.remotePath === `/backup${zp.ZTOOLS_PLUGINS_REMOTE_BASE}/${zp.ztoolsPlatformKey(process.platform)}` && dBase.pluginsDir === d1.pluginsDir,
      dBase.remotePath
    )

    // ZP5c 纯组装函数的规范化：补起始斜杠 / 去尾斜杠 / 反斜杠统一；空与根回落默认云端根
    check(
      'ZP5c composer normalizes the base and falls back to default on empty/root',
      zp.ztoolsPluginsRemotePath('backup', 'mac') === '/backup/ztools-plugins/mac' &&
        zp.ztoolsPluginsRemotePath('/backup/', 'mac') === '/backup/ztools-plugins/mac' &&
        zp.ztoolsPluginsRemotePath('\\backup', 'mac') === '/backup/ztools-plugins/mac' &&
        zp.ztoolsPluginsRemotePath('/', 'mac') === '/ztools-plugins/mac' &&
        zp.ztoolsPluginsRemotePath('', 'mac') === '/ztools-plugins/mac' &&
        zp.ztoolsPluginsRemotePath(null, 'mac') === '/ztools-plugins/mac',
      ''
    )

    // ZP6 available=false：目录不存在时给出面向用户的原因（UI 提示条文案来源）
    check(
      'ZP6 missing dir → available=false with user-facing reason',
      d1.available === false && typeof d1.reason === 'string' && d1.reason.length > 0,
      d1.reason
    )

    // ZP7 available=true：目录存在时可用且不带 reason
    const goodRoot = path.join(TMP, 'good')
    await fsp.mkdir(path.join(goodRoot, 'plugins', 'plugin-a'), { recursive: true })
    await fsp.writeFile(path.join(goodRoot, 'plugins', 'plugin-a', 'plugin.json'), '{}')
    process.env.ZTOOLS_DATA_ROOT = goodRoot
    const d2 = zp.describeZtoolsPluginsSync()
    check(
      'ZP7 existing dir → available=true, no reason, dir points at plugins',
      d2.available === true && d2.reason === undefined && d2.pluginsDir === path.join(goodRoot, 'plugins'),
      JSON.stringify({ available: d2.available, reason: d2.reason, pluginsDir: d2.pluginsDir })
    )

    // ZP8 现取不缓存：环境变量切换后下一次调用立即跟随（虚拟行刷新的语义前提）
    process.env.ZTOOLS_DATA_ROOT = path.join(TMP, 'data-root')
    const d3 = zp.describeZtoolsPluginsSync()
    check('ZP8 describe is re-evaluated per call (no caching)', d3.pluginsDir === path.join(TMP, 'data-root', 'plugins') && d3.available === false, d3.pluginsDir)
  } finally {
    if (prevEnv === undefined) delete process.env.ZTOOLS_DATA_ROOT
    else process.env.ZTOOLS_DATA_ROOT = prevEnv
    await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`zp-unit: ${results.length - failed.length}/${results.length} passed`)
  if (failed.length) {
    throw new Error('发现层单元测试失败：\n' + failed.map((r) => `  ❌ ${r.name}`).join('\n'))
  }
})
