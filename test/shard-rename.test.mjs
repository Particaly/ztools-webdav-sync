/**
 * e2e 分片「rename」：改名同步（MOVE 配对）与自签名证书连接链路。
 *   RN0 —— 能力探测识别 MOVE 支持 / 不支持（nomove 标记）
 *   RN1 —— 本地改名 → 云端 MOVE（零重传：reqlog 无 PUT、有 MOVE；基线随迁）
 *   RN2 —— 远端改名 → 本地跟随（零下载：reqlog 无 GET；本地 rename 落地）
 *   RN3 —— 同步期 MOVE 被拒（nomove）→ 持久降级 + 下一轮回落删传语义
 *   RN4 —— 内容已变的「改名」不配对（回落删传）
 *   RN5 —— 批量改名不触发批量删除闸（改名不是删除）
 *   T1/T2/T3 —— https 自签名 / 自建 CA 证书：错误文案、信任开关、CA 导入、
 *               信任开启下的完整同步轮（独立 spawn 的 TLS dav-server）
 * 每文件独立 dav-server / 端口 / 根目录（test/harness.mjs）；TLS 服务器另行 spawn。
 * 日常回归：npm run test:fast；本分片全部为 fast 节。
 */
import { test, afterAll } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setupShard, teardownShard, section, check, sleep, isNoop, SP, makeTrashStub, spawnDav, killDav } from './harness.mjs'

const {
  HERE, ROOT, PORT, LOCAL, server, services, cfg, storeModule, BUILT, preloadPath,
  STORAGE_MAIN, STORAGE_A, STORAGE_B, STORAGE_C, STORAGE_D, switchDevice,
  baselineDirOf, setProfile, setMidair, freshStore, tmpLocal, syncP, settleStable, sweepCrashResidue, projDir,
  REQLOG, readReqlog, countReq, lastReqLine,
  DEPTHLOG, readDepthlog, countDepth, clearDepthFlags,
  setThrottle, waitForReqLine, waitAbortLine, runCancelRound, readWalOps, findTempResidue,
  PUP, setNetcut, setPartialPut, puBuf,
  SC_DB, SC_KEY, setSCConfig, createTestSched, makeFakeClock, waitReal, pumpUntil, readLeaderLock, writeLeaderLock,
} = await setupShard({ shard: 'rename' })

// 本地删除（delete-local）经宿主回收站端口：收敛到 harness 工厂（与其它分片同款）
const trash = makeTrashStub()
trash.install()

const FIXTURES = path.join(HERE, 'fixtures')
const setNomove = async (on) => {
  if (on) fs.writeFileSync(path.join(ROOT, '.wdsync-test-nomove'), 'x')
  else await fsp.rm(path.join(ROOT, '.wdsync-test-nomove'), { force: true }).catch(() => {})
}

// ============================================================
// RN0：能力探测识别 MOVE 支持
// ============================================================

section('RN0：能力探测识别 MOVE 支持 / 不支持', async () => {
  await freshStore('rn0')
  const capsOk = await services.dav.probeCapabilities({ ...cfg }, true, '/rn0-cap')
  check('RN0 默认服务器（dav-server 支持 MOVE）→ moveSupported=true', capsOk.moveSupported === true)

  await setNomove(true)
  try {
    await freshStore('rn0b')
    const capsNo = await services.dav.probeCapabilities({ ...cfg }, true, '/rn0-cap')
    check('RN0 nomove 标记 → moveSupported=false', capsNo.moveSupported === false)
    check('RN0 nomove 探测备注包含回落说明', (capsNo.notes || []).some((n) => /MOVE/.test(n)))
  } finally {
    await setNomove(false)
  }
})

// ============================================================
// RN1：本地改名 → 云端 MOVE（零重传）
// ============================================================

