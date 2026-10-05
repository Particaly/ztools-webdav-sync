/**
 * 注册表对账层（src-ztools/preload/ztools-registry.mts）独立单元测试。
 * 覆盖：导出投影与重定基（路径 / logo 跨设备还原）、manifest 序列化稳定性与
 * 解析防御（损坏 / 版本过新 / 单条坏记录）、合并语义（本机权威 + 实体存在门槛 +
 * 幽灵清理）、孤儿实体扫描与登记、reconcileCore 全链路（注入内部 API 端口与
 * 真实临时目录：引导写 manifest / 采纳 / 幽灵两轮核验 / 降级 / 在途记录保留 /
 * 幂等无扰动）。
 * 运行：npx vitest run test/unit（或 npm run test:unit）
 *
 * 结构说明：沿用 zp 单测的 check 软失败登记 + 末尾一次性抛出；fake asar 用
 * 「以 .asar 结尾的目录」伪造（node 的 fs 直接按目录读 plugin.json，Electron
 * 运行时则由 asar 补丁承担同名读取路径，两种形态对扫描层透明）。
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

const zr = await import(pathToFileURL(path.join(PRELOAD, 'ztools-registry.mts')).href)

const TMP = path.join(os.tmpdir(), `wdsync-zr-unit-${Date.now()}-${process.pid}`)

test('ZTools 注册表对账单元（ZR1–ZR7，强顺序链）', async () => {
  const pluginsDir = path.join(TMP, 'plugins')
  try {
    // ---- 夹具：两个已注册实体（目录插件 alpha / 伪 asar 插件 beta）----
    await fsp.mkdir(path.join(pluginsDir, 'alpha'), { recursive: true })
    await fsp.writeFile(path.join(pluginsDir, 'alpha', 'plugin.json'), JSON.stringify({ name: 'alpha', title: 'Alpha', version: '1.0.0', logo: 'icon.png' }))
    await fsp.writeFile(path.join(pluginsDir, 'alpha', 'icon.png'), 'png')
    await fsp.mkdir(path.join(pluginsDir, 'beta-2.0.0-x.asar'), { recursive: true })
    await fsp.writeFile(path.join(pluginsDir, 'beta-2.0.0-x.asar', 'plugin.json'), JSON.stringify({ name: 'beta', title: 'Beta', version: '2.0.0' }))

    const alphaLogo = pathToFileURL(path.join(pluginsDir, 'alpha', 'icon.png')).href
    const alphaRec = {
      name: 'alpha', title: 'Alpha', version: '1.0.0', description: '', author: '', homepage: '',
      main: 'index.html', features: [{ code: 'a', icon: 'icon.png' }], path: path.join(pluginsDir, 'alpha'),
      storageKind: 'directory', sourceType: 'open_source', isDevelopment: false,
      installedFrom: 'npm', installedAt: '2026-01-01T00:00:00.000Z', logo: alphaLogo,
    }
    const betaRec = {
      name: 'beta', title: 'Beta', version: '2.0.0', path: path.join(pluginsDir, 'beta-2.0.0-x.asar'),
      storageKind: 'asar', isDevelopment: false, installedAt: '2026-01-02T00:00:00.000Z',
      logo: pathToFileURL(path.join(pluginsDir, 'beta-2.0.0-x.asar', 'icon.png')).href,
    }

    // ZR1 导出投影与导入还原：绝对 path → 相对 entity、file:// logo → 相对 logo；
    // 还原后 path / logo 按本机 pluginsDir 重建（跨设备重定基的核心往返）
    const m = zr.registryRecordToManifest(alphaRec, pluginsDir)
    check(
      'ZR1a registry→manifest rebase path and logo',
      m.name === 'alpha' && m.entity === 'alpha' && m.logo === 'alpha/icon.png' && m.installedFrom === 'npm' && !('path' in m) && !('isDevelopment' in m),
      JSON.stringify(m)
    )
    const back = zr.manifestRecordToRegistry(m, pluginsDir)
    check(
      'ZR1b manifest→registry rebuilds local path and logo',
      back.path === path.join(pluginsDir, 'alpha') && back.logo === alphaLogo && back.storageKind === 'directory',
      JSON.stringify({ path: back.path, logo: back.logo })
    )

    // ZR2 导出过滤与排序：目录外（开发项目）与实体缺位的记录不外传；输出按 name 稳定排序
    const devRec = { name: 'devproj', path: path.join(TMP, 'workspace', 'devproj'), isDevelopment: true }
    const ghostRec = { name: 'ghost', path: path.join(pluginsDir, 'gone'), isDevelopment: false }
    const manifest = zr.buildManifest([betaRec, devRec, ghostRec, alphaRec], pluginsDir)
    check(
      'ZR2 buildManifest filters non-entity/missing and sorts by name',
      JSON.stringify(manifest.records.map((r) => r.name)) === JSON.stringify(['alpha', 'beta']),
      JSON.stringify(manifest.records.map((r) => r.name))
    )
    const text1 = zr.serializeManifest(manifest)
    check('ZR2b serializeManifest is deterministic', zr.serializeManifest(zr.buildManifest([betaRec, devRec, ghostRec, alphaRec], pluginsDir)) === text1, text1)

    // ZR3 解析防御：合法文本往返；损坏 / 版本过新整体作废；单条坏记录跳过；
    // 版本窥探能识别「新版本 manifest」供冻结判定
    check('ZR3a parseManifest round-trips valid text', JSON.stringify(zr.parseManifest(text1)) === JSON.stringify(manifest), '')
    check(
      'ZR3b parseManifest rejects corrupt and newer versions',
      zr.parseManifest('not json') === null && zr.parseManifest('{"version":2,"records":[]}') === null && zr.parseManifest('{"version":0,"records":[]}') === null,
      ''
    )
    const partial = zr.parseManifest(JSON.stringify({ version: 1, records: [{ name: 'x', entity: 'x' }, { entity: 'no-name' }, { name: 'no-entity' }, 'junk'] }))
    check('ZR3c parseManifest keeps good records and drops bad ones', partial !== null && partial.records.length === 1 && partial.records[0].name === 'x', JSON.stringify(partial))
    check('ZR3d manifestVersionOnDisk peeks version', zr.manifestVersionOnDisk('{"version":99,"records":[]}') === 99 && zr.manifestVersionOnDisk(null) === null && zr.manifestVersionOnDisk('garbage') === null, '')

    // ZR4 合并语义：本机记录原样保留（权威）；manifest 记录实体存在才采纳；
    // dropNames 只清理 pluginsDir 内实体的记录（开发项目即使点名也不动）
    const gammaRec = { name: 'gamma', entity: 'gamma', title: 'Gamma', version: '0.1.0' }
    const { next, added, removed } = zr.mergeRegistryWithManifest(
      [alphaRec, { name: 'ghost2', path: path.join(pluginsDir, 'ghost2') }, devRec],
      { version: 1, records: [gammaRec, { name: 'pending', entity: 'pending' }] },
      pluginsDir,
      (p) => p === path.join(pluginsDir, 'gamma'),
      new Set(['ghost2', 'devproj'])
    )
    check(
      'ZR4 merge adopts existing-entity records only and drops marked ghosts',
      added.length === 1 && added[0] === 'gamma' && removed.length === 1 && removed[0] === 'ghost2' &&
        next.length === 3 && next.find((r) => r.name === 'gamma').path === path.join(pluginsDir, 'gamma') &&
        next.find((r) => r.name === 'alpha') === alphaRec && next.find((r) => r.name === 'devproj') === devRec,
      JSON.stringify({ added, removed, names: next.map((r) => r.name) })
    )

    // ZR5 孤儿扫描：目录插件与伪 asar 目录被识别，点开头 / manifest 自身 / 已登记 / 无 plugin.json 跳过
    await fsp.mkdir(path.join(pluginsDir, 'delta'), { recursive: true })
    await fsp.writeFile(path.join(pluginsDir, 'delta', 'plugin.json'), JSON.stringify({ name: 'delta', title: 'Delta', logo: 'i.png' }))
    await fsp.writeFile(path.join(pluginsDir, 'delta', 'i.png'), 'png')
    await fsp.mkdir(path.join(pluginsDir, 'eps-1.0.0-z.asar'), { recursive: true })
    await fsp.writeFile(path.join(pluginsDir, 'eps-1.0.0-z.asar', 'plugin.json'), JSON.stringify({ name: 'eps', title: 'Eps' }))
    await fsp.mkdir(path.join(pluginsDir, '.hiding'), { recursive: true })
    await fsp.writeFile(path.join(pluginsDir, '.hiding', 'plugin.json'), JSON.stringify({ name: 'hiding' }))
    await fsp.writeFile(path.join(pluginsDir, zr.REGISTRY_MANIFEST_NAME), '{"version":1,"records":[]}')
    await fsp.writeFile(path.join(pluginsDir, 'readme.txt'), 'not a plugin')
    const orphans = zr.scanOrphanEntities(pluginsDir, new Set(['alpha', 'beta']))
    check(
      'ZR5 scanOrphanEntities finds dir/asar orphans and skips dot/manifest/known/plain files',
      JSON.stringify(orphans.map((o) => o.config.name).sort()) === JSON.stringify(['delta', 'eps']) && orphans.every((o) => o.entityPath.startsWith(pluginsDir)),
      JSON.stringify(orphans.map((o) => o.config.name))
    )

    // ZR6 孤儿登记形态：installedFrom 'unknown'、storageKind 按形态、logo 重建为实体内 file:// URL
    const delta = orphans.find((o) => o.config.name === 'delta')
    const deltaRec = zr.orphanEntityToRegistry(delta)
    check(
      'ZR6 orphanEntityToRegistry builds a registry-shaped record',
      deltaRec.name === 'delta' && deltaRec.installedFrom === 'unknown' && deltaRec.isDevelopment === false &&
        deltaRec.storageKind === 'directory' && deltaRec.path === path.join(pluginsDir, 'delta') &&
        deltaRec.logo === pathToFileURL(path.join(pluginsDir, 'delta', 'i.png')).href,
      JSON.stringify(deltaRec)
    )
    // 清场：delta / eps 已完成使命，摘除后 ZR7 的孤儿扫描只剩目标场景的实体
    await fsp.rm(path.join(pluginsDir, 'delta'), { recursive: true, force: true })
    await fsp.rm(path.join(pluginsDir, 'eps-1.0.0-z.asar'), { recursive: true, force: true })

    // ZR7 reconcileCore 全链路（注入内存注册表端口 + 真实临时目录；默认 fs 通道）
    zr.__resetRegistryStateForTest()
    // 清掉 ZR5 写入的空 manifest：A 场景要在「盘上无 manifest」的前提下验证引导
    await fsp.rm(path.join(pluginsDir, zr.REGISTRY_MANIFEST_NAME), { force: true })
    const calls = { put: 0, notify: 0, backups: [] }
    const makeInternal = (db) => ({
      dbGet: async (key) => {
        if (key !== zr.ZTOOLS_REGISTRY_KEY) return null
        if (db.denied) throw new Error('API "internal:db-get" 仅限内置插件调用')
        return db.records
      },
      dbPut: async (key, value) => {
        if (db.denied) throw new Error('API "internal:db-put" 仅限内置插件调用')
        calls.put++
        db.records = value
        return { ok: true }
      },
      notifyChanged: async () => {
        calls.notify++
      },
    })
    const db = { records: [alphaRec, betaRec], denied: false }
    const deps = {
      internal: makeInternal(db),
      backup: (records) => calls.backups.push(records.map((r) => r.name)),
      readJsonSafe: (p) => {
        try {
          return JSON.parse(fs.readFileSync(p, 'utf-8'))
        } catch {
          return null
        }
      },
    }
    const readManifest = () => {
      try {
        return fs.readFileSync(path.join(pluginsDir, zr.REGISTRY_MANIFEST_NAME), 'utf-8')
      } catch {
        return null
      }
    }

    // 场景 A 引导：注册表有实体、盘上无 manifest → 写出初始 manifest（无注册表写入）
    const rA = await zr.reconcileCore(pluginsDir, deps)
    const manifestA = readManifest()
    check(
      'ZR7-A bootstrap writes initial manifest without touching registry',
      rA.status === 'ok' && rA.wroteManifest === true && rA.adopted.length === 0 && calls.put === 0 && calls.notify === 0 &&
        JSON.parse(manifestA).records.map((r) => r.name).join(',') === 'alpha,beta',
      JSON.stringify(rA)
    )

    // 场景 B 采纳：他机 manifest 带来 gamma（实体已在盘上）与 theta（实体未到）
    await fsp.mkdir(path.join(pluginsDir, 'gamma'), { recursive: true })
    await fsp.writeFile(path.join(pluginsDir, 'gamma', 'plugin.json'), JSON.stringify({ name: 'gamma', title: 'Gamma', version: '0.1.0' }))
    await fsp.writeFile(
      path.join(pluginsDir, zr.REGISTRY_MANIFEST_NAME),
      JSON.stringify({
        version: 1,
        records: [
          { name: 'gamma', entity: 'gamma', title: 'Gamma', version: '0.1.0', installedAt: '2026-02-01T00:00:00.000Z' },
          { name: 'theta', entity: 'theta', title: 'Theta' },
        ],
      })
    )
    const rB = await zr.reconcileCore(pluginsDir, deps)
    const gammaRec2 = db.records.find((r) => r.name === 'gamma')
    check(
      'ZR7-B adopts manifest record with existing entity and notifies host',
      rB.status === 'ok' && JSON.stringify(rB.adopted) === JSON.stringify(['gamma']) && calls.put === 1 && calls.notify === 1 &&
        gammaRec2.path === path.join(pluginsDir, 'gamma') && gammaRec2.installedAt === '2026-02-01T00:00:00.000Z' &&
        !db.records.some((r) => r.name === 'theta'),
      JSON.stringify({ rB, gamma: gammaRec2 })
    )
    // 重写保留在途记录（theta 实体未到也不从 manifest 丢失）
    const manifestB = JSON.parse(readManifest())
    check(
      'ZR7-Bb rewrite preserves in-flight manifest records',
      manifestB.records.map((r) => r.name).join(',') === 'alpha,beta,gamma,theta',
      JSON.stringify(manifestB.records.map((r) => r.name))
    )

    // 场景 G 幂等：无变化再跑 → noop、零写入、manifest 字节不变
    const beforeG = readManifest()
    const rG = await zr.reconcileCore(pluginsDir, deps)
    check(
      'ZR7-G no-change rerun is a noop with zero writes',
      rG.status === 'noop' && rG.wroteManifest === false && calls.put === 1 && readManifest() === beforeG,
      JSON.stringify(rG)
    )

    // 场景 C 未授权：dbGet 被宿主拒绝 → denied，不产生任何写入
    db.denied = true
    const rC = await zr.reconcileCore(pluginsDir, deps)
    db.denied = false
    check(
      'ZR7-C denied access degrades without writes',
      rC.status === 'denied' && typeof rC.error === 'string' && calls.put === 1 && readManifest() === beforeG,
      JSON.stringify(rC)
    )

    // 场景 D 旧宿主：internal 端口缺失 → unavailable
    const rD = await zr.reconcileCore(pluginsDir, { ...deps, internal: null })
    check('ZR7-D missing internal port reports unavailable', rD.status === 'unavailable' && calls.put === 1, JSON.stringify(rD))

    // 场景 E 幽灵两轮核验：实体缺位的记录首轮只标记（零写入），次轮才移除并触发写回
    db.records = [...db.records, { name: 'ghost3', path: path.join(pluginsDir, 'ghost3'), isDevelopment: false }]
    const rE1 = await zr.reconcileCore(pluginsDir, deps)
    const putAfterE1 = calls.put
    const rE2 = await zr.reconcileCore(pluginsDir, deps)
    check(
      'ZR7-E ghost record is marked first round and removed the next',
      rE1.status === 'noop' && rE1.removed.length === 0 && putAfterE1 === 1 &&
        rE2.status === 'ok' && JSON.stringify(rE2.removed) === JSON.stringify(['ghost3']) && calls.put === 2 && calls.notify === 2 &&
        !db.records.some((r) => r.name === 'ghost3'),
      JSON.stringify({ rE1, rE2, putAfterE1, put: calls.put, notify: calls.notify, names: db.records.map((r) => r.name) })
    )

    // 场景 F 版本冻结：盘上 manifest 版本更新（99）→ 不采纳不重写（防止旧插件降级覆盖）
    const foreignText = JSON.stringify({ version: 99, records: [{ name: 'future', entity: 'future' }] })
    await fsp.writeFile(path.join(pluginsDir, zr.REGISTRY_MANIFEST_NAME), foreignText)
    const rF = await zr.reconcileCore(pluginsDir, deps)
    check(
      'ZR7-F foreign newer manifest version is frozen (no adopt, no rewrite)',
      rF.status === 'noop' && rF.wroteManifest === false && !db.records.some((r) => r.name === 'future') && readManifest() === foreignText,
      JSON.stringify(rF)
    )

    // 备份钩子：只在注册表确有写回时触发（B 与 E 第二轮共两次），且携带写回前旧
    // 记录（E2 的旧状态里 ghost3 尚在 —— 备份的就是写回前事实）
    check(
      'ZR7-backup runs only before real registry writes',
      calls.backups.length === 2 && calls.backups[0].join(',') === 'alpha,beta' && calls.backups[1].join(',') === 'alpha,beta,gamma,ghost3',
      JSON.stringify(calls.backups)
    )
  } finally {
    await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`zr-unit: ${results.length - failed.length}/${results.length} passed`)
  if (failed.length) {
    throw new Error('注册表对账单元测试失败：\n' + failed.map((r) => `  ❌ ${r.name}`).join('\n'))
  }
})

/**
 * 权限闸单元（ZR8，独立用例）：对接宿主「高级权限」体系 ——
 * ztools.getInternalApiPermissions / requestInternalApiPermissions + 按通道授权
 *（internal:db-get 等）。覆盖：完全授权直通、缺失自动申请（pending）、待审申请
 * 覆盖期内不重复提交、部分授权补申请剩余通道、批准后下一轮直通、申请失败降级、
 * 旧宿主（无查询通道）回退直接探测路径。
 */
