/**
 * 运行中插件预检（src-ztools/preload/ztools-plugins.mts 纯函数 + services.mts
 * 预检门 gateRunningPluginWrites）独立单元测试。
 *
 * 背景：运行中的插件实体文件被宿主进程占用（Windows），同步的覆盖 / 删除必然
 * 失败 —— 引擎在传输前预检，命中时询问用户「重新安装并同步 / 本轮跳过」；确认
 * 后走宿主卸载流程（停止实例 → 移除注册记录 → 直接删除实体文件，不经回收站，
 * 保留插件数据），磁盘核实后调整本轮任务，云端新版本随即下载、轮末对账重新
 * 登记。本插件自身的实体在扫描层整体排除（同步引擎运行在它里面，不可被卸载）。
 * 本文件覆盖：
 *   RP-A selfPluginEntityRel —— 自身实体识别（asar / 目录实体 / 目录外 / 边界）
 *   RP-B pickRunningPluginWriteRels —— 本地写命中判定（顶层精确 / 目录前缀 / 去重）
 *   RP-C pluginDisplayInfoFor —— 展示信息解析（title 优先 / 两类记录 / logo 重建）
 *   RP-D gateRunningPluginWrites —— 预检门（uninstall 卸载 + 任务适配 / 实体未
 *        移除回退 / skip 摘除 / 通道缺失降级 / 非插件目录与预演轮旁路 / 自身命中
 *        不询问）
 *   RP-E setSelfModuleFileForTest —— 自身识别的注入与还原
 *
 * 运行：npx vitest run test/unit（或 npm run test:unit）。
 * 结构说明：check() 沿用软失败登记 + 末尾一次性抛出（与 exclude-semantics 一致）；
 * RP-D 直检经 services.sync._internals + services.host.setHostPorts 注入（源码轨
 * 单模块图，vitest 直载源码与注入同图）；门的磁盘核实走真实 fs，实体文件在临时
 * 目录真实创建。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'
import { makeCheck, UNIT_HERE as HERE } from '../harness.mjs'

const PRELOAD = path.join(HERE, '..', '..', 'src-ztools', 'preload')
const zp = await import(pathToFileURL(path.join(PRELOAD, 'ztools-plugins.mts')).href)

globalThis.window = globalThis.window || {}
await import(pathToFileURL(path.join(PRELOAD, 'services.mts')).href)
const services = globalThis.window.services
const internals = services.sync._internals

// 软失败登记收敛到 harness 的 makeCheck
const { check, assertAtEnd } = makeCheck()

// 本文件的临时插件目录（磁盘核实用真实文件；每个用例独立子目录，helpers 内
// recursive 创建 —— 不依赖模块级 mkdir 的完成时序）
const TMP = path.join(os.tmpdir(), `wdsync-running-unit-${Date.now()}-${process.pid}`)

/** 在临时插件目录里落一个实体文件（asar 形态），返回绝对路径 */
async function makeAsar(dir, name, body = 'asar') {
  await fsp.mkdir(dir, { recursive: true })
  const p = path.join(dir, name)
  await fsp.writeFile(p, body)
  return p
}

/** 在临时插件目录里落一个目录插件实体（目录 + 若干文件），返回目录绝对路径 */
async function makeDirPlugin(dir, name, files) {
  const p = path.join(dir, name)
  await fsp.mkdir(p, { recursive: true })
  for (const f of files) await fsp.writeFile(path.join(p, f), f)
  return p
}

/** 构造预检门的 fake 轮次上下文（只含门消费的字段；tasks / planByRel 按需组装） */
function fakeCtx(pluginsDir, overrides = {}) {
  const warnings = []
  const baselineDeleted = []
  const ctx = {
    dir: { id: 'ztools-plugins', localPath: pluginsDir, remotePath: '/ztools-plugins/windows' },
    dryRun: false,
    tasks: [],
    planByRel: new Map(),
    transferBytesTotal: 0,
    pushWarning: (m) => warnings.push(m),
    shouldAbort: () => false,
    handlers: {},
    store: {
      deleteEntry: async (rel) => {
        baselineDeleted.push(rel)
      },
    },
    ...overrides,
  }
  return { ctx, warnings, baselineDeleted }
}

