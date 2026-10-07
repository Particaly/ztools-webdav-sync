/**
 * e2e 共享测试基建（vitest 迁移版，自 test/sync-e2e.mjs 抽出；旧文件头的历史用例
 * 改写脉络见旧文件注释，迁移对拍通过后旧文件删除）。
 *
 * - section / slowSection 为 vitest 适配器：节注册为 test（fast 节带 'fast' tag、
 *   慢组带 'slow' tag）；check() 软失败登记，节尾一次性抛出全部失败用例清单 ——
 *   保持旧脚本「节内所有用例都执行、失败全列出」的语义。
 * - setupShard({ shard, port })：spawn 独立 dav-server（test/.dav-root-<shard>）、
 *   建独立 LOCAL / STORAGE_* / TRASH_DIR（pid 后缀防同毫秒碰撞）、加载 preload
 *   （WDSYNC_E2E_PRELOAD=built 切 dist 产物），返回旧主 try 作用域的全部共享标识符。
 * - teardownShard：对应旧 finally（引擎连接池销毁 → 标记兜底清理 → kill server 并
 *   等端口释放 → 删临时目录）；退出码由 vitest 接管。
 * - 对拍通道：WDSYNC_E2E_JSONL=<路径> 时逐用例追加 JSONL（节名/用例名/结果），
 *   供新旧运行 diff 比对。
 * - 工具库导出（模块顶层零副作用，unit 文件也可安全 import，不影响分片全局行为）：
 *   makeTrashStub / mountFakeDbStorage / makeCheck / spawnDav / killDav / UNIT_HERE，
 *   详见各导出处注释。
 * - setupShard 刻意保持在分片文件顶层执行、不迁移进 beforeAll：dav-server 端口已
 *   全部 0 化（内核随机分配，跨运行 / 并行 CI 不再 EADDRINUSE），顶层互斥已消解，
 *   惰性初始化的剩余收益只是省资源，不值得动 8 个分片的既有结构。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'vitest'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 轮次全零判定（原 M2 节内定义，提升到顶层供各节共享） */
export const isNoop = (s) => s.uploaded === 0 && s.downloaded === 0 && s.deleted === 0 && s.conflicts === 0
/** 各节共用的同步偏好（原 SAFE 节内定义，提升到顶层） */
export const SP = { ignoreHidden: true, concurrency: 4, conflictStrategy: 'ask' }
/** unit 测试文件所在目录（test/unit —— 替代各 unit 文件自建的 HERE 常量） */
export const UNIT_HERE = path.join(HERE, 'unit')

