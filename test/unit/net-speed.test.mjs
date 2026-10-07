/**
 * 实时速率链路的单元测试：
 *   N-T1 fmtSpeed 速率格式化（fmtBytes 口径 + /s 后缀）；
 *   N-T2 网络层流量计数：PUT 请求体计入上传、GET 响应体计入下载（全局累计 +
 *        每轮流量袋同步累加），PROPFIND 清单与控制方法不计 —— 扫描规划期的
 *        目录列表流量不会伪装成「下载速度」。
 * 调度器 1s 采样外发（net-speed 事件）的端到端行为见 test/shard-net.test.mjs「NS」节。
 * 运行：npx vitest run test/unit（或 npm run test:unit）
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { beforeAll, afterAll, test } from 'vitest'
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
  // 迷你 HTTP 服务器：PUT 收体即弃（201）、GET 回 64KB 固定内容、其余方法回 207 XML
  const GET_BODY = Buffer.alloc(64 * 1024, 7)
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
      res.writeHead(200, { 'content-length': GET_BODY.length, etag: '"t1"' })
      res.end(GET_BODY)
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