section('RN1：本地改名 → 云端 MOVE（零重传）', async () => {
  await freshStore('rn1')
  const lp = await tmpLocal('rn1')
  const content = 'rn1-content-'.repeat(64)
  await fsp.writeFile(path.join(lp, 'a-big.bin'), content)
  const s1 = await syncP(lp, '/proj')
  check('RN1 首轮上传 1 个文件', s1.uploaded === 1)

  // 本地改名（rename 保留 mtime，与真实用户操作一致）
  await fsp.rename(path.join(lp, 'a-big.bin'), path.join(lp, 'b-big.bin'))
  fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x') // 开启请求日志
  try {
    const s2 = await syncP(lp, '/proj')
    check('RN1 改名轮：renamedRemote=1', s2.renamedRemote === 1, JSON.stringify({ renamedRemote: s2.renamedRemote, renamedLocal: s2.renamedLocal }))
    check('RN1 改名轮零删除零上传（不回落删传）', s2.deleted === 0 && s2.uploaded === 0)
    check('RN1 改名轮零冲突', s2.conflicts === 0)
    const lines = await readReqlog()
    check('RN1 云端一次 MOVE（旧路径）', countReq(lines, 'MOVE', '/dav/proj/a-big.bin') === 1)
    check('RN1 新路径零 PUT（内容未重传）', countReq(lines, 'PUT', '/dav/proj/b-big.bin') === 0)
    check('RN1 旧路径零 DELETE', countReq(lines, 'DELETE', '/dav/proj/a-big.bin') === 0)

    // 远端真实状态：只有新名；基线随迁（新条目含 lhash，旧条目删除）
    check('RN1 远端只有新名文件', fs.existsSync(path.join(ROOT, 'proj', 'b-big.bin')) && !fs.existsSync(path.join(ROOT, 'proj', 'a-big.bin')))
    const d = { id: 'p', localPath: lp, remotePath: '/proj', mode: 'two-way' }
    const be = await services.sync._internals.baselineEntry(d, 'b-big.bin')
    check('RN1 基线随迁到新路径（含内容哈希）', !!be && typeof be.lhash === 'string')
    check('RN1 旧路径基线已删除', (await services.sync._internals.baselineEntry(d, 'a-big.bin')) === null)

    const s3 = await syncP(lp, '/proj')
    check('RN1 下一轮 no-op（无乒乓）', isNoop(s3))
  } finally {
    await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
    await fsp.rm(REQLOG, { force: true }).catch(() => {})
  }
})

// ============================================================
// RN2：远端改名 → 本地跟随（零下载）
// ============================================================

section('RN2：远端改名 → 本地跟随（零下载）', async () => {
  await freshStore('rn2')
  const lp = await tmpLocal('rn2')
  const content = 'rn2-content-'.repeat(32)
  await fsp.writeFile(path.join(lp, 'x.txt'), content)
  const s1 = await syncP(lp, '/proj')
  check('RN2 首轮上传 1 个文件', s1.uploaded === 1)

  // 对端设备在服务器上直接改名（模拟另一台设备的 MOVE）
  await fsp.rename(path.join(ROOT, 'proj', 'x.txt'), path.join(ROOT, 'proj', 'y.txt'))
  fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
  try {
    const s2 = await syncP(lp, '/proj')
    check('RN2 跟随轮：renamedLocal=1', s2.renamedLocal === 1, JSON.stringify({ renamedLocal: s2.renamedLocal }))
    check('RN2 跟随轮零下载零删除', s2.downloaded === 0 && s2.deleted === 0)
    const lines = await readReqlog()
    check('RN2 新路径零 GET（内容未重新下载）', countReq(lines, 'GET', '/dav/proj/y.txt') === 0)
    check('RN2 本地旧文件已改名（内容不变）', !fs.existsSync(path.join(lp, 'x.txt')) && (await fsp.readFile(path.join(lp, 'y.txt'), 'utf-8')) === content)
    const d = { id: 'p', localPath: lp, remotePath: '/proj', mode: 'two-way' }
    check('RN2 基线随迁到新路径', (await services.sync._internals.baselineEntry(d, 'y.txt')) !== null)
    const s3 = await syncP(lp, '/proj')
    check('RN2 下一轮 no-op', isNoop(s3))
  } finally {
    await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
    await fsp.rm(REQLOG, { force: true }).catch(() => {})
  }
})

// ============================================================
// RN3：同步期 MOVE 被拒 → 持久降级 + 回落删传
// ============================================================

