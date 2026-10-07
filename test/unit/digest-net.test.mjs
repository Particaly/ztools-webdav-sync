/**
 * 网络层新能力的单元测试：Digest 认证（挑战解析 / 应答计算 / RFC 2617 标准向量）
 * 与 resolveNetOpts 的扩展字段（带宽限速 / 代理地址解析）。
 * e2e 行为链路（401 挑战应答 / 限速耗时 / 代理转发）见 test/shard-net.test.mjs。
 * 运行：npx vitest run test/unit（或 npm run test:unit）
 */
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { beforeAll, afterAll, test } from 'vitest'
import { makeCheck, UNIT_HERE as HERE } from '../harness.mjs'

const PRELOAD = path.join(HERE, '..', '..', 'src-ztools', 'preload')

// 软失败登记 + JSONL 对拍通道（section 固定 'digest-net-unit'）收敛到 harness 的 makeCheck
const { check, assertAtEnd } = makeCheck('digest-net-unit')

let services
let internals

beforeAll(async () => {
  global.window = {}
  await import(pathToFileURL(path.join(PRELOAD, 'services.mts')).href)
  services = global.window.services
  internals = services.sync._internals
  await services.storage.setRootForTest(path.join(os.tmpdir(), `wdsync-unit-digest-${Date.now()}-${process.pid}`))
})

afterAll(() => {
  try {
    services.cleanup()
  } catch {
    /* 清理失败不影响断言输出 */
  }
  assertAtEnd({ fail: (failed, total) => `${failed.length}/${total} 个用例失败：\n  ❌ ${failed.map((f) => f.name).join('\n  ❌ ')}` })
})

test('U-D1：Digest 挑战解析（引号 / 无引号 / 多方案头）', () => {
  const { parseDigestChallenge } = internals
  const ch = parseDigestChallenge('realm="wdsync-test-realm", nonce="abc123", qop="auth,auth-int", opaque="op", algorithm=MD5, stale=true')
  check('标准形态各字段就位', ch && ch.realm === 'wdsync-test-realm' && ch.nonce === 'abc123' && ch.opaque === 'op')
  check('qop 保留原串（auth,auth-int）', ch.qop === 'auth,auth-int')
  check('algorithm / stale 解析', ch.algorithm === 'MD5' && ch.stale === true)
  const unq = parseDigestChallenge('realm=bare, nonce="n1"')
  check('无引号值可解析', unq && unq.realm === 'bare' && unq.nonce === 'n1')
  check('缺 realm 返回 null', parseDigestChallenge('nonce="n1"') === null)
  check('缺 nonce 返回 null', parseDigestChallenge('realm="r"') === null)
  check('引号未闭合返回 null', parseDigestChallenge('realm="r, nonce="n1"') === null)
  check('空串返回 null', parseDigestChallenge('') === null)
})

