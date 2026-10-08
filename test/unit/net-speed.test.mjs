/**
 * 实时速率链路的单元测试：
 *   N-T1 fmtSpeed 速率格式化（fmtBytes 口径 + /s 后缀）；
 *   N-T2 网络层流量计数：PUT 请求体计入上传、GET 响应体计入下载（全局累计 +
 *        每轮流量袋同步累加），PROPFIND 清单与控制方法不计 —— 扫描规划期的
 *        目录列表流量不会伪装成「下载速度」；
 *   N-T3 限速修改即时生效：applyNetLimits 推送后，挂 __wdsyncLiveLimits 的
 *        请求（模拟调度器轮次）按推送速率建桶，在途传输的字节桶随推送原地
 *        迁移（改数值 / 改 0 = 不限制均即时生效）。
 * 调度器 1s 采样外发（net-speed 事件）的端到端行为见 test/shard-net.test.mjs「NS」节。
 * 运行：npx vitest run test/unit（或 npm run test:unit）
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { beforeAll, afterAll, test, vi } from 'vitest'
import { makeCheck, UNIT_HERE as HERE } from '../harness.mjs'

const PRELOAD = path.join(HERE, '..', '..', 'src-ztools', 'preload')

// 软失败登记 + JSONL 对拍通道（section 固定 'net-speed-unit'）收敛到 harness 的 makeCheck
const { check, assertAtEnd } = makeCheck('net-speed-unit')

let services
let internals
let dav
let port

beforeAll(async () => {
  global.window = {}
  await import(pathToFileURL(path.join(PRELOAD, 'services.mts')).href)
  services = global.window.services
  internals = services.sync._internals
  await services.storage.setRootForTest(path.join(os.tmpdir(), `wdsync-unit-netspeed-${Date.now()}-${process.pid}`))
  // 迷你 HTTP 服务器：PUT 收体即弃（201）、GET 回 64KB 固定内容（/t3/ 前缀回
  // 256KB 供限速迁移用例拉长在途窗口）、其余方法回 207 XML
  const GET_BODY = Buffer.alloc(64 * 1024, 7)
  const GET_BIG = Buffer.alloc(256 * 1024, 9)
  const XML = Buffer.from('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>')
  dav = http.createServer((req, res) => {
    if (req.method === 'PUT') {
      req.resume()
      req.on('end', () => {
        res.writeHead(201, { etag: '"t1"' })
        res.end()
      })
      return
    }
    if (req.method === 'GET') {
      // davRequest 会把 serverUrl（含 /dav/ 前缀）与远端路径拼接，故按包含判定
      const body = req.url && req.url.includes('/t3/') ? GET_BIG : GET_BODY
      res.writeHead(200, { 'content-length': body.length, etag: '"t1"' })
      res.end(body)
      return
    }
    res.writeHead(207, { 'content-length': XML.length, 'content-type': 'application/xml' })
    res.end(XML)
  })
  await new Promise((resolve) => dav.listen(0, '127.0.0.1', resolve))
  port = dav.address().port
})

afterAll(async () => {
  try {
    services.cleanup()
  } catch {
    /* 清理失败不影响断言输出 */
  }
  dav.close()
  assertAtEnd({ fail: (failed, total) => `${failed.length}/${total} 个用例失败：\n  ❌ ${failed.map((f) => f.name).join('\n  ❌ ')}` })
})

const baseCfg = (bag) => ({ serverUrl: `http://127.0.0.1:${port}/dav/`, username: 'u', password: 'p', ...(bag ? { __wdsyncTraffic: bag } : {}) })

test('N-T1：fmtSpeed 速率格式化（fmtBytes 分档口径 + /s 后缀）', async () => {
  const { fmtSpeed } = await import(pathToFileURL(path.join(HERE, '..', '..', 'src', 'composables', 'format.ts')).href)
  check('B 档（整数）', fmtSpeed(512) === '512 B/s', fmtSpeed(512))
  check('KB 档', fmtSpeed(2048) === '2.0 KB/s', fmtSpeed(2048))
  check('MB 档', fmtSpeed(2.2 * 1024 * 1024) === '2.2 MB/s', fmtSpeed(2.2 * 1024 * 1024))
  check('小数先取整再分档', fmtSpeed(1500.7) === '1.5 KB/s', fmtSpeed(1500.7))
  check('0 → 0 B/s（展示位据此隐藏速率段）', fmtSpeed(0) === '0 B/s', fmtSpeed(0))
  check('非法入参按 0 处理', fmtSpeed(undefined) === '0 B/s', fmtSpeed(undefined))
})

