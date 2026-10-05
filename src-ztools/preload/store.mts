/* eslint-disable */
// WebDAV 同步插件 —— 本地状态存储层
//
// 职责：deviceId、每目录基线（baseline）、意图日志（WAL-lite）的持久化。
// 全部状态只存放于本机 pluginData（经宿主端口层取 ztools.getPath('pluginData')，
// 见 host.mts），绝不写入
// dbStorage 单文档、用户同步目录或远端。
//
// 磁盘布局（<storageRoot> 默认为 <pluginData>/sync-state）：
//   device.json                              设备 ID（首次生成，永不变）
//   baselines/<hash16>/meta.json             目录身份 + 元数据（lastDeepVerifyAt 等）
//   baselines/<hash16>/snapshot.json         基线快照（原子压缩产物）
//   baselines/<hash16>/log.jsonl             基线增量日志（append-only，每行带 CRC）
//   baselines/<hash16>/wal.jsonl             意图日志（同机制，轮末清空）
//   baselines/<hash16>/failures.json         持续失败退避表（整体原子写）
//   baselines/<hash16>/pending-conflicts.json 冲突挂起表 + 批量删除快照 + 删除范围决策（整体原子写）
//   baselines/<hash16>/decision-log.json      决策历史记录（整体原子写，环形上限）
//   baselines/<hash16>/sync-log.json          同步记录（每轮一条，整体原子写，环形上限）
//   baselines/<hash16>/scan-cache.json        etag 跳过扫描缓存（整体原子写）
//   servers/<hash16>/capabilities.json       服务器能力探测缓存（origin+username 粒度）
//   servers/<hash16>/noise.json              指纹噪声标记（origin+username 粒度、跨目录共享）
//   secretbox.key                            凭据混淆密钥（32 字节随机，0600，仅本机）
//
// baselines/<hash16> = sha256(schema 版本 + deviceId + 规范化 localPath + 规范化 remotePath) 前 16 hex，
// 即基线按「设备 × 本地目录 × 远端目录」隔离；
// servers/<hash16> = sha256(版本 + origin + username) 前 16 hex —— 能力与噪声是「同一台服务
// 器（同一账号）」的属性而非某个目录的属性，故与基线分目录、跨目录共享。
//
// 说明：能力缓存选择并入 store.js 而非独立模块 —— 复用 storageRoot / setRootForTest
// （测试多设备切根的隔离语义自动覆盖新文件）与 atomicWriteJson（崩溃安全写），
// 并随 closeAllStores 统一关闭，避免第三个模块重复实现存储根解析。
//
// 崩溃安全设计：
//   - 日志每行为 { v, n, c, o }，c 为负载 JSON 的 CRC32；半行 / CRC 失败 / 版本不识别
//     的行及「其后的全部行」被丢弃并记录 warning（append-only 日志损坏只会发生在尾部）。
//   - 压缩 = 写 snapshot.json.tmp → fsync → rename → 清空日志。rename 之前旧快照始终有效，
//     rename 之后日志重放对已包含的操作是幂等的（set/del/clear 后写覆盖先写），
//     因此「压缩中途崩溃」在任何断点都能恢复到一致状态。
//   - 快照损坏（存在但不可解析 / 版本不识别）视为「无基线」：entries 置空并置
//     loadedOk = false，由引擎进入无基线保护模式（整轮禁用删除传播）。
//   - fsync 崩溃安全点按批量策略布防，两级威胁模型分开对待：
//     · 进程崩溃（渲染进程被杀 / 崩溃）：追加写透过 OS 页缓存即可存活，无需逐条 fsync；
//     · 掉电级持久化：只在关键点 fsync（详见各函数注释）——
//       安全点 1：WAL intent 行写入后立即 fsync（意图必须先于远端操作落盘，否则
//                崩溃后无从采纳 / 重推导，这是 WAL 的根本保证）；
//       安全点 2：WAL done 行写入后立即 fsync（「操作已完成」的落盘证据，恢复期
//                据此直接采纳而无需重核对）；
//       安全点 3：基线日志（log.jsonl）追加不逐条 fsync（批量策略）——丢失该行时
//                WAL 的 done 行（已 fsync）配合下一轮 recoverIntents 的采纳语义可
//                安全收敛（无基线条目 + 两侧同内容 → adopt），轮末 flush 统一补齐；
//       安全点 4：轮末 flush() 对全部打开句柄 fsync（轮末崩溃安全点）；
//       安全点 5：atomicWriteJson / compact 的 tmp 文件句柄 fsync + rename 后目录
//                fsync（fsyncDirIfPossible，仅 POSIX。Windows 已知边界：fs.open(目录)
//                在 win32 上失败，目录项的掉电级持久化没有等价 API，只能跳过；
//                文件句柄 fsync 三平台可用，进程崩溃级持久化不受此边界影响）；
//       安全点 6：日志截断（_truncateFileNow）写空后 fsync —— 截断也要落盘，否则
//                掉电可能「复活」已压缩进快照的旧日志行（重放幂等可兜底，但磁盘
//                状态应与语义状态一致）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { getHostPorts } from './host.mts'
import type {
  BaselineEntry,
  DavCapabilities,
  DecisionLogEntry,
  DeleteBatch,
  DeleteScope,
  FailureRecord,
  LogOp,
  PendingListItem,
  PendingRecord,
  SyncLogEntry,
  WalIntent,
} from './types.mts'

const fsp = fs.promises

/** 存储结构版本号：升级时在此递增并在 _load 中接入迁移入口 */
const SCHEMA_V = 1
/** 基线日志行数超过该值时，轮末触发一次原子压缩 */
const COMPACT_LOG_LINES = 4096
/** meta.unstableHits 的最大记录条数（防膨胀；超出后停止累计，行为不变） */
const MAX_UNSTABLE_HITS = 1000
/**
 * 标记服务器 fingerprint-unstable 所需的「不同文件」数（默认 3）。
 * 按 distinct 文件计数而非同一文件多轮：编辑器自动保存 / 索引工具反复 touch
 * 单个文件不得触发误标；必须至少 N 个不同文件各自出现「仅指纹变化、内容相同」。
 */
const FINGERPRINT_NOISE_FILES = 3

// ---- 持续失败退避记录 ----
/** 失败退避表（failures.json）结构版本号 */
const FAILURES_V = 1
// ---- 挂起记录（冲突类 + 删除确认类）----
/** 挂起表（pending-conflicts.json）结构版本号 */
const PENDINGS_V = 1
// ---- 决策历史记录 ----
/** 决策历史（decision-log.json）结构版本号 */
const DECISION_LOG_V = 1
/** 决策历史环形上限：超出后丢弃最旧条目（纯展示性信息，防膨胀优先于完整性） */
const MAX_DECISION_LOG_ENTRIES = 200
// ---- 同步记录 ----
/** 同步记录（sync-log.json）结构版本号 */
const SYNC_LOG_V = 1
/** 同步记录环形上限（轮数）：超出后丢弃最旧轮次（纯展示性信息，防膨胀优先于完整性） */
const MAX_SYNC_LOG_ROUNDS = 200
// ---- etag 跳过扫描缓存----
/** 扫描缓存（scan-cache.json）结构版本号 */
const SCAN_CACHE_V = 1
/** 挂起条目上限：超出后丢弃新条目并记 warning（防膨胀；成功落地 / UI 清理后自然回收） */
const MAX_PENDING_ENTRIES = 500
/**
 * 合法选择值：冲突类挂起（缺省 kind）local / remote / both 与引擎冲突解决的
 * 三种动作一一对应；删除确认类挂起（kind='delete'）delete = 确认删除（下轮执行）、
 * keep = 保留两侧不删（持续抑制删除传播）。非法值一律按「未解决」处理。
 */
const PENDING_CHOICES = new Set(['local', 'remote', 'both', 'delete', 'keep', 'upload', 'remove-local'])
/** 失败记录条目上限：超出后丢弃新条目并记 warning（防膨胀；旧条目到期重试成功后自然清除） */
const MAX_FAILURE_ENTRIES = 1000
/** 单条失败消息的截断长度（字符） */
const FAILURE_MSG_MAX = 500
/** 指数退避基数：首次失败 15 分钟后重试，此后每多失败一次翻倍 */
const FAILURE_RETRY_BASE_MS = 15 * 60 * 1000
/** 退避上限：7 天（持续失败文件的最低重试频率，避免退避无限增长后永不再试） */
const FAILURE_RETRY_MAX_MS = 7 * 24 * 60 * 60 * 1000

// zlib.crc32 自 Node 20.15 起提供；旧运行环境回退到表驱动实现（结果一致）
const crc32Fallback = (() => {
  let table: Int32Array | null = null
  return function crc32(buf: Buffer): number {
    if (!table) {
      table = new Int32Array(256)
      for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        table[n] = c
      }
    }
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
})()
const crc32: (buf: Buffer) => number = typeof zlib.crc32 === 'function' ? zlib.crc32 : crc32Fallback

// ---------- 存储根与 deviceId ----------

/** 测试专用覆盖根（非空时优先于宿主 pluginData） */
let rootOverride: string | null = null
/** 已解析的存储根（懒解析缓存） */
let rootResolved: string | null = null
let deviceIdCache: string | null = null
/** 已打开的目录基线存储：baselineDirPath → DirStateStore（同进程内复用内存态） */
const openStores = new Map<string, DirStateStore>()

/**
 * 解析存储根目录。
 * 宿主内取 pluginData/sync-state —— 经宿主端口层取（见 host.mts：引擎
 * 对宿主的运行期依赖收敛为显式端口，无头 / 测试可注入自定义根；默认端口动态读
 * window.ztools，不缓存绑定）。端口返回 null（宿主未注入 / 接口异常 / 测试直载）
 * 时回退到系统临时目录 —— 回退目录跨进程不保证稳定，仅保证「可用且不写到用户目录」。
 */
function storageRoot(): string {
  if (rootOverride) return rootOverride
  if (rootResolved) return rootResolved
  const base = getHostPorts().storageRoot() || path.join(os.tmpdir(), 'webdav-sync-state-fallback')
  rootResolved = path.join(base, 'sync-state')
  return rootResolved
}

/**
 * 切换存储根（测试多设备模拟专用）：关闭全部已打开存储后重置缓存，
 * 使下一次访问从新根重新加载（含重新生成 / 读取 deviceId）。
 */
async function setRootForTest(dir: string | null): Promise<void> {
  await closeAllStores()
  rootOverride = dir || null
  rootResolved = null
  deviceIdCache = null
  // secretbox 密钥按存储根隔离：切根后必须按新根重新取（跨根解密必然失败，
  // 正是多设备密钥隔离语义的测试点）
  secretboxKeys.clear()
}

// ---------- fsync 崩溃安全基础设施 ----------