/**
 * 注入宿主插件管理端口。uninstall 行为：从运行列表移除该路径（模拟宿主 kill），
 * removeEntity=true 时再从磁盘删除实体（模拟宿主 fs.rm 成功）；false = 实体删除
 * 被占用（宿主只记日志仍返回 success 的形态）。internal 注入展示名解析的注册表
 * 读取。返回调用日志。
 */
function fakePluginsPort(runningList, { removeEntity = true, fail = false, internal = null } = {}) {
  const log = { uninstalls: [], runningQueries: 0 }
  services.host.setHostPorts({
    storageRoot: () => null,
    trashItem: async () => {},
    notify: () => {},
    config: null,
    lifecycle: null,
    internal,
    plugins: {
      getRunning: async () => {
        log.runningQueries++
        return runningList.slice()
      },
      uninstall: async (p) => {
        log.uninstalls.push(p)
        if (fail) return { success: false, error: '宿主拒绝' }
        const i = runningList.indexOf(p)
        if (i >= 0) runningList.splice(i, 1)
        if (removeEntity) await fsp.rm(p, { recursive: true, force: true })
        return { success: true }
      },
    },
    permissions: null,
  })
  return log
}

test('运行中插件预检（RP-A 自身实体识别）', () => {
  const dir = 'L:\\zt\\plugins'
  // asar 插件：preload 在 asar 虚拟路径内，实体 = 首段文件名
  check(
    'RP-A1 asar 实体识别（Electron asar 虚拟路径）',
    zp.selfPluginEntityRel(dir, 'L:\\zt\\plugins\\webdav-sync-1.1.0-abc.asar\\src-ztools\\preload\\dist\\services.js') === 'webdav-sync-1.1.0-abc.asar',
    ''
  )
  // 目录插件：实体 = 目录名
  check(
    'RP-A2 目录实体识别（实体目录内文件）',
    zp.selfPluginEntityRel(dir, 'L:\\zt\\plugins\\f-provider\\preload\\index.js') === 'f-provider',
    ''
  )
  // 正斜杠形态同判（宿主注入路径分隔符可能不一）
  check(
    'RP-A3 正斜杠路径同判',
    zp.selfPluginEntityRel('L:/zt/plugins', 'L:/zt/plugins/foo-1.0.asar/dist/main.js') === 'foo-1.0.asar',
    ''
  )
  // 目录外（开发项目 / 浏览器形态）不可判定
  check('RP-A4 目录外模块文件返回 null', zp.selfPluginEntityRel(dir, 'D:\\dev\\my-plugin\\main.js') === null, '')
  check('RP-A5 恰为 pluginsDir 本身返回 null', zp.selfPluginEntityRel(dir, 'L:\\zt\\plugins') === null, '')
  check('RP-A6 空模块文件返回 null', zp.selfPluginEntityRel(dir, null) === null && zp.selfPluginEntityRel(dir, '') === null, '')
  // 点开头首段不是实体（防 manifest 等同步辅助文件误判）
  check('RP-A7 点开头首段返回 null', zp.selfPluginEntityRel(dir, 'L:\\zt\\plugins\\.wdsync-tmp\\x.js') === null, '')
  // Windows 大小写不敏感：目录段大小写不一致仍命中（返回磁盘原样大小写）
  check(
    'RP-A8 前缀大小写不敏感',
    zp.selfPluginEntityRel('L:\\zt\\Plugins', 'l:\\zt\\PLUGINS\\foo-1.0.asar\\x.js') === 'foo-1.0.asar',
    ''
  )
})

