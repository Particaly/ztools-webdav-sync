/**
 * e2e 分片「tree」：选择性同步树、同步预演（dry-run）与云端配额预检。
 *   ST1 —— 选择性同步树：dav.listTree 完整清单 / 根缺失不完整判定
 *   ST2 —— 勾选树落地（excludeRels）：取消勾选子树不上行也不下行、重新勾选恢复、
 *          与 glob 排除规则共存
 *   ST3 —— 预演轮（hints.dryRun 引擎侧）：计划计数与随后真实轮逐项一致；零副作用
 *          （云端 / 本地 / 基线 / 挂起全不动）；冲突按生效策略预判（ask 不询问、
 *          固定策略展开）；批量删除如实反映挂起而零登记；远端根缺失（首次同步）
 *          按「云端为空」预演且零 MKCOL（能力缓存预热后断言）
 *   ST4 —— 预演经调度器（syncNow opts.dryRun）：结果带 dryRun、不排程（无退避 /
 *          follow-up）、同步记录落 trigger='dry-run'
 *   ST5 —— 云端配额预检：不足时轮首一条明确错误（零上传、归因 other）、充足与
 *          无配额形态零行为变化；testConnection 附带 quota（RFC 4331）
 * 每文件独立 dav-server / 端口 / 根目录（test/harness.mjs）；全部为 fast 节。
 */
import { test, afterAll } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setupShard, teardownShard, section, check, isNoop, SP, makeTrashStub, mountFakeDbStorage } from './harness.mjs'

const {
  ROOT, LOCAL, server, services, cfg,
  freshStore, tmpLocal, syncP,
  readReqlog, waitReal,
  SC_DB, SC_KEY, setSCConfig, createTestSched,
} = await setupShard({ shard: 'tree' })

// 本地删除（delete-local）经宿主回收站端口 + ST4 调度器读配置的假 dbStorage：
// 回收站桩 + dbStorage 挂载（读写 SC_DB）均收敛到 harness 工厂（与其它分片同款）
const trash = makeTrashStub()
trash.install()
mountFakeDbStorage(SC_DB)

const setQuota = async (v) => {
  if (v == null) await fsp.rm(path.join(ROOT, '.wdsync-test-quota'), { force: true }).catch(() => {})
  else fs.writeFileSync(path.join(ROOT, '.wdsync-test-quota'), String(v))
}
const setReqlog = async (on) => {
  if (on) fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
  else await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
}
/** 远端文件读取 / 存在性（dav 根即磁盘目录；根下第一段为同步远端名） */
const remoteRead = (rel) => fsp.readFile(path.join(ROOT, rel))
const remoteExists = (rel) =>
  fsp.stat(path.join(ROOT, rel)).then(
    () => true,
    () => false
  )

/** 标准测试树：资料/报告.docx、资料/视频/a.mp4、资料/视频/sub/b.mp4、笔记.md */
async function makeTreeLocal(lp) {
  await fsp.mkdir(path.join(lp, '资料', '视频', 'sub'), { recursive: true })
  await fsp.writeFile(path.join(lp, '资料', '报告.docx'), 'report-v1')
  await fsp.writeFile(path.join(lp, '资料', '视频', 'a.mp4'), 'video-a')
  await fsp.writeFile(path.join(lp, '资料', '视频', 'sub', 'b.mp4'), 'video-b')
  await fsp.writeFile(path.join(lp, '笔记.md'), 'notes-v1')
}

// ============================================================
// ST1：选择性同步树 —— dav.listTree
// ============================================================

section('ST1：选择性同步树（listTree 完整清单 / 根缺失不完整）', async () => {
  await freshStore('st1')
  const lp = await tmpLocal('st1')
  await makeTreeLocal(lp)
  const rp = '/st1-tree'
  const s1 = await syncP(lp, rp)
  check('ST1 首轮全量上传', s1.uploaded === 4 && isNoop(await syncP(lp, rp)))

  const tree = await services.dav.listTree(cfg, rp, true)
  check('ST1 扫描完整（complete=true）', tree.complete === true)
  const rels = new Set(tree.entries.map((e) => e.rel))
  check(
    'ST1 清单含全部 4 个文件与 3 个目录',
    ['资料/报告.docx', '资料/视频/a.mp4', '资料/视频/sub/b.mp4', '笔记.md'].every((r) => rels.has(r)) &&
      ['资料', '资料/视频', '资料/视频/sub'].every((r) => rels.has(r))
  )
  const fileEntry = tree.entries.find((e) => e.rel === '资料/报告.docx')
  check('ST1 文件条目带 size', !!fileEntry && fileEntry.size === 'report-v1'.length)
  const dirEntry = tree.entries.find((e) => e.rel === '资料/视频')
  check('ST1 目录条目 isDir', !!dirEntry && dirEntry.isDir === true)

  // 根缺失：不完整 + 错误（勾选树据此禁用）
  const missing = await services.dav.listTree(cfg, '/st1-not-exist', true)
  check('ST1 缺失根 → complete=false', missing.complete === false)
  check('ST1 缺失根 → errors 非空且 entries 为空', (missing.errors || []).length > 0 && missing.entries.length === 0)
})

