/**
 * 改名配对（computeRenamePairs）与 TLS 错误映射（normalizeTlsError / tlsAgentOptsFor）
 * 的单元测试：纯函数直检（services._internals 后门）。
 * 覆盖：本地 / 远端两个方向的配对成立与回落条件（哈希不符、尺寸不符、基线无
 * lhash、挂起决策、模式限制、moveSupported、一次性单向、基线不可信）、多对多
 * 贪心匹配；TLS 四类错误码的文案映射与非 TLS 透传；Agent 分池键的稳定性。
 * 运行：npx vitest run test/unit（或 npm run test:unit）
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, test } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PRELOAD = path.join(HERE, '..', '..', 'src-ztools', 'preload')

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  if (process.env.WDSYNC_E2E_JSONL) {
    try {
      fs.appendFileSync(process.env.WDSYNC_E2E_JSONL, JSON.stringify({ section: 'rename-tls-unit', name, ok: !!cond }) + '\n')
    } catch {
      /* 对拍输出失败不影响测试 */
    }
  }
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

let services

beforeAll(async () => {
  global.window = {}
  await import(pathToFileURL(path.join(PRELOAD, 'services.mts')).href)
  services = global.window.services
  await services.storage.setRootForTest(path.join(os.tmpdir(), `wdsync-unit-rtl-${Date.now()}-${process.pid}`))
})

afterAll(() => {
  try {
    services.cleanup()
  } catch {
    /* 清理失败不影响断言输出 */
  }
  const failed = results.filter((r) => !r.ok)
  if (failed.length) throw new Error(`${failed.length}/${results.length} 个用例失败：\n  ❌ ${failed.map((f) => f.name).join('\n  ❌ ')}`)
})

// ---- 测试脚手架：伪造目录存储与规划条目 ----

/** 伪存储（computeRenamePairs 只读这些成员） */
const fakeStore = (extra = {}) => ({
  loadedOk: true,
  meta: {},
  entries: new Map(),
  pendingIntents: new Map(),
  get: () => null,
  getPending: () => null,
  matchDeleteScope: () => null,
  getFailure: () => null,
  ...extra,
})

let tmpRoot = ''
const localAbsOf = (name) => path.join(tmpRoot, name)
const hashOf = (content) => crypto.createHash('sha256').update(content).digest('hex')

/** 建一个本地文件并返回 LocalStat 形态（abs / size / mtimeMs） */
async function localFile(name, content) {
  const abs = localAbsOf(name)
  await fsp.writeFile(abs, content)
  const st = await fsp.stat(abs)
  return { abs, size: st.size, mtimeMs: st.mtimeMs }
}

/** 基线条目形态（BaselineEntry） */
const baseline = (o) => ({ lsize: 0, lmtimeMs: 0, rsize: 0, rmtimeMs: 0, retag: '', ...o })

const runPairs = async (plan, opts = {}) =>
  services.sync._internals.computeRenamePairs({
    plan,
    store: opts.store || fakeStore(),
    caseSkip: new Set(),
    mode: opts.mode || 'two-way',
    oneshot: !!opts.oneshot,
    moveSupported: opts.moveSupported === undefined ? true : opts.moveSupported,
    forceUploads: opts.forceUploads || new Set(),
    localTol: 1000,
  })