test('N-T2：流量计数 —— PUT 上传 / GET 下载计入全局与每轮袋，PROPFIND 清单不计', async () => {
  const { davRequest, netTraffic } = internals
  const bag = { upBytes: 0, downBytes: 0 }
  const cfg = baseCfg(bag)
  const up0 = netTraffic.upBytes
  const down0 = netTraffic.downBytes

  // PUT 缓冲请求体 → 计入上传（全局 + 每轮袋同步累加）
  await davRequest(cfg, 'PUT', '/t1/a.txt', { body: 'x'.repeat(3000) })
  check('PUT 请求体计入上传（全局）', netTraffic.upBytes - up0 >= 3000, String(netTraffic.upBytes - up0))
  check('PUT 请求体计入上传（每轮袋）', bag.upBytes >= 3000, String(bag.upBytes))

  // GET（sinkFile 落盘流）→ 计入下载
  const sink = path.join(os.tmpdir(), `wdsync-nt-${Date.now()}-${process.pid}.bin`)
  await davRequest(cfg, 'GET', '/t1/a.txt', { sinkFile: sink })
  check('GET 响应体计入下载（全局 + 每轮袋）', netTraffic.downBytes - down0 >= 64 * 1024 && bag.downBytes >= 64 * 1024, `全局 ${netTraffic.downBytes - down0} / 袋 ${bag.downBytes}`)
  await fsp.rm(sink, { force: true })

  // PROPFIND 清单 / 控制方法不计入任何方向（上传只认 PUT、下载只认 GET）
  const up1 = netTraffic.upBytes
  const down1 = netTraffic.downBytes
  await davRequest(cfg, 'PROPFIND', '/t1/', { isCollection: true, headers: { Depth: '1' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"/>' })
  check('PROPFIND 响应清单不计入下载', netTraffic.downBytes === down1, String(netTraffic.downBytes - down1))
  check('PROPFIND 请求体不计入上传', netTraffic.upBytes === up1, String(netTraffic.upBytes - up1))
  check('每轮袋与全局累计一致（同步累加）', bag.upBytes === netTraffic.upBytes - up0 && bag.downBytes === netTraffic.downBytes - down0, `袋 ${bag.upBytes}/${bag.downBytes} 全局 ${netTraffic.upBytes - up0}/${netTraffic.downBytes - down0}`)
})

test('N-T3：限速修改即时生效 —— 推送限额后建桶、在途桶原地迁移、改 0 即放开', async () => {
  const { davRequest, applyNetLimits, byteBuckets, liveLimits } = internals
  const origin = `http://127.0.0.1:${port}`
  const serverUrl = `${origin}/dav/`

  // 推送 32KB/s：applyNetLimits 按 origin 归一入表（合法数值才生效，非法按 0）
  applyNetLimits(serverUrl, { uploadKBps: 32, downloadKBps: 32 })
  check('N-T3 推送限额按 origin 入表', liveLimits.get(origin)?.downloadKBps === 32, JSON.stringify([...liveLimits]))
  applyNetLimits('not-a-url', { downloadKBps: 32 })
  check('N-T3 非法地址推送被忽略', ![...liveLimits.keys()].some((k) => k.includes('not-a-url')))

  // 挂 live 标记的请求（模拟调度器轮次）：首块经桶放行即建桶，采用推送速率
  const sink1 = path.join(os.tmpdir(), `wdsync-nt3-${Date.now()}-${process.pid}.bin`)
  const p1 = davRequest({ serverUrl, username: 'u', password: 'p', __wdsyncLiveLimits: true }, 'GET', '/t3/big.bin', { sinkFile: sink1 })
  await vi.waitFor(() => {
    if (!byteBuckets.get(`${origin}|down`)) throw new Error('桶尚未创建')
  }, { timeout: 5000, interval: 20 })
  check('N-T3 live 轮次按推送速率建桶', byteBuckets.get(`${origin}|down`).rate === 32 * 1024, String(byteBuckets.get(`${origin}|down`).rate))

  // 传输仍在途（256KB @ 32KB/s 远未传完）时改限速 → 桶原地迁移，无需等请求结束
  applyNetLimits(serverUrl, { uploadKBps: 512, downloadKBps: 512 })
  await vi.waitFor(() => {
    if (byteBuckets.get(`${origin}|down`).rate !== 512 * 1024) throw new Error('桶速率未迁移')
  }, { timeout: 5000, interval: 20 })
  check('N-T3 在途传输的桶即时迁移到新速率', byteBuckets.get(`${origin}|down`).rate === 512 * 1024)

  // 改 0（不限速）→ 桶速率迁为「不限制」哨兵值，当前传输立即放开
  applyNetLimits(serverUrl, { uploadKBps: 0, downloadKBps: 0 })
  await vi.waitFor(() => {
    if (byteBuckets.get(`${origin}|down`).rate !== internals.BW_UNLIMITED_BPS) throw new Error('桶未放开')
  }, { timeout: 5000, interval: 20 })
  check('N-T3 改 0（不限）即时放开在途传输', byteBuckets.get(`${origin}|down`).rate === internals.BW_UNLIMITED_BPS)

  // 限速三次变化贯穿全程，传输本身不受影响正常收尾
  const r1 = await p1
  check('N-T3 限速变化中传输正常完成', r1.status === 200, String(r1.status))
  check('N-T3 落盘内容完整', (await fsp.stat(sink1)).size === 256 * 1024)
  await fsp.rm(sink1, { force: true })

  // 不挂 live 标记的请求（渲染层直调 / 测试口径）不读限额表：干净源上按请求侧
  // netOpts 建桶（localhost 与 127.0.0.1 是不同 origin，天然桶隔离；64KB 体在
  // 1MB/s 桶的 1 秒突发容量内瞬时完成，不为旧口径额外付出限速等待）
  const sink2 = path.join(os.tmpdir(), `wdsync-nt3-plain-${Date.now()}-${process.pid}.bin`)
  const origin2 = `http://localhost:${port}`
  const r2 = await davRequest({ serverUrl: `${origin2}/dav/`, username: 'u', password: 'p', netOpts: { downloadKBps: 1024 } }, 'GET', '/t1/a.txt', { sinkFile: sink2 })
  check('N-T3 直调路径按请求侧 netOpts 建桶限速', r2.status === 200 && byteBuckets.get(`${origin2}|down`)?.rate === 1024 * 1024, String(byteBuckets.get(`${origin2}|down`)?.rate))
  await fsp.rm(sink2, { force: true })
})
