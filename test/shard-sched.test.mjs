/**
 * e2e 分片「sched」：调度器组（SC1-SC10 / SC9B / W10）。SC1 挂假 dbStorage 供全系列使用，afterAll 统一收尾（删 ztools / 清 SC_DB）
 * 每文件独立 dav-server / 端口 / 根目录，
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
import { setupShard, teardownShard, section, slowSection, check, sleep, isNoop, SP, makeTrashStub, mountFakeDbStorage, spawnDav } from './harness.mjs'

const {
    HERE, ROOT, PORT, LOCAL, server, services, cfg, storeModule, BUILT, preloadPath,
    STORAGE_MAIN, STORAGE_A, STORAGE_B, STORAGE_C, STORAGE_D, switchDevice,
    baselineDirOf, setProfile, setMidair, freshStore, tmpLocal, syncP, settleStable, sweepCrashResidue, projDir,
    REQLOG, readReqlog, countReq, lastReqLine,
    DEPTHLOG, readDepthlog, countDepth, clearDepthFlags,
    setThrottle, waitForReqLine, waitAbortLine, runCancelRound, readWalOps, findTempResidue,
    PUP, setNetcut, setPartialPut, puBuf,
    SC_DB, SC_KEY, setSCConfig, createTestSched, makeFakeClock, waitReal, pumpUntil, readLeaderLock, writeLeaderLock,
  } = await setupShard({ shard: 'sched' })

  // 宿主回收站桩（原分片内逐字复制的 installTrash 块，统一收敛到 harness 工厂）
  const trash = makeTrashStub()
  const { install: installTrash } = trash
  installTrash()

/**
 * SC 系列共享的假 dbStorage 挂载（自 SC1 节内动作提取；幂等，保留回收站桩 ——
 * deleteLocalOne 依赖 shellTrashItem）。提取成模块级助手的原因：--tagsFilter slow
 * 只跑慢组时 SC1（快组）被跳过，而 SC3+ 的 createTestSched/init 仍需读该挂载 ——
 * 各 SC 节首自行调用（重复调用幂等无害），全量 / fast / slow 三种模式都成立。
 * 形态与 net/tree 分片一致，收敛到 harness 的 mountFakeDbStorage。
 */
