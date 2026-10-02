/**
 * 同步引擎端到端测试：直接在 Node 中加载 preload/services.js（及其依赖 store.js），
 * 对 test/dav-server.mjs 起的迷你 WebDAV 做真实同步验证。
 * 用法：node test/sync-e2e.mjs [--built] [--fast]
 *   --built：跑 esbuild 构建产物；--fast：跳过显式登记的慢组（无标志 = 全量，语义不变；
 *   详见文件内「分节登记 / 逐节计时 / --fast 慢组跳过」说明与运行末尾的分节耗时排行）
 *
 * ── 测试改写说明（旧用例 → 现状）──────────────────────────────
 * 引擎基准已由「远端 manifest」改为「本机基线（pluginData 存储）」，以下旧用例因此失效并改写：
 *   - S2/S3/S4（manifest 损坏 / 读取 500 / 恢复）→ S2/S3：改为「基线快照损坏 → 无基线
 *     保护模式（零删除、远端不被覆盖）+ 冲突收敛恢复」。S3 的 manifest-500 注入随远端
 *     状态文件一并删除（引擎不再读取任何远端状态）。
 *   - S5（失败轮次 manifest 字节不变）→ 失败隔离语义：单文件失败不回滚其他已成功文件，
 *     但轮末以 error 上报；「无重传」由基线条目直接证明。
 *   - S6/S7（暂存日志 adopt / manifest 412 提交冲突）→ 整体删除：暂存日志（P1-1）与
 *     manifest 提交（含 CAS）机制已删除，其崩溃安全职责由「每设备基线 + WAL 恢复」接管，
 *     对应用例改写为 P11-R 系列（崩溃注入恢复）。
 *   - S13-b（pending 暂存真值表）→ 删除：decideAction 不再接受 pending 参数；其「无基线
 *     且两侧都在」分支改由 newBoth 注入，真值表并入 S13。
 *   - S14 的 manifest 状态直检 → 删除（loadManifestState 已不存在），保留扫描完整性直检。
 *   - S15（条件 PUT）→ 保留服务器能力验证语义，目标文件由 .webdav-sync.json 改为普通文件。
 *   - P11（暂存日志生命周期 A–E）→ 改写为 P11-R（WAL 意图恢复 R1–R5）。
 *   - P13 的 manifest 断言 → 改为基线条目断言。
 *   - M1（新设备空目录 + 他人 manifest）→ 断言保持正向（新引擎下转绿）。
 * 新增：M2（A/B 交替多轮无乒乓）、M3（基线丢失 adopt + 保护解除）、N1（touch 不重传）、
 *   N2（双侧同内容 adopt）、N3（无 etag 服务器指纹噪声 + fingerprint-unstable）、
 *   N4（冲突「应用到全部」）、utimes 对齐断言（并入 M1）。
 *
 * ── 改动说明（P 系列档位矩阵）────────────────────────────────
 * 新增 P1–P9：服务器档位矩阵验收。档位由 dav-server 的
 * .wdsync-test-profile 标记文件切换（p1..p9，缺省 = p1 现状默认档）；每个档位断言
 * 「探测结果分类正确」+「一轮同步行为符合档位语义」。既有用例未删除；
 * testConnection 断言扩展为同时校验新增的 tier / capabilities 字段（原 ok 断言保留）。
 * midair 竞态钩子（.wdsync-test-midair，内容 put / propfind 选触发点）注入
 * 「规划后、执行前远端被改」：A 档必 412、B 档被复查拦下、P7 档记录静默忽略的后果。
 *
 * ── PC 系列：冲突挂起 + 批量策略延续 ──────────────────────────
 * 用户对冲突的选择在成功落地前先逐文件持久化（store 的 pending-conflicts.json）；
 * 落地失败（A 档 412 / B 档复查 REMOTE_CHANGED）→ 挂起保留 choice，下一轮规划
 * 自动沿用、不再弹窗（PC1/PC4），未解决冲突登记无 choice 挂起供 UI 统一处理
 *（PC2），挂起跨进程持久（PC3，switchDevice 重开后仍恢复）。
 *
 * ── 锁后置 + B 档新上传写前查重 ────────────────────────────────
 * 租约锁从「建根后、扫描前」移到「规划完成后、worker 执行前」且按需获取：仅含
 * 远端写操作（upload / delete-remote / conflict）的轮次才拿锁，空轮 / 纯下载轮
 * 零锁请求；让出轮保持 totalFiles===0 契约并新增 planned 信息字段。B 档「扫描期
 * 远端不存在」的新上传在写入前按父目录 PROPFIND Depth 1 查重（不依赖锁结果），
 * 命中即剔除不覆盖（REMOTE_CHANGED 同类后果）、查重失败按瞬时失败跳过不裸传。
 * L1/L2/L7/L8 按新时序改写（plan 阶段无锁 / 让出轮 planned 有值）；L10–L14 为
 * 新增验收（空轮零锁、写轮锁时序、窗口守卫、按需让出、空轮左锁清理，A/B 档各覆盖）。
 *
 * ── 取消中断在途传输 ────────────────────────────────────────────
 * shouldAbort 触发时网络层轮询销毁在途请求（cfg.__wdsyncAbort → ABORTED 错误）：
 * 大文件传输即时停止（不再等传完）；ABORTED 不计失败分类 / 不进退避表 / 不产生
 * 错误噪声，轮次按既有「同步已中止」收尾（已完成文件基线保留、锁照常释放、
 * 规划期取消则不再拿锁）。CA 系列为新增验收（下载 / 上传 / verify 池取消 ×
 * A/B 档、半截保留收敛、失败表隔离、规划期取消零锁请求），依赖 dav-server 的
 * .wdsync-test-throttle 节流标记与 reqlog 的 !ABORT 行。
 */
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '.dav-root')
const PORT = 5360
const LOCAL = path.join(os.tmpdir(), `wdsync-e2e-${Date.now()}`)

const results = []
// ── 分节登记 / 逐节计时 / --fast 慢组跳过（e2e 提速）──────────────
// 用法：node test/sync-e2e.mjs [--built] [--fast]。无标志 = 全量（默认语义不变）；
// --fast = 跳过显式登记为慢组的节，可与 --built 组合。运行结束打印分节耗时排行。
// 慢组划分标准（一句话）：节内主要耗时为不可压缩的真实墙钟等待（Retry-After /
// 退避静置、watcher 去抖、熔断风暴重试、租约锁 1.5s 写回静置、超大目录 IO/解析），
// 全量实测显著（≳3s）拖慢总时长、且单独跳过不牵连他节语义的节登记为慢组；
// 其余节（含未来新增用例）默认属于快组，--fast 一律照跑。
const FAST = process.argv.includes('--fast')
const RUN_T0 = Date.now()
const sectionStats = []
let curSection = null
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  if (curSection) {
    curSection.checks++
    if (!cond) curSection.failed++
  }
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 轮次全零判定（原 M2 节内定义，提升到顶层供各节共享） */
const isNoop = (s) => s.uploaded === 0 && s.downloaded === 0 && s.deleted === 0 && s.conflicts === 0
/** 各节共用的同步偏好（原 SAFE 节内定义，提升到顶层） */
const SP = { ignoreHidden: true, concurrency: 4, conflictStrategy: 'ask' }
/** 基础链路与 watch 节共用的项目目录（原 setup 节内定义，提升到顶层） */
const projDir = () => ({ id: 'd1', localPath: LOCAL, remotePath: '/proj', mode: 'two-way' })

/** 分节包装器：登记节名、逐节计时与用例计数；--fast 下跳过 slowReason 非空的节 */
async function section(desc, fn, slowReason = null) {
  const rec = { desc, slowReason, skipped: FAST && slowReason != null, t0: Date.now(), ms: 0, checks: 0, failed: 0 }
  sectionStats.push(rec)
  if (rec.skipped) {
    console.log(`⏭️  [fast] 跳过慢组「${desc}」（${slowReason}）`)
    return
  }
  const prev = curSection
  curSection = rec
  try {
    await fn()
  } finally {
    curSection = prev
    rec.ms = Date.now() - rec.t0
  }
}

/** 慢组显式登记：reason 必填（一句话写明该节为何慢 / 为何可被 --fast 跳过） */
const slowSection = (desc, reason, fn) => section(desc, fn, reason)

/**
 * 静态扫描各节的 check( 调用点数（--fast 跳过摘要用；不执行节体）。
 * 注意：循环 / 条件展开的用例按调用点计 1 —— 登记慢组时应选择无循环展开用例的节；
 * 全量运行时 printSectionReport 会对「慢组静态数 ≠ 实际执行数」给出 ⚠ 提示。
 */
function staticCheckCounts() {
  const counts = new Map()
  try {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n')
    let cur = null
    for (const line of src) {
      if (/^} catch/.test(line)) {
        cur = null // 主 try 的收尾区不属于任何节
        continue
      }
      const m = line.match(/^\s*await\s+(?:section|slowSection)\(\s*'((?:\\.|[^'\\])*)'/)
      if (m) {
        cur = m[1]
        counts.set(cur, 0)
        continue
      }
      if (cur != null) counts.set(cur, (counts.get(cur) || 0) + (line.match(/(?<![.\w$])check\(/g) || []).length)
    }
  } catch {
    /* 扫描失败只影响摘要显示，不影响测试本身 */
  }
  return counts
}

/** 运行末尾输出：--fast 跳过摘要 + 分节耗时排行（两种模式都打印，供维护参考） */
function printSectionReport() {
  const staticCounts = staticCheckCounts()
  const skippedRecs = sectionStats.filter((s) => s.skipped)
  if (skippedRecs.length) {
    const skippedChecks = skippedRecs.reduce((n, s) => n + (staticCounts.get(s.desc) ?? 0), 0)
    console.log(`\n[fast] 已跳过慢组 ${skippedRecs.length} 节 / ${skippedChecks} 个用例（按 check 调用点静态统计）：`)
    for (const s of skippedRecs) console.log(`  ⏭️  ${s.desc} —— ${s.slowReason}（${staticCounts.get(s.desc) ?? '?'} 用例）`)
  }
  const ranked = [...sectionStats].filter((s) => !s.skipped).sort((a, b) => b.ms - a.ms)
  console.log('\n──── 分节耗时排行（本模式已执行节，降序；供维护定位慢节）────')
  for (const s of ranked) {
    console.log(
      `${(s.ms / 1000).toFixed(1).padStart(7)}s ${String(s.checks).padStart(3)}例 ${s.failed ? `❌${s.failed} ` : ''}${s.desc}` +
        (s.slowReason ? '  [慢组→--fast 跳过]' : '') +
        (!FAST && s.slowReason && staticCounts.get(s.desc) !== s.checks ? `  ⚠ 静态统计 ${staticCounts.get(s.desc)} ≠ 实际 ${s.checks}（含循环展开用例，跳过摘要将不准）` : '')
    )
  }
  console.log(`──── 总墙钟 ${((Date.now() - RUN_T0) / 1000).toFixed(1)}s（${FAST ? 'fast' : '全量'}模式；不含进程启动前的开销）────`)
}

// 安全场景套件使用的本地目录与远端故障注入标记（try 外声明以便 finally 清理）
let SAFE_LOCAL = null

// 1. 清理上次运行遗留的远端内容，再启动迷你 DAV 服务器
await fsp.rm(ROOT, { recursive: true, force: true })
const server = spawn(process.execPath, [path.join(HERE, 'dav-server.mjs'), String(PORT), ROOT], { stdio: 'pipe' })
// 异常退出兜底：正常路径的 finally 会 kill，但挂起 await 的 drain 退出 / 外部
// SIGKILL 之外的死亡形态不经过 finally —— 孤儿 dav-server 占住端口会污染下一次
// 运行（EADDRINUSE / 旧根目录串台）。'exit' 同步回调里补一刀，幂等无害
process.on('exit', () => {
  try {
    server.kill()
  } catch (_) {
    /* 已死：忽略 */
  }
})
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server start timeout')), 5000)
  server.stdout.on('data', (d) => {
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
  server.stderr.on('data', (d) => console.error('[dav]', String(d)))
})

try {
  // 2. 加载 preload 服务（伪造 window）+ 显式设置本次运行的存储根（多设备模拟的基础）
  //    --built：改加载 esbuild 构建产物（src-ztools/preload/dist/services.js），
  //    与源码加载同一套用例双轨对照
  const BUILT = process.argv.includes('--built')
  const preloadPath = BUILT
    ? path.join(HERE, '..', 'src-ztools', 'preload', 'dist', 'services.js')
    : path.join(HERE, '..', 'src-ztools', 'preload', 'services.mts')
  console.log(`[e2e] preload under test: ${BUILT ? 'built bundle' : 'source'}`)
  global.window = {}
  await import(pathToFileURL(preloadPath).href)
  const services = global.window.services
  const cfg = { serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: 'p' }
  // 源码 store 模块：baselineDirOf 用它计算基线目录（bundle 模式下 bundle 内的 store
  // 是另一实例，切根时两边必须保持同根，路径计算才一致）。store 已迁移 .mts（ESM
  // 具名导出），命名空间直取即模块门面
  const storeModule = await import(pathToFileURL(path.join(HERE, '..', 'src-ztools', 'preload', 'store.mts')).href)
  const STORAGE_MAIN = path.join(os.tmpdir(), `wdsync-e2e-store-main-${Date.now()}`)
  const STORAGE_A = path.join(os.tmpdir(), `wdsync-e2e-store-a-${Date.now()}`)
  const STORAGE_B = path.join(os.tmpdir(), `wdsync-e2e-store-b-${Date.now()}`)
  const STORAGE_C = path.join(os.tmpdir(), `wdsync-e2e-store-c-${Date.now()}`)
  const STORAGE_D = path.join(os.tmpdir(), `wdsync-e2e-store-d-${Date.now()}`)
  const switchDevice = async (root) => {
    await services.storage.setRootForTest(root)
    if (BUILT) await storeModule.setRootForTest(root)
  }
  await switchDevice(STORAGE_MAIN)
  /**
   * 删除安全：本地删除一律走回收站 API（ztools.shellTrashItem → Electron
   * shell.trashItem）。e2e 伪造宿主实现：把文件移入独立回收目录（保留文件本体供
   * 断言），每次调用先登记 trashLog（含失败尝试，供「不退化 unlink」断言）。
   * trashFailNext > 0 = 接下来 N 次调用抛错（保护用例注入）；trashMissing = true =
   * 模拟宿主未注入回收站接口（delete window.ztools）。
   */
  const TRASH_DIR = path.join(os.tmpdir(), `wdsync-e2e-trash-${Date.now()}`)
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
  /** 直接定位某目录的基线存储目录（注入损坏快照等测试操纵用） */
  const baselineDirOf = async (d) => {
    const id = await services.storage.getDeviceId()
    return storeModule.baselineDirPath(id, d.localPath, d.remotePath)
  }

  // ── 跨节共享助手（原 P 系列节内定义；提升到此外层作用域，各节才能被独立登记 / 跳过）──
  const setProfile = async (p) => {
    if (p) fs.writeFileSync(path.join(ROOT, '.wdsync-test-profile'), p)
    else await fsp.rm(path.join(ROOT, '.wdsync-test-profile'), { force: true }).catch(() => {})
  }
  const setMidair = async (mode) => {
    if (mode) fs.writeFileSync(path.join(ROOT, '.wdsync-test-midair'), mode)
    else await fsp.rm(path.join(ROOT, '.wdsync-test-midair'), { force: true }).catch(() => {})
  }
  /** 新建独立存储根并切换（档位 / 能力缓存 / 基线互不串扰的前提） */
  const freshStore = async (tag) => {
    const root = path.join(os.tmpdir(), `wdsync-e2e-store-${tag}-${Date.now()}`)
    await fsp.mkdir(root, { recursive: true })
    await switchDevice(root)
    return root
  }
  const tmpLocal = async (tag) => {
    const lp = path.join(os.tmpdir(), `wdsync-e2e-local-${tag}-${Date.now()}`)
    await fsp.mkdir(lp, { recursive: true })
    return lp
  }
  const syncP = (lp, rp, prefs, handlers) =>
    services.sync.syncDirectory(cfg, { id: 'p', localPath: lp, remotePath: rp, mode: 'two-way' }, prefs || SP, handlers || {})
  /**
   * 收敛稳定断言：最多 maxRounds 轮内出现 no-op，且其后一轮仍是 no-op
   *（证明没有无限重传 / 乒乓；P6 异步指纹档位的关键断言）
   */
  const settleStable = async (lp, rp, maxRounds = 4) => {
    for (let i = 0; i < maxRounds; i++) {
      const s = await syncP(lp, rp)
      if (isNoop(s)) return { ok: isNoop(await syncP(lp, rp)), rounds: i + 1 }
    }
    return { ok: false, rounds: maxRounds }
  }
  /**
   * 崩溃注入轮的「进程死亡」等价收尾：crashErr 路径按设计不做任何收尾
   * （不释放锁、不清 60s 续租定时器，见 services.js 释放 finally 注释）—— 真实
   * 进程死亡时定时器随进程消失，而本测试进程活着，必须在每个崩溃轮断言后立即
   * 清扫，否则遗留定时器按 60s 周期向旧锁路径发 PUT，落进后续无关用例的观察窗。
   * 返回清除个数供断言。
   */
  const sweepCrashResidue = () => services.sync._internals.crashResidueSweep()

  // 计时器静态检查：与 store-unit 的计时器检查用同一正则。源码模式查
  // preload 源文件；--built 模式额外查构建产物（npm 脚本先重新构建，产物必新鲜；
  // esbuild 对 node: 内置模块保持 external，require('node:timers') 原样保留，
  // nodeTimers.xxx 成员调用不受影响 —— 产物回退到裸计时器时此处立即暴露）。
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
  await slowSection('基础：fs.watch 去抖回调 + dav.remove', 'watcher 去抖需 2×~2s 真实静置，用例价值密度低', async () => {
  let watched = false
  services.fsx.watchDir('e2e', LOCAL, () => {
    watched = true
  })
  await fsp.writeFile(path.join(LOCAL, 'watch-trigger.txt'), 'x')
  await sleep(2200)
  services.fsx.stopAllWatch()
  check('fs.watch triggers debounced callback', watched)

  // 13. 目录移除接口
  await services.sync.syncDirectory(cfg, projDir(), { ignoreHidden: true, concurrency: 4, conflictStrategy: 'ask' }, {})
  await services.dav.remove(cfg, '/proj/watch-trigger.txt')
  check('dav.remove works', !fs.existsSync(path.join(ROOT, 'proj', 'watch-trigger.txt')))
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
  check('S2 corrupt snapshot surfaces warning and conflict error', !!s2err && /冲突未解决/.test(s2err.message) && s2summary && s2summary.warnings.some((w) => /快照损坏|无基线/.test(w)), s2err && s2err.message)
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
  check('S5 unresolved conflict fails the round', !!s5err && /冲突未解决/.test(s5err.message), s5err && s5err.message)
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
  check('S7 remote delete failure fails the round', !!s7err && /删除远端失败/.test(s7err.message), s7err && s7err.message)
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
      check('S8 local delete failure fails the round', !!s8err && /删除本地文件失败/.test(s8err.message), s8err && s8err.message)
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
  check('S9 download guard rejects changed target', !!g1err && /已被修改|下载中止/.test(g1err.message), g1err && g1err.message)
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
      'N3 third distinct file marks fingerprint-unstable with warning',
      n3c.downloaded === 0 && n3c.adopted === 1 && n3c.warnings.some((w) => /指纹不稳定/.test(w)),
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

  // ============================================================
  // V1：规划期 verify 并发化 + 进度外发（网络层重构追加需求）
  // noetag 档位 + 远端 mtime 扰动 → 4.4-A 逐文件内容校验进入并发池；
  // 断言 plan 阶段进度携带 verifyDone/verifyTotal，字节数按待校验文件 size 预估
  // ============================================================
  await section('V1：规划期 verify 并发化', async () => {
  const V1_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-v1-${Date.now()}`)
  const v1Dir = () => ({ id: 'v1', localPath: V1_LOCAL, remotePath: '/v1', mode: 'two-way' })
  fs.writeFileSync(path.join(ROOT, '.wdsync-test-noetag'), 'x')
  try {
    await fsp.mkdir(V1_LOCAL, { recursive: true })
    await fsp.writeFile(path.join(V1_LOCAL, 'p1.txt'), 'v1-one')
    await fsp.writeFile(path.join(V1_LOCAL, 'p2.txt'), 'v1-two!!')
    await services.sync.syncDirectory(cfg, v1Dir(), SP, {})
    const bumpV1 = async (name, deltaMs) => {
      const p = path.join(ROOT, 'v1', name)
      const t = new Date((await fsp.stat(p)).mtimeMs + deltaMs)
      await fsp.utimes(p, t, t)
    }
    await bumpV1('p1.txt', 40000)
    await bumpV1('p2.txt', 40000)
    const planEvents = []
    const v1sum = await services.sync.syncDirectory(cfg, v1Dir(), SP, {
      onProgress: (p) => {
        if (p.phase === 'plan') planEvents.push(p)
      },
    })
    const lastPlan = planEvents[planEvents.length - 1]
    check('V1 verify pool adopts both files without transfer', v1sum.downloaded === 0 && v1sum.adopted === 2, JSON.stringify(v1sum))
    check(
      'V1 plan progress carries verify counters and byte estimates',
      !!lastPlan &&
        lastPlan.verifyTotal === 2 &&
        lastPlan.verifyDone === 2 &&
        lastPlan.bytesTotal === 'v1-one'.length + 'v1-two!!'.length &&
        lastPlan.bytesDone === 'v1-one'.length + 'v1-two!!'.length,
      JSON.stringify(lastPlan)
    )
  } finally {
    await fsp.rm(path.join(ROOT, '.wdsync-test-noetag'), { force: true }).catch(() => {})
  }
  await fsp.rm(V1_LOCAL, { recursive: true, force: true }).catch(() => {})

  })

  // ============================================================
  // RD 系列：重定向跟随（6.5）
  // ============================================================
  await section('RD：重定向跟随', async () => {
  fs.writeFileSync(path.join(ROOT, '.wdsync-test-redirect'), 'x')
  // 跨源重定向源：任何请求都 302 到另一个源（127.0.0.1:9），引擎必须拒绝跟随
  const crossServer = http.createServer((req, res) => {
    req.resume()
    res.writeHead(302, { Location: 'http://127.0.0.1:9/dav/' }).end()
  })
  await new Promise((r) => crossServer.listen(5361, '127.0.0.1', r))
  try {
    await fsp.mkdir(path.join(ROOT, 'rd', 'sub'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'rd', 'sub', 'f.txt'), 'rd-content')
    // davRequest 直检：无尾斜杠的集合 PROPFIND → 301 → 同源跟随 → 207（方法与请求体保留）
    const rdRes = await services.sync._internals.davRequest(cfg, 'PROPFIND', '/rd', {
      headers: { Depth: '1', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    })
    check('RD same-origin redirect followed to 207 with body', rdRes.status === 207 && /multistatus/.test(String(rdRes.body && rdRes.body.toString('utf-8'))), `status=${rdRes.status}`)
    // 跨源重定向必须拒绝，且报错信息包含源与目标 URL
    let crossErr = null
    try {
      await services.sync._internals.davRequest({ serverUrl: 'http://127.0.0.1:5361/dav/', username: 'u', password: 'p' }, 'PROPFIND', 'x', {})
    } catch (e) {
      crossErr = e
    }
    check(
      'RD cross-origin redirect rejected with both URLs',
      !!crossErr && /跨源/.test(crossErr.message) && crossErr.message.includes('127.0.0.1:5361') && crossErr.message.includes('127.0.0.1:9'),
      crossErr && crossErr.message
    )
    // 完整同步：引擎对集合请求已统一带尾斜杠，档位服务器不再触发重定向，流程照常成功
    const RD_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-rd-${Date.now()}`)
    await fsp.mkdir(RD_LOCAL, { recursive: true })
    const rdSum = await services.sync.syncDirectory(cfg, { id: 'rd', localPath: RD_LOCAL, remotePath: '/rd', mode: 'two-way' }, SP, {})
    check(
      'RD full sync works under redirect-flagged server',
      rdSum.downloaded === 1 && (await fsp.readFile(path.join(RD_LOCAL, 'sub', 'f.txt'), 'utf-8')) === 'rd-content',
      JSON.stringify(rdSum)
    )
    await fsp.rm(RD_LOCAL, { recursive: true, force: true }).catch(() => {})
  } finally {
    await fsp.rm(path.join(ROOT, '.wdsync-test-redirect'), { force: true }).catch(() => {})
    crossServer.close()
  }

  })

  // ============================================================
  // RL 系列：限流重试（6.7 / 6.6 Retry-After）
  // 前 3 次 PUT/GET 返回 429 + Retry-After: 1，之后放行；
  // PUT 属非幂等方法，仅在「服务端明确未处理」的 429 上重试 → 同步最终成功
  // ============================================================
  await section('RL：限流重试', async () => {
  fs.writeFileSync(path.join(ROOT, '.wdsync-test-ratelimit'), 'x')
  try {
    const RL_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-rl-${Date.now()}`)
    await fsp.mkdir(RL_LOCAL, { recursive: true })
    await fsp.writeFile(path.join(RL_LOCAL, 'a.txt'), 'rl-a')
    const rlT0 = Date.now()
    const rlSum = await services.sync.syncDirectory(cfg, { id: 'rl', localPath: RL_LOCAL, remotePath: '/rl', mode: 'two-way' }, SP, {})
    const rlMs = Date.now() - rlT0
    check(
      'RL rate-limited uploads eventually succeed',
      rlSum.uploaded === 1 && (await fsp.readFile(path.join(ROOT, 'rl', 'a.txt'), 'utf-8')) === 'rl-a',
      JSON.stringify(rlSum)
    )
    check('RL retry respected Retry-After=1s (three waits) in sane time', rlMs >= 2900 && rlMs < 20000, `${rlMs}ms`)
    await fsp.rm(RL_LOCAL, { recursive: true, force: true }).catch(() => {})
  } finally {
    await fsp.rm(path.join(ROOT, '.wdsync-test-ratelimit'), { force: true }).catch(() => {})
  }

  })

  // ============================================================
  // PR 系列：服务器档案与请求限速分层。
  // 档案匹配与 resolveNetOpts 分层走 _internals / dav.serverProfile 直检；
  // 限速在请求链路上的真实生效（令牌桶节拍）用显式 netOpts 走 davRequest 计时。
  // ============================================================
  await section('PR：服务器档案（坚果云默认限速）与 netOpts 分层', async () => {
  const profileOf = (u) => services.dav.serverProfile({ serverUrl: u })
  check('PR dav.jianguoyun.com matches profile', profileOf('https://dav.jianguoyun.com/dav/')?.label === '坚果云')
  check('PR apex domain matches profile too', profileOf('https://jianguoyun.com/dav/')?.label === '坚果云')
  check('PR embedded-subdomain host matches', profileOf('https://dav.web.jianguoyun.com/dav/')?.label === '坚果云')
  check('PR lookalike suffix host does not match', profileOf('https://evil-jianguoyun.com/dav/') == null)
  check('PR profile domain as prefix of another does not match', profileOf('https://jianguoyun.com.evil.com/dav/') == null)
  check('PR unrelated host has no profile', profileOf(`http://127.0.0.1:${PORT}/dav/`) == null)
  check('PR invalid or empty url returns null', profileOf('not a url') == null && profileOf('') == null)

  const netOf = (sv, netOpts) => services.sync._internals.resolveNetOpts({ serverUrl: sv, netOpts })
  const netJgy = netOf('https://dav.jianguoyun.com/dav/')
  const netLocal = netOf(`http://127.0.0.1:${PORT}/dav/`)
  check('PR default: no profile, no netOpts → rate 0', netLocal.ratePerSec === 0, JSON.stringify(netLocal))
  check('PR profile default applies when unset', netJgy.ratePerSec === 4, JSON.stringify(netJgy))
  check(
    'PR profile only overrides rate, other defaults intact',
    netJgy.connectTimeoutMs === 10000 && netJgy.idleTimeoutMs === 30000 && netJgy.stallMs === 60000 && netJgy.maxSockets === 8,
    JSON.stringify(netJgy)
  )
  check('PR explicit rate beats profile default', netOf('https://dav.jianguoyun.com/dav/', { ratePerSec: 10 }).ratePerSec === 10)
  check('PR explicit 0 means unlimited even on profile host', netOf('https://dav.jianguoyun.com/dav/', { ratePerSec: 0 }).ratePerSec === 0)
  check('PR invalid rate falls back to profile default', netOf('https://dav.jianguoyun.com/dav/', { ratePerSec: -3 }).ratePerSec === 4)
  check('PR invalid rate on non-profile host falls back to 0', netOf(`http://127.0.0.1:${PORT}/dav/`, { ratePerSec: 'x' }).ratePerSec === 0)

  // 限速在请求链路上生效：2 req/s × 7 个串行 PROPFIND。令牌桶容量 2（可突发
  // 2 个）+ 平均 2/s 补充，且睡眠期间的补充量记到下一请求头上（last 在睡前
  // 更新）→ 节拍呈「~500ms / ~5ms」交替，总耗时 ≈ 1.5s；不限速时 7 个本地
  // 请求仅数十毫秒。判 ≥ 1200ms 已与不限速形态差一个数量级以上。
  // 桶按 origin 缓存且仅 ratePerSec>0 时进入 —— 本用例后其余用例（默认 0）不受影响。
  const prCfg = { serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: 'p', netOpts: { ratePerSec: 2 } }
  const propfind = () =>
    services.sync._internals.davRequest(prCfg, 'PROPFIND', '', {
      headers: { Depth: '0', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    })
  const pacedT0 = Date.now()
  for (let i = 0; i < 7; i++) {
    const r = await propfind()
    if (r.status !== 207) throw new Error(`PR paced PROPFIND #${i} unexpected status ${r.status}`)
  }
  const pacedMs = Date.now() - pacedT0
  check('PR rate limit paces requests on the wire (burst 2 + ~500ms gaps)', pacedMs >= 1200 && pacedMs < 20000, `${pacedMs}ms`)

  })

  // ============================================================
  // X1 / X2：multistatus 解析容错（命名空间前缀 / CDATA / 实体 / 百分号编码 / 中文空格%23）
  // 预置含刁钻文件名的远端目录，逐风格断言 listRemote 解析；再在最奇异风格下完整同步
  // ============================================================
  await section('X1/X2：multistatus 解析容错', async () => {
  const XML_DIR = path.join(ROOT, 'xmlstyle')
  const tricky = [
    ['中 文.txt', 'tick-zh'],
    ['a&b.txt', 'tick-amp'],
    ['héro.txt', 'tick-e-acute'],
    ['tag#23.txt', 'tick-hash'],
    ['nested/深 &层.txt', 'tick-nested'],
  ]
  for (const [rel] of tricky) await fsp.mkdir(path.dirname(path.join(XML_DIR, rel)), { recursive: true })
  for (const [rel, content] of tricky) await fsp.writeFile(path.join(XML_DIR, rel), content)
  const trickyRels = tricky.map(([rel]) => rel).sort().join('|')
  try {
    // 扩展风格：hex（十六进制实体）与 cdataetag（CDATA 包裹的 getetag）两种新风格
    for (const style of ['d', 'plain', 'cdata', 'entity', 'hex', 'cdataetag', 'pct']) {
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-xmlstyle'), style)
      const files = await services.dav.list(cfg, '/xmlstyle', true)
      const got = Array.from(files.entries())
        .filter(([, v]) => !v.isDir)
        .map(([k]) => k)
        .sort()
        .join('|')
      check(`X1 xmlstyle '${style}' parses all tricky names`, got === trickyRels, got)
    }
    // CDATA etag（cdataetag 档）：etag 取值与普通 d: 档完全一致（CDATA 壳与实体都不泄漏进取值）
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-xmlstyle'), 'd')
    const etagPlainStyle = (await services.dav.list(cfg, '/xmlstyle', true)).get('中 文.txt')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-xmlstyle'), 'cdataetag')
    const etagCdataStyle = (await services.dav.list(cfg, '/xmlstyle', true)).get('中 文.txt')
    check(
      'X1 CDATA-wrapped etag parses to identical value',
      etagPlainStyle && !!etagPlainStyle.etag && etagPlainStyle.etag === etagCdataStyle.etag,
      `${etagPlainStyle && etagPlainStyle.etag} vs ${etagCdataStyle && etagCdataStyle.etag}`
    )
    // X2 完整同步（CDATA 风格）：远端 → 本地全部落地且内容一致
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-xmlstyle'), 'cdata')
    const X_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-xml-${Date.now()}`)
    await fsp.mkdir(X_LOCAL, { recursive: true })
    const xSum = await services.sync.syncDirectory(cfg, { id: 'xml', localPath: X_LOCAL, remotePath: '/xmlstyle', mode: 'two-way' }, SP, {})
    let xAllOk = xSum.downloaded === 5
    for (const [rel, content] of tricky) {
      if ((await fsp.readFile(path.join(X_LOCAL, ...rel.split('/')), 'utf-8').catch(() => 'MISS')) !== content) xAllOk = false
    }
    check('X2 full sync lands tricky names under cdata style', xAllOk, JSON.stringify(xSum))
    // X2 上传方向：本地新增刁钻文件名 → remoteUrl 逐段编码落地 → 列表解析回显一致
    await fsp.writeFile(path.join(X_LOCAL, '上传 &新 #文件.txt'), 'upload-tricky')
    const xSum2 = await services.sync.syncDirectory(cfg, { id: 'xml', localPath: X_LOCAL, remotePath: '/xmlstyle', mode: 'two-way' }, SP, {})
    check(
      'X2 upload of tricky name lands on remote',
      xSum2.uploaded === 1 && (await fsp.readFile(path.join(XML_DIR, '上传 &新 #文件.txt'), 'utf-8').catch(() => 'MISS')) === 'upload-tricky',
      JSON.stringify(xSum2)
    )
    const xAfter = await services.dav.list(cfg, '/xmlstyle', true)
    check('X2 uploaded tricky name parses back in listing', xAfter.has('上传 &新 #文件.txt'), Array.from(xAfter.keys()).join('|'))
    await fsp.rm(X_LOCAL, { recursive: true, force: true }).catch(() => {})
  } finally {
    await fsp.rm(path.join(ROOT, '.wdsync-test-xmlstyle'), { force: true }).catch(() => {})
  }

  })

  // ============================================================
  // B1：超大目录响应 —— 一次生成 2000+ 条目走 listRemoteSafe（控制时长，不要求 5 万）
  // ============================================================
  await section('B1：超大目录（2050 条目）', async () => {
  const BIG_DIR = path.join(ROOT, 'bigdir')
  const BIG_N = 2050
  await fsp.mkdir(BIG_DIR, { recursive: true })
  for (let i = 0; i < BIG_N; i += 100) {
    // 分批并行写：既快又避免一次排进 2000+ 个线程池任务
    await Promise.all(Array.from({ length: Math.min(100, BIG_N - i) }, (_, k) => fsp.writeFile(path.join(BIG_DIR, `f${i + k}.txt`), 'x')))
  }
  const bigT0 = Date.now()
  const bigScan = await services.sync._internals.listRemoteSafe(cfg, '/bigdir', true)
  const bigMs = Date.now() - bigT0
  check('B1 large listing complete with all entries', bigScan.complete === true && bigScan.files.size === BIG_N, `count=${bigScan.files.size} complete=${bigScan.complete}`)
  check('B1 large listing finishes promptly', bigMs < 30000, `${bigMs}ms`)
  // B1 追加：本地扫描进度回调 —— 最终计数必然送达（节流豁免的末报），
  // 中途事件数远小于条目数（节流生效；250ms 间隔 + 2050 文件扫描通常只够发数个）
  const bigLocal = path.join(os.tmpdir(), `wdsync-e2e-biglocal-${Date.now()}`)
  await fsp.mkdir(bigLocal, { recursive: true })
  for (let i = 0; i < BIG_N; i += 100) {
    await Promise.all(Array.from({ length: Math.min(100, BIG_N - i) }, (_, k) => fsp.writeFile(path.join(bigLocal, `f${i + k}.txt`), 'x')))
  }
  const scanEvents = []
  const bigLocalScan = await services.sync._internals.scanDirSafe(bigLocal, true, null, (n) => scanEvents.push(n))
  check(
    'B1 local scan reports throttled progress with final count delivered',
    bigLocalScan.complete === true && bigLocalScan.files.size === BIG_N && scanEvents.length >= 1 && scanEvents[scanEvents.length - 1] === BIG_N && scanEvents.length < BIG_N,
    `events=${scanEvents.length} last=${scanEvents[scanEvents.length - 1]}`
  )
  await fsp.rm(BIG_DIR, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(bigLocal, { recursive: true, force: true }).catch(() => {})
  })

  // ============================================================
  // B3 系列：Depth:infinity 单请求扫描 + 逐目录回落 + 浅响应阀门 +
  // 探测硬化。依赖 dav-server 的 .wdsync-test-depthlog（PROPFIND 深度日志）、
  // .wdsync-test-noinfinity（infinity 一律 403）与 .wdsync-test-shallowinf
  // （infinity 按 Depth:1 应答）三个标记，均用完即清。
  // ============================================================
  const DEPTHLOG = path.join(ROOT, '.wdsync-test-depthlog.log')
  /** 读深度日志为行数组（元素形如 'DEPTH inf /dav/path' 或 'DEPTH 1 /dav/path'） */
  const readDepthlog = async () =>
    (await fsp.readFile(DEPTHLOG, 'utf-8').catch(() => '')).split('\n').filter(Boolean)
  /** 某远端路径（忽略尾斜杠差异）在指定深度下的列举次数；depth 传 'inf' 或数字字符串 */
  const countDepth = (lines, depth, p) =>
    lines.filter((l) => l.startsWith(`DEPTH ${depth} `) && l.slice(`DEPTH ${depth} `.length).replace(/\/+$/, '') === p.replace(/\/+$/, '')).length
  const clearDepthFlags = async () => {
    for (const f of ['.wdsync-test-depthlog', '.wdsync-test-noinfinity', '.wdsync-test-shallowinf']) {
      await fsp.rm(path.join(ROOT, f), { force: true }).catch(() => {})
    }
    await fsp.rm(DEPTHLOG, { force: true }).catch(() => {})
  }

  await section('B3：Depth:infinity 单请求扫描 / 回落 / 浅响应阀门 / 探测硬化', async () => {
  await setProfile('p9')
  try {
    await clearDepthFlags()
    await freshStore('b3')
    const B3_A = await tmpLocal('b3')
    // 远端先建两层树（top + d1/mid + d1/d2/leaf）
    await fsp.mkdir(path.join(ROOT, 'b3', 'd1', 'd2'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'b3', 'top.txt'), 'b3-top')
    await fsp.writeFile(path.join(ROOT, 'b3', 'd1', 'mid.txt'), 'b3-mid')
    await fsp.writeFile(path.join(ROOT, 'b3', 'd1', 'd2', 'leaf.txt'), 'b3-leaf')
    // B3a 探测：嵌套探测文件验证后判支持（p9 服务器真实递归列举）
    const b3caps = await services.dav.probeCapabilities(cfg, true, '/b3')
    check('B3a probe reports depthInfinity=true (nested-entry verified)', b3caps.depthInfinity === true && b3caps.tier === 'A', JSON.stringify({ di: b3caps.depthInfinity, tier: b3caps.tier }))
    // B3a 同步：整棵树的扫描是根上的一次 Depth:infinity（零次逐目录列举），深层文件正常下载
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-depthlog'), 'x')
    const b3s1 = await syncP(B3_A, '/b3')
    let dl = await readDepthlog()
    check(
      'B3a full-tree scan is a single Depth:infinity request (no per-dir listings)',
      b3s1.downloaded === 3 && countDepth(dl, 'inf', '/dav/b3') >= 1 && countDepth(dl, '1', '/dav/b3') === 0,
      `downloaded=${b3s1.downloaded} infRoot=${countDepth(dl, 'inf', '/dav/b3')} perDirRoot=${countDepth(dl, '1', '/dav/b3')} lines=${dl.length}`
    )
    check(
      'B3a nested file downloaded via single-request scan',
      (await fsp.readFile(path.join(B3_A, 'd1', 'd2', 'leaf.txt'), 'utf-8')) === 'b3-leaf'
    )
    await fsp.rm(DEPTHLOG, { force: true })
    const b3s2 = await syncP(B3_A, '/b3')
    dl = await readDepthlog()
    check('B3a no-change round also scans with exactly one infinity request', isNoop(b3s2) && countDepth(dl, 'inf', '/dav/b3') === 1 && countDepth(dl, '1', '/dav/b3') === 0, `lines=${dl.length}`)
    // 深层远端变更 → 单请求扫描照样检出（整棵树都在这一个响应里）
    await fsp.rm(DEPTHLOG, { force: true })
    await fsp.writeFile(path.join(ROOT, 'b3', 'd1', 'd2', 'leaf.txt'), 'leaf-edited-by-peer')
    const b3s3 = await syncP(B3_A, '/b3')
    check(
      'B3a deep remote change detected via single-request scan',
      b3s3.downloaded === 1 && (await fsp.readFile(path.join(B3_A, 'd1', 'd2', 'leaf.txt'), 'utf-8')) === 'leaf-edited-by-peer',
      JSON.stringify(b3s3)
    )

    // B3b 回落：缓存仍称支持（不重探），服务器改口 403 → 逐目录扫描照常完成本轮上传
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-noinfinity'), 'x')
    try {
      await fsp.rm(DEPTHLOG, { force: true })
      await fsp.writeFile(path.join(B3_A, 'new-after-fallback.txt'), 'naf')
      const b3s4 = await syncP(B3_A, '/b3')
      dl = await readDepthlog()
      check(
        'B3b stale capability falls back to per-dir scan and round succeeds',
        b3s4.uploaded === 1 && b3s4.errors.length === 0 && countDepth(dl, '1', '/dav/b3') >= 2 && countDepth(dl, '1', '/dav/b3/d1') >= 1,
        `uploaded=${b3s4.uploaded} root1=${countDepth(dl, '1', '/dav/b3')} d1=${countDepth(dl, '1', '/dav/b3/d1')}`
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-noinfinity'), { force: true }).catch(() => {})
    }

    // B3c 浅响应阀门：基线含 >50 个嵌套文件后，服务器对 infinity 只回第一层 →
    // 整轮按「扫描不完整」中止（I1：零删除零传输），本地文件与基线原样保留；
    // 服务器行为恢复后下一轮照常（no-op）
    const B3_C = await tmpLocal('b3c')
    await fsp.mkdir(path.join(B3_C, 'sub'), { recursive: true })
    for (let i = 0; i < 60; i++) await fsp.writeFile(path.join(B3_C, 'sub', `f${i}.txt`), `b3c-${i}`)
    const b3c1 = await syncP(B3_C, '/b3c')
    check('B3c baseline established with 60 nested files', b3c1.uploaded === 60, JSON.stringify({ uploaded: b3c1.uploaded }))
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-shallowinf'), 'x')
    try {
      let b3cErr = null
      try {
        await syncP(B3_C, '/b3c')
      } catch (e) {
        b3cErr = e
      }
      const localKept = (await fsp.readdir(path.join(B3_C, 'sub'))).length
      check(
        'B3c shallow infinity response aborts round as incomplete scan (zero deletes)',
        !!b3cErr && /未包含任何嵌套条目/.test(b3cErr.message) && localKept === 60,
        `${b3cErr ? b3cErr.message : 'no error'} localKept=${localKept}`
      )
      check(
        'B3c baseline untouched by the aborted round',
        (await services.sync._internals.baselineSize({ id: 'p', localPath: B3_C, remotePath: '/b3c', mode: 'two-way' })) === 60
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-shallowinf'), { force: true }).catch(() => {})
    }
    const b3c2 = await syncP(B3_C, '/b3c')
    check('B3c round returns to normal after server behavior restored', isNoop(b3c2), JSON.stringify(b3c2))

    // B3d 探测硬化：探测期服务器就「207 但只回第一层」→ depthInfinity 必须判 false
    //（旧实现只看状态码会误判 true，引擎单请求扫描拿到残缺树 → 误删风险）
    await freshStore('b3d')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-shallowinf'), 'x')
    try {
      const b3dcaps = await services.dav.probeCapabilities(cfg, true, '/b3d')
      check('B3d probe hardening: 207-with-shallow-body must NOT be reported as depthInfinity', b3dcaps.depthInfinity === false, JSON.stringify({ di: b3dcaps.depthInfinity, notes: b3dcaps.notes }))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-shallowinf'), { force: true }).catch(() => {})
    }

    await fsp.rm(B3_A, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(B3_C, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'b3'), { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'b3c'), { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'b3d'), { recursive: true, force: true }).catch(() => {})
  } finally {
    await clearDepthFlags()
    await setProfile(null)
  }
  })

  // ============================================================
  // ES0：集合 etag 传播能力探测。依赖 dav-server 的
  // .wdsync-test-etagprop 标记（集合条目 etag 改为树内递归聚合 → 任何深度写入都
  // 传播到祖先集合；默认档集合无 etag 可观测），与 .wdsync-test-depthlog（缓存
  // 命中「零重探」的零请求佐证），均用完即清。只用 probeCapabilities（无同步轮，
  // 故不需要本地临时目录）；各用例独立远端路径 + 独立存储根，互不污染缓存。
  // ============================================================
  await section('ES0：etag 传播能力探测', async () => {
    const clearEtagprop = async () => {
      await fsp.rm(path.join(ROOT, '.wdsync-test-etagprop'), { force: true }).catch(() => {})
    }
    try {
      // a) 默认档（无 etagprop、无 p9）：集合条目无 etag → 传播不可观测，保守判
      //    false；默认档（p1）Depth:infinity 返回 403 → depthInfinity=false
      await freshStore('es0')
      const capsA = await services.dav.probeCapabilities(cfg, true, '/es0a')
      check(
        'ES0a default profile: etagPropagation=false (no collection etag to observe), depthInfinity=false',
        capsA.etagPropagation === false && capsA.depthInfinity === false,
        JSON.stringify({ ep: capsA.etagPropagation, di: capsA.depthInfinity, notes: capsA.notes })
      )
      // b) etagprop 开：修改二层深度的探测文件后，父集合与祖先集合 etag 都变 → true
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-etagprop'), 'x')
      const capsB = await services.dav.probeCapabilities(cfg, true, '/es0b')
      check(
        'ES0b etagprop flag: propagation observed through both levels (etagPropagation=true)',
        capsB.etagPropagation === true,
        JSON.stringify({ ep: capsB.etagPropagation, notes: capsB.notes })
      )
      // c) 缓存生效：同配置（同 origin+用户+存储根）不 force → 命中缓存不重探。
      //    佐证：probedAt 与 force 轮完全相同（重探必产生新的 Date.now()），且
      //    depthlog 打开时整轮零 PROPFIND（重探必有多个列举请求）
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-depthlog'), 'x')
      try {
        await fsp.rm(DEPTHLOG, { force: true }).catch(() => {})
        const capsC = await services.dav.probeCapabilities(cfg, false, '/es0b')
        const dl = await readDepthlog()
        check(
          'ES0c cached capability reused without re-probe (value kept, zero PROPFINDs)',
          capsC.etagPropagation === true && capsC.probedAt === capsB.probedAt && dl.length === 0,
          JSON.stringify({ ep: capsC.etagPropagation, sameProbedAt: capsC.probedAt === capsB.probedAt, lines: dl.length })
        )
      } finally {
        await fsp.rm(path.join(ROOT, '.wdsync-test-depthlog'), { force: true }).catch(() => {})
        await fsp.rm(DEPTHLOG, { force: true }).catch(() => {})
      }
      // d) 旧格式缓存迁移：手工落一份「缺 etagPropagation 字段」的 capabilities.json
      //    （saveCapabilities 的落盘格式：{ v, origin, username, caps }；commonProbed:
      //    true、probedAt 新鲜、writePaths 含本路径 —— 排除「缺写结论」等其他重探
      //    诱因，唯一诱因只能是缺字段），etagprop 标记保持开启；不 force 探测 →
      //    必须触发公共重探（若误信旧缓存，!!undefined 只能给 false）
      await freshStore('es0d')
      const capsDir = storeModule.serverStateDirPath(new URL(cfg.serverUrl).origin, cfg.username)
      // 回拨 1ms：断言用 probedAt !== oldProbedAt 判定「确实重探」，而重探时间戳取自
      // 探测入口的 Date.now() —— 本地极快时两者可落同一毫秒（实测偶发），回拨保证
      // 任何之后取的时钟都严格更大；对「新鲜缓存」语义无影响（TTL 按 7 天计）
      const oldProbedAt = Date.now() - 1
      await fsp.mkdir(capsDir, { recursive: true })
      await fsp.writeFile(
        path.join(capsDir, 'capabilities.json'),
        JSON.stringify({
          v: 1,
          origin: new URL(cfg.serverUrl).origin,
          username: cfg.username,
          caps: {
            probedAt: oldProbedAt,
            commonProbed: true,
            etag: { present: true, weak: false, stable: true },
            conditional: { ifMatch: true, ifNoneMatch: true },
            depthInfinity: false,
            mtimePrecision: 'ms',
            collectionRedirect: false,
            notes: [],
            writePaths: { [storeModule.normalizeRemoteKey('/es0d')]: { writable: true, probedAt: oldProbedAt } },
          },
        })
      )
      const capsD = await services.dav.probeCapabilities(cfg, false, '/es0d')
      check(
        'ES0d old cache missing etagPropagation forces a re-probe (value becomes true)',
        capsD.etagPropagation === true && capsD.probedAt !== oldProbedAt,
        JSON.stringify({ ep: capsD.etagPropagation, reProbed: capsD.probedAt !== oldProbedAt, notes: capsD.notes })
      )
      // 还原存储根与远端探测根目录（探测目录自身已由第 7 步 DELETE，这里清各根）
      await switchDevice(STORAGE_MAIN)
      for (const d of ['es0a', 'es0b', 'es0d']) await fsp.rm(path.join(ROOT, d), { recursive: true, force: true }).catch(() => {})
    } finally {
      await clearEtagprop()
    }
  })

  // ============================================================
  // ES1：远端子树 etag 跳过扫描。依赖 dav-server 的
  // .wdsync-test-etagprop（内容 'x' = 全递归聚合；'shallow' = 只聚合直接子文件，
  // 模拟「服务器停止深层传播」）与 .wdsync-test-depthlog（逐目录列举计数）。
  // 独立远端 /es1*、独立本地临时目录、独立存储根，用完清理。默认档（p1）：
  // 逐目录扫描（infinity 403）+ A 档（If-Match 生效），覆盖跳过 / 深层变化再下降 /
  // 周期性全量 / 停止传播界内滞后 / 运行时异常回落全链路。
  // ============================================================
  await section('ES1：etag 子树跳过', async () => {
    const ES1_RP = '/es1'
    const setEtagprop = async (mode) => fsp.writeFile(path.join(ROOT, '.wdsync-test-etagprop'), mode || 'x')
    const clearEtagpropFlag = async () => fsp.rm(path.join(ROOT, '.wdsync-test-etagprop'), { force: true }).catch(() => {})
    /** 该同步对的 scan-cache.json 路径（测试直改 lastFullScanAt 用；getScanCache 每轮重读磁盘，改完即生效） */
    const scanCacheFile = async (lp) => path.join(await baselineDirOf({ localPath: lp, remotePath: ES1_RP, mode: 'two-way' }), 'scan-cache.json')
    /** 把 scan-cache 的 lastFullScanAt 归零（0 = 立即过期 → 下一轮强制全量下降） */
    const expireScanCache = async (lp) => {
      const f = await scanCacheFile(lp)
      const obj = JSON.parse(await fsp.readFile(f, 'utf-8'))
      obj.lastFullScanAt = 0
      await fsp.writeFile(f, JSON.stringify(obj))
    }
    const withDepthlog = async (fn) => {
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-depthlog'), 'x')
      await fsp.rm(DEPTHLOG, { force: true }).catch(() => {})
      try {
        return await fn()
      } finally {
        await fsp.rm(path.join(ROOT, '.wdsync-test-depthlog'), { force: true }).catch(() => {})
      }
    }
    try {
      await setProfile(null) // 默认档 p1：per-dir 扫描 + A 档
      await setEtagprop('x')
      await freshStore('es1')
      const A = await tmpLocal('es1')

      // a) 种子轮：服务器侧直接种两层树 → 首轮全量下载并建立缓存；第二轮 no-op 且
      //    只列举根目录（a 与 c 按 etag 跳过，a/b 在 a 内部不再列举）
      await fsp.mkdir(path.join(ROOT, 'es1', 'a', 'b'), { recursive: true })
      await fsp.mkdir(path.join(ROOT, 'es1', 'c'), { recursive: true })
      await fsp.writeFile(path.join(ROOT, 'es1', 'a', '1.txt'), 'es1-a1')
      await fsp.writeFile(path.join(ROOT, 'es1', 'a', 'b', '2.txt'), 'es1-b2')
      await fsp.writeFile(path.join(ROOT, 'es1', 'c', '3.txt'), 'es1-c3')
      const s1 = await syncP(A, ES1_RP)
      check(
        'ES1a seed round downloads whole tree via full descent (cache established)',
        s1.downloaded === 3 && s1.scan && s1.scan.remote === 'per-dir' && s1.scan.skippedDirs === 0,
        JSON.stringify({ downloaded: s1.downloaded, scan: s1.scan })
      )
      const s2 = await withDepthlog(async () => syncP(A, ES1_RP))
      const dl2 = await readDepthlog()
      check(
        'ES1a second round is no-op with only the root listed (a and c skipped by etag)',
        isNoop(s2) && s2.scan && s2.scan.remote === 'per-dir' && s2.scan.skippedDirs === 2 &&
          countDepth(dl2, '1', '/dav/es1') === 1 && countDepth(dl2, '1', '/dav/es1/a') === 0 && countDepth(dl2, '1', '/dav/es1/c') === 0,
        `scan=${JSON.stringify(s2.scan)} root=${countDepth(dl2, '1', '/dav/es1')} a=${countDepth(dl2, '1', '/dav/es1/a')} c=${countDepth(dl2, '1', '/dav/es1/c')} lines=${dl2.length}`
      )

      // b) 远端深层变化被发现：etagprop 全递归聚合使 a 与 a/b 的 etag 都变 →
      //    下一轮仅该子树下降（c 继续跳过），深层文件下载；再一轮回到双跳过
      await fsp.writeFile(path.join(ROOT, 'es1', 'a', 'b', '2.txt'), 'es1-b2-peer-edited-deep')
      const s3 = await withDepthlog(async () => syncP(A, ES1_RP))
      const dl3 = await readDepthlog()
      check(
        'ES1b deep remote change re-descends only that subtree (c still skipped)',
        s3.downloaded === 1 && s3.scan.skippedDirs === 1 &&
          countDepth(dl3, '1', '/dav/es1/a') === 1 && countDepth(dl3, '1', '/dav/es1/a/b') === 1 && countDepth(dl3, '1', '/dav/es1/c') === 0,
        `downloaded=${s3.downloaded} skipped=${s3.scan.skippedDirs} a=${countDepth(dl3, '1', '/dav/es1/a')} b=${countDepth(dl3, '1', '/dav/es1/a/b')} c=${countDepth(dl3, '1', '/dav/es1/c')}`
      )
      check('ES1b deep change lands locally', (await fsp.readFile(path.join(A, 'a', 'b', '2.txt'), 'utf-8')) === 'es1-b2-peer-edited-deep')
      const s4 = await syncP(A, ES1_RP)
      check('ES1b next round back to skipping both subtrees', isNoop(s4) && s4.scan.skippedDirs === 2, JSON.stringify(s4.scan))

      // c) 本地新增（新子目录新文件）与修改照常：跳过子树内的修改按合成远端指纹
      //    走 A 档 If-Match 上传；新子目录自动 MKCOL
      await fsp.mkdir(path.join(A, 'd'), { recursive: true })
      await fsp.writeFile(path.join(A, 'd', '4.txt'), 'es1-d4')
      await fsp.writeFile(path.join(A, 'a', '1.txt'), 'es1-a1-local-edited')
      const s5 = await syncP(A, ES1_RP)
      check(
        'ES1c local new subdir + modified file upload normally (auto mkdir, If-Match on synth)',
        s5.uploaded === 2 && s5.errors.length === 0 &&
          (await fsp.readFile(path.join(ROOT, 'es1', 'd', '4.txt'), 'utf-8')) === 'es1-d4' &&
          (await fsp.readFile(path.join(ROOT, 'es1', 'a', '1.txt'), 'utf-8')) === 'es1-a1-local-edited',
        JSON.stringify({ uploaded: s5.uploaded, errors: s5.errors })
      )

      // d) 周期性全量对账：lastFullScanAt 归零 → 下一轮 skippedDirs===0、Depth:1
      //    计数恢复 N+1（根 + a + a/b + c + d），内容 no-op
      await expireScanCache(A)
      const s6 = await withDepthlog(async () => syncP(A, ES1_RP))
      const dl6 = await readDepthlog()
      const totalD1 = dl6.filter((l) => l.startsWith('DEPTH 1 ')).length
      check(
        'ES1d expired cache forces full descent (N+1 listings, content no-op)',
        isNoop(s6) && s6.scan.skippedDirs === 0 && totalD1 === 5 &&
          countDepth(dl6, '1', '/dav/es1') === 1 && countDepth(dl6, '1', '/dav/es1/a') === 1 && countDepth(dl6, '1', '/dav/es1/a/b') === 1 && countDepth(dl6, '1', '/dav/es1/c') === 1 && countDepth(dl6, '1', '/dav/es1/d') === 1,
        `scan=${JSON.stringify(s6.scan)} totalD1=${totalD1} lines=${dl6.length}`
      )

      // e) 服务器停止传播（界内滞后 + 全量兜底）：切换 shallow 聚合（深层写入不再
      //    影响祖先集合 etag；能力缓存仍称 etagPropagation=true）→ 先一轮全量刷新
      //    缓存（a 的聚合口径变化使其 etag 改变而重新下降；c/d/a/b 只含直接文件，
      //    两种口径值相同，仍被跳过）→ 深层直写（a 的 shallow etag 不变）→
      //    下一轮 no-op（documented miss）→ 强制全量轮发现并下载
      await setEtagprop('shallow')
      const s7 = await syncP(A, ES1_RP)
      check('ES1e settle round re-descends only a (aggregate basis changed)', isNoop(s7) && s7.scan.skippedDirs === 3, JSON.stringify(s7.scan))
      await fsp.writeFile(path.join(ROOT, 'es1', 'a', 'b', '2.txt'), 'es1-b2-deep-miss')
      const s8 = await syncP(A, ES1_RP)
      check(
        'ES1e propagation stopped: deep change missed within bounds (documented, skip active)',
        isNoop(s8) && s8.scan.skippedDirs === 3 && (await fsp.readFile(path.join(A, 'a', 'b', '2.txt'), 'utf-8')) === 'es1-b2-peer-edited-deep',
        `scan=${JSON.stringify(s8.scan)}`
      )
      await expireScanCache(A)
      const s9 = await syncP(A, ES1_RP)
      check(
        'ES1e forced full round discovers and downloads the missed change',
        s9.downloaded === 1 && s9.scan.skippedDirs === 0 && (await fsp.readFile(path.join(A, 'a', 'b', '2.txt'), 'utf-8')) === 'es1-b2-deep-miss',
        JSON.stringify({ downloaded: s9.downloaded, scan: s9.scan })
      )

      // f) 异常回落：跳过已发生、远端实际已变（再深层直写一次）→ 同时修改本地同一
      //    文件 → 轮内上传带 A 档 If-Match（合成 etag= 基线）撞真实远端 → 412 →
      //    warning「下一轮将强制全量扫描」+ 缓存立即过期；下一轮全量看到真实远端，
      //    冲突按 remote 解决并下载
      await fsp.writeFile(path.join(ROOT, 'es1', 'a', 'b', '2.txt'), 'es1-b2-anomaly')
      const s10 = await syncP(A, ES1_RP)
      check('ES1f skip still active when server quietly changed the deep file', isNoop(s10) && s10.scan.skippedDirs === 3, JSON.stringify(s10.scan))
      await fsp.writeFile(path.join(A, 'a', 'b', '2.txt'), 'es1-b2-local-edited')
      let s11err = null
      try {
        await syncP(A, ES1_RP)
      } catch (e) {
        s11err = e
      }
      check(
        'ES1f synth-vs-actual mismatch surfaces as 412 precondition error',
        !!s11err && !!s11err.summary && /412/.test(s11err.summary.errors[0] || '') && s11err.summary.scan && s11err.summary.scan.skippedDirs === 3,
        s11err ? `${s11err.message} | scan=${JSON.stringify(s11err.summary.scan)}` : 'no error'
      )
      check(
        'ES1f anomaly warning forces a full scan next round',
        !!s11err && s11err.summary.warnings.some((w) => /下一轮将强制全量扫描/.test(w)),
        s11err ? JSON.stringify(s11err.summary.warnings) : ''
      )
      const s12 = await syncP(A, ES1_RP, undefined, { onConflict: () => 'remote' })
      check(
        'ES1f next round full-scans, sees the real remote and resolves the conflict',
        s12.scan.skippedDirs === 0 && s12.conflicts === 1 && s12.downloaded === 1 &&
          (await fsp.readFile(path.join(A, 'a', 'b', '2.txt'), 'utf-8')) === 'es1-b2-anomaly',
        JSON.stringify({ scan: s12.scan, conflicts: s12.conflicts, downloaded: s12.downloaded })
      )

      // g) 默认档兼容回归：etagprop 关闭（集合条目无 etag）→ 即便缓存满、能力缓存
      //    仍称 true，也永不跳过（etag 缺失自然不匹配），既有行为不变
      await clearEtagpropFlag()
      const s13 = await syncP(A, ES1_RP)
      check('ES1g default profile never skips (no collection etag observable)', isNoop(s13) && s13.scan.skippedDirs === 0, JSON.stringify(s13.scan))

      // 清理：本地目录、远端树、存储根
      await fsp.rm(A, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'es1'), { recursive: true, force: true }).catch(() => {})
      await switchDevice(STORAGE_MAIN)
    } finally {
      await clearEtagpropFlag()
      await setProfile(null)
    }
  })

  // DP：本地脏路径快速核对 —— watch 轮把 watcher 事件
  // 累积的脏路径集经 handlers.hints 交给引擎，引擎用「基线合成 + 逐路径 lstat
  // 核对」替代全量 walk（scan.local='dirty'）；interval / startup / manual 轮不带
  // 提示恒全量（watch 事件不保证完整，正确性兜底是周期性全量扫描）。覆盖：直调
  // 三态（改 / 删 / 增）、目录名脏路径的子树清扫、阈值回落、来源限制、watcher
  // 记录与清理时序、调度器 watch/interval 轮的 hints 接线。
  await section('DP：本地脏路径快速核对', async () => {
    await setProfile(null) // 默认档 p1（A 档 + per-dir 远端扫描，排除 etag 跳过干扰）
    await freshStore('dp')
    const DP_A = await tmpLocal('dp-a')
    const DP_B = await tmpLocal('dp-b')
    const DP_E = await tmpLocal('dp-e')
    const DP_F = await tmpLocal('dp-f')
    /** 带 hints 的引擎直调（syncP 固定无 hints，提示轮需手工传 handlers） */
    const syncHint = (lp, rp, hints) =>
      services.sync.syncDirectory(cfg, { id: 'dp', localPath: lp, remotePath: rp, mode: 'two-way' }, SP, hints ? { hints } : {})
    /** 真实时钟轮询等待谓词（DP-f 自带：waitReal 定义在本节之后，位置上无法复用） */
    const waitUntil = async (pred, timeoutMs = 10000) => {
      const t0 = Date.now()
      while (!pred()) {
        if (Date.now() - t0 > timeoutMs) return false
        await sleep(20)
      }
      return true
    }
    try {
      // a) 引擎直调：种子轮全量 → 改 1 + 删 1 + 新增 1 → watch hints 快速核对
      //    （改写内容长度不同，确保 size 指纹可靠变化，不依赖 mtime 粒度）
      await fsp.writeFile(path.join(DP_A, 'a.txt'), 'dp-a-v1')
      await fsp.writeFile(path.join(DP_A, 'b.txt'), 'dp-b-v1')
      await fsp.writeFile(path.join(DP_A, 'c.txt'), 'dp-c-v1')
      const dSeed = await syncP(DP_A, '/dp')
      check('DPa seed round uploads 3 via full local scan', dSeed.uploaded === 3 && dSeed.scan && dSeed.scan.local === 'full', JSON.stringify(dSeed.scan))
      await fsp.writeFile(path.join(DP_A, 'a.txt'), 'dp-a-v2-longer-content')
      await fsp.unlink(path.join(DP_A, 'b.txt'))
      await fsp.writeFile(path.join(DP_A, 'new.txt'), 'dp-new-v1')
      const dDirty = await syncHint(DP_A, '/dp', { source: 'watch', dirtyPaths: ['a.txt', 'b.txt', 'new.txt'] })
      check(
        'DPa dirty round reports local scan form dirty with 3 paths',
        dDirty.scan && dDirty.scan.local === 'dirty' && dDirty.scan.dirtyPaths === 3,
        JSON.stringify(dDirty.scan)
      )
      check(
        'DPa dirty round plans correct ops (upload×2, delete-remote×1)',
        dDirty.uploaded === 2 && dDirty.deleted === 1 && dDirty.errors.length === 0,
        JSON.stringify({ uploaded: dDirty.uploaded, deleted: dDirty.deleted, errors: dDirty.errors })
      )
      check(
        'DPa remote reflects modify / delete / add exactly',
        (await fsp.readFile(path.join(ROOT, 'dp', 'a.txt'), 'utf-8')) === 'dp-a-v2-longer-content' &&
          !fs.existsSync(path.join(ROOT, 'dp', 'b.txt')) &&
          (await fsp.readFile(path.join(ROOT, 'dp', 'new.txt'), 'utf-8')) === 'dp-new-v1' &&
          fs.existsSync(path.join(ROOT, 'dp', 'c.txt')),
        ''
      )
      const dSettle = await syncP(DP_A, '/dp')
      check(
        'DPa next hint-less round is a full no-op (fast check kept baseline consistent)',
        dSettle.scan && dSettle.scan.local === 'full' && isNoop(dSettle),
        JSON.stringify(dSettle.scan)
      )

      // b) 目录删除：脏路径只报目录名 → 快速核对清空子树条目 → 远端子树删除传播
      //    + 空目录清理照常
      await fsp.mkdir(path.join(DP_B, 'sub'), { recursive: true })
      await fsp.writeFile(path.join(DP_B, 'sub', 'x.txt'), 'dp-b-x')
      await fsp.writeFile(path.join(DP_B, 'sub', 'y.txt'), 'dp-b-y')
      await fsp.writeFile(path.join(DP_B, 'top.txt'), 'dp-b-top')
      const dSeedB = await syncP(DP_B, '/dp2')
      check('DPb seed round uploads 3 (subtree + top)', dSeedB.uploaded === 3, JSON.stringify(dSeedB.scan))
      await fsp.rm(path.join(DP_B, 'sub'), { recursive: true, force: true })
      const dDirtyB = await syncHint(DP_B, '/dp2', { source: 'watch', dirtyPaths: ['sub'] })
      check(
        'DPb dir-name-only dirty path clears the whole subtree (delete-remote×2)',
        dDirtyB.scan && dDirtyB.scan.local === 'dirty' && dDirtyB.deleted === 2 && dDirtyB.errors.length === 0,
        JSON.stringify({ scan: dDirtyB.scan, deleted: dDirtyB.deleted, errors: dDirtyB.errors })
      )
      check(
        'DPb remote subtree removed and emptied dir pruned as usual',
        (await fsp.readdir(path.join(ROOT, 'dp2', 'sub')).catch(() => 'GONE')) === 'GONE' &&
          dDirtyB.dirsPrunedRemote === 1 &&
          (await fsp.readFile(path.join(ROOT, 'dp2', 'top.txt'), 'utf-8')) === 'dp-b-top',
        JSON.stringify({ pruned: dDirtyB.dirsPrunedRemote })
      )
      const dSettleB = await syncP(DP_B, '/dp2')
      check('DPb next full round is a no-op', dSettleB.scan && dSettleB.scan.local === 'full' && isNoop(dSettleB), JSON.stringify(dSettleB.scan))

      // c) 阈值回落：600 > 512 → 放弃快速核对走全量 walk（内容无变化 → no-op）
      const many = Array.from({ length: 600 }, (_, i) => `z${i}.txt`)
      const dOver = await syncHint(DP_A, '/dp', { source: 'watch', dirtyPaths: many })
      check(
        'DPc 600 dirty paths fall back to full walk',
        dOver.scan && dOver.scan.local === 'full' && dOver.scan.dirtyPaths === 600 && isNoop(dOver),
        JSON.stringify(dOver.scan)
      )

      // d) 来源限制：非 watch source（manual）即使带 dirtyPaths 也全量；无 hints 全量
      const dManual = await syncHint(DP_A, '/dp', { source: 'manual', dirtyPaths: ['a.txt'] })
      check(
        'DPd manual-source hints never trigger dirty scan',
        dManual.scan && dManual.scan.local === 'full' && dManual.scan.dirtyPaths === 0 && isNoop(dManual),
        JSON.stringify(dManual.scan)
      )
      const dNoHint = await syncP(DP_A, '/dp')
      check('DPd no hints = full scan', dNoHint.scan && dNoHint.scan.local === 'full' && isNoop(dNoHint), JSON.stringify(dNoHint.scan))

      // e) watcher 记录与清理：脏路径在去抖之前即时登记（NFC 归一）；引擎轮成功后
      //    恰好消费这些路径；轮后新事件留给下一轮；stopWatch 后 peek 返回 null。
      //    临时文件事件被 watchDir 过滤，不进脏集。
      let eFired = 0
      services.fsx.watchDir('dp-e', DP_E, () => {
        eFired++
      })
      const nfdName = 'cafe\u0301.txt' // NFD 写入（macOS 事件即 NFD 形态）→ 脏集应存 NFC
      const nfcName = `${'cafe\u0301'.normalize('NFC')}.txt`
      await fsp.writeFile(path.join(DP_E, 'e1.txt'), 'dp-e1')
      await fsp.writeFile(path.join(DP_E, nfdName), 'dp-e-nfd')
      await fsp.writeFile(path.join(DP_E, '.wdsync-tmp-e-probe'), 'x')
      // 等 fs.watch 事件送达。登记本身即时（不等 1.5s 去抖），但事件**送达**与系统
      // 负载相关：全量模式高负载下偶发迟到数秒，固定 sleep 会 miss（脏集跨去抖
      // 存续、仅被引擎轮消费，轮询等待不改变断言语义：登记 / NFC 归一 / 临时过滤）
      let peek1 = services.fsx.peekDirtyPaths('dp-e')
      const gotEvents = await waitUntil(() => {
        peek1 = services.fsx.peekDirtyPaths('dp-e')
        return Array.isArray(peek1) && peek1.includes('e1.txt') && peek1.includes(nfcName)
      }, 6000)
      check(
        'DPe dirty paths registered immediately, NFC-normalized (before debounce fires)',
        gotEvents && Array.isArray(peek1) && peek1.includes('e1.txt') && peek1.includes(nfcName),
        JSON.stringify(peek1)
      )
      check('DPe sync temp file events never enter the dirty set', Array.isArray(peek1) && !peek1.some((p) => p.includes('wdsync')), JSON.stringify(peek1))
      const dDirtyE = await syncHint(DP_E, '/dp-e', { source: 'watch', dirtyPaths: peek1, watcherKey: 'dp-e' })
      check(
        'DPe engine round consumes the hints (2 uploads, both new to empty baseline)',
        dDirtyE.scan && dDirtyE.scan.local === 'dirty' && dDirtyE.uploaded === 2 && dDirtyE.errors.length === 0,
        JSON.stringify({ scan: dDirtyE.scan, uploaded: dDirtyE.uploaded })
      )
      const peek2 = services.fsx.peekDirtyPaths('dp-e')
      check(
        'DPe consumed paths cleared from the watcher dirty set',
        Array.isArray(peek2) && !peek2.includes('e1.txt') && !peek2.includes(nfcName),
        JSON.stringify(peek2)
      )
      await fsp.writeFile(path.join(DP_E, 'e2.txt'), 'dp-e2')
      let peek3 = services.fsx.peekDirtyPaths('dp-e')
      await waitUntil(() => {
        peek3 = services.fsx.peekDirtyPaths('dp-e')
        return Array.isArray(peek3) && peek3.includes('e2.txt')
      }, 6000) // 同上：事件送达受负载影响，轮询等待（超时后按原断言失败）
      check('DPe events arriving after the round stay in the set for the next round', Array.isArray(peek3) && peek3.includes('e2.txt'), JSON.stringify(peek3))
      services.fsx.stopWatch('dp-e')
      check('DPe stopWatch drops the record (peek → null)', services.fsx.peekDirtyPaths('dp-e') === null, '')

      // f) 调度器接线：stub engine 捕获 handlers + peekDirtyPaths 返回固定值 ——
      //    watch 轮 hints.source='watch' 且脏路径传递（peek 用注册 watcherId），interval
      //    轮 source='interval' 且不带脏路径。本用例自带 dbStorage 桩与假时钟（SC 系列
      //    的共用助手定义在本节之后，位置上无法复用），结束即还原 ztools 桩。
      const prevZt = global.window.ztools
      const F_DB = {}
      global.window.ztools = {
        dbStorage: { getItem: (k) => (k in F_DB ? F_DB[k] : null), setItem: (k, v) => { F_DB[k] = v } },
        ...(prevZt && prevZt.shellTrashItem ? { shellTrashItem: prevZt.shellTrashItem } : {}),
      }
      F_DB['webdav-sync:data'] = {
        server: { serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: services.secure.sealSecret('p') },
        dirs: [{ id: 'd1', localPath: DP_F, remotePath: '/dp-f', mode: 'two-way' }],
        prefs: { autoSync: true, intervalMin: 1, syncOnStartup: false, backgroundRunning: true, conflictStrategy: 'ask', ignoreHidden: true, concurrency: 4 },
      }
      const fCalls = []
      const fPeeked = []
      let fWatchFire = null
      // 极简假时钟（调度器 now/timers 注入；选举等真实 IO 在推进间隙执行）
      let fNow = Date.now()
      const fPend = new Set()
      const fFire = () => {
        for (const h of Array.from(fPend)) {
          if (h.dead) continue
          if (h.at <= fNow) {
            if (h.interval > 0) {
              h.at = fNow + h.interval
              h.fn()
            } else {
              h.dead = true
              fPend.delete(h)
              h.fn()
            }
          }
        }
      }
      const fTimers = {
        setTimeout(fn, ms) {
          const h = { fn, at: fNow + Math.max(0, Number(ms) || 0), interval: 0, dead: false }
          fPend.add(h)
          return h
        },
        clearTimeout(h) {
          if (h) {
            h.dead = true
            fPend.delete(h)
          }
        },
        setInterval(fn, ms) {
          const h = { fn, at: fNow + Math.max(0, Number(ms) || 0), interval: Math.max(1, Number(ms) || 1), dead: false }
          fPend.add(h)
          return h
        },
        clearInterval(h) {
          if (h) {
            h.dead = true
            fPend.delete(h)
          }
        },
      }
      const fAdvance = async (ms) => {
        let remaining = ms
        while (remaining > 0) {
          const step = Math.min(200, remaining)
          fNow += step
          fFire()
          remaining -= step
          await new Promise((r) => setImmediate(r)) // 让真实 IO / 微任务在推进间隙执行
          fFire()
        }
      }
      const fSched = services.sync._internals.createScheduler({
        engine: {
          syncDirectory: async (_cfg, _dir, _prefs, handlers) => {
            fCalls.push(handlers && handlers.hints ? { ...handlers.hints } : null)
            return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, deferredConflicts: 0, adopted: 0, bytesUp: 0, bytesDown: 0, totalFiles: 0, tier: 'B', warnings: [], errors: [], errorsDropped: 0 }
          },
          watchDir: (wid, _lp, onChange) => {
            fWatchFire = onChange
            return true
          },
          stopWatch: () => {},
          stopAllWatch: () => {},
          peekDirtyPaths: (wid) => {
            fPeeked.push(wid)
            return ['stub-dirty.txt']
          },
          listPendingConflicts: async () => [],
        },
        getDeviceId: services.storage.getDeviceId,
        autoBootstrap: false,
        now: () => fNow,
        timers: fTimers,
      })
      try {
        await fSched.init()
        // 选举 / watcher 注册是真实 IO：边推进假时钟边等 leader + stub watchDir 挂上
        const elected = await waitUntil(() => fSched.getSnapshot().leader.isLeader === true && fWatchFire != null, 10000)
        check('DPf test scheduler elected leader and registered stub watcher', elected, JSON.stringify(fSched.getSnapshot().leader))
        // watch 轮：直接调 stub 捕获的 onChange（等价 watcher 去抖后的触发）
        fWatchFire()
        const watchOk = await waitUntil(() => fCalls.length >= 1, 8000)
        const watchHints = fCalls[0]
        check(
          'DPf watch round passes hints with source=watch and the peeked dirty paths',
          watchOk && watchHints && watchHints.source === 'watch' && Array.isArray(watchHints.dirtyPaths) && watchHints.dirtyPaths.length === 1 && watchHints.dirtyPaths[0] === 'stub-dirty.txt',
          JSON.stringify(watchHints)
        )
        check(
          'DPf peek uses the registered watcher id (instanceId:dirId) and watcherKey matches',
          fPeeked.includes(`${fSched.instanceId}:d1`) && watchHints && watchHints.watcherKey === `${fSched.instanceId}:d1`,
          JSON.stringify({ peeked: fPeeked, watcherKey: watchHints && watchHints.watcherKey })
        )
        // interval 轮：假时钟推进 60s（intervalMin=1）到期触发
        await fAdvance(62000)
        const intervalOk = await waitUntil(() => fCalls.length >= 2, 8000)
        const intervalHints = fCalls[fCalls.length - 1]
        check(
          'DPf interval round hints carry source=interval and no dirty paths (full scan)',
          intervalOk && intervalHints && intervalHints.source === 'interval' && intervalHints.dirtyPaths === undefined,
          JSON.stringify(intervalHints)
        )
      } finally {
        fSched.cleanup()
        global.window.ztools = prevZt
      }

      // 清理：本地目录、远端树、存储根
      for (const d of [DP_A, DP_B, DP_E, DP_F]) await fsp.rm(d, { recursive: true, force: true }).catch(() => {})
      for (const r of ['dp', 'dp2', 'dp-e']) await fsp.rm(path.join(ROOT, r), { recursive: true, force: true }).catch(() => {})
      await switchDevice(STORAGE_MAIN)
    } finally {
      services.fsx.stopWatch('dp-e') // 幂等兜底（e 段异常路径也不遗留 watcher）
      await setProfile(null)
    }
  })

  // ============================================================
  // HP 系列：宿主端口注入 —— preload 对宿主（ZTools）
  // 的全部运行期依赖（storageRoot / trashItem / notify / config / lifecycle）
  // 已收敛为显式端口（src-ztools/preload/host.mts，经 services.host 门面暴露）。
  // 本节只在源码轨运行：built 轨是双模块图（bundle 与另行 import 的源码 store
  // 各一实例），setHostPorts 注入只影响所在模块图、无法两边对齐 —— BUILT 时整节
  // 跳过；默认端口的等价性由既有全部用例回归证明（它们全部走 window.ztools mock）。
  // ============================================================
  await section('HP：宿主端口注入', async () => {
    if (BUILT) {
      console.log('[built] HP 节仅在源码轨运行（built 轨 bundle 与源码 store 双模块图，注入只影响所在模块图、无法对齐）—— 整节跳过')
      return
    }
    await setProfile(null) // 默认档 p1（与 DP 同口径，不引入档位变量）
    const prevZtHp = global.window.ztools
    const HP_ROOT = path.join(os.tmpdir(), `wdsync-e2e-hp-root-${Date.now()}`)
    const HP_TRASH = path.join(os.tmpdir(), `wdsync-e2e-hp-trash-${Date.now()}`)
    const HP_NOTES = []
    const HP_DB = {}
    const hpTrashLog = []
    /** 本节自带的实时钟轮询（waitReal 定义在本节之后的 SC 区，位置上无法复用） */
    const hpWait = async (pred, timeoutMs = 10000) => {
      const t0 = Date.now()
      while (!pred()) {
        if (Date.now() - t0 > timeoutMs) return false
        await sleep(20)
      }
      return true
    }
    let HP_LOCAL = null
    let HP2_LOCAL = null
    let hpSched = null
    try {
      await fsp.mkdir(HP_TRASH, { recursive: true })
      // —— a) 自定义端口全链路：存储根 / 回收站 / 内存 config / 通知收集 / lifecycle=null ——
      HP_LOCAL = await tmpLocal('hp')
      // 清 override 与根缓存，使端口成为存储根的唯一权威（setRootForTest 的
      // override 优先于端口，不清理会让注入形同虚设）
      await services.storage.setRootForTest(null)
      services.host.setHostPorts({
        storageRoot: () => HP_ROOT,
        trashItem: async (p) => {
          hpTrashLog.push(p)
          const dest = path.join(HP_TRASH, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(p)}`)
          await fsp.rename(p, dest)
        },
        notify: (body) => HP_NOTES.push(String(body)),
        config: { getItem: (k) => (k in HP_DB ? HP_DB[k] : null), setItem: (k, v) => { HP_DB[k] = v } },
        lifecycle: null,
      })
      await fsp.writeFile(path.join(HP_LOCAL, 'a.txt'), 'hp-a')
      await fsp.writeFile(path.join(HP_LOCAL, 'b.txt'), 'hp-b')
      const hpS1 = await syncP(HP_LOCAL, '/hp')
      const hpBaselineDir = await baselineDirOf({ localPath: HP_LOCAL, remotePath: '/hp' })
      check(
        'HPa injected storage-root port hosts all engine state (device.json + baseline under custom root)',
        hpS1.uploaded === 2 && fs.existsSync(path.join(HP_ROOT, 'sync-state', 'device.json')) && hpBaselineDir.startsWith(path.join(HP_ROOT, 'sync-state', 'baselines')),
        JSON.stringify({ uploaded: hpS1.uploaded, base: hpBaselineDir })
      )
      // 本地删除 → 经注入 trash 端口进自定义回收目录：删「远端」副本让引擎做
      // delete-local 传播（本地删除走回收站）；默认 mock 回收站（TRASH_DIR）零接触
      const trashMockCount0 = fs.readdirSync(TRASH_DIR).length
      await fsp.rm(path.join(ROOT, 'hp', 'b.txt'))
      const hpS2 = await syncP(HP_LOCAL, '/hp')
      check(
        'HPa remote-delete propagation routes the local delete through the injected trash port',
        hpS2.deleted === 1 && hpTrashLog.length === 1 && hpTrashLog[0].endsWith('b.txt') && fs.readdirSync(HP_TRASH).some((n) => n.endsWith('b.txt')) && !fs.existsSync(path.join(HP_LOCAL, 'b.txt')) && fs.readdirSync(TRASH_DIR).length === trashMockCount0,
        JSON.stringify({ deleted: hpS2.deleted, portCalls: hpTrashLog.length, mockDelta: fs.readdirSync(TRASH_DIR).length - trashMockCount0 })
      )
      // 调度器自举经注入的内存 config：此刻 window.ztools mock 只有 shellTrashItem、
      // 没有 dbStorage —— ready 即证明配置读的是端口而非宿主对象。
      // 冲突提醒用 startup 轮验证：init() 会标记 rendererOnline，手动轮（syncNow）的
      // 冲突将转发等待渲染层应答（无订阅者应答即永久等待 —— 生产语义正确但测试会
      // 挂起）；startup / watch 等自动轮冲突一律 defer，才是系统提醒的生产路径。
      // 挂起 services.mts 挂载期的默认调度器：它同样读得到注入的 config 端口 —— 若
      // 本节在它 ~1s 的自举重试窗口内运行（当前节序靠后不会，但顺序调整后会），
      // 它会抢先持有同一存储根的 leader 锁，本节的测试实例永远 standby。挂起让它
      // 主动让锁，finally 还原（还原时端口已撤、mock 无 dbStorage，它保持未自举态）。
      if (services.scheduler) services.scheduler.suspend()
      await fsp.writeFile(path.join(HP_LOCAL, 'c.txt'), 'hp-c-local')
      await fsp.writeFile(path.join(ROOT, 'hp', 'c.txt'), 'hp-c-remote')
      // autoSync 必须开：dirEligible 以「全局 autoSync !== false」为门（scheduler.mts），
      // 关着时任何调度器（含本节实例）都不会跑 startup 轮，挂起冲突的提醒无从触发
      HP_DB['webdav-sync:data'] = {
        server: { serverUrl: cfg.serverUrl, username: 'u', password: services.secure.sealSecret('p') },
        dirs: [{ id: 'hp1', localPath: HP_LOCAL, remotePath: '/hp', mode: 'two-way' }],
        prefs: { autoSync: true, intervalMin: 15, syncOnStartup: true, conflictStrategy: 'ask', ignoreHidden: true, concurrency: 4 },
      }
      hpSched = services.sync._internals.createScheduler({
        engine: {
          syncDirectory: services.sync.syncDirectory,
          watchDir: services.fsx.watchDir,
          stopWatch: services.fsx.stopWatch,
          stopAllWatch: services.fsx.stopAllWatch,
          listPendingConflicts: services.sync.listPendingConflicts,
        },
        getDeviceId: services.storage.getDeviceId,
        autoBootstrap: false,
      })
      const hpInit = await hpSched.init()
      check(
        'HPa scheduler bootstraps from the injected in-memory config port (ready + 1 slot)',
        hpInit.ready === true && hpInit.slots.length === 1,
        JSON.stringify({ ready: hpInit.ready, reason: hpInit.notReadyReason, slots: hpInit.slots.length })
      )
      // startup 轮（自动类，冲突一律 defer）→ 挂起冲突的系统提醒走注入 notify 端口
      const hpNotified = await hpWait(() => HP_NOTES.length >= 1, 15000)
      check(
        'HPa deferred-conflict notification routed through the injected notify port',
        hpNotified && HP_NOTES.length === 1 && /1 个待处理冲突/.test(HP_NOTES[0] || ''),
        JSON.stringify({ notified: hpNotified, notes: HP_NOTES })
      )
      hpSched.cleanup()
      hpSched = null
      // —— 还原默认端口：既有 window.ztools mock 路径照常工作（再驱动一小轮证明）——
      services.host.setHostPorts(null)
      await switchDevice(STORAGE_MAIN)
      HP2_LOCAL = await tmpLocal('hp2')
      await fsp.writeFile(path.join(HP2_LOCAL, 'x.txt'), 'hp2-x')
      const hpS3 = await syncP(HP2_LOCAL, '/hp2')
      await fsp.rm(path.join(ROOT, 'hp2', 'x.txt'))
      const hpS4 = await syncP(HP2_LOCAL, '/hp2') // 远端删除 → 本地经默认端口（mock 回收站）删除
      const hpMockTrashed = fs.readdirSync(TRASH_DIR).filter((n) => n.endsWith('x.txt'))
      check(
        'HPa setHostPorts(null) restores the default ports (delete flows to the window.ztools mock trash again)',
        hpS3.uploaded === 1 && hpS4.deleted === 1 && hpMockTrashed.length >= 1 && !fs.existsSync(path.join(HP2_LOCAL, 'x.txt')) && hpTrashLog.length === 1,
        JSON.stringify({ up: hpS3.uploaded, del: hpS4.deleted, mockHits: hpMockTrashed.length, portCalls: hpTrashLog.length })
      )
      // —— b) 默认端口动态性：不覆盖时每次现读 window.ztools（现取不缓存）——
      const HP_PROBE = path.join(os.tmpdir(), `wdsync-e2e-hp-probe-${Date.now()}`)
      global.window.ztools = {
        dbStorage: { getItem: () => null, setItem: () => {} },
        getPath: (n) => (n === 'pluginData' ? HP_PROBE : ''),
        shellTrashItem: async () => {},
        onPluginEnter: () => {},
        onPluginOut: () => {},
      }
      const dyn1 = services.host.getHostPorts()
      check(
        'HPb default port reflects the live window.ztools mock (config / storageRoot / lifecycle)',
        dyn1.config != null && dyn1.storageRoot() === HP_PROBE && dyn1.lifecycle != null,
        JSON.stringify({ config: dyn1.config != null, root: dyn1.storageRoot(), lifecycle: dyn1.lifecycle != null })
      )
      delete global.window.ztools
      await services.storage.setRootForTest(null) // 清根缓存，逼下一次解析走默认端口
      const dyn2 = services.host.getHostPorts()
      check(
        'HPb host removal degrades the default port (config=null, store falls back to tmpdir)',
        dyn2.config == null && dyn2.storageRoot() == null && dyn2.lifecycle == null && storeModule.storageRoot() === path.join(os.tmpdir(), 'webdav-sync-state-fallback', 'sync-state'),
        JSON.stringify({ config: dyn2.config == null, root: dyn2.storageRoot(), lifecycle: dyn2.lifecycle == null })
      )
    } finally {
      services.host.setHostPorts(null) // 双保险：异常路径也不把注入泄漏给后续节
      if (services.scheduler) await services.scheduler.resume().catch(() => {}) // 还原挂起的默认调度器（此刻 config 已不可得，它保持未自举态）
      global.window.ztools = prevZtHp
      await switchDevice(STORAGE_MAIN)
      if (hpSched) {
        try {
          hpSched.cleanup()
        } catch (_) {
          /* 已清理 / 未挂载：忽略 */
        }
      }
      for (const d of [HP_LOCAL, HP2_LOCAL, HP_ROOT, HP_TRASH]) if (d) await fsp.rm(d, { recursive: true, force: true }).catch(() => {})
      for (const r of ['hp', 'hp2']) await fsp.rm(path.join(ROOT, r), { recursive: true, force: true }).catch(() => {})
      await setProfile(null)
    }
  })

  // B4：进度事件节流 —— 逐文件 tick 不再全量外发（同相位 ≥150ms 节流），
  // 但每相位首事件与终态事件必然送达：注入式用例（plan 首事件窗口）依赖前者，
  // 最终计数依赖后者。用 30 个小文件的上传轮观测。
  await section('B4：进度事件节流与终态送达', async () => {
    await freshStore('b4')
    const B4_LOCAL = await tmpLocal('b4')
    for (let i = 0; i < 30; i++) await fsp.writeFile(path.join(B4_LOCAL, `f${i}.txt`), `b4-${i}`)
    const events = []
    const b4s1 = await syncP(B4_LOCAL, '/b4', undefined, {
      onProgress: (p) => events.push({ ...p }),
    })
    const phases = events.map((e) => e.phase)
    const transferEvents = events.filter((e) => e.phase === 'transfer')
    check(
      'B4 first event of each phase always delivered (scan/plan/transfer)',
      phases.includes('scan') && phases.includes('plan') && phases.includes('transfer') && phases[0] === 'scan',
      phases.join(',')
    )
    check(
      'B4 transfer-phase events throttled well below per-file ticks',
      b4s1.uploaded === 30 && transferEvents.length >= 1 && transferEvents.length < 30,
      `uploaded=${b4s1.uploaded} events=${transferEvents.length}`
    )
    check(
      'B4 final transfer event carries the full count (forced terminal tick)',
      transferEvents[transferEvents.length - 1].filesDone === 30 && transferEvents[transferEvents.length - 1].filesTotal === 30,
      JSON.stringify(transferEvents[transferEvents.length - 1])
    )
    // 扫描进度（phase='scan' 的 filesDone 递增）：末事件携带最终扫描计数
    const scanEvents = events.filter((e) => e.phase === 'scan')
    check('B4 scan progress delivered with final file count', scanEvents.length >= 1 && scanEvents[scanEvents.length - 1].filesDone === 30, `events=${scanEvents.length} last=${JSON.stringify(scanEvents[scanEvents.length - 1])}`)
    await fsp.rm(B4_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'b4'), { recursive: true, force: true }).catch(() => {})
  })

  // ============================================================
  // P 系列：服务器档位矩阵
  // 档位由 ROOT 下 .wdsync-test-profile 标记文件切换（内容 p1..p9）；
  // 保留既有单行为标记（noetag/redirect/ratelimit/xmlstyle）供旧用例复用，
  // profile 是它们的「组合预设」——档位是多种行为的原子组合，单个标记文件一次写入
  // 即整体生效，避免多标记写入顺序造成的中间态。每个档位断言：
  //   1) probeCapabilities 分类正确；2) 一轮（或多轮）同步行为符合档位语义。
  // 多设备（两 deviceId + 两本地目录）在 P1/P2/P7/P8 下各跑一轮基础交替。
  // ============================================================
  // （setProfile / setMidair / freshStore / tmpLocal / syncP / settleStable 已提升到外层共享作用域，
  //   以支持各节独立登记与 --fast 跳过）

  // ---------- P1 全功能（强 etag + 条件请求生效 + Depth infinity 关闭）----------
  await slowSection('P1：全功能档', '档位深水区：探测 + 竞态 + 多设备约 13 轮；A 档语义仍由 SAFE / L / PC / BV（默认 p1 档）覆盖', async () => {
  await setProfile('p1')
  await fsp.rm(path.join(ROOT, 'px1'), { recursive: true, force: true }).catch(() => {})
  const P1_S = await freshStore('p1a')
  const P1_A = await tmpLocal('p1a')
  const p1caps = await services.dav.probeCapabilities(cfg, true)
  check(
    'P1 probe classifies tier A with strong stable etag and honored conditionals',
    p1caps.tier === 'A' && p1caps.etag.present && !p1caps.etag.weak && p1caps.etag.stable && p1caps.conditional.ifMatch && p1caps.conditional.ifNoneMatch && p1caps.depthInfinity === false && p1caps.mtimePrecision === 'ms' && p1caps.writable === true,
    JSON.stringify(p1caps)
  )
  const p1cached = await services.dav.probeCapabilities(cfg)
  check('P1 probe result cached (no re-probe within TTL)', p1cached.probedAt === p1caps.probedAt && p1cached.tier === 'A')
  check('P1 probe leaves no residue on remote root', (await fsp.readdir(ROOT)).filter((n) => n.startsWith('.wdsync-probe-')).length === 0)
  await fsp.writeFile(path.join(P1_A, 'race-midair.txt'), 'p1-v1')
  await fsp.writeFile(path.join(P1_A, 'other.txt'), 'p1-other')
  const p1s1 = await syncP(P1_A, '/px1')
  check('P1 first sync uploads (new files via If-None-Match:*)', p1s1.uploaded === 2 && p1s1.tier === 'A', JSON.stringify(p1s1))
  // A 档 412 竞态保护：midair 钩子在收到 PUT 时先把远端改写为「对端新版本」再评估条件头
  await fsp.writeFile(path.join(P1_A, 'race-midair.txt'), 'p1-v2-local-longer')
  await setMidair('put')
  let p1midErr = null
  try {
    await syncP(P1_A, '/px1')
  } catch (e) {
    p1midErr = e
  }
  await setMidair(null)
  check('P1 midair PUT is rejected with 412 and skips the file', !!p1midErr && /412|已被其他设备修改/.test(p1midErr.message), p1midErr && p1midErr.message)
  check(
    'P1 midair: remote keeps peer version (local edit NOT uploaded this round)',
    (await fsp.readFile(path.join(ROOT, 'px1', 'race-midair.txt'), 'utf-8')).startsWith('MIDAIR-PEER-EDIT-')
  )
  // 下轮重新规划：双侧都变 → 冲突（策略 local）→ 收敛；钩子一次性，重传不再 412
  const p1s2 = await syncP(P1_A, '/px1', { ...SP, conflictStrategy: 'local' })
  check('P1 converges via conflict resolution after midair', p1s2.conflicts === 1 && p1s2.uploaded === 1, JSON.stringify(p1s2))
  const p1settle = await settleStable(P1_A, '/px1')
  check('P1 settles to no-op after midair round', p1settle.ok, `rounds=${p1settle.rounds}`)
  // 多设备基础交替（参考 M2 写法）
  const P1_SB = await freshStore('p1b')
  const P1_B = await tmpLocal('p1b')
  await switchDevice(P1_SB)
  const p1b1 = await syncP(P1_B, '/px1')
  check('P1 device B downloads all', p1b1.downloaded === 2, JSON.stringify(p1b1))
  await switchDevice(P1_S)
  await fsp.writeFile(path.join(P1_A, 'other.txt'), 'p1-other-v2')
  const p1a2 = await syncP(P1_A, '/px1')
  await switchDevice(P1_SB)
  const p1b2 = await syncP(P1_B, '/px1')
  check('P1 A edit propagates to device B', p1a2.uploaded === 1 && p1b2.downloaded === 1 && (await fsp.readFile(path.join(P1_B, 'other.txt'), 'utf-8')) === 'p1-other-v2', `${JSON.stringify(p1a2)} ${JSON.stringify(p1b2)}`)
  await switchDevice(P1_S)
  await fsp.unlink(path.join(P1_A, 'race-midair.txt'))
  const p1a3 = await syncP(P1_A, '/px1')
  await switchDevice(P1_SB)
  const p1b3 = await syncP(P1_B, '/px1')
  check('P1 A delete propagates to B (conditional DELETE)', p1a3.deleted === 1 && p1b3.deleted === 1 && !fs.existsSync(path.join(P1_B, 'race-midair.txt')), `${JSON.stringify(p1a3)} ${JSON.stringify(p1b3)}`)
  await switchDevice(P1_S)
  const p1conv = await syncP(P1_A, '/px1')
  await switchDevice(P1_SB)
  const p1convB = await syncP(P1_B, '/px1')
  check('P1 multi-device convergence without ping-pong', isNoop(p1conv) && isNoop(p1convB), `${JSON.stringify(p1conv)} ${JSON.stringify(p1convB)}`)

  })

  // ---------- P2 nginx 风格（无 etag + 静默忽略条件头 + mtime 秒级）----------
  await slowSection('P2：nginx 风格档', 'B 档深水区；p2 档真同步仍由 BV2 覆盖、B 档分类由 W5 覆盖', async () => {
  await setProfile('p2')
  await fsp.rm(path.join(ROOT, 'px2'), { recursive: true, force: true }).catch(() => {})
  const P2_S = await freshStore('p2a')
  const P2_A = await tmpLocal('p2a')
  const p2caps = await services.dav.probeCapabilities(cfg, true)
  check(
    'P2 probe classifies tier B (no etag, conditionals ignored, second-level mtime)',
    p2caps.tier === 'B' && p2caps.etag.present === false && p2caps.conditional.ifMatch === false && p2caps.conditional.ifNoneMatch === false && p2caps.mtimePrecision === 's' && p2caps.writable === true,
    JSON.stringify(p2caps)
  )
  await fsp.writeFile(path.join(P2_A, 'race-midair.txt'), 'p2-v1')
  await fsp.writeFile(path.join(P2_A, 'a.txt'), 'p2-content')
  const p2s1 = await syncP(P2_A, '/px2')
  check('P2 first sync uploads with B-tier warning', p2s1.uploaded === 2 && p2s1.tier === 'B' && p2s1.warnings.some((w) => /多设备并发安全/.test(w)), JSON.stringify(p2s1.warnings))
  const p2s1b = await syncP(P2_A, '/px2')
  check('P2 second-level mtime does not cause ping-pong', isNoop(p2s1b), JSON.stringify(p2s1b))
  // B 档复查拦截：midair 钩子（propfind 触发点）在复查 PROPFIND 时改写远端内容 → 复查发现不符
  await fsp.writeFile(path.join(P2_A, 'race-midair.txt'), 'p2-v2-local-longer')
  await setMidair('propfind')
  let p2midErr = null
  try {
    await syncP(P2_A, '/px2')
  } catch (e) {
    p2midErr = e
  }
  await setMidair(null)
  check('P2 midair overwrite abandoned by pre-PUT recheck', !!p2midErr && /复查发现远端已变化|跳过/.test(p2midErr.message), p2midErr && p2midErr.message)
  check('P2 midair: remote holds peer version (local edit not uploaded)', (await fsp.readFile(path.join(ROOT, 'px2', 'race-midair.txt'), 'utf-8')).startsWith('MIDAIR-PEER-EDIT-'))
  const p2s2 = await syncP(P2_A, '/px2', { ...SP, conflictStrategy: 'local' })
  check('P2 converges via conflict resolution after recheck abort', p2s2.conflicts === 1 && p2s2.uploaded === 1, JSON.stringify(p2s2))
  const p2settle = await settleStable(P2_A, '/px2')
  check('P2 settles to no-op', p2settle.ok, `rounds=${p2settle.rounds}`)
  // 多设备基础交替
  const P2_SB = await freshStore('p2b')
  const P2_B = await tmpLocal('p2b')
  await switchDevice(P2_SB)
  const p2b1 = await syncP(P2_B, '/px2')
  check('P2 device B downloads all', p2b1.downloaded === 2, JSON.stringify(p2b1))
  await switchDevice(P2_S)
  await fsp.writeFile(path.join(P2_A, 'a.txt'), 'p2-content-v2')
  const p2a2 = await syncP(P2_A, '/px2')
  await switchDevice(P2_SB)
  const p2b2 = await syncP(P2_B, '/px2')
  check('P2 A edit propagates to B', p2a2.uploaded === 1 && p2b2.downloaded === 1 && (await fsp.readFile(path.join(P2_B, 'a.txt'), 'utf-8')) === 'p2-content-v2', `${JSON.stringify(p2a2)} ${JSON.stringify(p2b2)}`)
  const p2convB = await syncP(P2_B, '/px2')
  check('P2 device B settles (second-level mtime aligned)', isNoop(p2convB), JSON.stringify(p2convB))

  })

  // ---------- P3 弱 etag + 条件请求生效 ----------
  await section('P3：弱 etag 档', async () => {
  await setProfile('p3')
  await fsp.rm(path.join(ROOT, 'px3'), { recursive: true, force: true }).catch(() => {})
  const P3_S = await freshStore('p3')
  const P3_A = await tmpLocal('p3')
  const p3caps = await services.dav.probeCapabilities(cfg, true)
  check(
    'P3 probe classifies tier B (weak etag served, conditionals honored)',
    p3caps.tier === 'B' && p3caps.etag.present === true && p3caps.etag.weak === true && p3caps.conditional.ifMatch === true && p3caps.conditional.ifNoneMatch === true,
    JSON.stringify(p3caps)
  )
  await fsp.writeFile(path.join(P3_A, 'a.txt'), 'p3-v1')
  await fsp.writeFile(path.join(P3_A, 'b.txt'), 'p3-v2')
  const p3s1 = await syncP(P3_A, '/px3')
  check('P3 first sync uploads', p3s1.uploaded === 2 && p3s1.tier === 'B', JSON.stringify(p3s1))
  // 弱 etag 绝不用于 If-Match 的行为证明：p3 服务器对任何 If-Match 一律 412 ——
  // 若引擎误发 If-Match，这次普通覆盖轮必失败；成功即证明未发送（走 B 档复查）
  await fsp.writeFile(path.join(P3_A, 'a.txt'), 'p3-v1-overwritten-longer')
  const p3s2 = await syncP(P3_A, '/px3')
  check('P3 overwrite succeeds without ever sending If-Match (weak etag never used)', p3s2.uploaded === 1 && (await fsp.readFile(path.join(ROOT, 'px3', 'a.txt'), 'utf-8')) === 'p3-v1-overwritten-longer', JSON.stringify(p3s2))
  const p3settle = await settleStable(P3_A, '/px3')
  check('P3 settles to no-op', p3settle.ok, `rounds=${p3settle.rounds}`)

  })

  // ---------- P4 集合无尾斜杠 301（重定向）----------
  await section('P4：重定向档', async () => {
  await setProfile('p4')
  await fsp.rm(path.join(ROOT, 'px4'), { recursive: true, force: true }).catch(() => {})
  await fsp.mkdir(path.join(ROOT, 'px4', 'sub'), { recursive: true })
  await fsp.writeFile(path.join(ROOT, 'px4', 'sub', 'f.txt'), 'p4-content')
  const P4_S = await freshStore('p4')
  const p4caps = await services.dav.probeCapabilities(cfg, true)
  check('P4 probe observes collection redirect and classifies tier A', p4caps.collectionRedirect === true && p4caps.tier === 'A', JSON.stringify(p4caps))
  const P4_A = await tmpLocal('p4')
  const p4s1 = await syncP(P4_A, '/px4')
  check('P4 full sync works under redirecting server', p4s1.downloaded === 1 && (await fsp.readFile(path.join(P4_A, 'sub', 'f.txt'), 'utf-8')) === 'p4-content', JSON.stringify(p4s1))
  const p4settle = await settleStable(P4_A, '/px4')
  check('P4 settles to no-op', p4settle.ok, `rounds=${p4settle.rounds}`)

  })

  // ---------- P5 限流 429 + Retry-After ----------
  await slowSection('P5：限流档', '探测期 3×Retry-After=1s 真实等待；429 重试语义仍由 RL 覆盖', async () => {
  await setProfile('p5')
  await fsp.rm(path.join(ROOT, 'px5'), { recursive: true, force: true }).catch(() => {})
  const P5_S = await freshStore('p5')
  const P5_A = await tmpLocal('p5')
  const p5t0 = Date.now()
  const p5caps = await services.dav.probeCapabilities(cfg, true)
  const p5probeMs = Date.now() - p5t0
  check('P5 probe survives rate limiting and still classifies tier A', p5caps.tier === 'A' && p5caps.conditional.ifMatch === true, JSON.stringify(p5caps.notes))
  check('P5 probe respected Retry-After waits', p5probeMs >= 2900 && p5probeMs < 20000, `${p5probeMs}ms`)
  await fsp.writeFile(path.join(P5_A, 'a.txt'), 'p5-content')
  const p5s1 = await syncP(P5_A, '/px5')
  check('P5 sync round completes after probe exhausted the limit budget', p5s1.uploaded === 1 && (await fsp.readFile(path.join(ROOT, 'px5', 'a.txt'), 'utf-8')) === 'p5-content', JSON.stringify(p5s1))

  })

  // ---------- P6 上传后异步改写 mtime/etag（指纹扰动收敛）----------
  await slowSection('P6：异步指纹扰动档', '指纹扰动多轮 settleStable 收敛马拉松；指纹噪声收敛仍由 N3 覆盖', async () => {
  await setProfile('p6')
  await fsp.rm(path.join(ROOT, 'px6'), { recursive: true, force: true }).catch(() => {})
  const P6_S = await freshStore('p6')
  const P6_A = await tmpLocal('p6')
  const p6caps = await services.dav.probeCapabilities(cfg, true)
  check('P6 probe classifies tier A with unstable etag (mtime in etag)', p6caps.tier === 'A' && p6caps.etag.stable === false && p6caps.etag.present === true, JSON.stringify(p6caps))
  let p6conflicts = 0
  const p6sync = async () => {
    const s = await syncP(P6_A, '/px6')
    p6conflicts += s.conflicts
    return s
  }
  await fsp.writeFile(path.join(P6_A, 'a.txt'), 'p6-content-a')
  await fsp.writeFile(path.join(P6_A, 'b.txt'), 'p6-content-b')
  const p6s2 = await p6sync()
  check('P6 uploads succeed under post-PUT fingerprint churn', p6s2.uploaded === 2, JSON.stringify(p6s2))
  const p6settle1 = await settleStable(P6_A, '/px6')
  check('P6 no infinite re-transfer after initial uploads', p6settle1.ok, `rounds=${p6settle1.rounds}`)
  await fsp.writeFile(path.join(P6_A, 'a.txt'), 'p6-content-a-v2-longer')
  const p6s3 = await p6sync()
  check('P6 edit uploads normally', p6s3.uploaded === 1, JSON.stringify(p6s3))
  const p6settle2 = await settleStable(P6_A, '/px6')
  check('P6 no infinite re-transfer after edit', p6settle2.ok, `rounds=${p6settle2.rounds}`)
  check('P6 fingerprint churn never produces conflicts', p6conflicts === 0, `conflicts=${p6conflicts}`)

  })

  // ---------- P7 静默忽略条件头（conditional=false → B 档）----------
  await slowSection('P7：静默忽略条件头档', 'B 档（忽略条件头）深水区；p7 复查放弃路径仍由 PC4 覆盖', async () => {
  await setProfile('p7')
  await fsp.rm(path.join(ROOT, 'px7'), { recursive: true, force: true }).catch(() => {})
  const P7_S = await freshStore('p7a')
  const P7_A = await tmpLocal('p7a')
  const p7caps = await services.dav.probeCapabilities(cfg, true)
  check(
    'P7 probe detects silently ignored conditionals and classifies tier B',
    p7caps.tier === 'B' && p7caps.conditional.ifMatch === false && p7caps.conditional.ifNoneMatch === false && p7caps.etag.present === true && p7caps.writable === true,
    JSON.stringify(p7caps)
  )
  await fsp.writeFile(path.join(P7_A, 'race-midair.txt'), 'p7-v1')
  await fsp.writeFile(path.join(P7_A, 'a.txt'), 'p7-content')
  const p7s1 = await syncP(P7_A, '/px7')
  check('P7 first sync uploads with concurrency warning', p7s1.uploaded === 2 && p7s1.warnings.some((w) => /多设备并发安全/.test(w)), JSON.stringify(p7s1.warnings))
  // 已知边界（记录在案）：复查（Depth:0 PROPFIND）通过后、PUT 落地前，钩子把远端改写为
  // 对端版本；P7 忽略条件头 → PUT 照常覆盖，对端修改丢失（last-writer-wins）
  await fsp.writeFile(path.join(P7_A, 'race-midair.txt'), 'p7-v2-local-longer')
  await setMidair('put')
  const p7s2 = await syncP(P7_A, '/px7')
  await setMidair(null)
  check(
    'P7 midair overwrite succeeds (known boundary: peer edit silently lost)',
    p7s2.uploaded === 1 && (await fsp.readFile(path.join(ROOT, 'px7', 'race-midair.txt'), 'utf-8')) === 'p7-v2-local-longer',
    JSON.stringify(p7s2)
  )
  const p7settle = await settleStable(P7_A, '/px7')
  check('P7 settles to no-op (no infinite loop despite ignored conditionals)', p7settle.ok, `rounds=${p7settle.rounds}`)
  // 多设备基础交替
  const P7_SB = await freshStore('p7b')
  const P7_B = await tmpLocal('p7b')
  await switchDevice(P7_SB)
  const p7b1 = await syncP(P7_B, '/px7')
  check('P7 device B downloads all', p7b1.downloaded === 2, JSON.stringify(p7b1))
  await switchDevice(P7_S)
  await fsp.writeFile(path.join(P7_A, 'a.txt'), 'p7-content-v2')
  const p7a2 = await syncP(P7_A, '/px7')
  await switchDevice(P7_SB)
  const p7b2 = await syncP(P7_B, '/px7')
  check('P7 A edit propagates to B', p7a2.uploaded === 1 && p7b2.downloaded === 1 && (await fsp.readFile(path.join(P7_B, 'a.txt'), 'utf-8')) === 'p7-content-v2', `${JSON.stringify(p7a2)} ${JSON.stringify(p7b2)}`)

  })

  // ---------- P8 只读（403）→ C 档 download-only ----------
  await section('P8：只读档', async () => {
  await setProfile('p8')
  await fsp.rm(path.join(ROOT, 'px8'), { recursive: true, force: true }).catch(() => {})
  await fsp.mkdir(path.join(ROOT, 'px8'), { recursive: true })
  await fsp.writeFile(path.join(ROOT, 'px8', 'r1.txt'), 'p8-remote-1')
  await fsp.writeFile(path.join(ROOT, 'px8', 'r2.txt'), 'p8-remote-2')
  const P8_S = await freshStore('p8a')
  const p8caps = await services.dav.probeCapabilities(cfg, true)
  check('P8 probe classifies tier C (write rejected)', p8caps.tier === 'C' && p8caps.writable === false && p8caps.notes.some((n) => /探测|HTTP 403/.test(n)), JSON.stringify(p8caps.notes))
  const P8_A = await tmpLocal('p8a')
  await fsp.writeFile(path.join(P8_A, 'new-local.txt'), 'p8-local-only')
  const p8s1 = await syncP(P8_A, '/px8')
  check(
    'P8 read-only round downloads only, uploads skipped, round does not fail',
    p8s1.downloaded === 2 && p8s1.uploaded === 0 && p8s1.warnings.some((w) => /只读/.test(w)) && p8s1.errors.length === 0,
    JSON.stringify(p8s1)
  )
  check('P8 local-only file not uploaded', !fs.existsSync(path.join(ROOT, 'px8', 'new-local.txt')))
  // 远端被外部删除 → delete-local 计划被 C 档跳过：本地数据不丢
  await fsp.rm(path.join(ROOT, 'px8', 'r2.txt'))
  const p8s2 = await syncP(P8_A, '/px8')
  check(
    'P8 delete-local skipped to preserve local data, round still succeeds',
    p8s2.deleted === 0 && p8s2.errors.length === 0 && fs.existsSync(path.join(P8_A, 'r2.txt')) && fs.existsSync(path.join(ROOT, 'px8', 'r1.txt')),
    JSON.stringify(p8s2.warnings)
  )
  // 多设备：B 下载；B 本地编辑不被上传（远端只读），远端内容不变
  const P8_SB = await freshStore('p8b')
  const P8_B = await tmpLocal('p8b')
  await switchDevice(P8_SB)
  const p8b1 = await syncP(P8_B, '/px8')
  check('P8 device B downloads read-only content', p8b1.downloaded === 1 && (await fsp.readFile(path.join(P8_B, 'r1.txt'), 'utf-8')) === 'p8-remote-1', JSON.stringify(p8b1))
  await fsp.writeFile(path.join(P8_B, 'r1.txt'), 'p8-B-local-edit')
  const p8b2 = await syncP(P8_B, '/px8')
  check('P8 device B local edit never uploaded (C tier)', p8b2.uploaded === 0 && (await fsp.readFile(path.join(ROOT, 'px8', 'r1.txt'), 'utf-8')) === 'p8-remote-1', JSON.stringify(p8b2))

  })

  // ---------- P9 Depth infinity 可用 ----------
  await section('P9：Depth infinity 档', async () => {
  await setProfile('p9')
  await fsp.rm(path.join(ROOT, 'px9'), { recursive: true, force: true }).catch(() => {})
  await fsp.mkdir(path.join(ROOT, 'px9', 'deep', 'deeper'), { recursive: true })
  await fsp.writeFile(path.join(ROOT, 'px9', 'top.txt'), 'p9-top')
  await fsp.writeFile(path.join(ROOT, 'px9', 'deep', 'deeper', 'leaf.txt'), 'p9-leaf')
  const P9_S = await freshStore('p9')
  const p9caps = await services.dav.probeCapabilities(cfg, true)
  check('P9 probe detects Depth infinity support (nested-entry verified) and classifies tier A', p9caps.depthInfinity === true && p9caps.tier === 'A', JSON.stringify(p9caps))
  const P9_A = await tmpLocal('p9')
  const p9s1 = await syncP(P9_A, '/px9')
  check('P9 sync works normally (single-request infinity scan since stage 7)', p9s1.downloaded === 2 && (await fsp.readFile(path.join(P9_A, 'deep', 'deeper', 'leaf.txt'), 'utf-8')) === 'p9-leaf', JSON.stringify(p9s1))
  const p9settle = await settleStable(P9_A, '/px9')
  check('P9 settles to no-op', p9settle.ok, `rounds=${p9settle.rounds}`)
  await setProfile(null)
  })

  // ============================================================
  // XS 系列：saxes 解析器直检 —— 前缀变体 / 实体解码 /
  // 流式块边界 / 畸形必抛 / first-match / 坏百分号序列保底
  // ============================================================
  await section('XS：saxes 解析器直检', async () => {
    const P = services.sync._internals
    // p 为命名空间前缀（含冒号）：'D:' / 'd:' / ''（默认命名空间）
    const mkEntry = (p, name, size) =>
      `<${p}response><${p}href>/dav/d/${encodeURIComponent(name)}</${p}href><${p}propstat><${p}prop>` +
      `<${p}resourcetype/><${p}getcontentlength>${size}</${p}getcontentlength>` +
      `<${p}getetag>&#x22;h&#x65;x&#x22;</${p}getetag>` +
      `</${p}prop></${p}propstat></${p}response>`
    const docOf = (p) =>
      `<?xml version="1.0"?><${p}multistatus ${p ? `xmlns:${p.slice(0, -1)}="DAV:"` : 'xmlns="DAV:"'}>` +
      `${mkEntry(p, '中 文.txt', 3)}${mkEntry(p, 'a&b.txt', 5)}</${p}multistatus>`
    const expectHrefs = ['/dav/d/中 文.txt', '/dav/d/a&b.txt']
    for (const p of ['D:', 'd:', '']) {
      const parsed = P.parseMultistatus(docOf(p))
      check(
        `XS prefix '${p || 'none'}' parses hrefs, entities and hex entities`,
        parsed.length === 2 && parsed[0].href === expectHrefs[0] && parsed[1].href === expectHrefs[1] && parsed[0].etag === '"hex"' && parsed[0].size === 3,
        JSON.stringify(parsed)
      )
    }
    // 流式：7 字节小块喂 Buffer —— 多字节中文名必然被块边界拆断，StringDecoder 必须缝好
    const stream = P.createMultistatusStream()
    const buf = Buffer.from(docOf('D:'), 'utf-8')
    for (let i = 0; i < buf.length; i += 7) stream.write(buf.subarray(i, Math.min(i + 7, buf.length)))
    stream.close()
    const chunked = stream.entries()
    check('XS chunked stream equals whole-string parse', JSON.stringify(chunked) === JSON.stringify(P.parseMultistatus(docOf('D:'))), JSON.stringify(chunked))
    // 畸形：截断 / 未闭合必抛（绝不静默返回部分结果）
    let threwTrunc = false
    try {
      P.parseMultistatus(docOf('D:').slice(0, Math.floor(docOf('D:').length * 0.5)))
    } catch (_) {
      threwTrunc = true
    }
    check('XS truncated document throws', threwTrunc)
    let threwUnclosed = false
    try {
      P.parseMultistatus(docOf('D:').replace('</D:multistatus>', ''))
    } catch (_) {
      threwUnclosed = true
    }
    check('XS unclosed document throws', threwUnclosed)
    // first-match：404 propstat 与 200 propstat 并存时，同名 prop 首次出现生效
    const dup =
      '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/a</D:href>' +
      '<D:propstat><D:prop><D:getcontentlength>1</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
      '<D:propstat><D:prop><D:getcontentlength>9</D:getcontentlength></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>' +
      '</D:response></D:multistatus>'
    const dupParsed = P.parseMultistatus(dup)
    check('XS first-match prop wins (404 propstat ignored)', dupParsed.length === 1 && dupParsed[0].size === 1, JSON.stringify(dupParsed))
    // 坏百分号序列（文件名含裸 % 且服务器未编码）：保留原值，不炸整次解析
    const badPct = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/d/100%zz.txt</D:href></D:response></D:multistatus>'
    const badParsed = P.parseMultistatus(badPct)
    check('XS bad percent sequence kept as-is', badParsed.length === 1 && badParsed[0].href === '/dav/d/100%zz.txt', JSON.stringify(badParsed))
  })

  // ============================================================
  // W 系列（核查项的验收用例）
  // ============================================================

  // W1：引擎临时文件不触发 watcher（防自触发同步回路）；真实用户修改仍触发
  await slowSection('W1：引擎临时文件不触发 watcher', 'watcher 防自触发需 2×~2s 真实静置，用例价值密度低', async () => {
    const W1_LOCAL = await tmpLocal('w1')
    let w1fired = 0
    services.fsx.watchDir('w1', W1_LOCAL, () => {
      w1fired++
    })
    // 引擎会在同步目录写的全部临时形态 + 同步系统残留
    for (const n of ['.wdsync-tmp-tol-123-abc', '.wdsync-dl-999-x', '.wdsync-verify-1-y', '.wdsync-probe-zz', '.webdav-sync.json']) {
      await fsp.writeFile(path.join(W1_LOCAL, n), 'x')
    }
    await sleep(2000)
    check('W1 engine temp files do not trigger watcher', w1fired === 0, `fired=${w1fired}`)
    await fsp.writeFile(path.join(W1_LOCAL, 'user-edit.txt'), 'x')
    await sleep(2300)
    check('W1 real user change still triggers watcher', w1fired === 1, `fired=${w1fired}`)
    services.fsx.stopWatch('w1')
    await fsp.rm(W1_LOCAL, { recursive: true, force: true }).catch(() => {})
  })

  // W2：远端残留的另一设备探测目录 / 临时文件不被当成普通文件下载
  //（ignoreHidden=false 下依然排除 —— 排除依据是引擎前缀而非隐藏规则）
  await section('W2：远端残留排除', async () => {
    await fsp.mkdir(path.join(ROOT, 'w2remote', '.wdsync-probe-leftover'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'w2remote', '.wdsync-probe-leftover', 'probe.txt'), 'p')
    await fsp.writeFile(path.join(ROOT, 'w2remote', '.wdsync-tmp-remote-leftover'), 't')
    await fsp.writeFile(path.join(ROOT, 'w2remote', 'real.txt'), 'r')
    const W2_LOCAL = await tmpLocal('w2')
    const w2sum = await syncP(W2_LOCAL, '/w2remote', { ...SP, ignoreHidden: false })
    check(
      'W2 remote probe/tmp leftovers excluded from sync',
      w2sum.downloaded === 1 && fs.existsSync(path.join(W2_LOCAL, 'real.txt')) && !fs.existsSync(path.join(W2_LOCAL, '.wdsync-tmp-remote-leftover')),
      JSON.stringify(w2sum)
    )
    check('W2 leftovers absent from baseline', (await services.sync._internals.baselineSize({ id: 'p', localPath: W2_LOCAL, remotePath: '/w2remote', mode: 'two-way' })) === 1)
    await fsp.rm(W2_LOCAL, { recursive: true, force: true }).catch(() => {})
  })

  // W3：A 档 If-Match 取值来源 —— 覆盖上传时 If-Match === 基线 retag（非冲突
  // 上放下扫描 etag 与基线 etag 按决策定义相等）；首轮 / 无基线新上传走 If-None-Match:*
  await section('W3：A 档条件头取值', async () => {
    const W3_LOCAL = await tmpLocal('w3')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-captheaders'), 'x')
    try {
      const w3dir = { id: 'p', localPath: W3_LOCAL, remotePath: '/w3', mode: 'two-way' }
      await fsp.writeFile(path.join(W3_LOCAL, 'g.txt'), 'g-v1')
      const w3s1 = await syncP(W3_LOCAL, '/w3')
      const w3base = await services.sync._internals.baselineEntry(w3dir, 'g.txt')
      await fsp.writeFile(path.join(W3_LOCAL, 'g.txt'), 'g-v2-longer-content')
      const w3s2 = await syncP(W3_LOCAL, '/w3')
      const log = fs.readFileSync(path.join(ROOT, '.wdsync-test-captheaders.log'), 'utf-8').trim().split('\n')
      const puts = log.filter((l) => l.startsWith('PUT /dav/w3/g.txt'))
      const first = puts[0] || ''
      const overwrite = puts[puts.length - 1] || ''
      check(
        'W3 first upload (no baseline) uses If-None-Match:* only',
        w3s1.uploaded === 1 && first.includes('INM=*') && first.includes('IM=-'),
        log.join(' | ')
      )
      check(
        'W3 overwrite If-Match equals baseline retag (== scan etag by decision definition)',
        w3s2.uploaded === 1 && w3base && w3base.retag && overwrite.includes(`IM=${w3base.retag}`) && overwrite.includes('INM=-'),
        `${overwrite} baseline=${w3base && w3base.retag}`
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-captheaders'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, '.wdsync-test-captheaders.log'), { force: true }).catch(() => {})
    }
    await fsp.rm(W3_LOCAL, { recursive: true, force: true }).catch(() => {})
  })

  // W4：写权限按远端根路径判定 —— 同一 origin+账号下一路径只读（C 档）、
  // 另一路径可写（A 档）；公共能力字段（etag / 条件请求）跨路径共享
  await section('W4：按子路径写权限', async () => {
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-ro-subpaths'), 'shared-ro')
    try {
      await freshStore('w4')
      await fsp.mkdir(path.join(ROOT, 'shared-ro'), { recursive: true })
      const roCaps = await services.dav.probeCapabilities(cfg, true, '/shared-ro')
      check(
        'W4 read-only subpath classifies tier C with reason',
        roCaps.tier === 'C' && roCaps.writable === false && /403/.test(roCaps.writeReason || ''),
        JSON.stringify(roCaps)
      )
      const rwCaps = await services.dav.probeCapabilities(cfg, false, '/ok-write')
      check(
        'W4 writable subpath (same origin+user) classifies tier A with shared common caps',
        rwCaps.tier === 'A' && rwCaps.writable === true && rwCaps.conditional.ifMatch === true && rwCaps.etag.present === true,
        JSON.stringify(rwCaps)
      )
      // 只读子路径上的真实同步：download-only，本地新文件不上传、远端内容不丢
      await fsp.writeFile(path.join(ROOT, 'shared-ro', 'r1.txt'), 'ro-1')
      const W4_LOCAL = await tmpLocal('w4ro')
      await fsp.writeFile(path.join(W4_LOCAL, 'local-only.txt'), 'x')
      const w4sum = await syncP(W4_LOCAL, '/shared-ro')
      check(
        'W4 sync into read-only subpath downloads only',
        w4sum.downloaded === 1 && w4sum.uploaded === 0 && w4sum.errors.length === 0 && w4sum.warnings.some((w) => /只读/.test(w)),
        JSON.stringify(w4sum)
      )
      check('W4 read-only subpath keeps local-only file off remote', !fs.existsSync(path.join(ROOT, 'shared-ro', 'local-only.txt')))
      await fsp.rm(W4_LOCAL, { recursive: true, force: true }).catch(() => {})
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-ro-subpaths'), { force: true }).catch(() => {})
    }
  })

  // W5：MKCOL 非权限性失败（409）不得按 C 档缓存 —— 当轮 B 档保守 + 不落长期缓存，
  // 故障移除后无须 force 即恢复可写
  await section('W5：MKCOL 非权限失败分类', async () => {
    await freshStore('w5')
    await fsp.mkdir(path.join(ROOT, 'mkcolpath'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-mkcolfail'), '409')
    try {
      const w5caps = await services.dav.probeCapabilities(cfg, true, '/mkcolpath')
      check(
        'W5 non-permission MKCOL failure stays tier B (not C) with retry-soon marker',
        w5caps.tier === 'B' && w5caps.writeRetrySoon === true && /409/.test(w5caps.writeReason || '') && !w5caps.degraded,
        JSON.stringify(w5caps)
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-mkcolfail'), { force: true }).catch(() => {})
    }
    const w5caps2 = await services.dav.probeCapabilities(cfg, false, '/mkcolpath')
    check('W5 recovers to writable without force after fault removed', w5caps2.tier === 'A' && w5caps2.writable === true, JSON.stringify(w5caps2))
  })

  // W6：远端同步根目录尚不存在 —— 同步轮先建根（既有行为），探测在新建根上
  // 照常完成（MKCOL 探测目录 / PUT 探测文件都在新根下），首轮上传成功
  await section('W6：远端根缺失自动创建', async () => {
    await freshStore('w6')
    const W6_LOCAL = await tmpLocal('w6')
    await fsp.writeFile(path.join(W6_LOCAL, 'a.txt'), 'w6-a')
    const w6sum = await syncP(W6_LOCAL, '/brand-new-root-xyz')
    check(
      'W6 missing remote root auto-created, probed there, first upload succeeds',
      w6sum.uploaded === 1 && w6sum.tier === 'A' && fs.existsSync(path.join(ROOT, 'brand-new-root-xyz', 'a.txt')),
      JSON.stringify(w6sum)
    )
    await fsp.rm(W6_LOCAL, { recursive: true, force: true }).catch(() => {})
  })

  // W7：持续 503 的服务器 —— 连续失败触发整轮熔断，轮次时长有上界；
  // 故障移除后下一轮自动恢复并完成全部上传
  await section('W7：持续 503 熔断风暴', async () => {
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-err503'), 'x')
    const W7_LOCAL = await tmpLocal('w7')
    try {
      await freshStore('w7')
      for (let i = 0; i < 10; i++) await fsp.writeFile(path.join(W7_LOCAL, `f${i}.txt`), 'x')
      const w7t0 = Date.now()
      let w7err = null
      try {
        await syncP(W7_LOCAL, '/w7')
      } catch (e) {
        w7err = e
      }
      const w7ms = Date.now() - w7t0
      const w7msgs = w7err && w7err.errors ? w7err.errors.join(';') : String(w7err && w7err.message)
      check('W7 persistent 503 trips round breaker with clear message', !!w7err && /熔断|连续失败/.test(w7msgs), w7msgs)
      check('W7 round duration bounded by circuit (not per-file retries)', w7ms < 45000, `${w7ms}ms`)
      // 熔断轮的机器可读字段 —— 调度层据此归因
      //「服务器连续无响应」并计入跨轮退避，不再解析错误文案
      check(
        'W7 err.summary.breaker = { open, consecutive >= threshold, reason }',
        !!w7err && w7err.summary && w7err.summary.breaker && w7err.summary.breaker.open === true && w7err.summary.breaker.consecutive >= 5 && /503/.test(String(w7err.summary.breaker.reason)),
        w7err && JSON.stringify(w7err.summary && w7err.summary.breaker)
      )
      check(
        'W7 err.summary.failureClass = network (all errors network-class)',
        !!w7err && w7err.summary && w7err.summary.failureClass === 'network' && w7err.summary.openIntents === 0,
        w7err && JSON.stringify({ failureClass: w7err.summary && w7err.summary.failureClass, openIntents: w7err.summary && w7err.summary.openIntents })
      )
      const w7remote = await fsp.readdir(path.join(ROOT, 'w7')).catch(() => [])
      check('W7 nothing landed on remote during 503 storm', w7remote.length === 0, JSON.stringify(w7remote))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-err503'), { force: true }).catch(() => {})
    }
    const w7b = await syncP(W7_LOCAL, '/w7')
    check('W7 next round after fault removal completes all uploads', w7b.uploaded === 10 && w7b.errors.length === 0, JSON.stringify(w7b))
    await fsp.rm(W7_LOCAL, { recursive: true, force: true })
  })

  // W8：远端探测残留按龄清理 —— 同步轮扫描后删除陈旧残留（≥10 分钟）、保留新鲜残留
  //（年龄门槛），且新鲜残留绝不进入同步候选（ignoreHidden=false 下依旧排除）
  await section('W8：探测残留按龄清理', async () => {
    await freshStore('w8')
    const W8_LOCAL = await tmpLocal('w8')
    await fsp.writeFile(path.join(W8_LOCAL, 'a.txt'), 'w8-a')
    const w8Stale = path.join(ROOT, 'w8', '.wdsync-probe-stale-xyz')
    const w8Fresh = path.join(ROOT, 'w8', '.wdsync-probe-fresh-xyz')
    await fsp.mkdir(w8Stale, { recursive: true })
    await fsp.writeFile(path.join(w8Stale, 'probe.txt'), 'stale')
    await fsp.mkdir(w8Fresh, { recursive: true })
    await fsp.writeFile(path.join(w8Fresh, 'probe.txt'), 'fresh')
    // utimes 远端根下的真实目录（写完 probe.txt 再拨回，防止子文件创建顶新目录 mtime）
    const w8Old = new Date(Date.now() - 11 * 60 * 1000)
    await fsp.utimes(w8Stale, w8Old, w8Old)
    const w8sum = await syncP(W8_LOCAL, '/w8', { ...SP, ignoreHidden: false })
    check('W8 stale probe residue dir removed after sync round', !fs.existsSync(w8Stale), JSON.stringify(w8sum))
    check('W8 fresh probe residue kept (under min age)', fs.existsSync(w8Fresh) && fs.existsSync(path.join(w8Fresh, 'probe.txt')))
    check(
      'W8 fresh residue never synced as normal file (ignoreHidden=false)',
      w8sum.uploaded === 1 && w8sum.downloaded === 0 && w8sum.totalFiles === 1 && !fs.existsSync(path.join(W8_LOCAL, '.wdsync-probe-fresh-xyz')),
      JSON.stringify(w8sum)
    )
    check(
      'W8 fresh residue absent from baseline',
      (await services.sync._internals.baselineSize({ id: 'p', localPath: W8_LOCAL, remotePath: '/w8', mode: 'two-way' })) === 1
    )
    await fsp.rm(W8_LOCAL, { recursive: true, force: true })
  })

  // W9：多设备视角 —— 清理不区分设备：设备 A 同步过的远端根里的陈旧探测残留，
  // 由设备 B（全新存储根 / 新 deviceId）的同步轮完成清理，且 B 不把残留当普通文件
  await section('W9：多设备残留清理', async () => {
    const W9_SA = await freshStore('w9a')
    const W9_A = await tmpLocal('w9a')
    await fsp.writeFile(path.join(W9_A, 'shared.txt'), 'w9-a')
    const w9a1 = await syncP(W9_A, '/w9')
    check('W9 device A first sync uploads', w9a1.uploaded === 1, JSON.stringify(w9a1))
    // 模拟设备 A 的探测崩溃残留（目录 mtime 拨到 12 分钟前）
    const w9Stale = path.join(ROOT, 'w9', '.wdsync-probe-crash-abc')
    await fsp.mkdir(w9Stale, { recursive: true })
    await fsp.writeFile(path.join(w9Stale, 'probe.txt'), 'x')
    const w9Old = new Date(Date.now() - 12 * 60 * 1000)
    await fsp.utimes(w9Stale, w9Old, w9Old)
    await freshStore('w9b') // 设备 B：全新存储根（新 deviceId / 新能力缓存 / 新基线）
    const W9_B = await tmpLocal('w9b')
    const w9b = await syncP(W9_B, '/w9', { ...SP, ignoreHidden: false })
    check("W9 device B round cleans other device's stale probe residue", !fs.existsSync(w9Stale), JSON.stringify(w9b))
    check(
      'W9 residue not counted as normal file by device B',
      w9b.downloaded === 1 && fs.existsSync(path.join(W9_B, 'shared.txt')) && !fs.existsSync(path.join(W9_B, '.wdsync-probe-crash-abc')),
      JSON.stringify(w9b)
    )
    check(
      'W9 device B baseline holds only the real file',
      (await services.sync._internals.baselineSize({ id: 'p', localPath: W9_B, remotePath: '/w9', mode: 'two-way' })) === 1
    )
    await fsp.rm(W9_A, { recursive: true, force: true })
    await fsp.rm(W9_B, { recursive: true, force: true })
  })

  // ============================================================
  // PF 系列：永久失败分类 + 指数退避重试 + 瞬时失败当轮重试
  // ============================================================

  // PF0 分类规则直检：permanent / transient / normal 三分类的关键边界
  await section('PF0：失败分类直检', async () => {
    const C = services.sync._internals.classifyOpFailure
    check(
      'PF0 classifyOpFailure permanent set (413/507/403/405, EACCES/EPERM, BAD_FILENAME)',
      C({ status: 413 }) === 'permanent' &&
        C({ status: 507 }) === 'permanent' &&
        C({ status: 403 }) === 'permanent' &&
        C({ status: 405 }) === 'permanent' &&
        C({ code: 'EACCES' }) === 'permanent' &&
        C({ code: 'EPERM' }) === 'permanent' &&
        C({ code: 'BAD_FILENAME' }) === 'permanent'
    )
    check(
      'PF0 classifyOpFailure 401 stays normal (config-level, must fail the round loudly)',
      C({ status: 401 }) === 'normal' && C({ code: 'AUTH', status: 401 }) === 'normal'
    )
    check(
      'PF0 classifyOpFailure transient set (423 / NETWORK / LOCAL_IO+EBUSY)',
      C({ status: 423 }) === 'transient' &&
        C({ code: 'NETWORK', status: 0 }) === 'transient' &&
        C({ code: 'LOCAL_IO', message: '写入本地文件失败 x.txt：EBUSY' }) === 'transient'
    )
    check(
      'PF0 classifyOpFailure protective errors stay normal (REMOTE_CHANGED / 412 / CIRCUIT_OPEN / 5xx)',
      C({ code: 'REMOTE_CHANGED', permanent: true }) === 'normal' &&
        C({ status: 412, code: 'PRECONDITION', permanent: true }) === 'normal' &&
        C({ code: 'CIRCUIT_OPEN', permanent: true }) === 'normal' &&
        C({ status: 500 }) === 'normal' &&
        C(null) === 'normal'
    )
  })

  // PF1（413 永久失败退避）：第一轮轮次报错、其余文件成功、failures 记 count=1；
  // 第二轮退避未到期 → 跳过重试（count 不变）且轮次成功带「跳过」warning；
  // ageFailures 推进时间 → 第三轮重试仍 413（count=2、退避翻倍）；再推进并移除故障 →
  // 第四轮成功且失败记录清空（PF3 一并断言）
  await section('PF1：413 永久失败退避', async () => {
    await freshStore('pf1')
    const PF1_LOCAL = await tmpLocal('pf1')
    for (const n of ['p1.txt', 'p2.txt', 'p3.txt']) await fsp.writeFile(path.join(PF1_LOCAL, n), `pf1-${n}`)
    await fsp.writeFile(path.join(PF1_LOCAL, 'bad.toolarge.txt'), 'pf1-too-large')
    const pf1dir = { id: 'pf1', localPath: PF1_LOCAL, remotePath: '/pf1', mode: 'two-way' }
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-fail413'), 'x')
    try {
      let pf1e1 = null
      try {
        await syncP(PF1_LOCAL, '/pf1')
      } catch (e) {
        pf1e1 = e
      }
      check(
        'PF1 round 1 fails on 413 while other files upload',
        !!pf1e1 && /413/.test(pf1e1.message) && pf1e1.summary && pf1e1.summary.uploaded === 3,
        pf1e1 && pf1e1.message
      )
      check('PF1 too-large file never lands on remote', !fs.existsSync(path.join(ROOT, 'pf1', 'bad.toolarge.txt')))
      const f1 = (await services.sync._internals.getFailures(pf1dir))['bad.toolarge.txt']
      check(
        'PF1 failure recorded with count=1 and ~15min backoff',
        !!f1 && f1.count === 1 && /413/.test(f1.message) && f1.retryAtMs > Date.now() + 14 * 60 * 1000 && f1.retryAtMs <= Date.now() + 16 * 60 * 1000,
        JSON.stringify(f1)
      )
      // 第二轮：退避未到期 → 规划层不生成传输任务（count 保持 1 证明未重试），轮次成功
      const pf1s2 = await syncP(PF1_LOCAL, '/pf1')
      check(
        'PF1 round 2 skips backed-off file, round succeeds with skip warning',
        pf1s2.errors.length === 0 &&
          pf1s2.uploaded === 0 &&
          pf1s2.warnings.some((w) => /跳过 1 个持续失败/.test(w) && /bad\.toolarge\.txt/.test(w) && /下次重试/.test(w)),
        JSON.stringify(pf1s2.warnings)
      )
      const f2 = (await services.sync._internals.getFailures(pf1dir))['bad.toolarge.txt']
      check('PF1 round 2 did not retry the file (count stays 1)', !!f2 && f2.count === 1, JSON.stringify(f2))
      // 推进退避时间 → 第三轮重试，仍 413 → count=2、退避翻倍（约 30 分钟）
      await services.sync._internals.ageFailures(pf1dir, 16 * 60 * 1000)
      let pf1e3 = null
      try {
        await syncP(PF1_LOCAL, '/pf1')
      } catch (e) {
        pf1e3 = e
      }
      const f3 = (await services.sync._internals.getFailures(pf1dir))['bad.toolarge.txt']
      check(
        'PF1 round 3 retries after backoff expiry and re-fails with doubled backoff',
        !!pf1e3 && /413/.test(pf1e3.message) && !!f3 && f3.count === 2 && f3.retryAtMs > Date.now() + 29 * 60 * 1000 && f3.retryAtMs <= Date.now() + 31 * 60 * 1000,
        JSON.stringify(f3)
      )
      await services.sync._internals.ageFailures(pf1dir, 31 * 60 * 1000)
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-fail413'), { force: true }).catch(() => {})
    }
    const pf1s4 = await syncP(PF1_LOCAL, '/pf1')
    check(
      'PF1 round 4 uploads after fault removal and backoff expiry',
      pf1s4.uploaded === 1 && pf1s4.errors.length === 0 && (await fsp.readFile(path.join(ROOT, 'pf1', 'bad.toolarge.txt'), 'utf-8')) === 'pf1-too-large',
      JSON.stringify(pf1s4)
    )
    // PF3：传输成功清除失败记录（failures 清空）
    const pf1f4 = await services.sync._internals.getFailures(pf1dir)
    check('PF3 success clears failure records', Object.keys(pf1f4).length === 0, JSON.stringify(pf1f4))
    const pf1s5 = await syncP(PF1_LOCAL, '/pf1')
    check('PF1 follow-up round is a no-op', isNoop(pf1s5), JSON.stringify(pf1s5))
    await fsp.rm(PF1_LOCAL, { recursive: true, force: true }).catch(() => {})
  })

  // PF2（423 瞬时失败当轮重试）：每个 PUT 路径第一次返回 423（无 Retry-After）之后放行 ——
  // 一轮内全部上传成功（errors=0），证明瞬时失败不使轮次失败、重试后当轮收敛；
  // 且瞬时失败不写入退避表（与永久失败的关键区别）
  await section('PF2：423 瞬时失败当轮重试', async () => {
    await freshStore('pf2')
    const PF2_LOCAL = await tmpLocal('pf2')
    await fsp.writeFile(path.join(PF2_LOCAL, 'a.txt'), 'pf2-a')
    await fsp.writeFile(path.join(PF2_LOCAL, 'b.txt'), 'pf2-b')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-fail423'), 'x')
    try {
      const pf2s = await syncP(PF2_LOCAL, '/pf2')
      check(
        'PF2 transient 423 converges within the round (uploaded=2, errors=0)',
        pf2s.uploaded === 2 && pf2s.errors.length === 0 && (await fsp.readFile(path.join(ROOT, 'pf2', 'a.txt'), 'utf-8')) === 'pf2-a',
        JSON.stringify(pf2s)
      )
      const pf2f = await services.sync._internals.getFailures({ id: 'pf2', localPath: PF2_LOCAL, remotePath: '/pf2', mode: 'two-way' })
      check('PF2 transient failures never enter the backoff table', Object.keys(pf2f).length === 0, JSON.stringify(pf2f))
      const pf2s2 = await syncP(PF2_LOCAL, '/pf2')
      check('PF2 follow-up round is a no-op', isNoop(pf2s2), JSON.stringify(pf2s2))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-fail423'), { force: true }).catch(() => {})
    }
    await fsp.rm(PF2_LOCAL, { recursive: true, force: true }).catch(() => {})
  })

  // ============================================================
  // BV 系列：上传后校验改为按目录批量（两段提交）
  // 依赖 dav-server 的 .wdsync-test-reqlog（逐请求日志）与 .wdsync-test-vanish
  //（PROPFIND 列表剔除条目）两个标记。
  // ============================================================
  const REQLOG = path.join(ROOT, '.wdsync-test-reqlog.log')
  /** 读请求日志为行数组（元素形如 'METHOD /dav/path'）；无日志返回空数组 */
  const readReqlog = async () =>
    (await fsp.readFile(REQLOG, 'utf-8').catch(() => '')).split('\n').filter(Boolean)
  /** 某路径（忽略尾斜杠差异）的指定方法请求数 */
  const countReq = (lines, method, p) =>
    lines.filter((l) => l.startsWith(`${method} `) && l.slice(method.length + 1).replace(/\/+$/, '') === p.replace(/\/+$/, '')).length
  /** 某路径指定方法请求的最后行号（-1 表示无）；用于「以该文件最后一次 PUT 为界」的断言 */
  const lastReqLine = (lines, method, p) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith(`${method} `) && lines[i].slice(method.length + 1).replace(/\/+$/, '') === p.replace(/\/+$/, '')) return i
    }
    return -1
  }

  // BV1（P1 档）：一个目录的上传全部完成后按父目录批量校验 —— 不再逐文件 PROPFIND。
  // 场景：根 3 文件 + sub/ 2 文件 + sub2/ 1 文件。reqlog 断言：
  //   核心 —— 对 6 个文件路径的 PROPFIND 为 0（旧实现每文件一次 Depth:0 校验）；
  //   辅助 —— 首个 PUT 之后的父目录 PROPFIND 恰为 3 个目录各 1 次（扫描与能力探测的
  //   列举都发生在上传开始之前，上传开始后只剩批量校验的 3 次）。
  await section('BV1：批量上传校验（P1 档）', async () => {
    await freshStore('bv1')
    const BV1_LOCAL = await tmpLocal('bv1')
    const bv1files = ['a.txt', 'b.txt', 'c.txt', 'sub/d.txt', 'sub/e.txt', 'sub2/f.txt']
    for (const n of bv1files) {
      await fsp.mkdir(path.dirname(path.join(BV1_LOCAL, n)), { recursive: true })
      await fsp.writeFile(path.join(BV1_LOCAL, n), `bv1-${n}`)
    }
    const bv1dir = { id: 'p', localPath: BV1_LOCAL, remotePath: '/bv1', mode: 'two-way' }
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      const bv1s1 = await syncP(BV1_LOCAL, '/bv1')
      check('BV1 first round uploads 6 files', bv1s1.uploaded === 6 && bv1s1.errors.length === 0, JSON.stringify(bv1s1))
      const lines = await readReqlog()
      const filePaths = bv1files.map((n) => `/dav/bv1/${n}`)
      check(
        'BV1 zero PROPFIND to any uploaded file path (per-file verify removed)',
        filePaths.every((p) => countReq(lines, 'PROPFIND', p) === 0),
        filePaths.map((p) => `${p}:${countReq(lines, 'PROPFIND', p)}`).join(' ')
      )
      // 租约锁（6.4）默认开启：锁 PUT（/dav/bv1/.webdav-sync.lock）不属于用户上传，
      // 「上传开始」的分界取首个用户文件 PUT。能力探测与扫描并发（冷缓存轮
      // 在本轮内探测），探测自身的 PUT（.wdsync-probe-* 路径）同样不是用户上传，
      // 一并排除在分界之外（探测对 /dav/bv1 的两次列举都在探测 PUT 之前，不会落入
      // afterPut 观察窗）
      const firstPut = lines.findIndex((l) => l.startsWith('PUT /dav/bv1/') && !l.includes('.webdav-sync.lock') && !l.includes('.wdsync-probe-'))
      const afterPut = lines.slice(firstPut + 1)
      const dirPaths = ['/dav/bv1', '/dav/bv1/sub', '/dav/bv1/sub2']
      check(
        'BV1 exactly one batch PROPFIND per parent dir after uploads start',
        firstPut >= 0 && dirPaths.every((p) => countReq(afterPut, 'PROPFIND', p) === 1),
        dirPaths.map((p) => `${p}:${countReq(afterPut, 'PROPFIND', p)}`).join(' ')
      )
      const bv1size = await services.sync._internals.baselineSize(bv1dir)
      const retagsOk = []
      for (const n of bv1files) {
        const e = await services.sync._internals.baselineEntry(bv1dir, n)
        retagsOk.push(e != null && e.lhash != null && typeof e.rsize === 'number' && e.rsize > 0 && e.retag !== '')
      }
      check('BV1 baseline holds 6 entries with remote fingerprint (retag non-empty)', bv1size === 6 && retagsOk.every(Boolean), `size=${bv1size}`)
      const bv1s2 = await syncP(BV1_LOCAL, '/bv1')
      check('BV1 second round is a no-op', isNoop(bv1s2), JSON.stringify(bv1s2))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
    }
    await fsp.rm(BV1_LOCAL, { recursive: true, force: true })
  })

  // BV2（P2 档，B 档覆盖）：新上传与覆盖上传均无「上传后」的文件 PROPFIND。B 档复查是
  // 上传**前**的 Depth:0 档位保护（允许存在）：以每个文件最后一次 PUT 为界，其后不得
  // 再有针对该文件的 PROPFIND；且整个两轮里每文件恰 1 次文件 PROPFIND（首轮新上传 0 +
  // 次轮覆盖复查 1；旧实现覆盖轮是复查 + 校验共 2 次）。
  await section('BV2：批量校验 B 档覆盖（P2 档）', async () => {
    await setProfile('p2')
    await freshStore('bv2')
    const BV2_LOCAL = await tmpLocal('bv2')
    await fsp.writeFile(path.join(BV2_LOCAL, 'x.txt'), 'bv2-x-v1')
    await fsp.writeFile(path.join(BV2_LOCAL, 'y.txt'), 'bv2-y-v1')
    const bv2dir = { id: 'p', localPath: BV2_LOCAL, remotePath: '/bv2', mode: 'two-way' }
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      const bv2s1 = await syncP(BV2_LOCAL, '/bv2')
      check('BV2 (p2/B tier) first upload succeeds', bv2s1.uploaded === 2 && bv2s1.errors.length === 0 && bv2s1.tier === 'B', JSON.stringify(bv2s1))
      // 覆盖上传：B 档复查在 PUT 前每文件发一次 Depth:0 PROPFIND（档位保护，允许）
      await fsp.writeFile(path.join(BV2_LOCAL, 'x.txt'), 'bv2-x-v2-longer')
      await fsp.writeFile(path.join(BV2_LOCAL, 'y.txt'), 'bv2-y-v2-longer')
      const bv2s2 = await syncP(BV2_LOCAL, '/bv2')
      check('BV2 overwrite round succeeds under B tier', bv2s2.uploaded === 2 && bv2s2.errors.length === 0, JSON.stringify(bv2s2))
      const lines = await readReqlog()
      let noPost = true
      const perFileCounts = []
      for (const name of ['x.txt', 'y.txt']) {
        const p = `/dav/bv2/${name}`
        const lastPut = lastReqLine(lines, 'PUT', p)
        const propLines = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.startsWith('PROPFIND ') && l.slice('PROPFIND '.length).replace(/\/+$/, '') === p.replace(/\/+$/, ''))
        if (lastPut < 0 || !propLines.every(({ i }) => i < lastPut)) noPost = false
        perFileCounts.push(propLines.length)
      }
      check('BV2 no PROPFIND to any file after its last PUT (post-upload verify removed)', noPost, JSON.stringify(lines.filter((l) => l.startsWith('PROPFIND /dav/bv2/'))))
      check('BV2 exactly one pre-PUT recheck per overwritten file (guard kept, verify gone)', perFileCounts.every((n) => n === 1), perFileCounts.join(','))
      const xe = await services.sync._internals.baselineEntry(bv2dir, 'x.txt')
      check(
        'BV2 baseline updated with correct size (noetag profile: retag empty)',
        xe != null && xe.lhash != null && xe.rsize === 'bv2-x-v2-longer'.length && (xe.retag || '') === '',
        JSON.stringify(xe)
      )
      const bv2s3 = await syncP(BV2_LOCAL, '/bv2')
      check('BV2 follow-up round is a no-op', isNoop(bv2s3), JSON.stringify(bv2s3))
    } finally {
      await setProfile(null)
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
    }
    await fsp.rm(BV2_LOCAL, { recursive: true, force: true })
  })

  // BV3（崩溃窗口）：PUT 成功 → 批量提交之间崩溃（afterTransferOp 注入）—— 轮次失败、
  // 远端已上传、基线未写、崩溃轮没有对该文件的上传后 PROPFIND（批量阶段被跳过）；
  // 下一轮 WAL 采纳收敛（R1 已覆盖采纳语义，此处补 reqlog 侧断言与最小闭环）。
  await section('BV3：批量提交窗口崩溃', async () => {
    await freshStore('bv3')
    const BV3_LOCAL = await tmpLocal('bv3')
    const bv3dir = { id: 'p', localPath: BV3_LOCAL, remotePath: '/bv3', mode: 'two-way' }
    await fsp.writeFile(path.join(BV3_LOCAL, 'a.txt'), 'bv3-a-v1')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      let bv3err = null
      try {
        await syncP(BV3_LOCAL, '/bv3', undefined, {
          afterTransferOp: async (p) => {
            if (p.rel === 'a.txt' && p.act === 'upload') throw new Error('SIMULATED-CRASH-BV3')
          },
        })
      } catch (e) {
        bv3err = e
      }
      check('BV3 crash in batch window fails the round', !!bv3err && /SIMULATED-CRASH-BV3/.test(bv3err.message), bv3err && bv3err.message)
      check('BV3 crash residue: leaked lease renew timer swept before first 60s tick', sweepCrashResidue() === 1)
      check(
        'BV3 remote upload happened, baseline not yet written',
        (await fsp.readFile(path.join(ROOT, 'bv3', 'a.txt'), 'utf-8')) === 'bv3-a-v1' && (await services.sync._internals.baselineEntry(bv3dir, 'a.txt')) === null
      )
      const lines = await readReqlog()
      const lastPut = lastReqLine(lines, 'PUT', '/dav/bv3/a.txt')
      const postProps = lines.filter((l, i) => i > lastPut && l.startsWith('PROPFIND /dav/bv3/a.txt'))
      check('BV3 crash round issues no post-upload PROPFIND to the file (batch skipped)', lastPut >= 0 && postProps.length === 0, postProps.join(';'))
      const bv3b = await syncP(BV3_LOCAL, '/bv3')
      const bv3e = await services.sync._internals.baselineEntry(bv3dir, 'a.txt')
      check(
        'BV3 next round adopts via WAL (no re-upload, no conflict)',
        bv3b.uploaded === 0 && bv3b.downloaded === 0 && bv3b.conflicts === 0 && bv3e != null && bv3e.lhash != null,
        JSON.stringify(bv3b)
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
    }
    await fsp.rm(BV3_LOCAL, { recursive: true, force: true })
  })

  // BV4（批量校验失败路径）：.wdsync-test-vanish —— PUT 成功但目录列表看不到该文件
  //（PROPFIND 到含 vanish 的路径时剔除 gone.vanish.txt 条目）：同目录 ok.txt 正常提交，
  // vanish 文件报「上传批量校验失败」、无基线、轮次 error 且不记退避表；去掉标记后
  // 下一轮收敛（intent 已 abort → 无基线 + 双侧同内容 → adopt），再一轮 no-op。
  await section('BV4：批量校验失败路径', async () => {
    await freshStore('bv4')
    const BV4_LOCAL = await tmpLocal('bv4')
    const bv4dir = { id: 'p', localPath: BV4_LOCAL, remotePath: '/bv4vanish', mode: 'two-way' }
    await fsp.writeFile(path.join(BV4_LOCAL, 'ok.txt'), 'bv4-ok')
    await fsp.writeFile(path.join(BV4_LOCAL, 'gone.vanish.txt'), 'bv4-gone')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-vanish'), 'x')
    try {
      let bv4err = null
      try {
        await syncP(BV4_LOCAL, '/bv4vanish')
      } catch (e) {
        bv4err = e
      }
      check(
        'BV4 vanish file fails batch verify while round errors',
        !!bv4err && /上传批量校验失败 gone\.vanish\.txt：远端未见该文件/.test(bv4err.message),
        bv4err && bv4err.message
      )
      const okEntry = await services.sync._internals.baselineEntry(bv4dir, 'ok.txt')
      check('BV4 sibling ok.txt committed to baseline (retag non-empty)', okEntry != null && okEntry.lhash != null && okEntry.retag !== '', JSON.stringify(okEntry))
      check(
        'BV4 vanish file has no baseline entry though remote holds the bytes',
        (await services.sync._internals.baselineEntry(bv4dir, 'gone.vanish.txt')) === null &&
          (await fsp.readFile(path.join(ROOT, 'bv4vanish', 'gone.vanish.txt'), 'utf-8')) === 'bv4-gone'
      )
      const bv4f = await services.sync._internals.getFailures(bv4dir)
      check('BV4 batch-verify failure never enters the backoff table', Object.keys(bv4f).length === 0, JSON.stringify(bv4f))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-vanish'), { force: true }).catch(() => {})
    }
    const bv4s2 = await syncP(BV4_LOCAL, '/bv4vanish')
    const goneEntry = await services.sync._internals.baselineEntry(bv4dir, 'gone.vanish.txt')
    check(
      'BV4 next round (marker removed) converges without error',
      // adopt 直采路径（mtime 命中容差）不重算 lhash，故只断言条目存在且远端 size 正确
      bv4s2.errors.length === 0 && bv4s2.conflicts === 0 && bv4s2.downloaded === 0 && bv4s2.adopted === 1 && goneEntry != null && goneEntry.rsize === 'bv4-gone'.length,
      JSON.stringify(bv4s2)
    )
    const bv4s3 = await syncP(BV4_LOCAL, '/bv4vanish')
    check('BV4 follow-up round is a no-op', isNoop(bv4s3), JSON.stringify(bv4s3))
    await fsp.rm(BV4_LOCAL, { recursive: true, force: true })
  })

  // ============================================================
  // L 系列：目录级租约锁 + 同目录单轮互斥
  // 依赖 dav-server 的 .wdsync-test-locksteal（锁 PUT 落盘后改写为他人 deviceId）
  // 与 .wdsync-test-delefail（DELETE 一律 500）两个标记；GET 应答新增 Last-Modified
  // 头供「服务器时钟过期判定」。P1 档为主（L8/L11/L12 用 P2 档做 B 档覆盖）；
  // L1–L9 不用 reqlog（锁 GET/PUT/DELETE 会进日志，避免与 BV 计数互相污染），
  // L10+（锁时序断言）起在独立用例内启用 reqlog 并用完即清（含日志文件）。
  // ============================================================
  await setProfile('p1') // L 系列公共前置（独立于各节，跳过个别节时仍需生效）

  // L1 正常释放：同步一轮（含上传）→ 轮中远端有锁（证明确实持有）→ 结束后无锁。
  // 锁后置：plan 阶段在拿锁之前（锁不存在），持锁证明只能在 transfer 阶段采集
  await section('L1：租约锁正常释放', async () => {
    await freshStore('l1')
    const L1_LOCAL = await tmpLocal('l1')
    const l1lock = path.join(ROOT, 'l1', '.webdav-sync.lock')
    await fsp.writeFile(path.join(L1_LOCAL, 'a.txt'), 'l1-a')
    await fsp.writeFile(path.join(L1_LOCAL, 'b.txt'), 'l1-b')
    let l1SawLock = false
    let l1PlanNoLock = true
    const l1s = await syncP(L1_LOCAL, '/l1', undefined, {
      onProgress: (p) => {
        if (p.phase === 'plan' && fs.existsSync(l1lock)) l1PlanNoLock = false
        if (!l1SawLock && p.phase === 'transfer') l1SawLock = fs.existsSync(l1lock)
      },
    })
    check(
      'L1 normal round uploads with lease held during transfer (no yielded / concurrent)',
      l1s.uploaded === 2 && l1s.errors.length === 0 && !l1s.yielded && !l1s.concurrent && l1SawLock,
      `${JSON.stringify(l1s)} sawLock=${l1SawLock}`
    )
    check('L1 lease absent during plan phase (lock deferred until after planning)', l1PlanNoLock)
    check('L1 lease lock released after round (no lock file on remote root)', !fs.existsSync(l1lock))
    const l1s2 = await syncP(L1_LOCAL, '/l1')
    check('L1 follow-up no-op round stays lock-free and is a no-op', isNoop(l1s2) && !fs.existsSync(l1lock), JSON.stringify(l1s2))
    await fsp.rm(L1_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l1'), { recursive: true, force: true })
  })

  // L2 让出：预置他人新锁（deviceId 'device-other'、当前 mtime）→ 本轮扫描规划**之后**
  // 让出（锁后置：planned 字段证明确有规划、tier 证明扫描后阶段已运行）、零传输、
  // 远端原样、锁仍在；删锁后下一轮正常
  await section('L2：他人持锁让出', async () => {
    await freshStore('l2')
    const L2_LOCAL = await tmpLocal('l2')
    const l2lock = path.join(ROOT, 'l2', '.webdav-sync.lock')
    await fsp.writeFile(path.join(L2_LOCAL, 'a.txt'), 'l2-a')
    await fsp.mkdir(path.join(ROOT, 'l2'), { recursive: true })
    await fsp.writeFile(l2lock, JSON.stringify({ v: 1, deviceId: 'device-other', startedAt: new Date().toISOString(), ttlMs: 180000 }))
    const l2s = await syncP(L2_LOCAL, '/l2')
    check(
      'L2 yields to another device holding a fresh lease (zero transfers, not an error)',
      l2s.yielded === true && l2s.uploaded === 0 && l2s.downloaded === 0 && l2s.totalFiles === 0 && l2s.warnings.some((w) => /另一设备正在同步/.test(w)),
      JSON.stringify(l2s)
    )
    check(
      'L2 yield happens after planning (planned set; tier proves post-scan phases ran)',
      l2s.planned === 1 && l2s.tier === 'A',
      `planned=${l2s.planned} tier=${l2s.tier}`
    )
    check(
      'L2 yielded round leaves remote content untouched (lock intact, nothing uploaded)',
      (await fsp.readFile(l2lock, 'utf-8')).includes('device-other') && !fs.existsSync(path.join(ROOT, 'l2', 'a.txt'))
    )
    await fsp.rm(l2lock, { force: true })
    const l2s2 = await syncP(L2_LOCAL, '/l2')
    check(
      'L2 next round syncs normally after lock removal (and releases)',
      l2s2.uploaded === 1 && l2s2.errors.length === 0 && !l2s2.yielded && !fs.existsSync(l2lock),
      JSON.stringify(l2s2)
    )
    await fsp.rm(L2_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l2'), { recursive: true, force: true })
  })

  // L3 过期接管：他人锁但 mtime 已 10 分钟前（服务器时钟年龄 ≥ ttl）→ 接管并正常同步 → 结束释放
  await section('L3：过期锁接管', async () => {
    await freshStore('l3')
    const L3_LOCAL = await tmpLocal('l3')
    const l3lock = path.join(ROOT, 'l3', '.webdav-sync.lock')
    await fsp.writeFile(path.join(L3_LOCAL, 'a.txt'), 'l3-a')
    await fsp.mkdir(path.join(ROOT, 'l3'), { recursive: true })
    await fsp.writeFile(l3lock, JSON.stringify({ v: 1, deviceId: 'device-other', startedAt: new Date().toISOString(), ttlMs: 180000 }))
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000)
    await fsp.utimes(l3lock, tenMinAgo, tenMinAgo)
    const l3s = await syncP(L3_LOCAL, '/l3')
    check(
      'L3 expired lease (server-clock age >= ttl) is taken over and synced',
      l3s.uploaded === 1 && !l3s.yielded && l3s.errors.length === 0,
      JSON.stringify(l3s)
    )
    check('L3 taken-over lease is released at round end', !fs.existsSync(l3lock))
    await fsp.rm(L3_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l3'), { recursive: true, force: true })
  })

  // L4 取消释放：多文件上传中 shouldAbort（首个 transfer 进度后置位）→ 轮次以中止收场
  //（error 且 message 含「中止」）→ 锁已释放；已完成文件的基线在（下一轮只补传余量，
  // 再一轮 no-op）—— 取消路径同样释放锁且不破坏基线一致性
  await section('L4：取消路径释放锁', async () => {
    await freshStore('l4')
    const L4_LOCAL = await tmpLocal('l4')
    for (let i = 0; i < 8; i++) await fsp.writeFile(path.join(L4_LOCAL, `f${i}.txt`), `l4-content-${i}`)
    let l4Abort = false
    let l4err = null
    try {
      await syncP(L4_LOCAL, '/l4', undefined, {
        shouldAbort: () => l4Abort,
        onProgress: (p) => {
          if (p.phase === 'transfer') l4Abort = true
        },
      })
    } catch (e) {
      l4err = e
    }
    check('L4 abort during transfer fails the round with abort message', !!l4err && /中止/.test(l4err.message), l4err && l4err.message)
    check('L4 lease released on abort (no lock file left)', !fs.existsSync(path.join(ROOT, 'l4', '.webdav-sync.lock')))
    const l4done = l4err && l4err.summary ? l4err.summary.uploaded : 0
    const l4b = await syncP(L4_LOCAL, '/l4')
    check(
      'L4 next round uploads only the remainder (completed baselines intact)',
      l4b.errors.length === 0 && l4done > 0 && l4done < 8 && l4b.uploaded === 8 - l4done && !fs.existsSync(path.join(ROOT, 'l4', '.webdav-sync.lock')),
      `done=${l4done} ${JSON.stringify(l4b)}`
    )
    const l4c = await syncP(L4_LOCAL, '/l4')
    check('L4 follow-up round is a no-op after remainder round', isNoop(l4c), JSON.stringify(l4c))
    await fsp.rm(L4_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l4'), { recursive: true, force: true })
  })

  // L5 熔断释放：首个 transfer 进度后打开 .wdsync-test-err503（PUT 全 503，DELETE 不受
  // 影响）→ 锁已获取、轮内熔断终止 → 释放 DELETE 不被熔断拦截：远端无锁文件、无左锁标记
  await slowSection('L5：熔断路径释放锁', '503 风暴熔断重试真实等待；熔断语义仍由 W7、锁释放路径仍由 L1/L2/L4/L6/L8 覆盖', async () => {
    await freshStore('l5')
    const L5_LOCAL = await tmpLocal('l5')
    for (let i = 0; i < 10; i++) await fsp.writeFile(path.join(L5_LOCAL, `f${i}.txt`), 'l5-x')
    const l5dir = { id: 'p', localPath: L5_LOCAL, remotePath: '/l5', mode: 'two-way' }
    const err503Flag = path.join(ROOT, '.wdsync-test-err503')
    let l5err = null
    try {
      await syncP(L5_LOCAL, '/l5', undefined, {
        onProgress: (p) => {
          if (p.phase === 'transfer' && !fs.existsSync(err503Flag)) fs.writeFileSync(err503Flag, 'x')
        },
      })
    } catch (e) {
      l5err = e
    } finally {
      await fsp.rm(err503Flag, { force: true }).catch(() => {})
    }
    const l5msgs = l5err && l5err.errors ? l5err.errors.join(';') : String(l5err && l5err.message)
    check('L5 round terminated by breaker under 503 storm (errors mention breaker)', !!l5err && /熔断|连续失败/.test(l5msgs), l5msgs)
    check(
      'L5 lease released despite open breaker (DELETE bypasses circuit: no lock file, no leftover mark)',
      !fs.existsSync(path.join(ROOT, 'l5', '.webdav-sync.lock')) && !(await services.sync._internals.getDirMeta(l5dir)).lockLeftover
    )
    await fsp.rm(L5_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l5'), { recursive: true, force: true })
  })

  // L6 释放失败 → 左锁 → 下轮清理：.wdsync-test-delefail + 纯上传目录 → 轮次成功（上传
  // 照常）但锁未删（warning「释放失败」+ meta.lockLeftover 已记）；去标记 → 下一轮开头
  // 清掉左锁（远端锁文件消失、标记清除）→ 正常同步并释放
  await section('L6：释放失败左锁清理', async () => {
    await freshStore('l6')
    const L6_LOCAL = await tmpLocal('l6')
    await fsp.writeFile(path.join(L6_LOCAL, 'a.txt'), 'l6-a')
    await fsp.writeFile(path.join(L6_LOCAL, 'b.txt'), 'l6-b')
    const l6dir = { id: 'p', localPath: L6_LOCAL, remotePath: '/l6', mode: 'two-way' }
    const l6lock = path.join(ROOT, 'l6', '.webdav-sync.lock')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-delefail'), 'x')
    let l6s1 = null
    try {
      l6s1 = await syncP(L6_LOCAL, '/l6')
      check(
        'L6 round succeeds (uploads intact) but lock release fails with warning',
        l6s1.uploaded === 2 && l6s1.errors.length === 0 && l6s1.warnings.some((w) => /租约锁释放失败/.test(w)),
        JSON.stringify(l6s1.warnings)
      )
      check('L6 lock file left on remote after failed release', fs.existsSync(l6lock))
      const l6meta1 = await services.sync._internals.getDirMeta(l6dir)
      check('L6 leftover-lock mark recorded in dir meta', !!l6meta1.lockLeftover && typeof l6meta1.lockLeftover.at === 'number', JSON.stringify(l6meta1.lockLeftover))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-delefail'), { force: true }).catch(() => {})
    }
    const l6s2 = await syncP(L6_LOCAL, '/l6')
    const l6meta2 = await services.sync._internals.getDirMeta(l6dir)
    check(
      'L6 next round cleans leftover lock at start (mark cleared, remote lock gone) and syncs fine',
      l6s2.errors.length === 0 && !l6meta2.lockLeftover && !fs.existsSync(l6lock),
      JSON.stringify(l6s2)
    )
    check('L6 next round is otherwise a no-op (baselines intact)', isNoop(l6s2), JSON.stringify(l6s2))
    await fsp.rm(L6_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l6'), { recursive: true, force: true })
  })

  // L7 写回竞争失败：.wdsync-test-locksteal —— 锁 PUT 落盘后被服务器改写为 peer-device-x，
  // 引擎静置回读到别人的 deviceId → 让出本轮，远端用户文件未被触碰
  await section('L7：写回竞争失败让出', async () => {
    await freshStore('l7')
    const L7_LOCAL = await tmpLocal('l7')
    await fsp.writeFile(path.join(L7_LOCAL, 'a.txt'), 'l7-a')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-locksteal'), 'x')
    try {
      const l7s = await syncP(L7_LOCAL, '/l7')
      check(
        'L7 write-back race lost: round yields after reading peer deviceId',
        l7s.yielded === true && l7s.uploaded === 0 && l7s.totalFiles === 0 && l7s.planned === 1 && l7s.warnings.some((w) => /另一设备正在同步/.test(w)),
        JSON.stringify(l7s)
      )
      check('L7 user files untouched on remote during yielded round', !fs.existsSync(path.join(ROOT, 'l7', 'a.txt')))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-locksteal'), { force: true }).catch(() => {})
    }
    await fsp.rm(L7_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l7'), { recursive: true, force: true })
  })

  // L8 P2 档（B 档覆盖）：L1 正常释放 + L2 让出在 p2 下各跑一遍（无 etag / 秒级 mtime /
  // 静默忽略条件头不影响锁状态机 —— 锁判定只依赖 GET 内容 + date/last-modified 头）
  await section('L8：锁状态机 B 档覆盖（P2）', async () => {
    await setProfile('p2')
    try {
      await freshStore('l8')
      const L8A_LOCAL = await tmpLocal('l8')
      await fsp.writeFile(path.join(L8A_LOCAL, 'a.txt'), 'l8-a')
      const l8s = await syncP(L8A_LOCAL, '/l8')
      check(
        'L8 (p2/B tier) normal round uploads and releases lease',
        l8s.uploaded === 1 && l8s.tier === 'B' && !l8s.yielded && !fs.existsSync(path.join(ROOT, 'l8', '.webdav-sync.lock')),
        JSON.stringify(l8s)
      )
      const L8B_LOCAL = await tmpLocal('l8b')
      const l8lock = path.join(ROOT, 'l8b', '.webdav-sync.lock')
      await fsp.writeFile(path.join(L8B_LOCAL, 'a.txt'), 'l8b-a')
      await fsp.mkdir(path.join(ROOT, 'l8b'), { recursive: true })
      await fsp.writeFile(l8lock, JSON.stringify({ v: 1, deviceId: 'device-other', startedAt: new Date().toISOString(), ttlMs: 180000 }))
      const l8s2 = await syncP(L8B_LOCAL, '/l8b')
      check(
        'L8 (p2/B tier) yields to another device holding a fresh lease',
        l8s2.yielded === true && l8s2.uploaded === 0 && l8s2.totalFiles === 0 && l8s2.planned === 1 && (await fsp.readFile(l8lock, 'utf-8')).includes('device-other'),
        JSON.stringify(l8s2)
      )
      await fsp.rm(L8A_LOCAL, { recursive: true, force: true })
      await fsp.rm(L8B_LOCAL, { recursive: true, force: true })
      await fsp.rm(path.join(ROOT, 'l8'), { recursive: true, force: true })
      await fsp.rm(path.join(ROOT, 'l8b'), { recursive: true, force: true })
    } finally {
      await setProfile(null)
    }
  })

  // L9 并发互斥：同一目录并发发起两个 syncDirectory（Promise.all，后到的立即
  // 返回）→ 第二个 concurrent === true 且零传输（无任何进度事件）；第一个正常完成并释放锁
  await section('L9：同目录单轮互斥', async () => {
    await freshStore('l9')
    const L9_LOCAL = await tmpLocal('l9')
    for (let i = 0; i < 3; i++) await fsp.writeFile(path.join(L9_LOCAL, `f${i}.txt`), `l9-f${i}`)
    let progressA = 0
    let progressB = 0
    const [r1, r2] = await Promise.all([
      syncP(L9_LOCAL, '/l9', undefined, { onProgress: () => { progressA++ } }),
      syncP(L9_LOCAL, '/l9', undefined, { onProgress: () => { progressB++ } }),
    ])
    check(
      'L9 second concurrent round returns immediately with concurrent flag, zero counts, no progress',
      r2.concurrent === true && r2.uploaded === 0 && r2.downloaded === 0 && progressB === 0 && r2.warnings.some((w) => /已有同步在进行/.test(w)),
      JSON.stringify(r2)
    )
    check(
      'L9 first round completes normally while the second skipped (lock released)',
      r1.uploaded === 3 && r1.errors.length === 0 && !r1.concurrent && progressA > 0 && !fs.existsSync(path.join(ROOT, 'l9', '.webdav-sync.lock')),
      JSON.stringify(r1)
    )
    await fsp.rm(L9_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l9'), { recursive: true, force: true })
  })

  // ============================================================
  // L10–L14：锁后置 + 按需获取 + B 档新上传写前查重的验收用例。
  // 用到 dav-server 的 .wdsync-test-reqlog（逐请求日志）与 .wdsync-test-dedupfail
  //（路径含 dedupfail 的 Depth:1 列举从第 2 次起注入状态码）两个标记，均用完即清。
  // ============================================================

  // L10（P1 / A 档）：空轮零锁请求（reqlog 全程无锁 GET/PUT/DELETE）；写轮锁 4 请求齐
  //（GET×2 + PUT + DELETE）、首个锁请求在扫描列举之后、首个用户 PUT 之前，且传输期间锁存在
  await section('L10：锁按需获取（A 档）', async () => {
    await freshStore('l10')
    const L10_LOCAL = await tmpLocal('l10')
    const l10lockFile = path.join(ROOT, 'l10', '.webdav-sync.lock')
    const l10lockPath = '/dav/l10/.webdav-sync.lock'
    await fsp.writeFile(path.join(L10_LOCAL, 'a.txt'), 'l10-a')
    const l10r1 = await syncP(L10_LOCAL, '/l10') // 首轮上传：写轮拿锁 + 能力缓存落定
    check('L10 write round uploads (lock taken then released)', l10r1.uploaded === 1 && l10r1.errors.length === 0 && !fs.existsSync(l10lockFile), JSON.stringify(l10r1))
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      // 空轮（无变化、能力缓存命中）：全程不得出现任何锁请求
      const l10r2 = await syncP(L10_LOCAL, '/l10')
      const emptyLines = await readReqlog()
      check(
        'L10 empty round issues zero lease-lock requests',
        isNoop(l10r2) && emptyLines.every((l) => !l.includes('.webdav-sync.lock')),
        `${emptyLines.length} reqs, lock lines: ${emptyLines.filter((l) => l.includes('.webdav-sync.lock')).length}`
      )
      // 写轮：本地新增 b.txt（B 档视角下的新上传；A 档由 If-None-Match:* 写时守卫保护）
      await fsp.writeFile(path.join(L10_LOCAL, 'b.txt'), 'l10-b')
      let sawLockInTransfer = false
      const l10r3 = await syncP(L10_LOCAL, '/l10', undefined, {
        onProgress: (p) => {
          if (!sawLockInTransfer && p.phase === 'transfer') sawLockInTransfer = fs.existsSync(l10lockFile)
        },
      })
      const lines3 = (await readReqlog()).slice(emptyLines.length)
      check(
        'L10 write round lock requests complete (GET x2 + PUT + DELETE)',
        l10r3.uploaded === 1 && countReq(lines3, 'GET', l10lockPath) === 2 && countReq(lines3, 'PUT', l10lockPath) === 1 && countReq(lines3, 'DELETE', l10lockPath) === 1,
        lines3.join(' | ')
      )
      // 同步根列举共 3 次（轮首建根探测、扫描、上传后批量校验），A 档无写前查重；
      // 首个锁请求须晚于第 2 次列举（扫描完成），首个用户 PUT 须晚于首个锁请求
      const listingIdxs = lines3.map((l, i) => (l === 'PROPFIND /dav/l10/' ? i : -1)).filter((i) => i >= 0)
      const firstLock = lines3.findIndex((l) => l.includes('.webdav-sync.lock'))
      const firstUserPut = lines3.findIndex((l) => l.startsWith('PUT /dav/l10/') && !l.includes('.webdav-sync.lock'))
      check(
        'L10 lock timing: after scan listing, before first user PUT',
        listingIdxs.length === 3 && firstLock > listingIdxs[1] && firstUserPut > firstLock,
        JSON.stringify({ listings: listingIdxs, firstLock, firstUserPut })
      )
      check('L10 lease held during transfer phase', sawLockInTransfer)
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
    }
    await fsp.rm(L10_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l10'), { recursive: true, force: true })
  })

  // L11（P2 / B 档）：空轮零锁 + 写轮锁时序同 L10，另断言 B 档新上传的写前查重
  // PROPFIND 落在「拿锁之后（含 1.5s 静置回读）、首个用户 PUT 之前」，传输期间锁存在
  await section('L11：锁按需获取（B 档）', async () => {
    await setProfile('p2')
    try {
      await freshStore('l11')
      const L11_LOCAL = await tmpLocal('l11')
      const l11lockFile = path.join(ROOT, 'l11', '.webdav-sync.lock')
      const l11lockPath = '/dav/l11/.webdav-sync.lock'
      await fsp.writeFile(path.join(L11_LOCAL, 'a.txt'), 'l11-a')
      const l11r1 = await syncP(L11_LOCAL, '/l11')
      check('L11 (B tier) write round uploads', l11r1.uploaded === 1 && l11r1.errors.length === 0 && l11r1.tier === 'B', JSON.stringify(l11r1))
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
      try {
        const l11r2 = await syncP(L11_LOCAL, '/l11')
        const emptyLines = await readReqlog()
        check('L11 empty round issues zero lease-lock requests', isNoop(l11r2) && emptyLines.every((l) => !l.includes('.webdav-sync.lock')), `${emptyLines.length} reqs [${emptyLines.join(' | ')}]`)
        await fsp.writeFile(path.join(L11_LOCAL, 'b.txt'), 'l11-b')
        let sawLockInTransfer = false
        const l11r3 = await syncP(L11_LOCAL, '/l11', undefined, {
          onProgress: (p) => {
            if (!sawLockInTransfer && p.phase === 'transfer') sawLockInTransfer = fs.existsSync(l11lockFile)
          },
        })
        const lines3 = (await readReqlog()).slice(emptyLines.length)
        check(
          'L11 write round lock requests complete (GET x2 + PUT + DELETE)',
          l11r3.uploaded === 1 && countReq(lines3, 'GET', l11lockPath) === 2 && countReq(lines3, 'PUT', l11lockPath) === 1 && countReq(lines3, 'DELETE', l11lockPath) === 1,
          lines3.join(' | ')
        )
        // 同步根列举共 4 次（建根探测、扫描、写前查重、上传后批量校验）；顺序断言：
        // 锁在扫描（第 2 次列举）之后 → 查重（第 3 次列举）在锁获取完成（回读 GET，
        // 第 3 个锁请求）之后 → 首个用户 PUT 在查重之后（轮末 DELETE 锁在一切之后，
        // 不参与本断言）
        const listingIdxs = lines3.map((l, i) => (l === 'PROPFIND /dav/l11/' ? i : -1)).filter((i) => i >= 0)
        const lockIdxs = lines3.map((l, i) => (l.includes('.webdav-sync.lock') ? i : -1)).filter((i) => i >= 0)
        const firstUserPut = lines3.findIndex((l) => l.startsWith('PUT /dav/l11/') && !l.includes('.webdav-sync.lock'))
        check(
          'L11 lock after scan; pre-write dedup listing after lock acquired, before first PUT',
          listingIdxs.length === 4 && lockIdxs[0] > listingIdxs[1] && listingIdxs[2] > lockIdxs[2] && firstUserPut > listingIdxs[2],
          JSON.stringify({ listings: listingIdxs, locks: lockIdxs, firstUserPut })
        )
        check('L11 lease held during transfer phase and released at round end', sawLockInTransfer && !fs.existsSync(l11lockFile))
      } finally {
        await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
        await fsp.rm(REQLOG, { force: true }).catch(() => {})
      }
      await fsp.rm(L11_LOCAL, { recursive: true, force: true })
      await fsp.rm(path.join(ROOT, 'l11'), { recursive: true, force: true })
    } finally {
      await setProfile('p1')
    }
  })

  // L12（P2 / B 档）：新上传写前查重的窗口守卫 —— 对端在本机扫描后、写入前新建同名
  // 文件（onProgress plan 阶段注入：扫描已结束、查重未发生）→ 本轮该文件被剔除不覆盖
  //（远端对端内容原样保留）、轮次按 REMOTE_CHANGED 同类后果报错、不进退避表；下一轮
  // 无基线双侧并存 → 冲突（策略 local）收敛。查重请求失败（dedupfail 注入 503）→
  // 该文件按瞬时失败语义跳过本轮上传（不裸传、不进退避表），故障移除后下轮正常上传。
  await section('L12：B 档新上传写前查重', async () => {
    await setProfile('p2')
    try {
      await freshStore('l12')
      const L12_LOCAL = await tmpLocal('l12')
      const l12dir = { id: 'l12', localPath: L12_LOCAL, remotePath: '/l12', mode: 'two-way' }
      const guardRemote = path.join(ROOT, 'l12', 'guard-midair.txt')
      await fsp.writeFile(path.join(L12_LOCAL, 'seed.txt'), 'l12-seed')
      const l12r1 = await syncP(L12_LOCAL, '/l12')
      check('L12 setup round uploads seed', l12r1.uploaded === 1 && l12r1.errors.length === 0, JSON.stringify(l12r1))
      // 窗口守卫命中：plan 阶段首个进度事件（扫描完成后、规划开始前）同步写远端同名文件
      await fsp.writeFile(path.join(L12_LOCAL, 'guard-midair.txt'), 'l12-local-version')
      let guardCreated = false
      let l12err = null
      try {
        await syncP(L12_LOCAL, '/l12', undefined, {
          onProgress: (p) => {
            if (p.phase === 'plan' && !guardCreated) {
              guardCreated = true
              fs.writeFileSync(guardRemote, 'PEER-CREATED-VERSION')
            }
          },
        })
      } catch (e) {
        l12err = e
      }
      check(
        'L12 peer-created file not overwritten this round (round errors, REMOTE_CHANGED-style)',
        !!l12err && /写前查重发现远端已出现同名文件/.test(l12err.message),
        l12err && l12err.message
      )
      check(
        'L12 remote keeps peer version untouched; local version intact',
        (await fsp.readFile(guardRemote, 'utf-8')) === 'PEER-CREATED-VERSION' && (await fsp.readFile(path.join(L12_LOCAL, 'guard-midair.txt'), 'utf-8')) === 'l12-local-version'
      )
      const l12f = await services.sync._internals.getFailures(l12dir)
      check('L12 dedup skip never enters the backoff table', Object.keys(l12f).length === 0, JSON.stringify(l12f))
      const l12r3 = await syncP(L12_LOCAL, '/l12', { ...SP, conflictStrategy: 'local' })
      check(
        'L12 next round converges via conflict (no baseline, both sides exist)',
        l12r3.conflicts === 1 && l12r3.uploaded === 1 && l12r3.errors.length === 0 && (await fsp.readFile(guardRemote, 'utf-8')) === 'l12-local-version',
        JSON.stringify(l12r3)
      )
      // 查重请求失败子用例（独立目录：路径含 dedupfail 才命中注入；首轮上传让该路径的
      // 能力 / 写权限缓存落定，探测不再列目录，第 1 次 Depth:1 列举即扫描）
      const DF_LOCAL = await tmpLocal('l12df')
      const dfdir = { id: 'l12df', localPath: DF_LOCAL, remotePath: '/dedupfail-l12', mode: 'two-way' }
      await fsp.writeFile(path.join(DF_LOCAL, 'seed.txt'), 'df-seed')
      const df1 = await syncP(DF_LOCAL, '/dedupfail-l12')
      check('L12 df setup round uploads', df1.uploaded === 1 && df1.errors.length === 0, JSON.stringify(df1))
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-dedupfail'), '503')
      try {
        await fsp.writeFile(path.join(DF_LOCAL, 'new.txt'), 'df-new-content')
        let dferr = null
        try {
          await syncP(DF_LOCAL, '/dedupfail-l12')
        } catch (e) {
          dferr = e
        }
        check(
          'L12 dedup request failure skips upload without blind PUT (transient semantics)',
          !!dferr && /写前查重失败/.test(dferr.message) && !fs.existsSync(path.join(ROOT, 'dedupfail-l12', 'new.txt')),
          dferr && dferr.message
        )
        const dff = await services.sync._internals.getFailures(dfdir)
        check(
          'L12 dedup-failure skip never enters the backoff table; local file intact',
          Object.keys(dff).length === 0 && (await fsp.readFile(path.join(DF_LOCAL, 'new.txt'), 'utf-8')) === 'df-new-content',
          JSON.stringify(dff)
        )
      } finally {
        await fsp.rm(path.join(ROOT, '.wdsync-test-dedupfail'), { force: true }).catch(() => {})
      }
      const df2 = await syncP(DF_LOCAL, '/dedupfail-l12')
      check(
        'L12 next round uploads after fault removal',
        df2.uploaded === 1 && (await fsp.readFile(path.join(ROOT, 'dedupfail-l12', 'new.txt'), 'utf-8')) === 'df-new-content',
        JSON.stringify(df2)
      )
      await fsp.rm(L12_LOCAL, { recursive: true, force: true })
      await fsp.rm(DF_LOCAL, { recursive: true, force: true })
      await fsp.rm(path.join(ROOT, 'l12'), { recursive: true, force: true })
      await fsp.rm(path.join(ROOT, 'dedupfail-l12'), { recursive: true, force: true })
    } finally {
      await setProfile('p1')
    }
  })

  // B2B-P404：B 档写前查重「远端父目录 404 ⇒ 放行整组上传」的
  // 独立验收（不依赖 B2B 节 FC5b 的 seed 轮）—— 本地新建子目录 + 文件的首轮，
  // 查重 PROPFIND 对不存在的父目录必然 404，404 = 组内必然无同名（比空列举更强的
  // 「无冲突」证据）→ 放行整组照常上传（PUT 前 MKCOL 建目录），且第二轮 no-op 收敛
  //（修复前该组每轮被「查重失败」跳过、MKCOL 永不发生，形成永不收敛的死循环）。
  // 对照组：父目录已存在的组，对端在扫描后、写入前新建同名文件 → 该组仍被剔除不覆盖
  //（与 L12 根目录场景同语义，此处验证子目录组的按父目录分组查重）。
  await section('B2B-P404：B 档父目录 404 放行整组上传（4.0 前置专项）', async () => {
    await setProfile('p2')
    try {
      await freshStore('p404')
      const P404_LOCAL = await tmpLocal('p404')
      // 场景一：本地新建子目录 + 两个文件，远端 /p404/sub-new 整个不存在
      await fsp.mkdir(path.join(P404_LOCAL, 'sub-new'), { recursive: true })
      await fsp.writeFile(path.join(P404_LOCAL, 'sub-new', 'a.txt'), 'p404-a')
      await fsp.writeFile(path.join(P404_LOCAL, 'sub-new', 'b.txt'), 'p404-b-longer')
      const p404r1 = await syncP(P404_LOCAL, '/p404')
      check(
        'P404 first round uploads whole group (parent 404 = pass-through, MKCOL then PUT)',
        p404r1.uploaded === 2 && p404r1.errors.length === 0,
        JSON.stringify(p404r1)
      )
      check(
        'P404 remote subdir created and both files present',
        fs.existsSync(path.join(ROOT, 'p404', 'sub-new', 'a.txt')) && fs.existsSync(path.join(ROOT, 'p404', 'sub-new', 'b.txt')),
        ''
      )
      const p404r2 = await syncP(P404_LOCAL, '/p404')
      check('P404 second round is a no-op (converged, no dead loop)', isNoop(p404r2) && p404r2.errors.length === 0, JSON.stringify(p404r2))
      // 场景二（对照组）：父目录已存在；对端在扫描后、写入前于该子目录新建同名文件
      // → 查重列举命中 → 组内该文件仍被剔除（不覆盖对端版本），轮次按 REMOTE_CHANGED
      // 同类后果报错；下一轮按冲突收敛（策略 local）
      await fsp.writeFile(path.join(P404_LOCAL, 'sub-new', 'guard.txt'), 'p404-local-guard')
      const guardRemote = path.join(ROOT, 'p404', 'sub-new', 'guard.txt')
      let guardCreated = false
      let p404err = null
      try {
        await syncP(P404_LOCAL, '/p404', undefined, {
          onProgress: (p) => {
            if (p.phase === 'plan' && !guardCreated) {
              guardCreated = true
              fs.writeFileSync(guardRemote, 'PEER-CREATED-GUARD')
            }
          },
        })
      } catch (e) {
        p404err = e
      }
      check(
        'P404 existing-parent group still drops on peer-created same name',
        !!p404err && /写前查重发现远端已出现同名文件/.test(p404err.message),
        p404err && p404err.message
      )
      check(
        'P404 peer version preserved; local version intact',
        (await fsp.readFile(guardRemote, 'utf-8')) === 'PEER-CREATED-GUARD' && (await fsp.readFile(path.join(P404_LOCAL, 'sub-new', 'guard.txt'), 'utf-8')) === 'p404-local-guard'
      )
      const p404r4 = await syncP(P404_LOCAL, '/p404', { ...SP, conflictStrategy: 'local' })
      check(
        'P404 next round converges via conflict (subdir group)',
        p404r4.conflicts === 1 && p404r4.uploaded === 1 && (await fsp.readFile(guardRemote, 'utf-8')) === 'p404-local-guard',
        JSON.stringify(p404r4)
      )
      await fsp.rm(P404_LOCAL, { recursive: true, force: true })
      await fsp.rm(path.join(ROOT, 'p404'), { recursive: true, force: true })
    } finally {
      await setProfile('p1')
    }
  })

  // L13（P1 / A 档）：按需让出 —— 写轮遇他机持锁 → 规划后让出（请求时序上锁 GET 在
  // 全部扫描 PROPFIND 之后、无锁 PUT / 无用户写）、零传输、totalFiles===0、planned 有值；
  // 他机锁释放后下一轮正常完成
  await section('L13：按需让出信息字段', async () => {
    await freshStore('l13')
    const L13_LOCAL = await tmpLocal('l13')
    const l13lock = path.join(ROOT, 'l13', '.webdav-sync.lock')
    await fsp.writeFile(path.join(L13_LOCAL, 'a.txt'), 'l13-a')
    await fsp.writeFile(path.join(L13_LOCAL, 'b.txt'), 'l13-b')
    await fsp.mkdir(path.join(ROOT, 'l13'), { recursive: true })
    await fsp.writeFile(l13lock, JSON.stringify({ v: 1, deviceId: 'device-peer-l13', startedAt: new Date().toISOString(), ttlMs: 180000 }))
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      const l13s1 = await syncP(L13_LOCAL, '/l13')
      const lines = await readReqlog()
      const lastPropIdx = lines.map((l, i) => (l.startsWith('PROPFIND') ? i : -1)).filter((i) => i >= 0).pop()
      const lockGetIdx = lines.findIndex((l) => l === 'GET /dav/l13/.webdav-sync.lock')
      check(
        'L13 write round yields after planning: zero transfers, totalFiles=0, planned set',
        l13s1.yielded === true && l13s1.uploaded === 0 && l13s1.downloaded === 0 && l13s1.totalFiles === 0 && l13s1.planned === 2 && l13s1.warnings.some((w) => /另一设备正在同步/.test(w)),
        JSON.stringify(l13s1)
      )
      check(
        'L13 lock GET after all scan PROPFINDs; no lock PUT / no user write in yielded round',
        lastPropIdx != null && lockGetIdx > lastPropIdx && countReq(lines, 'PUT', '/dav/l13/.webdav-sync.lock') === 0 && !lines.some((l) => l.startsWith('PUT /dav/l13/') && !l.includes('.wdsync-') && !l.includes('.webdav-sync.lock')),
        lines.join(' | ')
      )
      check('L13 peer lock intact after yielded round', (await fsp.readFile(l13lock, 'utf-8')).includes('device-peer-l13'))
      await fsp.rm(l13lock, { force: true })
      const l13s2 = await syncP(L13_LOCAL, '/l13')
      check(
        'L13 next round completes normally after peer releases',
        l13s2.uploaded === 2 && l13s2.errors.length === 0 && !l13s2.yielded && !fs.existsSync(l13lock),
        JSON.stringify(l13s2)
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
    }
    await fsp.rm(L13_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l13'), { recursive: true, force: true })
  })

  // L14（P1 / A 档）：lockLeftover 补删不随锁后置移动 —— 空轮也清。delefail 制造
  //「释放失败 → 左锁标记 + 远端锁残留」，去标记后跑一个空轮（无任何远端写 → 不拿锁）：
  // 轮首补删请求（DELETE 锁）仍发出、标记清除、轮次 no-op 且全程无锁 GET/PUT
  await section('L14：空轮左锁清理', async () => {
    await freshStore('l14')
    const L14_LOCAL = await tmpLocal('l14')
    const l14lock = path.join(ROOT, 'l14', '.webdav-sync.lock')
    const l14dir = { id: 'l14', localPath: L14_LOCAL, remotePath: '/l14', mode: 'two-way' }
    await fsp.writeFile(path.join(L14_LOCAL, 'a.txt'), 'l14-a')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-delefail'), 'x')
    try {
      const l14r1 = await syncP(L14_LOCAL, '/l14')
      check(
        'L14 setup: release fails, leftover mark recorded',
        l14r1.uploaded === 1 && fs.existsSync(l14lock) && !!(await services.sync._internals.getDirMeta(l14dir)).lockLeftover,
        JSON.stringify(l14r1.warnings)
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-delefail'), { force: true }).catch(() => {})
    }
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      const l14r2 = await syncP(L14_LOCAL, '/l14')
      const lines = await readReqlog()
      check(
        'L14 empty round still cleans leftover lock at round start (DELETE issued, mark cleared, round no-op)',
        isNoop(l14r2) && countReq(lines, 'DELETE', '/dav/l14/.webdav-sync.lock') === 1 && !(await services.sync._internals.getDirMeta(l14dir)).lockLeftover && !fs.existsSync(l14lock),
        lines.join(' | ')
      )
      check(
        'L14 empty round issues no other lock traffic (no GET/PUT)',
        countReq(lines, 'GET', '/dav/l14/.webdav-sync.lock') === 0 && countReq(lines, 'PUT', '/dav/l14/.webdav-sync.lock') === 0,
        lines.join(' | ')
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
    }
    await fsp.rm(L14_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l14'), { recursive: true, force: true })
  })

  // ============================================================
  // CA 系列：取消中断在途传输
  // 依赖 dav-server 的 .wdsync-test-throttle（路径含 throttle 的 GET/PUT 按 64KB 块
  // 节流，把 12MB 传输拉长到 ~2s，制造「传一半」的取消窗口）与 reqlog 的 !ABORT 行
  //（客户端销毁连接、响应未写完时记录）。断言面：取消即时生效（远小于传完）、在途
  // 请求被服务器观察到中断、临时文件即时清理、被中止文件不写基线 / 不进失败表 /
  // 不产生错误噪声、已完成的文件基线保留、取消轮照常释放租约锁。
  // 取消的上传 intent 不再以 abort 了结（服务器可能已收字节）；配合
  // .wdsync-test-partialput（PUT 边收边落盘），「取消留半截」由服务器真实模拟而非
  // 手写文件。下一轮 recoverIntents 半截判定链命中 → 强制重传，
  // 断言零冲突零弹窗。CA1/CA4/CA6 不涉及上传意图，保持原语义。
  // CA1/CA2/CA4/CA6 在默认 p1（A 档），CA3 在 p2（B 档）；「拿锁后取消 → 锁照常
  // 释放」另由 L4 覆盖（transfer 期取消 + 释放）。
  // ============================================================

  /** 设置 / 清除节流标记（ms = 每块延迟；null = 清除） */
  const setThrottle = async (ms) => {
    if (ms) fs.writeFileSync(path.join(ROOT, '.wdsync-test-throttle'), String(ms))
    else await fsp.rm(path.join(ROOT, '.wdsync-test-throttle'), { force: true }).catch(() => {})
  }
  /** 轮询 reqlog 直到谓词命中（超时抛错）；返回当时全部行 */
  const waitForReqLine = async (pred, timeoutMs = 15000) => {
    const t0 = Date.now()
    for (;;) {
      const lines = await readReqlog()
      if (pred(lines)) return lines
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitForReqLine 超时（${timeoutMs}ms）`)
      await sleep(30)
    }
  }
  /**
   * 等待 !ABORT 行出现（短超时）：服务器侧的连接关闭事件可能比客户端轮次收尾
   * 晚几十毫秒（服务器还在消费被中断的请求体），断言用轮询而非单次读取
   */
  const waitAbortLine = (method, urlPath) =>
    waitForReqLine((ls) => ls.some((l) => l === `!ABORT ${method} ${urlPath}`), 5000)
  /**
   * 起一轮同步，并在「目标请求行出现在 reqlog 且再过 warmMs」后置位取消标记 ——
   * 此时该传输必然在途（节流保证剩余时长 ≥1s）。返回 { err, summary, sawBytes,
   * abortToSettleMs }：err 为 null 表示轮次正常返回（取消失败形态）；sawBytes 记录
   * onProgress 是否观察到字节推进（引擎进度按文件粒度推进，小文件先完成即计）。
   */
  const runCancelRound = async (lp, rp, targetLine, warmMs, prefs) => {
    let abort = false
    let abortAt = 0
    let sawBytes = false
    const p = (async () => {
      try {
        const sum = await syncP(lp, rp, prefs, {
          shouldAbort: () => abort,
          onProgress: (ev) => {
            if (ev.phase === 'transfer' && ev.bytesDone > 0) sawBytes = true
          },
        })
        return { err: null, summary: sum }
      } catch (e) {
        return { err: e, summary: e.summary || null }
      }
    })()
    await waitForReqLine((ls) => ls.some((l) => l === targetLine))
    await sleep(warmMs)
    abortAt = Date.now()
    abort = true
    const r = await p
    return { ...r, sawBytes, abortToSettleMs: Date.now() - abortAt }
  }
  /** 读取某目录 WAL 的全部操作（e2e 形态断言用；损坏行忽略） */
  const readWalOps = async (d) => {
    const dir = await baselineDirOf(d)
    const text = await fsp.readFile(path.join(dir, 'wal.jsonl'), 'utf-8').catch(() => '')
    const ops = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        ops.push(JSON.parse(line).o)
      } catch {
        /* 损坏行不参与形态断言 */
      }
    }
    return ops
  }
  /** 递归收集本地目录中的引擎传输临时文件（.wdsync-dl- / .wdsync-verify-） */
  const findTempResidue = async (lp) => {
    const out = []
    const walk = async (dir) => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const ent of entries) {
        const abs = path.join(dir, ent.name)
        if (ent.isDirectory()) await walk(abs)
        else if (ent.name.startsWith('.wdsync-dl-') || ent.name.startsWith('.wdsync-verify-')) out.push(abs)
      }
    }
    await walk(lp)
    return out
  }

  await slowSection('CA：取消中断在途传输', '节流制造的真实秒级「传一半」取消窗口（每用例 0.4–2s）× A/B 档全覆盖；取消语义的快路径仍由 L4 覆盖', async () => {
    const BIG = 12 * 1024 * 1024

    // ---- CA1（P1 / A 档）：大文件下载中取消 ----
    await freshStore('ca1')
    const CA1_LOCAL = await tmpLocal('ca1')
    const ca1dir = { id: 'ca1', localPath: CA1_LOCAL, remotePath: '/ca1', mode: 'two-way' }
    const ca1big = Buffer.alloc(BIG)
    ca1big.fill('q')
    await fsp.mkdir(path.join(ROOT, 'ca1'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'ca1', 'big-throttle.bin'), ca1big)
    await fsp.writeFile(path.join(ROOT, 'ca1', 'small.txt'), 'ca1-small')
    await setThrottle(10)
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      const r = await runCancelRound(CA1_LOCAL, '/ca1', 'GET /dav/ca1/big-throttle.bin', 500)
      check('CA1 cancelled download round ends with abort message', !!r.err && /中止/.test(r.err.message) && r.err.phase === 'execute', r.err && r.err.message)
      check('CA1 cancel takes effect far before the throttled transfer finishes', r.abortToSettleMs > 0 && r.abortToSettleMs < 1000 && r.sawBytes, `settle=${r.abortToSettleMs}ms（完整传输约 1900ms）bytesObserved=${r.sawBytes}`)
      const lines = await waitAbortLine('GET', '/dav/ca1/big-throttle.bin')
      check('CA1 server observed the in-flight GET aborted', lines.some((l) => l === '!ABORT GET /dav/ca1/big-throttle.bin'), lines.filter((l) => l.startsWith('!ABORT')).join(' | '))
      check('CA1 download temp file removed immediately on cancel', (await findTempResidue(CA1_LOCAL)).length === 0)
      check(
        'CA1 aborted download writes no baseline; completed file keeps its baseline',
        (await services.sync._internals.baselineEntry(ca1dir, 'big-throttle.bin')) === null && !!(await services.sync._internals.baselineEntry(ca1dir, 'small.txt'))
      )
      check(
        'CA1 abort never enters the failure table or error noise',
        Object.keys(await services.sync._internals.getFailures(ca1dir)).length === 0 && !((r.summary && r.summary.errors) || []).some((m) => /big-throttle/.test(m)),
        JSON.stringify((r.summary && r.summary.errors) || [])
      )
      const walOps = await readWalOps(ca1dir)
      const intents = walOps.filter((o) => o.t === 'intent' && o.rel === 'big-throttle.bin')
      const settledIds = new Set(walOps.filter((o) => o.t === 'abort' || o.t === 'done').map((o) => o.id))
      check(
        'CA1 WAL: aborted download intent settled with abort (no dangling intent)',
        intents.length === 1 && walOps.some((o) => o.t === 'abort' && o.id === intents[0].id) && [...intents].every((i) => settledIds.has(i.id)),
        JSON.stringify(walOps)
      )
      await setThrottle(null)
      const ca1b = await syncP(CA1_LOCAL, '/ca1')
      check('CA1 next round re-plans and completes the aborted download', ca1b.errors.length === 0 && ca1b.downloaded === 1, JSON.stringify(ca1b))
      const ca1got = await fsp.readFile(path.join(CA1_LOCAL, 'big-throttle.bin'))
      check('CA1 converged content equals the remote original', ca1got.length === ca1big.length && ca1got.equals(ca1big))
      check('CA1 no temp residue after converging round', (await findTempResidue(CA1_LOCAL)).length === 0)
      check('CA1 follow-up round is a no-op', isNoop(await syncP(CA1_LOCAL, '/ca1')))
    } finally {
      await setThrottle(null)
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
      await fsp.rm(CA1_LOCAL, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'ca1'), { recursive: true, force: true }).catch(() => {})
    }

    // ---- CA2（P1 / A 档）：大文件上传中取消 → 服务器真实保留半截 → 下轮自动重传 ----
    // partialput 档下服务器真实保留已收字节，下一轮半截判定链自动识别并
    // 强制重传：零冲突、零弹窗（取消的上传 intent 保持开放，见节头说明）
    await freshStore('ca2')
    const CA2_LOCAL = await tmpLocal('ca2')
    const ca2dir = { id: 'ca2', localPath: CA2_LOCAL, remotePath: '/ca2', mode: 'two-way' }
    const ca2big = Buffer.alloc(BIG)
    ca2big.fill('z')
    await fsp.writeFile(path.join(CA2_LOCAL, 'up-throttle.bin'), ca2big)
    await fsp.writeFile(path.join(CA2_LOCAL, 'small.txt'), 'ca2-small')
    await setThrottle(10)
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-partialput'), 'x')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      const r = await runCancelRound(CA2_LOCAL, '/ca2', 'PUT /dav/ca2/up-throttle.bin', 500)
      check('CA2 cancelled upload round ends with abort message', !!r.err && /中止/.test(r.err.message), r.err && r.err.message)
      check('CA2 cancel interrupts the in-flight PUT promptly', r.abortToSettleMs > 0 && r.abortToSettleMs < 1000, `settle=${r.abortToSettleMs}ms`)
      const lines = await waitAbortLine('PUT', '/dav/ca2/up-throttle.bin')
      check('CA2 server observed the in-flight PUT aborted', lines.some((l) => l === '!ABORT PUT /dav/ca2/up-throttle.bin'), lines.filter((l) => l.startsWith('!ABORT')).join(' | '))
      const ca2localAfter = await fsp.readFile(path.join(CA2_LOCAL, 'up-throttle.bin'))
      check('CA2 local original intact after cancelled upload', ca2localAfter.length === ca2big.length && ca2localAfter.equals(ca2big))
      check(
        'CA2 completed upload before cancel is committed (abort-round batch verify settles it)',
        !!r.summary && r.summary.uploaded === 1 && !!(await services.sync._internals.baselineEntry(ca2dir, 'small.txt')) && fs.existsSync(path.join(ROOT, 'ca2', 'small.txt')),
        JSON.stringify(r.summary)
      )
      // 4.7：partialput 档下取消的 PUT 真实保留半截（非零、小于全量、内容恰为本地前缀）
      const ca2HalfPath = path.join(ROOT, 'ca2', 'up-throttle.bin')
      const ca2HalfSize = fs.existsSync(ca2HalfPath) ? fs.statSync(ca2HalfPath).size : -1
      check(
        'CA2 partialput server really kept the truncated upload (0 < size < full, exact prefix)',
        ca2HalfSize > 0 && ca2HalfSize < ca2big.length && (await fsp.readFile(ca2HalfPath)).equals(ca2big.subarray(0, ca2HalfSize)),
        `half=${ca2HalfSize} full=${ca2big.length}`
      )
      check('CA2 lease released after in-flight cancel (held since pre-workers)', !fs.existsSync(path.join(ROOT, 'ca2', '.webdav-sync.lock')))
      check(
        'CA2 abort never enters the failure table or error noise',
        Object.keys(await services.sync._internals.getFailures(ca2dir)).length === 0 && !((r.summary && r.summary.errors) || []).some((m) => /up-throttle/.test(m)),
        JSON.stringify((r.summary && r.summary.errors) || [])
      )
      // 取消的上传 intent 不写 abort —— 保持开放，供下一轮半截判定
      const walOps = await readWalOps(ca2dir)
      const intents = walOps.filter((o) => o.t === 'intent' && o.rel === 'up-throttle.bin')
      const settledIds = new Set(walOps.filter((o) => o.t === 'abort' || o.t === 'done').map((o) => o.id))
      check(
        'CA2 WAL: cancelled upload intent left OPEN (no abort) for next-round half detection',
        intents.length === 1 && !settledIds.has(intents[0].id) && intents[0].remote === null && typeof intents[0].at === 'number',
        JSON.stringify(walOps)
      )
      // 下一轮：半截判定链命中 → 强制重传（4.4），零冲突零弹窗
      await setThrottle(null)
      let ca2Conflicts = 0
      const ca2b = await syncP(CA2_LOCAL, '/ca2', undefined, {
        onConflict: async () => {
          ca2Conflicts++
          return 'local'
        },
      })
      check(
        'CA2 next round auto-detects the partial and re-uploads with ZERO conflicts/dialogs',
        ca2b.errors.length === 0 && ca2b.uploaded === 1 && ca2b.conflicts === 0 && ca2Conflicts === 0 && ca2b.warnings.some((w) => /半截/.test(w)),
        `calls=${ca2Conflicts} ${JSON.stringify({ ...ca2b, warnings: ca2b.warnings })}`
      )
      const ca2remote = await fsp.readFile(path.join(ROOT, 'ca2', 'up-throttle.bin'))
      check('CA2 remote ends byte-equal to local after auto re-upload', ca2remote.length === ca2big.length && ca2remote.equals(ca2big))
      check('CA2 WAL truncated empty after convergence round', (await readWalOps(ca2dir)).length === 0)
      check('CA2 follow-up round is a no-op', isNoop(await syncP(CA2_LOCAL, '/ca2')))
    } finally {
      await setThrottle(null)
      await fsp.rm(path.join(ROOT, '.wdsync-test-partialput'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
      await fsp.rm(CA2_LOCAL, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'ca2'), { recursive: true, force: true }).catch(() => {})
    }

    // ---- CA3（P2 / B 档）：大文件上传中取消（B 档：查重 + 复查守卫下的取消路径）----
    // 同 CA2：partialput 真实半截 + 下轮半截判定强制重传（B 档复查守卫用本轮扫描指纹）
    await setProfile('p2')
    try {
      await freshStore('ca3')
      const CA3_LOCAL = await tmpLocal('ca3')
      const ca3dir = { id: 'ca3', localPath: CA3_LOCAL, remotePath: '/ca3', mode: 'two-way' }
      const ca3big = Buffer.alloc(BIG)
      ca3big.fill('b')
      await fsp.writeFile(path.join(CA3_LOCAL, 'up-throttle.bin'), ca3big)
      await fsp.writeFile(path.join(CA3_LOCAL, 'small.txt'), 'ca3-small')
      await setThrottle(10)
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-partialput'), 'x')
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
      try {
        const r = await runCancelRound(CA3_LOCAL, '/ca3', 'PUT /dav/ca3/up-throttle.bin', 500)
        check('CA3 (B tier) cancelled upload round ends with abort message', !!r.err && /中止/.test(r.err.message), r.err && r.err.message)
        check('CA3 (B tier) cancel interrupts the in-flight PUT promptly', r.abortToSettleMs > 0 && r.abortToSettleMs < 1000, `settle=${r.abortToSettleMs}ms`)
        const lines = await waitAbortLine('PUT', '/dav/ca3/up-throttle.bin')
        check('CA3 (B tier) server observed the in-flight PUT aborted', lines.some((l) => l === '!ABORT PUT /dav/ca3/up-throttle.bin'), lines.filter((l) => l.startsWith('!ABORT')).join(' | '))
        check(
          'CA3 (B tier) abort never enters the failure table or error noise',
          Object.keys(await services.sync._internals.getFailures(ca3dir)).length === 0 && !((r.summary && r.summary.errors) || []).some((m) => /up-throttle/.test(m)),
          JSON.stringify((r.summary && r.summary.errors) || [])
        )
        check('CA3 (B tier) completed upload committed and lease released on cancel', !!r.summary && r.summary.uploaded === 1 && !fs.existsSync(path.join(ROOT, 'ca3', '.webdav-sync.lock')), JSON.stringify(r.summary))
        const ca3HalfPath = path.join(ROOT, 'ca3', 'up-throttle.bin')
        const ca3HalfSize = fs.existsSync(ca3HalfPath) ? fs.statSync(ca3HalfPath).size : -1
        check(
          'CA3 (B tier) partialput server really kept the truncated upload',
          ca3HalfSize > 0 && ca3HalfSize < ca3big.length && (await fsp.readFile(ca3HalfPath)).equals(ca3big.subarray(0, ca3HalfSize)),
          `half=${ca3HalfSize} full=${ca3big.length}`
        )
        const walOps3 = await readWalOps(ca3dir)
        const intents3 = walOps3.filter((o) => o.t === 'intent' && o.rel === 'up-throttle.bin')
        const settled3 = new Set(walOps3.filter((o) => o.t === 'abort' || o.t === 'done').map((o) => o.id))
        check('CA3 (B tier) cancelled upload intent left OPEN for half detection', intents3.length === 1 && !settled3.has(intents3[0].id), JSON.stringify(walOps3))
        // 下一轮：B 档复查守卫下强制重传半截（复查基准 = 本轮扫描到的半截指纹）
        await setThrottle(null)
        let ca3Conflicts = 0
        const ca3b = await syncP(CA3_LOCAL, '/ca3', undefined, {
          onConflict: async () => {
            ca3Conflicts++
            return 'local'
          },
        })
        check(
          'CA3 (B tier) next round auto-detects the partial and re-uploads with ZERO conflicts/dialogs',
          ca3b.errors.length === 0 && ca3b.uploaded === 1 && ca3b.conflicts === 0 && ca3Conflicts === 0,
          `calls=${ca3Conflicts} ${JSON.stringify(ca3b)}`
        )
        const ca3remote = await fsp.readFile(path.join(ROOT, 'ca3', 'up-throttle.bin'))
        check('CA3 (B tier) remote ends byte-equal to local after auto re-upload', ca3remote.length === ca3big.length && ca3remote.equals(ca3big))
        check('CA3 (B tier) follow-up round is a no-op', isNoop(await syncP(CA3_LOCAL, '/ca3')))
      } finally {
        await setThrottle(null)
        await fsp.rm(path.join(ROOT, '.wdsync-test-partialput'), { force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
        await fsp.rm(REQLOG, { force: true }).catch(() => {})
        await fsp.rm(CA3_LOCAL, { recursive: true, force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, 'ca3'), { recursive: true, force: true }).catch(() => {})
      }
    } finally {
      await setProfile('p1')
    }

    // ---- CA4（P1 / A 档）：规划期 verify 池的流式下载中取消 ----
    await freshStore('ca4')
    const CA4_LOCAL = await tmpLocal('ca4')
    const ca4dir = { id: 'ca4', localPath: CA4_LOCAL, remotePath: '/ca4', mode: 'two-way' }
    const ca4big = Buffer.alloc(BIG)
    ca4big.fill('v')
    await fsp.mkdir(path.join(ROOT, 'ca4'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'ca4', 'adopt-throttle.bin'), ca4big)
    await fsp.writeFile(path.join(CA4_LOCAL, 'adopt-throttle.bin'), ca4big)
    // 本地 mtime 拉开到容差外：无基线 + 双侧并存同 size → 规划期 verify（adopt）下载比对
    const ca4shift = new Date(Date.now() + 40000)
    await fsp.utimes(path.join(CA4_LOCAL, 'adopt-throttle.bin'), ca4shift, ca4shift)
    await setThrottle(10)
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      const r = await runCancelRound(CA4_LOCAL, '/ca4', 'GET /dav/ca4/adopt-throttle.bin', 400)
      check('CA4 cancelled verify round ends with abort message', !!r.err && /中止/.test(r.err.message), r.err && r.err.message)
      check('CA4 cancel interrupts the in-flight verify download promptly', r.abortToSettleMs > 0 && r.abortToSettleMs < 1000, `settle=${r.abortToSettleMs}ms`)
      const lines = await waitAbortLine('GET', '/dav/ca4/adopt-throttle.bin')
      check('CA4 server observed the in-flight verify GET aborted', lines.some((l) => l === '!ABORT GET /dav/ca4/adopt-throttle.bin'), lines.filter((l) => l.startsWith('!ABORT')).join(' | '))
      check('CA4 verify temp file removed immediately on cancel', (await findTempResidue(CA4_LOCAL)).length === 0)
      check('CA4 aborted verify writes no baseline and no failure record', (await services.sync._internals.baselineEntry(ca4dir, 'adopt-throttle.bin')) === null && Object.keys(await services.sync._internals.getFailures(ca4dir)).length === 0)
      await setThrottle(null)
      const ca4b = await syncP(CA4_LOCAL, '/ca4')
      check('CA4 next round adopts identical content without transfer', ca4b.errors.length === 0 && ca4b.adopted === 1 && ca4b.downloaded === 0, JSON.stringify(ca4b))
      check('CA4 follow-up round is a no-op', isNoop(await syncP(CA4_LOCAL, '/ca4')))
    } finally {
      await setThrottle(null)
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
      await fsp.rm(CA4_LOCAL, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'ca4'), { recursive: true, force: true }).catch(() => {})
    }

    // ---- CA6：规划期取消（拿锁前）→ 零锁请求；下一轮正常 ----
    await freshStore('ca6')
    const CA6_LOCAL = await tmpLocal('ca6')
    await fsp.writeFile(path.join(CA6_LOCAL, 'a.txt'), 'ca6-a')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      let ca6Abort = false
      let ca6err = null
      try {
        await syncP(CA6_LOCAL, '/ca6', undefined, {
          shouldAbort: () => ca6Abort,
          onProgress: (p) => {
            if (p.phase === 'plan') ca6Abort = true
          },
        })
      } catch (e) {
        ca6err = e
      }
      check('CA6 plan-phase cancel ends the round with abort message', !!ca6err && /中止/.test(ca6err.message), ca6err && ca6err.message)
      const lines = await readReqlog()
      check('CA6 cancel before lock acquisition issues zero lease-lock requests', lines.every((l) => !l.includes('.webdav-sync.lock')), lines.filter((l) => l.includes('.webdav-sync.lock')).join(' | '))
      check('CA6 cancelled round uploads nothing', !lines.some((l) => l.startsWith('PUT /dav/ca6/a.txt')) && !fs.existsSync(path.join(ROOT, 'ca6', 'a.txt')))
      const ca6b = await syncP(CA6_LOCAL, '/ca6')
      check('CA6 next round syncs normally after plan-phase cancel', ca6b.errors.length === 0 && ca6b.uploaded === 1, JSON.stringify(ca6b))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
      await fsp.rm(CA6_LOCAL, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'ca6'), { recursive: true, force: true }).catch(() => {})
    }
  })

  // ============================================================
  // PU 系列：半截上传的识别与自动重传 —— 恢复链路
  // 依赖 dav-server 的 .wdsync-test-netcut（收到第 N 块后主动断连 → 客户端以 NETWORK
  // 收场，区别于用户取消的 ABORTED；每路径最多切 M 次，内容 `N` 或 `N:M`）与
  // .wdsync-test-partialput（PUT 边收边落盘：断连时已收字节保留为半截）。netcut 无需
  // 节流与取消窗口，全部用例属快组；租约锁与本系列正交，统一关闭以省去每写轮 1.5s
  // 写回静置（锁语义由 L 系列覆盖）。PUP 关锁、其余与 SP 一致。
  // 覆盖：NETWORK 中断（非取消）自动重传 / 覆盖上传半截 / 对端改小前缀不符仍冲突 /
  // 超 verifyMaxBytes 冲突+提示 / 多开放 intent 去重 / 本地改/删后意图放弃无假重传 /
  // 原子服务器未落地正常覆盖 / 采纳内容确认（同 size 替换不采纳、GET 失败回退）/
  // WAL 截断保护与 30 天超龄 / 多设备他机收敛（P1 为主，PU11 覆盖 P7）。
  // ============================================================
  const PUP = { ...SP, leaseLock: false }
  const setNetcut = async (spec) => {
    if (spec) fs.writeFileSync(path.join(ROOT, '.wdsync-test-netcut'), spec)
    else await fsp.rm(path.join(ROOT, '.wdsync-test-netcut'), { force: true }).catch(() => {})
  }
  const setPartialPut = async (on) => {
    if (on) fs.writeFileSync(path.join(ROOT, '.wdsync-test-partialput'), 'x')
    else await fsp.rm(path.join(ROOT, '.wdsync-test-partialput'), { force: true }).catch(() => {})
  }
  /** 造一个 1MB 的填充文件内容（64KB × 16 块，netcut '2' 断在 128KB 处） */
  const puBuf = (ch) => {
    const b = Buffer.alloc(1024 * 1024)
    b.fill(ch)
    return b
  }

  await section('PU：半截上传识别与重传（恢复链路）', async () => {
    // ---- PU1：网络中断（非取消）+ partialput → 半截 → 自动重传；多开放 intent 去重 ----
    await freshStore('pu1')
    const PU1_LOCAL = await tmpLocal('pu1')
    const pu1dir = { id: 'pu1', localPath: PU1_LOCAL, remotePath: '/pu1', mode: 'two-way' }
    const pu1a = puBuf('a')
    await fsp.writeFile(path.join(PU1_LOCAL, 'cut-me.bin'), pu1a)
    await fsp.writeFile(path.join(PU1_LOCAL, 'ok.txt'), 'pu1-ok')
    await setPartialPut(true)
    await setNetcut('2') // 每路径不限次数：首次与当轮重试都被切断 → 轮次以 NETWORK 报错收场
    let pu1err = null
    try {
      await syncP(PU1_LOCAL, '/pu1', PUP)
    } catch (e) {
      pu1err = e
    }
    check(
      'PU1 netcut round fails with NETWORK error (not abort), same-round retry suppressed with a note',
      !!pu1err && /网络请求失败|ECONNRESET/.test(pu1err.message) && /本轮不再重试/.test(pu1err.errors ? pu1err.errors[0] : pu1err.message),
      pu1err && pu1err.message
    )
    check('PU1 sibling file still committed in the failed round', (await services.sync._internals.baselineEntry(pu1dir, 'ok.txt')) != null)
    const pu1Half = path.join(ROOT, 'pu1', 'cut-me.bin')
    const pu1HalfSize = fs.existsSync(pu1Half) ? fs.statSync(pu1Half).size : -1
    check('PU1 server kept a real partial (prefix of local)', pu1HalfSize > 0 && pu1HalfSize < pu1a.length && (await fsp.readFile(pu1Half)).equals(pu1a.subarray(0, pu1HalfSize)), `half=${pu1HalfSize}`)
    const pu1ops = await readWalOps(pu1dir)
    const pu1intents = pu1ops.filter((o) => o.t === 'intent' && o.rel === 'cut-me.bin')
    const pu1settled = new Set(pu1ops.filter((o) => o.t === 'abort' || o.t === 'done').map((o) => o.id))
    check(
      'PU1 WAL: ONE attempt (retry suppressed) → one open intent carrying remote=null + at',
      pu1intents.length === 1 && !pu1settled.has(pu1intents[0].id) && pu1intents[0].remote === null && typeof pu1intents[0].at === 'number',
      JSON.stringify(pu1ops)
    )
    check('PU1 WAL not truncated while an intent is open', (await fsp.readFile(path.join(await baselineDirOf(pu1dir), 'wal.jsonl'), 'utf-8')).includes('"intent"'))
    await setNetcut(null)
    await setPartialPut(false)
    let pu1calls = 0
    const pu1b = await syncP(PU1_LOCAL, '/pu1', PUP, {
      onConflict: async () => {
        pu1calls++
        return 'local'
      },
    })
    check(
      'PU1 next round auto re-uploads the partial with zero conflicts/dialogs',
      pu1b.errors.length === 0 && pu1b.uploaded === 1 && pu1b.conflicts === 0 && pu1calls === 0 && pu1b.warnings.some((w) => /半截/.test(w)),
      `calls=${pu1calls} ${JSON.stringify({ ...pu1b, warnings: pu1b.warnings })}`
    )
    check('PU1 converged remote equals local', (await fsp.readFile(pu1Half)).equals(pu1a))
    check('PU1 WAL truncated empty after convergence', (await readWalOps(pu1dir)).length === 0)
    check('PU1 follow-up round is a no-op', isNoop(await syncP(PU1_LOCAL, '/pu1', PUP)))
    await fsp.rm(PU1_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu1'), { recursive: true, force: true }).catch(() => {})

    // ---- PU5：同 rel 多个开放意图去重（跨轮残留 + 注入历史意图）----
    // 同轮重试已按 4.2 抑制，多个开放意图只剩「跨轮残留 / 崩溃窗口」一种来源 —— 用例
    // 在真实开放意图之外手工注入一条更早的开放意图行（同编码 / 同 CRC），验证恢复期
    // 对多条意图幂等去重：单次半截提示、单次重传、全部被新意图取代
    await freshStore('pu5')
    const PU5_LOCAL = await tmpLocal('pu5')
    const pu5dir = { id: 'pu5', localPath: PU5_LOCAL, remotePath: '/pu5', mode: 'two-way' }
    const pu5buf = puBuf('5')
    await fsp.writeFile(path.join(PU5_LOCAL, 'dup.bin'), pu5buf)
    await setPartialPut(true)
    await setNetcut('2')
    try {
      await syncP(PU5_LOCAL, '/pu5', PUP)
    } catch {
      /* 期望失败：留下开放意图 + 半截 */
    }
    await setNetcut(null)
    await setPartialPut(false)
    // 注入一条同 rel 的更早开放意图（模拟上一轮残留），重载存储使其参与折叠
    const pu5walPath = path.join(await baselineDirOf(pu5dir), 'wal.jsonl')
    const pu5st0 = await fsp.stat(path.join(PU5_LOCAL, 'dup.bin'))
    const pu5extra = storeModule._internals.encodeLine(1, {
      t: 'intent',
      id: 'pu5-injected-old',
      op: 'upload',
      rel: 'dup.bin',
      at: Date.now() - 3600_000,
      local: { size: pu5st0.size, mtimeMs: pu5st0.mtimeMs },
      remote: null,
    })
    await fsp.appendFile(pu5walPath, pu5extra)
    // wal 位于 <storageRoot>/baselines/<h>/wal.jsonl：剥掉 wal.jsonl/<h>/baselines 三段才是
    // 存储根；重设同一根以强制重载（折叠出两条开放意图）
    await switchDevice(path.resolve(pu5walPath, '..', '..', '..'))
    let pu5calls = 0
    const pu5b = await syncP(PU5_LOCAL, '/pu5', PUP, {
      onConflict: async () => {
        pu5calls++
        return 'local'
      },
    })
    const pu5halfWarns = pu5b.warnings.filter((w) => /半截/.test(w))
    check(
      'PU5 multiple open intents dedup to ONE half warning + ONE forced re-upload (zero conflicts)',
      pu5b.errors.length === 0 && pu5b.uploaded === 1 && pu5b.conflicts === 0 && pu5calls === 0 && pu5halfWarns.length === 1,
      `calls=${pu5calls} warns=${pu5halfWarns.length} ${JSON.stringify({ ...pu5b, warnings: pu5b.warnings })}`
    )
    check('PU5 converged remote equals local', (await fsp.readFile(path.join(ROOT, 'pu5', 'dup.bin'))).equals(pu5buf))
    check('PU5 WAL truncated empty after convergence (all superseded/settled)', (await readWalOps(pu5dir)).length === 0)
    check('PU5 follow-up round is a no-op', isNoop(await syncP(PU5_LOCAL, '/pu5', PUP)))
    await fsp.rm(PU5_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu5'), { recursive: true, force: true }).catch(() => {})

    // ---- PU2：覆盖上传半截（远端原有旧内容被半截替换）→ 自动重传 ----
    await freshStore('pu2')
    const PU2_LOCAL = await tmpLocal('pu2')
    const pu2dir = { id: 'pu2', localPath: PU2_LOCAL, remotePath: '/pu2', mode: 'two-way' }
    const pu2v1 = Buffer.alloc(256 * 1024)
    pu2v1.fill('1')
    const pu2v2 = puBuf('2')
    await fsp.writeFile(path.join(PU2_LOCAL, 'over.bin'), pu2v1)
    const pu2s0 = await syncP(PU2_LOCAL, '/pu2', PUP)
    check('PU2 setup uploads v1', pu2s0.uploaded === 1 && pu2s0.errors.length === 0, JSON.stringify(pu2s0))
    await fsp.writeFile(path.join(PU2_LOCAL, 'over.bin'), pu2v2)
    await setPartialPut(true)
    await setNetcut('2')
    let pu2err = null
    try {
      await syncP(PU2_LOCAL, '/pu2', PUP)
    } catch (e) {
      pu2err = e
    }
    check('PU2 overwrite upload interrupted with NETWORK', !!pu2err && /网络请求失败|ECONNRESET/.test(pu2err.message), pu2err && pu2err.message)
    const pu2remoteNow = await fsp.readFile(path.join(ROOT, 'pu2', 'over.bin'))
    check(
      'PU2 remote old content replaced by a real prefix of v2 (not v1)',
      pu2remoteNow.length > 0 && pu2remoteNow.length < pu2v2.length && pu2remoteNow.equals(pu2v2.subarray(0, pu2remoteNow.length)),
      `size=${pu2remoteNow.length}`
    )
    await setNetcut(null)
    await setPartialPut(false)
    let pu2calls = 0
    const pu2b = await syncP(PU2_LOCAL, '/pu2', PUP, {
      onConflict: async () => {
        pu2calls++
        return 'local'
      },
    })
    check(
      'PU2 next round detects the half and re-uploads with zero conflicts (intent.remote = pre-PUT v1 fp)',
      pu2b.errors.length === 0 && pu2b.uploaded === 1 && pu2b.conflicts === 0 && pu2calls === 0,
      `calls=${pu2calls} ${JSON.stringify(pu2b)}`
    )
    check('PU2 converged remote equals v2', (await fsp.readFile(path.join(ROOT, 'pu2', 'over.bin'))).equals(pu2v2))
    check('PU2 follow-up round is a no-op', isNoop(await syncP(PU2_LOCAL, '/pu2', PUP)))
    await fsp.rm(PU2_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu2'), { recursive: true, force: true }).catch(() => {})

    // ---- PU3：对端真实改小且前缀不符 → 仍冲突（无提示，意图放弃）----
    await freshStore('pu3')
    const PU3_LOCAL = await tmpLocal('pu3')
    const pu3dir = { id: 'pu3', localPath: PU3_LOCAL, remotePath: '/pu3', mode: 'two-way' }
    const pu3buf = puBuf('3')
    await fsp.writeFile(path.join(PU3_LOCAL, 'peer.bin'), pu3buf)
    await setPartialPut(true)
    await setNetcut('2')
    try {
      await syncP(PU3_LOCAL, '/pu3', PUP)
    } catch {
      /* 期望失败：留下开放意图 + 半截 */
    }
    await setNetcut(null)
    await setPartialPut(false)
    // 模拟对端把远端改成「小于本地但内容并非本地前缀」的文件
    const pu3peer = Buffer.alloc(100 * 1024)
    pu3peer.fill('X')
    await fsp.writeFile(path.join(ROOT, 'pu3', 'peer.bin'), pu3peer)
    let pu3info = null
    const pu3b = await syncP(PU3_LOCAL, '/pu3', PUP, {
      onConflict: async (info) => {
        pu3info = info
        return 'local'
      },
    })
    check(
      'PU3 peer-shrunk non-prefix file still yields a conflict (no auto re-upload, no hint)',
      pu3b.conflicts === 1 && pu3b.uploaded === 1 && pu3info != null && pu3info.hint === undefined,
      `hint=${pu3info && pu3info.hint} ${JSON.stringify(pu3b)}`
    )
    check(
      'PU3 prefix mismatch settles the intent as NOT-ours (recovery warning, dropped marker)',
      pu3b.warnings.some((w) => /非本机半截/.test(w)),
      JSON.stringify(pu3b.warnings)
    )
    check('PU3 converged after user choice local', (await fsp.readFile(path.join(ROOT, 'pu3', 'peer.bin'))).equals(pu3buf))
    await fsp.rm(PU3_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu3'), { recursive: true, force: true }).catch(() => {})

    // ---- PU4：超 verifyMaxBytes → 冲突 + 提示文案（意图保持开放）----
    await freshStore('pu4')
    const PU4_LOCAL = await tmpLocal('pu4')
    const pu4dir = { id: 'pu4', localPath: PU4_LOCAL, remotePath: '/pu4', mode: 'two-way' }
    const pu4buf = puBuf('4')
    await fsp.writeFile(path.join(PU4_LOCAL, 'huge.bin'), pu4buf)
    await setPartialPut(true)
    await setNetcut('2')
    try {
      await syncP(PU4_LOCAL, '/pu4', PUP)
    } catch {
      /* 期望失败：留下开放意图 + 半截 */
    }
    await setNetcut(null)
    await setPartialPut(false)
    let pu4info = null
    let pu4warn = []
    const pu4b = await services.sync.syncDirectory(
      cfg,
      { id: 'pu4', localPath: PU4_LOCAL, remotePath: '/pu4', mode: 'two-way' },
      { ...PUP, verifyMaxBytes: 1024 },
      {
        onConflict: async (info) => {
          pu4info = info
          return 'local'
        },
      }
    )
    pu4warn = pu4b.warnings
    check(
      'PU4 over-limit partial stays a conflict WITH the partial-upload hint',
      pu4b.conflicts === 1 && pu4b.uploaded === 1 && pu4info != null && pu4info.hint === 'partial-upload' && pu4warn.some((w) => /超过内容校验上限/.test(w)),
      `hint=${pu4info && pu4info.hint} ${JSON.stringify(pu4warn)}`
    )
    // 注：轮末 WAL 必然截断为空（冲突解决的落地意图了结了开放意图）；「冲突时刻意图
    // 仍开放」这一事实由上方 hint==='partial-upload' 断言直接证明（hint 条件 = 开放
    // upload 意图 + 远端小于本地），无需再读 WAL
    check('PU4 converged after user choice local', (await fsp.readFile(path.join(ROOT, 'pu4', 'huge.bin'))).equals(pu4buf))
    await fsp.rm(PU4_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu4'), { recursive: true, force: true }).catch(() => {})

    // ---- PU6：本地文件在 intent 之后被改 / 被删 → 意图放弃、无假重传 ----
    // (a) 本地删除：意图在恢复期放弃（本地已不存在），远端半截按「仅远端存在 → 下载」收敛
    await freshStore('pu6a')
    const PU6A_LOCAL = await tmpLocal('pu6a')
    const pu6adir = { id: 'pu6a', localPath: PU6A_LOCAL, remotePath: '/pu6a', mode: 'two-way' }
    const pu6abuf = puBuf('6')
    await fsp.writeFile(path.join(PU6A_LOCAL, 'gone.bin'), pu6abuf)
    await setPartialPut(true)
    await setNetcut('2')
    try {
      await syncP(PU6A_LOCAL, '/pu6a', PUP)
    } catch {
      /* 期望失败 */
    }
    await setNetcut(null)
    await setPartialPut(false)
    const pu6aops1 = await readWalOps(pu6adir)
    const pu6aopen = pu6aops1.filter((o) => o.t === 'intent' && o.rel === 'gone.bin').pop()
    check('PU6a setup leaves an open intent (recovery input)', pu6aopen != null && pu6aops1.every((o) => o.t !== 'abort' || o.id !== pu6aopen.id), JSON.stringify(pu6aops1))
    await fsp.unlink(path.join(PU6A_LOCAL, 'gone.bin'))
    const pu6a = await syncP(PU6A_LOCAL, '/pu6a', PUP)
    check(
      'PU6a deleted local → intent aborted at recovery, half downloaded back, no forced upload, no conflict',
      pu6a.downloaded === 1 && pu6a.conflicts === 0 && pu6a.uploaded === 0 && pu6a.warnings.some((w) => /本地文件已变化或不存在/.test(w)),
      JSON.stringify({ ...pu6a, warnings: pu6a.warnings })
    )
    check(
      'PU6a local now holds the half content (documented peer-visible half)',
      (await fsp.readFile(path.join(PU6A_LOCAL, 'gone.bin'))).equals(pu6abuf.subarray(0, fs.statSync(path.join(ROOT, 'pu6a', 'gone.bin')).size))
    )
    await fsp.rm(PU6A_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu6a'), { recursive: true, force: true }).catch(() => {})
    // (b) 本地修改（独立场景，无基线）：意图放弃，双侧并存 size 不同 → 冲突（绝不按旧意图假重传）
    await freshStore('pu6b')
    const PU6B_LOCAL = await tmpLocal('pu6b')
    const pu6bbufOld = puBuf('6')
    await fsp.writeFile(path.join(PU6B_LOCAL, 'edited.bin'), pu6bbufOld)
    await setPartialPut(true)
    await setNetcut('2')
    try {
      await syncP(PU6B_LOCAL, '/pu6b', PUP)
    } catch {
      /* 期望失败 */
    }
    await setNetcut(null)
    await setPartialPut(false)
    const pu6bbufNew = puBuf('7')
    await fsp.writeFile(path.join(PU6B_LOCAL, 'edited.bin'), pu6bbufNew)
    let pu6bConflicts = 0
    const pu6b = await syncP(PU6B_LOCAL, '/pu6b', PUP, {
      onConflict: async () => {
        pu6bConflicts++
        return 'local'
      },
    })
    check(
      'PU6b modified local → conflict (conservative), never a forced re-upload',
      pu6b.conflicts === 1 && pu6bConflicts === 1 && pu6b.uploaded === 1,
      `calls=${pu6bConflicts} ${JSON.stringify(pu6b)}`
    )
    check('PU6b converged to modified local', (await fsp.readFile(path.join(ROOT, 'pu6b', 'edited.bin'))).equals(pu6bbufNew))
    await fsp.rm(PU6B_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu6b'), { recursive: true, force: true }).catch(() => {})

    // ---- PU7：服务器原子（断连不落字节）→ 正常覆盖上传，无冲突 ----
    await freshStore('pu7')
    const PU7_LOCAL = await tmpLocal('pu7')
    const pu7dir = { id: 'pu7', localPath: PU7_LOCAL, remotePath: '/pu7', mode: 'two-way' }
    const pu7v1 = Buffer.alloc(256 * 1024)
    pu7v1.fill('1')
    const pu7v2 = puBuf('9')
    await fsp.writeFile(path.join(PU7_LOCAL, 'atomic.bin'), pu7v1)
    await syncP(PU7_LOCAL, '/pu7', PUP)
    await fsp.writeFile(path.join(PU7_LOCAL, 'atomic.bin'), pu7v2)
    await setNetcut('2') // 不开 partialput：切断的 PUT 不落任何字节（原子服务器 + 网络中断）
    try {
      await syncP(PU7_LOCAL, '/pu7', PUP)
    } catch {
      /* 期望失败：开放意图 + 远端仍为完整 v1 */
    }
    await setNetcut(null)
    check('PU7 atomic server kept the OLD full content (no partial)', (await fsp.readFile(path.join(ROOT, 'pu7', 'atomic.bin'))).equals(pu7v1))
    let pu7calls = 0
    const pu7b = await syncP(PU7_LOCAL, '/pu7', PUP, {
      onConflict: async () => {
        pu7calls++
        return 'local'
      },
    })
    check(
      'PU7 atomic-untouched remote → normal overwrite re-upload, zero conflicts (remote == intent.remote, no half)',
      pu7b.errors.length === 0 && pu7b.uploaded === 1 && pu7b.conflicts === 0 && pu7calls === 0,
      `calls=${pu7calls} ${JSON.stringify(pu7b)}`
    )
    check('PU7 converged to v2', (await fsp.readFile(path.join(ROOT, 'pu7', 'atomic.bin'))).equals(pu7v2))
    check('PU7 follow-up round is a no-op', isNoop(await syncP(PU7_LOCAL, '/pu7', PUP)))
    await fsp.rm(PU7_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu7'), { recursive: true, force: true }).catch(() => {})

    // ---- PU8：采纳路径内容确认（4.5）----
    // (a) 崩溃留下开放意图后，对端以同 size 不同内容替换 → 不再被静默采纳 → 冲突
    await freshStore('pu8')
    const PU8_LOCAL = await tmpLocal('pu8')
    const pu8dir = { id: 'pu8', localPath: PU8_LOCAL, remotePath: '/pu8', mode: 'two-way' }
    const pu8a = puBuf('a')
    await fsp.writeFile(path.join(PU8_LOCAL, 'adopt.bin'), pu8a)
    let pu8err = null
    try {
      await syncP(PU8_LOCAL, '/pu8', PUP, {
        afterTransferOp: async (p) => {
          if (p.rel === 'adopt.bin' && p.act === 'upload') throw new Error('SIMULATED-CRASH')
        },
      })
    } catch (e) {
      pu8err = e
    }
    check('PU8a crash after PUT leaves remote == local (full)', !!pu8err && (await fsp.readFile(path.join(ROOT, 'pu8', 'adopt.bin'))).equals(pu8a), pu8err && pu8err.message)
    check('PU8a crash residue: no leaked timer (leaseLock disabled for PU series)', sweepCrashResidue() === 0)
    // 对端替换为同 size 不同内容：内容确认必须拒绝采纳 → 冲突由用户裁决。
    // 远端 mtime 拉开到容差外：规避无基线 adopt 的 mtime 捷径，逼规划走 hash 比对分支
    const pu8peer = puBuf('B')
    const pu8peerPath = path.join(ROOT, 'pu8', 'adopt.bin')
    await fsp.writeFile(pu8peerPath, pu8peer)
    const pu8peerTime = new Date(Date.now() + 2 * 3600 * 1000)
    await fsp.utimes(pu8peerPath, pu8peerTime, pu8peerTime)
    let pu8info = null
    const pu8b = await syncP(PU8_LOCAL, '/pu8', PUP, {
      onConflict: async (info) => {
        pu8info = info
        return 'local'
      },
    })
    check(
      'PU8a same-size peer replacement NOT silently adopted → conflict, resolved by user',
      pu8b.conflicts === 1 && pu8b.uploaded === 1 && pu8b.adopted === 0 && pu8info != null,
      JSON.stringify({ ...pu8b, warnings: pu8b.warnings })
    )
    check('PU8a converged to local after user choice', (await fsp.readFile(path.join(ROOT, 'pu8', 'adopt.bin'))).equals(pu8a))
    // (b) GET 失败回退按 size 采纳：getfail 档让该文件的 GET 一律 404
    const PU8B_LOCAL = await tmpLocal('pu8b')
    const pu8bdir = { id: 'pu8b', localPath: PU8B_LOCAL, remotePath: '/pu8b', mode: 'two-way' }
    const pu8bbuf = puBuf('c')
    await fsp.writeFile(path.join(PU8B_LOCAL, 'adoptgetfail.bin'), pu8bbuf)
    try {
      await syncP(PU8B_LOCAL, '/pu8b', PUP, {
        afterTransferOp: async (p) => {
          if (p.rel === 'adoptgetfail.bin' && p.act === 'upload') throw new Error('SIMULATED-CRASH')
        },
      })
    } catch {
      /* 期望崩溃 */
    }
    check('PU8b crash residue: no leaked timer (leaseLock disabled for PU series)', sweepCrashResidue() === 0)
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-getfail'), 'adoptgetfail')
    try {
      const pu8br = await syncP(PU8B_LOCAL, '/pu8b', PUP)
      check(
        'PU8b GET failure falls back to size adoption (no transfer, no conflict, warning noted)',
        pu8br.uploaded === 0 && pu8br.downloaded === 0 && pu8br.conflicts === 0 && pu8br.warnings.some((w) => /按大小采纳/.test(w)) && (await services.sync._internals.baselineEntry(pu8bdir, 'adoptgetfail.bin')) != null,
        JSON.stringify({ ...pu8br, warnings: pu8br.warnings })
      )
      check('PU8b follow-up round is a no-op', isNoop(await syncP(PU8B_LOCAL, '/pu8b', PUP)))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-getfail'), { force: true }).catch(() => {})
    }
    await fsp.rm(PU8_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(PU8B_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu8'), { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu8b'), { recursive: true, force: true }).catch(() => {})

    // ---- PU9：开放意图 30 天超龄兜底 → 恢复期放弃 ----
    await freshStore('pu9')
    const PU9_LOCAL = await tmpLocal('pu9')
    const pu9dir = { id: 'pu9', localPath: PU9_LOCAL, remotePath: '/pu9', mode: 'two-way' }
    const pu9buf = puBuf('9')
    await fsp.writeFile(path.join(PU9_LOCAL, 'stale.bin'), pu9buf)
    await setPartialPut(true)
    await setNetcut('2')
    try {
      await syncP(PU9_LOCAL, '/pu9', PUP)
    } catch {
      /* 期望失败 */
    }
    await setNetcut(null)
    await setPartialPut(false)
    await services.sync._internals.ageOpenIntents(pu9dir, 31 * 24 * 3600 * 1000)
    let pu9calls = 0
    const pu9b = await syncP(PU9_LOCAL, '/pu9', PUP, {
      onConflict: async () => {
        pu9calls++
        return 'local'
      },
    })
    check(
      'PU9 over-aged open intent dropped at recovery (warning), falls back to normal conflict planning',
      pu9b.conflicts === 1 && pu9b.warnings.some((w) => /超龄/.test(w)) && pu9calls === 1,
      `calls=${pu9calls} ${JSON.stringify({ ...pu9b, warnings: pu9b.warnings })}`
    )
    check('PU9 converged after user choice local', (await fsp.readFile(path.join(ROOT, 'pu9', 'stale.bin'))).equals(pu9buf))
    await fsp.rm(PU9_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu9'), { recursive: true, force: true }).catch(() => {})

    // ---- PU10：多设备 —— 他机看到半截 → 先下载随后收敛，全程无冲突 ----
    const pu10aStore = await freshStore('pu10a')
    const PU10_A_LOCAL = await tmpLocal('pu10a')
    const pu10buf = puBuf('m')
    await fsp.writeFile(path.join(PU10_A_LOCAL, 'shared.bin'), pu10buf)
    await setPartialPut(true)
    await setNetcut('2')
    try {
      await syncP(PU10_A_LOCAL, '/pu10', PUP)
    } catch {
      /* 期望失败：A 留下开放意图 + 远端半截 */
    }
    await setNetcut(null)
    await setPartialPut(false)
    const halfSize = fs.statSync(path.join(ROOT, 'pu10', 'shared.bin')).size
    check('PU10 setup: partial exists on remote', halfSize > 0 && halfSize < pu10buf.length, `half=${halfSize}`)
    // 设备 B（独立存储根）：无开放意图 → 把半截当普通远端新文件下载（先收敛到半截）
    const pu10bStore = await freshStore('pu10b')
    const PU10_B_LOCAL = await tmpLocal('pu10b')
    const pu10b1 = await syncP(PU10_B_LOCAL, '/pu10', PUP)
    check('PU10 device B downloads the half as a plain new remote file (no conflict)', pu10b1.downloaded === 1 && pu10b1.conflicts === 0 && (await fsp.readFile(path.join(PU10_B_LOCAL, 'shared.bin'))).equals(pu10buf.subarray(0, halfSize)), JSON.stringify(pu10b1))
    // 设备 A：半截判定 → 强制重传全量
    await switchDevice(pu10aStore)
    const pu10a2 = await syncP(PU10_A_LOCAL, '/pu10', PUP)
    check('PU10 device A re-uploads the full content via half detection', pu10a2.uploaded === 1 && pu10a2.conflicts === 0 && (await fsp.readFile(path.join(ROOT, 'pu10', 'shared.bin'))).equals(pu10buf), JSON.stringify(pu10a2))
    // 设备 B：远端已变 → 下载全量，两侧收敛一致
    await switchDevice(pu10bStore)
    const pu10b2 = await syncP(PU10_B_LOCAL, '/pu10', PUP)
    check('PU10 device B converges to the full content afterwards', pu10b2.downloaded === 1 && pu10b2.conflicts === 0 && (await fsp.readFile(path.join(PU10_B_LOCAL, 'shared.bin'))).equals(pu10buf), JSON.stringify(pu10b2))
    check('PU10 both sides stable no-op afterwards', isNoop(await syncP(PU10_B_LOCAL, '/pu10', PUP)))
    await fsp.rm(PU10_A_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(PU10_B_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu10'), { recursive: true, force: true }).catch(() => {})

    // ---- PU11：P7 档（静默忽略条件头）同路径验证 ----
    await setProfile('p7')
    try {
      await freshStore('pu11')
      const PU11_LOCAL = await tmpLocal('pu11')
      const pu11buf = puBuf('q')
      await fsp.writeFile(path.join(PU11_LOCAL, 'p7cut.bin'), pu11buf)
      await setPartialPut(true)
      await setNetcut('2')
      try {
        await syncP(PU11_LOCAL, '/pu11', PUP)
      } catch {
        /* 期望失败 */
      }
      await setNetcut(null)
      await setPartialPut(false)
      let pu11calls = 0
      const pu11b = await syncP(PU11_LOCAL, '/pu11', PUP, {
        onConflict: async () => {
          pu11calls++
          return 'local'
        },
      })
      check(
        'PU11 (P7) half auto re-upload with zero conflicts/dialogs under B-tier recheck guards',
        pu11b.errors.length === 0 && pu11b.uploaded === 1 && pu11b.conflicts === 0 && pu11calls === 0,
        `calls=${pu11calls} ${JSON.stringify(pu11b)}`
      )
      check('PU11 (P7) converged remote equals local', (await fsp.readFile(path.join(ROOT, 'pu11', 'p7cut.bin'))).equals(pu11buf))
      check('PU11 (P7) follow-up round is a no-op', isNoop(await syncP(PU11_LOCAL, '/pu11', PUP)))
      await fsp.rm(PU11_LOCAL, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'pu11'), { recursive: true, force: true }).catch(() => {})
    } finally {
      await setProfile('p1')
    }

    // ---- PU12：持续中断链的 firstAt 继承、WAL 有界增长与超龄兜底 ----
    // (a) 同一文件反复「半截重传再中断」：每轮新意图取代旧意图且继承链上最初的
    //     firstAt（时钟不被刷新）；WAL 每轮净增 2 行（intent + 旧者 abort），线性有界；
    //     未超龄时恢复链照常自动重传（继承不误伤正常恢复）
    await freshStore('pu12')
    const PU12_LOCAL = await tmpLocal('pu12')
    const pu12dir = { id: 'pu12', localPath: PU12_LOCAL, remotePath: '/pu12', mode: 'two-way' }
    const pu12buf = puBuf('f')
    await fsp.writeFile(path.join(PU12_LOCAL, 'chain.bin'), pu12buf)
    await setPartialPut(true)
    await setNetcut('2')
    const CHAIN_ROUNDS = 3
    let chainFirstAt = 0
    for (let i = 0; i < CHAIN_ROUNDS; i++) {
      try {
        await syncP(PU12_LOCAL, '/pu12', PUP)
      } catch {
        /* 期望每轮中断：新意图取代旧意图（半截重传再被切断） */
      }
      const ops = await readWalOps(pu12dir)
      const intents = ops.filter((o) => o.t === 'intent' && o.rel === 'chain.bin')
      const settledIds = new Set(ops.filter((o) => o.t === 'abort' || o.t === 'done').map((o) => o.id))
      const open = intents.filter((o) => !settledIds.has(o.id))
      if (i === 0) chainFirstAt = Number(open[0] && open[0].firstAt)
      check(
        `PU12 chain round ${i + 1}: ONE open intent whose firstAt stays at the chain origin`,
        open.length === 1 && Number.isFinite(chainFirstAt) && Number(open[0].firstAt) === chainFirstAt,
        `open=${open.length} firstAt=${open[0] && open[0].firstAt} origin=${chainFirstAt}`
      )
    }
    const pu12ops = await readWalOps(pu12dir)
    const pu12intents = pu12ops.filter((o) => o.t === 'intent' && o.rel === 'chain.bin')
    const pu12settledIds = new Set(pu12ops.filter((o) => o.t === 'abort' || o.t === 'done').map((o) => o.id))
    const pu12settledChain = pu12intents.filter((o) => pu12settledIds.has(o.id)).length
    check(
      'PU12 WAL growth bounded: 2 lines per interrupted round (intents N + aborts N-1)',
      pu12intents.length === CHAIN_ROUNDS && pu12settledChain === CHAIN_ROUNDS - 1,
      `intents=${pu12intents.length} settled=${pu12settledChain}`
    )
    await setNetcut(null)
    await setPartialPut(false)
    // 链上相邻两轮的半截指纹完全相同（同 cut 点 → 同 size、同前缀内容 → p1 档内容
    // hash etag 相同，mtime 相差 <2s 落在 REMOTE_FP_TOL_MS 容差内），恢复期会按
    // 「远端 == intent.remote」走保守路径（PU7 语义）—— 真实调度间隔（分钟级）下
    // 新半截的 mtime 必然超出容差。把服务器侧半截的 mtime 前推 4s 模拟真实间隔，
    // 验证恢复链在「远端指纹已变」时的自动重传不受 firstAt 继承影响
    const pu12half = path.join(ROOT, 'pu12', 'chain.bin')
    const pu12halfTime = new Date(fs.statSync(pu12half).mtimeMs + 4000)
    await fsp.utimes(pu12half, pu12halfTime, pu12halfTime)
    let pu12calls = 0
    const pu12fix = await syncP(PU12_LOCAL, '/pu12', PUP, {
      onConflict: async () => {
        pu12calls++
        return 'local'
      },
    })
    check(
      'PU12 fresh chain still auto re-uploads via half detection (inheritance does not break recovery)',
      pu12fix.errors.length === 0 && pu12fix.uploaded === 1 && pu12fix.conflicts === 0 && pu12calls === 0,
      `calls=${pu12calls} ${JSON.stringify(pu12fix)}`
    )
    check('PU12 converged remote equals local', (await fsp.readFile(path.join(ROOT, 'pu12', 'chain.bin'))).equals(pu12buf))
    check('PU12 WAL truncated empty after convergence', (await readWalOps(pu12dir)).length === 0)
    await fsp.rm(PU12_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu12'), { recursive: true, force: true }).catch(() => {})

    // (b) 持续中断文件在超龄（按 firstAt）后被放弃：不再半截重传，回落普通冲突。
    //     若超龄误按每次取代刷新的 at 计算，2 轮链 + 31 天前拨后仍会自动重传（断言失败）
    await freshStore('pu12b')
    const PU12B_LOCAL = await tmpLocal('pu12b')
    const pu12bdir = { id: 'pu12b', localPath: PU12B_LOCAL, remotePath: '/pu12b', mode: 'two-way' }
    const pu12bbuf = puBuf('g')
    await fsp.writeFile(path.join(PU12B_LOCAL, 'chain.bin'), pu12bbuf)
    await setPartialPut(true)
    await setNetcut('2')
    for (let i = 0; i < 2; i++) {
      try {
        await syncP(PU12B_LOCAL, '/pu12b', PUP)
      } catch {
        /* 期望中断：留下取代链 */
      }
    }
    await setNetcut(null)
    await setPartialPut(false)
    await services.sync._internals.ageOpenIntents(pu12bdir, 31 * 24 * 3600 * 1000)
    let pu12bcalls = 0
    const pu12bb = await syncP(PU12B_LOCAL, '/pu12b', PUP, {
      onConflict: async () => {
        pu12bcalls++
        return 'local'
      },
    })
    check(
      'PU12b over-aged chain (aged by firstAt) dropped → normal conflict, asked once, no forced re-upload',
      pu12bb.conflicts === 1 && pu12bb.warnings.some((w) => /超龄/.test(w)) && pu12bcalls === 1,
      `calls=${pu12bcalls} ${JSON.stringify({ ...pu12bb, warnings: pu12bb.warnings })}`
    )
    check('PU12b converged after user choice local', (await fsp.readFile(path.join(ROOT, 'pu12b', 'chain.bin'))).equals(pu12bbuf))
    await fsp.rm(PU12B_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu12b'), { recursive: true, force: true }).catch(() => {})

    // ---- PU13：采纳内容确认的单轮字节预算 ----
    await freshStore('pu13')
    const PU13_LOCAL = await tmpLocal('pu13')
    const pu13dir = { id: 'pu13', localPath: PU13_LOCAL, remotePath: '/pu13', mode: 'two-way' }
    const pu13names = ['b1.bin', 'b2.bin', 'b3.bin']
    const pu13bodies = ['one', 'two', 'three'].map((s) => Buffer.from(s.repeat(256))) // 各 768B、内容互异
    for (let i = 0; i < pu13names.length; i++) await fsp.writeFile(path.join(PU13_LOCAL, pu13names[i]), pu13bodies[i])
    const pu13s0 = await syncP(PU13_LOCAL, '/pu13', PUP)
    check('PU13 setup uploads 3 files', pu13s0.uploaded === 3 && pu13s0.errors.length === 0, JSON.stringify(pu13s0))
    /** 注入 3 条同 rel 开放 upload 意图（local 指纹与当前文件一致 → 恢复期走采纳分支）并重载存储 */
    const pu13Inject = async () => {
      const walPath = path.join(await baselineDirOf(pu13dir), 'wal.jsonl')
      let seq = 500
      const stamp13 = Date.now()
      for (const nm of pu13names) {
        const st = await fsp.stat(path.join(PU13_LOCAL, nm))
        await fsp.appendFile(
          walPath,
          storeModule._internals.encodeLine(seq++, {
            t: 'intent',
            id: `pu13-${stamp13}-${nm}`,
            op: 'upload',
            rel: nm,
            at: stamp13,
            firstAt: stamp13,
            local: { size: st.size, mtimeMs: st.mtimeMs },
            remote: null,
          })
        )
      }
      await switchDevice(path.resolve(walPath, '..', '..', '..'))
    }
    // (b) 默认预算（verifyMaxBytes × 4）足够：3 条意图全部经 GET 内容确认采纳、无预算提示
    await pu13Inject()
    const pu13full = await syncP(PU13_LOCAL, '/pu13', PUP)
    check(
      'PU13 default budget confirms all 3 adoptions with no budget warning',
      pu13full.errors.length === 0 &&
        pu13full.warnings.filter((w) => /内容已确认/.test(w)).length === 3 &&
        !pu13full.warnings.some((w) => /超出本轮预算/.test(w)),
      JSON.stringify(pu13full.warnings)
    )
    // (a) 预算 = 单文件大小：第 1 条确认 GET 后预算归零，其余 2 条回退按大小采纳 ——
    //     汇总恰好一条 warning（不逐文件刷屏）、服务器侧只见 1 次采纳 GET
    await pu13Inject()
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    await fsp.rm(REQLOG, { force: true }).catch(() => {})
    try {
      const pu13small = await services.sync.syncDirectory(cfg, pu13dir, { ...PUP, adoptVerifyBudgetBytes: pu13bodies[0].length }, {})
      check(
        'PU13 small budget: all 3 still adopted (zero transfers), exactly ONE confirmed by GET',
        pu13small.errors.length === 0 &&
          pu13small.uploaded === 0 &&
          pu13small.downloaded === 0 &&
          pu13small.warnings.filter((w) => /内容已确认/.test(w)).length === 1,
        JSON.stringify({ ...pu13small, warnings: pu13small.warnings })
      )
      check(
        'PU13 budget exhaustion aggregates into ONE warning (2 files), per-file fallback suppressed',
        pu13small.warnings.filter((w) => /超出本轮预算/.test(w)).length === 1 &&
          pu13small.warnings.some((w) => /2 个文件/.test(w)) &&
          pu13small.warnings.filter((w) => /按大小采纳上传意图/.test(w)).length === 0,
        JSON.stringify(pu13small.warnings)
      )
      const pu13req = (await fsp.readFile(REQLOG, 'utf-8').catch(() => '')).split('\n').filter(Boolean)
      const pu13gets = pu13req.filter((l) => l.startsWith('GET /dav/pu13/'))
      check('PU13 only ONE adoption GET actually hit the server', pu13gets.length === 1, pu13gets.join(' | '))
      check('PU13 baseline intact and follow-up round is a no-op', isNoop(await syncP(PU13_LOCAL, '/pu13', PUP)))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
    }
    await fsp.rm(PU13_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu13'), { recursive: true, force: true }).catch(() => {})
  })

  // ============================================================
  // PC 系列：冲突挂起 + 批量策略延续
  // 用户对冲突的选择（含「应用到全部」）在成功落地前先逐文件持久化；落地失败
  //（A 档 412 / B 档复查 REMOTE_CHANGED）时下一轮规划自动沿用，不再重复询问。
  // PC1–PC3 在 P1 档（A 档 412 路径），PC4 在 P7 档（B 档复查放弃路径）。
  // midair 钩子只在 basename 含 'midair' 的文件上触发且每文件一次性 ——
  // 冲突文件命名带 midair、同轮另一冲突文件不带，即可分别命中 / 豁免。
  // ============================================================
  await setProfile('p1') // PC 系列公共前置（独立于各节，跳过个别节时仍需生效）

  // PC1 主链路：冲突 + applyToRemaining → 解决上传被 412 → 挂起保留 choice；
  // 同轮第二个冲突 g 被本轮内存的 applyToRemaining 直接解决（N4 语义不回退）；
  // 下一轮（钩子一次性已耗尽）不再询问、以 local 自动解决、pending 清空、第三轮 no-op
  await section('PC1：冲突挂起主链路', async () => {
    await freshStore('pc1')
    const PC1_LOCAL = await tmpLocal('pc1')
    const pc1dir = { id: 'pc1', localPath: PC1_LOCAL, remotePath: '/pc1', mode: 'two-way' }
    await fsp.writeFile(path.join(PC1_LOCAL, 'f-midair.txt'), 'pc1-f-V1')
    await fsp.writeFile(path.join(PC1_LOCAL, 'g.txt'), 'pc1-g-V1')
    const pc1s0 = await syncP(PC1_LOCAL, '/pc1')
    check('PC1 setup uploads both files', pc1s0.uploaded === 2, JSON.stringify(pc1s0))
    // 双侧修改成冲突（size 各不相同 → 直接冲突，不进 4.4-B 内容消歧）
    await fsp.writeFile(path.join(PC1_LOCAL, 'f-midair.txt'), 'pc1-f-LOCAL-v2')
    await fsp.writeFile(path.join(ROOT, 'pc1', 'f-midair.txt'), 'pc1-f-REMOTE-v2')
    await fsp.writeFile(path.join(PC1_LOCAL, 'g.txt'), 'pc1-g-LOCAL-v2')
    await fsp.writeFile(path.join(ROOT, 'pc1', 'g.txt'), 'pc1-g-REMOTE-v2')
    // A 档 midair：冲突解决的上传（If-Match 命中被对端改写后的远端）→ 412
    await setMidair('put')
    let pc1Calls = 0
    let pc1err = null
    try {
      await syncP(PC1_LOCAL, '/pc1', undefined, {
        onConflict: async () => {
          pc1Calls++
          return { choice: 'local', applyToRemaining: true }
        },
      })
    } catch (e) {
      pc1err = e
    }
    await setMidair(null)
    check(
      'PC1 round 1 fails on midair 412 while sibling still resolves',
      !!pc1err && /412|已被其他设备修改/.test(pc1err.message),
      pc1err && pc1err.message
    )
    check('PC1 onConflict asked exactly once (applyToRemaining covers the sibling)', pc1Calls === 1, `calls=${pc1Calls}`)
    check(
      'PC1 sibling conflict g resolved in-round by apply-to-remaining (N4 semantics intact)',
      (await fsp.readFile(path.join(ROOT, 'pc1', 'g.txt'), 'utf-8')) === 'pc1-g-LOCAL-v2'
    )
    const pc1pend = await services.sync.listPendingConflicts(pc1dir)
    check(
      'PC1 pending holds only the failed file f with choice local',
      pc1pend.length === 1 && pc1pend[0].rel === 'f-midair.txt' && pc1pend[0].choice === 'local' && pc1pend[0].local && pc1pend[0].remote,
      JSON.stringify(pc1pend)
    )
    // 第二轮：钩子一次性已耗尽 → 不再询问（计数仍为 1）、以 local 自动解决并上传成功
    const pc1s2 = await syncP(PC1_LOCAL, '/pc1', undefined, {
      onConflict: async () => {
        pc1Calls++
        return { choice: 'remote' }
      },
    })
    check(
      'PC1 round 2 reuses pending choice without asking again',
      pc1Calls === 1 && pc1s2.conflicts === 1 && pc1s2.uploaded === 1 && pc1s2.errors.length === 0 && pc1s2.warnings.some((w) => /沿用上次冲突处理策略/.test(w)),
      `calls=${pc1Calls} ${JSON.stringify(pc1s2)}`
    )
    check('PC1 remote f now holds the local version', (await fsp.readFile(path.join(ROOT, 'pc1', 'f-midair.txt'), 'utf-8')) === 'pc1-f-LOCAL-v2')
    check('PC1 pending cleared after successful resolution', (await services.sync.listPendingConflicts(pc1dir)).length === 0)
    const pc1s3 = await syncP(PC1_LOCAL, '/pc1')
    check('PC1 round 3 is a no-op', isNoop(pc1s3), JSON.stringify(pc1s3))
    await fsp.rm(PC1_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'pc1'), { recursive: true, force: true })
  })

  // PC2 未解决挂起：ask + 回调返回无法识别的值 → 轮次照旧报「冲突未解决」、
  // 挂起登记但无 choice、两侧原状；setPendingChoice 补记 remote → 下一轮不弹窗、
  // 以 remote 解决、pending 清空（「统一处理」入口的行为验证）
  await section('PC2：未解决挂起 + setPendingChoice', async () => {
    await freshStore('pc2')
    const PC2_LOCAL = await tmpLocal('pc2')
    const pc2dir = { id: 'pc2', localPath: PC2_LOCAL, remotePath: '/pc2', mode: 'two-way' }
    await fsp.writeFile(path.join(PC2_LOCAL, 'a.txt'), 'pc2-a-V1')
    await syncP(PC2_LOCAL, '/pc2')
    await fsp.writeFile(path.join(PC2_LOCAL, 'a.txt'), 'pc2-a-LOCAL-v2')
    await fsp.writeFile(path.join(ROOT, 'pc2', 'a.txt'), 'pc2-a-REMOTE-v2-longer')
    let pc2err = null
    try {
      await syncP(PC2_LOCAL, '/pc2', undefined, { onConflict: async () => ({ choice: 'neither' }) })
    } catch (e) {
      pc2err = e
    }
    check('PC2 unrecognized choice still fails the round as unresolved', !!pc2err && /冲突未解决/.test(pc2err.message), pc2err && pc2err.message)
    const pc2pend = await services.sync.listPendingConflicts(pc2dir)
    check(
      'PC2 pending registered without choice, both sides intact',
      pc2pend.length === 1 && pc2pend[0].rel === 'a.txt' && pc2pend[0].choice === undefined &&
        (await fsp.readFile(path.join(PC2_LOCAL, 'a.txt'), 'utf-8')) === 'pc2-a-LOCAL-v2' &&
        (await fsp.readFile(path.join(ROOT, 'pc2', 'a.txt'), 'utf-8')) === 'pc2-a-REMOTE-v2-longer',
      JSON.stringify(pc2pend)
    )
    // setPendingChoice 入口校验：非法值抛错；对不存在的挂起返回 false
    let pc2badChoice = false
    try {
      await services.sync.setPendingChoice(pc2dir, 'a.txt', 'bogus')
    } catch (_) {
      pc2badChoice = true
    }
    check('PC2 setPendingChoice rejects invalid choice values', pc2badChoice)
    check('PC2 setPendingChoice applies the choice and persists', (await services.sync.setPendingChoice(pc2dir, 'a.txt', 'remote')) === true)
    let pc2Calls2 = 0
    const pc2s2 = await syncP(PC2_LOCAL, '/pc2', undefined, {
      onConflict: async () => {
        pc2Calls2++
        return { choice: 'local' }
      },
    })
    check(
      'PC2 next round resolves via the set choice without asking',
      pc2Calls2 === 0 && pc2s2.conflicts === 1 && pc2s2.downloaded === 1 && pc2s2.errors.length === 0 && pc2s2.warnings.some((w) => /沿用上次冲突处理策略/.test(w)),
      `calls=${pc2Calls2} ${JSON.stringify(pc2s2)}`
    )
    check('PC2 local now holds the remote version', (await fsp.readFile(path.join(PC2_LOCAL, 'a.txt'), 'utf-8')) === 'pc2-a-REMOTE-v2-longer')
    check('PC2 pending cleared, further setPendingChoice is a no-op', (await services.sync.listPendingConflicts(pc2dir)).length === 0 && (await services.sync.setPendingChoice(pc2dir, 'a.txt', 'local')) === false)
    const pc2s3 = await syncP(PC2_LOCAL, '/pc2')
    check('PC2 round 3 is a no-op', isNoop(pc2s3), JSON.stringify(pc2s3))
    await fsp.rm(PC2_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'pc2'), { recursive: true, force: true })
  })

  // PC3 持久化跨进程：冲突 + 选择 + midair 失败保留 → switchDevice 换根再换回
  //（store 关闭重开，从磁盘恢复）→ pending 仍在且 choice 完好 → 下一轮沿用解决
  await section('PC3：挂起跨进程持久化', async () => {
    const PC3_S = await freshStore('pc3')
    const PC3_LOCAL = await tmpLocal('pc3')
    const pc3dir = { id: 'pc3', localPath: PC3_LOCAL, remotePath: '/pc3', mode: 'two-way' }
    await fsp.writeFile(path.join(PC3_LOCAL, 'f-midair.txt'), 'pc3-f-V1')
    await syncP(PC3_LOCAL, '/pc3')
    await fsp.writeFile(path.join(PC3_LOCAL, 'f-midair.txt'), 'pc3-f-LOCAL-v2')
    await fsp.writeFile(path.join(ROOT, 'pc3', 'f-midair.txt'), 'pc3-f-REMOTE-v2')
    await setMidair('put')
    let pc3err = null
    try {
      await syncP(PC3_LOCAL, '/pc3', undefined, { onConflict: async () => ({ choice: 'local' }) })
    } catch (e) {
      pc3err = e
    }
    await setMidair(null)
    check('PC3 round 1 fails via midair 412 (pending kept on disk)', !!pc3err && /412/.test(pc3err.message), pc3err && pc3err.message)
    // 换根再换回：DirStateStore 关闭后重开，挂起必须从 pending-conflicts.json 恢复
    await switchDevice(STORAGE_MAIN)
    await switchDevice(PC3_S)
    const pc3pend = await services.sync.listPendingConflicts(pc3dir)
    check(
      'PC3 pending survives store reopen with choice and fingerprints',
      pc3pend.length === 1 && pc3pend[0].rel === 'f-midair.txt' && pc3pend[0].choice === 'local' && typeof pc3pend[0].createdAt === 'number',
      JSON.stringify(pc3pend)
    )
    const pc3s2 = await syncP(PC3_LOCAL, '/pc3')
    check(
      'PC3 next round resolves via the persisted choice (hook consumed)',
      pc3s2.conflicts === 1 && pc3s2.uploaded === 1 && (await fsp.readFile(path.join(ROOT, 'pc3', 'f-midair.txt'), 'utf-8')) === 'pc3-f-LOCAL-v2' && (await services.sync.listPendingConflicts(pc3dir)).length === 0,
      JSON.stringify(pc3s2)
    )
    await fsp.rm(PC3_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'pc3'), { recursive: true, force: true })
  })

  // PC4（P7 档）：B 档复查放弃同样延续 —— setMidair('propfind') 使复查发现远端已变 →
  // REMOTE_CHANGED 放弃该文件；pending 保留 choice；下一轮沿用策略解决（钩子已耗尽）
  await section('PC4：B 档复查放弃延续（P7）', async () => {
    await setProfile('p7')
    try {
      await freshStore('pc4')
      const PC4_LOCAL = await tmpLocal('pc4')
      const pc4dir = { id: 'pc4', localPath: PC4_LOCAL, remotePath: '/pc4', mode: 'two-way' }
      await fsp.writeFile(path.join(PC4_LOCAL, 'f-midair.txt'), 'pc4-f-V1')
      await syncP(PC4_LOCAL, '/pc4')
      await fsp.writeFile(path.join(PC4_LOCAL, 'f-midair.txt'), 'pc4-f-LOCAL-v2')
      await fsp.writeFile(path.join(ROOT, 'pc4', 'f-midair.txt'), 'pc4-f-REMOTE-v2')
      await setMidair('propfind')
      let pc4err = null
      try {
        await syncP(PC4_LOCAL, '/pc4', undefined, { onConflict: async () => ({ choice: 'local' }) })
      } catch (e) {
        pc4err = e
      }
      await setMidair(null)
      check(
        'PC4 round 1 abandoned by B-tier recheck (REMOTE_CHANGED, round fails)',
        !!pc4err && /复查发现远端已变化|跳过/.test(pc4err.message),
        pc4err && pc4err.message
      )
      const pc4pend = await services.sync.listPendingConflicts(pc4dir)
      check('PC4 pending kept with choice local after recheck abort', pc4pend.length === 1 && pc4pend[0].choice === 'local', JSON.stringify(pc4pend))
      let pc4Calls = 0
      const pc4s2 = await syncP(PC4_LOCAL, '/pc4', undefined, {
        onConflict: async () => {
          pc4Calls++
          return { choice: 'remote' }
        },
      })
      check(
        'PC4 next round reuses the choice without asking (B tier converges)',
        pc4Calls === 0 && pc4s2.conflicts === 1 && pc4s2.uploaded === 1 && pc4s2.errors.length === 0 && (await fsp.readFile(path.join(ROOT, 'pc4', 'f-midair.txt'), 'utf-8')) === 'pc4-f-LOCAL-v2' && (await services.sync.listPendingConflicts(pc4dir)).length === 0,
        `calls=${pc4Calls} ${JSON.stringify(pc4s2)}`
      )
      await fsp.rm(PC4_LOCAL, { recursive: true, force: true })
      await fsp.rm(path.join(ROOT, 'pc4'), { recursive: true, force: true })
    } finally {
      await setProfile(null)
    }
  })

  // ============================================================
  // 调度器输入字段的行为验证 —— summary.failureClass /
  // openIntents / onConflict 'defer'（breaker 字段由 W7 的两条新断言覆盖，503 风暴
  // 不重复造）。调度层（scheduler.js 假时钟单测 + SC 节）建立在这些字段语义上。
  // ============================================================
  await section('B2A：调度器输入字段（failureClass / openIntents / defer）', async () => {
    // ---- FC1：网络类失败轮（netcut 真实 NETWORK 终态）→ failureClass=network、
    // openIntents>=1（半截意图保持开放）、breaker 不出现（熔断未开）；恢复轮
    // 成功后 failureClass 缺省、openIntents 归零 ----
    await freshStore('b2a1')
    const B2A_LOCAL = await tmpLocal('b2a1')
    const b2adir = { id: 'b2a', localPath: B2A_LOCAL, remotePath: '/b2a1', mode: 'two-way' }
    await fsp.writeFile(path.join(B2A_LOCAL, 'cut.bin'), puBuf('c'))
    await fsp.writeFile(path.join(B2A_LOCAL, 'ok.txt'), 'b2a-ok')
    await setPartialPut(true)
    await setNetcut('2')
    let fc1err = null
    try {
      await syncP(B2A_LOCAL, '/b2a1', PUP)
    } catch (e) {
      fc1err = e
    }
    await setNetcut(null)
    await setPartialPut(false)
    check(
      'FC1 netcut round: err.summary.failureClass=network + openIntents>=1 + no breaker field',
      !!fc1err && fc1err.summary && fc1err.summary.failureClass === 'network' && fc1err.summary.openIntents >= 1 && !fc1err.summary.breaker,
      fc1err && JSON.stringify({ failureClass: fc1err.summary.failureClass, openIntents: fc1err.summary.openIntents, breaker: fc1err.summary.breaker || null })
    )
    const fc1fix = await syncP(B2A_LOCAL, '/b2a1', PUP)
    check(
      'FC1 recovery round: success without failureClass, openIntents back to 0',
      fc1fix.errors.length === 0 && fc1fix.uploaded === 1 && fc1fix.failureClass === undefined && fc1fix.openIntents === 0,
      JSON.stringify({ uploaded: fc1fix.uploaded, failureClass: fc1fix.failureClass, openIntents: fc1fix.openIntents })
    )
    check('FC1 success round summary carries deferredConflicts=0 field', fc1fix.deferredConflicts === 0)
    await fsp.rm(B2A_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'b2a1'), { recursive: true, force: true }).catch(() => {})

    // ---- FC2：永久失败（413，文件级）轮 → failureClass=other、openIntents=0 ----
    await freshStore('b2a2')
    const FC2_LOCAL = await tmpLocal('b2a2')
    await fsp.writeFile(path.join(FC2_LOCAL, 'good.txt'), 'fc2-good')
    await fsp.writeFile(path.join(FC2_LOCAL, 'bad.toolarge.txt'), 'fc2-too-large')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-fail413'), 'x')
    let fc2err = null
    try {
      await syncP(FC2_LOCAL, '/b2a2')
    } catch (e) {
      fc2err = e
    }
    await fsp.rm(path.join(ROOT, '.wdsync-test-fail413'), { force: true }).catch(() => {})
    check(
      'FC2 permanent 413 round: failureClass=other + openIntents=0',
      !!fc2err && fc2err.summary && fc2err.summary.failureClass === 'other' && fc2err.summary.openIntents === 0,
      fc2err && JSON.stringify({ failureClass: fc2err.summary.failureClass, openIntents: fc2err.summary.openIntents })
    )
    check('FC2 sibling file uploaded in the failed round', fc2err && fc2err.summary.uploaded === 1)
    await fsp.rm(FC2_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'b2a2'), { recursive: true, force: true }).catch(() => {})

    // ---- FC3：混合失败轮（413 永久 + netcut 网络）→ failureClass=mixed ----
    await freshStore('b2a3')
    const FC3_LOCAL = await tmpLocal('b2a3')
    await fsp.writeFile(path.join(FC3_LOCAL, 'good.txt'), 'fc3-good')
    await fsp.writeFile(path.join(FC3_LOCAL, 'bad.toolarge.txt'), 'fc3-too-large')
    await fsp.writeFile(path.join(FC3_LOCAL, 'cut.bin'), puBuf('m'))
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-fail413'), 'x')
    await setNetcut('2')
    let fc3err = null
    try {
      await syncP(FC3_LOCAL, '/b2a3', PUP)
    } catch (e) {
      fc3err = e
    }
    await setNetcut(null)
    await fsp.rm(path.join(ROOT, '.wdsync-test-fail413'), { force: true }).catch(() => {})
    check(
      'FC3 mixed round (413 + netcut): failureClass=mixed',
      !!fc3err && fc3err.summary && fc3err.summary.failureClass === 'mixed' && fc3err.summary.openIntents >= 1,
      fc3err && JSON.stringify({ failureClass: fc3err.summary.failureClass, openIntents: fc3err.summary.openIntents, errors: fc3err.errors })
    )
    await fsp.rm(FC3_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'b2a3'), { recursive: true, force: true }).catch(() => {})

    // ---- FC4：扫描期失败（连接拒绝的原始 NETWORK 抛出）→ syncDirectory 兜底补
    // 最小 err.summary + err.failureClass=network（调度层退避输入的统一契约） ----
    const fc4dir = { id: 'fc4', localPath: B2A_LOCAL, remotePath: '/fc4', mode: 'two-way' }
    let fc4err = null
    try {
      await services.sync.syncDirectory(
        { serverUrl: `http://127.0.0.1:1/dav/`, username: 'u', password: 'p' },
        fc4dir,
        SP,
        {}
      )
    } catch (e) {
      fc4err = e
    }
    check(
      'FC4 scan-phase raw network throw gets minimal summary with failureClass=network',
      !!fc4err && fc4err.failureClass === 'network' && fc4err.summary && fc4err.summary.failureClass === 'network' && fc4err.summary.errors.length === 1 && fc4err.summary.totalFiles === 0,
      fc4err && JSON.stringify({ failureClass: fc4err.failureClass, summary: fc4err.summary })
    )

    // ---- DF1：onConflict 'defer' —— 后台冲突挂起 ----
    // 双冲突文件 + 一个仅本地修改的兄弟文件：defer 后轮次**成功返回**（不抛
    //「冲突未解决」），deferredConflicts=2、conflicts=0、兄弟文件照常上传；
    // 挂起记录无 choice；setPendingChoice 补记后下一轮不再询问（沿用），
    // 未补记的那个再次询问（仍可再 defer / 选择）。
    await freshStore('b2a4')
    const DF1_LOCAL = await tmpLocal('b2a4')
    const df1dir = { id: 'df1', localPath: DF1_LOCAL, remotePath: '/b2a4', mode: 'two-way' }
    await fsp.writeFile(path.join(DF1_LOCAL, 'a.txt'), 'df1-a-V1')
    await fsp.writeFile(path.join(DF1_LOCAL, 'b.txt'), 'df1-b-V1')
    await fsp.writeFile(path.join(DF1_LOCAL, 'c.txt'), 'df1-c-V1')
    await syncP(DF1_LOCAL, '/b2a4')
    // 制造两个冲突（a / b 双侧修改）+ 一个仅本地修改（c 正常上传）
    await fsp.writeFile(path.join(DF1_LOCAL, 'a.txt'), 'df1-a-LOCAL-v2')
    await fsp.writeFile(path.join(ROOT, 'b2a4', 'a.txt'), 'df1-a-REMOTE-v2-longer')
    await fsp.writeFile(path.join(DF1_LOCAL, 'b.txt'), 'df1-b-LOCAL-v2')
    await fsp.writeFile(path.join(ROOT, 'b2a4', 'b.txt'), 'df1-b-REMOTE-v2-longer')
    await fsp.writeFile(path.join(DF1_LOCAL, 'c.txt'), 'df1-c-LOCAL-v2')
    let df1calls = 0
    const df1s1 = await syncP(DF1_LOCAL, '/b2a4', undefined, {
      onConflict: async () => {
        df1calls++
        return 'defer'
      },
    })
    check(
      'DF1 defer round succeeds: deferredConflicts=2, conflicts=0, no errors, sibling uploaded',
      df1s1.errors.length === 0 && df1s1.deferredConflicts === 2 && df1s1.conflicts === 0 && df1s1.uploaded === 1 && df1calls === 2,
      `calls=${df1calls} ${JSON.stringify({ deferredConflicts: df1s1.deferredConflicts, conflicts: df1s1.conflicts, uploaded: df1s1.uploaded })}`
    )
    check(
      'DF1 deferred conflicts recorded pending without choice, conflict sides untouched',
      (await services.sync.listPendingConflicts(df1dir)).length === 2 &&
        (await services.sync.listPendingConflicts(df1dir)).every((p) => p.choice === undefined) &&
        (await fsp.readFile(path.join(DF1_LOCAL, 'a.txt'), 'utf-8')) === 'df1-a-LOCAL-v2' &&
        (await fsp.readFile(path.join(ROOT, 'b2a4', 'a.txt'), 'utf-8')) === 'df1-a-REMOTE-v2-longer',
      JSON.stringify(await services.sync.listPendingConflicts(df1dir))
    )
    // 统一处理：为 a 补记 local → 下一轮 a 沿用不再询问，b 无 choice 再次询问（选 remote）
    await services.sync.setPendingChoice(df1dir, 'a.txt', 'local')
    let df1calls2 = 0
    const df1s2 = await syncP(DF1_LOCAL, '/b2a4', undefined, {
      onConflict: async () => {
        df1calls2++
        return 'remote'
      },
    })
    check(
      'DF1 next round: pending choice reused without asking, unresolved asks again and resolves',
      df1calls2 === 1 && df1s2.errors.length === 0 && df1s2.conflicts === 2 && df1s2.deferredConflicts === 0 && df1s2.uploaded === 1 && df1s2.downloaded === 1,
      `calls=${df1calls2} ${JSON.stringify({ conflicts: df1s2.conflicts, deferredConflicts: df1s2.deferredConflicts, uploaded: df1s2.uploaded, downloaded: df1s2.downloaded })}`
    )
    check(
      'DF1 both conflicts converged to chosen sides, pending cleared',
      (await fsp.readFile(path.join(ROOT, 'b2a4', 'a.txt'), 'utf-8')) === 'df1-a-LOCAL-v2' &&
        (await fsp.readFile(path.join(DF1_LOCAL, 'b.txt'), 'utf-8')) === 'df1-b-REMOTE-v2-longer' &&
        (await services.sync.listPendingConflicts(df1dir)).length === 0
    )
    check('DF1 final round is a no-op', isNoop(await syncP(DF1_LOCAL, '/b2a4')))
    await fsp.rm(DF1_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'b2a4'), { recursive: true, force: true }).catch(() => {})
  })

  // ============================================================
  // B2B：failureClass 增量累计 —— 归纳不再依赖被截断到 200 条
  // 的 errors 列表。dedupfail 标记的注入点是「每路径第 2 次起的 Depth:1 列举」，
  // 故两用例都需要 seed 轮先把远端目录与基线建好（否则远端目录不存在，列举直接
  // 404，轮不到注入点）：
  //   FC5a（p1 / A 档）：seed 轮 250 文件入库 → 故障轮改写全部文件内容，PUT 全部
  //         成功而批量校验列举（该路径第 2 次）被注入 503 → 组级失败逐文件登记
  //         250 条网络类错误（200 保留 + 50 截断）→ 全网络类轮仍归 network；
  //         恢复轮双侧同内容（PUT 已落盘）→ 4.4-B 消歧全部 adopt，不重传；
  //   FC5b（p2 / B 档，探测在 seed 轮前完成，能力缓存定档 B）：故障轮 dedupfail/
  //         子目录下 250 个**新**文件走写前查重（扫描后该路径第 2 次列举 → 503，
  //         worker 池之前逐文件登记 250 条网络类）+ 根目录 60 个 .toolarge 的 413
  //         永久类（worker 池阶段、排在第 201 条之后全部落入截断区）→ 旧实现按
  //         保留的前 200 条归纳为 network（other 整段丢失），增量累计后归 mixed；
  //         恢复轮 250 个正常上传，60 个 413 已入永久失败退避表 → 汇总跳过不报错。
  // 慢组：两条 503×4 网络层重试退避链（~3.5s×2）+ 250 文件三轮真实 IO。
  // ============================================================
  await slowSection('B2B：failureClass 增量累计（250 条错误跨截断区）', '两条 503×4 重试退避链（~3.5s×2）+ 250 文件三轮 IO；failureClass 基本语义仍由 B2A 节 FC1–FC3 覆盖', async () => {
    // ---- FC5a：250 条网络类（A 档批量校验组级 503）→ 仍归 network ----
    await freshStore('b2b1')
    const FC5A_LOCAL = await tmpLocal('b2b1')
    const fc5aDedup = path.join(FC5A_LOCAL, 'dedupfail')
    await fsp.mkdir(fc5aDedup, { recursive: true })
    for (let i = 0; i < 250; i++) await fsp.writeFile(path.join(fc5aDedup, `f${i}.txt`), `fc5a-v1-${i}`)
    // seed 轮：无故障，250 文件全部入库（远端目录 + 基线建立，dedupfail 计数从本轮后起算）
    const fc5aseed = await syncP(FC5A_LOCAL, '/b2b1')
    check('FC5a seed round uploads all 250 (tier A, no dedup probe)', fc5aseed.uploaded === 250 && fc5aseed.errors.length === 0 && fc5aseed.tier === 'A', JSON.stringify({ uploaded: fc5aseed.uploaded, tier: fc5aseed.tier }))
    try {
      // 故障轮：改写全部文件内容（等长前缀、内容不同）+ 开 503 → PUT 成功、批量校验组级 503
      for (let i = 0; i < 250; i++) await fsp.writeFile(path.join(fc5aDedup, `f${i}.txt`), `fc5a-v2-${i}`)
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-dedupfail'), '503')
      let fc5aerr = null
      try {
        await syncP(FC5A_LOCAL, '/b2b1')
      } catch (e) {
        fc5aerr = e
      }
      check(
        'FC5a 250 network-class errors (200 kept + 50 dropped) still classify as network',
        !!fc5aerr && fc5aerr.summary && fc5aerr.summary.failureClass === 'network' && fc5aerr.summary.errors.length === 200 && fc5aerr.summary.errorsDropped === 50 && fc5aerr.summary.errors.every((m) => m.includes('上传批量校验失败')),
        fc5aerr && JSON.stringify({ failureClass: fc5aerr.summary.failureClass, len: fc5aerr.summary.errors.length, dropped: fc5aerr.summary.errorsDropped, head: fc5aerr.summary.errors[0] })
      )
      check('FC5a failed round commits nothing (uploaded=0)', fc5aerr && fc5aerr.summary.uploaded === 0)
      // 恢复轮：PUT 已把 v2 落盘（远端=本地=新内容，基线仍是 v1）→ 4.4-B 双侧变化 hash 消歧全部 adopt
      await fsp.rm(path.join(ROOT, '.wdsync-test-dedupfail'), { force: true })
      const fc5afix = await syncP(FC5A_LOCAL, '/b2b1')
      check(
        'FC5a recovery round adopts all 250 via both-sides-verify, no re-upload, no errors',
        fc5afix.errors.length === 0 && fc5afix.adopted === 250 && fc5afix.uploaded === 0 && fc5afix.failureClass === undefined,
        JSON.stringify({ adopted: fc5afix.adopted, uploaded: fc5afix.uploaded, errors: fc5afix.errors.length })
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-dedupfail'), { force: true }).catch(() => {})
    }
    await fsp.rm(FC5A_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'b2b1'), { recursive: true, force: true }).catch(() => {})

    // ---- FC5b：250 条网络类在前（B 档查重 503）+ 60 条永久类落入截断区 → mixed ----
    await freshStore('b2b2')
    await setProfile('p2') // 探测在 seed 轮完成并按 origin 缓存：后续轮固定 B 档（查重才会发生）
    const FC5B_LOCAL = await tmpLocal('b2b2')
    const fc5bDedup = path.join(FC5B_LOCAL, 'dedupfail')
    await fsp.mkdir(fc5bDedup, { recursive: true })
    // seed 轮：1 个 seed 文件把远端 /b2b2/dedupfail/ 目录建好（查重列举需要目录已存在）。
    // 同时覆盖查重 404 特判：B 档新上传 + 远端父目录不存在 → 查重 PROPFIND 404 =
    // 必然无同名（放行上传，PUT 前 MKCOL）；特判前该场景每轮被「查重失败（HTTP 404）」
    // 跳过、目录永远建不起来（死循环，本用例发现）
    await fsp.writeFile(path.join(fc5bDedup, 'seed.txt'), 'fc5b-seed')
    const fc5bseed = await syncP(FC5B_LOCAL, '/b2b2')
    check('FC5b seed round uploads seed file (tier B; dedup 404 on missing parent passes through)', fc5bseed.uploaded === 1 && fc5bseed.errors.length === 0 && fc5bseed.tier === 'B', JSON.stringify({ uploaded: fc5bseed.uploaded, tier: fc5bseed.tier }))
    try {
      // 故障轮：dedupfail/ 下 250 个新文件（查重 503，worker 之前逐文件报错）+ 根目录 60 个 413
      for (let i = 0; i < 250; i++) await fsp.writeFile(path.join(fc5bDedup, `f${i}.txt`), `fc5b-${i}`)
      for (let i = 0; i < 60; i++) await fsp.writeFile(path.join(FC5B_LOCAL, `t${i}.toolarge.txt`), `fc5b-t${i}`)
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-dedupfail'), '503')
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-fail413'), 'x')
      let fc5berr = null
      try {
        await syncP(FC5B_LOCAL, '/b2b2')
      } catch (e) {
        fc5berr = e
      }
      check(
        'FC5b 250 network (dedup probe 503) + 60 permanent (413, all dropped): failureClass=mixed via incremental counts',
        !!fc5berr && fc5berr.summary && fc5berr.summary.failureClass === 'mixed' && fc5berr.summary.errors.length === 200 && fc5berr.summary.errorsDropped === 110 && fc5berr.summary.errors.every((m) => m.includes('写前查重失败')),
        fc5berr && JSON.stringify({ failureClass: fc5berr.summary.failureClass, len: fc5berr.summary.errors.length, dropped: fc5berr.summary.errorsDropped, head: fc5berr.summary.errors[0] })
      )
      // 恢复轮：60 个 413 文件上一轮已入永久失败退避表（15min 起，本轮汇总跳过不报错）；
      // 250 个查重跳过文件（上一轮 PUT 从未发出，远端仍无）正常上传
      await fsp.rm(path.join(ROOT, '.wdsync-test-dedupfail'), { force: true })
      await fsp.rm(path.join(ROOT, '.wdsync-test-fail413'), { force: true })
      const fc5bfix = await syncP(FC5B_LOCAL, '/b2b2')
      check(
        'FC5b fault-free round uploads 250, skips 60 on permanent-failure backoff, no errors',
        fc5bfix.errors.length === 0 && fc5bfix.uploaded === 250 && fc5bfix.warnings.some((w) => w.includes('跳过 60 个持续失败文件')) && fc5bfix.failureClass === undefined,
        JSON.stringify({ uploaded: fc5bfix.uploaded, errors: fc5bfix.errors.length, warnings: fc5bfix.warnings })
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-dedupfail'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, '.wdsync-test-fail413'), { force: true }).catch(() => {})
      await setProfile(null)
    }
    await fsp.rm(FC5B_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'b2b2'), { recursive: true, force: true }).catch(() => {})
  })

  // ============================================================
  // TR1：引擎级瞬时失败当轮重试 —— .wdsync-test-fail423x
  // 的 N=4 超过网络层最大重试（3）次：初始 1 + 重试 3 共 4 次请求全部 423 耗尽，
  // 网络层以终态 423 抛回引擎 → classifyOpFailure 判 transient → worker 池收尾后的
  // 当轮重试循环真实生效（第 5 次 PUT 放行收敛）。与 PF2（N=1，被网络层重试吸收，
  // 未触及引擎级循环）互补：本轮 uploaded=2、errors=0、不入永久失败退避表、后续轮 no-op。
  // ============================================================
  await slowSection('TR1：引擎级当轮重试', '423×4 网络层重试 + 引擎级重试的真实退避等待；瞬时失败当轮重试基本语义仍由 PF2 覆盖', async () => {
    await freshStore('tr1')
    const TR1_LOCAL = await tmpLocal('tr1')
    const tr1dir = { id: 'tr1', localPath: TR1_LOCAL, remotePath: '/tr1', mode: 'two-way' }
    await fsp.writeFile(path.join(TR1_LOCAL, 'a.txt'), 'tr1-a')
    await fsp.writeFile(path.join(TR1_LOCAL, 'b.txt'), 'tr1-b')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-fail423x'), '4')
    try {
      const tr1s = await syncP(TR1_LOCAL, '/tr1')
      check(
        'TR1 engine-level in-round retry converges (uploaded=2, errors=0)',
        tr1s.uploaded === 2 && tr1s.errors.length === 0 && (await fsp.readFile(path.join(ROOT, 'tr1', 'a.txt'), 'utf-8')) === 'tr1-a',
        JSON.stringify(tr1s)
      )
      const tr1f = await services.sync._internals.getFailures(tr1dir)
      check('TR1 transient failures never enter the backoff table', Object.keys(tr1f).length === 0, JSON.stringify(tr1f))
      const tr1s2 = await syncP(TR1_LOCAL, '/tr1')
      check('TR1 follow-up round is a no-op', isNoop(tr1s2), JSON.stringify(tr1s2))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-fail423x'), { force: true }).catch(() => {})
    }
    await fsp.rm(TR1_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'tr1'), { recursive: true, force: true }).catch(() => {})
  })

  // X3：畸形 multistatus（截断 / 未闭合 / 坏实体，HTTP 分帧完整）——
  // 扫描判 incomplete、整轮中止、绝不误删；故障清除后收敛
  await section('X3：畸形 multistatus 防误删', async () => {
    await freshStore('x3')
    const X3_LOCAL = await tmpLocal('x3')
    await fsp.writeFile(path.join(X3_LOCAL, 'keep.txt'), 'k')
    await fsp.writeFile(path.join(X3_LOCAL, 'del-me.txt'), 'd')
    await syncP(X3_LOCAL, '/x3')
    await fsp.unlink(path.join(X3_LOCAL, 'del-me.txt')) // 本地删除：正常下一轮应传播为远端删除
    for (const mode of ['truncate', 'unclosed', 'badentity']) {
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-badxml'), mode)
      let x3err = null
      try {
        await syncP(X3_LOCAL, '/x3')
      } catch (e) {
        x3err = e
      }
      check(
        `X3 malformed '${mode}' aborts round as incomplete scan`,
        !!x3err && /扫描未完成/.test(x3err.message) && /解析失败/.test(x3err.message),
        x3err && x3err.message
      )
      check(
        `X3 malformed '${mode}' never deletes remote`,
        fs.existsSync(path.join(ROOT, 'x3', 'del-me.txt')) && fs.existsSync(path.join(ROOT, 'x3', 'keep.txt'))
      )
      await fsp.rm(path.join(ROOT, '.wdsync-test-badxml'), { force: true }).catch(() => {})
    }
    const x3b = await syncP(X3_LOCAL, '/x3')
    check('X3 round recovers after malformation clears (delete propagates)', x3b.deleted === 1 && !fs.existsSync(path.join(ROOT, 'x3', 'del-me.txt')), JSON.stringify(x3b))
    await fsp.rm(X3_LOCAL, { recursive: true, force: true }).catch(() => {})
  })

  // X5：超大目录响应 —— 5 万条目合成 multistatus 一次解析（含中文名 / %23 名）
  await section('X5：5 万条目大响应解析', async () => {
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-bigxml'), '50000')
    try {
      await fsp.mkdir(path.join(ROOT, 'bigxml'), { recursive: true })
      const x5t0 = Date.now()
      const scan = await services.sync._internals.listRemoteSafe(cfg, '/bigxml', true)
      const x5ms = Date.now() - x5t0
      check('X5 50k-entry listing complete with all entries', scan.complete === true && scan.files.size === 50000, `count=${scan.files.size} complete=${scan.complete}`)
      check('X5 50k-entry listing finishes promptly', x5ms < 30000, `${x5ms}ms`)
      const zh = scan.files.get('中 文7.txt')
      const hashName = scan.files.get('tag#-11.txt')
      check('X5 synthetic special names parsed with correct props', !!zh && zh.size === 8 && !!hashName && hashName.size === 12, `${JSON.stringify(zh)} ${JSON.stringify(hashName)}`)
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-bigxml'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'bigxml'), { recursive: true, force: true }).catch(() => {})
    }
  })

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

  /** 假 dbStorage 后备对象（SC 系列共用；生产为 dbStorage 的同步 KV） */
  const SC_DB = {}
  const SC_KEY = 'webdav-sync:data'
  /**
   * 写入一份调度器配置（dirs 为同步目录；prefs 缺省保持被动：不自动不启动）。
   * 密码经 services.secure.sealSecret 混淆落「dbStorage」—— 与渲染层 persist 同形态
   *（凭据混淆链路；调度器 loadConfig 内部解密）。
   */
  const setSCConfig = (dirs, prefs = {}) => {
    SC_DB[SC_KEY] = {
      server: { serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: services.secure.sealSecret('p') },
      dirs,
      prefs: { autoSync: false, intervalMin: 15, syncOnStartup: false, conflictStrategy: 'ask', ignoreHidden: true, concurrency: 4, ...prefs },
    }
  }
  /** 创建测试调度器实例（autoBootstrap:false；now / timers 可注入假时钟） */
  const createTestSched = (extra = {}) =>
    services.sync._internals.createScheduler({
      engine: {
        syncDirectory: services.sync.syncDirectory,
        watchDir: services.fsx.watchDir,
        stopWatch: services.fsx.stopWatch,
        stopAllWatch: services.fsx.stopAllWatch,
        listPendingConflicts: services.sync.listPendingConflicts,
      },
      getDeviceId: services.storage.getDeviceId,
      autoBootstrap: false,
      ...extra,
    })
  /**
   * 假时钟：手动推进 now 与定时器队列（调度器侧时间完全可控；引擎内部计时器仍为
   * 真实时间 —— 轮次完成靠真实 IO，推进循环间让出真实事件循环即可）。
   */
  const makeFakeClock = () => {
    let t = Date.now()
    const pend = new Set()
    const fire = () => {
      for (const h of Array.from(pend)) {
        if (h.dead) continue
        if (h.at <= t) {
          if (h.interval > 0) {
            h.at = t + h.interval
            h.fn()
          } else {
            h.dead = true
            pend.delete(h)
            h.fn()
          }
        }
      }
    }
    const timers = {
      setTimeout(fn, ms) {
        const h = { fn, at: t + Math.max(0, Number(ms) || 0), interval: 0, dead: false }
        pend.add(h)
        return h
      },
      clearTimeout(h) {
        if (h) {
          h.dead = true
          pend.delete(h)
        }
      },
      setInterval(fn, ms) {
        const h = { fn, at: t + Math.max(0, Number(ms) || 0), interval: Math.max(1, Number(ms) || 1), dead: false }
        pend.add(h)
        return h
      },
      clearInterval(h) {
        if (h) {
          h.dead = true
          pend.delete(h)
        }
      },
    }
    return {
      timers,
      now: () => t,
      async advance(ms, slice = 200) {
        let remaining = ms
        while (remaining > 0) {
          const step = Math.min(slice, remaining)
          t += step
          fire()
          remaining -= step
          // 让出真实事件循环：轮次 / 心跳的真实 IO 与微任务在推进间隙推进
          await new Promise((r) => setImmediate(r))
          fire()
        }
      },
    }
  }
  /** 真实时间轮询等待谓词为真（不推进假时钟） */
  const waitReal = async (pred, timeoutMs = 20000) => {
    const t0 = Date.now()
    while (!pred()) {
      if (Date.now() - t0 > timeoutMs) return false
      await sleep(20)
    }
    return true
  }
  /** 边推进假时钟边等待谓词为真（capFakeMs 限制假时钟最大推进量，防止区间外的到期任务被误触发） */
  const pumpUntil = async (clock, pred, timeoutMs = 20000, capFakeMs = Infinity) => {
    const t0 = Date.now()
    let advanced = 0
    while (!pred()) {
      if (Date.now() - t0 > timeoutMs || advanced >= capFakeMs) return false
      const step = Math.min(200, capFakeMs - advanced)
      await clock.advance(step)
      advanced += step
      await sleep(5)
    }
    return true
  }
  /** 读 leader.lock 内容（无 / 损坏返回 null） */
  const readLeaderLock = async () => {
    try {
      return JSON.parse(await fsp.readFile(path.join(storeModule.storageRoot(), 'scheduler', 'leader.lock'), 'utf-8'))
    } catch (_) {
      return null
    }
  }
  /** 原子写 leader.lock（temp+rename，模拟另一实例的接管写） */
  const writeLeaderLock = async (body) => {
    const dir = path.join(storeModule.storageRoot(), 'scheduler')
    await fsp.mkdir(dir, { recursive: true })
    const p = path.join(dir, 'leader.lock')
    const tmp = `${p}.tmp-test`
    await fsp.writeFile(tmp, JSON.stringify(body))
    await fsp.rename(tmp, p)
  }

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
    check('SC1 syncNow rejects with explicit error when not ready', !!sc1err && /未就绪/.test(sc1err.message), sc1err && sc1err.message)

    // 挂上假 dbStorage 后的测试实例：空配置 → ready + 0 slots；未知目录 → 明确报错。
    // 保留此前装载的回收站桩（deleteLocalOne 依赖 shellTrashItem，
    // 后续节的 delete-local 路径不得因本节换桩而失去宿主接口）
    const prevTrash = global.window.ztools && global.window.ztools.shellTrashItem
    global.window.ztools = {
      dbStorage: { getItem: (k) => (k in SC_DB ? SC_DB[k] : null), setItem: (k, v) => { SC_DB[k] = v } },
      ...(prevTrash ? { shellTrashItem: prevTrash } : {}),
    }
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
    check('SC1 syncNow unknown dir rejects explicitly', !!sc1err2 && /未找到同步目录/.test(sc1err2.message), sc1err2 && sc1err2.message)
    let sc1err3 = null
    try {
      await sc1.syncNow()
    } catch (e) {
      sc1err3 = e
    }
    check('SC1 syncNow with no enabled dirs rejects explicitly', !!sc1err3 && /没有启用的同步目录/.test(sc1err3.message), sc1err3 && sc1err3.message)

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

  // ---- SC2（快，假时钟）：DirSlot 状态机 —— 启动轮 / interval 锚定 / concurrent
  //      重入置 rerunPending / 取消保持原计划 / reload 新目录 ----
  await section('SC2：DirSlot 状态机（假时钟）', async () => {
    await freshStore('sc2')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-throttle'), '5')
    const clock = makeFakeClock()
    const SC2_LOCAL = await tmpLocal('sc2')
    const sc2dir = { id: 'd1', localPath: SC2_LOCAL, remotePath: '/sc2', mode: 'two-way' }
    await fsp.writeFile(path.join(SC2_LOCAL, 'a.txt'), 'sc2-a')
    setSCConfig([sc2dir], { autoSync: true, intervalMin: 1, syncOnStartup: true })
    const sched = createTestSched({ now: clock.now, timers: clock.timers })
    const events = []
    sched.subscribe((ev) => events.push(ev))
    const roundEnds = () => events.filter((e) => e.type === 'round-end')
    try {
      const snap0 = await sched.init()
      // 选举在 init 后异步完成（真实 IO）：泵动假时钟等待上位，再断言
      const elected = await pumpUntil(clock, () => sched.getSnapshot().leader.isLeader === true, 8000, 8000)
      check(
        'SC2 init loads config, elects leader (single instance), 1 slot',
        snap0.ready === true && snap0.slots.length === 1 && elected,
        JSON.stringify({ ready: snap0.ready, leader: sched.getSnapshot().leader })
      )
      check('SC2 leader.lock holds this instance token', (await readLeaderLock())?.instanceId === sched.instanceId, '')
      // 本节测 DirSlot 状态机（假时钟）：autoSync=true 使 leader 挂了 watcher，而测试
      // 写入 b.txt / c-throttle.bin 会在 1.5s 真实去抖后注入 watch 触发 —— 真实时钟
      // 事件与假时钟断言窗竞态（rerunPending 轮末 +2s 重排按规格清掉 interval 预订，
      // 「取消保持原计划」断言被测试自身的写入污染）。显式摘掉 watcher 使本节完全
      // 由假时钟决定（watcher 集成由 SC3 专测）；watcherId 契约 = `${instanceId}:${dirId}`
      services.fsx.stopWatch(`${sched.instanceId}:d1`)
      // 启动轮（syncOnStartup）：排队 → running → round-end（uploaded=1）。
      // 泵只负责把 tick 推到发射（假时钟管调度决策，不驱动真实 IO）；轮体是真实
      // IO（首轮含能力探测，冷缓存实测可达 ~2s）——若靠持续泵假时钟等轮结束，
      // 30000ms fake 上限折算的真实时间不够冷轮跑完，且推进过量会吞掉 interval
      // 预订窗（firstDue-now 失真）。故：泵到 running 即止，round-end 用真实时钟等
      const startupStarted = await pumpUntil(clock, () => roundEnds().length >= 1 || (sched.getSnapshot().slots[0] && sched.getSnapshot().slots[0].state === 'running'), 15000, 30000)
      const startupOk = startupStarted && (await waitReal(() => roundEnds().length >= 1, 15000))
      check(
        'SC2 startup round runs and uploads',
        startupOk && roundEnds()[0].error == null && roundEnds()[0].summary && roundEnds()[0].summary.uploaded === 1,
        JSON.stringify(roundEnds()[0] || {})
      )
      let slot = sched.getSnapshot().slots[0]
      const firstDue = slot.nextDueAt
      check(
        'SC2 interval booked (+60s from load) after startup round',
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
      // B2-fix 4.1：取消点必须锚定在「PUT 真正在途」。路径须含 'throttle' 才被
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
        cancelRes.ok === false && /同步已中止/.test(cancelRes.error || '') && lastEnd.cancelled === true,
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
      setSCConfig([sc2dir, { id: 'd2', localPath: SC2_LOCAL, remotePath: '/sc2b', mode: 'two-way' }], { autoSync: true, intervalMin: 1, syncOnStartup: true })
      const rl2 = await sched.reload()
      const snapRl = sched.getSnapshot()
      check(
        'SC2 reload picks up new dir (new slot + configV changes)',
        rl2.applied === true && snapRl.slots.length === 2 && snapRl.configV !== cfgVBefore,
        JSON.stringify({ applied: rl2.applied, slots: snapRl.slots.length })
      )
      // 同 SC2 启动轮：泵到 d2 的 startup 轮 running 即止（冷缓存探测轮 ~2s 真实
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
  await slowSection('SC3：leader 心跳与冲突前后台语义', '真实心跳 5s 采样×2 + 10MB 节流长轮（~7s）+ watch 去抖（~2s）', async () => {
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
        setSCConfig([sc3dir], { autoSync: true, intervalMin: 30, syncOnStartup: false })
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
  await slowSection('SC4：目录锁接管与 lost 中止', '真实心跳 5s 探测窗 + 16MB 节流长轮（~10s）', async () => {
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
        // B2-fix 4.1：外来锁写入等 reqlog 出现目标 PUT 行才开始 —— 把「中止发生在
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
          lostEnd && lostRound.cancelled === true && /同步已中止/.test(lostRound.error || ''),
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
        check('SC4 syncNow of the aborted round surfaces the cancel error', lostRes.ok === false && /同步已中止/.test(lostRes.error || ''), JSON.stringify(lostRes.error))
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
  await slowSection('SC6：手动委托与双实例互斥', 'leader 心跳领取窗（≤5s）×2 场景 + 双手动并发串行化（~12s）', async () => {
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
  await slowSection('SC7：无卸载事件死亡的超时兜底与 TTL 接管', '委托 15s 超时（真实等待）+ leader TTL 15s 过期 + 选举重试（~22s）', async () => {
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
  await section('SC8：全局并发与公平（双 origin）', async () => {
    // 第二个 dav-server 实例（不同 origin）：「每 origin 并发 1」需要两个 origin 才
    // 可验证。目录级 serverUrl 覆盖指向它（UI 不写该字段 —— 单服务器用户行为不变）。
    const PORT2 = 5361
    const ROOT2 = path.join(HERE, '.dav-root-sc8b')
    await fsp.rm(ROOT2, { recursive: true, force: true }).catch(() => {})
    const server2 = spawn(process.execPath, [path.join(HERE, 'dav-server.mjs'), String(PORT2), ROOT2], { stdio: 'pipe' })
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('sc8 second server start timeout')), 5000)
      server2.stdout.on('data', (d) => {
        if (String(d).includes('listening')) {
          clearTimeout(t)
          resolve()
        }
      })
      server2.stderr.on('data', (d) => console.error('[dav2]', String(d)))
    })
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
  await slowSection('SC9：跨轮退避 / follow-up / yield / 时钟跳变', '503×4 重试链 ×5（~3.5s/轮）+ netcut 恢复轮 ×7 + 真实 watch 去抖（~2.5s）', async () => {
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
      setSCConfig([{ id: 'd1', localPath: LP, remotePath: '/sc9a', mode: 'two-way' }], { autoSync: true, intervalMin: 1, syncOnStartup: false, leaseLock: false })
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
      setSCConfig([{ id: 'd1', localPath: LP, remotePath: '/sc9a2', mode: 'two-way' }], { autoSync: true, intervalMin: 1, syncOnStartup: false, leaseLock: false })
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
      setSCConfig([{ id: 'd1', localPath: LP, remotePath: '/sc9b', mode: 'two-way' }], { autoSync: true, intervalMin: 1, syncOnStartup: false, leaseLock: false })
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
      setSCConfig([{ id: 'd1', localPath: LP, remotePath: '/sc9c', mode: 'two-way' }], { autoSync: true, intervalMin: 1, syncOnStartup: false })
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
    await setProfile('p2')
    try {
      await freshStore('sc9p2')
      const LP = await tmpLocal('sc9p2')
      await fsp.mkdir(path.join(LP, 'dedupfail'), { recursive: true })
      await fsp.writeFile(path.join(LP, 'dedupfail', 'f1.txt'), 'sc9p2-f1')
      await fsp.writeFile(path.join(LP, 't1.toolarge.txt'), 'sc9p2-too-large')
      // autoSync true：backoff-expiry 轮经 tick 发射（自动调度门控）；选举后摘 watcher
      setSCConfig([{ id: 'd1', localPath: LP, remotePath: '/sc9p2', mode: 'two-way' }], { autoSync: true, intervalMin: 1, syncOnStartup: false, leaseLock: false })
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
      setSCConfig([sc10dir], { autoSync: true, intervalMin: 1, syncOnStartup: false })
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
          p1 && p1.dirId === 'd1' && p1.newlyNotified === true && p1.items.some((it) => it.rel === 'c1.txt' && !it.choice) && notes.length === 1 && /1 个待处理冲突/.test(notes[0] || ''),
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
          notes.length === 2 && /1 个待处理冲突/.test(notes[1]) && lastPending && lastPending.newlyNotified === true && lastPending.items.some((it) => it.rel === 'c2.txt'),
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
        rBreaker.tone === 'breaker' && rBreaker.title === '服务器连续无响应' && /HTTP 503/.test(rBreaker.detail) && rBreaker.errors.length === 2 && rBreaker.errors[0].startsWith(noise) && rBreaker.errors[0].includes('共 3 次') && rBreaker.errors[1] === 'other',
        JSON.stringify(rBreaker)
      )
      const rPartial = sr({ deferredConflicts: 3, errors: [] }, null, false)
      check('SC10 summarizeRound: deferred round reads as partial completion', rPartial.tone === 'partial' && rPartial.title === '部分完成，有 3 个待处理冲突', JSON.stringify(rPartial))
      const rCancel = sr(null, '同步已中止：用户取消', true)
      check('SC10 summarizeRound: cancelled tone', rCancel.tone === 'cancelled' && rCancel.title === '已取消同步', '')
      const rOk = sr({ errors: [] }, null, false)
      check('SC10 summarizeRound: clean round reads ok', rOk.tone === 'ok' && rOk.title === '同步完成', '')
      const rErr = sr({ errors: ['e1', 'e1'] }, null, false)
      check('SC10 summarizeRound: repeated identical errors fold with count', rErr.tone === 'error' && rErr.errors.length === 1 && rErr.errors[0].includes('共 2 次'), JSON.stringify(rErr))
    } finally {
      delete zt.showNotification
    }
  })

  // ---- W10（快，B2-fix 4.2）：watcher 同名窄洞（注入事件形态）与 interval 兜底 ----
  // 窄洞（README 已知边界）：用户文件恰与被监听目录同名、且平台以 change 事件上报其
  // 修改时，会被 watchDir 的「目录自事件过滤器」一并吞掉（evt=change 且 filename 全等
  // 目录名）。Windows 的内容修改正是 change 形态（README 口径，未在本机验证）；
  // macOS 实测（darwin 24.6 / Node 22，B2-fix 探针两次运行一致）：用户文件的创建 /
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
    setSCConfig([w10dir], { autoSync: true, intervalMin: 1, syncOnStartup: false })
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

  // SC 系列收尾：摘掉假 ztools，还原全局形态（后续 finally 的 services.cleanup 不受影响）
  delete global.window.ztools
  SC_DB[SC_KEY] = null

  // ── DS 系列：删除安全 ──────────────────────────────────
  // 五项保护各有「正常通过 + 保护生效」两类用例：批量删除阈值 / 本地删除进回收站 /
  // 本地根健康检查 / 远端根 404 重建 / 空目录清理。SC 收尾已摘掉假 ztools —— 本系列
  // 依赖回收站桩，先重装。
  installTrash()

  // DS1 批量删除阈值：少量删除正常传播（含恰等于阈值的边界放行）；超过
  // max(50, 基线×20%) 整批挂起（kind='delete' 无 choice），确认前零删除且跨轮持续；
  // 确认（delete）下一轮执行、保留（keep）持续抑制、确认标记随落地清除。
  // 注：用例刻意保留至少 1 个本地文件 —— 「本地删光」由 DS3 的空根目录保护拦截，
  // 不属于阈值通道（两层保护互斥地各管一段）
  await section('DS1：批量删除阈值与挂起确认', async () => {
    // —— 正常通过 + 边界：110 文件基线（阈值 max(50,22)=50），删 10 → 直接传播；
    // 再删 50（剩 50，目录非空）→ 恰等于阈值（不「超过」）→ 放行
    const LA = path.join(os.tmpdir(), `wdsync-e2e-ds1a-${Date.now()}`)
    const dA = () => ({ id: 'ds1a', localPath: LA, remotePath: '/ds1a', mode: 'two-way' })
    await fsp.mkdir(LA, { recursive: true })
    for (let i = 0; i < 110; i++) await fsp.writeFile(path.join(LA, `f${i}.txt`), `c${i}`)
    await services.sync.syncDirectory(cfg, dA(), SP, {})
    for (let i = 0; i < 10; i++) await fsp.unlink(path.join(LA, `f${i}.txt`))
    const a1 = await services.sync.syncDirectory(cfg, dA(), SP, {})
    check(
      'DS1 少量删除正常传播（10 ≤ 50，不触发阈值）',
      a1.deleted === 10 && a1.deleteHeld === 0 && fs.readdirSync(path.join(ROOT, 'ds1a')).length === 100,
      JSON.stringify({ deleted: a1.deleted, deleteHeld: a1.deleteHeld })
    )
    for (let i = 10; i < 60; i++) await fsp.unlink(path.join(LA, `f${i}.txt`))
    const a2 = await services.sync.syncDirectory(cfg, dA(), SP, {})
    check(
      'DS1 恰等于阈值放行（50 不大于 50）',
      a2.deleted === 50 && a2.deleteHeld === 0 && fs.readdirSync(path.join(ROOT, 'ds1a')).length === 50,
      JSON.stringify({ deleted: a2.deleted, deleteHeld: a2.deleteHeld })
    )
    await fsp.rm(LA, { recursive: true, force: true }).catch(() => {})

    // —— 保护生效：60 文件删除 59 个（留 1 个使目录非空）→ 59 > 50 整批挂起，
    // 确认前零删除
    const LB = path.join(os.tmpdir(), `wdsync-e2e-ds1b-${Date.now()}`)
    const dB = () => ({ id: 'ds1b', localPath: LB, remotePath: '/ds1b', mode: 'two-way' })
    await fsp.mkdir(LB, { recursive: true })
    for (let i = 0; i < 60; i++) await fsp.writeFile(path.join(LB, `f${i}.txt`), `c${i}`)
    await services.sync.syncDirectory(cfg, dB(), SP, {})
    for (let i = 0; i < 59; i++) await fsp.unlink(path.join(LB, `f${i}.txt`))
    const b1 = await services.sync.syncDirectory(cfg, dB(), SP, {})
    const pend1 = await services.sync._internals.getPendings(dB())
    check(
      'DS1 超阈值整批挂起：本轮零删除、远端原样',
      b1.deleted === 0 && b1.deleteHeld === 59 && fs.readdirSync(path.join(ROOT, 'ds1b')).length === 60,
      JSON.stringify({ deleted: b1.deleted, deleteHeld: b1.deleteHeld })
    )
    check(
      'DS1 挂起记录 kind=delete 且无 choice（待确认）',
      pend1.length === 59 && pend1.every((p) => p.kind === 'delete' && !p.choice),
      `pendings=${pend1.length}`
    )
    check('DS1 超阈值轮给出明确警告', b1.warnings.some((w) => /安全阈值/.test(w)), JSON.stringify(b1.warnings))
    // 确认前再跑一轮：挂起条目与阈值无关地持续等待确认（不因数量回落放行）
    const b2 = await services.sync.syncDirectory(cfg, dB(), SP, {})
    check('DS1 确认前跨轮持续零删除', b2.deleted === 0 && b2.deleteHeld === 59, JSON.stringify({ deleted: b2.deleted, deleteHeld: b2.deleteHeld }))
    // 确认 30（delete）保留 29（keep）→ 下一轮分别执行与抑制（留存的 f59 不受影响）
    const rels = pend1.map((p) => p.rel).sort()
    for (let i = 0; i < 30; i++) await services.sync.setPendingChoice(dB(), rels[i], 'delete')
    for (let i = 30; i < 59; i++) await services.sync.setPendingChoice(dB(), rels[i], 'keep')
    const b3 = await services.sync.syncDirectory(cfg, dB(), SP, {})
    check(
      'DS1 确认删除落地 30 个（远端剩 30 = 保留 29 + 未删的 1）',
      b3.deleted === 30 && fs.readdirSync(path.join(ROOT, 'ds1b')).length === 30,
      JSON.stringify({ deleted: b3.deleted, remote: fs.readdirSync(path.join(ROOT, 'ds1b')).length })
    )
    check('DS1 保留的 29 个被抑制并计数', b3.deleteKept === 29 && b3.deleteRootGuard === 0, JSON.stringify({ deleteKept: b3.deleteKept }))
    const pend2 = await services.sync._internals.getPendings(dB())
    check(
      'DS1 确认标记随落地清除、保留标记留存',
      pend2.length === 29 && pend2.every((p) => p.choice === 'keep' && p.kind === 'delete'),
      `pendings=${pend2.length}`
    )
    const b4 = await services.sync.syncDirectory(cfg, dB(), SP, {})
    check(
      'DS1 保留标记跨轮持续抑制删除传播',
      b4.deleted === 0 && b4.deleteKept === 29 && fs.readdirSync(path.join(ROOT, 'ds1b')).length === 30,
      JSON.stringify({ deleted: b4.deleted, deleteKept: b4.deleteKept })
    )
    // 非法选择值按记录类别拒绝（删除类挂起不接受 local/remote/both）
    let choiceErr = null
    try {
      await services.sync.setPendingChoice(dB(), rels[30], 'local')
    } catch (e) {
      choiceErr = e
    }
    check('DS1 删除类挂起拒绝冲突类选择值', !!choiceErr && /无效的挂起处理选择/.test(choiceErr.message), choiceErr && choiceErr.message)
    await fsp.rm(LB, { recursive: true, force: true }).catch(() => {})
  })

  // DS2 本地删除走回收站：正常经 ztools.shellTrashItem 进回收目录；失败（API 抛错 /
  // 宿主未注入）跳过该文件并记录，绝不退化 unlink（文件留在原地、基线保留）
  await section('DS2：本地删除走回收站（不退化 unlink）', async () => {
    const L = path.join(os.tmpdir(), `wdsync-e2e-ds2-${Date.now()}`)
    const d = () => ({ id: 'ds2', localPath: L, remotePath: '/ds2', mode: 'two-way' })
    await fsp.mkdir(L, { recursive: true })
    for (const n of ['a.txt', 'b.txt', 'c.txt', 'e.txt']) await fsp.writeFile(path.join(L, n), `ds2-${n}`)
    await services.sync.syncDirectory(cfg, d(), SP, {})
    // —— 正常通过：远端删除 2 个 → 本地经回收站 API 删除，文件本体保留在回收目录
    trashLog.length = 0
    await fsp.rm(path.join(ROOT, 'ds2', 'a.txt'))
    await fsp.rm(path.join(ROOT, 'ds2', 'b.txt'))
    const ok = await services.sync.syncDirectory(cfg, d(), SP, {})
    const trashedNames = fs.readdirSync(TRASH_DIR)
    check(
      'DS2 删除经 shellTrashItem 落地（本地消失、远端目标态达成）',
      ok.deleted === 2 && !fs.existsSync(path.join(L, 'a.txt')) && !fs.existsSync(path.join(L, 'b.txt')) && trashLog.length === 2,
      JSON.stringify({ deleted: ok.deleted, trashCalls: trashLog.length })
    )
    check('DS2 回收目录保留文件本体（可找回）', trashedNames.some((n) => n.endsWith('a.txt')) && trashedNames.some((n) => n.endsWith('b.txt')), trashedNames.join(','))
    check('DS2 回收站删除后基线条目移除', (await services.sync._internals.baselineEntry(d(), 'a.txt')) === null, '')
    // —— 保护生效 ①：回收站调用抛错 → 跳过并记录，不退化 unlink
    trashFailNext = 1
    await fsp.rm(path.join(ROOT, 'ds2', 'c.txt'))
    let e1 = null
    try {
      await services.sync.syncDirectory(cfg, d(), SP, {})
    } catch (e) {
      e1 = e
    }
    check(
      'DS2 回收站失败跳过并记录（文件保留、基线保留）',
      !!e1 && /删除本地文件失败/.test(e1.message) && fs.existsSync(path.join(L, 'c.txt')) && (await services.sync._internals.baselineEntry(d(), 'c.txt')) != null,
      e1 && e1.message
    )
    check('DS2 失败路径确实调用了回收站 API（未绕过）', trashLog.some((p) => p.endsWith('c.txt')), trashLog.map((p) => path.basename(p)).join(','))
    // —— 保护生效 ②：宿主未注入回收站接口 → 同样跳过并记录
    trashMissing = true
    installTrash()
    await fsp.rm(path.join(ROOT, 'ds2', 'e.txt'))
    let e2 = null
    try {
      await services.sync.syncDirectory(cfg, d(), SP, {})
    } catch (e) {
      e2 = e
    }
    check(
      'DS2 宿主无回收站接口跳过并记录（不删除）',
      !!e2 && /回收站接口/.test(e2.message) && fs.existsSync(path.join(L, 'e.txt')) && (await services.sync._internals.baselineEntry(d(), 'e.txt')) != null,
      e2 && e2.message
    )
    trashMissing = false
    installTrash()
    // 接口恢复后（模拟下一轮）删除收敛
    const ok2 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check('DS2 接口恢复后下一轮删除收敛（e.txt 进回收站）', ok2.deleted >= 1 && !fs.existsSync(path.join(L, 'e.txt')), JSON.stringify({ deleted: ok2.deleted }))
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
  })

  // DS3 本地根健康检查：根目录不存在 / 不可读 / 空目录+非空基线（疑似未挂载或被清空）
  // → 整轮中止零删除（远端原样）；正常目录照常同步
  await section('DS3：本地根健康检查', async () => {
    const L = path.join(os.tmpdir(), `wdsync-e2e-ds3-${Date.now()}`)
    const d = () => ({ id: 'ds3', localPath: L, remotePath: '/ds3', mode: 'two-way' })
    await fsp.mkdir(L, { recursive: true })
    for (const n of ['a.txt', 'b.txt', 'c.txt']) await fsp.writeFile(path.join(L, n), `ds3-${n}`)
    const ok = await services.sync.syncDirectory(cfg, d(), SP, {})
    check('DS3 正常根目录照常同步', ok.uploaded === 3, JSON.stringify(ok))
    // —— 保护 ①：根目录不存在（改名挪走模拟消失 / 未挂载路径）
    await fsp.rename(L, `${L}-gone`)
    let e1 = null
    try {
      await services.sync.syncDirectory(cfg, d(), SP, {})
    } catch (e) {
      e1 = e
    }
    check(
      'DS3 根目录不存在 → 整轮中止，远端原样',
      !!e1 && /本地同步根目录不可访问/.test(e1.message) && fs.readdirSync(path.join(ROOT, 'ds3')).length === 3,
      e1 && e1.message
    )
    await fsp.rename(`${L}-gone`, L)
    // —— 保护 ②：根目录不可读（POSIX chmod 000；Windows 该形态由 icacls 类 ACL 承担，
    // 属平台差异，此处不重复注入 —— 见 README 已知边界）
    if (process.platform !== 'win32') {
      await fsp.chmod(L, 0o000)
      let e2 = null
      try {
        await services.sync.syncDirectory(cfg, d(), SP, {})
      } catch (e) {
        e2 = e
      }
      check(
        'DS3 根目录不可读 → 整轮中止，远端原样',
        !!e2 && /本地同步根目录不可读/.test(e2.message) && fs.readdirSync(path.join(ROOT, 'ds3')).length === 3,
        e2 && e2.message
      )
      await fsp.chmod(L, 0o755)
    } else {
      check('DS3 根目录不可读（POSIX 形态）在 Windows 跳过（平台差异，未验证）', true)
    }
    // —— 保护 ③：空目录 + 非空基线（外置盘/网络盘掉线后挂载点残留的典型形态；
    // 用户真的删光本地文件也会命中 —— 保守取向，由目录配置检查 / 批量删除确认通道解决）
    for (const n of ['a.txt', 'b.txt', 'c.txt']) await fsp.unlink(path.join(L, n))
    let e3 = null
    try {
      await services.sync.syncDirectory(cfg, d(), SP, {})
    } catch (e) {
      e3 = e
    }
    check(
      'DS3 空目录+非空基线（疑似未挂载/被清空）→ 整轮中止，远端原样',
      !!e3 && /疑似目录未挂载|已被清空/.test(e3.message) && fs.readdirSync(path.join(ROOT, 'ds3')).length === 3,
      e3 && e3.message
    )
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
  })

  // DS4 远端根 404 重建保护：远端整根消失（404 → MKCOL 重建）且本地基线非空时，
  // 删除传播禁用 —— delete-local 改判为恢复上传（远端缺失是根消失伪象，复活取向）；
  // 和解完成后自动恢复删除传播。基线为空（首次同步）不触发保护。
  await section('DS4：远端根 404 重建保护', async () => {
    const L = path.join(os.tmpdir(), `wdsync-e2e-ds4-${Date.now()}`)
    const d = () => ({ id: 'ds4', localPath: L, remotePath: '/ds4', mode: 'two-way' })
    await fsp.mkdir(L, { recursive: true })
    for (let i = 0; i < 8; i++) await fsp.writeFile(path.join(L, `f${i}.txt`), `ds4-${i}`)
    const r1 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check('DS4 首次同步（基线为空的 404 重建不触发保护）', r1.uploaded === 8 && r1.deleteRootGuard === 0, JSON.stringify({ uploaded: r1.uploaded, guard: r1.deleteRootGuard }))
    // —— 保护生效：删除整个远端根 → 重建轮零删除 + 恢复上传 + 保护标记
    await services.dav.remove(cfg, '/ds4')
    const r2 = await services.sync.syncDirectory(cfg, d(), SP, {})
    let localLeft = 0
    for (let i = 0; i < 8; i++) if (fs.existsSync(path.join(L, `f${i}.txt`))) localLeft++
    check(
      'DS4 重建轮：零本地删除 + 删除改判为恢复上传（8 个全部重传）',
      r2.deleted === 0 && r2.uploaded === 8 && r2.deleteRootGuard === 8 && localLeft === 8,
      JSON.stringify({ deleted: r2.deleted, uploaded: r2.uploaded, guard: r2.deleteRootGuard, localLeft })
    )
    check('DS4 远端恢复全部 8 个文件', fs.readdirSync(path.join(ROOT, 'ds4')).length === 8, '')
    check('DS4 保护标记写入 meta', (await services.sync._internals.getDirMeta(d())).rootRebuilt != null, '')
    // —— 和解完成 → 保护解除（干净轮 guard=0 自动清标记）
    const r3 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check('DS4 和解后干净轮为 no-op', isNoop(r3), JSON.stringify(r3))
    check('DS4 和解完成自动解除保护标记', (await services.sync._internals.getDirMeta(d())).rootRebuilt === undefined, '')
    // —— 正常通过：解除后删除传播恢复正常
    await fsp.unlink(path.join(L, 'f0.txt'))
    const r4 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check('DS4 解除后删除传播恢复（单文件删除正常执行）', r4.deleted === 1 && !fs.existsSync(path.join(ROOT, 'ds4', 'f0.txt')), JSON.stringify({ deleted: r4.deleted }))
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
  })

  // DS4b 交互优先级：已确认的删除（choice=delete）优先于远端根重建保护 ——
  // 场景：远端批量删除触发阈值挂起 → 用户确认其中 1 个 → 此后远端整根消失重建，
  // 重建轮里已确认者照删（显式同意），未确认者继续挂起，其余未删文件恢复上传
  await section('DS4b：确认删除优先于根重建保护', async () => {
    const L = path.join(os.tmpdir(), `wdsync-e2e-ds4b-${Date.now()}`)
    const d = () => ({ id: 'ds4b', localPath: L, remotePath: '/ds4b', mode: 'two-way' })
    await fsp.mkdir(L, { recursive: true })
    for (let i = 0; i < 55; i++) await fsp.writeFile(path.join(L, `f${i}.txt`), `ds4b-${i}`)
    await services.sync.syncDirectory(cfg, d(), SP, {})
    // 远端删 54 个（留 f54）→ 54 > max(50,11) 触发阈值 → 全部挂起待确认
    for (let i = 0; i < 54; i++) await fsp.rm(path.join(ROOT, 'ds4b', `f${i}.txt`))
    const h1 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check('DS4b 前置：远端批量删除触发阈值挂起', h1.deleted === 0 && h1.deleteHeld === 54, JSON.stringify({ deleted: h1.deleted, deleteHeld: h1.deleteHeld }))
    // 用户确认 1 个（f0），其余 53 个保持待确认
    await services.sync.setPendingChoice(d(), 'f0.txt', 'delete')
    // 远端整根消失（连带 f54 的远端副本）→ 重建轮：确认者优先执行，未确认者继续挂起
    await services.dav.remove(cfg, '/ds4b')
    trashLog.length = 0
    const r = await services.sync.syncDirectory(cfg, d(), SP, {})
    check(
      'DS4b 重建轮：确认者照删（显式同意优先于根重建保护）',
      r.deleted === 1 && !fs.existsSync(path.join(L, 'f0.txt')) && trashLog.some((p) => p.endsWith('f0.txt')),
      JSON.stringify({ deleted: r.deleted })
    )
    check(
      'DS4b 重建轮：未确认者继续挂起、未删文件恢复上传',
      r.deleteHeld === 53 && r.deleteRootGuard === 1 && r.uploaded === 1 && fs.readdirSync(path.join(ROOT, 'ds4b')).length === 1,
      JSON.stringify({ deleteHeld: r.deleteHeld, guard: r.deleteRootGuard, uploaded: r.uploaded, remote: fs.readdirSync(path.join(ROOT, 'ds4b')) })
    )
    check('DS4b 确认标记随落地清除（剩 53 个待确认）', (await services.sync._internals.getPendings(d())).length === 53, '')
    // 后续轮：和解完成 → 保护解除；53 个挂起仍持续等待确认（与保护独立）
    const r2 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check(
      'DS4b 和解后保护解除、挂起持续等待确认',
      r2.deleteRootGuard === 0 && r2.deleteHeld === 53 && r2.deleted === 0 && (await services.sync._internals.getDirMeta(d())).rootRebuilt === undefined,
      JSON.stringify({ guard: r2.deleteRootGuard, deleteHeld: r2.deleteHeld, deleted: r2.deleted })
    )
    // 全部确认 → 收敛：本地进回收站，两端各剩 f54
    for (let i = 1; i < 54; i++) await services.sync.setPendingChoice(d(), `f${i}.txt`, 'delete')
    const r3 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check(
      'DS4b 全部确认后收敛（两端各剩 1 个文件）',
      r3.deleted === 53 && fs.readdirSync(L).length === 1 && fs.readdirSync(path.join(ROOT, 'ds4b')).length === 1,
      JSON.stringify({ deleted: r3.deleted, local: fs.readdirSync(L), remote: fs.readdirSync(path.join(ROOT, 'ds4b')) })
    )
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
  })

  // DS5 空目录清理：只清理「因本轮同步删除而变空」的目录（两侧各自处理自己执行的
  // 删除留下的空目录）；非空目录不动；远端 DELETE 前逐目录 PROPFIND 复核，他机在
  // 删除后写入的新内容使清理跳过（不递归误删）
  await section('DS5：空目录清理（两端）', async () => {
    // —— 正常（远端侧）：本地删除 sub/a.txt、sub/inner/b.txt → delete-remote ×2，
    // 远端 sub/inner、sub 变空被清理；本地目录是用户自己的删除行为，不在引擎清理范围
    const L1 = path.join(os.tmpdir(), `wdsync-e2e-ds5a-${Date.now()}`)
    const d1 = () => ({ id: 'ds5a', localPath: L1, remotePath: '/ds5a', mode: 'two-way' })
    await fsp.mkdir(path.join(L1, 'sub', 'inner'), { recursive: true })
    await fsp.writeFile(path.join(L1, 'top.txt'), 'top')
    await fsp.writeFile(path.join(L1, 'sub', 'a.txt'), 'a')
    await fsp.writeFile(path.join(L1, 'sub', 'inner', 'b.txt'), 'b')
    await services.sync.syncDirectory(cfg, d1(), SP, {})
    await fsp.unlink(path.join(L1, 'sub', 'a.txt'))
    await fsp.unlink(path.join(L1, 'sub', 'inner', 'b.txt'))
    const r1 = await services.sync.syncDirectory(cfg, d1(), SP, {})
    check(
      'DS5 远端空目录清理（嵌套子树自底向上）',
      r1.deleted === 2 && r1.dirsPrunedRemote === 2 && !fs.existsSync(path.join(ROOT, 'ds5a', 'sub')) && fs.existsSync(path.join(ROOT, 'ds5a', 'top.txt')),
      JSON.stringify({ deleted: r1.deleted, dirsPrunedRemote: r1.dirsPrunedRemote })
    )
    check('DS5 本地目录（用户自己的删除）不清理', fs.existsSync(path.join(L1, 'sub')), '')
    await fsp.rm(L1, { recursive: true, force: true }).catch(() => {})

    // —— 正常（本地侧）：远端删除 x/a.txt → delete-local 进回收站 → 本地 x/ 变空被清理
    const L2 = path.join(os.tmpdir(), `wdsync-e2e-ds5b-${Date.now()}`)
    const d2 = () => ({ id: 'ds5b', localPath: L2, remotePath: '/ds5b', mode: 'two-way' })
    await fsp.mkdir(path.join(L2, 'x'), { recursive: true })
    await fsp.writeFile(path.join(L2, 'x', 'a.txt'), 'a')
    await services.sync.syncDirectory(cfg, d2(), SP, {})
    await fsp.rm(path.join(ROOT, 'ds5b', 'x', 'a.txt'))
    const r2 = await services.sync.syncDirectory(cfg, d2(), SP, {})
    check(
      'DS5 本地空目录清理（delete-local 后 rmdir）',
      r2.deleted === 1 && r2.dirsPrunedLocal === 1 && !fs.existsSync(path.join(L2, 'x')),
      JSON.stringify({ deleted: r2.deleted, dirsPrunedLocal: r2.dirsPrunedLocal })
    )
    await fsp.rm(L2, { recursive: true, force: true }).catch(() => {})

    // —— 保护 ①：目录仍含其他文件 → 不清理（rmdir 对非空原子失败）
    const L3 = path.join(os.tmpdir(), `wdsync-e2e-ds5c-${Date.now()}`)
    const d3 = () => ({ id: 'ds5c', localPath: L3, remotePath: '/ds5c', mode: 'two-way' })
    await fsp.mkdir(path.join(L3, 'subk'), { recursive: true })
    await fsp.writeFile(path.join(L3, 'subk', 'a.txt'), 'a')
    await fsp.writeFile(path.join(L3, 'subk', 'keep.txt'), 'keep')
    await services.sync.syncDirectory(cfg, d3(), SP, {})
    await fsp.rm(path.join(ROOT, 'ds5c', 'subk', 'a.txt'))
    const r3 = await services.sync.syncDirectory(cfg, d3(), SP, {})
    check(
      'DS5 非空目录不清理（其余文件保留）',
      r3.deleted === 1 && r3.dirsPrunedLocal === 0 && fs.existsSync(path.join(L3, 'subk', 'keep.txt')),
      JSON.stringify({ deleted: r3.deleted, dirsPrunedLocal: r3.dirsPrunedLocal })
    )
    await fsp.rm(L3, { recursive: true, force: true }).catch(() => {})

    // —— 保护 ②：他机在「删除 → 清理」窗口内写入新文件 → 远端 PROPFIND 复核发现
    // 子条目后跳过清理（快照判定可清 ≠ 此刻仍空；集合 DELETE 是递归删除，绝不裸删）。
    // 注入点：首轮 onProgress 的第一个 plan 事件（扫描已完成、传输未开始）。
    const L4 = path.join(os.tmpdir(), `wdsync-e2e-ds5d-${Date.now()}`)
    const d4 = () => ({ id: 'ds5d', localPath: L4, remotePath: '/ds5d', mode: 'two-way' })
    await fsp.mkdir(path.join(L4, 'sub3'), { recursive: true })
    await fsp.writeFile(path.join(L4, 'sub3', 'a.txt'), 'a')
    await services.sync.syncDirectory(cfg, d4(), SP, {})
    await fsp.unlink(path.join(L4, 'sub3', 'a.txt'))
    let injected = false
    const r4 = await services.sync.syncDirectory(cfg, d4(), SP, {
      onProgress: (p) => {
        if (!injected && p && p.phase === 'plan') {
          injected = true
          fs.writeFileSync(path.join(ROOT, 'ds5d', 'sub3', 'new-from-peer.txt'), 'peer')
        }
      },
    })
    check(
      'DS5 复核发现他机新写入 → 远端目录不清理',
      r4.deleted === 1 && r4.dirsPrunedRemote === 0 && fs.existsSync(path.join(ROOT, 'ds5d', 'sub3', 'new-from-peer.txt')),
      JSON.stringify({ deleted: r4.deleted, dirsPrunedRemote: r4.dirsPrunedRemote })
    )
    check('DS5 注入确实发生在扫描后（plan 事件）', injected, '')
    await fsp.rm(L4, { recursive: true, force: true }).catch(() => {})
  })

  // ============================================================
  // FN 系列（跨平台与配置安全）
  // FN0 NFC 规范化一致性（NFD 服务器名 ↔ NFC 内部 key / origName 落地）
  // FN1 内置垃圾排除（始终生效，与 ignoreHidden 独立）+ 用户排除规则
  // FN2 Windows 文件名预检（非法字符 / 保留名 / 尾空格点 / 超长 → BAD_FILENAME 退避）
  // FN3 大小写冲突检测（跨侧 / 远端同名对；删除传播放行消解）
  // FN4 同步目录重叠校验（纯函数直检）
  // FN5 凭据混淆（AES-256-GCM）+ 用户可见输出无密码泄漏扫描 + 调度器解密链路
  // ============================================================

  await section('FN0：NFC 规范化一致性（NFD 服务器名）', async () => {
    await freshStore('fn0')
    const L = await tmpLocal('fn0')
    const nfdName = 'cafe\u0301.txt' // é 分解形态（NFD）：macOS 旧工具 / 部分 Linux 服务器产物
    const nfcName = 'caf\u00e9.txt' // é 预组合形态（NFC）：引擎内部 key
    const d = { id: 'fn0', localPath: L, remotePath: '/fn0', mode: 'two-way' }
    await fsp.mkdir(path.join(ROOT, 'fn0'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'fn0', nfdName), 'remote-nfd-content')
    const s1 = await services.sync.syncDirectory(cfg, d, SP, {})
    const names = await fsp.readdir(L)
    check('FN0 NFD 远端名正常下载', s1.downloaded === 1, JSON.stringify(s1))
    check('FN0 本地按 origName 落地服务器原名（NFD 字节）', names.length === 1 && names[0] === nfdName, JSON.stringify(names))
    const beNfc = await services.sync._internals.baselineEntry(d, nfcName)
    const beNfd = await services.sync._internals.baselineEntry(d, nfdName)
    check('FN0 基线 key 归一 NFC（NFD 查询命中同一条目）', beNfc != null && beNfc.origName === nfdName && JSON.stringify(beNfd) === JSON.stringify(beNfc), JSON.stringify(beNfc))
    const s2 = await services.sync.syncDirectory(cfg, d, SP, {})
    check('FN0 第二轮 no-op（两侧 NFD/NFC 名折叠为同一 key）', isNoop(s2), JSON.stringify(s2))
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'fn0'), { recursive: true, force: true }).catch(() => {})
  })

  await section('FN1：内置垃圾排除与用户排除规则', async () => {
    await freshStore('fn1')
    const L = await tmpLocal('fn1')
    const d = { id: 'fn1', localPath: L, remotePath: '/fn1', mode: 'two-way' }
    for (const n of ['.DS_Store', '._sidecar', '~$owner.docx', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini']) await fsp.writeFile(path.join(L, n), 'junk')
    await fsp.writeFile(path.join(L, '.hidden-keep.txt'), 'hidden-but-not-junk')
    await fsp.writeFile(path.join(L, 'keep-me.txt'), 'ok')
    await fsp.mkdir(path.join(L, 'sub'), { recursive: true })
    await fsp.writeFile(path.join(L, 'sub', 'skip.log'), 'user-excluded')
    await fsp.writeFile(path.join(L, 'sub', 'keep2.txt'), 'ok2')
    // ignoreHidden=false：隐藏文件应同步（.hidden-keep.txt），但垃圾仍须排除（两规则独立）
    const prefs = { ...SP, ignoreHidden: false, excludePatterns: ['*.log'] }
    const s1 = await services.sync.syncDirectory(cfg, d, prefs, {})
    check(
      'FN1 内置垃圾不上传（ignoreHidden=false 亦然）',
      s1.uploaded === 3 && ['.DS_Store', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini'].every((n) => !fs.existsSync(path.join(ROOT, 'fn1', n))),
      JSON.stringify(s1)
    )
    check('FN1 隐藏但非垃圾的文件正常同步（规则相互独立）', fs.existsSync(path.join(ROOT, 'fn1', '.hidden-keep.txt')), '')
    check('FN1 用户规则按文件名排除 *.log', !fs.existsSync(path.join(ROOT, 'fn1', 'sub', 'skip.log')) && fs.existsSync(path.join(ROOT, 'fn1', 'sub', 'keep2.txt')), '')
    // 远端侧：远端盘上的垃圾不下载（先清掉本地同名垃圾，断言才不混淆）
    for (const n of ['.DS_Store', '._sidecar', '~$owner.docx', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini']) await fsp.rm(path.join(L, n), { force: true })
    await fsp.writeFile(path.join(ROOT, 'fn1', '.DS_Store'), 'junk-remote')
    await fsp.writeFile(path.join(ROOT, 'fn1', '._rjunk'), 'junk-remote')
    const s2 = await services.sync.syncDirectory(cfg, d, prefs, {})
    check('FN1 远端垃圾不下载', s2.downloaded === 0 && !fs.existsSync(path.join(L, '.DS_Store')) && !fs.existsSync(path.join(L, '._rjunk')), JSON.stringify(s2))
    // 含 '/' 的规则按完整相对路径匹配（* 不跨目录段）；同批非命中文件照常同步
    await fsp.mkdir(path.join(L, 'sub2'), { recursive: true })
    await fsp.writeFile(path.join(L, 'sub2', 'a.txt'), 'x')
    await fsp.writeFile(path.join(L, 'plain.txt'), 'y')
    const prefs2 = { ...SP, excludePatterns: ['*.log', 'sub2/*'] }
    const s3 = await services.sync.syncDirectory(cfg, d, prefs2, {})
    check('FN1 含 / 规则按完整路径排除（* 不跨段）', s3.uploaded === 1 && !fs.existsSync(path.join(ROOT, 'fn1', 'sub2')) && fs.existsSync(path.join(ROOT, 'fn1', 'plain.txt')) && !fs.existsSync(path.join(ROOT, 'fn1', 'sub', 'skip.log')), JSON.stringify(s3))
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'fn1'), { recursive: true, force: true }).catch(() => {})
  })

  await section('FN2：Windows 文件名预检（BAD_FILENAME）', async () => {
    await freshStore('fn2')
    const L = await tmpLocal('fn2')
    const d = { id: 'fn2', localPath: L, remotePath: '/fn2', mode: 'two-way' }
    const badNames = ['a<b.txt', 'colon:name.txt', 'quote"s.txt', 'CON.txt', 'NUL.bin', 'pipe|x.txt', 'trail. ', 'tail ', `L${'x'.repeat(249)}.txt`]
    const goodNames = ['café.txt', 'a b.txt', 'ok.txt']
    for (const n of badNames) await fsp.writeFile(path.join(L, n), 'bad')
    for (const n of goodNames) await fsp.writeFile(path.join(L, n), 'good')
    let s1 = null
    let e1 = null
    try {
      s1 = await services.sync.syncDirectory(cfg, d, SP, {})
    } catch (e) {
      e1 = e
      s1 = e.summary
    }
    check('FN2 非法名上传全部拦截（轮次错误收场，合法名照常上传）', !!e1 && s1.uploaded === goodNames.length && s1.errors.length >= badNames.length, JSON.stringify({ uploaded: s1.uploaded, errs: s1.errors.length }))
    check('FN2 错误文案含明确原因（Windows 归因）', s1.errors.some((m) => /Windows/.test(m)) && s1.errors.some((m) => m.includes('CON.txt')), s1.errors[0])
    check(
      'FN2 非法名零落盘远端（预检先于任何请求）',
      badNames.every((n) => !fs.existsSync(path.join(ROOT, 'fn2', n))) && goodNames.every((n) => fs.existsSync(path.join(ROOT, 'fn2', n))),
      ''
    )
    const fails = await services.sync._internals.getFailures(d)
    check(
      'FN2 记入失败退避表（permanent，逐 rel）',
      Object.keys(fails).length === badNames.length && Object.values(fails).every((f) => f.code === 'BAD_FILENAME'),
      JSON.stringify(Object.keys(fails))
    )
    // 第二轮：退避期内规划层跳过 → 轮次成功（不再报错，仅提示）
    const s2 = await services.sync.syncDirectory(cfg, d, SP, {})
    check('FN2 退避期内跳过（轮次成功 + 汇总提示）', s2.uploaded === 0 && s2.errors.length === 0 && s2.warnings.some((w) => /持续失败/.test(w)), JSON.stringify({ up: s2.uploaded, errs: s2.errors.length }))
    // 重命名恢复：新 rel 无失败记录 → 自动恢复上传
    await fsp.rename(path.join(L, 'a<b.txt'), path.join(L, 'fixed.txt'))
    const s3 = await services.sync.syncDirectory(cfg, d, SP, {})
    check('FN2 重命名后自动恢复同步', s3.uploaded === 1 && fs.existsSync(path.join(ROOT, 'fn2', 'fixed.txt')), JSON.stringify(s3))
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'fn2'), { recursive: true, force: true }).catch(() => {})
  })

  await section('FN3：大小写冲突检测与消解', async () => {
    // —— 跨侧：本地 Case.txt ↔ 远端 case.txt（上传会覆盖远端，必须拦截）——
    await freshStore('fn3')
    const L = await tmpLocal('fn3')
    const d = { id: 'fn3', localPath: L, remotePath: '/fn3', mode: 'two-way' }
    await fsp.writeFile(path.join(L, 'Case.txt'), 'local-content')
    await fsp.mkdir(path.join(ROOT, 'fn3'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'fn3', 'case.txt'), 'remote-content')
    let s1 = null
    let e1 = null
    try {
      s1 = await services.sync.syncDirectory(cfg, d, SP, {})
    } catch (e) {
      e1 = e
      s1 = e.summary
    }
    check(
      'FN3 跨侧大小写冲突：零传输 + 明确报错（不静默覆盖）',
      !!e1 && s1.uploaded === 0 && s1.downloaded === 0 && s1.errors.some((m) => /大小写冲突/.test(m) && m.includes('Case.txt') && m.includes('case.txt')),
      JSON.stringify(s1 && s1.errors)
    )
    check(
      'FN3 两侧内容原样保留',
      (await fsp.readFile(path.join(L, 'Case.txt'), 'utf-8')) === 'local-content' && (await fsp.readFile(path.join(ROOT, 'fn3', 'case.txt'), 'utf-8')) === 'remote-content',
      ''
    )
    // 消解①：删除本地一侧 → 冲突解除；远端文件按无基线语义下载回来（单一大小写收敛）
    await fsp.rm(path.join(L, 'Case.txt'))
    const s2 = await services.sync.syncDirectory(cfg, d, SP, {})
    check('FN3 删除本地一侧后收敛（远端版本下载）', s2.downloaded === 1 && fs.existsSync(path.join(L, 'case.txt')), JSON.stringify(s2))
    check('FN3 消解后恢复 no-op', isNoop(await services.sync.syncDirectory(cfg, d, SP, {})), '')
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'fn3'), { recursive: true, force: true }).catch(() => {})

    // —— 远端同名对（大小写敏感服务器形态，casepair 虚拟孪生模拟）——
    await freshStore('fn3b')
    const L2 = await tmpLocal('fn3b')
    const d2 = { id: 'fn3b', localPath: L2, remotePath: '/fn3b', mode: 'two-way' }
    await fsp.mkdir(path.join(ROOT, 'fn3b'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'fn3b', 'pair.txt'), 'pair-lower')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-casepair'), 'pair.txt')
    try {
      let s4 = null
      let e4 = null
      try {
        s4 = await services.sync.syncDirectory(cfg, d2, SP, {})
      } catch (e) {
        e4 = e
        s4 = e.summary
      }
      check(
        'FN3 远端同名对：两个都不下载 + 报错',
        !!e4 && s4.downloaded === 0 && s4.errors.some((m) => /大小写冲突/.test(m) && m.includes('Pair.txt') && m.includes('pair.txt')),
        JSON.stringify(s4 && s4.errors)
      )
      check('FN3 本地未落任何同名文件（下载即互相覆盖）', !fs.existsSync(path.join(L2, 'pair.txt')) && !fs.existsSync(path.join(L2, 'Pair.txt')), '')
      // 建基线（关孪生）→ 复现冲突（开孪生）→ 删除本地消解：删除传播在冲突挂起下放行。
      // anchor：删除 pair.txt 后本地根仍非空，避免「空目录 + 非空基线」的根健康保护中止
      await fsp.rm(path.join(ROOT, '.wdsync-test-casepair'), { force: true })
      const s5 = await services.sync.syncDirectory(cfg, d2, SP, {})
      check('FN3 基线建立（孪生关闭时正常下载）', s5.downloaded === 1 && fs.existsSync(path.join(L2, 'pair.txt')), JSON.stringify(s5))
      await fsp.writeFile(path.join(L2, 'anchor.txt'), 'anchor')
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-casepair'), 'pair.txt')
      let s6 = null
      try {
        s6 = await services.sync.syncDirectory(cfg, d2, SP, {})
      } catch (e) {
        s6 = e.summary
      }
      check('FN3 冲突复现：非冲突文件照常同步，冲突文件零传输', s6.uploaded === 1 && s6.downloaded === 0 && s6.errors.some((m) => /大小写冲突/.test(m)), JSON.stringify(s6 && s6.errors))
      // 删除本地 pair.txt → delete-remote 放行（caseSkip 只挡传输，不挡删除传播）。
      // 本轮孪生仍在 → 冲突错误依旧存在（轮次 throw），断言基于 summary
      await fsp.rm(path.join(L2, 'pair.txt'))
      let s7 = null
      try {
        s7 = await services.sync.syncDirectory(cfg, d2, SP, {})
      } catch (e) {
        s7 = e.summary
      }
      check('FN3 删除传播在冲突挂起下放行（消解手段）', s7.deleted === 1 && !fs.existsSync(path.join(ROOT, 'fn3b', 'pair.txt')) && fs.existsSync(path.join(L2, 'anchor.txt')), JSON.stringify(s7))
      check('FN3 孪生随真实文件消失，下轮干净', isNoop(await services.sync.syncDirectory(cfg, d2, SP, {})), '')
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-casepair'), { force: true }).catch(() => {})
      await fsp.rm(L2, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'fn3b'), { recursive: true, force: true }).catch(() => {})
    }
  })

  await section('FN4：同步目录重叠校验（纯函数直检）', async () => {
    const o = services.sync._internals.checkDirOverlap
    const A = path.join(path.sep, 'base', 'docs')
    const B = path.join(path.sep, 'base', 'docs', 'sub')
    const C = path.join(path.sep, 'base', 'other')
    const existing = [{ id: 'e1', name: '文档', localPath: A, remotePath: '/docs' }]
    check('FN4 本地嵌套被拒', o({ localPath: B, remotePath: '/x' }, existing)?.side === 'local', '')
    check('FN4 本地反向嵌套被拒（新目录更浅）', o({ localPath: A, remotePath: '/x' }, [{ id: 'e2', localPath: B, remotePath: '/y' }])?.side === 'local', '')
    check('FN4 本地完全相同被拒', o({ localPath: A, remotePath: '/x' }, existing)?.side === 'local', '')
    check('FN4 远端嵌套被拒', o({ localPath: C, remotePath: '/docs/sub' }, existing)?.side === 'remote', '')
    check('FN4 远端完全相同被拒', o({ localPath: C, remotePath: '/docs/' }, existing)?.side === 'remote', '')
    check('FN4 两侧均不重叠放行', o({ localPath: C, remotePath: '/other' }, existing) == null, '')
    check('FN4 编辑自身豁免', o({ localPath: A, remotePath: '/docs' }, existing, 'e1') == null, '')
    check('FN4 前缀相似的兄弟目录放行（段边界）', o({ localPath: A + '2', remotePath: '/other2' }, existing) == null && o({ localPath: C, remotePath: '/docs2' }, existing) == null, '')
    if (process.platform === 'win32' || process.platform === 'darwin') {
      check('FN4 大小写折叠（win/darwin 默认卷大小写不敏感）', o({ localPath: A.toUpperCase(), remotePath: '/x' }, existing)?.side === 'local', A.toUpperCase())
    } else {
      check('FN4 linux 大小写敏感：仅大小写不同的路径不判重叠', o({ localPath: A.toUpperCase(), remotePath: '/x' }, existing) == null, '')
    }
  })

  await section('FN5：凭据混淆（AES-256-GCM）与输出泄漏扫描', async () => {
    // 直检：seal/open 往返、密文形态、随机 iv、非密文输入
    const PW = 'e2e-Secret-pw-77ff'
    const sealed = services.secure.sealSecret(PW)
    check('FN5 seal→open 往返', services.secure.openSecret(sealed) === PW, sealed.slice(0, 24))
    check('FN5 密文不含明文且为 v1 格式', sealed.startsWith('wdsync1:') && !sealed.includes(PW), '')
    check('FN5 二次 seal 产生不同密文（随机 iv）', services.secure.sealSecret(PW) !== sealed, '')
    check('FN5 非密文输入解密为空（不做明文兼容）', services.secure.openSecret(PW) === '' && services.secure.openSecret('') === '', '')
    const tampered = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    check('FN5 篡改密文解密失败（GCM 完整性）', services.secure.openSecret(tampered) === '', '')

    // 泄漏扫描：带错误与提示的完整轮次里，密码与 Authorization 值不得出现在任何
    // 用户可见输出（summary 序列化含 errors/warnings；失败退避表为落盘诊断）
    await freshStore('fn5')
    const L = await tmpLocal('fn5')
    const d = { id: 'fn5', localPath: L, remotePath: '/fn5', mode: 'two-way' }
    await fsp.writeFile(path.join(L, 'ok.txt'), 'ok')
    await fsp.writeFile(path.join(L, 'bad.toolarge.txt'), 'will-fail-413')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-fail413'), 'x')
    const cfgP = { ...cfg, password: PW }
    let summary = null
    let firstErr = ''
    try {
      summary = await services.sync.syncDirectory(cfgP, d, SP, {})
    } catch (e) {
      summary = e.summary
      firstErr = e.message
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-fail413'), { force: true }).catch(() => {})
    }
    const authB64 = Buffer.from(`u:${PW}`).toString('base64')
    const blob = JSON.stringify(summary) + '|' + firstErr
    check('FN5 轮次输出不含密码与认证头值', !blob.includes(PW) && !blob.includes(authB64), blob.slice(0, 80))
    const failDump = JSON.stringify(await services.sync._internals.getFailures(d))
    check('FN5 失败退避表不含密码', !failDump.includes(PW), '')
    check('FN5 泄漏扫描轮确有错误输出（扫描本身有效）', summary && summary.errors.length > 0 && summary.uploaded === 1, JSON.stringify({ up: summary && summary.uploaded, errs: summary && summary.errors.length }))
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'fn5'), { recursive: true, force: true }).catch(() => {})

    // 调度器链路：seal 后的密码经 loadConfig 解密送达网络层（AUTH 头值 = u:sched-pw）
    const prevZt = global.window.ztools
    const FN_DB = {}
    global.window.ztools = {
      ...(prevZt || {}),
      dbStorage: { getItem: (k) => (k in FN_DB ? FN_DB[k] : null), setItem: (k, v) => { FN_DB[k] = v } },
    }
    const L2 = await tmpLocal('fn5d')
    await fsp.writeFile(path.join(L2, 'auth.txt'), 'auth-probe')
    FN_DB['webdav-sync:data'] = {
      server: { serverUrl: cfg.serverUrl, username: 'u', password: services.secure.sealSecret('sched-pw') },
      dirs: [{ id: 'fn5d', localPath: L2, remotePath: '/fn5d', mode: 'two-way' }],
      prefs: { autoSync: false, intervalMin: 15, syncOnStartup: false },
    }
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-captheaders'), 'x')
    const sched = createTestSched()
    try {
      await sched.init()
      await waitReal(() => sched.getSnapshot().leader.isLeader === true, 6000)
      const res = await sched.syncNow('fn5d')
      const capLog = fs.readFileSync(path.join(ROOT, '.wdsync-test-captheaders.log'), 'utf-8')
      const expectAuth = `Basic ${Buffer.from('u:sched-pw').toString('base64')}`
      check('FN5 调度器解密链路：明文密码正确送达网络层', res.ok === true && capLog.includes(`AUTH=${expectAuth}`), `${res.ok} ${capLog.split('\n')[0] || ''}`)
    } finally {
      sched.cleanup()
      await fsp.rm(path.join(ROOT, '.wdsync-test-captheaders'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, '.wdsync-test-captheaders.log'), { force: true }).catch(() => {})
      global.window.ztools = prevZt
      await fsp.rm(L2, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'fn5d'), { recursive: true, force: true }).catch(() => {})
    }
  })

} catch (e) {
  check('unexpected error', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e))
} finally {
  // 先销毁引擎自建的 keep-alive 连接池（6.10）：残留 socket 会在 process.exit 时
  // 触发 libuv 的 UV_HANDLE_CLOSING 断言；stopAllWatch 等其余清理一并执行
  try {
    if (global.window && global.window.services && typeof global.window.services.cleanup === 'function') {
      global.window.services.cleanup()
    }
  } catch (_) {
    /* 忽略 */
  }
  // 各档位标记兜底清理（正常路径均已在其用例的 finally 中删除）
  const allFlags = [
    '.wdsync-test-noetag',
    '.wdsync-test-redirect',
    '.wdsync-test-ratelimit',
    '.wdsync-test-xmlstyle',
    '.wdsync-test-profile',
    '.wdsync-test-midair',
    '.wdsync-test-badxml',
    '.wdsync-test-bigxml',
    '.wdsync-test-captheaders',
    '.wdsync-test-captheaders.log',
    '.wdsync-test-err503',
    '.wdsync-test-ro-subpaths',
    '.wdsync-test-mkcolfail',
    '.wdsync-test-fail413',
    '.wdsync-test-fail423',
    '.wdsync-test-fail423x',
    '.wdsync-test-reqlog',
    '.wdsync-test-reqlog.log',
    '.wdsync-test-vanish',
    '.wdsync-test-locksteal',
    '.wdsync-test-delefail',
    '.wdsync-test-dedupfail',
    '.wdsync-test-throttle',
    '.wdsync-test-casepair',
    // etag 子树跳过与 depth-infinity 的探测标记（正常路径由
    // B3 / ES / DP 各节自己的 finally 清理，此处兜底防异常路径泄漏给后续节）
    '.wdsync-test-depthlog',
    '.wdsync-test-depthlog.log',
    '.wdsync-test-noinfinity',
    '.wdsync-test-shallowinf',
    '.wdsync-test-etagprop',
  ]
  for (const flag of allFlags) {
    await fsp.rm(path.join(ROOT, flag), { force: true }).catch(() => {})
  }
  // 先关闭管道再 kill：Windows 上带着未完成的子进程 stdio 读句柄直接退出
  // 会触发 libuv 的 UV_HANDLE_CLOSING 断言（退出码 127）
  try {
    server.stdout.destroy()
    server.stderr.destroy()
  } catch (_) {
    /* 忽略 */
  }
  server.kill()
  // 等 dav-server 真正退出（带 2s 兜底超时）再结束：SIGTERM 的送达与端口释放是
  // 异步的，紧跟其后的 process.exit 会把「子进程临终仍持有 5360」留给下一次
  // 运行 —— 背靠背跑 e2e / bench 时下一次启动直接 EADDRINUSE
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 2000)
    server.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
  })
  await fsp.rm(LOCAL, { recursive: true, force: true }).catch(() => {})
  if (SAFE_LOCAL) await fsp.rm(SAFE_LOCAL, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(path.join(ROOT, '.wdsync-test-noetag'), { force: true }).catch(() => {})
}

const failed = results.filter((r) => !r.ok)
console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`)
printSectionReport()
// 引擎使用 Node 默认全局 agent（Node 19+ 默认 keep-alive），退出前销毁存活 socket，
// 避免 process.exit 时触发 libuv 的 UV_HANDLE_CLOSING 断言（退出码 127）
http.globalAgent.destroy()
https.globalAgent.destroy()
process.exit(failed.length ? 1 : 0)