// ============================================================
// ST2：勾选树落地（excludeRels 的引擎语义）
// ============================================================

section('ST2：勾选树（excludeRels 子树排除 / 恢复 / 与 glob 共存）', async () => {
  await freshStore('st2')
  const lp = await tmpLocal('st2')
  await makeTreeLocal(lp)
  const rp = '/st2-tree'
  await syncP(lp, rp)
  check('ST2 基线收敛', isNoop(await syncP(lp, rp)))

  // 取消勾选「资料/视频」整棵子树：两侧扫描都不再看到它 —— 不上行也不下行
  //（云端副本按勾选语义保留，不做删除传播；基线条目随「两侧皆无」静默出清）
  const dOff = { id: 'st2', localPath: lp, remotePath: rp, mode: 'two-way' }
  const prefsOff = { ...SP, excludeRels: ['资料/视频'] }
  const sOff = await services.sync.syncDirectory(cfg, dOff, prefsOff, {})
  check('ST2 取消勾选轮零删除零传输（云端副本保留）', isNoop(sOff))
  check('ST2 云端子树保留（不删除传播）', (await remoteExists('st2-tree/资料/视频/a.mp4')) && (await remoteExists('st2-tree/资料/视频/sub/b.mp4')))
  check('ST2 云端其余内容不受影响', (await remoteExists('st2-tree/资料/报告.docx')) && (await remoteRead('st2-tree/笔记.md')).toString() === 'notes-v1')
  check('ST2 排除轮后收敛', isNoop(await services.sync.syncDirectory(cfg, dOff, prefsOff, {})))

  // 排除中的子树：本地新增不上行、云端新增不下行（双向静默）
  await fsp.writeFile(path.join(lp, '资料', '视频', 'new.mp4'), 'video-new')
  await fsp.mkdir(path.join(ROOT, 'st2-tree', '资料', '视频'), { recursive: true })
  await fsp.writeFile(path.join(ROOT, 'st2-tree', '资料', '视频', 'remote-only.mp4'), 'remote-only')
  const sHold = await services.sync.syncDirectory(cfg, dOff, prefsOff, {})
  check('ST2 排除中的新增两侧互不同步（零传输）', isNoop(sHold))
  check('ST2 本地新增未上行', !(await remoteExists('st2-tree/资料/视频/new.mp4')))
  check('ST2 云端新增未下行', !fs.existsSync(path.join(lp, '资料', '视频', 'remote-only.mp4')))

  // 重新勾选（清空 excludeRels）：恢复同步 —— 双侧都在的无基线条目按内容采纳，
  // 本地新增补齐云端、云端新增下载回来
  const sBack = await services.sync.syncDirectory(cfg, dOff, { ...SP }, {})
  check('ST2 恢复勾选后双向补齐', sBack.uploaded >= 1 && sBack.downloaded >= 1)
  check('ST2 云端拿回 new.mp4', await remoteExists('st2-tree/资料/视频/new.mp4'))
  check('ST2 本地拿回 remote-only.mp4', fs.existsSync(path.join(lp, '资料', '视频', 'remote-only.mp4')))
  check('ST2 恢复后收敛', isNoop(await syncP(lp, rp)))

  // 根级文件排除（无 '/' 的精确 rel）：字面匹配只命中该文件；基线在排除窗口内
  // 保持跟踪（「不可见」≠「两侧已删」），解除后按基线判变化而非误判冲突
  await fsp.writeFile(path.join(lp, '笔记.md'), 'notes-v2')
  const sFile = await services.sync.syncDirectory(cfg, dOff, { ...SP, excludeRels: ['笔记.md'] }, {})
  check('ST2 排除根级文件：改动不上行（零传输）', isNoop(sFile))
  check('ST2 云端笔记.md 保持旧版', (await remoteRead('st2-tree/笔记.md')).toString() === 'notes-v1')
  // 解除文件排除：排除窗口内的本地改动恢复上行（按基线识别为改动，而非冲突）
  const sResume = await services.sync.syncDirectory(cfg, dOff, { ...SP }, {})
  check('ST2 解除文件排除后改动恢复上行（不误判冲突）', sResume.uploaded === 1 && sResume.conflicts === 0)
  check('ST2 云端笔记.md 更新到新版', (await remoteRead('st2-tree/笔记.md')).toString() === 'notes-v2')
  check('ST2 恢复后收敛', isNoop(await syncP(lp, rp)))

  // 与 glob 排除规则共存：两套规则合并生效（树 rel 精确 + glob 段匹配）
  await fsp.writeFile(path.join(lp, 'x.tmp'), 'temp')
  await fsp.writeFile(path.join(lp, '资料', '视频', 'y.tmp'), 'temp')
  const sGlob = await services.sync.syncDirectory(cfg, dOff, { ...SP, excludePatterns: ['*.tmp'], excludeRels: ['资料/视频'] }, {})
  check('ST2 glob 与勾选树共存（*.tmp + 子树都排除，零传输）', isNoop(sGlob))
  check('ST2 tmp 文件未上行', !(await remoteExists('st2-tree/x.tmp')) && !(await remoteExists('st2-tree/资料/视频/y.tmp')))
})