section('RN3：同步期 MOVE 被拒（nomove）→ 持久降级 + 下一轮回落删传', async () => {
  await freshStore('rn3')
  const lp = await tmpLocal('rn3')
  await fsp.writeFile(path.join(lp, 'r3.bin'), 'rn3-content')
  const s1 = await syncP(lp, '/proj')
  check('RN3 首轮上传成功（探测期 MOVE 正常）', s1.uploaded === 1)

  await fsp.rename(path.join(lp, 'r3.bin'), path.join(lp, 'r3-new.bin'))
  await setNomove(true)
  let failedSummary = null
  try {
    // 改名轮：MOVE 405 → 报错收场（零删除零上传零改名）
    try {
      const s2 = await syncP(lp, '/proj')
      check('RN3 MOVE 被拒的轮次应以错误收场', false, `意外成功：${JSON.stringify(s2)}`)
    } catch (e) {
      failedSummary = e.summary || null
      check('RN3 MOVE 被拒轮报「不支持改名」', /不支持改名/.test(String((e.summary && e.summary.errors && e.summary.errors[0]) || e.message)))
      check('RN3 MOVE 被拒轮零删除零上传', !!failedSummary && failedSummary.deleted === 0 && failedSummary.uploaded === 0)
    }
    check('RN3 能力缓存持久降级 moveSupported=false', (await services.dav.getCachedCapabilities({ ...cfg }, '/'))?.moveSupported === false)
    // 远端保持旧名（本轮什么都没发生）
    check('RN3 拒绝轮远端仍是旧名', fs.existsSync(path.join(ROOT, 'proj', 'r3.bin')))

    // 下一轮：配对被 moveSupported=false 挡住 → 回落删传语义
    const s3 = await syncP(lp, '/proj')
    check('RN3 回落轮删 1 传 1（既删传语义）', s3.deleted === 1 && s3.uploaded === 1 && (s3.renamedRemote ?? 0) === 0)
    check('RN3 回落轮远端只有新名', fs.existsSync(path.join(ROOT, 'proj', 'r3-new.bin')) && !fs.existsSync(path.join(ROOT, 'proj', 'r3.bin')))
    check('RN3 回落轮本地新名内容不变', (await fsp.readFile(path.join(lp, 'r3-new.bin'), 'utf-8')) === 'rn3-content')
    const s4 = await syncP(lp, '/proj')
    check('RN3 回落收敛后 no-op', isNoop(s4))
  } finally {
    await setNomove(false)
  }
})

// ============================================================
// RN4：内容已变的「改名」不配对（回落删传）
// ============================================================

section('RN4：内容已变（尺寸不同）的「改名」不配对', async () => {
  await freshStore('rn4')
  const lp = await tmpLocal('rn4')
  await fsp.writeFile(path.join(lp, 'c.bin'), 'rn4-original-content')
  const s1 = await syncP(lp, '/proj')
  check('RN4 首轮上传 1 个文件', s1.uploaded === 1)

  // 「改名」同时改了内容（尺寸变化）：尺寸不同 → 不满足配对条件
  await fsp.rename(path.join(lp, 'c.bin'), path.join(lp, 'd.bin'))
  await fsp.writeFile(path.join(lp, 'd.bin'), 'rn4-original-content-plus-more')
  fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
  try {
    const s2 = await syncP(lp, '/proj')
    check('RN4 不配对：删 1 传 1（删传语义）', s2.deleted === 1 && s2.uploaded === 1 && (s2.renamedRemote ?? 0) === 0)
    const lines = await readReqlog()
    check('RN4 未发 MOVE', countReq(lines, 'MOVE', '/dav/proj/c.bin') === 0)
    check('RN4 远端只有新名（新内容）', (await fsp.readFile(path.join(ROOT, 'proj', 'd.bin'), 'utf-8')) === 'rn4-original-content-plus-more')
    const s3 = await syncP(lp, '/proj')
    check('RN4 收敛后 no-op', isNoop(s3))
  } finally {
    await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
    await fsp.rm(REQLOG, { force: true }).catch(() => {})
  }
})

// ============================================================
// RN5：批量改名不触发批量删除闸
// ============================================================

