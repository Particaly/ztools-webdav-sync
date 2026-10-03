/**
 * e2e 分片「head」：头部组（B2A-S / 基础与 watch / SAFE / P11-R / P13 / N1-N4 / D1 / M1 / M2-M3）。基础→watch 复用 /proj 基线；「基础」必须在空 ROOT 上首个运行（listDirs 断言根内容）
 * 由 test/sync-e2e.mjs 机械拆分（节体逐字保留）；每文件独立 dav-server / 端口 / 根目录，
 * vitest 按文件并行、文件内保持原节顺序。共享基建见 test/harness.mjs。
 * 日常回归：npm run test:fast（跳过 slow tag）；等待组单独回归：npm run test:slow。
 */
import { test, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setupShard, teardownShard, section, slowSection, check, sleep, isNoop, SP } from './harness.mjs'

const {
    HERE, ROOT, PORT, LOCAL, server, services, cfg, storeModule, BUILT, preloadPath,
    STORAGE_MAIN, STORAGE_A, STORAGE_B, STORAGE_C, STORAGE_D, switchDevice,
    baselineDirOf, setProfile, setMidair, freshStore, tmpLocal, syncP, settleStable, sweepCrashResidue, projDir,
    REQLOG, readReqlog, countReq, lastReqLine,
    DEPTHLOG, readDepthlog, countDepth, clearDepthFlags,
    setThrottle, waitForReqLine, waitAbortLine, runCancelRound, readWalOps, findTempResidue,
    PUP, setNetcut, setPartialPut, puBuf,
    SC_DB, SC_KEY, setSCConfig, createTestSched, makeFakeClock, waitReal, pumpUntil, readLeaderLock, writeLeaderLock,
  } = await setupShard({ shard: 'head', port: 5371 })

  const TRASH_DIR = path.join(os.tmpdir(), `wdsync-e2e-trash-${Date.now()}-${process.pid}`)
  fs.mkdirSync(TRASH_DIR, { recursive: true })
  const trashLog = []
  let trashFailNext = 0
  let trashMissing = false
  const installTrash = () => {
    if (trashMissing) {
      delete global.window.ztools
      return
    }
    global.window.ztools = {
      shellTrashItem: async (p) => {
        trashLog.push(p)
        if (trashFailNext > 0) {
          trashFailNext--
          throw new Error('EACCES: permission denied (injected trash failure)')
        }
        const dest = path.join(TRASH_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(p)}`)
        await fsp.rename(p, dest)
      },
    }
  }
  installTrash()

// SAFE 节写入、afterAll 清理（原 try 外声明）
let SAFE_LOCAL = null

  await section('B2A-S：计时器静态检查（node:timers only）', async () => {
    const bareTimerRe = /(?<![.\w$])(setTimeout|setInterval|clearTimeout|clearInterval)\s*\(/
    // 迁移窗口：源文件逐步 .js → .mts，两个扩展名都探测
    for (const name of ['services', 'store', 'scheduler']) {
      const p = ['.mts', '.js'].map((ext) => path.join(HERE, '..', 'src-ztools', 'preload', name + ext)).find((x) => fs.existsSync(x))
      if (!p) continue // 模块可能不存在；存在即查
      const src = fs.readFileSync(p, 'utf-8')
      const offending = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => bareTimerRe.test(l))
      check(`B2A-S ${path.basename(p)} has no bare global timer calls`, offending.length === 0, offending.slice(0, 3).map(([n, l]) => `L${n}: ${l.trim().slice(0, 70)}`).join(' | '))
    }
    if (BUILT) {
      const bundleSrc = fs.readFileSync(preloadPath, 'utf-8')
      const offending = bundleSrc.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => bareTimerRe.test(l))
      check('B2A-S built bundle has no bare global timer calls', offending.length === 0, offending.slice(0, 3).map(([n, l]) => `L${n}: ${l.trim().slice(0, 70)}`).join(' | '))
      check('B2A-S built bundle requires node:timers', /require\(["']node:timers["']\)/.test(bundleSrc))
    } else {
      check('B2A-S source mode: bundle check deferred to --built run', true)
    }
  })

  await section('基础：连接 / 列举 / 首次同步链路', async () => {
  // 3. 测试连接（扩展：返回值附带档位与能力摘要 —— 新增字段断言，原 ok 断言保留）
  const conn = await services.dav.testConnection(cfg)
  check('testConnection', conn.ok && conn.tier === 'A' && !!conn.capabilities, `latency=${conn.latencyMs}ms tier=${conn.tier} ${conn.error || ''}`)

  // 3.5 远端目录选择器：浅层列举直接子目录（根目录 / 子目录 / 不存在的路径）
  await fsp.mkdir(path.join(ROOT, 'docs', 'inner'), { recursive: true })
  await fsp.mkdir(path.join(ROOT, 'photos'), { recursive: true })
  await fsp.mkdir(path.join(ROOT, '我的文档'), { recursive: true })
  await fsp.mkdir(path.join(ROOT, '.hidden-dir'), { recursive: true })
  await fsp.writeFile(path.join(ROOT, 'docs', 'note.txt'), 'n')
  await fsp.writeFile(path.join(ROOT, 'root-file.txt'), 'r')
  const rootDirs = await services.dav.listDirs(cfg, '')
  const rootNames = rootDirs.map((d) => d.name).sort().join(',')
  check(
    'listDirs root lists visible dirs only',
    rootNames === 'docs,photos,我的文档' && rootDirs.every((d) => d.path.startsWith('/')),
    `${rootNames} ${JSON.stringify(rootDirs)}`
  )
  const docDirs = await services.dav.listDirs(cfg, '/docs')
  check(
    'listDirs subdir lists dirs not files',
    docDirs.length === 1 && docDirs[0].name === 'inner' && docDirs[0].path === '/docs/inner',
    JSON.stringify(docDirs)
  )
  let listDirsThrows = false
  try {
    await services.dav.listDirs(cfg, '/no-such-dir')
  } catch (_) {
    listDirsThrows = true
  }
  check('listDirs missing dir throws', listDirsThrows)

  // 4. 准备本地目录并首次同步（应上传 3 个文件）
  // （projDir 已提升到顶层：setup 节与 watch 节共用）
  await fsp.mkdir(path.join(LOCAL, 'sub'), { recursive: true })
  await fsp.writeFile(path.join(LOCAL, 'a.txt'), 'hello-a')
  await fsp.writeFile(path.join(LOCAL, 'b.md'), 'hello-b-longer-content')
  await fsp.writeFile(path.join(LOCAL, 'sub', 'c.txt'), 'hello-c')
  const sum1 = await services.sync.syncDirectory(cfg, projDir(), { ignoreHidden: true, concurrency: 4, conflictStrategy: 'ask' }, {})
  check('first sync uploads 3 files', sum1.uploaded === 3 && sum1.totalFiles === 3, JSON.stringify(sum1))
  check('remote file exists after upload', fs.existsSync(path.join(ROOT, 'proj', 'sub', 'c.txt')))
  check('baseline records 3 files with lhash', (await services.sync._internals.baselineSize(projDir())) === 3 && (await services.sync._internals.baselineEntry(projDir(), 'a.txt')).lhash != null)

  // 5. 无变更二次同步（应全部 keep）
  const sum2 = await services.sync.syncDirectory(cfg, projDir(), { ignoreHidden: true, concurrency: 4, conflictStrategy: 'ask' }, {})
  check('second sync is a no-op', sum2.uploaded === 0 && sum2.downloaded === 0, JSON.stringify(sum2))

  // 6. 远端变更 → 仅下载；下载后本地 mtime 与远端对齐（utimes，4.6），随后一轮 no-op
  const remoteB = path.join(ROOT, 'proj', 'b.md')
  await fsp.writeFile(remoteB, 'remote-edited-version-of-b')
  const sum3 = await services.sync.syncDirectory(cfg, projDir(), { ignoreHidden: true, concurrency: 4, conflictStrategy: 'ask' }, {})
  const localB = await fsp.readFile(path.join(LOCAL, 'b.md'), 'utf-8')
  check('remote change downloads', sum3.downloaded === 1 && localB === 'remote-edited-version-of-b', JSON.stringify(sum3))
  const stLocalB = await fsp.stat(path.join(LOCAL, 'b.md'))
  const stRemoteB = await fsp.stat(remoteB)
  check(
    'download aligns local mtime to remote (utimes)',
    Math.abs(stLocalB.mtimeMs - stRemoteB.mtimeMs) < 2500,
    `local=${stLocalB.mtimeMs} remote=${stRemoteB.mtimeMs}`
  )
  const sum3b = await services.sync.syncDirectory(cfg, projDir(), { ignoreHidden: true, concurrency: 4, conflictStrategy: 'ask' }, {})
  check('post-download round is a no-op', sum3b.uploaded === 0 && sum3b.downloaded === 0, JSON.stringify(sum3b))

  // 7. 同一文件双侧同时修改 → 冲突（策略 local：保留本地上传）
  await fsp.writeFile(path.join(LOCAL, 'a.txt'), 'local-edit-of-a')
  await fsp.writeFile(path.join(ROOT, 'proj', 'a.txt'), 'remote-edit-of-a')
  const sum4 = await services.sync.syncDirectory(cfg, projDir(), { ignoreHidden: true, concurrency: 4, conflictStrategy: 'local' }, {})
  check('conflict resolved as local uploads', sum4.conflicts === 1 && sum4.uploaded === 1, JSON.stringify(sum4))
  const remoteA = await fsp.readFile(path.join(ROOT, 'proj', 'a.txt'), 'utf-8')
  check('remote a.txt now holds local version', remoteA === 'local-edit-of-a')

  // 8. 同时保留：云端版本另存为 *.conflict.md
  await fsp.writeFile(path.join(LOCAL, 'b.md'), 'local-edit-2-of-b')
  await fsp.writeFile(remoteB, 'remote-edit-2-of-b')
  const sum5 = await services.sync.syncDirectory(cfg, projDir(), { ignoreHidden: true, concurrency: 4, conflictStrategy: 'both' }, {})
  check('keep-both creates conflict copy', sum5.conflicts === 1 && fs.existsSync(path.join(LOCAL, 'b.conflict.md')), JSON.stringify(sum5))
  const conflictCopy = await fsp.readFile(path.join(LOCAL, 'b.conflict.md'), 'utf-8')
  check('conflict copy holds remote version', conflictCopy === 'remote-edit-2-of-b')
  const ccEntry = await services.sync._internals.baselineEntry(projDir(), 'b.conflict.md')
  check('conflict copy recorded with conflictCopy flag', ccEntry != null && ccEntry.conflictCopy === true, JSON.stringify(ccEntry))

  // 9. 本地删除 → 远端删除（双向）
  await fsp.unlink(path.join(LOCAL, 'sub', 'c.txt'))
  const sum6 = await services.sync.syncDirectory(cfg, projDir(), { ignoreHidden: true, concurrency: 4, conflictStrategy: 'ask' }, {})
  check('local delete propagates to remote', sum6.deleted === 1 && !fs.existsSync(path.join(ROOT, 'proj', 'sub', 'c.txt')), JSON.stringify(sum6))
  check('deleted file dropped from baseline', (await services.sync._internals.baselineEntry(projDir(), 'sub/c.txt')) === null)

  // 10. 忽略隐藏文件：.env 不上传
  await fsp.writeFile(path.join(LOCAL, '.env'), 'secret')
  const sum7 = await services.sync.syncDirectory(cfg, projDir(), { ignoreHidden: true, concurrency: 4, conflictStrategy: 'ask' }, {})
  check('hidden file ignored', !fs.existsSync(path.join(ROOT, 'proj', '.env')), JSON.stringify(sum7))

  // 11. 仅下载模式：本地变更不上传（冲突按「保留云端」解决 → 重新下载远端版本）
  await fsp.writeFile(path.join(LOCAL, 'a.txt'), 'download-mode-local-edit')
  const sum8 = await services.sync.syncDirectory(cfg, { ...projDir(), mode: 'download' }, { ignoreHidden: true, concurrency: 4, conflictStrategy: 'remote' }, {})
  const remoteA2 = await fsp.readFile(path.join(ROOT, 'proj', 'a.txt'), 'utf-8')
  const localA2 = await fsp.readFile(path.join(LOCAL, 'a.txt'), 'utf-8')
  check(
    'download mode never uploads (conflict resolved to remote)',
    remoteA2 === 'local-edit-of-a' && localA2 === 'local-edit-of-a',
    JSON.stringify(sum8)
  )

  })

  // 12. 目录监听触发回调（独立成节：去抖静置 ~2.2s，可被 --fast 跳过）

  // [慢组登记原因] watcher 去抖需 2×~2s 真实静置，用例价值密度低
  await slowSection('基础：fs.watch 去抖回调 + dav.remove', 'watcher 去抖需 2×~2s 真实静置，用例价值密度低', async () => {
  // 自包含（原复用「基础」节的 LOCAL 与 /proj 基线；--tagsFilter slow 单独回归时
  // 基础（快组）被跳过会 ENOENT）—— 自建目录对，两条断言语义不变
  await freshStore('basewatch')
  const BW_LOCAL = await tmpLocal('basewatch')
  let watched = false
  services.fsx.watchDir('e2e', BW_LOCAL, () => {
    watched = true
  })
  await fsp.writeFile(path.join(BW_LOCAL, 'watch-trigger.txt'), 'x')
  // macOS FSEvents 在并行负载下可能迟送 / 合并丢事件（同目录连续写，W10 已知边界）：
  // 轮询等待去抖回调，过半窗口未触发则补写一次重触发 —— 断言语义是「watcher+去抖
  // 链路可用」，与单次事件必达无关
  let reTrig = 0
  const wStart = Date.now()
  while (!watched) {
    if (Date.now() - wStart > 8000) break
    if (reTrig === 0 && Date.now() - wStart > 3000) {
      reTrig++
      await fsp.writeFile(path.join(BW_LOCAL, 'watch-trigger.txt'), 'x2')
    }
    await sleep(100)
  }
  services.fsx.stopAllWatch()
  check('fs.watch triggers debounced callback', watched)

  // 13. 目录移除接口（own remote path，不再依赖 /proj 既有内容）
  await services.sync.syncDirectory(cfg, { id: 'bw', localPath: BW_LOCAL, remotePath: '/basewatch', mode: 'two-way' }, { ignoreHidden: true, concurrency: 4, conflictStrategy: 'ask' }, {})
  await services.dav.remove(cfg, '/basewatch/watch-trigger.txt')
  check('dav.remove works', !fs.existsSync(path.join(ROOT, 'basewatch', 'watch-trigger.txt')))
  await fsp.rm(BW_LOCAL, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(path.join(ROOT, 'basewatch'), { recursive: true, force: true }).catch(() => {})
  })

  // ============================================================
  // 同步安全场景（独立 /safe 目录）
  // ============================================================

  await section('SAFE：同步安全场景', async () => {
  SAFE_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-safe-${Date.now()}`)
  const safeDir = () => ({ id: 'safe', localPath: SAFE_LOCAL, remotePath: '/safe', mode: 'two-way' })
  const syncSafe = (mode, handlers, prefs) =>
    services.sync.syncDirectory(cfg, { ...safeDir(), mode: mode || 'two-way' }, prefs || SP, handlers || {})

  await fsp.mkdir(SAFE_LOCAL, { recursive: true })
  await fsp.writeFile(path.join(SAFE_LOCAL, 'a.txt'), 'safe-a-v1')
  await fsp.writeFile(path.join(SAFE_LOCAL, 'del.txt'), 'safe-del')

  // S1 首次同步
  const s1 = await syncSafe()
  check('S1 first sync uploads', s1.uploaded === 2 && s1.totalFiles === 2, JSON.stringify(s1))
  check('S1 baseline records both files', (await services.sync._internals.baselineSize(safeDir())) === 2)

  // S2 基线快照损坏 → 无基线保护模式：零删除、远端不被覆盖、冲突交由用户
  //（改写自旧的 S2「manifest 损坏」；损坏的是本机快照而非远端文件）
  const safeStoreDir = await baselineDirOf(safeDir())
  await services.storage.setRootForTest(STORAGE_MAIN) // 关闭缓存句柄，使损坏对下次加载可见
  fs.writeFileSync(path.join(safeStoreDir, 'snapshot.json'), '{"v":1,"files": BROKEN')
  await fsp.writeFile(path.join(SAFE_LOCAL, 'a.txt'), 'safe-a-v2-local-longer-content')
  await fsp.unlink(path.join(SAFE_LOCAL, 'del.txt'))
  let s2err = null
  let s2summary = null
  try {
    await syncSafe()
  } catch (e) {
    s2err = e
    s2summary = e.summary
  }
  check('S2 corrupt snapshot surfaces conflict error (baseline note is log-only now)', !!s2err && /冲突还没处理/.test(s2err.message), s2err && s2err.message)
  check('S2 corrupt snapshot blocks delete propagation', fs.existsSync(path.join(ROOT, 'safe', 'del.txt')))
  check('S2 corrupt snapshot blocks overwrite', (await fsp.readFile(path.join(ROOT, 'safe', 'a.txt'), 'utf-8')) === 'safe-a-v1')
  check(
    'S2 missing local file resurrected as new remote file (no-baseline semantics)',
    (await fsp.readFile(path.join(SAFE_LOCAL, 'del.txt'), 'utf-8').catch(() => 'MISSING')) === 'safe-del' && s2summary && s2summary.downloaded === 1,
    JSON.stringify(s2summary)
  )

  // S3 恢复：冲突按策略收敛，随后一轮 no-op（改写自旧 S4）
  const s3 = await syncSafe('two-way', {}, { ...SP, conflictStrategy: 'local' })
  check('S3 recovery converges via conflict strategy', s3.conflicts === 1 && s3.uploaded === 1, JSON.stringify(s3))
  check('S3 remote a.txt updated', (await fsp.readFile(path.join(ROOT, 'safe', 'a.txt'), 'utf-8')) === 'safe-a-v2-local-longer-content')
  const s3b = await syncSafe()
  check('S3 follow-up round is a no-op', s3b.uploaded === 0 && s3b.downloaded === 0 && s3b.conflicts === 0, JSON.stringify(s3b))

  // S4 单文件失败不阻塞其他文件：ok2.txt 成功并落基线；轮末以 error 上报失败清单
  //（改写自旧 S5「任一失败整轮放弃 + manifest 不变」：基线方案下成功结果不再回滚）
  await fsp.writeFile(path.join(SAFE_LOCAL, 'bad.failput.txt'), 'x')
  await fsp.writeFile(path.join(SAFE_LOCAL, 'ok2.txt'), 'ok2-content')
  let s4err = null
  let s4summary = null
  try {
    await syncSafe()
  } catch (e) {
    s4err = e
    s4summary = e.summary
  }
  check('S4 upload failure fails the round', !!s4err && /failput/.test(s4err.message), s4err && s4err.message)
  check('S4 other files still transferred', (await fsp.readFile(path.join(ROOT, 'safe', 'ok2.txt'), 'utf-8').catch(() => 'MISSING')) === 'ok2-content')
  check(
    'S4 succeeded file recorded in baseline (no re-upload next round)',
    (await services.sync._internals.baselineEntry(safeDir(), 'ok2.txt')) != null,
    JSON.stringify(s4summary)
  )
  await fsp.unlink(path.join(SAFE_LOCAL, 'bad.failput.txt'))
  const s4b = await syncSafe()
  check('S4 next round does not re-upload succeeded file', s4b.uploaded === 0 && s4b.downloaded === 0, JSON.stringify(s4b))

  // S5 冲突未解决（ask 且无回调）→ 该文件报错，两侧原状；基线保留旧条目
  await fsp.writeFile(path.join(SAFE_LOCAL, 'a.txt'), 'safe-a-v4-local-x')
  await fsp.writeFile(path.join(ROOT, 'safe', 'a.txt'), 'safe-a-v4-remote-y')
  let s5err = null
  try {
    await syncSafe()
  } catch (e) {
    s5err = e
  }
  check('S5 unresolved conflict fails the round', !!s5err && /冲突还没处理/.test(s5err.message), s5err && s5err.message)
  check(
    'S5 both versions intact',
    (await fsp.readFile(path.join(SAFE_LOCAL, 'a.txt'), 'utf-8')) === 'safe-a-v4-local-x' &&
      (await fsp.readFile(path.join(ROOT, 'safe', 'a.txt'), 'utf-8')) === 'safe-a-v4-remote-y'
  )
  check('S5 baseline keeps pre-conflict entry', (await services.sync._internals.baselineEntry(safeDir(), 'a.txt')) != null)

  // S6 冲突解决（local）→ 正常收敛
  const s6 = await syncSafe('two-way', {}, { ...SP, conflictStrategy: 'local' })
  check('S6 conflict resolved as local', s6.conflicts === 1 && s6.uploaded === 1, JSON.stringify(s6))
  check('S6 remote holds chosen version', (await fsp.readFile(path.join(ROOT, 'safe', 'a.txt'), 'utf-8')) === 'safe-a-v4-local-x')

  // S7 远端删除失败（.faildelete 注入 500）：基线条目保留，收敛后条目清除且不复活
  await fsp.writeFile(path.join(SAFE_LOCAL, 'gone.faildelete.txt'), 'bye')
  await syncSafe()
  await fsp.unlink(path.join(SAFE_LOCAL, 'gone.faildelete.txt'))
  let s7err = null
  try {
    await syncSafe()
  } catch (e) {
    s7err = e
  }
  check('S7 remote delete failure fails the round', !!s7err && /无法从云端删除/.test(s7err.message), s7err && s7err.message)
  check('S7 remote file still exists', fs.existsSync(path.join(ROOT, 'safe', 'gone.faildelete.txt')))
  check('S7 baseline retains entry', (await services.sync._internals.baselineEntry(safeDir(), 'gone.faildelete.txt')) != null)
  // 收敛：移除远端文件后两侧皆无 → clean 丢弃条目，且不得把远端删除当成「新文件」下载回来
  //（force：上一条 check 失败时文件可能已被移除，此处 rm 不得因 ENOENT 中止整个 runner）
  await fsp.rm(path.join(ROOT, 'safe', 'gone.faildelete.txt'), { force: true })
  const s7b = await syncSafe()
  check('S7 clean after manual remote removal (no resurrection)', s7b.downloaded === 0 && (await services.sync._internals.baselineEntry(safeDir(), 'gone.faildelete.txt')) === null, JSON.stringify(s7b))

  // S8 本地删除失败（win32：icacls 拒绝删除权限）→ 报错且基线保留
  if (process.platform === 'win32') {
    await fsp.writeFile(path.join(SAFE_LOCAL, 'keepme.txt'), 'keepme')
    await syncSafe()
    await fsp.rm(path.join(ROOT, 'safe', 'keepme.txt'))
    const deny = spawnSync('icacls', [path.join(SAFE_LOCAL, 'keepme.txt'), '/deny', '*S-1-1-0:(D)'])
    if (deny.status === 0) {
      let s8err = null
      try {
        await syncSafe()
      } catch (e) {
        s8err = e
      }
      check('S8 local delete failure fails the round', !!s8err && /无法删除/.test(s8err.message), s8err && s8err.message)
      check('S8 local file still present', fs.existsSync(path.join(SAFE_LOCAL, 'keepme.txt')))
      check('S8 baseline retains entry', (await services.sync._internals.baselineEntry(safeDir(), 'keepme.txt')) != null)
      spawnSync('icacls', [path.join(SAFE_LOCAL, 'keepme.txt'), '/reset'])
      const s8b = await syncSafe()
      check('S8 delete succeeds after acl reset', s8b.deleted >= 1, JSON.stringify(s8b))
      check('S8 local file removed', !fs.existsSync(path.join(SAFE_LOCAL, 'keepme.txt')))
    } else {
      check('S8 icacls unavailable, scenario skipped', true)
    }
  }

  // S9 下载守卫直检：目标与计划指纹不符时拒绝覆盖用户内容
  await fsp.writeFile(path.join(ROOT, 'safe', 'rg.txt'), 'REMOTE-VERSION')
  const localRg = path.join(SAFE_LOCAL, 'rg.txt')
  await fsp.writeFile(localRg, 'LOCAL-CURRENT')
  let g1err = null
  try {
    await services.sync._internals.downloadOne(cfg, safeDir(), 'rg.txt', SAFE_LOCAL, null, {
      expectedLocal: { size: 999, mtimeMs: 1 },
    })
  } catch (e) {
    g1err = e
  }
  check('S9 download guard rejects changed target', !!g1err && /未下载/.test(g1err.message), g1err && g1err.message)
  check('S9 user content preserved', (await fsp.readFile(localRg, 'utf-8')) === 'LOCAL-CURRENT')
  const stRg = await fsp.stat(localRg)
  const g2 = await services.sync._internals.downloadOne(cfg, safeDir(), 'rg.txt', SAFE_LOCAL, null, {
    expectedLocal: { size: stRg.size, mtimeMs: stRg.mtimeMs },
    expectedRemoteSize: 'REMOTE-VERSION'.length,
  })
  check(
    'S9 matching guard downloads and replaces',
    g2.size === 'REMOTE-VERSION'.length && (await fsp.readFile(localRg, 'utf-8')) === 'REMOTE-VERSION',
    JSON.stringify(g2)
  )

  // S10 状态机直检：decideAction 三模式真值表（基线条目字段 lsize/lmtimeMs）
  const D = services.sync._internals.decideAction
  const L = { abs: 'x', size: 1, mtimeMs: 1000 }
  const R = { isDir: false, size: 1, mtimeMs: 1000, etag: 'e' }
  const M = { lsize: 1, lmtimeMs: 1000, lhash: 'h', rsize: 1, rmtimeMs: 1000, retag: 'e' }
  const table = [
    [null, null, null, 'two-way', 'skip'],
    [null, null, M, 'two-way', 'clean'],
    [L, null, null, 'two-way', 'upload'],
    [L, null, M, 'two-way', 'delete-local'],
    [L, null, M, 'upload', 'upload'],
    [L, null, M, 'download', 'delete-local'],
    [null, R, null, 'two-way', 'download'],
    [null, R, M, 'two-way', 'delete-remote'],
    [null, R, M, 'upload', 'delete-remote'],
    [null, R, M, 'download', 'download'],
    [L, R, M, 'two-way', 'keep'],
    [{ ...L, size: 2 }, R, M, 'two-way', 'upload'],
    [{ ...L, size: 2 }, R, M, 'download', 'conflict'],
    [L, { ...R, size: 2 }, M, 'two-way', 'download'],
    [L, { ...R, size: 2 }, M, 'upload', 'conflict'],
    [{ ...L, size: 2 }, { ...R, size: 2 }, M, 'two-way', 'conflict'],
    [L, R, { ...M, conflictCopy: true }, 'two-way', 'keep'],
    // 无基线 + 两侧都在：newBoth 注入决定（4.2）
    [L, R, null, 'two-way', 'keep'],
    [L, R, null, 'upload', 'keep'],
    [L, R, null, 'download', 'keep'],
    // 无基线 + 仅一侧存在：视为新增，任何模式不产生 delete-*
    [L, null, null, 'download', 'upload'],
    [null, R, null, 'upload', 'download'],
  ]
  const flagOf = (l, r, m) => (m == null && l && r ? { newBoth: 'adopt' } : undefined)
  const badRows = table.filter(([l, r, m, mode, want]) => D('f', l, r, m, mode, flagOf(l, r, m)).act !== want)
  check(
    'S10 decideAction truth table',
    badRows.length === 0,
    badRows.map(([l, r, m, mode, want]) => `${want} != ${D('f', l, r, m, mode, flagOf(l, r, m)).act}`).join('; ')
  )
  check(
    'S10 newBoth flags decide adopt vs conflict',
    D('f', L, R, null, 'two-way', { newBoth: 'adopt' }).act === 'keep' && D('f', L, R, null, 'two-way', { newBoth: 'conflict' }).act === 'conflict'
  )

  // S11 扫描状态直检：缺失子树必须报告「不完整」（删除传播的前置闸门）
  const miss = await services.sync._internals.listRemoteSafe(cfg, '/safe/no-such-sub', true)
  check('S11 missing remote subtree reported incomplete', miss.complete === false && miss.errors.length === 1, JSON.stringify(miss.errors))

  // S12 条件 PUT 原始语义（服务器能力验证，改用普通文件；引擎自身不再使用 If-Match）
  // 注：用 agent:false 的一次性连接，避免 fetch/undici 的 keep-alive 句柄影响进程退出
  const rawReq = (method, headers, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: PORT, path: '/dav/safe/cond.txt', method, headers, agent: false },
        resolve
      )
      req.on('error', reject)
      if (body != null) req.end(body)
      else req.end()
    })
  await rawReq('PUT', {}, 'cond-body-v1')
  const mres = await rawReq('GET', {})
  const etag = mres.headers.etag || ''
  const r1 = await rawReq('PUT', { 'If-Match': '"stale-etag"' }, 'cond-body-v2')
  const r2 = await rawReq('PUT', { 'If-Match': etag }, 'cond-body-v2')
  const r3 = await rawReq('PUT', { 'If-None-Match': '*' }, 'cond-body-v3')
  check(
    'S12 conditional PUT semantics',
    r1.statusCode === 412 && (r2.statusCode === 201 || r2.statusCode === 204) && r3.statusCode === 412,
    `${r1.statusCode}/${r2.statusCode}/${r3.statusCode}`
  )

  // S13 网络不可达 → 同步在扫描前失败，不产生任何动作
  const badCfg = { ...cfg, serverUrl: 'http://127.0.0.1:1/dav/' }
  let s13err = null
  try {
    await services.sync.syncDirectory(badCfg, safeDir(), SP, {})
  } catch (e) {
    s13err = e
  }
  check('S13 network down fails before any action', !!s13err, s13err && s13err.message)

  })

  // ============================================================
  // P11-R：WAL 意图恢复（改写自旧 P11 暂存日志套件；3.5 崩溃安全）
  // afterTransferOp 在「操作成功、基线未写」处抛错 = 模拟进程崩溃
  // ============================================================

  // [慢组登记原因] 14+ 轮同步 × 每轮租约锁 1.5s 静置的崩溃马拉松；WAL 采纳关键路径仍由 BV3 覆盖
  await slowSection('P11-R：WAL 意图恢复', '14+ 轮同步 × 每轮租约锁 1.5s 静置的崩溃马拉松；WAL 采纳关键路径仍由 BV3 覆盖', async () => {
  const P11_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-p11r-${Date.now()}`)
  const p11Dir = () => ({ id: 'p11r', localPath: P11_LOCAL, remotePath: '/p11r', mode: 'two-way' })
  const syncP11 = (handlers, prefs) => services.sync.syncDirectory(cfg, p11Dir(), prefs || SP, handlers || {})
  const crashAfter = (rel, act) => ({
    afterTransferOp: async (p) => {
      if (p.rel === rel && (!act || p.act === act || p.act.startsWith(act))) throw new Error('SIMULATED-CRASH')
    },
  })
  await fsp.mkdir(P11_LOCAL, { recursive: true })
  await fsp.writeFile(path.join(P11_LOCAL, 'a.txt'), 'p11-a-v1')

  // R1 上传成功与基线写入之间崩溃 → 下一轮恢复采纳：无重传、无冲突、无弹窗
  let r1err = null
  try {
    await syncP11(crashAfter('a.txt', 'upload'))
  } catch (e) {
    r1err = e
  }
  check('R1 crash after upload fails the round', !!r1err && /SIMULATED-CRASH/.test(r1err.message), r1err && r1err.message)
  check('R1 crash residue: leaked lease renew timer swept exactly once (write round)', sweepCrashResidue() === 1 && sweepCrashResidue() === 0, 'sweep must clear 1 then 0')
  check('R1 remote upload did happen', (await fsp.readFile(path.join(ROOT, 'p11r', 'a.txt'), 'utf-8')) === 'p11-a-v1')
  check('R1 baseline not yet written', (await services.sync._internals.baselineEntry(p11Dir(), 'a.txt')) === null)
  const r1b = await syncP11()
  check('R1 next round adopts via WAL (no re-upload, no conflict)', r1b.uploaded === 0 && r1b.downloaded === 0 && r1b.conflicts === 0, JSON.stringify(r1b))
  const r1Entry = await services.sync._internals.baselineEntry(p11Dir(), 'a.txt')
  check('R1 adopted entry carries lhash', r1Entry != null && r1Entry.lhash != null, JSON.stringify(r1Entry))
  const r1c = await syncP11()
  check('R1 follow-up round is a no-op', r1c.uploaded === 0 && r1c.downloaded === 0, JSON.stringify(r1c))

  // R2 下载成功与基线写入之间崩溃 → 下一轮恢复采纳（文件已在本地、不重复下载）
  await fsp.writeFile(path.join(ROOT, 'p11r', 'd.txt'), 'p11-d-from-remote')
  let r2err = null
  try {
    await syncP11(crashAfter('d.txt', 'download'))
  } catch (e) {
    r2err = e
  }
  check('R2 crash after download fails the round', !!r2err && /SIMULATED-CRASH/.test(r2err.message), r2err && r2err.message)
  check('R2 crash residue: no leaked timer (download-only round takes no lease)', sweepCrashResidue() === 0)
  check('R2 file already landed locally', (await fsp.readFile(path.join(P11_LOCAL, 'd.txt'), 'utf-8')) === 'p11-d-from-remote')
  const r2b = await syncP11()
  check('R2 next round adopts via WAL (no re-download)', r2b.downloaded === 0 && r2b.conflicts === 0, JSON.stringify(r2b))
  const r2c = await syncP11()
  check('R2 follow-up round is a no-op', r2c.downloaded === 0 && r2c.uploaded === 0, JSON.stringify(r2c))

  // R3 远端删除成功与基线写入之间崩溃 → 下一轮按旧基线重推导（clean），不复活
  await fsp.writeFile(path.join(P11_LOCAL, 'e.txt'), 'p11-e')
  await syncP11()
  await fsp.unlink(path.join(P11_LOCAL, 'e.txt'))
  let r3err = null
  try {
    await syncP11(crashAfter('e.txt', 'delete-remote'))
  } catch (e) {
    r3err = e
  }
  check('R3 crash after remote delete fails the round', !!r3err && /SIMULATED-CRASH/.test(r3err.message), r3err && r3err.message)
  check('R3 crash residue: leaked lease renew timer swept (delete-remote write round)', sweepCrashResidue() === 1)
  check('R3 remote file already gone', !fs.existsSync(path.join(ROOT, 'p11r', 'e.txt')))
  const r3b = await syncP11()
  check('R3 next round cleans up without resurrection', r3b.downloaded === 0 && (await services.sync._internals.baselineEntry(p11Dir(), 'e.txt')) === null, JSON.stringify(r3b))

  // R4 远端删除传播（delete-local）成功与基线写入之间崩溃 → 下一轮按旧基线重推导后 clean，不复活
  await fsp.writeFile(path.join(P11_LOCAL, 'f.txt'), 'p11-f')
  await syncP11()
  await fsp.rm(path.join(ROOT, 'p11r', 'f.txt')) // 仅删远端：本地未变 → delete-local 传播
  let r4err = null
  try {
    await syncP11(crashAfter('f.txt', 'delete-local'))
  } catch (e) {
    r4err = e
  }
  check('R4 crash after local delete fails the round', !!r4err && /SIMULATED-CRASH/.test(r4err.message), r4err && r4err.message)
  check('R4 crash residue: no leaked timer (delete-local round takes no lease)', sweepCrashResidue() === 0)
  check('R4 local file already removed', !fs.existsSync(path.join(P11_LOCAL, 'f.txt')))
  const r4b = await syncP11()
  check('R4 next round re-derives and cleans entry', r4b.downloaded === 0 && (await services.sync._internals.baselineEntry(p11Dir(), 'f.txt')) === null, JSON.stringify(r4b))

  // R5 操作失败（failput）→ 意图被放弃；移除故障后按正常规划重试成功
  await fsp.writeFile(path.join(P11_LOCAL, 'badR5.failput.txt'), 'x')
  let r5err = null
  try {
    await syncP11()
  } catch (e) {
    r5err = e
  }
  check('R5 failed op fails the round', !!r5err && /failput/.test(r5err.message), r5err && r5err.message)
  await fsp.unlink(path.join(P11_LOCAL, 'badR5.failput.txt'))
  const r5b = await syncP11()
  check('R5 retry after recovery uploads normally', r5b.uploaded === 0 && r5b.conflicts === 0, JSON.stringify(r5b))
  await fsp.rm(P11_LOCAL, { recursive: true, force: true }).catch(() => {})

  })

  // ============================================================
  // P13 临时文件隔离 + 崩溃残留清理（独立 /p13 目录，ignoreHidden=false）
  // ============================================================

  await section('P13：临时文件隔离', async () => {
  const P13_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-p13-${Date.now()}`)
  const p13Prefs = { ...SP, ignoreHidden: false }
  const p13Dir = () => ({ id: 'p13', localPath: P13_LOCAL, remotePath: '/p13', mode: 'two-way' })
  await fsp.mkdir(path.join(P13_LOCAL, 'sub'), { recursive: true })
  await fsp.writeFile(path.join(P13_LOCAL, 'real.txt'), 'p13-real')
  await fsp.writeFile(path.join(P13_LOCAL, '.wdsync-dl-residual'), 'residual-root')
  await fsp.writeFile(path.join(P13_LOCAL, 'sub', '.wdsync-dl-nested'), 'residual-nested')
  const p13first = await services.sync.syncDirectory(cfg, p13Dir(), p13Prefs, {})
  check('P13 temp files never synced even with ignoreHidden=false', p13first.uploaded === 1 && p13first.totalFiles === 1, JSON.stringify(p13first))
  check('P13 temp files absent from remote', !fs.existsSync(path.join(ROOT, 'p13', '.wdsync-dl-residual')) && !fs.existsSync(path.join(ROOT, 'p13', 'sub')))
  check('P13 temp files absent from baseline', (await services.sync._internals.baselineSize(p13Dir())) === 1)
  // 崩溃残留清理：陈旧临时文件被启动期清理回收，新鲜（可能活跃）的保留
  const staleTmp = path.join(P13_LOCAL, '.wdsync-dl-stale')
  await fsp.writeFile(staleTmp, 'stale')
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await fsp.utimes(staleTmp, twoHoursAgo, twoHoursAgo)
  await fsp.writeFile(path.join(P13_LOCAL, '.wdsync-tmp-fresh'), 'fresh')
  await services.sync.syncDirectory(cfg, p13Dir(), p13Prefs, {})
  check('P13 stale orphan temp cleaned at startup', !fs.existsSync(staleTmp))
  check('P13 fresh temp kept', fs.existsSync(path.join(P13_LOCAL, '.wdsync-tmp-fresh')))
  // 下载生命周期：远端新文件经临时文件落地的正式文件内容正确，且不留临时残留
  await fsp.utimes(path.join(P13_LOCAL, '.wdsync-dl-residual'), twoHoursAgo, twoHoursAgo)
  await fsp.writeFile(path.join(ROOT, 'p13', 'from-remote.txt'), 'remote-content')
  await services.sync.syncDirectory(cfg, p13Dir(), p13Prefs, {})
  check('P13 download via temp file lands correctly', (await fsp.readFile(path.join(P13_LOCAL, 'from-remote.txt'), 'utf-8')) === 'remote-content')
  const tmpLeft = (await fsp.readdir(P13_LOCAL)).filter((n) => n.startsWith('.wdsync-dl-') || n.startsWith('.wdsync-tmp-') || n.startsWith('.wdsync-verify-'))
  check('P13 no temp residue after downloads', tmpLeft.length === 1 && tmpLeft[0] === '.wdsync-tmp-fresh', JSON.stringify(tmpLeft))
  check(
    'P13 isSyncTempName contract',
    services.sync._internals.isSyncTempName('.wdsync-dl-x') &&
      services.sync._internals.isSyncTempName('.wdsync-tmp-y') &&
      services.sync._internals.isSyncTempName('.wdsync-verify-z') &&
      // 能力探测文件前缀同样被扫描排除（探测文件放远端根目录，不得干扰同步）
      services.sync._internals.isSyncTempName('.wdsync-probe-w') &&
      !services.sync._internals.isSyncTempName('user-file.wdsync-dl-x') &&
      !services.sync._internals.isSyncTempName('real.txt')
  )
  await fsp.rm(P13_LOCAL, { recursive: true, force: true }).catch(() => {})

  })

  // ============================================================
  // N 系列：决策语义
  // ============================================================

  await section('N1/N2：touch 消歧 / 双侧同改 adopt', async () => {
  // N1 本地 touch（mtime 变化、内容不变）→ hash 消歧不产生上传，基线 mtime 静默刷新
  const N1_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-n1-${Date.now()}`)
  const n1Dir = () => ({ id: 'n1', localPath: N1_LOCAL, remotePath: '/n1', mode: 'two-way' })
  await fsp.mkdir(N1_LOCAL, { recursive: true })
  await fsp.writeFile(path.join(N1_LOCAL, 'a.txt'), 'n1-content')
  await services.sync.syncDirectory(cfg, n1Dir(), SP, {})
  const n1Touch = new Date(Date.now() + 10000)
  await fsp.utimes(path.join(N1_LOCAL, 'a.txt'), n1Touch, n1Touch)
  const n1b = await services.sync.syncDirectory(cfg, n1Dir(), SP, {})
  check('N1 local touch does not re-upload', n1b.uploaded === 0 && n1b.downloaded === 0, JSON.stringify(n1b))
  const n1Entry = await services.sync._internals.baselineEntry(n1Dir(), 'a.txt')
  check('N1 baseline mtime silently refreshed', n1Entry != null && Math.abs(n1Entry.lmtimeMs - n1Touch.getTime()) < 1500, JSON.stringify(n1Entry))
  await fsp.rm(N1_LOCAL, { recursive: true, force: true }).catch(() => {})

  // N2 双侧都改为相同内容（等长覆写）→ 内容相同 adopt，不算冲突、不传输
  // 注：mtime 用 utimes 显式拉开到容差外，避免重写时间落在容差内被当作「本地未变」
  const N2_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-n2-${Date.now()}`)
  const n2Dir = () => ({ id: 'n2', localPath: N2_LOCAL, remotePath: '/n2', mode: 'two-way' })
  await fsp.mkdir(N2_LOCAL, { recursive: true })
  await fsp.writeFile(path.join(N2_LOCAL, 'same.txt'), 'AAAAAAAAAA')
  await services.sync.syncDirectory(cfg, n2Dir(), SP, {})
  await fsp.writeFile(path.join(N2_LOCAL, 'same.txt'), 'BBBBBBBBBB') // 等长新内容
  const n2Shift = new Date(Date.now() + 15000)
  await fsp.utimes(path.join(N2_LOCAL, 'same.txt'), n2Shift, n2Shift)
  await fsp.writeFile(path.join(ROOT, 'n2', 'same.txt'), 'BBBBBBBBBB') // 双侧相同的新内容
  const n2b = await services.sync.syncDirectory(cfg, n2Dir(), SP, {})
  check('N2 identical edits on both sides adopt without transfer', n2b.uploaded === 0 && n2b.downloaded === 0 && n2b.conflicts === 0 && n2b.adopted === 1, JSON.stringify(n2b))
  const n2c = await services.sync.syncDirectory(cfg, n2Dir(), SP, {})
  check('N2 follow-up round is a no-op', n2c.uploaded === 0 && n2c.downloaded === 0, JSON.stringify(n2c))
  await fsp.rm(N2_LOCAL, { recursive: true, force: true }).catch(() => {})

  })

  // N3 无 etag 服务器（.wdsync-test-noetag）：仅远端 mtime 变化 → hash 消歧采纳；

  await section('N3：无 etag 指纹噪声', async () => {
  // fingerprint-unstable 需至少 3 个「不同文件」各自出现指纹噪声才标记（4.4，
  // 编辑器自动保存反复 touch 单个文件不得误标），标记后给出 UI 提示
  const N3_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-n3-${Date.now()}`)
  const n3Dir = () => ({ id: 'n3', localPath: N3_LOCAL, remotePath: '/n3', mode: 'two-way' })
  fs.writeFileSync(path.join(ROOT, '.wdsync-test-noetag'), 'x')
  try {
    await fsp.mkdir(N3_LOCAL, { recursive: true })
    for (const n of ['x1.txt', 'x2.txt', 'x3.txt']) await fsp.writeFile(path.join(N3_LOCAL, n), 'n3-content')
    await services.sync.syncDirectory(cfg, n3Dir(), SP, {})
    const bump = async (name, deltaMs) => {
      const p = path.join(ROOT, 'n3', name)
      const t = new Date((await fsp.stat(p)).mtimeMs + deltaMs)
      await fsp.utimes(p, t, t)
    }
    // 单个文件反复出现指纹噪声（3 轮）：全部采纳、绝不标记
    for (let i = 0; i < 3; i++) {
      await bump('x1.txt', 30000)
      const r = await services.sync.syncDirectory(cfg, n3Dir(), SP, {})
      check(`N3 single-file noise round ${i + 1} adopted without marking`, r.downloaded === 0 && r.adopted === 1 && !r.warnings.some((w) => /指纹不稳定/.test(w)), JSON.stringify(r.warnings))
    }
    // 第 2、3 个不同文件各自出现噪声：第 3 个时标记 + 提示
    await bump('x2.txt', 30000)
    const n3b = await services.sync.syncDirectory(cfg, n3Dir(), SP, {})
    check('N3 second distinct file still not marked', n3b.downloaded === 0 && !n3b.warnings.some((w) => /指纹不稳定/.test(w)), JSON.stringify(n3b.warnings))
    await bump('x3.txt', 30000)
    const n3c = await services.sync.syncDirectory(cfg, n3Dir(), SP, {})
    check(
      'N3 third distinct file marks fingerprint-unstable (note is log-only now)',
      n3c.downloaded === 0 && n3c.adopted === 1 && !n3c.warnings.some((w) => /指纹/.test(w)),
      JSON.stringify(n3c.warnings)
    )
    await bump('x2.txt', 30000)
    const n3d = await services.sync.syncDirectory(cfg, n3Dir(), SP, {})
    check('N3 unstable server keeps converging without transfers', n3d.downloaded === 0 && n3d.adopted === 1, JSON.stringify(n3d))
  } finally {
    await fsp.rm(path.join(ROOT, '.wdsync-test-noetag'), { force: true }).catch(() => {})
  }
  await fsp.rm(N3_LOCAL, { recursive: true, force: true }).catch(() => {})

  })

  // D1 深度校验（4.5，默认关）：等长覆写且 mtime 还原 → 常规轮漏检（已知边界）；

  await section('D1：深度校验', async () => {
  // 开启后重算 hash 与基线比较可检出并上传；同周期内不重复重算
  const D1_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-d1-${Date.now()}`)
  const d1Dir = () => ({ id: 'd1v', localPath: D1_LOCAL, remotePath: '/d1v', mode: 'two-way' })
  await fsp.mkdir(D1_LOCAL, { recursive: true })
  await fsp.writeFile(path.join(D1_LOCAL, 'a.txt'), 'v1-content')
  await services.sync.syncDirectory(cfg, d1Dir(), SP, {})
  const stD1 = await fsp.stat(path.join(D1_LOCAL, 'a.txt'))
  await fsp.writeFile(path.join(D1_LOCAL, 'a.txt'), 'x1-content') // 等长覆写
  await fsp.utimes(path.join(D1_LOCAL, 'a.txt'), stD1.atime, stD1.mtime) // mtime 还原
  const d1a = await services.sync.syncDirectory(cfg, d1Dir(), SP, {})
  check('D1 deep-verify off misses equal-size restored-mtime edit', d1a.uploaded === 0, JSON.stringify(d1a))
  const d1b = await services.sync.syncDirectory(cfg, d1Dir(), { ...SP, deepVerify: true, deepVerifyDays: 7 }, {})
  check('D1 deep-verify detects and uploads the hidden edit', d1b.uploaded === 1 && (await fsp.readFile(path.join(ROOT, 'd1v', 'a.txt'), 'utf-8')) === 'x1-content', JSON.stringify(d1b))
  const d1c = await services.sync.syncDirectory(cfg, d1Dir(), { ...SP, deepVerify: true, deepVerifyDays: 7 }, {})
  check('D1 follow-up round is a no-op', d1c.uploaded === 0 && d1c.downloaded === 0, JSON.stringify(d1c))
  await fsp.rm(D1_LOCAL, { recursive: true, force: true }).catch(() => {})

  })

  // N4 首次同步的「应用到全部」冲突策略：首个冲突选择 applyToRemaining 后不再询问

  await section('N4：冲突应用到全部', async () => {
  const N4_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-n4-${Date.now()}`)
  const n4Dir = () => ({ id: 'n4', localPath: N4_LOCAL, remotePath: '/n4', mode: 'two-way' })
  await fsp.mkdir(N4_LOCAL, { recursive: true })
  await fsp.mkdir(path.join(ROOT, 'n4'), { recursive: true })
  for (const n of ['p.txt', 'q.txt', 'r.txt']) {
    await fsp.writeFile(path.join(N4_LOCAL, n), `local-${n}`)
    await fsp.writeFile(path.join(ROOT, 'n4', n), `remote-${n}`) // size 不同 → 冲突
  }
  await switchDevice(STORAGE_D)
  let n4Calls = 0
  const n4sum = await services.sync.syncDirectory(cfg, n4Dir(), SP, {
    onConflict: async () => {
      n4Calls++
      return { choice: 'local', applyToRemaining: true }
    },
  })
  check('N4 apply-to-all asks only once', n4Calls === 1, `calls=${n4Calls}`)
  check('N4 all conflicts resolved by the chosen strategy', n4sum.conflicts === 3 && n4sum.uploaded === 3, JSON.stringify(n4sum))
  check('N4 remote holds local versions', (await fsp.readFile(path.join(ROOT, 'n4', 'q.txt'), 'utf-8')) === 'local-q.txt')
  await fsp.rm(N4_LOCAL, { recursive: true, force: true }).catch(() => {})

  })

  // ============================================================
  // M 系列：多设备（两个 deviceId + 两个本地目录 + 同一远端）
  // ============================================================

  await section('M1：新设备加入', async () => {
  // M1 新设备加入：本地为空 → 零远端删除、全部下载（新引擎下的正向断言）
  const M1_A = path.join(os.tmpdir(), `wdsync-e2e-m1-a-${Date.now()}`)
  const M1_B = path.join(os.tmpdir(), `wdsync-e2e-m1-b-${Date.now()}`)
  const m1Dir = (local) => ({ id: 'm1', localPath: local, remotePath: '/m1', mode: 'two-way' })
  await fsp.mkdir(path.join(M1_A, 'sub'), { recursive: true })
  await fsp.writeFile(path.join(M1_A, 'a.txt'), 'm1-a')
  await fsp.writeFile(path.join(M1_A, 'b.txt'), 'm1-b')
  await fsp.writeFile(path.join(M1_A, 'sub', 'c.txt'), 'm1-c')
  await switchDevice(STORAGE_A)
  const m1a = await services.sync.syncDirectory(cfg, m1Dir(M1_A), SP, {})
  check('M1 device A first sync uploads', m1a.uploaded === 3, JSON.stringify(m1a))
  // 设备 B：本地为空目录，同步同一远端（复现点：新引擎必须零远端删除）
  await fsp.mkdir(M1_B, { recursive: true })
  await switchDevice(STORAGE_B)
  const m1b = await services.sync.syncDirectory(cfg, m1Dir(M1_B), SP, {})
  check(
    'M1 new device with empty local downloads, zero remote deletes',
    m1b.downloaded === 3 && m1b.deleted === 0 && m1b.conflicts === 0,
    JSON.stringify(m1b)
  )
  check(
    'M1 remote files survive device B first sync',
    fs.existsSync(path.join(ROOT, 'm1', 'a.txt')) &&
      fs.existsSync(path.join(ROOT, 'm1', 'b.txt')) &&
      fs.existsSync(path.join(ROOT, 'm1', 'sub', 'c.txt'))
  )
  check(
    'M1 device B local holds the downloaded files',
    (await fsp.readFile(path.join(M1_B, 'a.txt'), 'utf-8').catch(() => 'MISSING')) === 'm1-a' &&
      (await fsp.readFile(path.join(M1_B, 'sub', 'c.txt'), 'utf-8').catch(() => 'MISSING')) === 'm1-c'
  )
  // 下载后本地 mtime 与远端对齐（utimes）；B 再同步一轮 no-op（不乒乓）
  const m1aStatB = await fsp.stat(path.join(M1_B, 'a.txt'))
  const m1aStatR = await fsp.stat(path.join(ROOT, 'm1', 'a.txt'))
  check('M1 device B mtime aligned to remote', Math.abs(m1aStatB.mtimeMs - m1aStatR.mtimeMs) < 2500, `${m1aStatB.mtimeMs} vs ${m1aStatR.mtimeMs}`)
  const m1b2 = await services.sync.syncDirectory(cfg, m1Dir(M1_B), SP, {})
  check('M1 device B second round is a no-op', m1b2.uploaded === 0 && m1b2.downloaded === 0, JSON.stringify(m1b2))
  await fsp.rm(M1_A, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(M1_B, { recursive: true, force: true }).catch(() => {})

  })

  // M2 A/B 交替同步多轮：编辑与删除正确传播，收敛后无互删互传乒乓（4.7）

  // [慢组登记原因] 多轮收敛马拉松（每轮 1.5s 锁静置）；基础交替 / 下载语义仍由 M1 与 P8 覆盖
  await slowSection('M2/M3：多设备交替 / 基线丢失 adopt', '多轮收敛马拉松（每轮 1.5s 锁静置）；基础交替 / 下载语义仍由 M1 与 P8 覆盖', async () => {
  const M2_A = path.join(os.tmpdir(), `wdsync-e2e-m2-a-${Date.now()}`)
  const M2_B = path.join(os.tmpdir(), `wdsync-e2e-m2-b-${Date.now()}`)
  const m2Dir = (local) => ({ id: 'm2', localPath: local, remotePath: '/m2', mode: 'two-way' })
  const syncM2 = async (root, local) => {
    await switchDevice(root)
    return services.sync.syncDirectory(cfg, m2Dir(local), SP, {})
  }
  await fsp.mkdir(M2_A, { recursive: true })
  await fsp.mkdir(M2_B, { recursive: true })
  await fsp.writeFile(path.join(M2_A, 'f1.txt'), 'f1-v1')
  await fsp.writeFile(path.join(M2_A, 'f2.txt'), 'f2-v1')
  await fsp.writeFile(path.join(M2_A, 'f3.txt'), 'f3-v1')
  const m2a1 = await syncM2(STORAGE_A, M2_A)
  check('M2 A uploads 3 files', m2a1.uploaded === 3, JSON.stringify(m2a1))
  const m2b1 = await syncM2(STORAGE_B, M2_B)
  check('M2 B downloads all as new device', m2b1.downloaded === 3 && m2b1.deleted === 0, JSON.stringify(m2b1))
  // A 改 f1 → B 同步拿到新版本
  await fsp.writeFile(path.join(M2_A, 'f1.txt'), 'f1-v2-from-A')
  const m2a2 = await syncM2(STORAGE_A, M2_A)
  const m2b2 = await syncM2(STORAGE_B, M2_B)
  check('M2 A edit propagates to B', m2a2.uploaded === 1 && m2b2.downloaded === 1 && (await fsp.readFile(path.join(M2_B, 'f1.txt'), 'utf-8')) === 'f1-v2-from-A', `${JSON.stringify(m2a2)} ${JSON.stringify(m2b2)}`)
  // B 改 f2 → A 同步拿到新版本
  await fsp.writeFile(path.join(M2_B, 'f2.txt'), 'f2-v2-from-B')
  const m2b3 = await syncM2(STORAGE_B, M2_B)
  const m2a3 = await syncM2(STORAGE_A, M2_A)
  check('M2 B edit propagates to A', m2b3.uploaded === 1 && m2a3.downloaded === 1 && (await fsp.readFile(path.join(M2_A, 'f2.txt'), 'utf-8')) === 'f2-v2-from-B', `${JSON.stringify(m2b3)} ${JSON.stringify(m2a3)}`)
  // A 删 f1 → B 同步后本地也删除（修改胜过删除的反面：未修改时删除传播）
  await fsp.unlink(path.join(M2_A, 'f1.txt'))
  const m2a4 = await syncM2(STORAGE_A, M2_A)
  const m2b4 = await syncM2(STORAGE_B, M2_B)
  check('M2 A delete propagates to B', m2a4.deleted === 1 && m2b4.deleted === 1 && !fs.existsSync(path.join(M2_B, 'f1.txt')), `${JSON.stringify(m2a4)} ${JSON.stringify(m2b4)}`)
  // 收敛判定：双方连续各两轮全零（无乒乓）
  const m2conv1 = await syncM2(STORAGE_A, M2_A)
  const m2conv2 = await syncM2(STORAGE_B, M2_B)
  const m2conv3 = await syncM2(STORAGE_A, M2_A)
  // isNoop 已提升到顶层（多节共用）
  check('M2 convergence without ping-pong', isNoop(m2conv1) && isNoop(m2conv2) && isNoop(m2conv3), `${JSON.stringify(m2conv1)} ${JSON.stringify(m2conv2)} ${JSON.stringify(m2conv3)}`)
  // M3 基线丢失（换新存储根 = 全新 deviceId）：在同步状态下 → 全部 adopt、零传输、零删除
  await switchDevice(STORAGE_C)
  const m3a = await services.sync.syncDirectory(cfg, m2Dir(M2_A), SP, {})
  check(
    'M3 baseline loss adopts in-sync files without transfer or delete',
    m3a.uploaded === 0 && m3a.downloaded === 0 && m3a.deleted === 0 && m3a.conflicts === 0 && m3a.adopted === 2,
    JSON.stringify(m3a)
  )
  // 基线重建后保护解除：删除恢复正常传播
  await fsp.unlink(path.join(M2_A, 'f3.txt'))
  const m3b = await services.sync.syncDirectory(cfg, m2Dir(M2_A), SP, {})
  check('M3 delete propagation restored after baseline rebuild', m3b.deleted === 1 && !fs.existsSync(path.join(ROOT, 'm2', 'f3.txt')), JSON.stringify(m3b))
  await fsp.rm(M2_A, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(M2_B, { recursive: true, force: true }).catch(() => {})

  })

afterAll(async () => {
  if (SAFE_LOCAL) await fsp.rm(SAFE_LOCAL, { recursive: true, force: true }).catch(() => {})
  await teardownShard({ ROOT, LOCAL, server })
})