test('U-D2：Digest 应答计算（RFC 2617 标准向量）', () => {
  const { digestAuthorization } = internals
  // RFC 2617 §3.5 的完整示例：response 必须是 6629fae49393a05397450978507c4ef1
  const hdr = digestAuthorization(
    { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', qop: 'auth,auth-int', opaque: '5ccc069c403ebaf9f0171e9517f40e41', algorithm: 'MD5' },
    1,
    '0a4f113b',
    'Mufasa',
    'Circle Of Life',
    'GET',
    '/dir/index.html'
  )
  check('标准向量 response 正确', !!hdr && hdr.includes('response="6629fae49393a05397450978507c4ef1"'), String(hdr).slice(0, 80))
  check('头形态含 qop / nc / cnonce / opaque / algorithm', !!hdr && hdr.includes('qop=auth') && hdr.includes('nc=00000001') && hdr.includes('cnonce="0a4f113b"') && hdr.includes('opaque="5ccc069c403ebaf9f0171e9517f40e41"') && hdr.includes('algorithm=MD5'))
  check('头以 Digest 起始', !!hdr && hdr.startsWith('Digest '))
})

test('U-D3：Digest 应答的 qop 协商与算法映射', () => {
  const { digestAuthorization } = internals
  const base = { realm: 'r', nonce: 'n' }
  // 未提供 qop：RFC 2069 旧式应答 response = H(HA1:nonce:HA2)
  const legacy = digestAuthorization(base, 1, 'cn', 'u', 'p', 'GET', '/x')
  const H = (s) => crypto.createHash('md5').update(s).digest('hex')
  const expectLegacy = H(`${H('u:r:p')}:n:${H('GET:/x')}`)
  check('无 qop 走 RFC 2069 旧式应答', !!legacy && legacy.includes(`response="${expectLegacy}"`))
  check('旧式头不含 nc / cnonce 字段', !!legacy && !legacy.includes('nc=') && !legacy.includes('cnonce='))
  // 只提供 auth-int：不支持（引擎传输流式，无法给请求体哈希）
  check('仅 auth-int 的挑战返回 null', digestAuthorization({ ...base, qop: 'auth-int' }, 1, 'cn', 'u', 'p', 'GET', '/x') === null)
  // 不支持的算法
  check('未知算法返回 null', digestAuthorization({ ...base, algorithm: 'SHA-999' }, 1, 'cn', 'u', 'p', 'GET', '/x') === null)
  // -sess 变体：HA1 = H(H(username:realm:pass):nonce:cnonce)，与基底哈希共用映射
  const sess = digestAuthorization({ ...base, qop: 'auth', algorithm: 'MD5-sess' }, 1, 'cn', 'u', 'p', 'GET', '/x')
  const ha1s = H(`${H('u:r:p')}:n:cn`)
  const expectSess = H(`${ha1s}:n:00000001:cn:auth:${H('GET:/x')}`)
  check('MD5-sess 的 HA1 换算正确', !!sess && sess.includes(`response="${expectSess}"`))
  // nc 补零到 8 位
  const nc9 = digestAuthorization({ ...base, qop: 'auth' }, 9, 'cn', 'u', 'p', 'GET', '/x')
  check('nc 补零至 8 位十六进制', !!nc9 && nc9.includes('nc=00000009'))
})

test('U-N1：resolveNetOpts 的带宽与代理解析', () => {
  const { resolveNetOpts } = internals
  const dflt = resolveNetOpts({})
  check('缺省：不限速 / 无代理', dflt.uploadKBps === 0 && dflt.downloadKBps === 0 && dflt.proxyUrl === '' && dflt.proxy === null)
  const full = resolveNetOpts({ netOpts: { uploadKBps: 128, downloadKBps: 64, proxyUrl: 'http://127.0.0.1:7890' } })
  check('显式限速与代理透传', full.uploadKBps === 128 && full.downloadKBps === 64)
  check('代理解析出 host / port', full.proxy && full.proxy.hostname === '127.0.0.1' && full.proxy.port === 7890 && full.proxy.protocol === 'http:')
  check('默认端口推断（https 代理 → 443）', resolveNetOpts({ netOpts: { proxyUrl: 'https://proxy.example.com' } }).proxy.port === 443)
  const auth = resolveNetOpts({ netOpts: { proxyUrl: 'http://u:p%40x@10.0.0.1:3128' } })
  check('代理认证头携带（userinfo 解码 + Basic）', !!auth.proxy && auth.proxy.authHeader['Proxy-Authorization'].startsWith('Basic '))
  check('非法代理地址按直连处理', resolveNetOpts({ netOpts: { proxyUrl: 'socks5://x' } }).proxy === null)
  check('非数字限速回退 0', resolveNetOpts({ netOpts: { uploadKBps: 'abc' } }).uploadKBps === 0)
  check('显式 0 = 不限（不被 num() 吞成默认）', resolveNetOpts({ netOpts: { uploadKBps: 0 } }).uploadKBps === 0)
})