let curSection = null
export function check(name, cond, detail = '') {
  if (curSection) {
    curSection.checks++
    if (!cond) curSection.failed.push(name)
  }
  if (process.env.WDSYNC_E2E_JSONL) {
    try {
      fs.appendFileSync(process.env.WDSYNC_E2E_JSONL, JSON.stringify({ section: curSection ? curSection.desc : null, name, ok: !!cond }) + '\n')
    } catch (_) {
      /* 对拍输出失败不影响测试本身 */
    }
  }
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

async function runSection(desc, fn) {
  const rec = { desc, checks: 0, failed: [] }
  const prev = curSection
  curSection = rec
  try {
    await fn()
  } finally {
    curSection = prev
  }
  if (rec.failed.length) {
    throw new Error(`「${desc}」${rec.failed.length}/${rec.checks} 个用例失败：\n  ❌ ${rec.failed.join('\n  ❌ ')}`)
  }
}

/** 节包装器：注册为 vitest test（fast tag；节内 check 全跑完、失败末尾一次抛出） */
export function section(desc, fn) {
  return test(desc, { tags: ['fast'] }, () => runSection(desc, fn))
}

/** 慢组显式登记：reason 必填（一句话写明该节为何慢 / 为何可被日常回归跳过） */
export function slowSection(desc, reason, fn) {
  return test(desc, { tags: ['slow'] }, () => runSection(desc, fn))
}

/**
 * unit 文件专用的 check 工厂（消除 9 份 results/check 自建副本；与上面分片侧
 * check/section 软失败机制同族但独立 —— unit 无节概念，全文件一张登记表）。
 * @param jsonlSection 对拍节名（如 'store-unit'）；给出时启用 WDSYNC_E2E_JSONL
 *   逐用例追加（仅迁移对拍期使用，与既有 3 份带通道副本的行为一致）；缺省不写
 * @returns {{ check, results, assertAtEnd }}
 *   - check(name, cond, detail)：软失败登记（results 只存 {name, ok}，保持各文件
 *     既有失败清单形态）+ 标准日志行
 *   - results：登记数组本体（个别文件用例内自检 results.every(r => r.ok)）
 *   - assertAtEnd({ passLine, fail })：末尾汇总 —— passLine 为可选的
 *     `(passed, total) => string`（存在即先打印）；有失败时抛 fail(failed, total)
 *     返回的消息（string 或 Error，各文件措辞自定、输出与旧脚本字节一致）
 */
export function makeCheck(jsonlSection = null) {
  const results = []
  const check = (name, cond, detail = '') => {
    results.push({ name, ok: !!cond })
    if (jsonlSection && process.env.WDSYNC_E2E_JSONL) {
      try {
        fs.appendFileSync(process.env.WDSYNC_E2E_JSONL, JSON.stringify({ section: jsonlSection, name, ok: !!cond }) + '\n')
      } catch (_) {
        /* 对拍输出失败不影响测试本身 */
      }
    }
    console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  }
  const assertAtEnd = ({ passLine = null, fail } = {}) => {
    const failed = results.filter((r) => !r.ok)
    if (passLine) console.log(passLine(results.length - failed.length, results.length))
    if (failed.length) {
      const msg = fail(failed, results.length)
      throw msg instanceof Error ? msg : new Error(msg)
    }
  }
  return { check, results, assertAtEnd }
}

/** 本测试文件内 makeTrashStub 创建过的回收站目录（teardownShard 统一清理用；forks 池下每文件独立） */
const trashDirs = []
/**
 * 本进程 setupShard 产生的全部 uniq 临时目录（LOCAL / STORAGE_* / freshStore /
 * tmpLocal 登记制追加）：模块级登记的原因 —— 部分分片只把 { ROOT, LOCAL, server }
 * 传给 teardownShard，靠 ctx 字段会漏清；登记制对任意句柄形态都成立。
 * 前提（vitest.config 注释所载）：forks 池下每测试文件独占一个子进程，单进程
 * 只有一次 setupShard。
 */
const shardTmpDirs = []

/**
 * 宿主回收站桩工厂（原 head/lock/misc/sched/tiers 五分片逐字复制、net/tree/rename
 * 三处简化变体的统一替代）：shellTrashItem 把传入路径 rename 进独立 TRASH_DIR
 *（不真删，供断言「进了回收站」），并支持失败注入与「宿主未提供端口」模拟。
 * 返回 { TRASH_DIR, install, trashLog, failNext, missing }：
 * - install()：按当前控制变量（重）装 global.window.ztools；missing=true 时卸载
 *   ztools（模拟宿主无回收站端口）
 * - trashLog：已回收路径数组（引用本体，可原地 length=0 清零复用）
 * - failNext：数字存取器 —— 接下来 N 次调用抛 EACCES 注入失败（trash.failNext = 1）
 * - missing：布尔存取器 —— 置 true 后下一次 install() 装出「无 ztools」形态
 */
export function makeTrashStub() {
  const TRASH_DIR = path.join(os.tmpdir(), `wdsync-e2e-trash-${Date.now()}-${process.pid}`)
  fs.mkdirSync(TRASH_DIR, { recursive: true })
  trashDirs.push(TRASH_DIR)
  const trashLog = []
  let trashFailNext = 0
  let trashMissing = false
  const install = () => {
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
  return {
    TRASH_DIR,
    install,
    trashLog,
    get failNext() {
      return trashFailNext
    },
    set failNext(v) {
      trashFailNext = v
    },
    get missing() {
      return trashMissing
    },
    set missing(v) {
      trashMissing = v
    },
  }
}

/**
 * 挂假 dbStorage 到 global.window.ztools（原 shard-sched 的 mountScZtools /
 * shard-net 的 mountScDb / shard-tree 内联挂载的统一替代）：getItem/setItem 后备
 * 到传入的普通对象（生产为宿主 dbStorage 的同步 KV），并保留已装的
 * shellTrashItem（回收站桩叠加 —— deleteLocalOne 依赖，三处原实现均如此）。
 * @param db 承载数据的普通对象（各分片的 SC_DB）
 */
export function mountFakeDbStorage(db) {
  const prevTrash = global.window.ztools && global.window.ztools.shellTrashItem
  global.window.ztools = {
    dbStorage: { getItem: (k) => (k in db ? db[k] : null), setItem: (k, v) => { db[k] = v } },
    ...(prevTrash ? { shellTrashItem: prevTrash } : {}),
  }
}

/**
 * spawn 一个 dav-server 并等待就绪（stdout 出现含 'listening' 的行；15s 超时，
 * 超时即杀子进程防孤儿）；stderr 逐行转发到控制台。
 * @param opts.tag 根目录名后缀（root 缺省 = test/.dav-root-<tag>，spawn 前清空；stderr 前缀）
 * @param opts.root 根目录覆盖（如 shard-sched SC8 的 ROOT-sc8b 副根）
 * @param opts.port 监听端口，0 = 内核随机分配（默认 —— 跨运行 / 并行 CI 零冲突），
 *   实际端口从就绪行解析
 * @param opts.cert / opts.key TLS 证书与密钥路径（同时给出时以 https 提供服务）
 * @returns {Promise<{child: ChildProcess, root: string, port: number}>} port 为实际监听端口
 */
export async function spawnDav({ tag, port = 0, cert, key, root } = {}) {
  const davRoot = root || path.join(HERE, `.dav-root-${tag}`)
  await fsp.rm(davRoot, { recursive: true, force: true })
  const child = spawn(process.execPath, [path.join(HERE, 'dav-server.mjs'), String(port), davRoot, ...(cert && key ? [cert, key] : [])], {
    stdio: 'pipe',
    // 父进程死亡看门狗的注入 pid：worker 被强杀等未走 afterAll 的路径下，
    // dav-server 自行退出（防端口残留；见 dav-server.mjs 顶部说明）
    env: { ...process.env, WDSYNC_DAV_EXIT_WITH: String(process.pid) },
  })
  const portActual = await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch (_) {
        /* 已死：忽略 */
      }
      reject(new Error(`dav-server ${tag} start timeout`))
    }, 15000)
    child.stdout.on('data', (d) => {
      const line = String(d)
      if (line.includes('listening')) {
        const m = /127\.0\.0\.1:(\d+)/.exec(line)
        if (m) {
          clearTimeout(t)
          resolve(Number(m[1]))
        }
      }
    })
    child.stderr.on('data', (d) => console.error(`[dav-${tag}]`, String(d)))
  })
  return { child, root: davRoot, port: portActual }
}