/**
 * 注入式验证钩子（仅测试使用，生产恒为 no-op，不改变任何生产行为）：
 * 每个实际执行的 fsync 点回调 onEvent({ kind, file })，事件类别全表：
 *   'wal'         WAL intent / done 行写入后的句柄 fsync（安全点 1 / 2）
 *   'flush'       轮末 flush() 对每个打开句柄的 fsync（安全点 4）
 *   'json-file'   atomicWriteJson / compact 的 tmp 文件句柄 fsync（安全点 5）
 *   'json-dir'    atomicWriteJson rename 后的目录 fsync（安全点 5，仅 POSIX）
 *   'compact-dir' compact rename 后的目录 fsync（安全点 5，仅 POSIX）
 *   'truncate'    _truncateFileNow 截断写空后的 fsync（安全点 6）
 * Windows 上目录类事件（json-dir / compact-dir）不会出现（目录 fsync 被跳过），
 * 这本身就是注入断言的组成部分；onEvent 抛错亦静默，绝不影响写入路径。
 */
const fsyncSpy: { onEvent: ((ev: { kind: string; file: string }) => void) | null } = { onEvent: null }

/** 上报一次 fsync 事件给注入钩子（未注入 / 回调抛错均静默） */
function noteFsync(kind: string, file: string): void {
  if (typeof fsyncSpy.onEvent === 'function') {
    try {
      fsyncSpy.onEvent({ kind, file })
    } catch (_) {
      /* 钩子异常不得影响写入路径 */
    }
  }
}

/**
 * 尽力而为的目录 fsync（安全点 5 的目录半边，仅 POSIX）。
 * Windows 已知边界：fs.open(目录) 在 win32 上会失败（EACCES/EISDIR 一类），
 * 目录项的掉电级持久化在 Windows 上没有等价 API，故直接 return 跳过；
 * 文件句柄的 fsync 三平台可用，不受此边界影响。任何异常静默吞（尽力而为）。
 * @param dirPath 要 fsync 的目录
 * @param spyKind 非空时在成功 fsync 后上报该类别事件（内部 / 测试观测用）；
 *                目录被平台跳过或 fsync 失败时不报 —— 事件只代表实际执行了的 fsync 点
 */