test('rename-tls-unit', async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'wdsync-rn-unit-'))
  const { normalizeTlsError, tlsAgentOptsFor } = services.sync._internals

  // ---- 方向一：本地改名配对 ----
  {
    const oldStat = { abs: localAbsOf('a.bin'), size: 10, mtimeMs: 1000 }
    const newL = await localFile('b.bin', 'hello-wdsync')
    const m = baseline({ lsize: newL.size, lmtimeMs: newL.mtimeMs, lhash: hashOf('hello-wdsync'), rsize: newL.size, rmtimeMs: 500, retag: 'e1' })
    const plan = [
      { rel: 'a.bin', l: null, r: { size: newL.size, mtimeMs: 500, etag: 'e1' }, m, flags: { rChanged: false } },
      { rel: 'b.bin', l: newL, r: null, m: null, flags: {} },
    ]
    const pairs = await runPairs(plan)
    check('本地改名：旧消失+新出现+哈希一致 → 配对', pairs.length === 1 && pairs[0].dir === 'local' && pairs[0].oldRel === 'a.bin' && pairs[0].newRel === 'b.bin')
    const badHash = await runPairs([
      { ...plan[0], m: baseline({ ...m, lhash: 'deadbeef' }) },
      plan[1],
    ])
    check('本地改名：哈希不符 → 不配对（回落删传）', badHash.length === 0)

    const badSize = await runPairs([
      plan[0],
      { ...plan[1], l: { ...newL, size: newL.size + 1 } },
    ])
    check('本地改名：尺寸不符 → 不配对', badSize.length === 0)

    const noLhash = await runPairs([
      { ...plan[0], m: baseline({ ...m, lhash: undefined }) },
      plan[1],
    ])
    check('本地改名：基线无 lhash → 不配对', noLhash.length === 0)

    const remoteChanged = await runPairs([
      { ...plan[0], flags: { rChanged: true } },
      plan[1],
    ])
    check('本地改名：远端已变（删除传播不成立）→ 不配对', remoteChanged.length === 0)
  }

  // ---- 方向二：远端改名配对 ----
  {
    const oldL = await localFile('x.txt', 'remote-side')
    const m = baseline({ lsize: oldL.size, lmtimeMs: oldL.mtimeMs, lhash: hashOf('remote-side'), rsize: oldL.size, rmtimeMs: 9000, retag: 'tag-x' })
    const plan = [
      { rel: 'x.txt', l: oldL, r: null, m, flags: { lChanged: false } },
      { rel: 'y.txt', l: null, r: { size: oldL.size, mtimeMs: 9000, etag: 'tag-x' }, m: null, flags: {} },
    ]
    const pairs = await runPairs(plan)
    check('远端改名：旧远端消失+新远端出现+指纹一致 → 配对', pairs.length === 1 && pairs[0].dir === 'remote' && pairs[0].oldRel === 'x.txt')

    const etagDiff = await runPairs([
      plan[0],
      { ...plan[1], r: { size: oldL.size, mtimeMs: 9000, etag: 'tag-other' } },
    ])
    check('远端改名：etag 不同 → 不配对', etagDiff.length === 0)
  }

  // ---- 模式与回落条件 ----
  {
    const newL = await localFile('m1.bin', 'mode-check')
    const m = baseline({ lsize: newL.size, lhash: hashOf('mode-check'), rsize: newL.size, retag: 'e' })
    const localPlan = [
      { rel: 'o.bin', l: null, r: { size: newL.size, mtimeMs: 1, etag: 'e' }, m, flags: { rChanged: false } },
      { rel: 'm1.bin', l: newL, r: null, m: null, flags: {} },
    ]
    check('download 模式不传播本地改名', (await runPairs(localPlan, { mode: 'download' })).length === 0)

    const oldL = await localFile('m2.txt', 'r-mode')
    const rm = baseline({ lsize: oldL.size, lmtimeMs: oldL.mtimeMs, rsize: oldL.size, rmtimeMs: 2, retag: 'e2' })
    const remotePlan = [
      { rel: 'p.txt', l: oldL, r: null, m: rm, flags: { lChanged: false } },
      { rel: 'q.txt', l: null, r: { size: oldL.size, mtimeMs: 2, etag: 'e2' }, m: null, flags: {} },
    ]
    check('upload 模式不跟随远端改名', (await runPairs(remotePlan, { mode: 'upload' })).length === 0)
    check('two-way 两方向都可配对', (await runPairs(remotePlan)).length === 1)

    check('一次性单向轮不配对', (await runPairs(localPlan, { oneshot: true })).length === 0)
    check('基线不可信（loadedOk=false）不配对', (await runPairs(localPlan, { store: fakeStore({ loadedOk: false }) })).length === 0)
    check('根重建保护窗口不配对', (await runPairs(localPlan, { store: fakeStore({ meta: { rootRebuilt: { at: 1 } } }) })).length === 0)
    check('moveSupported=false 挡本地改名方向', (await runPairs(localPlan, { moveSupported: false })).length === 0)
    check('moveSupported=false 不挡远端改名方向（本地改名无需 MOVE）', (await runPairs(remotePlan, { moveSupported: false })).length === 1)

    check('旧路径有删除挂起 → 不配对', (await runPairs(localPlan, { store: fakeStore({ getPending: (rel) => (rel === 'o.bin' ? { kind: 'delete' } : null) }) })).length === 0)
    check('旧路径处于失败退避期 → 不配对', (await runPairs(localPlan, { store: fakeStore({ getFailure: (rel) => (rel === 'o.bin' ? { retryAtMs: Date.now() + 60000 } : null) }) })).length === 0)
    check('旧路径有开放 WAL 意图 → 不配对', (await runPairs(localPlan, { store: fakeStore({ pendingIntents: new Map([['i1', { op: 'upload', rel: 'o.bin' }]]) }) })).length === 0)
  }
  {
    const newL = await localFile('cs.bin', 'case-skip')
    const m = baseline({ lsize: newL.size, lhash: hashOf('case-skip'), rsize: newL.size, retag: 'e' })
    const plan = [
      { rel: 'old.bin', l: null, r: { size: newL.size, mtimeMs: 1, etag: 'e' }, m, flags: { rChanged: false } },
      { rel: 'cs.bin', l: newL, r: null, m: null, flags: {} },
    ]
    const pairsWithSkip = await services.sync._internals.computeRenamePairs({
      plan,
      store: fakeStore(),
      caseSkip: new Set(['old.bin']),
      mode: 'two-way',
      oneshot: false,
      moveSupported: true,
      forceUploads: new Set(),
      localTol: 1000,
    })
    check('大小写冲突文件 → 不配对', pairsWithSkip.length === 0)
  }

  // ---- 多对多同内容：贪心一对一 ----
  {
    const l1 = await localFile('n1.bin', 'dup-content')
    const l2 = await localFile('n2.bin', 'dup-content')
    const m1 = baseline({ lsize: l1.size, lhash: hashOf('dup-content'), rsize: l1.size, retag: 't1' })
    const m2 = baseline({ lsize: l1.size, lhash: hashOf('dup-content'), rsize: l1.size, retag: 't2' })
    const plan = [
      { rel: 'o1.bin', l: null, r: { size: l1.size, mtimeMs: 1, etag: 't1' }, m: m1, flags: { rChanged: false } },
      { rel: 'o2.bin', l: null, r: { size: l1.size, mtimeMs: 1, etag: 't2' }, m: m2, flags: { rChanged: false } },
      { rel: 'n1.bin', l: l1, r: null, m: null, flags: {} },
      { rel: 'n2.bin', l: l2, r: null, m: null, flags: {} },
    ]
    const pairs = await runPairs(plan)
    const olds = new Set(pairs.map((p) => p.oldRel))
    check('同内容多对多：贪心一对一（两对、旧路径不重复）', pairs.length === 2 && olds.size === 2)
  }

  // ---- TLS 错误映射 ----
  {
    const mk = (code) => ({ code, message: `ssl ${code}`, reason: 'cert' })
    const selfSigned = normalizeTlsError(mk('DEPTH_ZERO_SELF_SIGNED_CERT'))
    check('TLS：自签名错误映射为 code=TLS + 指引信任开关', selfSigned && selfSigned.code === 'TLS' && selfSigned.permanent === true && /自签名/.test(selfSigned.message) && /信任此服务器证书/.test(selfSigned.message))
    check('TLS：SELF_SIGNED_CERT_IN_CHAIN 同类映射', !!normalizeTlsError(mk('SELF_SIGNED_CERT_IN_CHAIN')))
    check('TLS：UNABLE_TO_VERIFY_LEAF_SIGNATURE 同类映射', !!normalizeTlsError(mk('UNABLE_TO_VERIFY_LEAF_SIGNATURE')))
    const expired = normalizeTlsError(mk('CERT_HAS_EXPIRED'))
    check('TLS：证书过期映射过期文案', expired && /过期/.test(expired.message))
    const alt = normalizeTlsError(mk('ERR_TLS_CERT_ALTNAME_INVALID'))
    check('TLS：域名不匹配映射核对地址文案', alt && /不匹配/.test(alt.message))
    const proto = normalizeTlsError(mk('EPROTO'))
    check('TLS：EPROTO 映射 http/https 写反文案', proto && /https/.test(proto.message))
    check('TLS：非 TLS 错误透传（返回 null）', normalizeTlsError(mk('ECONNRESET')) === null && normalizeTlsError({ message: 'x' }) === null && normalizeTlsError(null) === null)
  }

  // ---- Agent 分池键 ----
  {
    const none = tlsAgentOptsFor({})
    check('TLS Agent：未配置 → 空 key（默认池）', none.key === '' && !none.rejectUnauthorized && !none.ca)
    const trust = tlsAgentOptsFor({ tls: { trustServerCertificate: true } })
    check('TLS Agent：仅信任 → key=1| 且 rejectUnauthorized=false', trust.key === '1|' && trust.rejectUnauthorized === false && !trust.ca)
    const ca = tlsAgentOptsFor({ tls: { caPem: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----' } })
    check('TLS Agent：仅 CA → key 含哈希且携带 ca', ca.key.startsWith('0|') && ca.key.length > 2 && typeof ca.ca === 'string' && !ca.rejectUnauthorized)
    const both = tlsAgentOptsFor({ tls: { trustServerCertificate: true, caPem: 'pem-x' } })
    check('TLS Agent：信任 + CA → 键不同于单用', both.key !== trust.key && both.key !== ca.key)
    const ca2 = tlsAgentOptsFor({ tls: { caPem: 'pem-y' } })
    check('TLS Agent：不同 CA → 不同分池键', ca2.key !== ca.key)
    check('TLS Agent：空白 caPem 视为未配置', tlsAgentOptsFor({ tls: { caPem: '   ' } }).key === '')
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
})