/** 关停 spawnDav 返回的句柄：销毁 stdio 管道 → kill → 删其根目录 */
export async function killDav(h) {
  try {
    h.child.stdout.destroy()
    h.child.stderr.destroy()
  } catch (_) {
    /* 已死：忽略 */
  }
  h.child.kill()
  await fsp.rm(h.root, { recursive: true, force: true }).catch(() => {})
}

/**
 * 清扫历史运行残留的 uniq 临时目录（wdsync-e2e[-store|-trash]-<时间戳>-<pid>，
 * 即 setupShard 的 LOCAL/STORAGE_* 与 makeTrashStub 的 TRASH_DIR 形态）：
 * 只删「创建进程已死」的目录 —— 并行运行中的其他分片（pid 存活）、freshStore/
 * tmpLocal 之类无 pid 后缀的目录（由 teardownShard 登记制清理）与用户的其他
 * /tmp 内容绝不动。触发场景：整文件被 slow 过滤跳过时 afterAll 不执行，
 * setupShard 在下一轮启动时兜底（对应 dav-root 的既有先例）。
 */
async function sweepDeadRunTmpDirs() {
  const sweepRe = /^wdsync-e2e-(store-[a-z]+-|trash-)?\d+-\d+$/
  let entries = []
  try {
    entries = await fsp.readdir(os.tmpdir())
  } catch (_) {
    return
  }
  for (const name of entries) {
    if (!sweepRe.test(name)) continue
    const pid = Number(name.slice(name.lastIndexOf('-') + 1))
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    try {
      process.kill(pid, 0) // 探活：还活着（并行分片 / pid 已被复用）→ 保守跳过
      continue
    } catch (e) {
      if (!e || e.code !== 'ESRCH') continue // EPERM 等按存活处理（保守）
    }
    await fsp.rm(path.join(os.tmpdir(), name), { recursive: true, force: true }).catch(() => {})
  }
}
/**
 * 每分片一套独立环境：dav-server（端口 0 = 内核随机分配，就绪行解析回填 PORT）/
 * .dav-root-<shard> / 临时目录 / preload 实例。
 * 返回旧主 try 作用域的全部共享标识符（分片文件顶部同名解构，节体零改动搬运）；
 * LOCAL / STORAGE_* 与 freshStore / tmpLocal 产生的目录一并登记到模块级
 * shardTmpDirs（teardownShard 统一清理，不依赖分片传入的句柄形态）。
 */