const mountScZtools = () => mountFakeDbStorage(SC_DB)

  // ============================================================
  // SC 系列：preload 侧调度器 —— 自举 / DirSlot 状态机（假时钟）/
  // leader 选举与心跳 / lost 中止 / 手动委托与兜底 / 双实例互斥 / 无卸载事件的
  // 死亡接管 / 冲突前后台语义 / 档位矩阵（P1 / P2 / P7）。
  //
  // 测试实例经 sync._internals.createScheduler 创建（autoBootstrap:false，可注入
  // 假时钟；生产实例由 services.js 尾部挂载并自举）。global.window.ztools 在本节
  // 系列内临时挂上假 dbStorage（配置权威通道；生产为宿主 LMDB 同步 KV），系列末尾
  // 删除还原。多实例同进程 = 模拟宿主「主窗口视图 + 独立窗口」双渲染进程形态
  //（双实例场景）：storageRoot / leader.lock / manual-requests /
  // locks 共享，跨实例协调全部走文件。
  // ============================================================
  // ---- SC1（快）：自举未就绪 / syncNow 明确报错 / 空配置 / 钩子转发 / 挂起语义 ----

  await section('SC1：调度器门面基础（自举未就绪 / 报错 / 钩子转发 / 挂起）', async () => {
    // 生产挂载实例在 e2e 环境（无 window.ztools）下自举失败：50ms×20 重试后
    // ready:false + 原因可见（scheduler-error 已发，无订阅者静默）
    const mounted = services.scheduler
    check('SC1 mounted scheduler facade exists', !!mounted && typeof mounted.syncNow === 'function')
    let snap = mounted.getSnapshot()
    const sc1t0 = Date.now()
    while (`${snap.notReadyReason || ''}`.startsWith('自举等待') && Date.now() - sc1t0 < 4000) {
      await sleep(80)
      snap = mounted.getSnapshot()
    }
    check(
      'SC1 bootstrap fails visibly without dbStorage (ready=false + reason)',
      snap.ready === false && /dbStorage 不可用/.test(snap.notReadyReason || ''),
      snap.notReadyReason
    )
    let sc1err = null
    try {
      await mounted.syncNow('x')
    } catch (e) {
      sc1err = e
    }
    check('SC1 syncNow rejects with explicit error when not ready', !!sc1err && /还没准备好/.test(sc1err.message), sc1err && sc1err.message)

    // 挂上假 dbStorage 后的测试实例：空配置 → ready + 0 slots；未知目录 → 明确报错。
    // 保留此前装载的回收站桩（deleteLocalOne 依赖 shellTrashItem，
    // 后续节的 delete-local 路径不得因本节换桩而失去宿主接口）
    mountScZtools()
    SC_DB[SC_KEY] = null
    const sc1 = createTestSched()
    const sc1snap = await sc1.init()
    check('SC1 empty config → ready with 0 slots, not leader yet (no dirs to serve)', sc1snap.ready === true && sc1snap.slots.length === 0, JSON.stringify({ ready: sc1snap.ready, slots: sc1snap.slots.length }))
    // 服务器已配置但目录不存在 / 无启用目录：两种明确报错（不静默忽略）
    setSCConfig([])
    await sc1.reload()
    let sc1err2 = null
    try {
      await sc1.syncNow('no-such-dir')
    } catch (e) {
      sc1err2 = e
    }
    check('SC1 syncNow unknown dir rejects explicitly', !!sc1err2 && /找不到这个同步文件夹/.test(sc1err2.message), sc1err2 && sc1err2.message)
    let sc1err3 = null
    try {
      await sc1.syncNow()
    } catch (e) {
      sc1err3 = e
    }
    check('SC1 syncNow with no enabled dirs rejects explicitly', !!sc1err3 && /没有正在开启的同步文件夹/.test(sc1err3.message), sc1err3 && sc1err3.message)

    // plugin-out / plugin-enter 事件转发（渲染层只经订阅接收，不自行注册钩子）
    const sc1events = []
    const sc1unsub = sc1.subscribe((ev) => sc1events.push(ev))
    sc1.handlePluginOut(false)
    sc1.handlePluginEnter({ code: 'sync' })
    check(
      'SC1 plugin-out / plugin-enter forwarded to subscribers',
      sc1events.some((ev) => ev.type === 'plugin-out' && ev.isKill === false) && sc1events.some((ev) => ev.type === 'plugin-enter' && ev.code === 'sync'),
      JSON.stringify(sc1events.map((e) => e.type))
    )
    sc1unsub()

    // 用户「后台运行」关闭：隐藏（plugin-out 非杀）→ 挂起；进入 → 恢复
    const sc1lp = await tmpLocal('sc1')
    setSCConfig([{ id: 'd1', localPath: sc1lp, remotePath: '/sc1', mode: 'two-way' }], { backgroundRunning: false })
    await sc1.reload()
    sc1.handlePluginOut(false)
    check('SC1 pref-off hide suspends auto scheduling', sc1.getSnapshot().suspended === true, '')
    sc1.handlePluginEnter({ code: 'sync' })
    await waitReal(() => sc1.getSnapshot().suspended === false, 3000)
    check('SC1 plugin-enter resumes pref-suspended scheduling', sc1.getSnapshot().suspended === false, '')
    sc1.cleanup()
    await fsp.rm(sc1lp, { recursive: true, force: true }).catch(() => {})
  })

  // ---- SC2（快，假时钟）：DirSlot 状态机 —— 新目录首轮 / interval 锚定 / concurrent
  //      重入置 rerunPending / 取消保持原计划 / reload 新目录 ----

  await section('SC2：DirSlot 状态机（假时钟）', async () => {
    mountScZtools() // 幂等：fast/slow 过滤下 SC1 可能未运行
    await freshStore('sc2')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-throttle'), '5')
    const clock = makeFakeClock()
    const SC2_LOCAL = await tmpLocal('sc2')
    const sc2dir = { id: 'd1', localPath: SC2_LOCAL, remotePath: '/sc2', mode: 'two-way' }
    await fsp.writeFile(path.join(SC2_LOCAL, 'a.txt'), 'sc2-a')
    // 打开插件不立即同步（syncOnStartup 已移除）：初始 0 目录，首个同步轮由
    // reload 新增 d1 的「新目录首轮」承担
    setSCConfig([], { autoSync: true, intervalMin: 1 })
    const sched = createTestSched({ now: clock.now, timers: clock.timers })
    const events = []
    sched.subscribe((ev) => events.push(ev))
    const roundEnds = () => events.filter((e) => e.type === 'round-end')
    try {
      const snap0 = await sched.init()
      // 选举在 init 后异步完成（真实 IO）：泵动假时钟等待上位，再断言
      const elected = await pumpUntil(clock, () => sched.getSnapshot().leader.isLeader === true, 8000, 8000)
      check(
        'SC2 init loads config, elects leader (single instance), no slot yet',
        snap0.ready === true && snap0.slots.length === 0 && elected,
        JSON.stringify({ ready: snap0.ready, slots: snap0.slots.length, leader: sched.getSnapshot().leader })
      )
      check('SC2 leader.lock holds this instance token', (await readLeaderLock())?.instanceId === sched.instanceId, '')
      setSCConfig([sc2dir], { autoSync: true, intervalMin: 1 })
      const rl0 = await sched.reload()
      check(
        'SC2 reload adds d1 (new slot, first round armed)',
        rl0.applied === true && sched.getSnapshot().slots.length === 1,
        JSON.stringify({ applied: rl0.applied, slots: sched.getSnapshot().slots.length })
      )
      // 本节测 DirSlot 状态机（假时钟）：autoSync=true 使 leader 挂了 watcher，而测试
      // 写入 b.txt / c-throttle.bin 会在 1.5s 真实去抖后注入 watch 触发 —— 真实时钟
      // 事件与假时钟断言窗竞态（rerunPending 轮末 +2s 重排按规格清掉 interval 预订，
      // 「取消保持原计划」断言被测试自身的写入污染）。显式摘掉 watcher 使本节完全
      // 由假时钟决定（watcher 集成由 SC3 专测）；watcherId 契约 = `${instanceId}:${dirId}`
      services.fsx.stopWatch(`${sched.instanceId}:d1`)
      // 新目录首轮（reload 新增 d1）：排队 → running → round-end（uploaded=1）。
      // 泵只负责把 tick 推到发射（假时钟管调度决策，不驱动真实 IO）；轮体是真实
      // IO（首轮含能力探测，冷缓存实测可达 ~2s）——若靠持续泵假时钟等轮结束，
      // 30000ms fake 上限折算的真实时间不够冷轮跑完，且推进过量会吞掉 interval
      // 预订窗（firstDue-now 失真）。故：泵到 running 即止，round-end 用真实时钟等
      const startupStarted = await pumpUntil(clock, () => roundEnds().length >= 1 || (sched.getSnapshot().slots[0] && sched.getSnapshot().slots[0].state === 'running'), 15000, 30000)
      const startupOk = startupStarted && (await waitReal(() => roundEnds().length >= 1, 15000))
      check(
        'SC2 first round of the newly added dir runs and uploads',
        startupOk && roundEnds()[0].error == null && roundEnds()[0].summary && roundEnds()[0].summary.uploaded === 1,
        JSON.stringify(roundEnds()[0] || {})
      )
      let slot = sched.getSnapshot().slots[0]
      const firstDue = slot.nextDueAt
      check(
        'SC2 interval booked (+60s from reload) after first round',
        slot.state === 'scheduled' && slot.nextDueKind === 'interval' && firstDue != null && firstDue - clock.now() <= 60000 && firstDue - clock.now() > 0,
        `state=${slot.state} dueIn=${firstDue == null ? '-' : firstDue - clock.now()}`
      )
      // interval 到期 → 第二轮（no-op）；下一拍从**到期时刻**锚定（+60s，不受轮长影响）
      const intervalOk = await pumpUntil(clock, () => roundEnds().length >= 2, 15000, 90000)
      slot = sched.getSnapshot().slots[0]
      check(
        'SC2 interval round fires on schedule; next cadence anchored at due+interval',
        intervalOk && Math.abs(slot.nextDueAt - (firstDue + 60000)) <= 1500,
        `nextDue-due-60s=${slot.nextDueAt - (firstDue + 60000)}`
      )

      // concurrent:true（引擎 ROUND_IN_FLIGHT 被直调占用）→ 不丢触发：rerunPending
      // → 轮末 +2s 重排一次 → rerun 轮收敛
      await fsp.writeFile(path.join(SC2_LOCAL, 'b.txt'), 'sc2-b')
      const roundsBefore = roundEnds().length
      const direct = services.sync.syncDirectory(cfg, { ...sc2dir }, SP, {})
      // 直调轮同步占据 ROUND_IN_FLIGHT（syncDirectory 入口即置位）；调度轮随即触发：
      // 引擎立即返回 concurrent:true → rerunPending（+2s 重排），触发不丢
      const manualP = sched.syncNow('d1')
      const concurrentOk = await pumpUntil(clock, () => roundEnds().length >= roundsBefore + 1, 10000, 5000)
      slot = sched.getSnapshot().slots[0]
      check(
        'SC2 concurrent re-entry sets rerunPending (+2s watch reschedule), trigger not lost',
        concurrentOk && slot.nextDueKind === 'watch' && slot.nextDueAt - clock.now() <= 3500 && slot.nextDueAt - clock.now() > 0,
        `kind=${slot.nextDueKind} in=${slot.nextDueAt == null ? '-' : slot.nextDueAt - clock.now()}`
      )
      const manualRes = await manualP
      await direct
      check('SC2 syncNow during in-flight engine round resolves without error', manualRes.ok === true, JSON.stringify(manualRes))
      const rerunOk = await pumpUntil(clock, () => roundEnds().length >= roundsBefore + 2, 20000, 10000)
      check('SC2 rerun round executes after concurrent re-entry (trigger not dropped)', rerunOk, `rounds=${roundEnds().length}/${roundsBefore + 2}`)

      // 取消：慢轮中取消 → cancelled 收场、interval 预订保持原计划（不重排、不提前）
      const bookedAt = sched.getSnapshot().slots[0].nextDueAt
      // 取消点必须锚定在「PUT 真正在途」。路径须含 'throttle' 才被
      // dav-server 节流（throttle=20 → 4MB/64KB×20ms ≈ 1.3s 传输窗口）；reqlog 出现
      // 目标 PUT 行才发取消，轮末断言 !ABORT（服务器观察到该 PUT 未写完即被销毁）——
      // 此前仅断言 slot running（含扫描 / 规划期，PUT 未必开始），取消落在传输中这一
      // 前提未断言，节流失效时会空转通过
      await setThrottle(20)
      await fsp.writeFile(path.join(SC2_LOCAL, 'c-throttle.bin'), Buffer.alloc(4 * 1024 * 1024, 99))
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
      const cancelP = sched.syncNow('d1')
      const putSeen = await waitForReqLine((ls) => ls.some((l) => l === 'PUT /dav/sc2/c-throttle.bin'), 15000)
      check(
        'SC2 slow round is in transfer (throttled PUT on the wire) before cancel',
        putSeen && sched.getSnapshot().slots[0].state === 'running',
        putSeen ? 'running' : 'PUT line not seen'
      )
      sched.cancel('d1')
      const cancelRes = await cancelP
      const cancelAbort = await waitAbortLine('PUT', '/dav/sc2/c-throttle.bin')
      check(
        'SC2 server observed the in-flight PUT aborted (cancel landed mid-transfer)',
        cancelAbort.some((l) => l === '!ABORT PUT /dav/sc2/c-throttle.bin'),
        cancelAbort.filter((l) => l.startsWith('!ABORT')).join(' | ')
      )
      await setThrottle(null)
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
      slot = sched.getSnapshot().slots[0]
      const lastEnd = roundEnds()[roundEnds().length - 1]
      check(
        'SC2 cancelled round settles with cancelled semantics',
        cancelRes.ok === false && /已取消同步/.test(cancelRes.error || '') && lastEnd.cancelled === true,
        JSON.stringify({ ok: cancelRes.ok, error: cancelRes.error, evCancelled: lastEnd.cancelled })
      )
      check(
        'SC2 cancel keeps the booked interval plan untouched (no re-anchor, no early retry)',
        slot.nextDueAt === bookedAt && slot.state === 'scheduled',
        `nextDueAt=${slot.nextDueAt} booked=${bookedAt} state=${slot.state}`
      )

      // reload 自检：配置未变零动作；新增目录 → 新 slot + startup 轮
      const cfgVBefore = sched.getSnapshot().configV
      const rl1 = await sched.reload()
      check('SC2 reload with unchanged config is a no-op', rl1.applied === false && sched.getSnapshot().configV === cfgVBefore, '')
      setSCConfig([sc2dir, { id: 'd2', localPath: SC2_LOCAL, remotePath: '/sc2b', mode: 'two-way' }], { autoSync: true, intervalMin: 1 })
      const rl2 = await sched.reload()
      const snapRl = sched.getSnapshot()
      check(
        'SC2 reload picks up new dir (new slot + configV changes)',
        rl2.applied === true && snapRl.slots.length === 2 && snapRl.configV !== cfgVBefore,
        JSON.stringify({ applied: rl2.applied, slots: snapRl.slots.length })
      )
      // 同上新目录首轮：泵到 d2 的 startup 轮 running 即止（冷缓存探测轮 ~2s 真实
      // IO），round-end 用真实时钟等，避免 fake 上限折算的真实时间不够
      const d2Started = await pumpUntil(clock, () => {
        if (roundEnds().some((e) => e.dirId === 'd2')) return true
        const s2 = sched.getSnapshot().slots.find((x) => x.id === 'd2')
        return !!s2 && s2.state === 'running'
      }, 20000, 60000)
      const d2Ok = d2Started && (await waitReal(() => roundEnds().some((e) => e.dirId === 'd2'), 15000))
      check('SC2 newly added dir gets its startup round', d2Ok, '')
    } finally {
      sched.cleanup()
      await fsp.rm(path.join(ROOT, '.wdsync-test-throttle'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
      await fsp.rm(SC2_LOCAL, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'sc2'), { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'sc2b'), { recursive: true, force: true }).catch(() => {})
    }
  })

  // ---- SC3（慢）：leader 心跳不断更（长轮期间）+ 冲突前后台语义（P2 / B 档）----

  // [慢组登记原因] 真实心跳 5s 采样×2 + 10MB 节流长轮（~7s）+ watch 去抖（~2s）
  await slowSection('SC3：leader 心跳与冲突前后台语义', '真实心跳 5s 采样×2 + 10MB 节流长轮（~7s）+ watch 去抖（~2s）', async () => {
    mountScZtools() // 幂等：fast/slow 过滤下 SC1 可能未运行
      await setProfile('p2')
      try {
        await freshStore('sc3')
        const SC3_LOCAL = await tmpLocal('sc3')
        const sc3dir = { id: 'd1', localPath: SC3_LOCAL, remotePath: '/sc3', mode: 'two-way' }
        setSCConfig([sc3dir])
        const sched = createTestSched()
        const events = []
        sched.subscribe((ev) => events.push(ev))
        const snap = await sched.init()
        await waitReal(() => sched.getSnapshot().leader.isLeader === true, 5000)
        check('SC3 single instance elected leader', sched.getSnapshot().leader.isLeader === true, JSON.stringify(snap.leader))

        // 长轮期间心跳不断更：10MB @40ms/64KB ≈ 6.4s 传输（路径含 throttle 才被
        // dav-server 节流）+ 扫描/规划 —— 5.6s 采样点落在轮内，轮次进行中
        // leader.lock 的 at 每 5s 刷新（分片让出使 libuv 心跳得以运行）。
        // 采样点显式断言「轮确实在传输中」（slot running + d1 尚无
        // round-end + reqlog 已见目标 PUT），轮末断言整轮时长 ≥5s —— 节流失效时
        // 整轮毫秒级完成、采样点退化为空闲心跳，弱断言会空转通过（文件名不含
        // throttle 时长轮毫秒级跑完）
        fs.writeFileSync(path.join(ROOT, '.wdsync-test-throttle'), '40')
        fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
        await fsp.writeFile(path.join(SC3_LOCAL, 'big-throttle.bin'), Buffer.alloc(10 * 1024 * 1024, 7))
        const sc3t0 = Date.now()
        const manualP = sched.syncNow('d1')
        const putSeen3 = await waitForReqLine((ls) => ls.some((l) => l === 'PUT /dav/sc3/big-throttle.bin'), 15000)
        check('SC3 long round reaches the throttled PUT (round in transit)', putSeen3, '')
        const atSample1 = (await readLeaderLock())?.at
        await sleep(5600) // 跨过一个心跳周期（5s）；PUT 传输下界 6.4s，采样点必在传输中
        const lockMid = await readLeaderLock()
        const slotMid3 = sched.getSnapshot().slots[0]
        check(
          'SC3 sampling point is mid-round (slot running, no round-end yet, PUT on the wire)',
          slotMid3.state === 'running' && !events.some((e) => e.type === 'round-end' && e.dirId === 'd1'),
          `state=${slotMid3.state} roundEnds=${events.filter((e) => e.type === 'round-end').length}`
        )
        check(
          'SC3 heartbeat keeps refreshing during a long round (at advanced)',
          typeof atSample1 === 'number' && typeof lockMid?.at === 'number' && lockMid.at > atSample1,
          `at1=${atSample1} at2=${lockMid && lockMid.at}`
        )
        check('SC3 still leader mid-round', sched.getSnapshot().leader.isLeader === true, '')
        const bigRes = await manualP
        const sc3ms = Date.now() - sc3t0
        check('SC3 throttled transfer really took seconds (server throttle path hit)', sc3ms >= 5000, `${sc3ms}ms（无节流时整轮毫秒级）`)
        check('SC3 long manual round completes ok', bigRes.ok === true && bigRes.summary && bigRes.summary.uploaded === 1, JSON.stringify(bigRes.ok ? bigRes.summary && bigRes.summary.uploaded : bigRes.error))
        await fsp.rm(path.join(ROOT, '.wdsync-test-throttle'), { force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
        await fsp.rm(REQLOG, { force: true }).catch(() => {})

        // 冲突前后台语义（B 档）：manual + 渲染层订阅在线 → 转发弹窗（本测试应答）；
        // watch 后台轮 → 一律 defer 挂起（deferredConflicts 计数 + pending-conflicts
        // 事件外发 + 不弹窗），引擎既有挂起通道复用
        await fsp.writeFile(path.join(SC3_LOCAL, 'f-ask.txt'), 'sc3-local-ask')
        await fsp.mkdir(path.join(ROOT, 'sc3'), { recursive: true })
        await fsp.writeFile(path.join(ROOT, 'sc3', 'f-ask.txt'), 'sc3-remote-ask')
        const manualAsk = sched.syncNow('d1')
        const gotConflict = await waitReal(() => events.some((e) => e.type === 'conflict'), 15000)
        const conflictEv = events.find((e) => e.type === 'conflict')
        check('SC3 manual round forwards conflict to subscriber (renderer online)', gotConflict && !!conflictEv, '')
        check('SC3 resolveConflict answers the engine question', sched.resolveConflict(conflictEv.conflictId, 'local') === true, '')
        const askRes = await manualAsk
        check(
          'SC3 manual conflict resolves as local (uploaded, no defer)',
          askRes.ok === true && askRes.summary && askRes.summary.conflicts === 1 && askRes.summary.uploaded === 1 && (askRes.summary.deferredConflicts || 0) === 0,
          JSON.stringify(askRes.summary || askRes.error)
        )
        check(
          'SC3 remote now holds local version (B-tier recheck guard passed)',
          (await fsp.readFile(path.join(ROOT, 'sc3', 'f-ask.txt'), 'utf-8')) === 'sc3-local-ask',
          ''
        )

        // 后台（watch）轮冲突 → defer：autoSync 开 + reload → leader 挂 watcher →
        // 写入触发文件 → watch 轮撞上 g 冲突 → defer（不转发弹窗）
        await fsp.writeFile(path.join(SC3_LOCAL, 'g-defer.txt'), 'sc3-local-defer')
        await fsp.writeFile(path.join(ROOT, 'sc3', 'g-defer.txt'), 'sc3-remote-defer')
        setSCConfig([sc3dir], { autoSync: true, intervalMin: 30 })
        await sched.reload()
        const conflictsBefore = events.filter((e) => e.type === 'conflict').length
        await fsp.writeFile(path.join(SC3_LOCAL, 'trigger.txt'), 'sc3-trigger') // 触发 watcher（1.5s 去抖）
        const deferEnd = await waitReal(
          () => events.some((e) => e.type === 'round-end' && e.summary && Number(e.summary.deferredConflicts) > 0),
          20000
        )
        const deferRound = events.find((e) => e.type === 'round-end' && e.summary && Number(e.summary.deferredConflicts) > 0)
        check(
          'SC3 background (watch) round defers conflict: no popup, counted, round not failed',
          deferEnd && deferRound.error == null && deferRound.summary.deferredConflicts === 1 && events.filter((e) => e.type === 'conflict').length === conflictsBefore,
          JSON.stringify(deferRound || {})
        )
        const pendingEv = events.find((e) => e.type === 'pending-conflicts')
        check(
          'SC3 pending-conflicts event emitted with the deferred file',
          !!pendingEv && pendingEv.items.some((it) => it.rel === 'g-defer.txt'),
          JSON.stringify(pendingEv && pendingEv.items)
        )
        // 挂起记录经统一处理通道收敛：setPendingChoice('local') 后下一轮自动解决
        await services.sync.setPendingChoice(sc3dir, 'g-defer.txt', 'local')
        const settleRes = await sched.syncNow('d1')
        check(
          'SC3 setPendingChoice resolves the deferred conflict on next round',
          settleRes.ok === true && settleRes.summary && settleRes.summary.conflicts === 1 && (settleRes.summary.deferredConflicts || 0) === 0,
          JSON.stringify(settleRes.summary || settleRes.error)
        )
        sched.cleanup()
        await fsp.rm(SC3_LOCAL, { recursive: true, force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, 'sc3'), { recursive: true, force: true }).catch(() => {})
      } finally {
        await fsp.rm(path.join(ROOT, '.wdsync-test-throttle'), { force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
        await fsp.rm(REQLOG, { force: true }).catch(() => {})
        await setProfile('p1')
      }
    }
  )

  // ---- SC4（慢）：目录锁 stale 接管 + lost 中止（在途轮文件边界取消、不写基线）----

  // [慢组登记原因] 真实心跳 5s 探测窗 + 16MB 节流长轮（~10s）
  await slowSection('SC4：目录锁接管与 lost 中止', '真实心跳 5s 探测窗 + 16MB 节流长轮（~10s）', async () => {
    mountScZtools() // 幂等：fast/slow 过滤下 SC1 可能未运行
      await freshStore('sc4')
      const SC4_LOCAL = await tmpLocal('sc4')
      const sc4dir = { id: 'd1', localPath: SC4_LOCAL, remotePath: '/sc4', mode: 'two-way' }
      setSCConfig([sc4dir])
      const sched = createTestSched()
      const events = []
      sched.subscribe((ev) => events.push(ev))
      await sched.init()
      await waitReal(() => sched.getSnapshot().leader.isLeader === true, 5000)
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-throttle'), '40')
      try {
        // 目录锁 stale 接管：预置他机停更 ≥ TTL（at 与 mtime 双信号均旧）的目录锁
        // → 本轮 temp+rename 接管后照常同步（stale <TTL 时则等待 / 让路）
        const deviceId = await services.storage.getDeviceId()
        const lockH = storeModule.hash16(['dirlock', deviceId, storeModule.normalizeLocalKey(SC4_LOCAL), storeModule.normalizeRemoteKey('/sc4'), `http://127.0.0.1:${PORT}`])
        const staleLock = path.join(storeModule.storageRoot(), 'scheduler', 'locks', `${lockH}.lock`)
        await fsp.mkdir(path.dirname(staleLock), { recursive: true })
        const staleAt = Date.now() - 120000
        await fsp.writeFile(staleLock, JSON.stringify({ v: 1, instanceId: 'dead-peer', at: staleAt, ttlMs: 60000 }))
        await fsp.utimes(staleLock, new Date(staleAt), new Date(staleAt))
        await fsp.writeFile(path.join(SC4_LOCAL, 'a.txt'), 'sc4-a')
        const takeoverRes = await sched.syncNow('d1')
        check(
          'SC4 stale dir lock (both signals ≥ TTL) taken over; round proceeds',
          takeoverRes.ok === true && takeoverRes.summary && takeoverRes.summary.uploaded === 1 && !(await fsp.readFile(staleLock, 'utf-8').then(() => true).catch(() => false)),
          JSON.stringify(takeoverRes.ok ? takeoverRes.summary && takeoverRes.summary.uploaded : takeoverRes.error)
        )

        // lost 中止：长轮在飞时 leader.lock 被他机接管写（新鲜）→ 下一拍心跳先读后写
        // 发现失位 → 在途轮经 shouldAbort 在文件边界以取消语义中止；基线不新增。
        // 外来锁循环改写直到失位确认：与心跳的 temp+rename 写入存在竞态（外来锁可能
        // 恰好落在心跳「先读后写」之间而被覆盖），重写保证任一心跳拍的先读必命中。
        // 外来锁写入等 reqlog 出现目标 PUT 行才开始 —— 把「中止发生在
        // 传输中」变成前提而非巧合（此前仅断言 slot running，含扫描 / 规划期）；
        // 轮末断言 !ABORT（服务器观察到该 PUT 未写完即被销毁）
        const baseBefore = await services.sync._internals.baselineSize(sc4dir)
        // 16MB @40ms/64KB ≈ 10.2s 传输（路径含 throttle 才被 dav-server 节流）：
        // 9s 外来锁窗口内心跳（5s 拍）必发现失位 → 在途 PUT 被中止
        await fsp.writeFile(path.join(SC4_LOCAL, 'big-throttle.bin'), Buffer.alloc(16 * 1024 * 1024, 4))
        fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
        const lostP = sched.syncNow('d1')
        const putSeen4 = await waitForReqLine((ls) => ls.some((l) => l === 'PUT /dav/sc4/big-throttle.bin'), 15000)
        check(
          'SC4 lost-abort round is in transfer (throttled PUT on the wire) before takeover begins',
          putSeen4 && sched.getSnapshot().slots[0].state === 'running',
          putSeen4 ? 'running' : 'PUT line not seen'
        )
        const foreign = () => writeLeaderLock({ v: 1, instanceId: 'peer-takes-over', deviceId: 'peer-dev', at: Date.now() })
        const tForeign = Date.now()
        while (sched.getSnapshot().leader.state !== 'lost' && Date.now() - tForeign < 9000) {
          await foreign()
          await sleep(600)
        }
        const lostEnd = await waitReal(() => events.some((e) => e.type === 'round-end' && e.error), 12000)
        const lostRound = [...events].reverse().find((e) => e.type === 'round-end' && e.error)
        check(
          'SC4 taken-over instance aborts in-flight round at file boundary (cancel semantics)',
          lostEnd && lostRound.cancelled === true && /已取消同步/.test(lostRound.error || ''),
          JSON.stringify(lostRound || {})
        )
        const abortLines4 = await waitAbortLine('PUT', '/dav/sc4/big-throttle.bin')
        check(
          'SC4 server observed the in-flight PUT aborted mid-transfer',
          abortLines4.some((l) => l === '!ABORT PUT /dav/sc4/big-throttle.bin'),
          abortLines4.filter((l) => l.startsWith('!ABORT')).join(' | ')
        )
        check('SC4 lost round writes no new baseline entries', (await services.sync._internals.baselineSize(sc4dir)) === baseBefore, `before=${baseBefore} after=${await services.sync._internals.baselineSize(sc4dir)}`)
        const lostSnap = sched.getSnapshot()
        check('SC4 instance reports lost state and stops auto scheduling', lostSnap.leader.state === 'lost' && lostSnap.leader.isLeader === false, JSON.stringify(lostSnap.leader))
        // lost 后重选有 30s±30% 抖动：观察窗内不得立即夺回（他机的新鲜锁也挡住重试）
        await sleep(5200)
        check(
          'SC4 no immediate re-election after lost (30s±30% jitter; peer lock fresh)',
          sched.getSnapshot().leader.state === 'lost',
          JSON.stringify(sched.getSnapshot().leader)
        )
        const lostRes = await lostP
        check('SC4 syncNow of the aborted round surfaces the cancel error', lostRes.ok === false && /已取消同步/.test(lostRes.error || ''), JSON.stringify(lostRes.error))
        sched.cleanup()
      } finally {
        await fsp.rm(path.join(ROOT, '.wdsync-test-throttle'), { force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
        await fsp.rm(REQLOG, { force: true }).catch(() => {})
        await fsp.rm(SC4_LOCAL, { recursive: true, force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, 'sc4'), { recursive: true, force: true }).catch(() => {})
      }
    }
  )

  // ---- SC5（快）：调度器驱动的档位矩阵（P1 A 档 / P2 / P7 B 档）----

  await section('SC5：调度器驱动同步的档位矩阵（P1 / P2 / P7）', async () => {
    mountScZtools() // 幂等：fast/slow 过滤下 SC1 可能未运行
    for (const prof of ['p1', 'p2', 'p7']) {
      await setProfile(prof)
      try {
        await freshStore(`sc5${prof}`)
        const lp = await tmpLocal(`sc5${prof}`)
        const rp = `/sc5-${prof}`
        await fsp.writeFile(path.join(lp, 'hello.txt'), `sc5-${prof}`)
        setSCConfig([{ id: 'd1', localPath: lp, remotePath: rp, mode: 'two-way' }])
        const sched = createTestSched()
        const snap = await sched.init()
        // 选举异步完成（真实 IO）：先等上位再手动同步（上位前的 syncNow 会走
        // 「委托给自己」路径 —— 行为同样正确，但此处直跑以断言 summary/tier）
        await waitReal(() => sched.getSnapshot().leader.isLeader === true, 5000)
        const res = await sched.syncNow('d1')
        const expectTier = prof === 'p1' ? 'A' : 'B'
        check(
          `SC5 ${prof}: scheduler-driven manual sync completes at tier ${expectTier}`,
          snap.ready === true && sched.getSnapshot().leader.isLeader === true && res.ok === true && res.summary && res.summary.uploaded === 1 && res.summary.tier === expectTier,
          JSON.stringify({ ok: res.ok, error: res.error, tier: res.summary && res.summary.tier })
        )
        check(`SC5 ${prof}: remote file present`, fs.existsSync(path.join(ROOT, 'sc5-' + prof, 'hello.txt')), '')
        sched.cleanup()
        await fsp.rm(lp, { recursive: true, force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, 'sc5-' + prof), { recursive: true, force: true }).catch(() => {})
      } finally {
        await setProfile('p1')
      }
    }
  })

  // ---- SC6（慢）：手动委托 claim/receipt + 双实例同目录手动互斥 ----

  // [慢组登记原因] leader 心跳领取窗（≤5s）×2 场景 + 双手动并发串行化（~12s）
  await slowSection('SC6：手动委托与双实例互斥', 'leader 心跳领取窗（≤5s）×2 场景 + 双手动并发串行化（~12s）', async () => {
    mountScZtools() // 幂等：fast/slow 过滤下 SC1 可能未运行
      await freshStore('sc6')
      const SC6_LOCAL = await tmpLocal('sc6')
      const sc6dir = { id: 'd1', localPath: SC6_LOCAL, remotePath: '/sc6', mode: 'two-way' }
      await fsp.writeFile(path.join(SC6_LOCAL, 'only-once.txt'), 'sc6-once')
      setSCConfig([sc6dir])
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
      const schedA = createTestSched()
      const schedB = createTestSched()
      const eventsB = []
      try {
        await schedA.init()
        await waitReal(() => schedA.getSnapshot().leader.isLeader === true, 5000)
        await schedB.init()
        const bStandby = await waitReal(() => schedB.getSnapshot().leader.state === 'standby', 5000)
        check(
          'SC6 first instance leads, second stands by (fresh lock observed)',
          schedA.getSnapshot().leader.isLeader === true && bStandby === true,
          JSON.stringify({ a: schedA.getSnapshot().leader.state, b: schedB.getSnapshot().leader.state })
        )

        // 委托：B（非 leader）syncNow → req → A 心跳领取（claim）→ 代跑 → receipt
        schedB.subscribe((ev) => eventsB.push(ev))
        const delOk = await schedB.syncNow('d1')
        check('SC6 delegated manual sync returns ok via receipt', delOk.ok === true, JSON.stringify(delOk.error))
        const lines = await fsp.readFile(path.join(storeModule.storageRoot(), 'scheduler', 'manual-requests.jsonl'), 'utf-8')
        const kinds = lines.split('\n').filter(Boolean).map((l) => storeModule._internals.decodeLine(l)).filter(Boolean).map((o) => o.kind)
        check(
          'SC6 manual-requests records req + claim(by leader) + receipt triple',
          kinds.filter((k) => k === 'req').length === 1 && kinds.filter((k) => k === 'claim').length === 1 && kinds.filter((k) => k === 'receipt').length === 1,
          JSON.stringify(kinds)
        )
        check(
          'SC6 delegated round surfaces round-end on requester side (renderer state settles)',
          eventsB.some((e) => e.type === 'round-end' && e.dirId === 'd1' && e.error == null),
          ''
        )
        let reqLines = await readReqlog()
        check(
          'SC6 delegated upload happens exactly once',
          countReq(reqLines, 'PUT', `/dav/sc6/only-once.txt`) === 1 && fs.existsSync(path.join(ROOT, 'sc6', 'only-once.txt')),
          `PUT count=${countReq(reqLines, 'PUT', `/dav/sc6/only-once.txt`)}`
        )

        // 双实例同时手动同一目录：A 直跑 + B 委托 → 目录锁 + 队列串行化 → 恰一次上传、
        // 基线 JSONL 完整可解析（无并发写坏）
        fs.rmSync(REQLOG)
        await fsp.writeFile(path.join(SC6_LOCAL, 'second.txt'), 'sc6-second')
        const both = await Promise.all([schedA.syncNow('d1'), schedB.syncNow('d1')])
        check('SC6 dual-instance concurrent manual syncs both resolve ok', both[0].ok === true && both[1].ok === true, JSON.stringify(both.map((r) => r.ok)))
        reqLines = await readReqlog()
        check(
          'SC6 same-dir dual manual sync uploads exactly once (mutex via dir lock + queue)',
          countReq(reqLines, 'PUT', `/dav/sc6/second.txt`) === 1,
          `PUT count=${countReq(reqLines, 'PUT', `/dav/sc6/second.txt`)}`
        )
        const baselineDir = await baselineDirOf(sc6dir)
        // 基线完整性：快照未压缩（log 行数 < 4096）时 snapshot.json 可不存在 —— 完整性
        // 以引擎视角的条目数 + log.jsonl 逐行 CRC 有效判定（并发写坏必然破坏其一）
        const entriesOk = (await services.sync._internals.baselineSize(sc6dir)) === 2
        const logOk = await fsp
          .readFile(path.join(baselineDir, 'log.jsonl'), 'utf-8')
          .then((t) => t.split('\n').filter(Boolean).every((l) => storeModule._internals.decodeLine(l) != null))
          .catch(() => false)
        check('SC6 baseline holds both files after dual sync (no corruption)', entriesOk, `entries=${await services.sync._internals.baselineSize(sc6dir)}`)
        check('SC6 baseline JSONL fully CRC-valid after dual sync', logOk, '')
      } finally {
        schedA.cleanup()
        schedB.cleanup()
        await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog.log'), { force: true }).catch(() => {})
        await fsp.rm(SC6_LOCAL, { recursive: true, force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, 'sc6'), { recursive: true, force: true }).catch(() => {})
      }
    }
  )

  // ---- SC7（慢）：无卸载事件的死亡（close/destroy/crash 型：清扫定时器、锁残留）
  //      → 委托 15s 超时核验 → 兜底本地跑（不重跑）→ TTL 过期新实例接管 ----

  // [慢组登记原因] 委托 15s 超时（真实等待）+ leader TTL 15s 过期 + 选举重试（~22s）
  await slowSection('SC7：无卸载事件死亡的超时兜底与 TTL 接管', '委托 15s 超时（真实等待）+ leader TTL 15s 过期 + 选举重试（~22s）', async () => {
    mountScZtools() // 幂等：fast/slow 过滤下 SC1 可能未运行
      await freshStore('sc7')
      const SC7_LOCAL = await tmpLocal('sc7')
      const sc7dir = { id: 'd1', localPath: SC7_LOCAL, remotePath: '/sc7', mode: 'two-way' }
      await fsp.writeFile(path.join(SC7_LOCAL, 'rescue.txt'), 'sc7-rescue')
      setSCConfig([sc7dir])
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
      const schedA = createTestSched()
      const schedB = createTestSched()
      try {
        await schedA.init() // A 上位（leader.lock 写入 + 心跳启动）
        await waitReal(() => schedA.getSnapshot().leader.isLeader === true, 5000)
        await schedB.init()
        await waitReal(() => schedB.getSnapshot().leader.state === 'standby', 5000)
        await schedB.suspend('api') // B 退出选举（兜底期间不与 A 争位）
        // 模拟 A「无卸载事件的死亡」（close/destroy/crash 型）：清扫其全部定时器，
        // 不执行任何清理 —— leader.lock 与进程内状态原地残留（ghost-timers 结论 c）
        const swept = services.sync._internals.sweepSchedulerTimers()
        check('SC7 death simulation swept leader timers (heartbeat/tick ≥2)', swept >= 2, `swept=${swept}`)
        check('SC7 dead leader lock left behind (no unload events to release it)', (await readLeaderLock())?.instanceId === schedA.instanceId, '')
        // B 手动：委托 15s 无人领取（A 已死）→ 核验（无 receipt、req 未被压缩）→
        // 兜底本地跑（目录锁 + 冲突 defer）→ 恰一次上传
        const rescue = await schedB.syncNow('d1')
        check(
          'SC7 unclaimed request falls back to local run after 15s and uploads once',
          rescue.ok === true && rescue.summary && rescue.summary.uploaded === 1 && fs.existsSync(path.join(ROOT, 'sc7', 'rescue.txt')),
          JSON.stringify(rescue.ok ? rescue.summary && rescue.summary.uploaded : rescue.error)
        )
        let reqLines = await readReqlog()
        check(
          'SC7 fallback run uploaded exactly once (verify-then-run, never re-run)',
          countReq(reqLines, 'PUT', `/dav/sc7/rescue.txt`) === 1,
          `PUT count=${countReq(reqLines, 'PUT', `/dav/sc7/rescue.txt`)}`
        )
        const manualText = await fsp.readFile(path.join(storeModule.storageRoot(), 'scheduler', 'manual-requests.jsonl'), 'utf-8')
        const manualKinds = manualText.split('\n').filter(Boolean).map((l) => storeModule._internals.decodeLine(l)).filter(Boolean).map((o) => o.kind)
        check('SC7 timed-out request has req but no claim/receipt (nobody ran it twice)', manualKinds.filter((k) => k === 'req').length === 1 && !manualKinds.includes('claim'), JSON.stringify(manualKinds))
        // TTL 接管：leader.lock 停更 ≥15s（死亡时刻起算）→ 新实例接管上位并可服务
        const schedC = createTestSched()
        const snapC = await schedC.init()
        const tookOver = await waitReal(() => schedC.getSnapshot().leader.isLeader === true, 25000)
        check(
          'SC7 stale leader lock (≥TTL) taken over by a new instance',
          tookOver && snapC.ready === true,
          JSON.stringify(schedC.getSnapshot().leader)
        )
        await fsp.writeFile(path.join(SC7_LOCAL, 'after-takeover.txt'), 'sc7-after')
        const cRes = await schedC.syncNow('d1')
        reqLines = await readReqlog()
        check(
          'SC7 new leader serves manual sync (no interference from dead instance)',
          // 上传恰一次即可 —— 新 leader 的心跳可能先领取 B 的遗留委托请求、由代跑轮
          // 顺带上传该文件（文件已存在且无基线，代跑是真实同步），随后的手动轮成为
          // no-op（uploaded=0）。恰一次由 PUT 计数与远端内容自证，不绑定执行者。
          cRes.ok === true && countReq(reqLines, 'PUT', `/dav/sc7/after-takeover.txt`) === 1 && (await fsp.readFile(path.join(ROOT, 'sc7', 'after-takeover.txt'), 'utf-8').catch(() => '')) === 'sc7-after',
          `PUT count=${countReq(reqLines, 'PUT', `/dav/sc7/after-takeover.txt`)}`
        )
        // 死实例遗留的未领取 req 由新 leader 领取代跑（no-op 收敛）并回执 —— 不重复上传
        await sleep(6500) // 等新 leader 的下一拍心跳领取遗留请求
        const finalPuts = countReq(await readReqlog(), 'PUT', `/dav/sc7/rescue.txt`)
        check('SC7 leftover request re-served as no-op (never re-uploaded)', finalPuts === 1, `rescue PUTs=${finalPuts}`)
        schedC.cleanup()
      } finally {
        schedA.cleanup()
        schedB.cleanup()
        await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog.log'), { force: true }).catch(() => {})
        await fsp.rm(SC7_LOCAL, { recursive: true, force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, 'sc7'), { recursive: true, force: true }).catch(() => {})
      }
    }
  )

  // ============================================================
  // SC8–SC10：调度策略 —— 全局并发与公平 / 跨轮退避 / 开放意图
  // follow-up / 让出重排 / 时钟跳变 / 退避期 watch 合并 / 挂起冲突提醒。
  // 假时钟纪律：SC8 / SC9B autoSync=false（不挂 watcher）；SC9 的 A/B/C 三段
  // 假时钟节在选举后显式 stopWatch（A/B/C 段测试写文件不产生 watch 触发），
  // 唯独 A2 段保留真实 watcher —— 它就是「退避期 watch 合并」的被测对象，且
  // 该段在 watcher 存活期间只发生一次受控的用户文件写入（w.txt）。
  // 节流用例纪律：依赖 dav-server 节流拉长传输窗口的采样点（SC8）均以
  // 「reqlog 已见目标 PUT 行（服务器侧证据：节流路径命中）+ slot running +
  // 该目录尚无 round-end」锚定「轮确实处于传输中」。
  // ============================================================
  // ---- SC8（快，假时钟 + 双 origin 节流长轮）：全局并发 / 每 origin 串行 / 插队公平 ----

  // [慢组登记原因] 双 origin 节流长轮的公平窗口采样（每用例 1-5s 真实传输）；调度器并发基础仍由 SC2 覆盖、公平语义留发版验证
  await slowSection('SC8：全局并发与公平（双 origin）', '双 origin 节流长轮的公平窗口采样（每用例 1-5s 真实传输）；调度器并发基础仍由 SC2 覆盖、公平语义留发版验证', async () => {
    mountScZtools() // 幂等：fast/slow 过滤下 SC1 可能未运行
    // 第二个 dav-server 实例（不同 origin）：「每 origin 并发 1」需要两个 origin 才
    // 可验证。目录级 serverUrl 覆盖指向它（UI 不写该字段 —— 单服务器用户行为不变）。
    // 端口 0 随机分配（原 PORT+1 推算在固定端口时代安全，随机端口下会撞端口）。
    const ROOT2 = ROOT + '-sc8b'
    const { child: server2, port: PORT2 } = await spawnDav({ tag: 'sched-sc8b', root: ROOT2 })
    const log1 = async () => (await fsp.readFile(REQLOG, 'utf-8').catch(() => '')).split('\n').filter(Boolean)
    const log2 = async () => (await fsp.readFile(path.join(ROOT2, '.wdsync-test-reqlog.log'), 'utf-8').catch(() => '')).split('\n').filter(Boolean)
    const waitForLineIn = async (read, target, timeoutMs = 15000) => {
      const t0 = Date.now()
      for (;;) {
        const ls = await read()
        if (ls.some((l) => l === target)) return true
        if (Date.now() - t0 > timeoutMs) return false
        await sleep(30)
      }
    }
    try {
      await freshStore('sc8')
      // 节流 300ms/64KB：256KB 文件 ≈ 1.2s 传输窗口（公平轮用 1MB ≈ 4.8s）
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-throttle'), '300')
      fs.writeFileSync(path.join(ROOT2, '.wdsync-test-throttle'), '300')
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
      fs.writeFileSync(path.join(ROOT2, '.wdsync-test-reqlog'), 'x')
      const A1 = await tmpLocal('sc8a1')
      const A2 = await tmpLocal('sc8a2')
      const A3 = await tmpLocal('sc8a3')
      const B1 = await tmpLocal('sc8b1')
      for (const lp of [A1, A2, A3]) await fsp.writeFile(path.join(lp, 'f-throttle.bin'), Buffer.alloc(256 * 1024, 1))
      await fsp.writeFile(path.join(B1, 'f-throttle.bin'), Buffer.alloc(768 * 1024, 1)) // 12 块 ×300ms ≈ 3.6s：并行观察窗
      setSCConfig([
        { id: 'a1', localPath: A1, remotePath: '/sc8a1', mode: 'two-way' },
        { id: 'a2', localPath: A2, remotePath: '/sc8a2', mode: 'two-way' },
        { id: 'a3', localPath: A3, remotePath: '/sc8a3', mode: 'two-way' },
        { id: 'b1', localPath: B1, remotePath: '/sc8b1', mode: 'two-way', serverUrl: `http://127.0.0.1:${PORT2}/dav/` },
      ])
      const clock = makeFakeClock()
      const sched = createTestSched({ now: clock.now, timers: clock.timers })
      const events = []
      sched.subscribe((e) => events.push(e))
      const stateOf = (id) => sched.getSnapshot().slots.find((s) => s.id === id)
      await sched.init()
      await pumpUntil(clock, () => sched.getSnapshot().leader.isLeader === true, 8000, 8000)
      const endsOf = (id) => events.filter((e) => e.type === 'round-end' && e.dirId === id).length

      // —— 并发形态：先让 b1（origin B）进入传输，再同时触发 a1/a2（同 origin A）——
      //    syncNow 入队前有 leader 锁读 await，同时触发时入队顺序不定，断言写成
      //    顺序无关：a1/a2 必「恰一个 running 一个 queued」（每 origin 串行），
      //    b1 与 A 侧并行（both in transfer，按节流用例纪律锚定）
      const pB1 = sched.syncNow('b1')
      const putBSeen = await waitForLineIn(log2, 'PUT /dav/sc8b1/f-throttle.bin')
      check('SC8 b1 (origin B) round is in transfer (throttled PUT on the wire)', putBSeen && stateOf('b1').state === 'running' && endsOf('b1') === 0, `seen=${putBSeen} state=${stateOf('b1').state}`)
      const pA1 = sched.syncNow('a1')
      const pA2 = sched.syncNow('a2')
      const pairOk = await waitReal(() => {
        const s1 = stateOf('a1')
        const s2 = stateOf('a2')
        return (s1.state === 'running') !== (s2.state === 'running') && (s1.state === 'queued' || s2.state === 'queued') && stateOf('b1').state === 'running' && endsOf('b1') === 0
      }, 5000)
      const runA = stateOf('a1').state === 'running' ? 'a1' : 'a2'
      const queuedA = runA === 'a1' ? 'a2' : 'a1'
      const putASeen = await waitForLineIn(log1, `PUT /dav/sc8${runA}/f-throttle.bin`)
      check(
        'SC8 same-origin rounds serialize while cross-origin runs in parallel (both in transfer)',
        pairOk && putBSeen && putASeen && endsOf(runA) === 0,
        `pairOk=${pairOk} runA=${runA} putA=${putASeen} b1Ends=${endsOf('b1')}`
      )
      const [rA1, rA2, rB1] = await Promise.all([pA1, pA2, pB1])
      check(
        'SC8 all three manual rounds complete with uploads (queued one ran after origin released)',
        rA1.ok === true && rA2.ok === true && rB1.ok === true && rA1.summary.uploaded === 1 && rA2.summary.uploaded === 1 && rB1.summary.uploaded === 1,
        JSON.stringify([rA1.summary && rA1.summary.uploaded, rA2.summary && rA2.summary.uploaded, rB1.summary && rB1.summary.uploaded])
      )
      const idxRun = events.findIndex((e) => e.type === 'round-end' && e.dirId === runA)
      const idxQueued = events.findIndex((e) => e.type === 'round-end' && e.dirId === queuedA)
      check('SC8 per-origin serialization visible in round-end order (running one ends first)', idxRun >= 0 && idxQueued > idxRun, `run=${idxRun} queued=${idxQueued}`)
      // 公平轮的长传输文件（1MB@300ms ≈ 4.8s）：第一阶段之后写入（避免首轮多传它污染计数）
      await fsp.writeFile(path.join(A1, 'big-throttle.bin'), Buffer.alloc(1024 * 1024, 2))

      // —— 公平上限：a2 经 rerun（+2s watch 预订，非插队路径）入队并「饿死」后，
      //    后来的 manual 插队（a3）不得越过它 —— a2 的 rerun 轮先结束
      const pA2a = sched.syncNow('a2') // 第一轮（快，noop）
      await waitReal(() => stateOf('a2') && stateOf('a2').state === 'running', 5000)
      const pA2b = sched.syncNow('a2') // 运行中再触发 → rerunPending → 轮末 +2s watch 预订
      await pA2a
      const pA1big = sched.syncNow('a1') // 长轮（1MB@300ms ≈ 4.8s，占住 origin A）
      const bigSeen = await waitForLineIn(log1, 'PUT /dav/sc8a1/big-throttle.bin')
      check('SC8 fairness setup: long a1 round is in transfer (throttled PUT on the wire)', bigSeen && stateOf('a1').state === 'running' && endsOf('a1') === 1, `seen=${bigSeen} ends=${endsOf('a1')}`)
      await clock.advance(3000) // a2 的 +2s watch 预订到期 → tick 发射（非插队入队；origin 忙 → 留队）
      await waitReal(() => stateOf('a2').state === 'queued', 3000)
      await clock.advance(31000) // a2 队内等待 ≥ FAIRNESS_STARVE_MS(30s) → 被饿死标记
      check('SC8 starved a2 still queued while origin A busy', stateOf('a2').state === 'queued', JSON.stringify(stateOf('a2')))
      const pA3 = sched.syncNow('a3') // manual 插队：只能排在被饿死的 a2 之后
      await Promise.all([pA1big, pA2b, pA3])
      const idxA2Rerun = events.map((e) => (e.type === 'round-end' && e.dirId === 'a2' ? 1 : 0)).lastIndexOf(1)
      const idxA3 = events.findIndex((e) => e.type === 'round-end' && e.dirId === 'a3')
      check('SC8 fairness: starved interval/watch round runs before later manual jump-ins', idxA2Rerun >= 0 && idxA3 > idxA2Rerun, `a2Rerun=${idxA2Rerun} a3=${idxA3}`)

      // —— 全局上限（prefs.schedulerMaxConcurrent=1）：不同 origin 也不许并行
      setSCConfig(
        [
          { id: 'a1', localPath: A1, remotePath: '/sc8a1', mode: 'two-way' },
          { id: 'a2', localPath: A2, remotePath: '/sc8a2', mode: 'two-way' },
          { id: 'a3', localPath: A3, remotePath: '/sc8a3', mode: 'two-way' },
          { id: 'b1', localPath: B1, remotePath: '/sc8b1', mode: 'two-way', serverUrl: `http://127.0.0.1:${PORT2}/dav/` },
        ],
        { autoSync: false, schedulerMaxConcurrent: 1 }
      )
      await sched.reload()
      // cap 轮的长传输文件（768KB ≈ 3.6s）：确保采样点落在 a1 传输中而 b1 未跑完
      await fsp.writeFile(path.join(A1, 'cap-throttle.bin'), Buffer.alloc(768 * 1024, 3))
      await fsp.writeFile(path.join(B1, 'cap-throttle.bin'), Buffer.alloc(768 * 1024, 3))
      const endsBeforeCap = endsOf('a1') + endsOf('b1')
      const pCapA = sched.syncNow('a1')
      const pCapB = sched.syncNow('b1')
      // 谁先入队是锁读竞态：锁住「实际先跑者」断言（顺序无关）—— 恰一个 running、
      // 另一个 queued（cap=1 下不同 origin 也不并行），先跑者在传输中（reqlog 锚定）
      const capPair = await waitReal(() => {
        const ca = stateOf('a1')
        const cb = stateOf('b1')
        return (ca.state === 'running') !== (cb.state === 'running') && (ca.state === 'queued' || cb.state === 'queued')
      }, 5000)
      const runCap = stateOf('a1').state === 'running' ? 'a1' : 'b1'
      const capSeen = await waitForLineIn(runCap === 'a1' ? log1 : log2, `PUT /dav/sc8${runCap}/cap-throttle.bin`)
      check(
        'SC8 global cap (schedulerMaxConcurrent=1) serializes even different origins',
        capPair && capSeen && stateOf(runCap).state === 'running' && endsOf('a1') + endsOf('b1') === endsBeforeCap,
        `capPair=${capPair} run=${runCap} seen=${capSeen} ends=${endsOf('a1') + endsOf('b1')}/${endsBeforeCap}`
      )
      const [rCapA, rCapB] = await Promise.all([pCapA, pCapB])
      check('SC8 capped rounds both complete with uploads', rCapA.ok === true && rCapB.ok === true && rCapA.summary.uploaded === 1 && rCapB.summary.uploaded === 1, JSON.stringify([rCapA.ok, rCapB.ok]))
      sched.cleanup()
      await fsp.rm(A1, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(A2, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(A3, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(B1, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'sc8a1'), { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'sc8a2'), { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'sc8a3'), { recursive: true, force: true }).catch(() => {})
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-throttle'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT2, '.wdsync-test-throttle'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT2, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT2, '.wdsync-test-reqlog.log'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'sc8b1'), { recursive: true, force: true }).catch(() => {})
      server2.kill()
      await fsp.rm(ROOT2, { recursive: true, force: true }).catch(() => {})
    }
  })

  // ---- SC9（慢，假时钟）：跨轮退避 / 开放意图 follow-up / 让出重排 / 时钟跳变 ----

  // [慢组登记原因] 503×4 重试链 ×5（~3.5s/轮）+ netcut 恢复轮 ×7 + 真实 watch 去抖（~2.5s）
  await slowSection('SC9：跨轮退避 / follow-up / yield / 时钟跳变', '503×4 重试链 ×5（~3.5s/轮）+ netcut 恢复轮 ×7 + 真实 watch 去抖（~2.5s）', async () => {
    mountScZtools() // 幂等：fast/slow 过滤下 SC1 可能未运行
    const err503 = path.join(ROOT, '.wdsync-test-err503')
    const setErr503 = async (on) => {
      if (on) fs.writeFileSync(err503, 'x')
      else await fsp.rm(err503, { force: true }).catch(() => {})
    }

    // ===== A 段（sc9a，stopWatch）：退避起算 / 指数与上限 / 成功清零 / 手动无视 / 跳变 =====
    {
      await freshStore('sc9a')
      const LP = await tmpLocal('sc9a')
      await fsp.writeFile(path.join(LP, 'g.txt'), 'sc9a-good')
      setSCConfig([{ id: 'd1', localPath: LP, remotePath: '/sc9a', mode: 'two-way' }], { autoSync: true, intervalMin: 1, leaseLock: false })
      const clock = makeFakeClock()
      const sched = createTestSched({ now: clock.now, timers: clock.timers })
      const events = []
      sched.subscribe((e) => events.push(e))
      const slotSnap = () => sched.getSnapshot().slots[0]
      try {
        await sched.init()
        await pumpUntil(clock, () => sched.getSnapshot().leader.isLeader === true, 8000, 8000)
        services.fsx.stopWatch(`${sched.instanceId}:d1`) // 假时钟节纪律：显式摘 watcher
        // 干净首轮：能力缓存落定 + g.txt 上传 + interval 预订（+60s）
        const clean = await sched.syncNow('d1')
        check('SC9a clean round succeeds and books interval', clean.ok === true && slotSnap().nextDueKind === 'interval', JSON.stringify(slotSnap().nextDueKind))

        // —— 退避起算：第 1 轮网络失败不计起（fails=1 < 2），第 2 轮起退避
        await setErr503(true)
        await fsp.writeFile(path.join(LP, 'bad1.txt'), 'sc9a-bad1')
        const f1 = await sched.syncNow('d1')
        const sAfter1 = slotSnap()
        check('SC9a first network failure keeps interval booking (fails=1 below threshold)', f1.ok === false && sAfter1.backoff.fails === 1 && sAfter1.nextDueKind === 'interval', JSON.stringify({ fails: sAfter1.backoff.fails, kind: sAfter1.nextDueKind }))
        const f2 = await sched.syncNow('d1')
        const sAfter2 = slotSnap()
        const dueIn2 = sAfter2.nextDueAt - clock.now()
        check(
          'SC9a second consecutive failure arms backoff (interval×2^1, kind=backoff)',
          f2.ok === false && sAfter2.backoff.fails === 2 && sAfter2.nextDueKind === 'backoff' && sAfter2.backoff.until === sAfter2.nextDueAt && dueIn2 > 110000 && dueIn2 < 130000,
          `fails=${sAfter2.backoff.fails} kind=${sAfter2.nextDueKind} dueIn=${dueIn2}ms`
        )
        const failEnds = events.filter((e) => e.type === 'round-end' && e.error != null)
        check(
          'SC9a failing rounds expose failureClass=network (machine-readable backoff input)',
          failEnds.length === 2 && failEnds.every((e) => e.summary && e.summary.failureClass === 'network'),
          JSON.stringify(failEnds.map((e) => e.summary && e.summary.failureClass))
        )
        // —— 退避到期 → 轮恢复 → 成功清零回 interval
        await setErr503(false)
        const endsBefore = events.filter((e) => e.type === 'round-end').length
        await clock.advance(dueIn2 + 2000, 4000)
        // 高负载下轮体真实耗时可显著拉长：25s 预算（假时钟只管调度决策）
        await waitReal(() => events.filter((e) => e.type === 'round-end').length > endsBefore, 25000)
        const sRecover = slotSnap()
        check(
          'SC9a backoff-expiry round recovers, clears backoff and rebooks interval',
          sRecover.backoff.fails === 0 && sRecover.backoff.until === 0 && sRecover.nextDueKind === 'interval' && (await fsp.readFile(path.join(ROOT, 'sc9a', 'bad1.txt'), 'utf-8').catch(() => '')) === 'sc9a-bad1',
          JSON.stringify({ fails: sRecover.backoff.fails, kind: sRecover.nextDueKind })
        )

        // —— 手动无视退避且成功后清零：重新武装（新失败目标 bad2 + 2 轮失败）后立刻手动成功
        await setErr503(true)
        await fsp.writeFile(path.join(LP, 'bad2.txt'), 'sc9a-bad2')
        await sched.syncNow('d1')
        await sched.syncNow('d1')
        const sArmed = slotSnap()
        check('SC9a backoff re-armed for manual-bypass subcase', sArmed.backoff.fails === 2 && sArmed.nextDueKind === 'backoff' && sArmed.backoff.until > clock.now(), JSON.stringify({ fails: sArmed.backoff.fails, kind: sArmed.nextDueKind }))
        await setErr503(false)
        const manual = await sched.syncNow('d1') // 退避期内手动：立即执行并成功（bad2 落盘）
        const sManual = slotSnap()
        check(
          'SC9a manual sync ignores backoff and success clears it',
          manual.ok === true && (await fsp.readFile(path.join(ROOT, 'sc9a', 'bad2.txt'), 'utf-8').catch(() => '')) === 'sc9a-bad2' && sManual.backoff.fails === 0 && sManual.backoff.until === 0 && sManual.nextDueKind === 'interval',
          JSON.stringify({ ok: manual.ok, fails: sManual.backoff.fails, kind: sManual.nextDueKind })
        )

        // —— 时钟跳变（睡眠唤醒模拟：单步大推进 → tick 间隔 > 5s）：到期任务延迟 5–10s 补跑
        const dueBeforeJump = slotSnap().nextDueAt
        const endsBeforeJump = events.filter((e) => e.type === 'round-end').length
        await clock.advance(120000, 120000) // 单步推进（slice=120s）→ 唤醒级跳变
        const sJump = slotSnap()
        const jumpIn = sJump.nextDueAt - clock.now()
        check(
          'SC9a clock jump delays due tasks by 5-10s instead of firing immediately',
          events.filter((e) => e.type === 'round-end').length === endsBeforeJump && sJump.state === 'scheduled' && sJump.nextDueKind === 'interval' && jumpIn > 0 && jumpIn <= 10000 && sJump.nextDueAt > dueBeforeJump,
          `state=${sJump.state} kind=${sJump.nextDueKind} dueIn=${jumpIn}ms roundsFired=${events.filter((e) => e.type === 'round-end').length - endsBeforeJump}`
        )
        await clock.advance(jumpIn + 1000) // 小步推进到补跑点 → 轮发射（noop 成功）
        await waitReal(() => events.filter((e) => e.type === 'round-end').length > endsBeforeJump, 25000)
        check('SC9a jump catch-up round eventually fires', slotSnap().nextDueKind === 'interval', '')

        // —— 跳变宽限：跳变后 60s 内的网络类失败不计入退避（新失败目标 bad3）
        await setErr503(true)
        await fsp.writeFile(path.join(LP, 'bad3.txt'), 'sc9a-bad3')
        const endsBeforeGrace = events.filter((e) => e.type === 'round-end').length
        await clock.advance(120000, 120000) // 再跳一次（到期任务 → 延迟补跑点）
        await clock.advance(15000) // 推进到补跑点 → 轮发射（真实 IO + 503 重试链）
        await waitReal(() => {
          const le = [...events].reverse().find((e) => e.type === 'round-end')
          return le && le.error != null && events.filter((e) => e.type === 'round-end').length > endsBeforeGrace
        }, 25000)
        const sGrace = slotSnap()
        const lastEnd = [...events].reverse().find((e) => e.type === 'round-end')
        check(
          'SC9a network failure within jump grace does not count toward backoff',
          sGrace.backoff.fails === 0 && lastEnd.error != null && lastEnd.summary && lastEnd.summary.failureClass === 'network',
          `fails=${sGrace.backoff.fails} cls=${lastEnd.summary && lastEnd.summary.failureClass}`
        )
        await setErr503(false)
        await clock.advance(slotSnap().nextDueAt - clock.now() + 2000, 4000)
        await waitReal(() => {
          const le = [...events].reverse().find((e) => e.type === 'round-end')
          return le && le.error == null
        }, 15000)
        check('SC9a recovers after grace window (bad3 uploaded)', (await fsp.readFile(path.join(ROOT, 'sc9a', 'bad3.txt'), 'utf-8').catch(() => '')) === 'sc9a-bad3', '')
      } finally {
        await setErr503(false)
        sched.cleanup()
        await fsp.rm(LP, { recursive: true, force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, 'sc9a'), { recursive: true, force: true }).catch(() => {})
      }
    }

    // ===== A2 段（sc9a2，watcher 存活）：退避期 watch 触发只合并成一个到期点 =====
    {
      await freshStore('sc9a2')
      const LP = await tmpLocal('sc9a2')
      await fsp.writeFile(path.join(LP, 'bad1.txt'), 'sc9a2-bad1') // 故障轮的上传目标（初始无干净轮：无需能力缓存预热？——需要！见下）
      setSCConfig([{ id: 'd1', localPath: LP, remotePath: '/sc9a2', mode: 'two-way' }], { autoSync: true, intervalMin: 1, leaseLock: false })
      const clock = makeFakeClock()
      const sched = createTestSched({ now: clock.now, timers: clock.timers })
      const events = []
      sched.subscribe((e) => events.push(e))
      const slotSnap = () => sched.getSnapshot().slots[0]
      try {
        await sched.init()
        await pumpUntil(clock, () => sched.getSnapshot().leader.isLeader === true, 8000, 8000)
        // 本段保留真实 watcher（「退避期 watch 合并」的被测对象）。watcher 存活期间的
        // 受控写入序列：① 干净手动轮先传 bad1（能力缓存落定，避免后续探测 PUT 撞
        // 503 归 C 档）；② 故障开 → 改写 bad1（触发一次 watch → 该 watch 轮即第 1 个
        // 失败轮）；③ 手动补第 2 个失败轮 → 退避武装；④ 写 w.txt —— 唯一被断言的
        // 「退避期内 watch 触发」。
        const clean = await sched.syncNow('d1')
        await setErr503(true)
        await fsp.writeFile(path.join(LP, 'bad1.txt'), 'sc9a2-bad1-v2')
        await waitReal(() => events.filter((e) => e.type === 'round-end' && e.error != null).length >= 1, 15000) // watch 轮失败（第 1 轮）
        await sched.syncNow('d1') // 第 2 个失败轮 → 退避武装
        const armed = slotSnap()
        const endsArmed = events.filter((e) => e.type === 'round-end').length
        check('SC9a2 backoff armed (two failing rounds)', armed.backoff.fails === 2 && armed.nextDueKind === 'backoff', JSON.stringify({ fails: armed.backoff.fails, kind: armed.nextDueKind }))
        // 退避期内写 w.txt → 真实去抖（1.5s）→ watch 触发被合并（不排队不提前）
        await fsp.writeFile(path.join(LP, 'w.txt'), 'sc9a2-watch-held')
        await waitReal(() => slotSnap().watchHeld === true, 5000)
        const held = slotSnap()
        check(
          'SC9a2 watch trigger during backoff is merged into the backoff due point (no early run)',
          held.watchHeld === true && held.nextDueKind === 'backoff' && held.nextDueAt === armed.nextDueAt && events.filter((e) => e.type === 'round-end').length === endsArmed && held.state === 'scheduled',
          JSON.stringify({ watchHeld: held.watchHeld, kind: held.nextDueKind, same: held.nextDueAt === armed.nextDueAt })
        )
        await setErr503(false)
        await clock.advance(held.nextDueAt - clock.now() + 2000, 4000)
        await waitReal(() => events.filter((e) => e.type === 'round-end').length > endsArmed, 15000)
        const settled = slotSnap()
        const wRemote = await fsp.readFile(path.join(ROOT, 'sc9a2', 'w.txt'), 'utf-8').catch(() => '')
        check(
          'SC9a2 backoff-expiry round absorbs the held watch change (no data loss) and clears the flag',
          settled.watchHeld === false && settled.backoff.fails === 0 && wRemote === 'sc9a2-watch-held',
          JSON.stringify({ watchHeld: settled.watchHeld, fails: settled.backoff.fails, w: wRemote })
        )
      } finally {
        await setErr503(false)
        sched.cleanup()
        await fsp.rm(LP, { recursive: true, force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, 'sc9a2'), { recursive: true, force: true }).catch(() => {})
      }
    }

    // ===== B 段（sc9b，stopWatch）：开放意图 follow-up 优先于退避 + 无进展回落 =====
    {
      await freshStore('sc9b')
      const LP = await tmpLocal('sc9b')
      const big = Buffer.alloc(1024 * 1024)
      big.fill('b')
      await fsp.writeFile(path.join(LP, 'big.bin'), big)
      // autoSync 必须 true：follow-up 属自动调度轮（tick 的 autoSync 门控）；
      // 假时钟节纪律 —— 选举后显式摘 watcher（本段无受控写入需求）
      setSCConfig([{ id: 'd1', localPath: LP, remotePath: '/sc9b', mode: 'two-way' }], { autoSync: true, intervalMin: 1, leaseLock: false })
      const clock = makeFakeClock()
      const sched = createTestSched({ now: clock.now, timers: clock.timers })
      const events = []
      sched.subscribe((e) => events.push(e))
      const slotSnap = () => sched.getSnapshot().slots[0]
      const netcut = path.join(ROOT, '.wdsync-test-netcut')
      const partialput = path.join(ROOT, '.wdsync-test-partialput')
      try {
        await sched.init()
        await pumpUntil(clock, () => sched.getSnapshot().leader.isLeader === true, 8000, 8000)
        services.fsx.stopWatch(`${sched.instanceId}:d1`)
        fs.writeFileSync(partialput, 'x')
        fs.writeFileSync(netcut, '2:6') // 每路径前 6 次 PUT 在第 2 块后断连
        // R1（手动）：上传被断 → NETWORK + 开放意图 1 → follow-up 预订（30–60s 抖动）
        const r1 = await sched.syncNow('d1')
        const s1 = slotSnap()
        const fu1 = s1.nextDueAt - clock.now()
        check(
          'SC9b open intent books a jittered follow-up (30-60s) after the interrupted round',
          r1.ok === false && s1.nextDueKind === 'follow-up' && s1.followUp.count === 1 && fu1 >= 29000 && fu1 <= 61000,
          `kind=${s1.nextDueKind} count=${s1.followUp.count} dueIn=${fu1}ms`
        )
        // R2（follow-up 轮）：再断 → fails=2（退避已够格）但 openIntents>0 → follow-up 优先
        await clock.advance(fu1 + 1000)
        await waitReal(() => events.filter((e) => e.type === 'round-end').length >= 2, 15000)
        const s2 = slotSnap()
        check(
          'SC9b follow-up takes priority over cross-round backoff (fails>=2 while kind=follow-up)',
          s2.backoff.fails >= 2 && s2.nextDueKind === 'follow-up' && s2.followUp.count === 2,
          JSON.stringify({ fails: s2.backoff.fails, kind: s2.nextDueKind, count: s2.followUp.count })
        )
        // R3 起：开放意图数不降（netcut 半截的网络失败轮与「不齐整半截→冲突 defer」
        // 轮都保持 openIntents=1）→ 持续 follow-up；断言「无进展回落」最终发生且
        // follow 状态清零（对两条引擎路径都稳健，不逐轮断言 np 值）
        let roundNo = 2
        let fellBack = false
        for (let guard = 0; guard < 8 && !fellBack; guard++) {
          const sn = slotSnap()
          if (sn.nextDueKind !== 'follow-up') {
            fellBack = true
            break
          }
          roundNo++
          await clock.advance(sn.nextDueAt - clock.now() + 1000, 4000)
          await waitReal(() => events.filter((e) => e.type === 'round-end').length >= roundNo, 15000)
        }
        const sF = slotSnap()
        check(
          'SC9b five no-progress follow-ups fall back to regular scheduling (follow state reset)',
          sF.nextDueKind !== 'follow-up' && sF.followUp.count === 0 && sF.followUp.noProgress === 0 && (sF.nextDueKind === 'interval' || sF.nextDueKind === 'backoff'),
          JSON.stringify({ kind: sF.nextDueKind, count: sF.followUp.count, np: sF.followUp.noProgress, fails: sF.backoff.fails })
        )
        // 收敛：移除断连与半截保留；若半截已被判为冲突挂起，落 choice 后下一轮解决
        await fsp.rm(netcut, { force: true }).catch(() => {})
        await fsp.rm(partialput, { force: true }).catch(() => {})
        const pendingsB = await services.sync.listPendingConflicts({ id: 'd1', localPath: LP, remotePath: '/sc9b', mode: 'two-way' })
        if (pendingsB.some((p) => p.rel === 'big.bin' && !p.choice)) {
          await services.sync.setPendingChoice({ id: 'd1', localPath: LP, remotePath: '/sc9b', mode: 'two-way' }, 'big.bin', 'local')
        }
        await clock.advance(sF.nextDueAt - clock.now() + 2000, 4000)
        await waitReal(() => {
          const le = [...events].reverse().find((e) => e.type === 'round-end')
          return le && le.error == null && le.summary && le.summary.uploaded === 1
        }, 20000)
        const s7 = slotSnap()
        const remoteBig = await fsp.readFile(path.join(ROOT, 'sc9b', 'big.bin')).catch(() => Buffer.alloc(0))
        check(
          'SC9b post-fallback round re-uploads the interrupted file and resets to interval',
          s7.nextDueKind === 'interval' && s7.followUp.count === 0 && remoteBig.length === big.length && remoteBig.equals(big),
          JSON.stringify({ kind: s7.nextDueKind, remoteLen: remoteBig.length })
        )
      } finally {
        await fsp.rm(netcut, { force: true }).catch(() => {})
        await fsp.rm(partialput, { force: true }).catch(() => {})
        sched.cleanup()
        await fsp.rm(LP, { recursive: true, force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, 'sc9b'), { recursive: true, force: true }).catch(() => {})
      }
    }

    // ===== C 段（sc9c，stopWatch）：让出重排（15–45s 抖动）与连续让出收敛 =====
    {
      await freshStore('sc9c')
      const LP = await tmpLocal('sc9c')
      await fsp.writeFile(path.join(LP, 'a.txt'), 'sc9c-a')
      // autoSync true：yield-retry / 收敛后的 interval 轮都要经 tick 发射；选举后摘 watcher
      setSCConfig([{ id: 'd1', localPath: LP, remotePath: '/sc9c', mode: 'two-way' }], { autoSync: true, intervalMin: 1 })
      const lockPath = path.join(ROOT, 'sc9c', '.webdav-sync.lock')
      const clock = makeFakeClock()
      const sched = createTestSched({ now: clock.now, timers: clock.timers })
      const events = []
      sched.subscribe((e) => events.push(e))
      const slotSnap = () => sched.getSnapshot().slots[0]
      try {
        await sched.init()
        await pumpUntil(clock, () => sched.getSnapshot().leader.isLeader === true, 8000, 8000)
        services.fsx.stopWatch(`${sched.instanceId}:d1`)
        // 他人新鲜租约锁 → 让出（L2 同款预置）。连续 5 次手动轮全部让出：
        // 前 4 次 → yield-retry（15–45s 抖动，不计失败不清退避）；第 5 次 → interval 收敛
        await fsp.mkdir(path.join(ROOT, 'sc9c'), { recursive: true })
        await fsp.writeFile(lockPath, JSON.stringify({ v: 1, deviceId: 'device-sc9-peer', startedAt: new Date().toISOString(), ttlMs: 180000 }))
        for (let i = 1; i <= 4; i++) {
          const ry = await sched.syncNow('d1')
          const sy = slotSnap()
          const yIn = sy.nextDueAt - clock.now()
          check(
            `SC9c yield #${i} reschedules with 15-45s jitter (not a failure, backoff untouched)`,
            ry.ok === true && ry.summary && ry.summary.yielded === true && sy.nextDueKind === 'yield-retry' && yIn >= 14000 && yIn <= 46000 && sy.backoff.fails === 0,
            `kind=${sy.nextDueKind} dueIn=${yIn}ms fails=${sy.backoff.fails}`
          )
        }
        // 第 5 次连续让出 → 按 interval 收敛（不再抖动重排）
        const r5 = await sched.syncNow('d1')
        const s5 = slotSnap()
        check('SC9c five consecutive yields converge to interval scheduling', r5.ok === true && r5.summary && r5.summary.yielded === true && s5.nextDueKind === 'interval', `kind=${s5.nextDueKind}`)
        // 释放锁 → 到期轮正常完成上传（收敛后的 interval 预订由 tick 发射）
        await fsp.rm(lockPath, { force: true }).catch(() => {})
        const endsC = events.filter((e) => e.type === 'round-end').length
        await clock.advance(s5.nextDueAt - clock.now() + 2000, 4000)
        await waitReal(() => events.filter((e) => e.type === 'round-end').length > endsC, 15000)
        check('SC9c round syncs normally after peer releases the lease', (await fsp.readFile(path.join(ROOT, 'sc9c', 'a.txt'), 'utf-8').catch(() => '')) === 'sc9c-a', '')
      } finally {
        sched.cleanup()
        await fsp.rm(LP, { recursive: true, force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, 'sc9c'), { recursive: true, force: true }).catch(() => {})
      }
    }
  })

  // ---- SC9B（快）：策略档位覆盖（P2 / B 档）—— mixed 失败类同样计入跨轮退避 ----

  await section('SC9B：策略档位覆盖（P2 · mixed 计入退避）', async () => {
    mountScZtools() // 幂等：fast/slow 过滤下 SC1 可能未运行
    await setProfile('p2')
    try {
      await freshStore('sc9p2')
      const LP = await tmpLocal('sc9p2')
      await fsp.mkdir(path.join(LP, 'dedupfail'), { recursive: true })
      await fsp.writeFile(path.join(LP, 'dedupfail', 'f1.txt'), 'sc9p2-f1')
      await fsp.writeFile(path.join(LP, 't1.toolarge.txt'), 'sc9p2-too-large')
      // autoSync true：backoff-expiry 轮经 tick 发射（自动调度门控）；选举后摘 watcher
      setSCConfig([{ id: 'd1', localPath: LP, remotePath: '/sc9p2', mode: 'two-way' }], { autoSync: true, intervalMin: 1, leaseLock: false })
      const clock = makeFakeClock()
      const sched = createTestSched({ now: clock.now, timers: clock.timers })
      const events = []
      sched.subscribe((e) => events.push(e))
      const slotSnap = () => sched.getSnapshot().slots[0]
      const dedupfail = path.join(ROOT, '.wdsync-test-dedupfail')
      const fail413 = path.join(ROOT, '.wdsync-test-fail413')
      try {
        await sched.init()
        await pumpUntil(clock, () => sched.getSnapshot().leader.isLeader === true, 8000, 8000)
        services.fsx.stopWatch(`${sched.instanceId}:d1`) // 假时钟节纪律：本段无受控写入
        fs.writeFileSync(dedupfail, '503')
        fs.writeFileSync(fail413, 'x')
        // 第 1 轮：查重 503（网络类）+ 413（永久类）→ failureClass 'mixed'
        const m1 = await sched.syncNow('d1')
        const e1 = [...events].reverse().find((e) => e.type === 'round-end')
        check(
          'SC9B mixed round (network + permanent errors) reports failureClass=mixed',
          m1.ok === false && e1 && e1.summary && e1.summary.failureClass === 'mixed' && slotSnap().backoff.fails === 1,
          JSON.stringify({ cls: e1 && e1.summary && e1.summary.failureClass, fails: slotSnap().backoff.fails })
        )
        // 第 2 轮（413 已进永久退避表被跳过，查重仍 503 → network）：fails=2 → 退避武装
        const m2 = await sched.syncNow('d1')
        const s2 = slotSnap()
        check(
          'SC9B mixed-counted failure arms backoff on the next consecutive failure (B tier)',
          m2.ok === false && s2.backoff.fails === 2 && s2.nextDueKind === 'backoff',
          JSON.stringify({ fails: s2.backoff.fails, kind: s2.nextDueKind })
        )
        // 故障移除 → 退避到期轮恢复（dedupfail 文件上传、toolarge 按退避表跳过不报错）
        await fsp.rm(dedupfail, { force: true }).catch(() => {})
        await fsp.rm(fail413, { force: true }).catch(() => {})
        const endsB = events.filter((e) => e.type === 'round-end').length
        await clock.advance(s2.nextDueAt - clock.now() + 2000, 4000)
        await waitReal(() => events.filter((e) => e.type === 'round-end').length > endsB, 20000)
        const rec = [...events].reverse().find((e) => e.type === 'round-end')
        const f1Remote = await fsp.readFile(path.join(ROOT, 'sc9p2', 'dedupfail', 'f1.txt'), 'utf-8').catch(() => '')
        check(
          'SC9B backoff-expiry round recovers at B tier and clears backoff (f1 converged)',
          rec && rec.error == null && slotSnap().backoff.fails === 0 && slotSnap().nextDueKind === 'interval' && f1Remote === 'sc9p2-f1',
          JSON.stringify({ err: rec && rec.error, fails: slotSnap().backoff.fails, kind: slotSnap().nextDueKind, f1: f1Remote })
        )
      } finally {
        await fsp.rm(dedupfail, { force: true }).catch(() => {})
        await fsp.rm(fail413, { force: true }).catch(() => {})
        sched.cleanup()
        await fsp.rm(LP, { recursive: true, force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, 'sc9p2'), { recursive: true, force: true }).catch(() => {})
      }
    } finally {
      await setProfile(null)
    }
  })

  // ---- SC10（快，假时钟）：后台冲突 defer 挂起的系统提醒（同批一次）与 summarizeRound 直检 ----

  await section('SC10：挂起冲突提醒与 summarizeRound 直检', async () => {
    mountScZtools() // 幂等：fast/slow 过滤下 SC1 可能未运行
    // 挂起冲突的 defer 语义（后台轮一律挂起、轮末「部分完成」）已由 SC3 覆盖；本节
    // 验证提醒链路：新的无 choice 挂起 → ztools.showNotification 一次（同批
    // 不重复），处理后再出现新集合才再提醒；pending-conflicts 事件携带 newlyNotified。
    const notes = []
    const zt = global.window.ztools
    zt.showNotification = (body) => notes.push(String(body))
    try {
      await freshStore('sc10')
      const LP = await tmpLocal('sc10')
      await fsp.writeFile(path.join(LP, 'c1.txt'), 'sc10-local-v1')
      await fsp.mkdir(path.join(ROOT, 'sc10'), { recursive: true })
      await fsp.writeFile(path.join(ROOT, 'sc10', 'c1.txt'), 'sc10-remote-v1')
      const sc10dir = { id: 'd1', localPath: LP, remotePath: '/sc10', mode: 'two-way' }
      setSCConfig([sc10dir], { autoSync: true, intervalMin: 1 })
      const clock = makeFakeClock()
      const sched = createTestSched({ now: clock.now, timers: clock.timers })
      const events = []
      sched.subscribe((e) => events.push(e))
      const slotSnap = () => sched.getSnapshot().slots[0]
      const pendings = () => events.filter((e) => e.type === 'pending-conflicts')
      try {
        await sched.init()
        await pumpUntil(clock, () => sched.getSnapshot().leader.isLeader === true, 8000, 8000)
        services.fsx.stopWatch(`${sched.instanceId}:d1`) // 假时钟节纪律：摘 watcher，用 interval 轮驱动
        // 第 1 个 interval 轮：双侧同改无基线 → 冲突 → defer 挂起 + 提醒一次
        await clock.advance(61000)
        await waitReal(() => pendings().length >= 1, 15000)
        const p1 = pendings()[0]
        check(
          'SC10 first deferred conflict emits pending event and notifies once',
          p1 && p1.dirId === 'd1' && p1.newlyNotified === true && p1.items.some((it) => it.rel === 'c1.txt' && !it.choice) && notes.length === 1 && /1 个文件需要你选择保留哪一个/.test(notes[0] || ''),
          JSON.stringify({ newly: p1 && p1.newlyNotified, notes: notes.length })
        )
        // 第 2 个 interval 轮：同一挂起集合 → 不再提醒（同批去重）
        const endsBefore2 = events.filter((e) => e.type === 'round-end').length
        await clock.advance(61000)
        await waitReal(() => events.filter((e) => e.type === 'round-end').length > endsBefore2, 15000)
        await sleep(300) // pending 事件异步外发
        check('SC10 same pending batch never re-notifies', notes.length === 1, `notes=${notes.length}`)
        // 用户统一处理：落 choice → 下一轮自动解决
        check('SC10 setPendingChoice accepted by engine', (await services.sync.setPendingChoice(sc10dir, 'c1.txt', 'local')) === true, '')
        const endsBefore3 = events.filter((e) => e.type === 'round-end').length
        await clock.advance(slotSnap().nextDueAt - clock.now() + 2000, 4000)
        await waitReal(() => events.filter((e) => e.type === 'round-end').length > endsBefore3, 15000)
        check(
          'SC10 pending choice auto-resolves on the next round (local wins, no defer)',
          (await fsp.readFile(path.join(ROOT, 'sc10', 'c1.txt'), 'utf-8').catch(() => '')) === 'sc10-local-v1' && slotSnap().nextDueKind === 'interval',
          ''
        )
        // 新一批冲突（不同文件）→ 再提醒一次
        await fsp.writeFile(path.join(LP, 'c2.txt'), 'sc10-local-v2')
        await fsp.writeFile(path.join(ROOT, 'sc10', 'c2.txt'), 'sc10-remote-v2')
        await clock.advance(slotSnap().nextDueAt - clock.now() + 2000, 4000)
        await waitReal(() => notes.length === 2, 20000)
        const lastPending = [...pendings()].pop()
        check(
          'SC10 a NEW pending set notifies again only after the previous one was handled',
          notes.length === 2 && /1 个文件需要你选择保留哪一个/.test(notes[1]) && lastPending && lastPending.newlyNotified === true && lastPending.items.some((it) => it.rel === 'c2.txt'),
          JSON.stringify({ notes: notes.length, newly: lastPending && lastPending.newlyNotified })
        )
        // 「暂时忽略」：清除挂起（该文件再冲突时才重新询问），不触发提醒
        check('SC10 clearPendingConflict (ignore for now) removes the record', (await services.sync.clearPendingConflict(sc10dir, 'c2.txt')) === true, '')
      } finally {
        sched.cleanup()
        await fsp.rm(LP, { recursive: true, force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, 'sc10'), { recursive: true, force: true }).catch(() => {})
      }

      // —— summarizeRound 纯函数直检（渲染层熔断归因 / 噪声折叠 / 部分完成文案）——
      const sr = services.scheduler.summarizeRound
      const noise = '无法列举远端目录（CIRCUIT_OPEN：连续失败达到 5 次）'
      const rBreaker = sr({ breaker: { open: true, consecutive: 5, reason: 'PUT 127.0.0.1:5360：HTTP 503' }, errors: [noise, noise, noise, 'other'] }, null, false)
      check(
        'SC10 summarizeRound: breaker tone with folded CIRCUIT_OPEN noise',
        rBreaker.tone === 'breaker' && rBreaker.title === '服务器一直没有响应，本次同步已暂停，稍后自动重试' && /HTTP 503/.test(rBreaker.detail) && rBreaker.errors.length === 2 && rBreaker.errors[0].startsWith(noise) && rBreaker.errors[0].includes('重复 3 次') && rBreaker.errors[1] === 'other',
        JSON.stringify(rBreaker)
      )
      const rPartial = sr({ deferredConflicts: 3, errors: [] }, null, false)
      check('SC10 summarizeRound: deferred round reads as partial completion', rPartial.tone === 'partial' && rPartial.title === '部分完成：3 个文件等你选择', JSON.stringify(rPartial))
      const rCancel = sr(null, '同步已中止：用户取消', true)
      check('SC10 summarizeRound: cancelled tone', rCancel.tone === 'cancelled' && rCancel.title === '已取消同步', '')
      const rOk = sr({ errors: [] }, null, false)
      check('SC10 summarizeRound: clean round reads ok', rOk.tone === 'ok' && rOk.title === '同步完成', '')
      const rErr = sr({ errors: ['e1', 'e1'] }, null, false)
      check('SC10 summarizeRound: repeated identical errors fold with count', rErr.tone === 'error' && rErr.errors.length === 1 && rErr.errors[0].includes('重复 2 次'), JSON.stringify(rErr))
    } finally {
      delete zt.showNotification
    }
  })

  // ---- W10（快）：watcher 同名窄洞（注入事件形态）与 interval 兜底 ----
  // 窄洞（已知边界）：用户文件恰与被监听目录同名、且平台以 change 事件上报其
  // 修改时，会被 watchDir 的「目录自事件过滤器」一并吞掉（evt=change 且 filename 全等
  // 目录名）。Windows 的内容修改正是 change 形态（未在本机验证）；
  // macOS 实测（darwin 24.6 / Node 22，探针两次运行一致）：用户文件的创建 /
  // 覆盖 / 原地改写一律 rename 具名事件，change 只出现在目录自事件 —— 窄洞在 macOS
  // 上无法用真实用户写入构成。故窄洞本身用**注入事件形态**模拟：直接调用过滤器纯
  // 函数 _internals.ignoredWatchEvent 传入 {evt:'change', filename:目录名}（= Windows
  // 对同名文件内容修改的上报形态）。断言三层：
  //   ① 过滤器契约：窄洞形态被吞；同名 rename（macOS 实测形态）放行不漏报；异名
  //      change / 更深路径段 / null filename 放行；引擎临时名仍被吞；
  //   ② 窄洞后果 = watch 触发丢失：显式摘掉选举挂上的 watcher 等价模拟「事件被吞、
  //      无 watch 轮」（SC2 同款手法）；
  //   ③ interval 兜底：假时钟推到到期点发射的定时轮把该文件的修改同步上去，不丢数据
  //      （interval 按时发射本身由 SC2 覆盖，此处证的是「watch 丢触发后数据仍收敛」）。

  await section('W10：watcher 同名窄洞（注入事件形态）与 interval 兜底', async () => {
    mountScZtools() // 幂等：fast/slow 过滤下 SC1 可能未运行
    const ig = services.sync._internals.ignoredWatchEvent
    check('W10 filter swallows the same-name change event (the narrow hole, Windows modify form)', ig('w2hole', 'change', 'w2hole') === true, '')
    check('W10 filter passes same-name rename (macOS-observed form, no under-reporting)', ig('w2hole', 'rename', 'w2hole') === false, '')
    check('W10 filter passes change of a differently-named file', ig('w2hole', 'change', 'other.txt') === false, '')
    check('W10 filter passes deeper same-name path (subdir named like the dir is not the self event)', ig('w2hole', 'change', 'w2hole/sub.txt') === false, '')
    check('W10 filter still swallows engine temp names (root and nested)', ig('w2hole', 'rename', '.wdsync-dl-1-a') === true && ig('w2hole', 'change', 'sub/.wdsync-tmp-x') === true, '')
    check('W10 filter passes null-filename platform events (treated as user change)', ig('w2hole', 'rename', null) === false, '')

    await freshStore('w10')
    const W10_BASE = await tmpLocal('w10')
    const W10_DIR = path.join(W10_BASE, 'w2hole') // 被监听 / 同步的目录，basename 恰为 w2hole
    await fsp.mkdir(W10_DIR, { recursive: true })
    const sameNameRel = 'w2hole' // 用户文件恰与监听目录同名
    await fsp.writeFile(path.join(W10_DIR, sameNameRel), 'w10-v1')
    const w10dir = { id: 'd1', localPath: W10_DIR, remotePath: '/w10', mode: 'two-way' }
    setSCConfig([w10dir], { autoSync: true, intervalMin: 1 })
    const clock10 = makeFakeClock()
    const sched10 = createTestSched({ now: clock10.now, timers: clock10.timers })
    const ev10 = []
    sched10.subscribe((e) => ev10.push(e))
    try {
      await sched10.init()
      const elected10 = await pumpUntil(clock10, () => sched10.getSnapshot().leader.isLeader === true, 8000, 8000)
      check('W10 scheduler elected leader', elected10, JSON.stringify(sched10.getSnapshot().leader))
      // ② 模拟窄洞后果：选举挂上的 watcher 显式摘除 = 同名 change 事件被吞、无 watch 轮
      services.fsx.stopWatch(`${sched10.instanceId}:d1`)
      // 首轮手动：v1 上传 + 基线落地（interval 兜底「修改不丢」的对照基点）
      const r10a = await sched10.syncNow('d1')
      check(
        'W10 initial manual round uploads the same-name file',
        r10a.ok === true && r10a.summary && r10a.summary.uploaded === 1 && (await fsp.readFile(path.join(ROOT, 'w10', sameNameRel), 'utf-8')) === 'w10-v1',
        JSON.stringify(r10a.ok ? r10a.summary : r10a.error)
      )
      // 同名文件内容修改（Windows 上以 change 上报、被窄洞吞掉的那个形态）
      await fsp.writeFile(path.join(W10_DIR, sameNameRel), 'w10-v2-longer-content')
      const dueAt10 = sched10.getSnapshot().slots[0].nextDueAt
      const kind10 = sched10.getSnapshot().slots[0].nextDueKind
      check('W10 interval booking survives the manual round', kind10 === 'interval' && dueAt10 != null && dueAt10 > clock10.now(), `kind=${kind10} dueIn=${dueAt10 == null ? '-' : dueAt10 - clock10.now()}`)
      const endsBefore = ev10.filter((e) => e.type === 'round-end').length
      // 窄洞期间（下一次 interval 到期前）：无任何轮 —— watch 触发已丢，没有别的来源
      await clock10.advance(Math.max(0, dueAt10 - clock10.now() - 1500))
      const idleSnap10 = sched10.getSnapshot().slots[0]
      check(
        'W10 no round fires before the interval due point (watch trigger lost to the hole)',
        ev10.filter((e) => e.type === 'round-end').length === endsBefore && idleSnap10.state === 'scheduled' && idleSnap10.nextDueKind === 'interval',
        `roundEnds=${ev10.filter((e) => e.type === 'round-end').length}/${endsBefore} state=${idleSnap10.state} kind=${idleSnap10.nextDueKind}`
      )
      // ③ interval 到期 → 定时轮兜底：修改被同步、基线更新、后续 no-op
      await clock10.advance(dueAt10 - clock10.now() + 1200)
      const fallbackOk = await waitReal(() => ev10.filter((e) => e.type === 'round-end').length > endsBefore, 15000)
      const fallbackRound = ev10.find((e) => e.type === 'round-end' && e.summary && e.summary.uploaded === 1)
      check(
        'W10 interval round picks up the same-name file change (fallback syncs, no data loss)',
        fallbackOk && !!fallbackRound && fallbackRound.error == null,
        JSON.stringify(fallbackRound || {})
      )
      check(
        'W10 remote converges to the modified content and baseline follows',
        (await fsp.readFile(path.join(ROOT, 'w10', sameNameRel), 'utf-8')) === 'w10-v2-longer-content' && !!(await services.sync._internals.baselineEntry(w10dir, sameNameRel)),
        ''
      )
      check('W10 follow-up round is a no-op', isNoop(await syncP(W10_DIR, '/w10')), '')
    } finally {
      sched10.cleanup()
      await fsp.rm(W10_BASE, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'w10'), { recursive: true, force: true }).catch(() => {})
    }
  })

  // ---- SC11（快）：实验「ZTools 插件同步」目录合成 —— 自动发现 / 平台隔离远端 /
  //      开关与行级暂停 / 同 id 手改条目滤除 ----
  // 说明：插件目录发现走 ZTOOLS_DATA_ROOT 环境变量（与宿主 appDataPaths 同序）。
  // 该变量是进程级的，本节设置并在 finally 恢复 —— 绝不读到真实 ~/.ztools
  //（开发机存在装有插件的真目录，误同步会污染真实数据）。

  await section('SC11：实验 ZTools 插件同步（loadConfig 合成 + 端到端轮）', async () => {
    mountScZtools() // 幂等：fast/slow 过滤下 SC1 可能未运行
    const prevEnv = process.env.ZTOOLS_DATA_ROOT
    const ZT_ROOT = path.join(os.tmpdir(), `wdsync-e2e-sc11-ztroot-${Date.now()}`)
    const PLUGINS = path.join(ZT_ROOT, 'plugins')
    const sc11Sched = createTestSched()
    let ud11 = null
    try {
      // 模拟真实插件目录形态：目录插件与 asar 插件混放
      await fsp.mkdir(path.join(PLUGINS, 'plugin-a'), { recursive: true })
      await fsp.writeFile(path.join(PLUGINS, 'plugin-a', 'plugin.json'), '{"name":"plugin-a"}')
      await fsp.writeFile(path.join(PLUGINS, 'demo-b-0.1.0-ab12cd34.asar'), 'fake-asar-body')
      process.env.ZTOOLS_DATA_ROOT = ZT_ROOT

      // ① 公共 describe 入口：id 契约 + 自动发现 + 平台隔离远端
      const desc = services.ztoolsPlugins.describe()
      const platformKey = { darwin: 'mac', win32: 'windows', linux: 'linux' }[process.platform] || process.platform
      check(
        'SC11 describe discovers plugins dir and platform-isolated remote path',
        desc.id === 'ztools-plugins' && desc.pluginsDir === PLUGINS && desc.available === true && desc.remotePath === `/ztools-plugins/${platformKey}` && desc.platformKey === platformKey,
        JSON.stringify({ id: desc.id, pluginsDir: desc.pluginsDir, remotePath: desc.remotePath, available: desc.available })
      )

      // ② 开关关闭（缺省）：不合成虚拟目录
      await freshStore('sc11')
      ud11 = await tmpLocal('sc11')
      setSCConfig([{ id: 'ud1', localPath: ud11, remotePath: '/sc11-ud1', mode: 'two-way' }], { ztoolsPluginSync: false })
      await sc11Sched.init()
      await sc11Sched.reload()
      check('SC11 toggle off synthesizes no plugin slot', !sc11Sched.getSnapshot().slots.some((s) => s.id === 'ztools-plugins'), JSON.stringify(sc11Sched.getSnapshot().slots.map((s) => s.id)))

      // ③ 开关开启：合成 slot 与用户目录并存（固定 id）。autoSync 打开使
      // dirEligible 成立 —— 下方「只排 interval、无 startup 轮」的断言才有意义
      setSCConfig([{ id: 'ud1', localPath: ud11, remotePath: '/sc11-ud1', mode: 'two-way' }], { ztoolsPluginSync: true, autoSync: true })
      await sc11Sched.reload()
      const ids11 = sc11Sched.getSnapshot().slots.map((s) => s.id)
      check('SC11 toggle on synthesizes fixed-id plugin slot alongside user dirs', ids11.includes('ztools-plugins') && ids11.includes('ud1') && ids11.length === 2, JSON.stringify(ids11))
      // ③b 开启瞬间不立即同步：新 slot 不设 startup 标记，首轮只排到下一个
      // interval 时间点（setSCConfig 缺省 intervalMin=15 → 预订应在 ~15min 后）
      const plug11 = sc11Sched.getSnapshot().slots.find((s) => s.id === 'ztools-plugins')
      check(
        'SC11 toggle-on books the first round at the next interval point (no immediate sync)',
        plug11 && plug11.state === 'scheduled' && plug11.nextDueKind === 'interval' && plug11.nextDueAt != null && plug11.nextDueAt - Date.now() > 14 * 60000,
        JSON.stringify(plug11 ? { state: plug11.state, kind: plug11.nextDueKind, dueInMin: plug11.nextDueAt == null ? null : Math.round((plug11.nextDueAt - Date.now()) / 60000) } : null)
      )

      // ④ 端到端一轮：插件目录（自动发现）→ 平台隔离远端；目录插件与 asar 文件都上传
      await waitReal(() => sc11Sched.getSnapshot().leader.isLeader === true, 5000)
      // leader 上位后也无 startup 轮：真实等待窗内 slot 保持 scheduled（startup 轮
      // 不得在 tick ≤1s 内入队 → queued/running）
      await new Promise((r) => setTimeout(r, 2200))
      const plugQuiet11 = sc11Sched.getSnapshot().slots.find((s) => s.id === 'ztools-plugins')
      check(
        'SC11 no round fires right after toggle-on even with leader elected (waits for the booked point)',
        plugQuiet11 && plugQuiet11.state === 'scheduled',
        JSON.stringify(plugQuiet11 ? { state: plugQuiet11.state, kind: plugQuiet11.nextDueKind } : null)
      )
      const r11 = await sc11Sched.syncNow('ztools-plugins')
      const remoteBase11 = path.join(ROOT, 'ztools-plugins', platformKey)
      check(
        'SC11 plugin round uploads dir plugin + asar artifact to platform-isolated remote',
        r11.ok === true && r11.summary && r11.summary.uploaded === 2 && fs.existsSync(path.join(remoteBase11, 'plugin-a', 'plugin.json')) && fs.existsSync(path.join(remoteBase11, 'demo-b-0.1.0-ab12cd34.asar')),
        JSON.stringify(r11.ok ? r11.summary : r11.error)
      )

      // ④b 云端存储位置可配置：prefs 指定父目录 → 合成项远端 = <父目录>/ztools-plugins/<平台>。
      // remotePath 变化 → 基线随键更换 → 首轮把本机插件重新上传到新位置（旧位置不动）
      setSCConfig([{ id: 'ud1', localPath: ud11, remotePath: '/sc11-ud1', mode: 'two-way' }], { ztoolsPluginSync: true, autoSync: true, ztoolsPluginSyncRemoteDir: '/sc11-custom' })
      await sc11Sched.reload()
      const r11b = await sc11Sched.syncNow('ztools-plugins')
      const remoteBase11b = path.join(ROOT, 'sc11-custom', 'ztools-plugins', platformKey)
      check(
        'SC11 custom cloud folder composes <chosen>/ztools-plugins/<platform> and re-uploads there',
        r11b.ok === true && r11b.summary && r11b.summary.uploaded === 2 && fs.existsSync(path.join(remoteBase11b, 'plugin-a', 'plugin.json')) && fs.existsSync(path.join(remoteBase11b, 'demo-b-0.1.0-ab12cd34.asar')),
        JSON.stringify(r11b.ok ? r11b.summary : r11b.error)
      )

      // ⑤ 行级暂停（ztoolsPluginSyncPaused → enabled=false）：全量手动同步不含该目录
      setSCConfig([{ id: 'ud1', localPath: ud11, remotePath: '/sc11-ud1', mode: 'two-way' }], { ztoolsPluginSync: true, ztoolsPluginSyncPaused: true })
      await sc11Sched.reload()
      const all11 = await sc11Sched.syncNow()
      check(
        'SC11 paused plugin slot is skipped by sync-all (maps to enabled=false)',
        all11.ok === true && all11.perDir.length === 1 && all11.perDir[0].dirId === 'ud1',
        JSON.stringify(all11.perDir)
      )

      // ⑥ 手改同 id 条目被滤除：固定 id 由合成项独占，防止 slot 撞 id
      setSCConfig([{ id: 'ztools-plugins', localPath: path.join(ZT_ROOT, 'rogue'), remotePath: '/sc11-rogue', mode: 'two-way' }], { ztoolsPluginSync: false })
      await sc11Sched.reload()
      check('SC11 rogue user entry with the reserved id is dropped', sc11Sched.getSnapshot().slots.length === 0, JSON.stringify(sc11Sched.getSnapshot().slots.map((s) => s.id)))
    } finally {
      sc11Sched.cleanup()
      if (prevEnv === undefined) delete process.env.ZTOOLS_DATA_ROOT
      else process.env.ZTOOLS_DATA_ROOT = prevEnv
      await fsp.rm(ZT_ROOT, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'ztools-plugins'), { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'sc11-custom'), { recursive: true, force: true }).catch(() => {})
      if (ud11) await fsp.rm(ud11, { recursive: true, force: true }).catch(() => {})
    }
  })

  // ============================================================
  // SC12：目录级覆盖 —— 单个同步文件夹单独设置全部高级项与自动同步。
  //   ① 记录型引擎包装捕获取 down 的 cfg / prefs：目录级 overrides（并发 / 限速 /
  //      租约锁 / 深度校验 / 排除规则 / 冲突 / 隐藏）整体替换全局对应项，
  //      限速经 cfg.netOpts.ratePerSec 注入；
  //   ② 目录级 autoSync=false：不排 interval、tick 清预订、watcher 摘除；
  //   ③ 自动同步关的目录手动 syncNow 仍可用，文件变化不触发自动轮；
  //   ④ 重新开启 → 按目录级 interval 重新预订；
  //   ⑤ 全局 autoSync=false 时目录级 true 覆盖生效（未覆盖目录仍不排程）。
  // ============================================================
  await section('SC12：目录级覆盖（全部高级项 + 目录级自动同步）', async () => {
    mountScZtools()
    await freshStore('sc12')
    const clock = makeFakeClock()
    const SC12_LOCAL = await tmpLocal('sc12')
    const SC12_LOCAL2 = await tmpLocal('sc12b')
    await fsp.writeFile(path.join(SC12_LOCAL, 'a.txt'), 'sc12-a')

    // 记录型引擎包装：捕获调度器下发的 cfg / dir / prefs（轮体委托真实引擎执行）；
    // watcher 注册 / 摘除同步记账（目录级自动同步门控的观测面）
    const seen = []
    const watchRegs = []
    const watchStops = []
    const sched = createTestSched({
      engine: {
        syncDirectory: async (c, d, p, h) => {
          seen.push({ cfg: c, dir: d, prefs: p })
          return services.sync.syncDirectory(c, d, p, h)
        },
        watchDir: (id, lp, cb) => {
          watchRegs.push(id)
          return services.fsx.watchDir(id, lp, cb)
        },
        stopWatch: (id) => {
          watchStops.push(id)
          return services.fsx.stopWatch(id)
        },
        stopAllWatch: services.fsx.stopAllWatch,
        listPendingConflicts: services.sync.listPendingConflicts,
      },
      now: clock.now,
      timers: clock.timers,
    })
    const events = []
    sched.subscribe((ev) => events.push(ev))
    const roundEnds = () => events.filter((e) => e.type === 'round-end')
    const watcherId = `${sched.instanceId}:d1`
    const overrides = {
      autoSync: true,
      intervalMin: 30,
      conflictStrategy: 'local',
      ignoreHidden: false,
      concurrency: 6,
      ratePerSec: 9,
      leaseLock: false,
      deepVerify: true,
      excludePatterns: ['*.iso'],
    }
    // 全局：并发 4 / 租约锁开 / 深度校验关 / 另一套排除规则 —— 目录级覆盖应整体替换
    setSCConfig([{ id: 'd1', localPath: SC12_LOCAL, remotePath: '/sc12', mode: 'two-way', overrides }], {
      autoSync: true,
      intervalMin: 1,
      concurrency: 4,
      leaseLock: true,
      deepVerify: false,
      excludePatterns: ['*.tmp'],
    })
    try {
      await sched.init()
      const elected = await waitReal(() => sched.getSnapshot().leader.isLeader === true, 8000)
      check('SC12 leader elected for override tests', elected, '')

      // ① 目录级覆盖下发引擎：prefs 各项取 overrides 值；限速经 cfg.netOpts 注入
      const r1 = await sched.syncNow('d1')
      check('SC12 manual round on override dir completes', r1.ok === true && r1.summary && r1.summary.uploaded === 1, JSON.stringify(r1.ok ? r1.summary : r1.error))
      const first = seen[seen.length - 1]
      check(
        'SC12 per-dir overrides reach the engine (concurrency/leaseLock/deepVerify/exclude/conflict/ignoreHidden)',
        !!first &&
          first.prefs.concurrency === 6 &&
          first.prefs.leaseLock === false &&
          first.prefs.deepVerify === true &&
          JSON.stringify(first.prefs.excludePatterns) === JSON.stringify(['*.iso']) &&
          first.prefs.conflictStrategy === 'local' &&
          first.prefs.ignoreHidden === false,
        JSON.stringify(first && first.prefs)
      )
      check(
        'SC12 per-dir ratePerSec injected via cfg.netOpts (explicit value wins over profile/global layering)',
        !!first && first.cfg && first.cfg.netOpts && first.cfg.netOpts.ratePerSec === 9,
        JSON.stringify(first && first.cfg)
      )
      check('SC12 watcher registered for auto-sync dir', watchRegs.includes(watcherId), JSON.stringify({ watchRegs, watchStops }))

      // ② 目录级 autoSync=false：预订被清（tick 清理）、watcher 摘除
      setSCConfig([{ id: 'd1', localPath: SC12_LOCAL, remotePath: '/sc12', mode: 'two-way', overrides: { ...overrides, autoSync: false } }], {
        autoSync: true,
        intervalMin: 1,
      })
      await sched.reload()
      const cleared = await pumpUntil(clock, () => {
        const s = sched.getSnapshot().slots.find((x) => x.id === 'd1')
        return s && s.state === 'idle' && s.nextDueAt == null
      }, 8000, 5000)
      const slotOff = sched.getSnapshot().slots.find((x) => x.id === 'd1')
      check(
        'SC12 per-dir autoSync=false clears the booked auto schedule',
        cleared && slotOff.state === 'idle' && slotOff.nextDueAt == null && slotOff.nextDueKind == null,
        JSON.stringify(slotOff && { state: slotOff.state, due: slotOff.nextDueAt, kind: slotOff.nextDueKind })
      )
      check('SC12 watcher stopped for per-dir autoSync=false', watchStops.includes(watcherId), JSON.stringify(watchStops))

      // ③ 自动同步关的目录：文件变化不触发自动轮；手动同步仍可用
      const roundsBefore = roundEnds().length
      await fsp.writeFile(path.join(SC12_LOCAL, 'b.txt'), 'sc12-b')
      await sleep(2600) // 引擎 watcher 去抖 1.5s：若 watcher 未摘除，此处必然出现 watch 轮
      check('SC12 no auto round fires for per-dir autoSync=false after file change', roundEnds().length === roundsBefore, `rounds=${roundEnds().length}/${roundsBefore}`)
      const r3 = await sched.syncNow('d1')
      check('SC12 manual syncNow still works with per-dir autoSync=false', r3.ok === true && r3.summary && r3.summary.uploaded === 1, JSON.stringify(r3.ok ? r3.summary : r3.error))

      // ④ 重新开启目录级自动同步：按目录级 interval（30min）重新预订，无 startup 轮
      setSCConfig([{ id: 'd1', localPath: SC12_LOCAL, remotePath: '/sc12', mode: 'two-way', overrides }], { autoSync: true, intervalMin: 1 })
      await sched.reload()
      const slotBack = sched.getSnapshot().slots.find((x) => x.id === 'd1')
      check(
        'SC12 re-enabled per-dir autoSync rebooks the interval at the dir-level cadence',
        slotBack && slotBack.state === 'scheduled' && slotBack.nextDueKind === 'interval' && slotBack.nextDueAt != null && Math.abs(slotBack.nextDueAt - (Date.now() + 30 * 60000)) < 60000,
        JSON.stringify(slotBack && { state: slotBack.state, kind: slotBack.nextDueKind, dueInMin: slotBack.nextDueAt == null ? null : Math.round((slotBack.nextDueAt - clock.now()) / 60000) })
      )

      // ⑤ 全局 autoSync=false：目录级 true 覆盖生效；未覆盖目录不排程
      setSCConfig(
        [
          { id: 'd1', localPath: SC12_LOCAL, remotePath: '/sc12', mode: 'two-way', overrides },
          { id: 'd2', localPath: SC12_LOCAL2, remotePath: '/sc12b', mode: 'two-way' },
        ],
        { autoSync: false, intervalMin: 1 }
      )
      await sched.reload()
      const d1 = sched.getSnapshot().slots.find((x) => x.id === 'd1')
      const d2 = sched.getSnapshot().slots.find((x) => x.id === 'd2')
      check(
        'SC12 per-dir autoSync=true overrides a globally off autoSync (dir scheduled, uncovered dir stays idle)',
        d1 && d2 && d1.state === 'scheduled' && d1.nextDueKind === 'interval' && d1.nextDueAt != null && d2.state === 'idle' && d2.nextDueAt == null,
        JSON.stringify({ d1: d1 && { state: d1.state, kind: d1.nextDueKind }, d2: d2 && { state: d2.state, kind: d2.nextDueKind } })
      )
    } finally {
      sched.cleanup()
      await fsp.rm(SC12_LOCAL, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(SC12_LOCAL2, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'sc12'), { recursive: true, force: true }).catch(() => {})
    }
  })

  // ---- SC13（快，假时钟）：全局暂停自动同步 —— dirEligible 门控（自动轮不排 /
  //      新目录 startup 不发射）/ 到期自动恢复补跑 / 手动恢复补跑 / 手动
  //      syncNow 不受影响 / -1 一直暂停无到期定时器 ----

  await section('SC13：全局暂停自动同步（假时钟）', async () => {
    mountScZtools() // 幂等：fast/slow 过滤下 SC1 可能未运行
    // 真私有存储根（绝不 switchDevice 到全局）：调度器的 leader.lock / 目录锁
    // 全部落在这里。freshStore 会把全局当前根切过去（跟随 store.storageRoot 的
    // 存活实例都能到达），因此这里直接建独立目录注入 —— 前序节遗留的存活实例
    // 只会跟随全局当前根，永远到不了本节的私有根，leader 选举零竞争（该干扰
    // 曾以「心跳发现锁已被其他实例接管」的 becomeLost 偶发打断本节）。
    // 引擎的基线 / 能力缓存仍走全局根（按 localPath / remotePath 键隔离，不串）。
    const sc13Root = path.join(os.tmpdir(), `wdsync-sc13-root-${Date.now()}-${process.pid}`)
    await fsp.mkdir(path.join(sc13Root, 'scheduler'), { recursive: true })
    const clock = makeFakeClock()
    const SC13_LOCAL = await tmpLocal('sc13')
    await fsp.writeFile(path.join(SC13_LOCAL, 'a.txt'), 'sc13-a')
    // 初始未暂停、autoSync 关（slot idle，无任何轮）：先把 leader 选出来再测门控
    setSCConfig([{ id: 'd1', localPath: SC13_LOCAL, remotePath: '/sc13', mode: 'two-way' }], { autoSync: false, intervalMin: 1 })
    const sched = createTestSched({ now: clock.now, timers: clock.timers, storageRoot: () => sc13Root })
    const events = []
    sched.subscribe((ev) => events.push(ev))
    const roundEnds = () => events.filter((e) => e.type === 'round-end')
    try {
      await sched.init()
      const elected = await pumpUntil(clock, () => sched.getSnapshot().leader.isLeader === true, 8000, 8000)
      check('SC13 instance elected leader', elected, JSON.stringify(sched.getSnapshot().leader))

      // ① 暂停 + autoSync 开（reload 出现新目录）：dirEligible 门控 —— slot 保持
      //    idle、新目录 startup 轮不发射、interval 不预订
      setSCConfig([{ id: 'd1', localPath: SC13_LOCAL, remotePath: '/sc13', mode: 'two-way' }], {
        autoSync: true,
        intervalMin: 1,
        globalPauseUntil: clock.now() + 30 * 1000,
      })
      await sched.reload()
      let slot = sched.getSnapshot().slots[0]
      check(
        'SC13 pause gates eligibility: new-dir slot stays idle, no startup/interval booking',
        slot && slot.state === 'idle' && slot.nextDueAt == null,
        JSON.stringify(slot && { state: slot.state, due: slot.nextDueAt })
      )
      // 大步长注意：步进必须 < HEARTBEAT_MS(5s)，否则假时钟下心跳两次写入的间隔
      // 超过 leader 锁 TTL(15s)，leader 会按设计自判 lost —— 调度决策全停。
      // 暂停时长用 30s 而非分钟级：缩小假时钟推进窗口，降低跨节僵尸实例
      // （前序节遗留的真实时钟选举重试）在本节运行期抢走 leader 锁的偶发干扰。
      await clock.advance(5 * 1000, 4000)
      check('SC13 no auto rounds fire while paused', roundEnds().length === 0, `rounds=${roundEnds().length}`)

      // ② 到期自动恢复：过期定时器（kit.after，假时钟驱动）触发重读 → 迁移判定
      //    → 有资格空闲目录短抖动（2–6s）内补跑预订 → 真实轮跑完。
      //    先大步长跨过到期点，再用 pumpUntil 消费补跑预订 —— pumpUntil 边推进
      //    假时钟（tick 得以发射）边让出真实时间（轮体真实 IO 得以推进）；
      //    waitReal 纯真实等待不会动假时钟，tick（假定时器）永远不会触发。
      await clock.advance(30 * 1000, 4000)
      const resumeOk = await pumpUntil(clock, () => roundEnds().length >= 1, 20000, 60000)
      slot = sched.getSnapshot().slots[0]
      check(
        'SC13 pause expiry re-arms a catch-up round (2-6s jitter, interval kind) that runs',
        resumeOk && roundEnds()[0] && roundEnds()[0].error == null,
        JSON.stringify({ resumeOk, round: roundEnds()[0] || null })
      )

      // ③ 暂停中手动 syncNow 不受影响（用户显式动作）
      setSCConfig([{ id: 'd1', localPath: SC13_LOCAL, remotePath: '/sc13', mode: 'two-way' }], {
        autoSync: true,
        intervalMin: 1,
        globalPauseUntil: clock.now() + 30 * 1000,
      })
      await sched.reload()
      slot = sched.getSnapshot().slots[0]
      check(
        'SC13 re-pause clears the interval booking',
        slot.state === 'idle' && slot.nextDueAt == null,
        JSON.stringify({ state: slot.state, due: slot.nextDueAt })
      )
      let manualErr = null
      let manualRes = null
      try {
        manualRes = await sched.syncNow('d1')
      } catch (e) {
        manualErr = e
      }
      check(
        'SC13 manual syncNow works while paused',
        !manualErr && manualRes && manualRes.ok === true && roundEnds().length === 2,
        JSON.stringify({ err: manualErr && manualErr.message, res: manualRes, rounds: roundEnds().length })
      )

      // ④ -1 一直暂停：无到期定时器（推进时钟不恢复、不报错）；手动恢复（清 0）
      //    经 reload 迁移 → 短抖动补跑
      setSCConfig([{ id: 'd1', localPath: SC13_LOCAL, remotePath: '/sc13', mode: 'two-way' }], {
        autoSync: true,
        intervalMin: 1,
        globalPauseUntil: -1,
      })
      await sched.reload()
      await clock.advance(8 * 1000, 4000)
      slot = sched.getSnapshot().slots[0]
      check(
        'SC13 indefinite pause never auto-resumes',
        slot.state === 'idle' && roundEnds().length === 2,
        JSON.stringify({ state: slot.state, rounds: roundEnds().length })
      )
      setSCConfig([{ id: 'd1', localPath: SC13_LOCAL, remotePath: '/sc13', mode: 'two-way' }], { autoSync: true, intervalMin: 1 })
      await sched.reload()
      slot = sched.getSnapshot().slots[0]
      check(
        'SC13 manual resume books a 2-6s catch-up round',
        slot.state === 'scheduled' && slot.nextDueKind === 'interval' && slot.nextDueAt != null && slot.nextDueAt - clock.now() <= 6500 && slot.nextDueAt - clock.now() > 0,
        `state=${slot.state} kind=${slot.nextDueKind} in=${slot.nextDueAt == null ? '-' : slot.nextDueAt - clock.now()}`
      )
      // capFake 放宽到 120s：200ms 步进下 ≈6s 真实时间，覆盖冷缓存轮的真实 IO 时长
      const resume2 = await pumpUntil(clock, () => roundEnds().length >= 3, 25000, 120000)
      check('SC13 resumed catch-up round runs', resume2 && roundEnds()[2] && roundEnds()[2].error == null, JSON.stringify(roundEnds()[2] || {}))
    } finally {
      sched.cleanup()
      await fsp.rm(SC13_LOCAL, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(sc13Root, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'sc13'), { recursive: true, force: true }).catch(() => {})
    }
  })

afterAll(async () => {
  // SC 系列收尾（原 DS1 前 gap 的节外语句迁移至此）：摘假 ztools、清 SC_DB
  delete global.window.ztools
  SC_DB[SC_KEY] = null
  await teardownShard({ ROOT, LOCAL, server })
})