// ============================================================
// ST3：预演轮（hints.dryRun 引擎侧）
// ============================================================

section('ST3：预演轮（计划计数与真实轮一致 / 零副作用）', async () => {
  await freshStore('st3')
  const lp = await tmpLocal('st3')
  const rp = '/st3-dry'
  await fsp.mkdir(lp, { recursive: true })
  await fsp.mkdir(path.join(ROOT, 'st3-dry'), { recursive: true })
  // 基线：两侧各有 m1（将改本地）/ rm1（将改云端）/ del1（本地将删）/ keep（不动）
  await fsp.writeFile(path.join(lp, 'm1.txt'), 'local-v1')
  await fsp.writeFile(path.join(lp, 'del1.txt'), 'del-me')
  await fsp.writeFile(path.join(lp, 'keep.txt'), 'keep')
  await fsp.writeFile(path.join(ROOT, 'st3-dry', 'm1.txt'), 'local-v1')
  await fsp.writeFile(path.join(ROOT, 'st3-dry', 'rm1.txt'), 'remote-v1')
  await fsp.writeFile(path.join(ROOT, 'st3-dry', 'del1.txt'), 'del-me')
  await fsp.writeFile(path.join(ROOT, 'st3-dry', 'keep.txt'), 'keep')
  const d = { id: 'st3', localPath: lp, remotePath: rp, mode: 'two-way' }
  await syncP(lp, rp)
  check('ST3 基线收敛', isNoop(await syncP(lp, rp)))
  // 制造本轮变化：本地改 m1（变长 —— 采纳入基线的条目无内容哈希，等长改动
  // 落在「无哈希漏检」的已知边界内，测试用变长确保可检出）、云端改 rm1、
  // 本地删 del1、本地新增 new1
  await fsp.writeFile(path.join(lp, 'm1.txt'), 'local-version-2')
  await fsp.writeFile(path.join(ROOT, 'st3-dry', 'rm1.txt'), 'remote-v2')
  await fsp.rm(path.join(lp, 'del1.txt'))
  await fsp.writeFile(path.join(lp, 'new1.txt'), 'brand-new')
  const baselineBefore = await services.sync._internals.baselineSize(d)

  // ---- 预演轮 ----
  let dry = null
  let dryErr = null
  try {
    dry = await services.sync.syncDirectory(cfg, d, { ...SP, conflictStrategy: 'ask' }, { hints: { source: 'dry-run', dryRun: true } })
  } catch (e) {
    dryErr = e
  }
  check('ST3 预演轮成功返回且带 dryRun 标记', !dryErr && !!dry && dry.dryRun === true)
  // 计划：上传 2（m1 更新 + new1 新增）、下载 1（rm1）、删除 1（del1 → delete-remote）
  check('ST3 计划：上传 2 / 下载 1 / 删除 1 / 冲突 0', !!dry && dry.uploaded === 2 && dry.downloaded === 1 && dry.deleted === 1 && dry.conflicts === 0)
  check('ST3 计划字节量（上传 24 / 下载 9）', !!dry && dry.bytesUp === 24 && dry.bytesDown === 9)
  check('ST3 提示携带预演说明', !!dry && (dry.warnings || []).some((w) => w.includes('预演')))

  // ---- 零副作用断言 ----
  check('ST3 本地 rm1.txt 未被下载覆盖（仍是旧版）', fs.existsSync(path.join(lp, 'rm1.txt')) && (await fsp.readFile(path.join(lp, 'rm1.txt'), 'utf-8')) === 'remote-v1')
  check('ST3 云端 new1 未上传', !(await remoteExists('st3-dry/new1.txt')))
  check('ST3 云端 del1 仍在（删除未执行）', await remoteExists('st3-dry/del1.txt'))
  check('ST3 云端 m1 未被覆盖', (await remoteRead('st3-dry/m1.txt')).toString() === 'local-v1')
  check('ST3 基线条目数不变', (await services.sync._internals.baselineSize(d)) === baselineBefore)
  check('ST3 挂起表未登记（冲突 / 删除确认零写入）', (await services.sync.listPendingConflicts(d)).length === 0)

  // 计划明细经同步记录读取（__syncOps 只服务落盘，随返回值剥离 —— 与渲染层同一路径）
  const log = await services.sync.listSyncLog({ id: 'st3', localPath: lp, remotePath: rp })
  const dryEntry = (log || []).find((e) => e.trigger === 'dry-run')
  check('ST3 同步记录落预演轮（trigger=dry-run / status=ok）', !!dryEntry && dryEntry.status === 'ok')
  check(
    'ST3 记录明细四条且方向与 added 标记正确',
    !!dryEntry &&
      dryEntry.ops.length === 4 &&
      dryEntry.ops.some((o) => o.op === 'upload' && o.rel === 'new1.txt' && o.added === true) &&
      dryEntry.ops.some((o) => o.op === 'upload' && o.rel === 'm1.txt' && !o.added) &&
      dryEntry.ops.some((o) => o.op === 'download' && o.rel === 'rm1.txt') &&
      dryEntry.ops.some((o) => o.op === 'delete-remote' && o.rel === 'del1.txt')
  )

  // ---- 紧随的真实轮与预演对拍（roadmap 验收：结果一致，抽样验证）----
  const real = await syncP(lp, rp)
  check('ST3 真实轮计数与预演一致（上传 2 / 下载 1 / 删除 1）', real.uploaded === 2 && real.downloaded === 1 && real.deleted === 1 && real.conflicts === 0)
  check('ST3 真实轮字节量与预演一致', real.bytesUp === 24 && real.bytesDown === 9)
  check('ST3 真实轮后收敛', isNoop(await syncP(lp, rp)))
})

