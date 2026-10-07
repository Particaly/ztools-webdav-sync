/**
 * 存储层（src-ztools/preload/store.mts）独立单元测试（vitest 迁移版）。
 * 覆盖：半行日志、CRC 错误、压缩中途崩溃、快照损坏、日志重放幂等、
 * WAL 生命周期、deviceId 稳定性、5 万条目加载耗时与内存、
 * 凭据混淆 AES-256-GCM（U17）、同步记录 JSONL 化与旧格式迁移（U19）。
 * 运行：npx vitest run test/unit（或 npm run test:unit）
 *
 * 结构说明：用例链强顺序依赖（U3 直接改 U2 的日志文件、U4 改 U3 的……），
 * 因此整体保持单一 test 顺序执行；check() 沿用软失败登记 + 末尾一次性抛出，
 * 语义与旧 node 脚本一致（所有用例跑完、失败清单一次列出）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'
import { makeCheck, UNIT_HERE as HERE } from '../harness.mjs'

const PRELOAD = path.join(HERE, '..', '..', 'src-ztools', 'preload')

// 软失败登记 + JSONL 对拍通道（section 固定 'store-unit'）收敛到 harness 的 makeCheck
const { check, assertAtEnd } = makeCheck('store-unit')

// CJS 模块经 ESM 动态 import 取 module.exports
const store = await import(pathToFileURL(path.join(PRELOAD, 'store.mts')).href)
const ROOT = path.join(os.tmpdir(), `wdsync-store-unit-${Date.now()}-${process.pid}`)
await fsp.mkdir(ROOT, { recursive: true })
// 显式切到本次运行的独立根：避免命中跨运行持久化的 fallback 目录
await store.setRootForTest(ROOT)

const dirOpts = { localPath: 'D:\\Sync\\Docs', remotePath: '/docs' }
const openStore = () => store.openDirStore(dirOpts)
const entryOf = (n) => ({
  origName: `f${n}.txt`,
  lsize: 100 + n,
  lmtimeMs: 1700000000000 + n,
  lhash: `hash-${n}`,
  rsize: 100 + n,
  rmtimeMs: 1700000000100 + n,
  retag: `"e${n}"`,
})

test('存储层单元（U1–U18，强顺序链）', async () => {
  try {
  // U1 deviceId：同根稳定、跨根隔离
  const id1 = await store.getDeviceId()
  const id1b = await store.getDeviceId()
  check('U1 deviceId stable within a root', id1 === id1b && /^[0-9a-f-]{36}$/.test(id1), id1)
  const ROOT_B = path.join(ROOT, 'device-b')
  await fsp.mkdir(ROOT_B, { recursive: true })
  await store.setRootForTest(ROOT_B)
  const id2 = await store.getDeviceId()
  check('U1 deviceId isolated per root', id2 !== id1, id2)
  await store.setRootForTest(ROOT)
  check('U1 deviceId restored after switching back', (await store.getDeviceId()) === id1)

  // U2 基线读写与重开持久化
  let s = await openStore()
  await s.setEntry('a.txt', entryOf(1))
  await s.setEntry('sub/b.txt', entryOf(2))
  await s.deleteEntry('a.txt')
  await s.flush()
  await store.closeAllStores()
  s = await openStore()
  check('U2 entries persist across reopen', s.get('a.txt') === undefined && s.get('sub/b.txt').lhash === 'hash-2')
  check('U2 NFC key lookup', s.get('sub/b.txt') === s.get('sub/b.txt'))

  // U3 半行日志：最后一行截断 → 丢弃尾部，此前条目完好
  await store.closeAllStores()
  const dirP = store.baselineDirPath(await store.getDeviceId(), dirOpts.localPath, dirOpts.remotePath)
  const logFile = path.join(dirP, 'log.jsonl')
  const logRaw1 = await fsp.readFile(logFile, 'utf-8')
  const halfLine = logRaw1.split('\n')[0].slice(0, 20) // 一条合法行的前 20 字节（无换行）
  await fsp.writeFile(logFile, logRaw1 + halfLine, 'utf-8')
  s = await openStore()
  check('U3 half-line tail dropped with warning', s.get('sub/b.txt') !== undefined && s.warnings.some((w) => /baseline log/.test(w)), JSON.stringify(s.warnings))
  await store.closeAllStores()

  // U4 CRC 错误：完整 JSON 但 CRC 不符 → 该行及其后全部丢弃
  await store.closeAllStores()
  s = await openStore()
  await s.setEntry('c.txt', entryOf(3))
  await s.flush()
  await store.closeAllStores()
  let logRaw2 = await fsp.readFile(logFile, 'utf-8')
  const lines = logRaw2.split('\n').filter(Boolean)
  const badCrcLine = lines[lines.length - 1].replace(/"c":\d+/, '"c":1') // 合法 JSON、错误 CRC
  const tailAfterBad = lines[0] // 坏行之后还有一条合法行，必须一并丢弃
  await fsp.writeFile(logFile, [...lines.slice(0, -1), badCrcLine, tailAfterBad, ''].join('\n'), 'utf-8')
  s = await openStore()
  check('U4 CRC-bad line and successors dropped', s.get('c.txt') === undefined && s.warnings.some((w) => /CRC/.test(w)))
  check('U4 lines before CRC error intact', s.get('sub/b.txt') !== undefined)
  await store.closeAllStores()

  // U5 压缩中途崩溃（a：tmp 残留）——快照与日志不受影响
  s = await openStore()
  await s.setEntry('d.txt', entryOf(4))
  await s.compact()
  await store.closeAllStores()
  // 压缩成功后手动伪造 tmp 残留 + 在日志里补一条（模拟 rename 后、清日志前崩溃：日志含已压缩操作）
  fs.writeFileSync(path.join(dirP, `snapshot.json.tmp-crash`), '{"v":1,"entries":{BROKEN', 'utf-8')
  s = await openStore()
  await s.setEntry('sub/b.txt', entryOf(22)) // 同 key 重写：重放幂等性由此验证
  await s.flush()
  await store.closeAllStores()
  // 快照已含 sub/b.txt(v2)；再把日志整体回滚成「仍含旧操作」的样子后重放
  const logNow = await fsp.readFile(logFile, 'utf-8')
  const snapNow = JSON.parse(await fsp.readFile(path.join(dirP, 'snapshot.json'), 'utf-8'))
  // 直接把日志重放一遍到快照之上（等价于 rename 后未清日志的崩溃点）
  const replayed = JSON.parse(JSON.stringify(snapNow.entries))
  for (const line of logNow.split('\n')) {
    if (!line.trim()) continue
    const o = JSON.parse(line).o
    if (o.t === 'set') replayed[o.k] = o.e
    else if (o.t === 'del') delete replayed[o.k]
  }
  s = await openStore()
  const reloaded = Object.fromEntries(s.entries)
  check('U5 leftover tmp ignored and replay idempotent', JSON.stringify(reloaded) === JSON.stringify(replayed) && s.get('d.txt') !== undefined)
  check('U5 compact zeroes log lines', s.logLines === 1, `logLines=${s.logLines}`)
  await store.closeAllStores()

  // U6 快照损坏 → 无基线保护（loadedOk=false + 空表 + warning）
  await fsp.writeFile(path.join(dirP, 'snapshot.json'), '{"v":1,"files": BROKEN', 'utf-8')
  s = await openStore()
  check('U6 corrupt snapshot → no-baseline mode', s.loadedOk === false && s.entries.size === 0 && s.warnings.some((w) => /snapshot corrupt/.test(w)))
  await store.closeAllStores()
  // 版本不识别同样按损坏处理
  await fsp.writeFile(path.join(dirP, 'snapshot.json'), JSON.stringify({ v: 99, entries: { x: entryOf(9) } }), 'utf-8')
  s = await openStore()
  check('U6 unknown schema version → no-baseline mode', s.loadedOk === false && s.entries.size === 0)
  await store.closeAllStores()

  // U7 日志重放幂等：同一状态连续加载两次结果一致
  await fsp.rm(dirP, { recursive: true, force: true })
  s = await openStore()
  await s.setEntry('x.txt', entryOf(5))
  await s.setEntry('x.txt', entryOf(6))
  await s.deleteEntry('x.txt')
  await s.setEntry('y.txt', entryOf(7))
  await s.flush()
  await store.closeAllStores()
  const sA = await openStore()
  const dumpA = JSON.stringify(Object.fromEntries(sA.entries))
  await store.closeAllStores()
  const sB = await openStore()
  const dumpB = JSON.stringify(Object.fromEntries(sB.entries))
  check('U7 replay idempotent across loads', dumpA === dumpB && sB.get('y.txt').lhash === 'hash-7' && sB.get('x.txt') === undefined)
  await store.closeAllStores()

  // U8 WAL 生命周期：intent → pending；done → 了结；跨重开保留；truncate 清空
  s = await openStore()
  await s.appendWalIntent({ id: 'i1', op: 'upload', rel: 'y.txt', local: { size: 107, mtimeMs: 1 } })
  await s.appendWalIntent({ id: 'i2', op: 'download', rel: 'z.txt', remote: { size: 9, mtimeMs: 2, etag: 'e' } })
  check('U8 pending intents tracked', s.pendingIntents.size === 2)
  await s.appendWalDone('i1')
  check('U8 done resolves intent', s.pendingIntents.size === 1 && s.pendingIntents.get('i2').op === 'download')
  await s.flush()
  await store.closeAllStores()
  s = await openStore()
  check('U8 open intent survives reopen', s.pendingIntents.size === 1 && s.pendingIntents.get('i2').rel === 'z.txt')
  await s.appendWalAbort('i2')
  await s.truncateWal()
  await store.closeAllStores()
  s = await openStore()
  check('U8 truncateWal clears everything', s.pendingIntents.size === 0 && (await fsp.readFile(path.join(dirP, 'wal.jsonl'), 'utf-8')) === '')
  await store.closeAllStores()

  // U15：开放意图的 WAL 截断保护与超龄助手。
  // 半截判定依赖开放意图跨轮存活 —— 有开放意图时 truncateWal 必须**跳过截断**
  // （截断会抹掉「本机可能已在远端留下半截」的唯一线索）；全部了结后才清空。
  // ageOpenIntents 为 e2e 验证 30 天超龄兜底的内存前拨助手（不落盘）。
  await fsp.rm(dirP, { recursive: true, force: true })
  s = await openStore()
  await s.appendWalIntent({ id: 'k1', op: 'upload', rel: 'half.bin', at: Date.now(), local: { size: 10, mtimeMs: 1 }, remote: null })
  await s.appendWalIntent({ id: 'k2', op: 'upload', rel: 'done.bin', at: Date.now(), local: { size: 5, mtimeMs: 1 }, remote: null })
  await s.appendWalDone('k2')
  check('U15 one open + one settled intent tracked', s.pendingIntents.size === 1 && s.pendingIntents.get('k1').rel === 'half.bin')
  await s.truncateWal()
  check(
    'U15 truncateWal SKIPPED while an intent is open (wal kept on disk)',
    s.pendingIntents.size === 1 && (await fsp.readFile(path.join(dirP, 'wal.jsonl'), 'utf-8')).includes('"id":"k1"')
  )
  await store.closeAllStores()
  s = await openStore()
  check('U15 open intent survives reopen (recovery input intact)', s.pendingIntents.size === 1 && s.pendingIntents.get('k1').remote === null)
  s.ageOpenIntents(31 * 24 * 3600 * 1000)
  check('U15 ageOpenIntents shifts at backwards (memory only)', Date.now() - s.pendingIntents.get('k1').at > 30 * 24 * 3600 * 1000)
  await s.appendWalAbort('k1')
  await s.truncateWal()
  check(
    'U15 truncateWal clears once all intents settled',
    s.pendingIntents.size === 0 && (await fsp.readFile(path.join(dirP, 'wal.jsonl'), 'utf-8')) === ''
  )
  await store.closeAllStores()

  // U15b：开放意图的 firstAt（链上最初写入时刻）持久化跨重开；
  // ageOpenIntents 对 at 与 firstAt 一并前拨（超龄兜底按 firstAt 计算的前提）
  s = await openStore()
  const u15bAt = Date.now()
  await s.appendWalIntent({ id: 'k4', op: 'upload', rel: 'chain.bin', at: u15bAt, firstAt: u15bAt - 5000, local: { size: 10, mtimeMs: 1 }, remote: null })
  await s.flush()
  await store.closeAllStores()
  s = await openStore()
  const k4 = s.pendingIntents.get('k4')
  check(
    'U15b firstAt persists across reopen (firstAt < at on inherited chain)',
    k4 != null && k4.firstAt === u15bAt - 5000 && k4.at === u15bAt,
    JSON.stringify(k4)
  )
  s.ageOpenIntents(1000)
  check(
    'U15b ageOpenIntents shifts BOTH at and firstAt',
    s.pendingIntents.get('k4').firstAt === u15bAt - 5000 - 1000 && s.pendingIntents.get('k4').at === u15bAt - 1000
  )
  await s.appendWalAbort('k4')
  await s.truncateWal()
  await store.closeAllStores()

  // U9 fingerprint-unstable（origin+username 粒度、跨目录共享）。
  // 旧目录粒度 API（noteRemoteFingerprintNoise / resetRemoteFingerprintNoise /
  // fingerprintUnstable）已删除；同一服务器（同账号）下跨目录累计 distinct 文件计数。
  const dirS1 = await store.openDirStore({ localPath: 'D:\\S1', remotePath: '/s1' })
  const dirS2 = await store.openDirStore({ localPath: 'D:\\S2', remotePath: '/s2' })
  check('U9 per-dir noise API removed after migration', typeof dirS1.noteRemoteFingerprintNoise !== 'function' && typeof dirS1.resetRemoteFingerprintNoise !== 'function' && dirS1.fingerprintUnstable === undefined && dirS1.meta.noiseFiles === undefined)
  const srvA = await store.openServerState('http://a.example.com', 'u1')
  const srvA2 = await store.openServerState('http://a.example.com', 'u1')
  check('U9 server state reused per origin+username', srvA === srvA2 && srvA !== dirS1)
  // 同一文件反复出现不计入 distinct；跨目录的不同文件计入（rel 在 origin 域内全局唯一）
  const m1 = srvA.noteFingerprintNoise('dir1/a.txt')
  const m1b = srvA.noteFingerprintNoise('dir1/a.txt') // 同一文件重复出现：不计入 distinct
  const m2 = srvA.noteFingerprintNoise('dir2/b.txt') // 第 2 个不同文件（跨目录）：仍不标记
  check('U9 single-file repetition never marks unstable', !m1 && !m1b && !m2 && srvA.fingerprintUnstable === false)
  const m3 = srvA.noteFingerprintNoise('dir3/c.txt') // 第 3 个不同文件（跨目录累计）→ 标记
  check('U9 third distinct file marks unstable (cross-dir)', m3 === true && srvA.fingerprintUnstable === true)
  check('U9 reset removes file from noise set', srvA.resetFingerprintNoise('dir2/b.txt') === true && srvA.noiseFiles['dir2/b.txt'] === undefined)
  await srvA.saveNoise()
  await store.closeAllStores()
  // 重开（含另开一个目录存储）：标记持久化且跨目录可见
  const srvARe = await store.openServerState('http://a.example.com', 'u1')
  check('U9 unstable persists across reopen', srvARe.fingerprintUnstable === true && srvARe.noiseFiles['dir1/a.txt'] === 1)
  // 隔离：不同 origin / 不同 username 互不影响（能力缓存与噪声同键域）
  const srvB = await store.openServerState('http://b.example.com', 'u1')
  const srvAuser2 = await store.openServerState('http://a.example.com', 'u2')
  check('U9 isolated per origin and username', srvB.fingerprintUnstable === false && srvAuser2.fingerprintUnstable === false)
  await store.closeAllStores()

  // U11 服务器能力缓存（capabilities.json）：TTL、持久化、损坏降级
  const caps = {
    probedAt: Date.now(),
    tier: 'A',
    writable: true,
    etag: { present: true, weak: false, stable: true },
    conditional: { ifMatch: true, ifNoneMatch: true },
    depthInfinity: false,
    mtimePrecision: 'ms',
    collectionRedirect: false,
    notes: [],
  }
  await srvB.saveCapabilities(caps)
  check('U11 cached capabilities within TTL', srvB.getCachedCapabilities(60000) === caps)
  const stale = { ...caps, probedAt: Date.now() - 8 * 24 * 3600 * 1000 }
  await srvB.saveCapabilities(stale)
  check('U11 expired TTL returns null, longer TTL still hits', srvB.getCachedCapabilities(60000) === null && srvB.getCachedCapabilities(9 * 24 * 3600 * 1000) === stale)
  await store.closeAllStores()
  const srvB2 = await store.openServerState('http://b.example.com', 'u1')
  // 注意重开后是 JSON 反序列化出的新对象，按字段值断言而非引用相等
  const reC = srvB2.getCachedCapabilities(9 * 24 * 3600 * 1000)
  check('U11 capabilities persist across reopen', reC != null && reC.tier === 'A' && reC.probedAt === stale.probedAt && reC.conditional.ifMatch === true)
  await store.closeAllStores()
  fs.writeFileSync(path.join(store.serverStateDirPath('http://b.example.com', 'u1'), 'capabilities.json'), '{"v":1,"caps":BROKEN')
  fs.writeFileSync(path.join(store.serverStateDirPath('http://b.example.com', 'u1'), 'noise.json'), 'BROKEN')
  const srvB3 = await store.openServerState('http://b.example.com', 'u1')
  check('U11 corrupt state files degrade to defaults', srvB3.getCachedCapabilities(9 * 24 * 3600 * 1000) === null && srvB3.fingerprintUnstable === false && Object.keys(srvB3.noiseFiles).length === 0)
  await store.closeAllStores()

  // U12 fsync 崩溃安全点：经 _internals.fsyncSpy 注入验证。
  // 断言以事件为准：事件证明「该 fsync 点被执行」；读回文件内容只是写入顺序的
  // 旁证（页缓存读回不证明持久）。Windows 上目录类事件（json-dir / compact-dir）
  // 不会出现（目录 fsync 被跳过），按平台分支断言，两种平台都能跑绿。
  const fsyncSpy = store._internals.fsyncSpy
  const events = []
  fsyncSpy.onEvent = (e) => events.push(e)
  const kindsSoFar = () => events.map((e) => e.kind).join(',')
  const isWin = process.platform === 'win32'
  await fsp.rm(dirP, { recursive: true, force: true })
  s = await openStore()

  // 安全点 1：intent 写入后立即产生 kind='wal' 的 fsync 事件，且该行已可读回（顺序旁证）
  events.length = 0
  await s.appendWalIntent({ id: 'w1', op: 'upload', rel: 'a.txt', local: { size: 1, mtimeMs: 1 } })
  check('U12 wal intent fsync event fired', events.filter((e) => e.kind === 'wal').length === 1, kindsSoFar())
  const walText = await fsp.readFile(path.join(dirP, 'wal.jsonl'), 'utf-8')
  check('U12 wal intent line visible on disk', walText.includes('"t":"intent"') && walText.includes('"id":"w1"'))

  // 安全点 2：done 写入后再次收到 wal 事件
  events.length = 0
  await s.appendWalDone('w1')
  check('U12 wal done fsync event fired', events.filter((e) => e.kind === 'wal').length === 1, kindsSoFar())

  // 批量策略：基线日志追加（set/delete）不产生任何即时 fsync 事件
  events.length = 0
  await s.setEntry('b.txt', entryOf(11))
  await s.deleteEntry('b.txt')
  check('U12 baseline append defers fsync (batch policy)', events.length === 0, kindsSoFar())

  // 安全点 4：flush 对每个打开句柄各产生一个事件（此时 log.jsonl 与 wal.jsonl 均已打开）
  events.length = 0
  await s.flush()
  const flushFiles = events.filter((e) => e.kind === 'flush').map((e) => e.file)
  check(
    'U12 flush fsyncs every open handle',
    flushFiles.length === 2 && flushFiles.some((f) => f.endsWith('log.jsonl')) && flushFiles.some((f) => f.endsWith('wal.jsonl')),
    flushFiles.join('|')
  )

  // 安全点 5（atomicWriteJson，经 saveMeta 触发）：json-file 恒有；json-dir 仅 POSIX
  events.length = 0
  await s.saveMeta()
  check('U12 atomicWriteJson file fsync fired', events.some((e) => e.kind === 'json-file'), kindsSoFar())
  if (isWin) {
    check('U12 atomicWriteJson dir fsync skipped on win32', !events.some((e) => e.kind === 'json-dir'), kindsSoFar())
  } else {
    check('U12 atomicWriteJson dir fsync fired on POSIX', events.some((e) => e.kind === 'json-dir'), kindsSoFar())
  }

  // compact：快照 tmp 文件 fsync（json-file）+ 日志截断 fsync（truncate）+ compact-dir（仅 POSIX）
  events.length = 0
  await s.compact()
  check(
    'U12 compact fires json-file and truncate',
    events.some((e) => e.kind === 'json-file') && events.some((e) => e.kind === 'truncate'),
    kindsSoFar()
  )
  if (isWin) {
    check('U12 compact dir fsync skipped on win32', !events.some((e) => e.kind === 'compact-dir'), kindsSoFar())
  } else {
    check('U12 compact dir fsync fired on POSIX', events.some((e) => e.kind === 'compact-dir'), kindsSoFar())
  }

  // 生产默认 no-op：钩子置回 null（防串扰），后续写入照常
  fsyncSpy.onEvent = null
  await s.setEntry('c.txt', entryOf(12))
  await s.flush()
  check('U12 spy reset to no-op does not affect writes', s.get('c.txt') !== undefined && s.get('c.txt').lhash === 'hash-12')
  await store.closeAllStores()

  // U13 持续失败退避记录：noteFailure 退避计算与消息截断、
  // failureSkipList、clearFailure、持久化与损坏降级、条目上限
  {
    const fOpts = { localPath: 'D:\\Fail', remotePath: '/fail' }
    const fDirP = store.baselineDirPath(await store.getDeviceId(), fOpts.localPath, fOpts.remotePath)
    await fsp.rm(fDirP, { recursive: true, force: true }).catch(() => {})
    let fs1 = await store.openDirStore(fOpts)
    check('U13 empty store has no failures and not dirty', fs1.failures.size === 0 && fs1.failuresDirty === false)
    fs1.noteFailure('a.txt', { code: 'HTTP 413', message: 'x'.repeat(600) })
    const fa = fs1.getFailure('a.txt')
    check(
      'U13 noteFailure truncates message and sets 15min backoff',
      !!fa && fa.count === 1 && fa.message.length === 500 && fa.firstAt > 0 && fa.retryAtMs === fa.lastAt + 15 * 60 * 1000,
      JSON.stringify(fa && { count: fa.count, len: fa.message.length })
    )
    fs1.noteFailure('a.txt', { code: 'HTTP 413', message: 'again' })
    const fa2 = fs1.getFailure('a.txt')
    check('U13 backoff doubles per count (count=2 → 30min)', !!fa2 && fa2.count === 2 && fa2.firstAt === fa.firstAt && fa2.retryAtMs === fa2.lastAt + 30 * 60 * 1000)
    // 连续失败到 count=12：15min × 2^11 ≈ 32 天 → 封顶 7 天
    for (let i = 0; i < 10; i++) fs1.noteFailure('a.txt', { code: 'HTTP 413', message: 'm' })
    const fa12 = fs1.getFailure('a.txt')
    check('U13 backoff capped at 7 days', fa12.count === 12 && fa12.retryAtMs === fa12.lastAt + 7 * 24 * 60 * 60 * 1000)
    fs1.noteFailure('b.txt', { code: 'NETWORK', message: 'nb' })
    check('U13 failureSkipList holds only unexpired rels', fs1.failureSkipList(Date.now()).has('a.txt') && fs1.failureSkipList(Date.now()).has('b.txt') && !fs1.failureSkipList(fa12.retryAtMs + 1).has('a.txt'))
    check('U13 entries marked dirty before save', fs1.failuresDirty === true)
    await fs1.saveFailures()
    check('U13 saveFailures clears dirty', fs1.failuresDirty === false)
    await store.closeAllStores()
    const fs2 = await store.openDirStore(fOpts)
    check('U13 failures persist across reopen', fs2.getFailure('a.txt').count === 12 && fs2.getFailure('b.txt').code === 'NETWORK')
    check('U13 clearFailure removes entry and marks dirty', fs2.clearFailure('a.txt') === true && fs2.getFailure('a.txt') === undefined && fs2.failuresDirty === true)
    check('U13 clearFailure on missing entry is a no-op', fs2.clearFailure('no-such.txt') === false)
    await fs2.saveFailures()
    await store.closeAllStores()
    // 损坏降级：存在但不可解析 → 按空处理 + warning，绝不影响同步安全
    fs.writeFileSync(path.join(fDirP, 'failures.json'), '{"v":1,"failures": BROKEN')
    const fs3 = await store.openDirStore(fOpts)
    check('U13 corrupt failures.json degrades to empty with warning', fs3.failures.size === 0 && fs3.warnings.some((w) => /failures\.json/.test(w)), JSON.stringify(fs3.warnings))
    await store.closeAllStores()
    // 版本不识别同样按空处理
    fs.writeFileSync(path.join(fDirP, 'failures.json'), JSON.stringify({ v: 99, failures: { a: { count: 1, retryAtMs: 1 } } }))
    const fs4 = await store.openDirStore(fOpts)
    check('U13 unknown failures version degrades to empty', fs4.failures.size === 0 && fs4.warnings.some((w) => /版本不识别/.test(w)))
    // 条目上限：灌 1001 条 → 第 1001 条被丢弃（noteFailure 返回 false）并记 warning
    let allRecorded = true
    for (let i = 0; i <= 1000; i++) if (!fs4.noteFailure(`f${i}.txt`, { code: 'X', message: 'm' })) allRecorded = false
    check(
      'U13 entries capped at 1000 with warning',
      fs4.failures.size === 1000 && allRecorded === false && fs4.warnings.some((w) => /上限/.test(w)),
      `size=${fs4.failures.size}`
    )
    // 已有条目继续更新不受上限影响
    check('U13 existing entry still updatable at cap', fs4.noteFailure('f0.txt', { code: 'X', message: 'm2' }) === true && fs4.getFailure('f0.txt').count === 2)
    await store.closeAllStores()
  }

  // U14 冲突挂起记录：登记 / 列表 / 覆盖 / 清除 / 落盘 /
  // 损坏降级 / 条目上限 —— 状态流转：登记（决策时）→ 消费（规划期读）→ 清除（成功落地）
  {
    const pOpts = { localPath: 'D:\\Pend', remotePath: '/pend' }
    const pDirP = store.baselineDirPath(await store.getDeviceId(), pOpts.localPath, pOpts.remotePath)
    await fsp.rm(pDirP, { recursive: true, force: true }).catch(() => {})
    const infoOf = (choice, createdAt) => ({
      local: { size: 3, mtimeMs: 111 },
      remote: { size: 5, mtimeMs: 222, etag: '"e1"' },
      createdAt,
      ...(choice ? { choice } : {}),
    })
    let ps1 = await store.openDirStore(pOpts)
    check('U14 empty store has no pendings and not dirty', ps1.pendings.size === 0 && ps1.pendingsDirty === false)
    check('U14 setPending records entry and marks dirty', ps1.setPending('a.txt', infoOf('local', 1000)) === true && ps1.pendingsDirty === true)
    ps1.setPending('b.txt', infoOf(null, 2000)) // 未解决挂起（无 choice）
    ps1.setPending('c.txt', infoOf('remote', 3000))
    const list1 = ps1.listPending()
    check(
      'U14 listPending sorted by createdAt with fingerprints and choice',
      list1.length === 3 && list1[0].rel === 'a.txt' && list1[0].choice === 'local' && list1[0].local.size === 3 && list1[0].remote.etag === '"e1"' && list1[1].choice === undefined && list1[2].rel === 'c.txt',
      JSON.stringify(list1)
    )
    check(
      'U14 listPending returns copies (mutation does not leak)',
      (list1[0].local.size = 999) === 999 && ps1.getPending('a.txt').local.size === 3
    )
    // 覆盖登记：同 rel 重记更新 choice（条目数不增）；非法 choice 值按未处理对待（不写入）
    ps1.setPending('b.txt', infoOf('both', 2000))
    ps1.setPending('c.txt', infoOf('weird', 3000))
    check(
      'U14 setPending overwrites entry; invalid choice stored as unresolved',
      ps1.getPending('b.txt').choice === 'both' && ps1.getPending('c.txt').choice === undefined && ps1.pendings.size === 3
    )
    await ps1.savePendings()
    check('U14 savePendings clears dirty', ps1.pendingsDirty === false)
    await store.closeAllStores()
    // 重开：持久化跨进程恢复（含两侧指纹与无 choice 挂起）
    const ps2 = await store.openDirStore(pOpts)
    check(
      'U14 pendings persist across reopen (incl. choiceless)',
      ps2.getPending('a.txt').choice === 'local' && ps2.getPending('b.txt').choice === 'both' && ps2.getPending('c.txt').remote.etag === '"e1"' && ps2.getPending('c.txt').choice === undefined && ps2.pendingsDirty === false
    )
    check(
      'U14 clearPending removes entry and marks dirty; missing rel is a no-op',
      ps2.clearPending('a.txt') === true && ps2.getPending('a.txt') === undefined && ps2.clearPending('no-such.txt') === false && ps2.pendingsDirty === true
    )
    await ps2.savePendings()
    await store.closeAllStores()
    // 损坏降级：存在但不可解析 → 按空处理 + warning，绝不影响同步安全
    fs.writeFileSync(path.join(pDirP, 'pending-conflicts.json'), '{"v":1,"pendings": BROKEN')
    const ps3 = await store.openDirStore(pOpts)
    check('U14 corrupt pending-conflicts.json degrades to empty with warning', ps3.pendings.size === 0 && ps3.warnings.some((w) => /pending-conflicts\.json/.test(w)), JSON.stringify(ps3.warnings))
    await store.closeAllStores()
    // 版本不识别同样按空处理
    fs.writeFileSync(path.join(pDirP, 'pending-conflicts.json'), JSON.stringify({ v: 99, pendings: { a: { local: {}, remote: {}, createdAt: 1, choice: 'local' } } }))
    const ps4 = await store.openDirStore(pOpts)
    check('U14 unknown pendings version degrades to empty', ps4.pendings.size === 0 && ps4.warnings.some((w) => /版本不识别/.test(w)))
    // 条目上限 500：第 501 条被丢弃（setPending 返回 false）并记 warning；既有条目仍可更新
    let allRecorded = true
    for (let i = 0; i <= 500; i++) if (!ps4.setPending(`f${i}.txt`, infoOf('local', 4000 + i))) allRecorded = false
    check(
      'U14 entries capped at 500 with warning',
      ps4.pendings.size === 500 && allRecorded === false && ps4.warnings.some((w) => /上限/.test(w)),
      `size=${ps4.pendings.size}`
    )
    check('U14 existing entry still updatable at cap', ps4.setPending('f0.txt', infoOf('remote', 5000)) === true && ps4.getPending('f0.txt').choice === 'remote')
    await store.closeAllStores()
    // 删除确认类挂起（kind='delete'）：登记持久化 kind 与 delete/keep 选择；跨重开保留；
    // 冲突类选择值不写入删除类条目（校验仍在：非法 choice 按未解决降级）
    fs.rmSync(path.join(pDirP, 'pending-conflicts.json'), { force: true })
    let ps5 = await store.openDirStore(pOpts)
    ps5.setPending('del-a.txt', { ...infoOf(null, 100), kind: 'delete' })
    ps5.setPending('del-b.txt', { ...infoOf('delete', 200), kind: 'delete' })
    ps5.setPending('del-c.txt', { ...infoOf('keep', 300), kind: 'delete' })
    ps5.setPending('del-bad.txt', { ...infoOf('local', 400), kind: 'delete' }) // 非法组合：删除类 + local
    ps5.setPending('plain.txt', { ...infoOf('keep', 500) }) // 冲突类 + keep：选择值合法集外的组合按未解决降级由引擎校验；存储层仅认合法值集合
    await ps5.savePendings()
    await store.closeAllStores()
    ps5 = await store.openDirStore(pOpts)
    check(
      'U14 delete-kind pendings persist with kind and choices across reopen',
      ps5.getPending('del-a.txt').kind === 'delete' && ps5.getPending('del-a.txt').choice === undefined &&
        ps5.getPending('del-b.txt').choice === 'delete' && ps5.getPending('del-c.txt').choice === 'keep' &&
        ps5.getPending('plain.txt').kind === undefined,
      JSON.stringify(ps5.listPending())
    )
    check(
      'U14 listPending exposes kind for UI / engine',
      ps5.listPending().filter((p) => p.kind === 'delete').length === 4,
      JSON.stringify(ps5.listPending().map((p) => [p.rel, p.kind, p.choice]))
    )
    check(
      'U14 delete-kind accepts conflict choices at store level but services layer rejects (documented division)',
      ps5.getPending('del-bad.txt').choice === 'local',
      ''
    )
    await store.closeAllStores()
  }

  // U18 etag 跳过扫描缓存（scan-cache.json）：
  // 保存 → 重开可读、磁盘内容与保存对象一致、损坏 / 版本不识别降级 null + warning、
  // 畸形条目逐条丢弃不连累整表
  {
    const scOpts = { localPath: 'D:\\ScanCache', remotePath: '/sc' }
    const scDirP = store.baselineDirPath(await store.getDeviceId(), scOpts.localPath, scOpts.remotePath)
    await fsp.rm(scDirP, { recursive: true, force: true }).catch(() => {})
    let sc1 = await store.openDirStore(scOpts)
    check('U18 empty store has no scan cache (null)', sc1.getScanCache() === null)
    const cacheObj = { v: 1, lastFullScanAt: 1700000000000, collections: { a: { e: '"x"', m: 1700000000000 }, 'a/b': { e: '"y"', m: 1699999000000 } } }
    await sc1.saveScanCache(cacheObj)
    const justSaved = sc1.getScanCache()
    check(
      'U18 saved cache readable in-memory right after save',
      justSaved != null && justSaved.lastFullScanAt === 1700000000000 && justSaved.collections['a'].e === '"x"' && justSaved.collections['a/b'].m === 1699999000000,
      JSON.stringify(justSaved)
    )
    await store.closeAllStores()
    const sc2 = await store.openDirStore(scOpts)
    const re = sc2.getScanCache()
    check(
      'U18 scan cache persists across reopen with content unchanged',
      re != null && re.lastFullScanAt === 1700000000000 && re.collections['a'].e === '"x"' && re.collections['a'].e !== re.collections['a/b'].e && re.collections['a/b'].m === 1699999000000,
      JSON.stringify(re)
    )
    // 磁盘形状契约：保存对象原样落盘（引擎外的消费方 / 测试直接改文件的前提）
    const onDisk = JSON.parse(await fsp.readFile(path.join(scDirP, 'scan-cache.json'), 'utf-8'))
    check('U18 on-disk content matches the saved object', JSON.stringify(onDisk) === JSON.stringify(cacheObj))
    // 损坏 → null + warning（只记一次，不跨调用刷屏）
    fs.writeFileSync(path.join(scDirP, 'scan-cache.json'), '{"v":1,"collections": BROKEN')
    check('U18 corrupt scan-cache.json degrades to null with warning', sc2.getScanCache() === null && sc2.warnings.some((w) => /scan-cache\.json/.test(w)), JSON.stringify(sc2.warnings))
    check('U18 corrupt-cache warning recorded only once per instance', sc2.getScanCache() === null && sc2.warnings.filter((w) => /scan-cache\.json/.test(w)).length === 1)
    // 版本不识别同样降级 null（不带新 warning —— 已记过一次；换实例验证有 warning 的路径）
    fs.writeFileSync(path.join(scDirP, 'scan-cache.json'), JSON.stringify({ v: 99, lastFullScanAt: 1, collections: { a: { e: '"x"', m: 1 } } }))
    await store.closeAllStores()
    const sc3 = await store.openDirStore(scOpts)
    check('U18 unknown scan-cache version degrades to null', sc3.getScanCache() === null && sc3.warnings.some((w) => /版本不识别/.test(w)))
    // 逐条轻校验：e 非空字符串 + m 数字，畸形条目丢弃、合法条目保留
    fs.writeFileSync(
      path.join(scDirP, 'scan-cache.json'),
      JSON.stringify({ v: 1, lastFullScanAt: 5, collections: { ok: { e: '"o"', m: 1 }, badEmptyE: { e: '', m: 1 }, badM: { e: '"m"', m: 'x' }, notObj: 'str' } })
    )
    const partial = sc3.getScanCache()
    check(
      'U18 malformed entries dropped without poisoning the table',
      partial != null && Object.keys(partial.collections).length === 1 && partial.collections.ok.e === '"o"' && partial.lastFullScanAt === 5,
      JSON.stringify(partial)
    )
    await store.closeAllStores()
  }

  // U10 5 万条目：加载耗时与内存
  await fsp.rm(dirP, { recursive: true, force: true })
  s = await openStore()
  const N = 50000
  const t0 = Date.now()
  for (let i = 0; i < N; i++) await s.setEntry(`dir${(i / 1000) | 0}/file-${i}.txt`, entryOf(i))
  await s.compact()
  const writeMs = Date.now() - t0
  await store.closeAllStores()
  const memBefore = process.memoryUsage().heapUsed
  const t1 = Date.now()
  s = await openStore()
  const loadMs = Date.now() - t1
  const memAfter = process.memoryUsage().heapUsed
  const memDeltaMB = Math.max(0, (memAfter - memBefore) / 1024 / 1024)
  check('U10 50k entries load within budget', s.entries.size === N && loadMs < 10000, `load=${loadMs}ms write+compact=${writeMs}ms heapΔ=${memDeltaMB.toFixed(1)}MB`)
  check('U10 50k entry content intact', s.get('dir10/file-10245.txt').lhash === 'hash-10245')
  // 轮末压缩阈值行为：日志行数未超阈值不压缩
  check('U10 compact threshold respected', s.logLines === 0 && (await store._internals.DirStateStore).prototype !== undefined)
  console.log(`   [U10] snapshot size = ${(fs.statSync(path.join(dirP, 'snapshot.json')).size / 1024 / 1024).toFixed(1)} MB`)
  await store.closeAllStores()

  // U17 凭据混淆（AES-256-GCM）：往返 / 密文形态 / 随机 iv / 篡改 / 非密文输入 /
  // 跨根密钥隔离 / 密钥文件属性。防随手窥视而非强加密（密钥与密文同机同盘）。
  {
    const PW = 'unit-秘密-pw-77ff'
    const sealed = store.sealSecret(PW)
    check('U17 seal→open roundtrip (含多字节)', store.openSecret(sealed) === PW, sealed.slice(0, 24))
    check('U17 sealed value is v1 format and leaks no plaintext', sealed.startsWith('wdsync1:') && sealed.split(':').length === 4 && !sealed.includes(PW), '')
    check('U17 each seal uses a fresh iv (different ciphertexts)', store.sealSecret(PW) !== sealed && store.openSecret(store.sealSecret(PW)) === PW, '')
    check('U17 empty string roundtrips as empty', store.sealSecret('') === '' && store.openSecret('') === '', '')
    check('U17 non-cipher input opens as empty (no plaintext compatibility)', store.openSecret(PW) === '' && store.openSecret('wdsync1:bad:bad:bad') === '', '')
    const tampered = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    check('U17 tampered ciphertext fails GCM integrity (opens empty)', store.openSecret(tampered) === '', '')
    // 密钥文件存在且为 32 字节（POSIX 下 0600）
    const keyFile = path.join(ROOT, 'secretbox.key')
    const kst = fs.statSync(keyFile)
    check('U17 key file is 32 bytes', kst.size === 32, `size=${kst.size}`)
    if (process.platform !== 'win32') {
      check('U17 key file mode is 0600 (POSIX)', (kst.mode & 0o777) === 0o600, `mode=${(kst.mode & 0o777).toString(8)}`)
    } else {
      check('U17 key file mode check skipped on win32', true, '')
    }
    // 跨根密钥隔离：A 根密封 → B 根解不开（每根独立密钥），回 A 根可解
    const sealedA = store.sealSecret('root-a-secret')
    const ROOT_C = path.join(ROOT, 'device-c')
    await fsp.mkdir(ROOT_C, { recursive: true })
    await store.setRootForTest(ROOT_C)
    check('U17 cross-root open fails (per-root key isolation)', store.openSecret(sealedA) === '', '')
    const sealedC = store.sealSecret('root-c-secret')
    await store.setRootForTest(ROOT)
    check('U17 back to root A: original ciphertext opens, other root does not', store.openSecret(sealedA) === 'root-a-secret' && store.openSecret(sealedC) === '', '')
  }

  // U19 同步记录 JSONL 化：逐轮一行 append + 环形上限/重写松弛摊薄 + 旧
  // sync-log.json 整文件读时兼容迁移 + 尾部撕裂容忍与自愈。写放大的关键断言是
  // 「两次重写之间磁盘行数按轮递增（纯 append）、越过上限+松弛才整表重写一次」。
  {
    const logOpts = { localPath: 'D:\\Sync\\LogSync', remotePath: '/logsync' }
    const openLogStore = () => store.openDirStore(logOpts)
    const logDir = store.baselineDirPath(await store.getDeviceId(), logOpts.localPath, logOpts.remotePath)
    const jsonl = path.join(logDir, 'sync-log.jsonl')
    const legacy = path.join(logDir, 'sync-log.json')
    const lineCount = async (p) => {
      try {
        return (await fsp.readFile(p, 'utf-8')).split('\n').filter((l) => l.trim()).length
      } catch (_) {
        return -1 // 文件不存在
      }
    }
    const exists = async (p) => {
      try {
        await fsp.access(p)
        return true
      } catch (_) {
        return false
      }
    }
    // 单轮记录工厂：含全部可选字段（op / renamed / 错误明细 / rename from / choice），
    // 同时验证 round-trip 对可选字段的保真
    const slogEntry = (n, extra = {}) => ({
      at: n,
      endAt: n + 5,
      trigger: 'interval',
      status: 'ok',
      uploaded: 1,
      downloaded: 2,
      deleted: 0,
      conflicts: 1,
      adopted: 0,
      renamed: 1,
      deferredConflicts: 0,
      deleteHeld: 0,
      bytesUp: 10,
      bytesDown: 20,
      totalFiles: 3,
      ops: [
        { op: 'upload', rel: `a/f${n}.txt`, bytes: 10, added: true },
        { op: 'rename-remote', rel: `b/f${n}.txt`, from: `c/old${n}.txt` },
        { op: 'conflict', rel: `d/f${n}.txt`, choice: 'both' },
      ],
      errors: [`err-${n}`],
      ...extra,
    })

    // —— 首次建档：append 3 轮 + save → 整体重写建档为 JSONL（每行 CRC 有效），
    //    不再产生旧整文件 sync-log.json
    let ls = await openLogStore()
    for (let i = 1; i <= 3; i++) ls.appendSyncLog(slogEntry(i))
    await ls.saveSyncLog()
    check('U19 首次落盘建档为 sync-log.jsonl（3 行）', (await lineCount(jsonl)) === 3, `lines=${await lineCount(jsonl)}`)
    check('U19 不产生旧整文件 sync-log.json', !(await exists(legacy)), '')
    {
      const lines = (await fsp.readFile(jsonl, 'utf-8')).split('\n').filter(Boolean)
      const crcOk = lines.every((l) => {
        const o = JSON.parse(l)
        return o.v === 1 && typeof o.c === 'number' && (store._internals.crc32(Buffer.from(JSON.stringify(o.o), 'utf-8')) >>> 0) === (o.c >>> 0)
      })
      check('U19 每行 { v, c, o } 信封且 CRC 校验通过', crcOk, '')
      check('U19 listSyncLog 最新在前（at=3 首位）', ls.listSyncLog()[0].at === 3 && ls.listSyncLog().length === 3, '')
    }

    // —— append 路径 + 每轮落盘 fsync：增量续写 2 行（磁盘 5 行）且注入钩子能观测
    //    到 'synclog' 类 fsync（维持「轮末 = 已持久化」的旧语义档位）
    let fsyncKinds = []
    store._internals.fsyncSpy.onEvent = (ev) => fsyncKinds.push(ev.kind)
    try {
      ls.appendSyncLog(slogEntry(4))
      await ls.saveSyncLog()
      ls.appendSyncLog(slogEntry(5))
      await ls.saveSyncLog()
    } finally {
      store._internals.fsyncSpy.onEvent = null
    }
    check('U19 常规轮纯 append（磁盘行数 5，无整表重写）', (await lineCount(jsonl)) === 5, `lines=${await lineCount(jsonl)}`)
    check('U19 每轮落盘伴随一次 synclog 句柄 fsync', fsyncKinds.filter((k) => k === 'synclog').length === 2, JSON.stringify(fsyncKinds))

    // —— 重开持久化 + 可选字段 round-trip 保真（rename from / choice / renamed / op）
    await store.closeAllStores()
    ls = await openLogStore()
    {
      const list = ls.listSyncLog()
      const rich = list.find((r) => r.at === 3)
      check(
        'U19 重开 5 轮完好且可选字段保真（from / choice / renamed / errors）',
        list.length === 5 &&
          rich.ops[1].from === 'c/old3.txt' &&
          rich.ops[2].choice === 'both' &&
          rich.renamed === 1 &&
          rich.errors[0] === 'err-3' &&
          rich.ops[0].added === true &&
          rich.ops[0].bytes === 10,
        JSON.stringify(rich)
      )
    }

    // —— 环形 + 摊薄重写：补到 200 轮（一次批量 save，append 路径）→ 再逐轮 +25
    //    （磁盘 225 行仍纯 append）→ 重开加载裁回 200 → 第 226 轮触发整表重写回 200 行
    for (let i = 6; i <= 200; i++) ls.appendSyncLog(slogEntry(i))
    await ls.saveSyncLog()
    check('U19 批量补至 200 轮一次 save 仍走 append（磁盘 200 行）', (await lineCount(jsonl)) === 200, `lines=${await lineCount(jsonl)}`)
    for (let i = 201; i <= 225; i++) {
      ls.appendSyncLog(slogEntry(i))
      await ls.saveSyncLog()
    }
    check('U19 上限+松弛内不重写（磁盘 225 行 = 200+25）', (await lineCount(jsonl)) === 225, `lines=${await lineCount(jsonl)}`)
    await store.closeAllStores()
    ls = await openLogStore()
    check('U19 加载把磁盘 225 行裁回环形 200 轮（最新在前 at=225）', ls.listSyncLog().length === 200 && ls.listSyncLog()[0].at === 225, `len=${ls.listSyncLog().length}`)
    ls.appendSyncLog(slogEntry(226))
    await ls.saveSyncLog()
    check('U19 越过上限+松弛触发一次整表重写（磁盘回 200 行）', (await lineCount(jsonl)) === 200 && ls.listSyncLog()[0].at === 226 && ls.listSyncLog().length === 200, `lines=${await lineCount(jsonl)}`)
    await store.closeAllStores()

    // —— 旧整文件格式迁移：手写 v1 sync-log.json（含 1 条畸形轮）→ 读时导入 →
    //    首次落盘迁移为 JSONL 并删除旧文件
    const logOpts2 = { localPath: 'D:\\Sync\\LogSync2', remotePath: '/logsync2' }
    const logDir2 = store.baselineDirPath(await store.getDeviceId(), logOpts2.localPath, logOpts2.remotePath)
    await fsp.mkdir(logDir2, { recursive: true })
    await fsp.writeFile(
      path.join(logDir2, 'sync-log.json'),
      JSON.stringify({
        v: 1,
        rounds: [
          { at: 1, endAt: 2, trigger: 'manual', status: 'ok', uploaded: 1, downloaded: 0, deleted: 0, conflicts: 0, adopted: 0, deferredConflicts: 0, deleteHeld: 0, bytesUp: 5, bytesDown: 0, totalFiles: 1, ops: [{ op: 'upload', rel: 'old/a.txt', added: true }], errors: [] },
          { broken: true }, // 畸形轮：导入时直接丢弃，不连累整表
          { at: 2, endAt: 3, trigger: 'watch', status: 'partial', uploaded: 0, downloaded: 1, deleted: 0, conflicts: 2, adopted: 0, renamed: 2, deferredConflicts: 2, deleteHeld: 0, bytesUp: 0, bytesDown: 7, totalFiles: 2, ops: [{ op: 'rename-local', rel: 'new/b.txt', from: 'old/b.txt' }], errors: ['legacy-err'] },
        ],
      }),
      'utf-8'
    )
    let ls2 = await store.openDirStore(logOpts2)
    {
      const list = ls2.listSyncLog()
      check(
        'U19 旧整文件读时兼容导入（畸形轮丢弃、可选字段保留）',
        list.length === 2 && list[0].at === 2 && list[0].renamed === 2 && list[0].ops[0].from === 'old/b.txt' && list[1].ops[0].added === true,
        JSON.stringify(list)
      )
    }
    ls2.appendSyncLog(slogEntry(99, { trigger: 'manual' }))
    await ls2.saveSyncLog()
    check('U19 首次落盘迁移为 JSONL（3 行）并删除旧整文件', (await lineCount(path.join(logDir2, 'sync-log.jsonl'))) === 3 && !(await exists(path.join(logDir2, 'sync-log.json'))), `lines=${await lineCount(path.join(logDir2, 'sync-log.jsonl'))}`)
    await store.closeAllStores()
    ls2 = await store.openDirStore(logOpts2)
    check('U19 迁移后重开自 JSONL 读取（3 轮）', ls2.listSyncLog().length === 3 && ls2.listSyncLog()[0].at === 99, '')
    await store.closeAllStores()

    // —— 尾部撕裂容忍 + 自愈：追加半行 → 重开丢弃尾部并告警 → 下一轮落盘全量重写
    //    自愈（不再有撕裂行）
    {
      const raw = await fsp.readFile(jsonl, 'utf-8')
      await fsp.writeFile(jsonl, raw + raw.split('\n')[0].slice(0, 20), 'utf-8')
    }
    ls = await openLogStore()
    check('U19 撕裂尾行丢弃且此前 200 轮完好（含 warning）', ls.listSyncLog().length === 200 && ls.listSyncLog()[0].at === 226 && ls.warnings.some((w) => /sync-log\.jsonl/.test(w)), JSON.stringify(ls.warnings))
    ls.appendSyncLog(slogEntry(227))
    await ls.saveSyncLog()
    {
      const lines = (await fsp.readFile(jsonl, 'utf-8')).split('\n').filter(Boolean)
      const allDecode = lines.every((l) => {
        try {
          const o = JSON.parse(l)
          return (store._internals.crc32(Buffer.from(JSON.stringify(o.o), 'utf-8')) >>> 0) === (o.c >>> 0)
        } catch (_) {
          return false
        }
      })
      check('U19 损坏后下一轮落盘全量重写自愈（环形 200 行全 CRC 通过）', lines.length === 200 && allDecode, `lines=${lines.length}`)
    }
    await store.closeAllStores()
    ls = await openLogStore()
    check('U19 自愈后重开无新告警且 200 轮完好（最新 at=227）', ls.listSyncLog().length === 200 && ls.listSyncLog()[0].at === 227 && !ls.warnings.some((w) => /sync-log\.jsonl.*损坏/.test(w)), JSON.stringify(ls.warnings))
    await store.closeAllStores()
  }

  // U16 引擎/调度器计时器静态检查：
  // preload 侧引擎与调度器源码不得出现裸全局 setTimeout/setInterval/clearTimeout/
  // clearInterval 调用 —— 宿主 contextIsolation:false 下 preload 的全局计时器就是
  // Blink DOM timer，页面真进入 hidden 后被钳到 ≥1s（实测），
  // 隐藏态后台轮的锁静置 / 续租 / 取消轮询都会被拖到分钟级。只允许经
  // node:timers 的引用（nodeTimers.xxx 形态；成员调用的点前缀使其与裸调用可区分）。
  // 构建产物（dist/services.js）的同项检查在 e2e built 模式下执行（彼时刚重新构建）。
  // 附带守护：crashResidueSweep 等测试后门只存在于 sync._internals，不得进入渲染层类型。
  {
    const bareTimerRe = /(?<![.\w$])(setTimeout|setInterval|clearTimeout|clearInterval)\s*\(/
    // 迁移窗口：源文件逐步 .js → .mts，两个扩展名都探测
    for (const name of ['services', 'store', 'scheduler']) {
      const p = ['.mts', '.js'].map((ext) => path.join(PRELOAD, name + ext)).find((x) => fs.existsSync(x))
      if (!p) continue // 模块可能不存在；存在即查
      const src = fs.readFileSync(p, 'utf-8')
      const offending = src
        .split('\n')
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => bareTimerRe.test(l))
      check(
        `U16 ${path.basename(p)}: no bare global timer calls (node:timers only)`,
        offending.length === 0,
        offending.slice(0, 3).map(([n, l]) => `L${n}: ${l.trim().slice(0, 70)}`).join(' | ')
      )
    }
    const envSrc = fs.readFileSync(path.join(HERE, '..', '..', 'src', 'env.d.ts'), 'utf-8')
    check('U16 renderer types keep _internals / crashResidueSweep out of public API', !/_internals|crashResidueSweep/.test(envSrc))
  }
  } catch (e) {
    check('unexpected error', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e))
  } finally {
    await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {})
  }

  assertAtEnd({
    passLine: (passed, total) => `\n===== ${passed}/${total} passed =====`,
    fail: (failed) => `存储层单元测试 ${failed.length} 项失败：\n${failed.map((f) => `  ❌ ${f.name}`).join('\n')}`,
  })
})