async function fsyncDirIfPossible(dirPath: string, spyKind?: string | null): Promise<void> {
  if (process.platform === 'win32') return
  let fh: fs.promises.FileHandle | null = null
  try {
    fh = await fsp.open(dirPath, 'r')
    await fh.sync()
    if (spyKind) noteFsync(spyKind, dirPath)
  } catch (_) {
    /* 目录不可打开 / fsync 不支持：静默跳过（尽力而为） */
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

/** 原子写 JSON：tmp → fsync → rename → 目录 fsync（安全点 5；调用方保证目录已存在或自行 mkdir） */
async function atomicWriteJson(file: string, obj: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const fh = await fsp.open(tmp, 'w')
  try {
    await fh.writeFile(JSON.stringify(obj), 'utf-8')
    await fh.sync()
    noteFsync('json-file', tmp)
  } finally {
    await fh.close()
  }
  await fsp.rename(tmp, file)
  // rename 只保证可见性顺序；目录项的掉电级持久化须 fsync 父目录（Windows 跳过，见 fsyncDirIfPossible）
  await fsyncDirIfPossible(path.dirname(file), 'json-dir')
}

/**
 * 读取（不存在则生成）本设备 ID。存于 <root>/device.json，永不主动变更；
 * 文件损坏时重新生成 —— 旧基线因 key 变化而自然失联，引擎按无基线保护模式收敛，
 * 不会误删（安全方向），但会触发一次 adopt 密集轮，属可接受的降级。
 */
async function getDeviceId(): Promise<string> {
  if (deviceIdCache) return deviceIdCache
  const file = path.join(storageRoot(), 'device.json')
  let id = ''
  try {
    const parsed: any = JSON.parse(await fsp.readFile(file, 'utf-8'))
    if (parsed && typeof parsed.deviceId === 'string' && parsed.deviceId) id = parsed.deviceId
  } catch (_) {
    /* 不存在 / 损坏：首次生成 */
  }
  if (!id) {
    id = crypto.randomUUID()
    await atomicWriteJson(file, { v: SCHEMA_V, deviceId: id })
  }
  deviceIdCache = id
  return id
}

// ---------- 凭据混淆（AES-256-GCM） ----------
//
// 目的：WebDAV 密码经 dbStorage（宿主 LMDB）落盘时不以明文出现 —— 防的是
// 「随手窥视」（翻数据库文件 / 共享诊断导出 / 截图一眼看到）。密钥就存在同一台
// 机器的 pluginData 下（secretbox.key），与密文同盘 —— 能读本机任意文件的人同样
// 能解开：这不是强加密，README 如实说明。不做密钥派生自用户口令一类方案
// （每次启动都要问一次密码，与「后台自动同步」的产品形态冲突）。
//
// 形态：sealSecret/openSecret 均为**同步**函数（dbStorage.setItem 是同步 IPC，
// 渲染层 persist 不能 await）。密钥懒加载进内存缓存；首次调用在当前存储根下
// 以独占创建（'wx'）生成 32 字节随机密钥，0600 权限（POSIX），竞态时读既有文件。
// 密文格式 `wdsync1:<b64url(iv12)>:<b64url(tag16)>:<b64url(ct)>`；每次加密随机
// iv，AAD 绑定版本串（防跨用途挪用）。解密失败（格式不符 / 密钥不符 / GCM 校验
// 失败 / 空串）一律返回 ''：调用方按「密码丢失」处理（界面显示空密码，用户
// 重输即可，绝不把密文当明文送去认证）。

/** secretbox 密文版本前缀（AAD 与密文格式共用） */
const SECRETBOX_V1 = 'wdsync1'
/** 内存中的密钥缓存：storageRoot → 32 字节 Buffer（切根后按新根重取） */
const secretboxKeys = new Map<string, Buffer>()

/** 读取（或首次生成）当前存储根的 secretbox 密钥；任何异常返回 null（seal/open 均按失败处理） */
function secretboxKey(): Buffer | null {
  const root = storageRoot()
  if (secretboxKeys.has(root)) return secretboxKeys.get(root) ?? null
  const file = path.join(root, 'secretbox.key')
  let key: Buffer | null = null
  try {
    key = fs.readFileSync(file)
  } catch (_) {
    /* 不存在 / 不可读：尝试生成 */
  }
  if (!key || key.length !== 32) {
    try {
      fs.mkdirSync(root, { recursive: true })
      const fresh = crypto.randomBytes(32)
      // 独占创建：并发首次调用（多窗口同时 persist）只有一个赢家，输家读到赢家文件
      const fh = fs.openSync(file, 'wx', 0o600)
      try {
        fs.writeSync(fh, fresh)
      } finally {
        fs.closeSync(fh)
      }
      key = fresh
    } catch (_) {
      try {
        key = fs.readFileSync(file)
      } catch (_) {
        key = null
      }
    }
  }
  if (key && key.length === 32) secretboxKeys.set(root, key)
  else key = null
  return key
}

/**
 * 加密一段明文（同步）。空串原样返回空串（「没有密码」没有可加密的东西）；
 * 密钥不可用（pluginData 不可写等）返回明文原文 —— 混淆是尽力而为，绝不能因它
 * 让密码丢失或阻断保存；该情形 README 已知边界如实说明。
 * @param {string} plain 明文
 * @returns {string} 密文（wdsync1:...）或原样返回的明文/空串
 */
function sealSecret(plain: string | null | undefined): string {
  const p = String(plain == null ? '' : plain)
  if (p === '') return ''
  const key = secretboxKey()
  if (!key) return p
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(SECRETBOX_V1, 'utf-8'))
  const ct = Buffer.concat([cipher.update(p, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [SECRETBOX_V1, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':')
}

/**
 * 解密 sealSecret 的产物（同步）。非密文格式 / 密钥不符 / 校验失败 / 空串一律
 * 返回 ''（按「密码丢失」处理，用户重输；绝不返回半可信内容）。
 * @param {string} sealed 密文
 * @returns {string} 明文；不可解时为空串
 */
function openSecret(sealed: string | null | undefined): string {
  const s = String(sealed == null ? '' : sealed)
  if (s === '') return ''
  const parts = s.split(':')
  if (parts.length !== 4 || parts[0] !== SECRETBOX_V1) return ''
  const key = secretboxKey()
  if (!key) return ''
  try {
    const iv = Buffer.from(parts[1], 'base64url')
    const tag = Buffer.from(parts[2], 'base64url')
    const ct = Buffer.from(parts[3], 'base64url')
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(SECRETBOX_V1, 'utf-8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8')
  } catch (_) {
    return ''
  }
}

// ---------- 键规范化 ----------

/** rel / 名称统一以 NFC 作为内部 key（macOS NFD 与其他平台互通的前提） */
function nfc(s: string): string {
  return String(s).normalize('NFC')
}

/** 本地路径键规范化：resolve + NFC；Windows 大小写不敏感，键侧统一小写 */
function normalizeLocalKey(p: string | null | undefined): string {
  let t = path.resolve(String(p || ''))
  if (process.platform === 'win32') t = t.toLowerCase()
  return nfc(t)
}

/** 远端路径键规范化：统一正斜杠、去尾斜杠、保证以 / 开头、NFC */
function normalizeRemoteKey(p: string | null | undefined): string {
  let t = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!t.startsWith('/')) t = '/' + t
  if (t === '') t = '/'
  return nfc(t)
}

/**
 * 通用键哈希（sha256 前 16 hex）：把任意 JSON 可序列化的部件数组压成 16 hex 文件名段。
 * 基线 / 服务器状态目录的键压缩同款算法；导出给 scheduler 复用
 *（目录互斥锁 locks/<h>.lock 的键 = hash16([...身份部件])），避免第三个模块重复实现。
 */
function hash16(parts: unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
}

/** 由「设备 × 本地目录 × 远端目录」计算基线存储目录（sha256 前 16 hex） */
function baselineDirPath(deviceId: string, localPath: string, remotePath: string): string {
  const key = JSON.stringify([SCHEMA_V, deviceId, normalizeLocalKey(localPath), normalizeRemoteKey(remotePath)])
  const h = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
  return path.join(storageRoot(), 'baselines', h)
}

// ---------- 行编解码（CRC 保护） ----------

/** 编码一行日志：{ v, n, c, o }，c = JSON.stringify(o) 的 CRC32（负载为任意 JSON 可序列化对象） */
function encodeLine(seq: number, op: object): string {
  const payload = JSON.stringify(op)
  const c = crc32(Buffer.from(payload, 'utf-8')) >>> 0
  return `${JSON.stringify({ v: SCHEMA_V, n: seq, c, o: op })}\n`
}

/**
 * 解码一行日志；返回负载对象，任何不一致（半行 / JSON 损坏 / 版本不识别 / CRC 不符）返回 null。
 * 注意：负载对象不得含纯数字键 —— JSON.parse 保留非数字键顺序，重新 stringify 才能与 CRC 一致。
 */
function decodeLine(line: string | null | undefined): any {
  if (!line) return null
  let obj: any
  try {
    obj = JSON.parse(line)
  } catch (_) {
    return null
  }
  if (!obj || obj.v !== SCHEMA_V || typeof obj.c !== 'number' || !obj.o || typeof obj.o !== 'object') return null
  const payload = JSON.stringify(obj.o)
  if ((crc32(Buffer.from(payload, 'utf-8')) >>> 0) !== (obj.c >>> 0)) return null
  return obj.o
}

/**
 * 重放一段日志文本：逐行解码并应用；遇到首个损坏行即停止并丢弃其后全部（尾部丢弃语义），
 * 记录 warning。返回成功应用的行数。
 */
function replayLogText(text: string, applyFn: (op: LogOp) => void, warnings: string[], label: string): number {
  if (!text) return 0
  const lines = text.split('\n')
  let applied = 0
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw) continue // 容忍末尾空行
    const op = decodeLine(raw)
    if (!op) {
      warnings.push(`${label}: 第 ${i + 1} 行损坏（半行/CRC/版本），该行及其后已丢弃`)
      break
    }
    applyFn(op)
    applied++
  }
  return applied
}

// ---------- DirStateStore：单目录基线 + WAL ----------

/**
 * 单个同步目录的基线存储。
 * 生命周期：openDirStore() 按 key 打开（进程内缓存复用）→ 引擎读写 → 轮末 flush /
 * compactIfNeeded / saveMeta / truncateWal → 进程退出或测试切根时 close。
 * 全部文件写操作经内部 promise 链串行化，多 worker 并发追加不会交错。
 */
class DirStateStore {
  /** 基线存储目录 */
  dirPath: string
  /** { deviceId, localPath, remotePath }（已规范化，写回 meta 备查） */
  keyInfo: { deviceId: string; localPath: string; remotePath: string }
  /** nfcRel → 基线条目 */
  entries: Map<string, BaselineEntry>
  /** 快照是否可信；false = 快照损坏，引擎须按无基线保护模式运行 */
  loadedOk: boolean
  warnings: string[]
  /** WAL 中未了结的意图：id → intent 记录 */
  pendingIntents: Map<string, WalIntent>
  /** 持续失败退避表：nfcRel → 记录 */
  failures: Map<string, FailureRecord>
  /** 失败退避表自上次落盘后是否有变更（引擎轮末据此决定是否 saveFailures） */
  failuresDirty: boolean
  /**
   * 冲突挂起表：nfcRel → 记录。choice ∈ 'local'|'remote'|'both'，为「用户已做出但尚未成功落地的
   * 冲突决策」；无 choice = 冲突尚未解决（供 UI 统一处理）。注意：本表只是决策辅助状态，
   * 完全不参与 WAL / 基线语义 —— 丢失或损坏的最坏后果是下一轮重新询问用户，不影响数据安全。
   */
  pendings: Map<string, PendingRecord>
  /** 冲突挂起表自上次落盘后是否有变更（引擎轮末据此决定是否 savePendings） */
  pendingsDirty: boolean
  /**
   * 批量删除快照（deleteBatch）：触发批量删除阈值拦截的轮对「全部未决策删除候选」
   * 的目录聚合快照 —— 逐文件挂起表有 500 条上限，超出部分没有逐文件记录，快照是
   * UI 树形展示与「全部 / 按目录」批量决策的完整事实源。与 pendings 同属决策辅助
   * 状态：丢失 / 损坏的最坏后果是 UI 树缺失（下一轮触发拦截时重建），不影响同步安全。
   */
  deleteBatch: DeleteBatch | null
  /**
   * 删除范围决策（deleteScopes）：用户在目录树节点（含空前缀 = 整目录）做出的
   * 批量选择，按前缀匹配消费（最具体者胜）。与 pendings 同生命周期语义：
   * 消费轮按选择执行 / 抑制，扫描完整且零匹配的轮由引擎剪枝。
   */
  deleteScopes: DeleteScope[]
  /**
   * 决策历史记录（decision-log.json，最新在尾）：用户对待处理挂起的每次选择 /
   * 忽略各占一条。纯展示性审计状态，不参与 WAL / 基线 / 挂起语义 —— 丢失或损坏
   * 的最坏后果是「最近处理记录」列表变短。
   */
  decisionLog: DecisionLogEntry[]
  /** 决策历史自上次落盘后是否有变更（门面层追加后立即落盘，不积压到轮末） */
  decisionLogDirty: boolean
  /**
   * 同步记录（sync-log.json，最新在尾）：每次引擎轮（成功 / 失败 / 取消 / 让出）
   * 一条，携带触发方式、起止时间、计数摘要与逐文件操作明细。纯展示性审计状态，
   * 不参与 WAL / 基线 / 挂起语义 —— 丢失或损坏的最坏后果是「同步记录」列表变短。
   */
  syncLog: SyncLogEntry[]
  /** 同步记录自上次落盘后是否有变更（引擎轮末追加后立即落盘，不积压） */
  syncLogDirty: boolean
  /** scan-cache.json 损坏降级提示是否已记过（getScanCache 每轮重读磁盘，防长驻进程跨轮刷屏） */
  scanCacheWarned: boolean
  /** 元数据（meta.json）：lastDeepVerifyAt 等（噪声标记已迁至服务器粒度存储，见 ServerStateStore） */
  meta: Record<string, unknown> & { v: number }
  /** 全部文件写操作经此 promise 链串行化（多 worker 并发追加不交错） */
  chain: Promise<unknown>
  /** 文件名 → 追加句柄 */
  fds: Map<string, fs.promises.FileHandle>
  /** 内存序号（仅排障用，不参与校验） */
  seq: number
  logLines: number

  /** @param dirPath 基线存储目录 @param keyInfo { deviceId, localPath, remotePath }（已规范化，写回 meta 备查） */
  constructor(dirPath: string, keyInfo: { deviceId: string; localPath: string; remotePath: string }) {
    this.dirPath = dirPath
    this.keyInfo = keyInfo
    this.entries = new Map<any, any>()
    this.loadedOk = true
    this.warnings = []
    this.pendingIntents = new Map<any, any>()
    this.failures = new Map<any, any>()
    this.failuresDirty = false
    this.pendings = new Map<any, any>()
    this.pendingsDirty = false
    this.deleteBatch = null
    this.deleteScopes = []
    this.decisionLog = []
    this.decisionLogDirty = false
    this.syncLog = []
    this.syncLogDirty = false
    this.scanCacheWarned = false
    this.meta = { v: SCHEMA_V, ...keyInfo }
    this.chain = Promise.resolve()
    this.fds = new Map<any, any>() // 文件名 → 追加句柄
    this.seq = 0
    this.logLines = 0
  }

  /**
   * 打开（或复用）一个目录的基线存储。
   * 加载顺序：meta → snapshot → log 重放 → wal 重放；任何读取异常都不抛出，
   * 按「缺失 / 损坏」各自的降级语义处理（损坏 → 无基线保护，绝不因存储异常让同步误删）。
   */
  static async open(opts: { deviceId?: string; localPath: string; remotePath: string }): Promise<DirStateStore> {
    const deviceId = opts.deviceId || (await getDeviceId())
    const keyInfo = {
      deviceId,
      localPath: normalizeLocalKey(opts.localPath),
      remotePath: normalizeRemoteKey(opts.remotePath),
    }
    const dirPath = baselineDirPath(deviceId, opts.localPath, opts.remotePath)
    const cached = openStores.get(dirPath)
    if (cached) return cached
    const store = new DirStateStore(dirPath, keyInfo)
    await store._load()
    openStores.set(dirPath, store)
    return store
  }

  async _load() {
    await fsp.mkdir(this.dirPath, { recursive: true })
    // meta：损坏不致命，按默认值继续（会话内重新累计）
    try {
      const meta = JSON.parse(await fsp.readFile(this.metaPath(), 'utf-8'))
      if (meta && meta.v === SCHEMA_V && typeof meta === 'object') {
        // 噪声字段（noiseFiles / fingerprintUnstable）已迁移到服务器粒度存储，
        // 此处即便旧文件带出也不再读入目录粒度
        this.meta = { ...this.meta, ...meta }
        delete this.meta.noiseFiles
        delete this.meta.fingerprintUnstable
      }
    } catch (_) {
      /* 首次打开 */
    }
    // failures（持续失败退避表）：损坏 / 版本不识别一律按空处理并记 warning ——
    // 失败记录只是「避免每轮撞墙」的优化，绝不影响同步安全（基线与 WAL 不受牵连）；
    // 放在快照加载之前，快照损坏触发的提前 return 也不会漏掉本表
    let failRaw: any = null
    try {
      failRaw = await fsp.readFile(this.failuresPath(), 'utf-8')
    } catch (e: any) {
      if (e && e.code !== 'ENOENT') this.warnings.push('failures.json 不可读：失败退避记录按空处理')
    }
    if (failRaw !== null) {
      let parsed: any = null
      try {
        parsed = JSON.parse(failRaw)
      } catch (_) {
        /* 损坏 → 按空处理 */
      }
      if (parsed && parsed.v === FAILURES_V && parsed.failures && typeof parsed.failures === 'object') {
        for (const k of Object.keys(parsed.failures)) {
          const f = parsed.failures[k]
          // 逐条轻校验：count / retryAtMs 必须是数字，畸形条目直接丢弃（不连累整表）
          if (f && typeof f === 'object' && typeof f.count === 'number' && typeof f.retryAtMs === 'number') {
            this.failures.set(nfc(k), {
              code: String(f.code || ''),
              message: String(f.message || '').slice(0, FAILURE_MSG_MAX),
              count: f.count,
              firstAt: Number(f.firstAt) || 0,
              lastAt: Number(f.lastAt) || 0,
              retryAtMs: f.retryAtMs,
            })
          }
        }
      } else {
        this.warnings.push('failures.json 损坏或版本不识别：失败退避记录按空处理')
      }
    }
    // pendings（冲突挂起表）：损坏 / 版本不识别一律按空处理并记 warning ——
    // 挂起只是「用户已选择但尚未落地的决策」的辅助状态，绝不影响同步安全
    //（基线与 WAL 不受牵连；最坏情形是丢失后下一轮重新询问用户）。与 failures
    // 同样放在快照加载之前，快照损坏触发的提前 return 也不会漏掉本表。
    let pendRaw: any = null
    try {
      pendRaw = await fsp.readFile(this.pendingPath(), 'utf-8')
    } catch (e: any) {
      if (e && e.code !== 'ENOENT') this.warnings.push('pending-conflicts.json 不可读：冲突挂起记录按空处理')
    }
    if (pendRaw !== null) {
      let parsed: any = null
      try {
        parsed = JSON.parse(pendRaw)
      } catch (_) {
        /* 损坏 → 按空处理 */
      }
      if (parsed && parsed.v === PENDINGS_V && parsed.pendings && typeof parsed.pendings === 'object') {
        for (const k of Object.keys(parsed.pendings)) {
          const p = parsed.pendings[k]
            // 逐条轻校验：createdAt 必须是数字、两侧指纹必须是对象；choice 只认合法值，
            // 其余（含畸形 / 手改的任意串）按「未解决」降级保留条目 —— 畸形条目不连累整表。
            // kind='delete'（删除确认类）/ 'root-lost'（根丢失决策类）原样保留；其余值按冲突类（无 kind）处理
            if (p && typeof p === 'object' && typeof p.createdAt === 'number' && p.local && typeof p.local === 'object' && p.remote && typeof p.remote === 'object') {
              const rec: PendingRecord = {
                local: { size: Number(p.local.size) || 0, mtimeMs: Number(p.local.mtimeMs) || 0 },
                remote: { size: Number(p.remote.size) || 0, mtimeMs: Number(p.remote.mtimeMs) || 0, etag: String(p.remote.etag || '') },
                createdAt: p.createdAt,
              }
              if (p.kind === 'delete' || p.kind === 'root-lost') rec.kind = p.kind
              if (p.choice != null && PENDING_CHOICES.has(p.choice)) rec.choice = p.choice
              // 范围决策盖章的来源标记（scope 前缀 + 代际）：仅删除确认类可能携带；
              // 畸形（缺代际 / 非串前缀）按无来源处理 —— 退化为普通逐文件选择，安全侧
              if (rec.kind === 'delete' && typeof p.scope === 'string' && typeof p.scopeGen === 'number') {
                rec.scope = p.scope
                rec.scopeGen = p.scopeGen
              }
              this.pendings.set(nfc(k), rec)
            }
        }
      } else {
        this.warnings.push('pending-conflicts.json 损坏或版本不识别：冲突挂起记录按空处理')
      }
      // 附加载荷（同文件，向后兼容：旧版本文件没有这两个字段 → 按缺省空值处理）：
      // deleteBatch 批量删除快照 / deleteScopes 删除范围决策。畸形一律按「无」降级 ——
      // 快照缺失时引擎在下一轮触发拦截时重建，scope 丢失只是回到「重新询问」的安全侧。
      const b = parsed && parsed.deleteBatch
      if (b && typeof b === 'object' && typeof b.at === 'number' && typeof b.total === 'number' && typeof b.bytes === 'number' && Array.isArray(b.nodes)) {
        const nodes = b.nodes
          .filter((nd: any) => nd && typeof nd.rel === 'string' && typeof nd.files === 'number' && typeof nd.bytes === 'number')
          .map((nd: any) => ({ rel: nfc(nd.rel), isDir: !!nd.isDir, files: Math.max(0, nd.files), bytes: Math.max(0, nd.bytes) }))
        if (nodes.length) this.deleteBatch = { at: b.at, total: Math.max(0, b.total), bytes: Math.max(0, b.bytes), nodes }
      }
      const sc = parsed && parsed.deleteScopes
      if (Array.isArray(sc)) {
        for (const s of sc) {
          // 逐条轻校验：prefix 非空串（'' = 整目录，合法）、choice 只认 delete/keep；
          // gen 缺失按 0（扁平代际）处理
          if (s && typeof s === 'object' && typeof s.prefix === 'string' && (s.choice === 'delete' || s.choice === 'keep')) {
            this.deleteScopes.push({ prefix: nfc(s.prefix), choice: s.choice, at: Number(s.at) || Date.now(), gen: Number(s.gen) || 0 })
          }
        }
      }
    }
    // decision-log（决策历史）：损坏 / 版本不识别一律按空处理并记 warning —— 纯展示性
    // 审计信息，绝不影响同步安全；与 failures / pendings 同样放在快照加载之前。
    let dlogRaw: any = null
    try {
      dlogRaw = await fsp.readFile(this.decisionLogPath(), 'utf-8')
    } catch (e: any) {
      if (e && e.code !== 'ENOENT') this.warnings.push('decision-log.json 不可读：决策历史按空处理')
    }
    if (dlogRaw !== null) {
      let parsed: any = null
      try {
        parsed = JSON.parse(dlogRaw)
      } catch (_) {
        /* 损坏 → 按空处理 */
      }
      if (parsed && parsed.v === DECISION_LOG_V && Array.isArray(parsed.entries)) {
        for (const en of parsed.entries) {
          // 逐条轻校验：at 必须是数字、rel/kind/choice 必须是非空串；畸形条目直接丢弃
          if (en && typeof en === 'object' && typeof en.at === 'number' && typeof en.rel === 'string' && en.rel && typeof en.kind === 'string' && en.kind && typeof en.choice === 'string' && en.choice) {
            const rec: DecisionLogEntry = { at: en.at, rel: en.rel, kind: en.kind as DecisionLogEntry['kind'], choice: en.choice }
            if (typeof en.affected === 'number' && en.affected > 0) rec.affected = en.affected
            this.decisionLog.push(rec)
          }
        }
      } else {
        this.warnings.push('decision-log.json 损坏或版本不识别：决策历史按空处理')
      }
    }
    // sync-log（同步记录）：损坏 / 版本不识别一律按空处理并记 warning —— 纯展示性
    // 审计信息，绝不影响同步安全；与 failures / pendings 同样放在快照加载之前。
    let slogRaw: any = null
    try {
      slogRaw = await fsp.readFile(this.syncLogPath(), 'utf-8')
    } catch (e: any) {
      if (e && e.code !== 'ENOENT') this.warnings.push('sync-log.json 不可读：同步记录按空处理')
    }
    if (slogRaw !== null) {
      let parsed: any = null
      try {
        parsed = JSON.parse(slogRaw)
      } catch (_) {
        /* 损坏 → 按空处理 */
      }
      if (parsed && parsed.v === SYNC_LOG_V && Array.isArray(parsed.rounds)) {
        for (const rd of parsed.rounds) {
          // 逐条轻校验：起止时刻必须是数字、trigger / status 必须是非空串；畸形条目
          // 直接丢弃不连累整表（与 decision-log 同款容错）。计数缺省 0（旧版本 /
          // 手改文件的宽容读取），操作明细逐条校验并做防御性截断。
          if (rd && typeof rd === 'object' && typeof rd.at === 'number' && typeof rd.endAt === 'number' && typeof rd.trigger === 'string' && rd.trigger && typeof rd.status === 'string' && rd.status) {
            const ops: any[] = []
            if (Array.isArray(rd.ops)) {
              for (const op of rd.ops) {
                if (op && typeof op === 'object' && typeof op.op === 'string' && typeof op.rel === 'string' && op.rel) {
                  const rec: any = { op: op.op, rel: op.rel }
                  if (op.ok === false) rec.ok = false
                  if (typeof op.err === 'string' && op.err) rec.err = String(op.err).slice(0, 500)
                  if (typeof op.bytes === 'number' && op.bytes > 0) rec.bytes = op.bytes
                  if (op.added === true) rec.added = true
                  if (op.choice === 'local' || op.choice === 'remote' || op.choice === 'both') rec.choice = op.choice
                  ops.push(rec)
                }
              }
            }
            const rec: SyncLogEntry = {
              at: rd.at,
              endAt: rd.endAt,
              trigger: rd.trigger,
              status: rd.status as SyncLogEntry['status'],
              uploaded: Number(rd.uploaded) || 0,
              downloaded: Number(rd.downloaded) || 0,
              deleted: Number(rd.deleted) || 0,
              conflicts: Number(rd.conflicts) || 0,
              adopted: Number(rd.adopted) || 0,
              deferredConflicts: Number(rd.deferredConflicts) || 0,
              deleteHeld: Number(rd.deleteHeld) || 0,
              bytesUp: Number(rd.bytesUp) || 0,
              bytesDown: Number(rd.bytesDown) || 0,
              totalFiles: Number(rd.totalFiles) || 0,
              ops,
              errors: Array.isArray(rd.errors) ? rd.errors.filter((s: any) => typeof s === 'string' && s).slice(0, 200) : [],
            }
            if (rd.op === 'pull' || rd.op === 'push' || rd.op === 'pull-full' || rd.op === 'push-full') rec.op = rd.op
            if (typeof rd.error === 'string' && rd.error) rec.error = String(rd.error).slice(0, 500)
            if (typeof rd.errorsDropped === 'number' && rd.errorsDropped > 0) rec.errorsDropped = rd.errorsDropped
            this.syncLog.push(rec)
          }
        }
      } else {
        this.warnings.push('sync-log.json 损坏或版本不识别：同步记录按空处理')
      }
    }
    // snapshot：不存在 = 合法首轮；存在但不可解析 = 损坏 → 无基线保护
    const snapPath = path.join(this.dirPath, 'snapshot.json')
    let raw: any = null
    try {
      raw = await fsp.readFile(snapPath, 'utf-8')
    } catch (e: any) {
      if (e && e.code !== 'ENOENT') {
        this.loadedOk = false
        this.warnings.push('baseline snapshot unreadable: treated as no-baseline (delete propagation disabled)')
      }
    }
    if (raw !== null) {
      let snap: any = null
      try {
        snap = JSON.parse(raw)
      } catch (_) {
        /* 损坏 */
      }
      if (snap && snap.v === SCHEMA_V && snap.entries && typeof snap.entries === 'object') {
        for (const k of Object.keys(snap.entries)) this.entries.set(k, snap.entries[k])
      } else {
        // 快照损坏 = 存储层出过事故 → 整体不信任：跳过日志重放（日志保留在磁盘供排障），
        // 按无基线保护模式运行（引擎将禁用删除传播），轮末压缩会重建快照
        this.loadedOk = false
        this.warnings.push('baseline snapshot corrupt: treated as no-baseline (delete propagation disabled)')
        return
      }
    }
    // 快照不存在（从未压缩）或快照正常：重放增量日志（尾部损坏自动截断）
    let logText = ''
    try {
      logText = await fsp.readFile(this.logPath(), 'utf-8')
    } catch (_) {
      /* 无日志 */
    }
    this.logLines = replayLogText(logText, (op) => this._applyOp(op), this.warnings, 'baseline log')
    // wal 重放：折叠出未了结意图
    let walText = ''
    try {
      walText = await fsp.readFile(this.walPath(), 'utf-8')
    } catch (_) {
      /* 无 wal */
    }
    replayLogText(walText, (op) => this._applyWalOp(op), this.warnings, 'wal')
  }

  /** 应用一条基线日志操作（幂等：后写覆盖先写） */
  _applyOp(op: LogOp): void {
    if (op.t === 'set' && typeof op.k === 'string' && op.e) this.entries.set(op.k, op.e)
    else if (op.t === 'del' && typeof op.k === 'string') this.entries.delete(op.k)
    else if (op.t === 'clear') this.entries.clear()
  }

  /** 应用一条 WAL 操作：intent 登记 / done 与 abort 了结 */
  _applyWalOp(op: LogOp): void {
    if (op.t === 'intent' && op.id) this.pendingIntents.set(op.id, op as unknown as WalIntent)
    else if ((op.t === 'done' || op.t === 'abort') && op.id) this.pendingIntents.delete(op.id)
  }

  metaPath(): string {
    return path.join(this.dirPath, 'meta.json')
  }
  logPath(): string {
    return path.join(this.dirPath, 'log.jsonl')
  }
  walPath(): string {
    return path.join(this.dirPath, 'wal.jsonl')
  }
  failuresPath(): string {
    return path.join(this.dirPath, 'failures.json')
  }
  pendingPath(): string {
    return path.join(this.dirPath, 'pending-conflicts.json')
  }
  decisionLogPath(): string {
    return path.join(this.dirPath, 'decision-log.json')
  }
  syncLogPath(): string {
    return path.join(this.dirPath, 'sync-log.json')
  }
  scanCachePath(): string {
    return path.join(this.dirPath, 'scan-cache.json')
  }

  /** 经互斥链串行化一次异步写（并发 worker 追加不交错） */
  _chain<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.catch(() => {})
    return run
  }

  /** 取（或惰性打开）某文件的追加句柄 */
  async _fdFor(name: string): Promise<fs.promises.FileHandle> {
    let fh = this.fds.get(name)
    if (!fh) {
      fh = await fsp.open(path.join(this.dirPath, name), 'a')
      this.fds.set(name, fh)
    }
    return fh
  }

  /**
   * 追加一行到指定日志文件（内存序号仅用于排障，不参与校验）。
   * fsyncKind 非空 → 写入后立即 fsync 该句柄并上报事件（WAL intent / done 的崩溃
   * 安全点 1 / 2，意图与了结证据必须当场落盘）。基线日志（setEntry / deleteEntry）
   * 不传 → 批量策略：丢失一条基线行时，WAL 的 done 行（已 fsync）配合下一轮
   * recoverIntents 的采纳语义可安全收敛（无基线条目 + 两侧同内容 → adopt），轮末
   * flush() 统一补齐 —— 逐条 fsync 换不来更强的收敛保证，只会拖慢每文件同步路径。
   * fsync 失败静默吞：fsync 只是附加的持久化动作，不改变追加写本身的语义与错误行为。
   */
  _appendLine(name: string, op: LogOp, fsyncKind?: string | null): Promise<void> {
    return this._chain(async () => {
      this.seq++
      const fh = await this._fdFor(name)
      await fh.writeFile(encodeLine(this.seq, op), 'utf-8')
      if (fsyncKind) {
        await fh.sync().catch(() => {})
        noteFsync(fsyncKind, path.join(this.dirPath, name))
      }
    })
  }

  // ---- 基线读写 ----

  /** 读取某 rel 的基线条目（内部做 NFC 归一；不存在返回 undefined） */
  get(rel: string): BaselineEntry | undefined {
    return this.entries.get(nfc(rel))
  }

  /**
   * 写入 / 更新一条基线：先更新内存，再追加日志。
   * 追加失败时抛出（调用方按文件级失败处理）——重载后以日志为准，内存领先不会误删。
   */
  async setEntry(rel: string, entry: BaselineEntry): Promise<void> {
    const k = nfc(rel)
    this.entries.set(k, entry)
    return this._appendLine('log.jsonl', { t: 'set', k, e: entry })
  }

  /** 删除一条基线（如两侧均已不存在的 clean、删除传播完成） */
  async deleteEntry(rel: string): Promise<void> {
    const k = nfc(rel)
    this.entries.delete(k)
    return this._appendLine('log.jsonl', { t: 'del', k })
  }

  // ---- WAL ----

  /**
   * 操作前登记意图（intent 必须先于操作本身可被观察到）。
   * 崩溃安全点 1：写入后立即 fsync —— 意图必须先于远端操作落盘，否则掉电后
   * 无从采纳 / 重推导，这是 WAL 的根本保证。
   */
  async appendWalIntent(intent: WalIntent): Promise<void> {
    this.pendingIntents.set(intent.id, intent)
    return this._appendLine('wal.jsonl', { t: 'intent', ...intent }, 'wal')
  }

  /**
   * 操作验证成功且基线已更新后了结意图。
   * 崩溃安全点 2：写入后立即 fsync —— done 行是「操作已完成」的落盘证据，
   * 恢复期据此直接采纳而无需重核对。
   */
  async appendWalDone(id: string): Promise<void> {
    this.pendingIntents.delete(id)
    return this._appendLine('wal.jsonl', { t: 'done', id }, 'wal')
  }

  /**
   * 意图放弃（操作失败 / 恢复核对不通过）。不设即时 fsync（批量策略）：丢失
   * abort 行只会让未了结意图在崩溃恢复时按保守路径重核对后再度放弃，不会造成
   * 重复应用，走轮末 flush 即可。
   */
  async appendWalAbort(id: string): Promise<void> {
    this.pendingIntents.delete(id)
    return this._appendLine('wal.jsonl', { t: 'abort', id })
  }

  /**
   * 轮末清空 WAL（全部意图已了结；崩溃残留的未了结意图会在下次加载时重现）。
   * 存在**开放意图**（PUT 以 NETWORK / ABORTED / 读流失败收场后有意
   * 保持未了结的 upload 意图，见 services.js 的 abort 策略）时**跳过截断** —— 截断会
   * 抹掉「本机可能已在远端留下半截文件」的唯一线索。开放意图由下一轮 recoverIntents
   * 三向判定（采纳 / 放弃 / 判半截转重传）收敛；防无限累积由两条兜底保证：
   * 本地文件已不存在 / 已变化 → 恢复期放弃；开放意图龄超 30 天 → 恢复期放弃。
   */
  async truncateWal(): Promise<void> {
    if (this.pendingIntents.size > 0) return // 有开放意图：保留 WAL 供下一轮恢复
    await this._truncateFile('wal.jsonl')
    this.pendingIntents.clear()
  }

  /**
   * 测试专用：把全部开放意图的写入时间整体前拨 ms 毫秒（验证 30 天超龄兜底；
   * 只改内存不落盘，与 ageFailures 同款语义）。超龄按链上最初写入时刻 firstAt
   * 计算 —— at 与 firstAt 一并前拨，与生产语义保持同构。
   */
  ageOpenIntents(ms: number): void {
    for (const it of this.pendingIntents.values()) {
      it.at = (Number(it.at) || 0) - (Number(ms) || 0)
      if (Number(it.firstAt) > 0) it.firstAt = Number(it.firstAt) - (Number(ms) || 0)
    }
  }

  // ---- 持续失败退避记录 ----
  //
  // 语义：永久失败（HTTP 413/507/403/405、本地 EACCES/EPERM 等，由 services.js 的
  // classifyOpFailure 判定）按文件记入本表，指数退避期内规划层不再为该文件生成传输
  // 任务；传输成功或两侧均已不存在（clean）时清除。纯内存读写，轮末由引擎在
  // failuresDirty 时统一落盘（与基线 / WAL 共用 chain 串行，内部不并发）。

  /** 读取某 rel 的失败记录（nfc 归一；不存在返回 undefined） */
  getFailure(rel: string): FailureRecord | undefined {
    return this.failures.get(nfc(rel))
  }

  /**
   * 记录一次永久失败：count 累加，重试时间 = lastAt + min(15 分钟 × 2^(count-1), 7 天)。
   * message 截断到 FAILURE_MSG_MAX 字符；条目总数已达 MAX_FAILURE_ENTRIES 时丢弃
   * 新条目并记 warning（返回 false，调用方据此向用户提示）。
   * @param {string} rel 文件相对路径
   * @param {{ code?: string, message?: string }} info 失败分类码与消息（来自错误对象）
   * @returns {boolean} 是否成功记录
   */
  noteFailure(rel: string, info: { code?: string; message?: string } = {}): boolean {
    const k = nfc(rel)
    const prev = this.failures.get(k)
    if (!prev && this.failures.size >= MAX_FAILURE_ENTRIES) {
      this.warnings.push(`失败退避记录已达上限 ${MAX_FAILURE_ENTRIES} 条：${k} 的新失败未记录`)
      return false
    }
    const now = Date.now()
    const count = (prev ? prev.count : 0) + 1
    const delay = Math.min(FAILURE_RETRY_BASE_MS * Math.pow(2, count - 1), FAILURE_RETRY_MAX_MS)
    this.failures.set(k, {
      code: String(info.code || ''),
      message: String(info.message || '').slice(0, FAILURE_MSG_MAX),
      count,
      firstAt: prev ? prev.firstAt : now,
      lastAt: now,
      retryAtMs: now + delay,
    })
    this.failuresDirty = true
    return true
  }

  /**
   * 清除某 rel 的失败记录（该文件传输成功 / 动作收敛为 clean 时调用）。
   * @returns {boolean} 是否确实移除了条目（调用方可据此判断是否需要落盘，本表统一由轮末落盘）
   */
  clearFailure(rel: string): boolean {
    const k = nfc(rel)
    if (!this.failures.delete(k)) return false
    this.failuresDirty = true
    return true
  }

  /**
   * 仍处于退避期（retryAtMs > nowMs）的 rel 集合：规划层据此跳过该文件的传输动作。
   * @param {number} nowMs 判定基准时刻（缺省当前时间）
   * @returns {Set<string>} 退避期内的 rel 集合（nfc key）
   */
  failureSkipList(nowMs: number = Date.now()): Set<string> {
    const out = new Set<string>()
    for (const [k, f] of this.failures) if (f.retryAtMs > nowMs) out.add(k)
    return out
  }

  /** 轮末落盘失败退避表（引擎仅在 failuresDirty 时调用；经 chain 与基线/WAL 写入串行） */
  async saveFailures(): Promise<void> {
    return this._chain(async () => {
      await atomicWriteJson(this.failuresPath(), { v: FAILURES_V, failures: Object.fromEntries(this.failures) })
      this.failuresDirty = false
    })
  }

  /** 测试专用：把全部记录的重试时间整体前拨 ms 毫秒（验证退避到期后的重试行为；只改内存不落盘） */
  ageFailures(ms: number): void {
    for (const f of this.failures.values()) f.retryAtMs -= Number(ms) || 0
  }

  // ---- 挂起记录（冲突类 + 删除确认类）----
  //
  // 语义：用户对某个冲突做出的选择（local / remote / both）在「决策成功落地」之前先
  // 挂起持久化 —— 落地失败（A 档 412 / B 档复查 REMOTE_CHANGED / 网络错误）时，下一轮
  // 规划遇到同一文件的冲突即自动沿用该选择，不再重复弹窗（「应用到全部」的决策
  // 跨轮延续）。无 choice 的条目是「已询问但未解决」的挂起，供后续 UI 统一处理。
  // 删除确认类（kind='delete'）：单轮待删超过安全阈值时由引擎整批登记（无 choice），
  // 用户经同一面板确认（delete，下一轮执行删除）或保留（keep，持续抑制该文件的
  // 删除传播直至状态变化）；确认删除落地成功后由引擎清除。
  // 根丢失决策类（kind='root-lost'，rel 恒为 '.'）：远端同步根 404 且基线非空时登记
  //（无 choice），用户在决策弹窗选择 upload（重建云端并重新上传）或 remove-local
  // （跟随云端删除移除本地已同步内容）；下一轮根探测消费该选择后清除。
  // 生命周期：决策时登记（setPending）→ 规划期消费（引擎读 getPending）→ 冲突解决
  // 动作成功提交后清除（clearPending）→ 失败保留（什么都不做）。纯内存读写，轮末由
  // 引擎在 pendingsDirty 时统一落盘（与基线 / WAL / failures 共用 chain 串行，内部不并发）。
  //
  // 安全边界：本表绕不过也补不了 WAL / 基线语义 —— 它只回答「这个冲突按哪个策略办 /
  // 这个删除是否已确认」，不承载任何「数据是否已传输」的事实；删除本表文件不影响
  // 同步正确性，只影响体验（删除确认类条目丢失后下一轮按阈值重新登记，仍零删除）。

  /** 读取某 rel 的挂起记录（nfc 归一；不存在返回 undefined） */
  getPending(rel: string): PendingRecord | undefined {
    return this.pendings.get(nfc(rel))
  }

  /**
   * 全部挂起记录（数组，按 createdAt 升序）—— UI 列表与测试断言共用；
   * 返回深拷贝副本，调用方改写不会污染内部状态。
   */
  listPending(): PendingListItem[] {
    return Array.from(this.pendings.entries())
      .map(([rel, p]) => ({
        rel,
        local: { ...p.local },
        remote: { ...p.remote },
        createdAt: p.createdAt,
        ...(p.choice ? { choice: p.choice } : {}),
        ...(p.kind ? { kind: p.kind } : {}),
      }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * 登记（或覆盖）一条挂起记录。
   * @param {string} rel 文件相对路径（内部 nfc 归一）
   * @param {{ local?: {size?, mtimeMs?}, remote?: {size?, mtimeMs?, etag?}, createdAt?: number, choice?: string, kind?: string }} info
   *        两侧指纹（size / mtimeMs / etag，供 UI 展示与排障）、登记时刻、用户选择
   *        （冲突类 'local'|'remote'|'both'；删除确认类 'delete'|'keep'；省略 = 未解决
   *        挂起；非法值按未处理对待，不写入 choice）、记录类别 kind（'delete' = 删除
   *        确认类；省略 = 冲突类）
   * @returns {boolean} 是否成功记录（条目总数已达 MAX_PENDING_ENTRIES 且该 rel 无既有
   *          条目时丢弃新条目、记 warning 并返回 false；既有条目覆盖不受上限影响）
   */
  setPending(
    rel: string,
    info: {
      local?: { size?: number; mtimeMs?: number }
      remote?: { size?: number; mtimeMs?: number; etag?: string }
      createdAt?: number
      choice?: string
      kind?: string
    } = {}
  ): boolean {
    const k = nfc(rel)
    if (!this.pendings.has(k) && this.pendings.size >= MAX_PENDING_ENTRIES) {
      this.warnings.push(`冲突挂起记录已达上限 ${MAX_PENDING_ENTRIES} 条：${k} 的新挂起未记录`)
      return false
    }
    const rec: PendingRecord = {
      local: {
        size: Number(info.local && info.local.size) || 0,
        mtimeMs: Number(info.local && info.local.mtimeMs) || 0,
      },
      remote: {
        size: Number(info.remote && info.remote.size) || 0,
        mtimeMs: Number(info.remote && info.remote.mtimeMs) || 0,
        etag: String((info.remote && info.remote.etag) || ''),
      },
      createdAt: Number(info.createdAt) || Date.now(),
    }
    if (info.kind === 'delete' || info.kind === 'root-lost') rec.kind = info.kind
    if (info.choice != null && PENDING_CHOICES.has(info.choice)) rec.choice = info.choice as PendingRecord['choice']
    this.pendings.set(k, rec)
    this.pendingsDirty = true
    return true
  }

  /**
   * 清除某 rel 的挂起记录（冲突决策成功落地时由引擎调用）。
   * @returns {boolean} 是否确实移除了条目（无条目时为无害 no-op，返回 false）
   */
  clearPending(rel: string): boolean {
    const k = nfc(rel)
    if (!this.pendings.delete(k)) return false
    this.pendingsDirty = true
    return true
  }

  // ---- 批量删除快照 + 删除范围决策 ----
  //
  // 语义：逐文件挂起表（上方 pendings）有 MAX_PENDING_ENTRIES 上限，「大量文件被删
  // 触发批量删除闸」时超出上限的候选没有逐文件记录 —— 用户在目录树上做的「保留 /
  // 删除」决策若只落逐文件记录，永远盖不住装不下的部分（历史缺陷：确认过「全部不删」
  // 后每轮仍重新询问）。本节补两个结构：
  //   deleteBatch  —— 拦截轮对全部未决策候选的目录聚合快照（UI 树形展示 + 「全部」
  //                  类决策的完整事实源）；全部候选被消费后由引擎清除。
  //   deleteScopes —— 前缀范围决策（'' = 整目录）：规划期按前缀匹配消费（最具体者
  //                  胜），天然覆盖装不下的候选；扫描完整且零匹配的轮自动剪枝。
  // 二者与 pendings 同为「决策辅助状态」：不参与 WAL / 基线语义，丢失 / 损坏的
  // 最坏后果是 UI 树缺失（下轮触发拦截时重建）或回到「重新询问」的安全侧。
  // 持久化与 pendings 同文件同脏标记（savePendings 一并写入）。

  /** 读取批量删除快照（无则 null；返回内部引用 —— 引擎只写不改读出对象） */
  getDeleteBatch(): DeleteBatch | null {
    return this.deleteBatch
  }

  /** 写入（整体替换）批量删除快照；引擎在触发拦截的轮构建后调用 */
  setDeleteBatch(batch: DeleteBatch): void {
    this.deleteBatch = batch
    this.pendingsDirty = true
  }

  /**
   * 清除批量删除快照（全部候选已消费 / 情形已消失时由引擎调用）。
   * @returns {boolean} 是否确实清除了快照（无快照时 no-op 返回 false）
   */
  clearDeleteBatch(): boolean {
    if (!this.deleteBatch) return false
    this.deleteBatch = null
    this.pendingsDirty = true
    return true
  }

  /**
   * 落一条（或覆盖同前缀槽位的）删除范围决策。prefix 已 nfc 归一（调用方保证）；
   * 同前缀重复决策按「最后一次为准」覆盖；gen 为决策代际（快照 at，扁平为 0）——
   * 只影响盖章改写边界（见 stampDeleteScopeChoices），不参与匹配。
   */
  setDeleteScope(prefix: string, choice: 'delete' | 'keep', gen: number): void {
    const p = nfc(prefix)
    const existing = this.deleteScopes.find((s) => s.prefix === p)
    if (existing) {
      existing.choice = choice
      existing.at = Date.now()
      existing.gen = gen
    } else {
      this.deleteScopes.push({ prefix: p, choice, at: Date.now(), gen })
    }
    this.pendingsDirty = true
  }

  /** 当前全部删除范围决策（返回深拷贝副本，调用方改写不会污染内部状态） */
  listDeleteScopes(): DeleteScope[] {
    return this.deleteScopes.map((s) => ({ ...s }))
  }

  /**
   * 匹配某 rel 的删除范围决策：rel === prefix（文件级 / 目录级精确）或 rel 在
   * prefix 目录之下（prefix='photos' 匹配 'photos/a.jpg' 与 'photos/sub/b.jpg'；
   * prefix='' 匹配全部）。多 scope 命中时取最具体（最长前缀）者 —— 用户先保了
   * 大目录、后单独确认了其中一个文件时，以更具体的决定为准。
   * @returns {DeleteScope | null} 命中的决策；无命中返回 null
   */
  matchDeleteScope(rel: string): DeleteScope | null {
    const k = nfc(rel)
    let best: DeleteScope | null = null
    for (const s of this.deleteScopes) {
      const hit = s.prefix === '' || s.prefix === k || k.startsWith(s.prefix === '' ? '' : s.prefix + '/')
      if (hit && (!best || s.prefix.length > best.prefix.length)) best = s
    }
    return best
  }

  /**
   * 剪枝失效的范围决策：引擎传入「本轮实际匹配过的前缀集合」，未出现在集合中的
   * scope 视为其覆盖情形已消失（文件恢复 / 已全部处理 / 基线变化），自动移除 ——
   * 否则陈旧 keep 会永远压制未来的新删除事件（用户删除云端后本应重新询问）。
   * 仅在扫描完整轮调用（扫描不完整时「零匹配」不可信，见引擎调用点注释）。
   * @param matchedPrefixes 本轮至少匹配过一个删除候选的前缀集合
   * @returns {number} 剪枝掉的决策条数（0 = 无变化，引擎无需落盘）
   */
  pruneDeleteScopes(matchedPrefixes: Set<string>): number {
    if (!this.deleteScopes.length) return 0
    const kept = this.deleteScopes.filter((s) => matchedPrefixes.has(s.prefix))
    if (kept.length === this.deleteScopes.length) return 0
    const pruned = this.deleteScopes.length - kept.length
    this.deleteScopes = kept
    this.pendingsDirty = true
    return pruned
  }

  /** 是否存在未决策（无 choice）的删除确认类挂起（引擎轮末判定快照可否清除） */
  hasUndecidedDeletes(): boolean {
    for (const p of this.pendings.values()) {
      if (p.kind === 'delete' && !p.choice) return true
    }
    return false
  }

  /**
   * 把某前缀下既有删除确认类挂起的 choice 对齐为用户在目录树上做的范围决策
   *（setDeleteScope 的配套：决策同时盖章既有逐文件记录，保证「挂起表逐条判定」
   * 与「scope 匹配判定」两条消费路径语义一致，且 UI 列表不再把这些条目当未决策
   * 展示）。改写边界（防翻案）：
   *   - 无 choice 的记录 → 盖章（本就是待决策项，范围决策覆盖它们是本意）；
   *   - 已有 choice 且来自同代范围决策（scopeGen === gen）且旧前缀被新前缀覆盖
   *     → 改写（同代内更具体 / 更新的范围决策覆盖旧的盖章，如子树保留后单独
   *       确认其中一文件）；
   *   - 其余（用户逐文件显式选择，或跨代的盖章）→ 不动（范围决策不翻案逐文件
   *     决策与旧代决定 —— 「全部」只作用于当前树里未决策的部分）。
   * @returns {number} 盖章（含改写）的记录条数
   */
  stampDeleteScopeChoices(prefix: string, choice: 'delete' | 'keep', gen: number): number {
    const p = nfc(prefix)
    let n = 0
    for (const [k, rec] of this.pendings) {
      if (rec.kind !== 'delete') continue
      const hit = p === '' || p === k || k.startsWith(p === '' ? '' : p + '/')
      if (!hit) continue
      // 改写仅限「同代且新前缀落在旧盖章前缀之内 / 相等」（更具体的后点决策细化
      // 旧的盖章）；更宽的新决策不动旧盖章（引擎按最具体 scope 匹配，行为不受影响）
      const withinOld = rec.scope != null && (rec.scope === '' || p === rec.scope || p.startsWith(rec.scope + '/'))
      const restamp = !rec.choice || (rec.scopeGen === gen && withinOld)
      if (!restamp) continue
      rec.choice = choice
      rec.scope = p
      rec.scopeGen = gen
      n++
    }
    if (n > 0) this.pendingsDirty = true
    return n
  }

  /** 轮末落盘冲突挂起表（引擎仅在 pendingsDirty 时调用；经 chain 与基线/WAL/失败表写入串行）。
   *  同文件附加写入批量删除快照（deleteBatch）与删除范围决策（deleteScopes）——
   *  二者与挂起表同为「决策辅助状态」，共用 pendingsDirty 脏标记与落盘时机。 */
  async savePendings(): Promise<void> {
    return this._chain(async () => {
      await atomicWriteJson(this.pendingPath(), {
        v: PENDINGS_V,
        pendings: Object.fromEntries(this.pendings),
        deleteBatch: this.deleteBatch,
        deleteScopes: this.deleteScopes,
      })
      this.pendingsDirty = false
    })
  }

  // ---- 决策历史记录 ----
  //
  // 语义：decision-log.json（整体原子写）保存用户对待处理挂起的每次选择 / 忽略
  //（appendDecision 追加，最新在尾，环形上限 MAX_DECISION_LOG_ENTRIES 条 —— 超限
  // 丢弃最旧）。与 pendings 同为「决策辅助 / 展示」性质：不承载任何数据事实，
  // 删除本文件不影响同步正确性，只影响「最近处理记录」可回看的范围。

  /**
   * 追加一条决策历史（用户经 setPendingChoice 落选择 / 经 clearPendingConflict
   * 忽略挂起时由门面层调用）。环形上限：超出后丢弃最旧条目。
   * @param entry 决策条目（at / rel / kind / choice；root-lost 类带 affected）
   */
  appendDecision(entry: DecisionLogEntry): void {
    this.decisionLog.push(entry)
    if (this.decisionLog.length > MAX_DECISION_LOG_ENTRIES) {
      this.decisionLog.splice(0, this.decisionLog.length - MAX_DECISION_LOG_ENTRIES)
    }
    this.decisionLogDirty = true
  }

  /**
   * 全部决策历史（按时间倒序，最新在前）——「最近处理记录」面板与测试断言共用；
   * 返回浅拷贝副本（条目对象视为只读不再深拷贝），调用方改写不会污染内部顺序。
   */
  listDecisionLog(): DecisionLogEntry[] {
    return [...this.decisionLog].reverse()
  }

  /** 落盘决策历史（门面层追加后立即调用，不积压；经 chain 与其他表写入串行） */
  async saveDecisionLog(): Promise<void> {
    return this._chain(async () => {
      await atomicWriteJson(this.decisionLogPath(), { v: DECISION_LOG_V, entries: this.decisionLog })
      this.decisionLogDirty = false
    })
  }

  // ---- 同步记录 ----
  //
  // 语义：sync-log.json（整体原子写）保存每次引擎轮一条的同步审计记录（引擎
  // syncDirectory 收尾处 appendSyncLog，最新在尾，环形上限 MAX_SYNC_LOG_ROUNDS
  // 轮 —— 超限丢弃最旧）。与 decision-log 同为「展示 / 审计」性质：不承载任何
  // 数据事实，删除本文件不影响同步正确性，只影响「同步记录」页可回看的范围。

  /**
   * 追加一条同步记录（引擎 syncDirectory 轮末收尾时调用）。环形上限：超出后
   * 丢弃最旧轮次。单轮操作明细全量记录（截断语义已移除，展示完整性由渲染层
   * 虚拟滚动承担）。
   * @param entry 同步记录条目（at / endAt / trigger / status / 计数 / ops / errors）
   */
  appendSyncLog(entry: SyncLogEntry): void {
    this.syncLog.push(entry)
    if (this.syncLog.length > MAX_SYNC_LOG_ROUNDS) {
      this.syncLog.splice(0, this.syncLog.length - MAX_SYNC_LOG_ROUNDS)
    }
    this.syncLogDirty = true
  }

  /**
   * 全部同步记录（按时间倒序，最新在前）——「同步记录」页与测试断言共用；
   * 返回浅拷贝副本（条目对象视为只读不再深拷贝），调用方改写不会污染内部顺序。
   */
  listSyncLog(): SyncLogEntry[] {
    return [...this.syncLog].reverse()
  }

  /** 落盘同步记录（引擎轮末追加后立即调用，不积压；经 chain 与其他表写入串行） */
  async saveSyncLog(): Promise<void> {
    return this._chain(async () => {
      await atomicWriteJson(this.syncLogPath(), { v: SYNC_LOG_V, rounds: this.syncLog })
      this.syncLogDirty = false
    })
  }

  // ---- etag 跳过扫描缓存----
  //
  // 语义：远端子集合 etag 跳过扫描的缓存（scan-cache.json，整体原子写）。形状：
  //   { v: 1, lastFullScanAt: 毫秒, collections: { <远端集合 NFC rel>: { e: etag, m: mtimeMs } } }
  // 只有「完整扫描轮」的观测才可落入（引擎在 I1 闸门通过后写入；lastFullScanAt
  // 是最近一次全量下降时刻，超过 ETAG_SKIP_FULL_SCAN_MS 后缓存过期、强制全量）。
  // 纯性能优化状态：丢失 / 损坏的最坏后果是下一轮多列举一些目录，绝不影响同步
  // 正确性 —— 与 failures / pendings 同等对待，不进 WAL / 基线语义。

  /**
   * 读取 etag 跳过扫描缓存；缺失 / 损坏 / 版本不识别返回 null（调用方按
   * 「不跳过」全量列举，只损失性能）。每次调用都重读磁盘（每轮一次、文件极小）：
   * store 实例跨轮长驻进程内存，缓存读值会让磁盘上的修复 / 测试改写失效，
   * 新鲜度以磁盘为准。损坏与版本不识别记 warning 且每实例只记一次（防跨轮刷屏）；
   * 逐条轻校验：e 必须为非空字符串、m 必须为数字，畸形条目直接丢弃不连累整表
   * （与 failures / pendings 的逐条容错同款）。键统一 NFC 归一。
   */
  getScanCache(): any | null {
    let text: string
    try {
      text = fs.readFileSync(this.scanCachePath(), 'utf-8')
    } catch (_) {
      return null // 不存在（首轮）/ 不可读：按无缓存处理，静默
    }
    let raw: any = null
    let parseFailed = false
    try {
      raw = JSON.parse(text)
    } catch (_) {
      parseFailed = true // 半截 / 非法 JSON：与版本不识别同路降级（下方统一警告）
    }
    if (parseFailed || !raw || raw.v !== SCAN_CACHE_V || !raw.collections || typeof raw.collections !== 'object') {
      if (!this.scanCacheWarned) {
        this.scanCacheWarned = true
        this.warnings.push('scan-cache.json 损坏或版本不识别：etag 跳过缓存按空处理（本轮全量列举）')
      }
      return null
    }
    const collections: Record<string, { e: string; m: number }> = {}
    for (const k of Object.keys(raw.collections)) {
      const c = raw.collections[k]
      if (c && typeof c === 'object' && typeof c.e === 'string' && c.e && typeof c.m === 'number') {
        collections[nfc(k)] = { e: c.e, m: c.m }
      }
    }
    return {
      v: SCAN_CACHE_V,
      lastFullScanAt: typeof raw.lastFullScanAt === 'number' ? raw.lastFullScanAt : 0,
      collections,
    }
  }

  /**
   * 原子保存 etag 跳过扫描缓存（经 chain 与基线 / WAL / 附属表写串行）。
   * 写失败向上抛 —— 调用方按「下一轮多列举」降级提示即可，不影响同步正确性。
   */
  async saveScanCache(cache: unknown): Promise<void> {
    return this._chain(() => atomicWriteJson(this.scanCachePath(), cache))
  }

  // ---- 持久化收尾 ----

  /** fsync 全部打开的追加句柄（轮末崩溃安全点：安全点 4，基线日志批量策略的统一补齐） */
  async flush(): Promise<void> {
    return this._chain(async () => {
      for (const [name, fh] of this.fds.entries()) {
        await fh.sync().catch(() => {})
        noteFsync('flush', path.join(this.dirPath, name))
      }
    })
  }

  /** 原子压缩：写快照 tmp → fsync → rename → 清空日志（任意断点崩溃均可一致恢复） */
  async compact(): Promise<void> {
    return this._chain(async () => {
      const snapFile = path.join(this.dirPath, 'snapshot.json')
      const tmp = `${snapFile}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
      const fh = await fsp.open(tmp, 'w')
      try {
        const obj = { v: SCHEMA_V, ts: Date.now(), entries: Object.fromEntries(this.entries) }
        await fh.writeFile(JSON.stringify(obj), 'utf-8')
        await fh.sync()
        noteFsync('json-file', tmp)
      } finally {
        await fh.close()
      }
      await fsp.rename(tmp, snapFile)
      // rename 后 fsync 目录（安全点 5）：让新快照的目录项掉电级落盘（Windows 跳过）
      await fsyncDirIfPossible(this.dirPath, 'compact-dir')
      // 注意：此处已身处 chain 任务内，只能调用「不再入链」的内部实现，否则自等死锁
      await this._truncateFileNow('log.jsonl')
      this.logLines = 0
      // 快照损坏的轮次由引擎在轮末强制 compact 重建：用本轮已验证的事实重写快照后，
      // 内存态与磁盘一致且全部可信，解除「无基线保护」标记（对缺失条目的保护由
      // 「无条目 ⇒ decideAction 不产生 delete-*」继续保证）
      this.loadedOk = true
    })
  }

  /** 日志行数超阈值时压缩（轮末调用） */
  async compactIfNeeded(): Promise<void> {
    if (this.logLines >= COMPACT_LOG_LINES) await this.compact()
  }

  /** 保存元数据（原子写） */
  async saveMeta(): Promise<void> {
    const meta = { ...this.meta, v: SCHEMA_V }
    await atomicWriteJson(this.metaPath(), meta)
  }

  // ---- fingerprint-unstable 已迁移 ----
  // 噪声集合与 unstable 标记属于「同一台服务器（origin+username）」而非单个目录，
  // 旧目录粒度方法（fingerprintUnstable / noteRemoteFingerprintNoise /
  // resetRemoteFingerprintNoise）已删除，由 ServerStateStore 承接；
  // 无历史用户数据需要迁移，引擎的触发条件与 note/reset 调用点已改到新存储。

  // ---- 内部 ----

  /** 截断一个日志文件：关句柄 → 置空 → 下次追加重新打开 */
  async _truncateFile(name: string): Promise<void> {
    return this._chain(() => this._truncateFileNow(name))
  }

  /**
   * _truncateFile 的内部实现（调用方必须已持有 chain；不得直接外部调用）。
   * 截断也要落盘（安全点 6）：open('w') → 写空 → fsync → close —— 未 fsync 的截断
   * 在掉电后可能「复活」旧日志行；即便复活，重放对已压缩进快照的操作也幂等
   * （后写覆盖先写），此处的 fsync 是让磁盘状态与语义状态一致，而非安全兜底。
   */
  async _truncateFileNow(name: string): Promise<void> {
    const fh = this.fds.get(name)
    if (fh) {
      this.fds.delete(name)
      await fh.close().catch(() => {})
    }
    const file = path.join(this.dirPath, name)
    const h = await fsp.open(file, 'w')
    try {
      await h.writeFile('', 'utf-8')
      await h.sync()
      noteFsync('truncate', file)
    } finally {
      await h.close()
    }
  }

  /** 关闭全部句柄并从进程缓存移除（进程退出 / 测试切根时） */
  async close(): Promise<void> {
    await this._chain(async () => {
      for (const fh of this.fds.values()) await fh.close().catch(() => {})
      this.fds.clear()
    })
    openStores.delete(this.dirPath)
  }
}

/** 关闭全部已打开存储（进程退出 / 测试切根） */
async function closeAllStores(): Promise<void> {
  const all = Array.from(openStores.values())
  openStores.clear()
  for (const s of all) await s.close().catch(() => {})
  // 服务器粒度状态不持有文件句柄，只需清空进程内缓存：
  // 切根（setRootForTest）后按新根重新加载，与基线存储的隔离语义一致
  openServerStores.clear()
}

// ---------- ServerStateStore：服务器粒度状态 ----------

/** 服务器状态结构版本号 */
const SERVER_STATE_V = 1
/** 已打开的服务器状态存储：serverStateDirPath → ServerStateStore（进程内复用） */
const openServerStores = new Map<string, ServerStateStore>()

/** 由「origin + username」计算服务器状态目录（sha256 前 16 hex） */
function serverStateDirPath(origin: string, username: string): string {
  const key = JSON.stringify([SERVER_STATE_V, String(origin || ''), String(username || '')])
  const h = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
  return path.join(storageRoot(), 'servers', h)
}

/**
 * 单个「origin + username」的服务器状态存储。
 * 与 DirStateStore 的目录粒度不同，这里存放跨目录共享的服务器级事实：
 *   - capabilities.json：probeCapabilities 的探测结果（档位 / etag / 条件请求等），
 *     TTL 由调用方解释（默认 7 天，可用 force 强制重探）；
 *   - noise.json：fingerprint-unstable 噪声文件集合 —— 同一服务器（同账号）下
 *     累计出现 FINGERPRINT_NOISE_FILES 个「不同文件」的「指纹变化但内容相同」
 *     即标记整台服务器（跨目录累计）。
 * 两个文件均为整体原子写（无 append 日志）：体积小、写频低，损坏即按默认值
 * 重新探测 / 重新累计，不影响同步安全（基线仍在 DirStateStore，受 CRC 保护）。
 */
class ServerStateStore {
  /** 状态存储目录 */
  dirPath: string
  /** { origin, username }（写回文件备查） */
  keyInfo: { origin: string; username: string }
  /** 最近一次成功探测的结果（null = 从未探测 / 缓存不可用） */
  capabilities: any
  /**
   * 指纹噪声状态：{ fingerprintUnstable, noiseFiles, concurrencyWarned }。
   * concurrencyWarned：B 档并发安全提示是否已在本服务器（origin+username）提醒过 ——
   * 渲染层对每轮 summary.warnings 弹 toast，引擎据此不在后续轮次再携带该提示
   *（置位与落盘时机见 services 同步轮的步骤 3.5 与轮末收口处）。
   */
  noise: { fingerprintUnstable: boolean; noiseFiles: Record<string, number>; concurrencyWarned: boolean }
  warnings: string[]

  /** @param dirPath 状态存储目录 @param keyInfo { origin, username }（写回文件备查） */
  constructor(dirPath: string, keyInfo: { origin: string; username: string }) {
    this.dirPath = dirPath
    this.keyInfo = keyInfo
    this.capabilities = null
    this.noise = { fingerprintUnstable: false, noiseFiles: {}, concurrencyWarned: false }
    this.warnings = []
  }

  /**
   * 打开（或复用）一个服务器状态存储。
   * 与 DirStateStore.open 同款进程内缓存：同 origin+username 的多个同步目录
   * 共享同一内存实例，噪声计数天然跨目录累计。
   */
  static async open(origin: string, username: string): Promise<ServerStateStore> {
    const keyInfo = { origin: String(origin || ''), username: String(username || '') }
    const dirPath = serverStateDirPath(keyInfo.origin, keyInfo.username)
    const cached = openServerStores.get(dirPath)
    if (cached) return cached
    const store = new ServerStateStore(dirPath, keyInfo)
    await store._load()
    openServerStores.set(dirPath, store)
    return store
  }

  /** 加载两个状态文件：缺失 = 首次；损坏 / 版本不识别 = 按默认值继续并记 warning（探测可重做） */
  async _load(): Promise<void> {
    await fsp.mkdir(this.dirPath, { recursive: true }).catch(() => {})
    try {
      const parsed: any = JSON.parse(await fsp.readFile(path.join(this.dirPath, 'capabilities.json'), 'utf-8'))
      if (parsed && parsed.v === SERVER_STATE_V && parsed.caps && typeof parsed.caps === 'object' && typeof parsed.caps.probedAt === 'number') {
        this.capabilities = parsed.caps
      } else if (parsed) {
        this.warnings.push('capabilities.json 版本不识别：忽略缓存，待重新探测')
      }
    } catch (_) {
      /* 不存在或损坏：视为未探测 */
    }
    try {
      const parsed: any = JSON.parse(await fsp.readFile(path.join(this.dirPath, 'noise.json'), 'utf-8'))
      if (parsed && parsed.v === SERVER_STATE_V && typeof parsed === 'object') {
        this.noise = {
          fingerprintUnstable: !!parsed.fingerprintUnstable,
          noiseFiles: parsed.noiseFiles && typeof parsed.noiseFiles === 'object' ? parsed.noiseFiles : {},
          concurrencyWarned: !!parsed.concurrencyWarned,
        }
      } else if (parsed) {
        this.warnings.push('noise.json 版本不识别：噪声计数重新累计')
      }
    } catch (_) {
      /* 不存在或损坏：按默认值重新累计 */
    }
  }

  /**
   * 读取未过期的能力缓存；过期或缺失返回 null（调用方现场探测）。
   * @param ttlMs 缓存有效期（毫秒），缺省 7 天（能力探测的默认 TTL）
   */
  getCachedCapabilities(ttlMs: number = 7 * 24 * 3600 * 1000): any {
    if (!this.capabilities) return null
    if (Date.now() - this.capabilities.probedAt > ttlMs) return null
    return this.capabilities
  }

  /** 原子保存能力探测结果（probedAt 由探测方写入，作为 TTL 起点） */
  async saveCapabilities(caps: any): Promise<void> {
    this.capabilities = caps
    await atomicWriteJson(path.join(this.dirPath, 'capabilities.json'), {
      v: SERVER_STATE_V,
      ...this.keyInfo,
      caps,
    })
  }

  /** 该服务器（origin+username）是否已被标记为指纹不稳定（etag/mtime 变化不可信） */
  get fingerprintUnstable(): boolean {
    return !!this.noise.fingerprintUnstable
  }

  /** 噪声文件集合（测试与排障直读；业务写入走 note/reset） */
  get noiseFiles(): Record<string, number> {
    return this.noise.noiseFiles
  }

  /**
   * 记录一个出现「仅远端指纹变化、内容 hash 相同」的文件（distinct 计数、跨目录累计）。
   * 不同文件数达到 FINGERPRINT_NOISE_FILES（默认 3）才标记 unstable ——
   * 单个文件反复 touch（编辑器自动保存、索引器）不会误标。
   * @returns 是否为本次新打上的标记（调用方据此提示一次并落盘）
   */
  noteFingerprintNoise(rel: string): boolean {
    const files = this.noise.noiseFiles
    if (Object.keys(files).length >= MAX_UNSTABLE_HITS && files[rel] == null) return false
    files[rel] = 1
    if (!this.noise.fingerprintUnstable && Object.keys(files).length >= FINGERPRINT_NOISE_FILES) {
      this.noise.fingerprintUnstable = true
      return true
    }
    return false
  }

  /**
   * 把文件移出噪声集合（远端发生真实内容变化时）。
   * @returns 是否确实移除了条目（调用方据此决定是否需要落盘）
   */
  resetFingerprintNoise(rel: string): boolean {
    if (this.noise.noiseFiles[rel] == null) return false
    delete this.noise.noiseFiles[rel]
    return true
  }

  /** 原子保存噪声状态（引擎在标记发生变化后的轮末调用） */
  async saveNoise(): Promise<void> {
    await atomicWriteJson(path.join(this.dirPath, 'noise.json'), { v: SERVER_STATE_V, ...this.keyInfo, ...this.noise })
  }
}

/** 打开（或复用）目录基线存储（DirStateStore.open 的模块门面） */
function openDirStore(opts: { deviceId?: string; localPath: string; remotePath: string }): Promise<DirStateStore> {
  return DirStateStore.open(opts)
}

/** 打开（或复用）服务器粒度状态存储（ServerStateStore.open 的模块门面） */
function openServerState(origin: string, username: string): Promise<ServerStateStore> {
  return ServerStateStore.open(origin, username)
}

export {
  SCHEMA_V,
  COMPACT_LOG_LINES,
  storageRoot,
  setRootForTest,
  getDeviceId,
  // 目录 fsync 助手：POSIX 尽力而为，Windows 跳过（已知边界）；供 services 复用
  fsyncDirIfPossible,
  nfc,
  normalizeLocalKey,
  normalizeRemoteKey,
  // 凭据混淆（AES-256-GCM，同步；详见「凭据混淆」节注释——防随手窥视，非强加密）
  sealSecret,
  openSecret,
  baselineDirPath,
  // 通用键哈希：scheduler 的目录互斥锁键等复用
  hash16,
  // CRC 行编码 / 解码：manual-requests.jsonl 与基线日志同一 {v,n,c,o} 行格式
  encodeLine as encodeCrcLine,
  decodeLine as decodeCrcLine,
  openDirStore,
  closeAllStores,
  serverStateDirPath,
  openServerState,
}
/** 测试与审计直检入口（渲染层公共类型不含本对象） */
export const _internals = { encodeLine, decodeLine, replayLogText, DirStateStore, ServerStateStore, crc32, fsyncSpy }