section('ST3b：预演的冲突预判（ask 不询问 / 固定策略展开）', async () => {
  await freshStore('st3b')
  const lp = await tmpLocal('st3b')
  const rp = '/st3b-dry'
  await fsp.mkdir(lp, { recursive: true })
  await fsp.mkdir(path.join(ROOT, 'st3b-dry'), { recursive: true })
  // 冲突对：两侧大小不同（无基线 → newBoth=conflict；同大小会因 mtime 贴近走采纳）
  await fsp.writeFile(path.join(lp, 'c1.txt'), 'AAAA')
  await fsp.writeFile(path.join(ROOT, 'st3b-dry', 'c1.txt'), 'BBBBBB')
  const d = { id: 'st3b', localPath: lp, remotePath: rp, mode: 'two-way' }

  // 'ask' 策略：只计冲突、不询问（无 onConflict 回调也零错误）、零登记
  const dryAsk = await services.sync.syncDirectory(cfg, d, { ...SP, conflictStrategy: 'ask' }, { hints: { source: 'dry-run', dryRun: true } })
  check('ST3b ask 策略预演计冲突 1', dryAsk.conflicts === 1 && dryAsk.dryRun === true)
  check('ST3b ask 预演零上传零下载', dryAsk.uploaded === 0 && dryAsk.downloaded === 0)
  check('ST3b ask 预演零登记（挂起表空）', (await services.sync.listPendingConflicts(d)).length === 0)

  // 固定策略 'local'：预判为保留电脑版本 → 计冲突 1 + 计划上传（与真实轮执行期同口径）
  const dryLocal = await services.sync.syncDirectory(cfg, d, { ...SP, conflictStrategy: 'local' }, { hints: { source: 'dry-run', dryRun: true } })
  check('ST3b local 策略预演计冲突 1 + 计划上传', dryLocal.conflicts === 1 && dryLocal.uploaded === 1 && dryLocal.bytesUp === 4)
  check('ST3b local 预演零副作用（云端未覆盖）', (await remoteRead('st3b-dry/c1.txt')).toString() === 'BBBBBB')
})