test('运行中插件预检（RP-B 本地写命中判定）', () => {
  const dir = 'L:\\zt\\plugins'
  const running = ['L:\\zt\\plugins\\calc-1.4.2-2baa.asar', 'L:\\zt\\plugins\\dirplug', 'D:\\dev\\outside']
  const writes = [
    'calc-1.4.2-2baa.asar', // 顶层 asar 覆盖（精确命中）
    'dirplug/main.js', // 目录实体内部文件（前缀命中）
    'dirplug', // 目录实体本身被删（前缀命中同一实体）
    'other-2.0.asar', // 未运行插件（不命中）
    'unrelated.txt',
  ]
  const hits = zp.pickRunningPluginWriteRels(writes, running, dir)
  check(
    'RP-B1 顶层 asar 精确命中 + 目录实体前缀命中（含实体本身），目录外运行路径忽略',
    hits.size === 2 && hits.get('L:\\zt\\plugins\\calc-1.4.2-2baa.asar') === 'calc-1.4.2-2baa.asar' && hits.get('L:\\zt\\plugins\\dirplug') === 'dirplug',
    JSON.stringify([...hits])
  )
  // 同一实体的多文件命中去重（一个实体一个询问条目）
  const hits2 = zp.pickRunningPluginWriteRels(['dirplug/a.js', 'dirplug/b/c.js'], ['L:/zt/plugins/dirplug'], 'L:\\zt\\plugins')
  check('RP-B2 同实体多文件命中去重为一条', hits2.size === 1 && hits2.has('L:/zt/plugins/dirplug'), JSON.stringify([...hits2]))
  // 前缀不误伤同名前缀兄弟（dirplug2 不是 dirplug 的子路径）
  const hits3 = zp.pickRunningPluginWriteRels(['dirplug2/a.js'], ['L:/zt/plugins/dirplug'], 'L:\\zt\\plugins')
  check('RP-B3 同名前缀兄弟不误伤', hits3.size === 0, JSON.stringify([...hits3]))
  // 空输入
  check('RP-B4 空写集 / 空运行集返回空映射', zp.pickRunningPluginWriteRels([], running, dir).size === 0 && zp.pickRunningPluginWriteRels(writes, [], dir).size === 0, '')
})

test('运行中插件预检（RP-C 展示信息解析：名称 + 图标）', () => {
  const dir = 'L:\\zt\\plugins'
  const registry = [
    { name: 'calc', title: '计算器', path: 'L:\\zt\\plugins\\calc-1.4.2.asar', logo: 'data:image/png;base64,AAA' },
    { name: 'filelogo', path: 'L:/zt/plugins/filelogo-1.0.asar', logo: 'file:///L:/zt/plugins/filelogo-1.0.asar/icon.png' },
  ]
  const manifest = [
    { name: 'dirplug', entity: 'dirplug', logo: 'dirplug/icon.png' },
    { name: 'nolingo', entity: 'nolingo-1.0.asar' },
  ]
  const records = [...registry, ...manifest]
  const calc = zp.pluginDisplayInfoFor(records, 'calc-1.4.2.asar', dir)
  check('RP-C1 注册表记录 title 优先 + data: 图标原样', !!calc && calc.name === '计算器' && calc.logo === 'data:image/png;base64,AAA', JSON.stringify(calc))
  const fl = zp.pluginDisplayInfoFor(records, 'filelogo-1.0.asar', dir)
  check('RP-C2 file:// 图标原样', !!fl && fl.name === 'filelogo' && fl.logo === 'file:///L:/zt/plugins/filelogo-1.0.asar/icon.png', JSON.stringify(fl))
  const dp = zp.pluginDisplayInfoFor(records, 'dirplug', dir)
  check(
    'RP-C3 manifest 相对路径 logo 重建为本机 file:// URL',
    !!dp && dp.name === 'dirplug' && dp.logo === pathToFileURL(path.join(dir, 'dirplug', 'icon.png')).href,
    JSON.stringify(dp)
  )
  const nl = zp.pluginDisplayInfoFor(records, 'nolingo-1.0.asar', dir)
  check('RP-C4 无 logo 记录：只带名称（记录的 name）', !!nl && nl.name === 'nolingo' && nl.logo === undefined, JSON.stringify(nl))
  check('RP-C5 无命中返回 null（展示回落实体文件名）', zp.pluginDisplayInfoFor(records, 'unknown-9.9.asar', dir) === null, '')
  check('RP-C6 空 records 返回 null', zp.pluginDisplayInfoFor([], 'calc.asar', dir) === null, '')
  check('RP-C7 注册表记录无 title 回落 name', zp.pluginDisplayInfoFor([{ name: 'calc', path: 'L:/zt/plugins/calc.asar' }], 'calc.asar', dir)?.name === 'calc', '')
})

