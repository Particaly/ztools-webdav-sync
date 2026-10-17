/**
 * 同步记录的注册表登记字段（registryAdopted / registryRemoved）读盘归一单元测试。
 *
 * 背景：「ZTools 插件」虚拟行轮末对账的登记产出折进当轮同步记录（写入侧
 * services.mts buildSyncLogEntry），读取侧 store.mts normalizeSyncRound 对磁盘
 * 条目做逐字段白名单重建 —— 新字段必须入白名单，否则重启后读盘即被剥掉。
 * 本文件验证读盘归一：合法名单保留、畸形名单（非字符串 / 空名）剔除不连累
 * 整条、超长截断 50（与写入侧同上限）、缺省条目不带键。
 *
 * 运行：npx vitest run test/unit（或 npm run test:unit）
 * 结构说明：独立 test 块 + 独立存储根（setRootForTest 进程级，但 vitest 按文件
 * 隔离模块注册表，不外泄）；check 软失败登记 + 末尾一次性抛出（与 store.test.mjs
 * 一致）。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'
import { makeCheck, UNIT_HERE as HERE } from '../harness.mjs'

const PRELOAD = path.join(HERE, '..', '..', 'src-ztools', 'preload')

const { check, assertAtEnd } = makeCheck()

const store = await import(pathToFileURL(path.join(PRELOAD, 'store.mts')).href)
const ROOT = path.join(os.tmpdir(), `wdsync-reglog-unit-${Date.now()}-${process.pid}`)
await fsp.mkdir(ROOT, { recursive: true })
await store.setRootForTest(ROOT)

const dirOpts = { localPath: path.join(ROOT, 'plugins'), remotePath: '/ztools-plugins/windows' }

/** 最小合法轮次条目（counts 与 ops 形态对齐 store.test.mjs 的 slogEntry） */
const roundOf = (n, extra = {}) => ({
  at: 1700000000000 + n,
  endAt: 1700000000000 + n + 5,
  trigger: 'interval',
  status: 'ok',
  uploaded: 0,
  downloaded: 1,
  deleted: 0,
  conflicts: 0,
  adopted: 0,
  deferredConflicts: 0,
  deleteHeld: 0,
  bytesUp: 0,
  bytesDown: 100 + n,
  totalFiles: 3,
  ops: [{ op: 'download', rel: `plugin-${n}/plugin.json`, bytes: 100 + n, added: true }],
  errors: [],
  ...extra,
})

test('注册表登记字段读盘归一（RL1–RL3）', async () => {
  try {
    const ls = await store.openDirStore(dirOpts)
    // RL1 合法名单 + 畸形混入：写入侧不消毒（直接 append），读盘归一剔除非字符串
    // 与空名、保留合法名 —— 「畸形剔除不连累整条」
    ls.appendSyncLog(
      roundOf(1, {
        registryAdopted: ['plugin-a', 123, null, '', 'plugin-c'],
        registryRemoved: ['ghost-x'],
      })
    )
    // RL2 无登记字段的常规轮：读盘后不得出现 undefined 键（旧版本记录形态不变）
    ls.appendSyncLog(roundOf(2))
    // RL3 超长名单：读盘截断 50（与写入侧 buildSyncLogEntry 同上限）
    ls.appendSyncLog(roundOf(3, { registryAdopted: Array.from({ length: 60 }, (_, i) => `p-${i}`) }))
    await ls.saveSyncLog()

    // 关闭全部已打开存储（同根重设即全关）→ 重新打开走磁盘加载 + 归一化
    await store.setRootForTest(ROOT)
    const ls2 = await store.openDirStore(dirOpts)
    const rounds = ls2.listSyncLog()
    const byAt = new Map(rounds.map((r) => [r.at, r]))
    const r1 = byAt.get(1700000000001)
    const r2 = byAt.get(1700000000002)
    const r3 = byAt.get(1700000000003)

    check(
      'RL1 junk names dropped on disk reload, valid names survive',
      !!r1 && JSON.stringify(r1.registryAdopted) === JSON.stringify(['plugin-a', 'plugin-c']) && JSON.stringify(r1.registryRemoved) === JSON.stringify(['ghost-x']),
      JSON.stringify(r1 ? { adopted: r1.registryAdopted, removed: r1.registryRemoved } : null)
    )
    check('RL2 entry without registry fields stays clean (no undefined keys)', !!r2 && r2.registryAdopted === undefined && r2.registryRemoved === undefined, JSON.stringify(r2 ? { adopted: r2.registryAdopted, removed: r2.registryRemoved } : null))
    check('RL3 overlong name list truncated to 50 on disk reload', !!r3 && Array.isArray(r3.registryAdopted) && r3.registryAdopted.length === 50 && r3.registryAdopted[0] === 'p-0' && r3.registryAdopted[49] === 'p-49', JSON.stringify(r3 ? r3.registryAdopted?.length : null))
  } catch (e) {
    check('unexpected error', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e))
  } finally {
    await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {})
  }

  assertAtEnd({
    fail: (failed, total) => `注册表登记字段归一测试失败 ${failed.length}/${total} 条:\n${failed.map((f) => `  - ${f.name} ${f.detail}`).join('\n')}`,
  })
})