section('ST3c：预演的批量删除阈值（如实反映挂起 / 零登记 / 保护不透支）', async () => {
  await freshStore('st3c')
  const lp = await tmpLocal('st3c')
  const rp = '/st3c-dry'
  await fsp.mkdir(lp, { recursive: true })
  for (let i = 0; i < 60; i++) await fsp.writeFile(path.join(lp, `bulk-${i}.txt`), `bulk-${i}`)
  const d = { id: 'st3c', localPath: lp, remotePath: rp, mode: 'two-way' }
  await syncP(lp, rp)
  check('ST3c 基线就绪', isNoop(await syncP(lp, rp)))
  // 本地删 59 留 1：本地根全空会触发根健康闸（空目录 + 非空基线 → 整轮中止），
  // 这是既有保护语义 —— 预演同样受它约束；保留 1 个文件让删除闸（阈值 50）可测
  for (let i = 0; i < 59; i++) await fsp.rm(path.join(lp, `bulk-${i}.txt`))

  const dryDel = await services.sync.syncDirectory(cfg, d, { ...SP }, { hints: { source: 'dry-run', dryRun: true } })
  check('ST3c 批量删除预演：deleteHeld=59', dryDel.deleteHeld === 59)
  check('ST3c 批量删除预演：deleted=0', dryDel.deleted === 0)
  check('ST3c 批量删除预演：零登记（挂起表空）', (await services.sync.listPendingConflicts(d)).length === 0)
  check('ST3c 批量删除预演：云端全部保留', (await remoteExists('st3c-dry/bulk-0.txt')) && (await remoteExists('st3c-dry/bulk-58.txt')))

  // 预演后真实轮照常走删除闸 —— 预演没有透支任何保护
  const realDel = await syncP(lp, rp)
  check('ST3c 预演后的真实轮仍挂起批量删除（保护未失效）', realDel.deleteHeld === 59 && realDel.deleted === 0)
})

section('ST3d：预演首次同步（远端根刚建即空 → 全量上传计划，零 MKCOL 零 PUT 零基线）', async () => {
  await freshStore('st3d')
  const lp = await tmpLocal('st3d')
  await fsp.writeFile(path.join(lp, 'a.txt'), 'aaa')
  await fsp.mkdir(path.join(lp, '子目录'), { recursive: true })
  await fsp.writeFile(path.join(lp, '子目录', 'b.txt'), 'bbb')
  const rp = '/st3d-no-such-root'
  // 能力缓存先预热：现场探测会在远端创建探测目录（首次同步的既有边界），探测
  // 目录自身按前缀排除、不参与同步 —— 之后的请求日志才是纯预演轮的
  await services.dav.probeCapabilities({ ...cfg }, true, rp)
  await setReqlog(true)
  try {
    const d = { id: 'st3d', localPath: lp, remotePath: rp, mode: 'two-way' }
    const dry = await services.sync.syncDirectory(cfg, d, { ...SP }, { hints: { source: 'dry-run', dryRun: true } })
    check('ST3d 预演成功（空远端 → 全量上传计划）', dry.dryRun === true && dry.uploaded === 2)
    const lines = await readReqlog()
    check('ST3d 请求日志无 MKCOL（不建目录）', !lines.some((l) => l.startsWith('MKCOL ')))
    check('ST3d 零上传执行（无 PUT）', !lines.some((l) => l.startsWith('PUT ')))
    check('ST3d 本地基线未写入', (await services.sync._internals.baselineSize(d)) === 0)
  } finally {
    await setReqlog(false)
  }
})

// ============================================================
// ST4：预演经调度器（syncNow opts.dryRun）
// ============================================================