test('运行中插件预检（RP-D 预检门）', async () => {
  // ---- RP-D1 uninstall：实体删除成功 → 任务按磁盘核实适配 ----
  {
    const dir = path.join(TMP, 'd1')
    const calcAbs = await makeAsar(dir, 'calc-1.4.2.asar')
    await makeDirPlugin(dir, 'dirplug', ['main.js', 'extra.js'])
    const running = [calcAbs, path.join(dir, 'dirplug')]
    const port = fakePluginsPort(running, {
      removeEntity: true,
      // 注册表读取（展示名 + 图标解析）：calc 带 title 与 data: 图标
      internal: { dbGet: async () => [{ name: 'calc', title: '计算器', path: calcAbs, logo: 'data:image/png;base64,AAA' }] },
    })
    const { ctx, warnings, baselineDeleted } = fakeCtx(dir)
    ctx.planByRel.set('calc-1.4.2.asar', { rel: 'calc-1.4.2.asar', l: { size: 1, mtimeMs: 1 } })
    ctx.tasks = [
      { rel: 'calc-1.4.2.asar', kind: 'download', bytes: 100 }, // 覆盖下载 → 转全新下载
      { rel: 'dirplug/main.js', kind: 'delete-local', bytes: 0 }, // 留任（实体已不在，执行即达成）
      { rel: 'dirplug/extra.js', kind: 'upload', bytes: 30 }, // 实体内上传 → 摘除
      { rel: 'dirplug/new-name.js', kind: 'rename-local', bytes: 10 }, // 实体内改名 → 摘除
      { rel: 'keep-2.0.asar', kind: 'upload', bytes: 50 }, // 无关任务 → 留任
      { rel: 'gone-1.0.asar', kind: 'delete-remote', bytes: 0 }, // 云端清理 → 留任
    ]
    ctx.transferBytesTotal = 190
    const asked = []
    ctx.handlers.onPluginRunning = async (info) => {
      asked.push(info.items)
      return 'uninstall'
    }
    await internals.gateRunningPluginWrites(ctx)
    const left = ctx.tasks.map((t) => `${t.kind}:${t.rel}`).sort()
    check(
      'RP-D1 卸载两实体；覆盖下载转全新（it.l 置空 + 基线删除）；实体内上传/改名摘除；delete-local / delete-remote / 无关任务留任',
      port.uninstalls.length === 2 &&
        ctx.planByRel.get('calc-1.4.2.asar').l === null &&
        JSON.stringify(baselineDeleted) === JSON.stringify(['calc-1.4.2.asar']) &&
        JSON.stringify(left) === JSON.stringify(['delete-local:dirplug/main.js', 'delete-remote:gone-1.0.asar', 'download:calc-1.4.2.asar', 'upload:keep-2.0.asar']) &&
        ctx.transferBytesTotal === 150 &&
        warnings.length === 0,
      JSON.stringify({ uninstalls: port.uninstalls, left, bytes: ctx.transferBytesTotal, baselineDeleted, warnings })
    )
    check(
      'RP-D1b 询问条目带展示名与图标',
      asked.length === 1 && asked[0].length === 2 && asked[0].some((x) => x.name === '计算器' && x.logo === 'data:image/png;base64,AAA'),
      JSON.stringify(asked)
    )
    services.host.setHostPorts(null)
  }
  // ---- RP-D1c 卸载返回成功但实体仍被占用（宿主删除失败只记日志）→ 任务原样保留 ----
  {
    const dir = path.join(TMP, 'd1c')
    const calcAbs = await makeAsar(dir, 'calc-1.4.2.asar')
    fakePluginsPort([calcAbs], { removeEntity: false })
    const { ctx, baselineDeleted } = fakeCtx(dir)
    const it = { rel: 'calc-1.4.2.asar', l: { size: 1, mtimeMs: 1 } }
    ctx.planByRel.set('calc-1.4.2.asar', it)
    ctx.tasks = [{ rel: 'calc-1.4.2.asar', kind: 'download', bytes: 100 }]
    ctx.handlers.onPluginRunning = async () => 'uninstall'
    await internals.gateRunningPluginWrites(ctx)
    check(
      'RP-D1c 实体仍在：it.l 保留、基线不动、任务留任（按既有失败路径安全失败）',
      it.l !== null && baselineDeleted.length === 0 && ctx.tasks.length === 1,
      JSON.stringify({ l: it.l, baselineDeleted, tasks: ctx.tasks.length })
    )
    services.host.setHostPorts(null)
  }
  // ---- RP-D1d 卸载失败（宿主拒绝）→ 任务原样保留 ----
  {
    const dir = path.join(TMP, 'd1d')
    const calcAbs = await makeAsar(dir, 'calc-1.4.2.asar')
    fakePluginsPort([calcAbs], { removeEntity: false, fail: true })
    const { ctx } = fakeCtx(dir)
    const it = { rel: 'calc-1.4.2.asar', l: { size: 1, mtimeMs: 1 } }
    ctx.planByRel.set('calc-1.4.2.asar', it)
    ctx.tasks = [{ rel: 'calc-1.4.2.asar', kind: 'download', bytes: 100 }]
    ctx.handlers.onPluginRunning = async () => 'uninstall'
    await internals.gateRunningPluginWrites(ctx)
    check('RP-D1d 卸载失败：任务原样保留', it.l !== null && ctx.tasks.length === 1, '')
    services.host.setHostPorts(null)
  }
  // ---- RP-D2 skip：命中实体的本地写任务摘出本轮（字节分母同步扣减）+ 显式跳过带 warning ----
  {
    const dir = path.join(TMP, 'd2')
    await makeAsar(dir, 'calc-1.4.2.asar')
    await makeDirPlugin(dir, 'dirplug', ['main.js'])
    fakePluginsPort([path.join(dir, 'calc-1.4.2.asar'), path.join(dir, 'dirplug')], { removeEntity: false })
    const { ctx, warnings } = fakeCtx(dir)
    ctx.planByRel.set('calc-1.4.2.asar', { rel: 'calc-1.4.2.asar', l: { size: 1, mtimeMs: 1 } })
    ctx.planByRel.set('dirplug/main.js', { rel: 'dirplug/main.js', l: { size: 2, mtimeMs: 2 } })
    ctx.tasks = [
      { rel: 'calc-1.4.2.asar', kind: 'download', bytes: 100 },
      { rel: 'dirplug/main.js', kind: 'download', bytes: 30 },
      { rel: 'dirplug', kind: 'delete-local', bytes: 0 },
      { rel: 'keep-2.0.asar', kind: 'upload', bytes: 50 },
    ]
    ctx.transferBytesTotal = 180
    ctx.handlers.onPluginRunning = async () => 'skip'
    await internals.gateRunningPluginWrites(ctx)
    const left = ctx.tasks.map((t) => t.rel)
    check(
      'RP-D2 skip：命中本地写任务全部摘出、字节分母扣减、无关上传留任、带跳过 warning',
      JSON.stringify(left.sort()) === JSON.stringify(['keep-2.0.asar']) && ctx.transferBytesTotal === 50 && warnings.length === 1 && /已跳过 3 个/.test(warnings[0]),
      JSON.stringify({ left, bytes: ctx.transferBytesTotal, warnings })
    )
    services.host.setHostPorts(null)
  }
  // ---- RP-D3 后台轮（无询问通道）：静默跳过（摘任务、无 warning） ----
  {
    const dir = path.join(TMP, 'd3')
    await makeAsar(dir, 'calc-1.4.2.asar')
    fakePluginsPort([path.join(dir, 'calc-1.4.2.asar')], { removeEntity: false })
    const { ctx, warnings } = fakeCtx(dir)
    ctx.planByRel.set('calc-1.4.2.asar', { rel: 'calc-1.4.2.asar', l: { size: 1, mtimeMs: 1 } })
    ctx.tasks = [{ rel: 'calc-1.4.2.asar', kind: 'download', bytes: 100 }]
    await internals.gateRunningPluginWrites(ctx)
    check('RP-D3 无询问通道静默跳过（任务摘出、无 warning）', ctx.tasks.length === 0 && warnings.length === 0, JSON.stringify({ tasks: ctx.tasks.length, warnings }))
    services.host.setHostPorts(null)
  }
  // ---- RP-D4 降级：端口缺失 / 查询失败 → 不动任务（按既有失败路径处理） ----
  {
    const dir = path.join(TMP, 'd4')
    await makeAsar(dir, 'calc-1.4.2.asar')
    services.host.setHostPorts(null)
    const { ctx } = fakeCtx(dir)
    ctx.planByRel.set('calc-1.4.2.asar', { rel: 'calc-1.4.2.asar', l: { size: 1, mtimeMs: 1 } })
    ctx.tasks = [{ rel: 'calc-1.4.2.asar', kind: 'download', bytes: 100 }]
    await internals.gateRunningPluginWrites(ctx)
    check('RP-D4a 插件端口缺失：任务原样保留（降级直传）', ctx.tasks.length === 1, '')
    fakePluginsPort([path.join(dir, 'calc-1.4.2.asar')], { removeEntity: false })
    services.host.getHostPorts().plugins.getRunning = async () => null // 查询失败形态
    await internals.gateRunningPluginWrites(ctx)
    check('RP-D4b 查询失败：任务原样保留（降级直传）', ctx.tasks.length === 1, '')
    fakePluginsPort([], { removeEntity: false }) // 无运行插件
    await internals.gateRunningPluginWrites(ctx)
    check('RP-D4c 无运行插件：任务原样保留', ctx.tasks.length === 1, '')
    services.host.setHostPorts(null)
  }
  // ---- RP-D5 旁路：非插件目录 / 预演轮 / 无本地写任务 ----
  {
    const dir = path.join(TMP, 'd5')
    await makeAsar(dir, 'calc-1.4.2.asar')
    fakePluginsPort([path.join(dir, 'calc-1.4.2.asar')], { removeEntity: false })
    const plain = fakeCtx(dir, { dir: { id: 'd1', localPath: dir, remotePath: '/docs' }, tasks: [{ rel: 'a.txt', kind: 'download', bytes: 10 }] })
    plain.ctx.planByRel.set('a.txt', { rel: 'a.txt', l: { size: 1, mtimeMs: 1 } })
    await internals.gateRunningPluginWrites(plain.ctx)
    const dry = fakeCtx(dir, { dryRun: true, tasks: [{ rel: 'calc-1.4.2.asar', kind: 'download', bytes: 10 }] })
    dry.ctx.planByRel.set('calc-1.4.2.asar', { rel: 'calc-1.4.2.asar', l: { size: 1, mtimeMs: 1 } })
    await internals.gateRunningPluginWrites(dry.ctx)
    const fresh = fakeCtx(dir, { tasks: [{ rel: 'brand-new-1.0.asar', kind: 'download', bytes: 10 }] })
    fresh.ctx.planByRel.set('brand-new-1.0.asar', { rel: 'brand-new-1.0.asar', l: null }) // 全新下载（无覆盖）
    await internals.gateRunningPluginWrites(fresh.ctx)
    check(
      'RP-D5 非插件目录 / 预演轮 / 全新下载均旁路（任务不动、不询问）',
      plain.ctx.tasks.length === 1 && dry.ctx.tasks.length === 1 && fresh.ctx.tasks.length === 1,
      ''
    )
    services.host.setHostPorts(null)
  }
  // ---- RP-D6 自身命中不询问（防御性再滤；仅自身命中时不弹窗） ----
  {
    const dir = path.join(TMP, 'd6')
    await makeAsar(dir, 'webdav-sync-1.1.0.asar')
    await makeAsar(dir, 'calc-1.4.2.asar')
    internals.setSelfModuleFileForTest(path.join(dir, 'webdav-sync-1.1.0.asar', 'preload', 'services.js'))
    try {
      fakePluginsPort([path.join(dir, 'webdav-sync-1.1.0.asar'), path.join(dir, 'calc-1.4.2.asar')], { removeEntity: false })
      const { ctx } = fakeCtx(dir)
      ctx.planByRel.set('webdav-sync-1.1.0.asar', { rel: 'webdav-sync-1.1.0.asar', l: { size: 1, mtimeMs: 1 } })
      ctx.planByRel.set('calc-1.4.2.asar', { rel: 'calc-1.4.2.asar', l: { size: 1, mtimeMs: 1 } })
      ctx.tasks = [
        { rel: 'webdav-sync-1.1.0.asar', kind: 'download', bytes: 100 },
        { rel: 'calc-1.4.2.asar', kind: 'download', bytes: 100 },
      ]
      const asked = []
      ctx.handlers.onPluginRunning = async (info) => {
        asked.push(info.items)
        return 'skip'
      }
      await internals.gateRunningPluginWrites(ctx)
      check(
        'RP-D6 自身实体被过滤出询问（仅询问其他插件）',
        asked.length === 1 && asked[0].length === 1 && asked[0][0].rel === 'calc-1.4.2.asar',
        JSON.stringify(asked)
      )
      // 仅自身命中：不询问、任务不动（自身在扫描层已被排除，这里只是防御）
      const only = fakeCtx(dir)
      only.ctx.planByRel.set('webdav-sync-1.1.0.asar', { rel: 'webdav-sync-1.1.0.asar', l: { size: 1, mtimeMs: 1 } })
      only.ctx.tasks = [{ rel: 'webdav-sync-1.1.0.asar', kind: 'download', bytes: 100 }]
      let askedAgain = false
      only.ctx.handlers.onPluginRunning = async () => {
        askedAgain = true
        return 'skip'
      }
      await internals.gateRunningPluginWrites(only.ctx)
      check('RP-D6b 仅自身命中时不询问', askedAgain === false && only.ctx.tasks.length === 1, JSON.stringify({ askedAgain, tasks: only.ctx.tasks.length }))
    } finally {
      internals.setSelfModuleFileForTest(undefined) // 还原真实 __filename 通道
      services.host.setHostPorts(null)
    }
  }
})

test('运行中插件预检（RP-E 自身识别注入与还原）', async () => {
  const dir = 'L:\\zt\\plugins'
  internals.setSelfModuleFileForTest('L:\\zt\\plugins\\me-1.0.asar\\x.js')
  check('RP-E1 注入后识别为注入值', internals.runningSelfEntityRel(dir) === 'me-1.0.asar', internals.runningSelfEntityRel(dir))
  internals.setSelfModuleFileForTest(null)
  check('RP-E2 显式 null = 无模块文件（返回 null）', internals.runningSelfEntityRel(dir) === null, '')
  internals.setSelfModuleFileForTest(undefined)
  // 还原后读真实 `__filename`：Node 测试环境是源码 .mts 直载（ESM），无 `__filename`
  // → null；若未来在 CJS 形态跑且位于插件目录内，返回非空也是合法形态，不做强断言
  const restored = internals.runningSelfEntityRel(dir)
  check('RP-E3 还原后不抛错', restored === null || typeof restored === 'string', String(restored))

  // 全文件用例在此一次性收敛（模块级调用会在测试执行前跑完 —— 恒平凡通过，
  // 必须挂在最后一个 test 块内；前面用例的失败清单也由这里统一抛出）
  await assertAtEnd()
})