test('ZTools 注册表对账权限闸单元（ZR8，强顺序链）', async () => {
  const pluginsDir = path.join(TMP, 'plugins-perm')
  try {
    zr.__resetRegistryStateForTest()
    await fsp.mkdir(path.join(pluginsDir, 'alpha'), { recursive: true })
    await fsp.writeFile(path.join(pluginsDir, 'alpha', 'plugin.json'), JSON.stringify({ name: 'alpha', title: 'Alpha', version: '1.0.0' }))
    const alphaRec = {
      name: 'alpha', title: 'Alpha', version: '1.0.0', path: path.join(pluginsDir, 'alpha'),
      storageKind: 'directory', isDevelopment: false, installedAt: '2026-01-01T00:00:00.000Z',
    }

    const CH = zr.REQUIRED_INTERNAL_CHANNELS
    check(
      'ZR8-0 required channels are exactly the three the plugin needs',
      CH.length === 3 && CH.includes('internal:db-get') && CH.includes('internal:db-put') && CH.includes('internal:notify-plugins-changed'),
      JSON.stringify(CH)
    )

    const calls = { put: 0, notify: 0, gets: 0, requests: [] }
    const makeDb = (records) => ({ records, denied: false })
    const makeInternal = (db) => ({
      dbGet: async () => {
        calls.gets++
        if (db.denied) throw new Error('API "internal:db-get" 仅限内置插件调用')
        return db.records
      },
      dbPut: async (_key, value) => {
        calls.put++
        db.records = value
        return { ok: true }
      },
      notifyChanged: async () => {
        calls.notify++
      },
    })
    const makePerms = (status, reply) => ({
      getStatus: async () => {
        if (status.throwIt) throw new Error('boom')
        return status.value
      },
      request: async (apis, reason) => {
        calls.requests.push({ apis, reason })
        return reply(apis, reason)
      },
    })
    const db = makeDb([alphaRec])
    const depsBase = () => ({ internal: makeInternal(db), backup: () => {} })

    // ZR8a 完全授权（fullAccess）：跳过申请直通对账
    calls.requests.length = 0
    let r = await zr.reconcileCore(pluginsDir, { ...depsBase(), permissions: makePerms({ value: { fullAccess: true, granted: [], pending: [] } }, () => ({ success: false })) })
    check(
      'ZR8a fullAccess proceeds without any request',
      r.status === 'ok' && r.wroteManifest === true && calls.requests.length === 0 && calls.put === 0,
      JSON.stringify({ r, requests: calls.requests.length })
    )

    // ZR8b 零授权：自动提交申请（通道与用途说明齐备），状态 pending、零注册表操作
    calls.requests.length = 0
    calls.gets = 0
    await fsp.rm(path.join(pluginsDir, zr.REGISTRY_MANIFEST_NAME), { force: true })
    r = await zr.reconcileCore(pluginsDir, { ...depsBase(), permissions: makePerms({ value: { fullAccess: false, granted: [], pending: [] } }, (apis, reason) => { return { success: true, status: 'pending', requestedApis: apis, reason } }) })
    check(
      'ZR8b missing channels auto-submit a request and reconcile reports pending',
      r.status === 'pending' && JSON.stringify(r.requested) === JSON.stringify([...CH]) && calls.requests.length === 1 &&
        typeof calls.requests[0].reason === 'string' && calls.requests[0].reason.length > 0 && calls.gets === 0 && calls.put === 0,
      JSON.stringify({ r, requests: calls.requests, gets: calls.gets, put: calls.put })
    )

    // ZR8c 待审申请已覆盖缺失集：不重复提交（宿主侧并集去重，避免每轮刷写）
    const reqCountBefore = calls.requests.length
    calls.gets = 0
    r = await zr.reconcileCore(pluginsDir, { ...depsBase(), permissions: makePerms({ value: { fullAccess: false, granted: [], pending: [...CH] } }, () => ({ success: true, status: 'pending' })) })
    check(
      'ZR8c pending-covered missing channels do not resubmit',
      r.status === 'pending' && calls.requests.length === reqCountBefore && calls.gets === 0,
      JSON.stringify({ r, requests: calls.requests.length })
    )

    // ZR8d 部分授权：只为剩余缺失通道补申请
    calls.requests.length = 0
    r = await zr.reconcileCore(pluginsDir, { ...depsBase(), permissions: makePerms({ value: { fullAccess: false, granted: ['internal:db-get'] }, pending: [] }, (apis) => ({ success: true, status: 'pending', requestedApis: apis })) })
    check(
      'ZR8d partial grant requests only the remaining channels',
      r.status === 'pending' && JSON.stringify(calls.requests[0].apis) === JSON.stringify(['internal:db-put', 'internal:notify-plugins-changed']),
      JSON.stringify({ r, requests: calls.requests })
    )

    // ZR8e 按通道授权齐备（无 fullAccess）：直通对账（授权实时生效的验收路径）
    calls.requests.length = 0
    r = await zr.reconcileCore(pluginsDir, { ...depsBase(), permissions: makePerms({ value: { fullAccess: false, granted: [...CH] }, pending: [] }, () => ({ success: false })) })
    check(
      'ZR8e all channels granted proceeds like full access',
      r.status === 'ok' && r.wroteManifest === true && calls.requests.length === 0 && calls.gets > 0,
      JSON.stringify({ r, requests: calls.requests.length })
    )

    // ZR8f 申请接口失败（success=false）：按 pending 记录原因（申请未入队列 →
    // 下一轮 pending 不再覆盖缺失集，自动重新提交 —— 重试语义自愈），零注册表操作
    calls.requests.length = 0
    calls.gets = 0
    await fsp.rm(path.join(pluginsDir, zr.REGISTRY_MANIFEST_NAME), { force: true })
    r = await zr.reconcileCore(pluginsDir, { ...depsBase(), permissions: makePerms({ value: { fullAccess: false, granted: [], pending: [] } }, () => ({ success: false, error: '宿主忙' })) })
    check(
      'ZR8f failed request reports pending with reason and retries next round',
      r.status === 'pending' && r.error === '宿主忙' && calls.gets === 0 && calls.requests.length === 1,
      JSON.stringify(r)
    )
    // 失败后下一轮必然重提（pending 未覆盖缺失集）
    r = await zr.reconcileCore(pluginsDir, { ...depsBase(), permissions: makePerms({ value: { fullAccess: false, granted: [], pending: [] } }, () => ({ success: true, status: 'pending' })) })
    check('ZR8f-b failed submission is resubmitted on the next round', r.status === 'pending' && calls.requests.length === 2, JSON.stringify({ r, requests: calls.requests.length }))

    // ZR8g 批准后（授权到位）：下一轮对账自动通过（申请通道不再被调用）
    calls.requests.length = 0
    r = await zr.reconcileCore(pluginsDir, { ...depsBase(), permissions: makePerms({ value: { fullAccess: false, granted: [...CH] }, pending: [] }, () => ({ success: false })) })
    check('ZR8g next round after approval passes the gate automatically', r.status === 'ok' && calls.requests.length === 0, JSON.stringify(r))

    // ZR8h 旧宿主（无权限查询通道）：回退直接探测 —— dbGet 正常即直通
    r = await zr.reconcileCore(pluginsDir, { ...depsBase() })
    check('ZR8h legacy host without permission port falls back to direct probe', r.status === 'noop' || r.status === 'ok', JSON.stringify(r))
  } finally {
    await fsp.rm(path.join(TMP, 'plugins-perm'), { recursive: true, force: true }).catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`zr-perm-unit: ${results.length - failed.length}/${results.length} passed`)
  if (failed.length) {
    throw new Error('权限闸单元测试失败：\n' + failed.map((r) => `  ❌ ${r.name}`).join('\n'))
  }
})