section('ST4：调度器路径（syncNow opts.dryRun：带标记 / 不排程 / 记录预演触发）', async () => {
  await freshStore('st4')
  const lp = await tmpLocal('st4')
  await fsp.writeFile(path.join(lp, 'x.txt'), 'xxx')
  const rp = '/st4-dry'
  const dir = { id: 'st4', name: 'st4', localPath: lp, remotePath: rp, mode: 'two-way', enabled: true }
  setSCConfig([dir], { autoSync: false, intervalMin: 15 })
  const sched = createTestSched()
  try {
    await sched.init()
    // init 后配置加载 / 选举异步完成：等待 ready 再发起预演（与调度器分片同惯例）
    check('ST4 调度器就绪', await waitReal(() => sched.getSnapshot().ready === true, 8000))
    const r = await sched.syncNow('st4', { dryRun: true })
    check('ST4 预演返回成功', !!r && r.ok === true)
    check('ST4 summary 带 dryRun 标记', !!r && !!r.summary && r.summary.dryRun === true)
    check('ST4 计划：上传 1', !!r && !!r.summary && r.summary.uploaded === 1)
    check('ST4 云端未创建（零副作用）', !(await remoteExists('st4-dry/x.txt')))
    const snap = sched.getSnapshot()
    const slot = snap.slots.find((s) => s.id === 'st4')
    check('ST4 预演后目录空闲', !!slot && slot.state === 'idle')
    check('ST4 无 follow-up / backoff 预订', !!slot && slot.nextDueKind !== 'follow-up' && slot.nextDueKind !== 'backoff')
    const log = await services.sync.listSyncLog({ id: 'st4', localPath: lp, remotePath: rp })
    check('ST4 同步记录落预演轮（trigger=dry-run）', (log || []).some((e) => e.trigger === 'dry-run' && e.status === 'ok'))
  } finally {
    sched.cleanup()
    services.sync._internals.sweepSchedulerTimers()
  }
})

// ============================================================
// ST5：云端配额预检（RFC 4331）
// ============================================================

section('ST5：云端配额预检（不足轮首报错 / 充足与无配额零变化 / testConnection 带配额）', async () => {
  await freshStore('st5')
  const lp = await tmpLocal('st5')
  const rp = '/st5-quota'
  await fsp.mkdir(lp, { recursive: true })
  // 远端根先建好：轮首根探测只在集合存在时携带配额属性（缺失根的首轮拿不到
  // 配额信息、按设计跳过预检，见引擎预检注释）
  await fsp.mkdir(path.join(ROOT, 'st5-quota'), { recursive: true })
  const big = Buffer.alloc(64 * 1024, 7)
  await fsp.writeFile(path.join(lp, 'big.bin'), big)
  const d = { id: 'st5', localPath: lp, remotePath: rp, mode: 'two-way' }

  // testConnection 附带配额（quota=100KB）
  await setQuota(100 * 1024)
  const conn = await services.dav.testConnection(cfg)
  check('ST5 连接测试带出 quota.available', conn.ok === true && !!conn.quota && conn.quota.available === 100 * 1024)

  // 配额 10 字节 < 计划上传 64KB：轮首一条明确错误、零上传、归因 other
  await setQuota(10)
  let err = null
  try {
    await syncP(lp, rp)
  } catch (e) {
    err = e
  }
  check('ST5 配额不足轮首报错', !!err && String(err.message).includes('云端空间不够'))
  check('ST5 失败归因 other（不触发网络退避口径）', !!err && err.failureClass === 'other')
  check('ST5 配额不足零上传', !(await remoteExists('st5-quota/big.bin')))
  check('ST5 错误附带 summary（记录与调度层可用）', !!err && !!err.summary)

  // 配额充足（1MB）：照常上传
  await setQuota(1024 * 1024)
  const okRound = await syncP(lp, rp)
  check('ST5 配额充足照常同步', okRound.uploaded === 1 && isNoop(await syncP(lp, rp)))
  check('ST5 云端内容就位', (await remoteRead('st5-quota/big.bin')).length === 64 * 1024)

  // 服务器不返回配额（'none'）：预检静默跳过，行为与无配额形态一致
  await setQuota('none')
  await fsp.writeFile(path.join(lp, 'more.bin'), Buffer.alloc(1024, 3))
  const noQuota = await syncP(lp, rp)
  check('ST5 无配额服务器零行为变化', noQuota.uploaded === 1)
  const conn2 = await services.dav.testConnection(cfg)
  check('ST5 无配额时连接测试不带 quota 字段', conn2.ok === true && conn2.quota === undefined)
})

afterAll(async () => {
  await teardownShard({ ROOT, LOCAL, server })
})