export async function setupShard({ shard }) {
  const BUILT = process.env.WDSYNC_E2E_PRELOAD === 'built'
  const ROOT = path.join(HERE, `.dav-root-${shard}`)
  // 上一轮「整文件被 slow 过滤跳过 → afterAll 未执行」残留 uniq 临时目录的兜底清扫
  await sweepDeadRunTmpDirs()
  await fsp.rm(ROOT, { recursive: true, force: true })
  const { child: server, port: PORT } = await spawnDav({ tag: shard, port: 0 })
  process.on('exit', () => {
    try {
      server.kill()
    } catch (_) {
      /* 已死：忽略 */
    }
  })
  // 防泄漏：spawn 之后任何失败（加载异常等）立即杀掉子进程，否则收集期失败不触发
  // afterAll，孤儿 dav-server 会级联污染后续运行（端口已 0 化，此处防 fd / 进程残留）
  try {
  const preloadPath = BUILT
    ? path.join(HERE, '..', 'src-ztools', 'preload', 'dist', 'services.js')
    : path.join(HERE, '..', 'src-ztools', 'preload', 'services.mts')
  console.log(`[e2e:${shard}] preload under test: ${BUILT ? 'built bundle' : 'source'} (port ${PORT})`)
  global.window = {}
  await import(pathToFileURL(preloadPath).href)
  const services = global.window.services
  const cfg = { serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: 'p' }
  const storeModule = await import(pathToFileURL(path.join(HERE, '..', 'src-ztools', 'preload', 'store.mts')).href)
  const uniq = `${Date.now()}-${process.pid}`
  const LOCAL = path.join(os.tmpdir(), `wdsync-e2e-${uniq}`)
  const STORAGE_MAIN = path.join(os.tmpdir(), `wdsync-e2e-store-main-${uniq}`)
  const STORAGE_A = path.join(os.tmpdir(), `wdsync-e2e-store-a-${uniq}`)
  const STORAGE_B = path.join(os.tmpdir(), `wdsync-e2e-store-b-${uniq}`)
  const STORAGE_C = path.join(os.tmpdir(), `wdsync-e2e-store-c-${uniq}`)
  const STORAGE_D = path.join(os.tmpdir(), `wdsync-e2e-store-d-${uniq}`)
  // uniq 目录登记到模块级 shardTmpDirs（teardownShard 对任意句柄形态统一清理）
  shardTmpDirs.push(LOCAL, STORAGE_MAIN, STORAGE_A, STORAGE_B, STORAGE_C, STORAGE_D)
  const switchDevice = async (root) => {
    await services.storage.setRootForTest(root)
    if (BUILT) await storeModule.setRootForTest(root)
  }
  await switchDevice(STORAGE_MAIN)

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
  /** 新建独立存储根并切换（档位 / 能力缓存 / 基线互不串扰的前提）；目录登记入 shardTmpDirs 待收尾清理 */
  const freshStore = async (tag) => {
    const root = path.join(os.tmpdir(), `wdsync-e2e-store-${tag}-${Date.now()}`)
    await fsp.mkdir(root, { recursive: true })
    shardTmpDirs.push(root)
    await switchDevice(root)
    return root
  }
  /** 新建独立本地目录（tag 区分用途）；目录登记入 shardTmpDirs 待收尾清理 */
  const tmpLocal = async (tag) => {
    const lp = path.join(os.tmpdir(), `wdsync-e2e-local-${tag}-${Date.now()}`)
    await fsp.mkdir(lp, { recursive: true })
    shardTmpDirs.push(lp)
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
   * onProgress 是否观察到字节推进（引擎进度随传输字节流推进，传输中有字节落地即计）。
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
      prefs: { autoSync: false, intervalMin: 15, conflictStrategy: 'ask', ignoreHidden: true, concurrency: 4, ...prefs },
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

  const projDir = () => ({ id: 'd1', localPath: LOCAL, remotePath: '/proj', mode: 'two-way' })
  return {
    HERE, ROOT, PORT, LOCAL, server, services, cfg, storeModule, BUILT, preloadPath,
    STORAGE_MAIN, STORAGE_A, STORAGE_B, STORAGE_C, STORAGE_D, switchDevice,
    baselineDirOf, setProfile, setMidair, freshStore, tmpLocal, syncP, settleStable, sweepCrashResidue, projDir,
    REQLOG, readReqlog, countReq, lastReqLine,
    DEPTHLOG, readDepthlog, countDepth, clearDepthFlags,
    setThrottle, waitForReqLine, waitAbortLine, runCancelRound, readWalOps, findTempResidue,
    PUP, setNetcut, setPartialPut, puBuf,
    SC_DB, SC_KEY, setSCConfig, createTestSched, makeFakeClock, waitReal, pumpUntil, readLeaderLock, writeLeaderLock,
  }
  } catch (e) {
    try {
      server.stdout.destroy()
      server.stderr.destroy()
    } catch (_) {
      /* 忽略 */
    }
    try {
      server.kill('SIGKILL')
    } catch (_) {
      /* 忽略 */
    }
    throw e
  }
}

/** 对应旧 finally：引擎连接池销毁 + 标记兜底清理 + kill server 等端口释放 + 删临时目录 */
export async function teardownShard(ctx) {
  try {
    if (global.window && global.window.services && typeof global.window.services.cleanup === 'function') {
      global.window.services.cleanup()
    }
  } catch (_) {
    /* 忽略 */
  }
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
    // 改名同步（MOVE）标记（正常路径由 RN 节自己的 finally 清理，此处兜底防异常泄漏）
    '.wdsync-test-nomove',
    // etag 子树跳过与 depth-infinity 的探测标记（正常路径由
    // B3 / ES / DP 各节自己的 finally 清理，此处兜底防异常路径泄漏给后续节）
    '.wdsync-test-depthlog',
    '.wdsync-test-depthlog.log',
    '.wdsync-test-noinfinity',
    '.wdsync-test-shallowinf',
    '.wdsync-test-root404prop',
    '.wdsync-test-etagprop',
    // 选择性同步 / 预演 / 配额档（ST 分片用；正常路径由各节自己的 finally 清理，此处兜底）
    '.wdsync-test-quota',
    // Digest 认证档（NET 分片用；同上兜底）
    '.wdsync-test-digest',
  ]
  for (const flag of allFlags) {
    await fsp.rm(path.join(ctx.ROOT, flag), { force: true }).catch(() => {})
  }
  try {
    ctx.server.stdout.destroy()
    ctx.server.stderr.destroy()
  } catch (_) {
    /* 忽略 */
  }
  ctx.server.kill()
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 2000)
    ctx.server.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
  })
  await fsp.rm(ctx.LOCAL, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(path.join(ctx.ROOT, '.wdsync-test-noetag'), { force: true }).catch(() => {})
  // 本轮 uniq 的各级临时目录统一清理（模块级登记制：setupShard 的 LOCAL / 五个
  // 存储根 + freshStore/tmpLocal 产生的目录 + makeTrashStub 的回收站目录）——
  // 与分片传给 teardownShard 的句柄形态无关（多数分片只传 { ROOT, LOCAL, server }）
  for (const d of shardTmpDirs) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {})
  }
  for (const d of trashDirs) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {})
  }
  http.globalAgent.destroy()
  https.globalAgent.destroy()
}