section('RN5：批量改名（60 个）不触发批量删除闸', async () => {
  await freshStore('rn5')
  const lp = await tmpLocal('rn5')
  for (let i = 1; i <= 60; i++) await fsp.writeFile(path.join(lp, `f${String(i).padStart(2, '0')}.txt`), `rn5-${i}`)
  const s1 = await syncP(lp, '/proj')
  check('RN5 首轮上传 60 个文件', s1.uploaded === 60)

  // 全部改名（基线 60 → 批量删除阈值 max(50, 12) = 50；若走删除语义必然拦截）
  for (let i = 1; i <= 60; i++) await fsp.rename(path.join(lp, `f${String(i).padStart(2, '0')}.txt`), path.join(lp, `g${String(i).padStart(2, '0')}.txt`))
  const s2 = await syncP(lp, '/proj')
  check('RN5 批量改名：renamedRemote=60', s2.renamedRemote === 60)
  check('RN5 批量改名零删除零上传', s2.deleted === 0 && s2.uploaded === 0)
  check('RN5 未触发批量删除闸（deleteHeld=0）', (s2.deleteHeld ?? 0) === 0)
  check('RN5 远端只有新名', fs.existsSync(path.join(ROOT, 'proj', 'g60.txt')) && !fs.existsSync(path.join(ROOT, 'proj', 'f01.txt')))
  const s3 = await syncP(lp, '/proj')
  check('RN5 收敛后 no-op', isNoop(s3))
})

// ============================================================
// T1/T2/T3：自签名 / 自建 CA 证书的 https 连接链路（独立 TLS dav-server）
// ============================================================

section('T1/T2/T3：自签名与自建 CA 证书的连接链路', async () => {
  // TLS dav-server 改用 harness 的 spawnDav（端口 0 随机分配；含父进程死亡看门狗注入）
  const selfSigned = await spawnDav({ tag: 'tls1', cert: path.join(FIXTURES, 'self-signed.crt'), key: path.join(FIXTURES, 'self-signed.key') })
  const caSigned = await spawnDav({ tag: 'tls2', cert: path.join(FIXTURES, 'ca-signed.crt'), key: path.join(FIXTURES, 'ca-signed.key') })
  const caPem = fs.readFileSync(path.join(FIXTURES, 'test-ca.crt'), 'utf-8')
  const urlTls1 = `https://127.0.0.1:${selfSigned.port}/dav/`
  const urlTls2 = `https://127.0.0.1:${caSigned.port}/dav/`
  try {
    // T1 自签名：默认校验失败 → 友好文案指引信任开关；开启信任 → 连接成功
    const bad = await services.dav.testConnection({ serverUrl: urlTls1, username: 'u', password: 'p' })
    check('T1 自签名默认拒绝（连接失败）', bad.ok === false)
    check('T1 错误文案指向证书问题与信任开关', /证书/.test(String(bad.error || '')) && /信任此服务器证书/.test(String(bad.error || '')), String(bad.error || '').slice(0, 80))

    const trusted = await services.dav.testConnection({ serverUrl: urlTls1, username: 'u', password: 'p', tls: { trustServerCertificate: true } })
    check('T1 开启信任后连接成功', trusted.ok === true, String(trusted.error || ''))

    // T2 自建 CA 签发：默认失败；导入 CA → 校验通过
    const bad2 = await services.dav.testConnection({ serverUrl: urlTls2, username: 'u', password: 'p' })
    check('T2 CA 签发证书默认拒绝', bad2.ok === false && /证书/.test(String(bad2.error || '')))
    const withCa = await services.dav.testConnection({ serverUrl: urlTls2, username: 'u', password: 'p', tls: { caPem } })
    check('T2 导入 CA 后连接成功（完整校验）', withCa.ok === true, String(withCa.error || ''))

    // T3 信任开启下的完整同步轮（引擎路径 + TLS Agent 池）
    await switchDevice(STORAGE_MAIN)
    const lp = await tmpLocal('tls3')
    await fsp.writeFile(path.join(lp, 'tls.txt'), 'tls-engine-round')
    const tlsCfg = { serverUrl: urlTls1, username: 'u', password: 'p', tls: { trustServerCertificate: true } }
    const s1 = await services.sync.syncDirectory(tlsCfg, { id: 'p', localPath: lp, remotePath: '/proj', mode: 'two-way' }, SP, {})
    check('T3 信任开启下引擎轮上传成功', s1.uploaded === 1)
    check('T3 远端落盘新文件', fs.existsSync(path.join(selfSigned.root, 'proj', 'tls.txt')))
    // 同一服务器换回严格校验（Agent 分池生效性）：连接测试重新失败
    const strict = await services.dav.testConnection({ serverUrl: urlTls1, username: 'u', password: 'p' })
    check('T3 严格校验与信任连接互不影响（分池生效）', strict.ok === false)
  } finally {
    for (const h of [selfSigned, caSigned]) await killDav(h)
  }
})

afterAll(async () => {
  await teardownShard({ ROOT, LOCAL, server })
})
