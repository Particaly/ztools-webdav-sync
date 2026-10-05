/* eslint-disable */
// WebDAV 同步插件 —— ZTools 插件注册表的跨设备对账（实验功能「无感同步」核心）
//
// 定位：解决「只同步实体目录，插件不出现在已安装列表」的缺口。宿主的已安装
// 列表读 LMDB 注册表文档 ZTOOLS/plugins（内部 API internal:db-get/db-put 可
// 读写，见宿主 src/main/api/renderer/plugins.ts 的 readInstalledPlugins），不
// 扫描 ~/.ztools/plugins 目录 —— 换机后实体回来了但没有注册记录。本模块把
// 注册表记录作为一份普通文件（manifest）随实体目录一起双向同步：
//   导出 —— 本机注册表 → manifest（绝对路径重定基为相对 pluginsDir，跨设备可还原）；
//   合并 —— manifest（他机投影）+ 本机实体扫描 → 注册表（补登记 / 孤儿采纳 /
//           幽灵清理），经内部 API 写回；未授权 / 旧宿主时整体跳过（降级为
//           纯实体同步，与历史行为一致）。
//
// 授权模型（宿主「高级权限」体系）：internal API 按通道细粒度授权
//（internal:db-get 等），插件经 ztools.requestInternalApiPermissions 主动申请、
// 用户在宿主设置页审批，授权数据每次 IPC 现读 —— 批准后实时生效无需重开插件。
// 本模块在每轮对账开头做权限闸：REQUIRED_INTERNAL_CHANNELS 齐备才动注册表，
// 缺失时自动提交申请（状态 pending，见 reconcileCore 步骤 1）。
//
// 设计约束（配套：README「ZTools 插件同步的边界」、design/host-api-requirements.md）：
//   - manifest 是注册表的**投影**不是权威：本机注册表对本机已有记录保持权威
//     （安装 / 升级 / 禁用状态由宿主自己写），manifest 只补「本机没有的名字」；
//     manifest 改写仅发生在「本轮注册表确有变化」或「盘上 manifest 缺失 / 损坏」
//     时 —— A 删 B 留（删除决策未落地）期间两侧按差异轮流改写会造成 manifest
//     无限对传，按变化驱动写可自然收敛。
//   - 实体存在性是登记门槛：manifest 记录只在实体已在本地落盘后才采纳；实体
//     缺位的记录连续两轮核验后才移除（容忍宿主升级瞬间实体缺位的竞态；即使
//     误移除，孤儿采纳也会从实体内 plugin.json 自愈）。
//   - manifest 兼容性只向前不向后：盘上 manifest 版本高于本插件认识的范围时
//     整体冻结 manifest 维护（不采纳不重写），避免旧版本插件把新格式降级覆盖。
//
// 本文件是叶子模块：仅依赖 node 内置 / host.mts / ztools-plugins.mts，
// vitest 直载源码与 esbuild 单文件产物双通道通用。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getHostPorts } from './host.mts'
import type { InternalPermissionPort, InternalRegistryPort } from './host.mts'
import { ztoolsPluginsDir } from './ztools-plugins.mts'
import type { InternalApiPermissionStatus, RegistryReconcileResult } from './types.mts'

/**
 * manifest 文件名（位于插件实体目录内，随目录同步双向流转）。不用点开头命名：
 * 同步引擎的 ignoreHidden 偏好会跳过隐藏文件，manifest 必须作为普通文件参与
 * 同步；宿主不扫描该目录内容，多一份普通文件无害。
 */
export const REGISTRY_MANIFEST_NAME = 'ztools-plugins.registry.json'

/** ZTOOLS 命名空间里插件注册表文档的键（宿主 readInstalledPlugins 同款） */
export const ZTOOLS_REGISTRY_KEY = 'plugins'

/** 本插件认识的 manifest 格式版本：更高版本冻结维护，更低 / 相等正常处理 */
export const MANIFEST_VERSION = 1

/** 本插件认识的对账所需 internal 通道清单：注册表读 / 写 + 列表刷新通知 ——
 *  主动申请时按此清单提交（最小授权；宿主只接受真实已注册的通道名） */
export const REQUIRED_INTERNAL_CHANNELS = [
  'internal:db-get',
  'internal:db-put',
  'internal:notify-plugins-changed',
] as const

/** 主动申请附带的用途说明（设置页「高级权限」审批界面展示，限 500 字） */
export const REGISTRY_PERMISSION_REQUEST_REASON =
  '同步完成后把从云端回来的插件登记进 ZTools 已安装列表：读取与更新插件注册表，并通知界面即时刷新'

/** 首写注册表前的备份保留份数（pluginData/registry-backups 下滚动清理） */
const BACKUP_KEEP = 5

/**
 * manifest 单条记录：注册表记录的**可同步投影**。刻意不含 path（绝对路径跨
 * 设备无意义，由 entity 相对路径 + 目标机 pluginsDir 重建）与 isDevelopment
 * （开发项目实体不在插件目录内，导出阶段即被过滤）。
 */
export interface RegistryManifestRecord {
  name: string
  /** 实体相对 pluginsDir 的路径（目录插件 = 目录名；asar 插件 = 版本化文件名；恒以 / 分隔） */
  entity: string
  title?: string
  version?: string
  description?: string
  author?: string
  homepage?: string
  main?: string
  preload?: string
  features?: unknown
  storageKind?: string
  sourceType?: string
  installedFrom?: string
  installedAt?: string
  /** logo 的重定基形态：相对 pluginsDir 的路径（如 `<entity>/icon.png`），或 data:/http(s):/file: 原样 */
  logo?: string
}

/** manifest 文件整体形状（固定键序 + 记录按 name 排序，保证跨设备字节稳定） */
export interface RegistryManifest {
  version: number
  records: RegistryManifestRecord[]
}

/**
 * 最近一次对账的模块级快照（渲染层虚拟行提示的数据源；进程重启归零，由下一轮
 * round-end / 手动对账重建）。
 */
let lastState: (RegistryReconcileResult & { at: number }) | null = null

/**
 * 幽灵记录的「首次发现实体缺位」标记（插件名 → true）：连续两轮对账都缺实体
 * 才从注册表移除，第一轮只标记 —— 宿主安装 / 升级流程里实体有亚秒级的替换
 * 窗口，单轮缺位就删会把正在升级的插件误登记成幽灵。进程内状态：重启后重新
 * 数两轮，最坏后果是幽灵清理延后，不产生错误登记。
 */
const ghostMarks = new Set<string>()

// ---------- 纯函数：路径 / 记录形态 ----------

/**
 * 计算路径相对 pluginsDir 的投影；不在 pluginsDir 之内返回 null。
 * @param pluginsDir 插件实体目录绝对路径
 * @param p 待判定的绝对路径
 * @returns 以 / 分隔的相对路径；p 恰为 pluginsDir 本身、越界或无法相对化时为 null
 */
function relInside(pluginsDir: string, p: string): string | null {
  let rel: string
  try {
    rel = path.relative(pluginsDir, p)
  } catch {
    return null
  }
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

/**
 * 注册表记录是否指向 pluginsDir 内的实体。开发项目 / 内置插件的 path 在目录
 * 外 —— 导出、清理都跳过（生命周期归宿主开发流程管，不归同步）。
 */
function isEntityRecord(record: any, pluginsDir: string): boolean {
  return !!record && typeof record.path === 'string' && relInside(pluginsDir, record.path) !== null
}

/**
 * 导出方向重定基 logo：宿主安装时把 logo 写成指向本机实体目录的绝对 file://
 * URL（读取侧 normalizeIconPath 对 file:// 原样放行），跨设备必须还原为相对
 * pluginsDir 的路径。data:/http(s) 与目录外的 file:// 原样保留 —— 重定基失败
 * 比伪装成功更安全（宁可图标缺失，不可指向他机路径）。
 * @param logo 注册表记录的 logo 字段（通常为 file:// URL）
 * @param pluginsDir 插件实体目录绝对路径
 * @returns 可跨设备携带的 logo 形态（相对路径或原样透传）
 */
function rebaseLogoOut(logo: unknown, pluginsDir: string): string {
  const s = typeof logo === 'string' ? logo : ''
  if (!s) return ''
  if (s.startsWith('data:') || s.startsWith('http://') || s.startsWith('https://')) return s
  if (s.startsWith('file://')) {
    try {
      const rel = relInside(pluginsDir, fileURLToPath(s))
      if (rel) return rel
    } catch {
      /* 非本地路径形态，原样保留 */
    }
  }
  return s
}

/**
 * 导入方向重建 logo：相对形态按**本机** pluginsDir 重建为 file:// URL（宿主
 * getAllPlugins 对 file:// 不再加工，必须落库前就指向本机路径）；data:/http(s)/
 * file: 原样。
 * @param logo manifest 记录的 logo 字段
 * @param pluginsDir 本机插件实体目录绝对路径
 * @returns 落库用的 logo 字段值
 */
function rebaseLogoIn(logo: unknown, pluginsDir: string): string {
  const s = typeof logo === 'string' ? logo : ''
  if (!s) return ''
  if (s.startsWith('data:') || s.startsWith('http://') || s.startsWith('https://') || s.startsWith('file://')) return s
  return pathToFileURL(path.join(pluginsDir, s)).href
}

/**
 * 注册表记录 → manifest 记录（导出投影）：白名单字段按固定键序拷贝（undefined
 * 跳过，保证序列化字节稳定），绝对 path 换成 entity 相对路径，logo 重定基。
 * @param record 注册表原始记录（宿主 buildPluginInfo 形态）
 * @param pluginsDir 插件实体目录绝对路径
 * @returns manifest 记录；path 不在 pluginsDir 内（开发项目 / 内置插件 / 脏数据）返回 null
 */
export function registryRecordToManifest(record: any, pluginsDir: string): RegistryManifestRecord | null {
  if (!record || typeof record.name !== 'string' || !record.name) return null
  const entity = isEntityRecord(record, pluginsDir) ? relInside(pluginsDir, record.path) : null
  if (entity === null) return null
  const m: RegistryManifestRecord = { name: record.name, entity }
  const rest: Array<[keyof RegistryManifestRecord, unknown]> = [
    ['title', record.title],
    ['version', record.version],
    ['description', record.description],
    ['author', record.author],
    ['homepage', record.homepage],
    ['main', record.main],
    ['preload', record.preload],
    ['features', record.features],
    ['storageKind', record.storageKind],
    ['sourceType', record.sourceType],
    ['installedFrom', record.installedFrom],
    ['installedAt', record.installedAt],
  ]
  for (const [k, v] of rest) {
    if (v !== undefined) (m as any)[k] = v
  }
  const logo = rebaseLogoOut(record.logo, pluginsDir)
  if (logo) m.logo = logo
  return m
}

/**
 * manifest 记录 → 注册表记录（导入还原）：entity 相对路径按**本机** pluginsDir
 * 重建绝对 path，logo 重建为本机 file:// URL，其余字段原样 —— 字段集与宿主
 * buildPluginInfo 的产出对齐，使登记后的记录与原生安装记录同构。
 * @param m manifest 记录
 * @param pluginsDir 本机插件实体目录绝对路径
 * @returns 可写入注册表的完整记录
 */
export function manifestRecordToRegistry(m: RegistryManifestRecord, pluginsDir: string): any {
  const out: any = {
    name: m.name,
    path: path.join(pluginsDir, ...m.entity.split('/')),
  }
  const keys: Array<keyof RegistryManifestRecord> = [
    'title',
    'version',
    'description',
    'author',
    'homepage',
    'main',
    'preload',
    'features',
    'storageKind',
    'sourceType',
    'installedFrom',
    'installedAt',
  ]
  for (const k of keys) {
    if ((m as any)[k] !== undefined) out[k] = (m as any)[k]
  }
  out.logo = rebaseLogoIn(m.logo, pluginsDir)
  return out
}

/**
 * 导出本机注册表的可同步投影：仅收 path 在 pluginsDir 内**且实体当前存在**的
 * 记录（幽灵记录不外传 —— 他机不该登记一个源头已不存在的插件），按 name 排序。
 * 纯数据函数，实体存在性经 existsFn 注入。
 * @param records 本机注册表记录数组
 * @param pluginsDir 插件实体目录绝对路径
 * @param existsFn 实体存在性判定（缺省 fs.statSync）
 * @returns manifest 对象；无任何可同步记录时 records 为空数组
 */
export function buildManifest(
  records: any[],
  pluginsDir: string,
  existsFn: (p: string) => boolean = defaultExists
): RegistryManifest {
  const out: RegistryManifestRecord[] = []
  for (const record of records || []) {
    if (!isEntityRecord(record, pluginsDir)) continue
    if (!existsFn(record.path)) continue
    const m = registryRecordToManifest(record, pluginsDir)
    if (m) out.push(m)
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { version: MANIFEST_VERSION, records: out }
}

/**
 * manifest 的稳定序列化（无缩进紧凑 JSON）：「本轮导出是否等于盘上内容」的
 * 比对与跨设备字节稳定都依赖它 —— 只吃 buildManifest 的产出，键序由构造顺序保证。
 * @param m manifest 对象
 * @returns 稳定的 JSON 文本
 */
export function serializeManifest(m: RegistryManifest): string {
  return JSON.stringify(m)
}

/**
 * 解析盘上的 manifest 文本：结构不合法（非对象 / version 低于当前 / records 非
 * 数组 / 记录缺 name 或 entity）返回 null，由调用方按「可重写」处理；单条坏记录
 * 跳过（尽力采纳），不整体作废。version 高于本插件认识范围时也返回 null ——
 * 调用方须先经 manifestVersionOnDisk 判定，冻结维护而非降级覆盖。
 * @param text manifest 文件内容（存在时）
 * @returns manifest 对象；整体不合法或版本过新返回 null
 */
export function parseManifest(text: string): RegistryManifest | null {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || typeof raw.version !== 'number' || !Array.isArray(raw.records)) return null
  if (raw.version > MANIFEST_VERSION || raw.version < 1) return null
  const records: RegistryManifestRecord[] = []
  for (const r of raw.records) {
    if (r && typeof r.name === 'string' && r.name && typeof r.entity === 'string' && r.entity) {
      records.push(r as RegistryManifestRecord)
    }
  }
  return { version: MANIFEST_VERSION, records }
}

/**
 * 读取盘上 manifest 的格式版本（只窥版本号，不做结构校验）：用于「新版本
 * manifest 由新插件写入、旧插件不得降级覆盖」的保护判定。
 * @param text manifest 文件内容（缺文件时为 null）
 * @returns 版本号；无法解析出版本返回 null
 */
export function manifestVersionOnDisk(text: string | null): number | null {
  if (text == null) return null
  try {
    const raw = JSON.parse(text)
    return typeof raw?.version === 'number' ? raw.version : null
  } catch {
    return null
  }
}

// ---------- 纯函数：合并与孤儿扫描 ----------

/**
 * 合并 manifest 到本机注册表（产出下一版注册表，不落库）：
 *   采纳 —— manifest 里本机没有的记录，实体已在本机落盘的才登记（实体是门槛：
 *   下载未完成 / 删除决策未落地的记录，等实体到位后的下一轮再采纳）；
 *   清理 —— dropNames 里的本机记录移除（两轮幽灵核验由调用方完成，本函数只执行）。
 * 本机已有记录一律原样保留：安装 / 升级 / 禁用状态由宿主写入，manifest 不得回写覆盖。
 * @param local 本机注册表记录数组（不修改）
 * @param manifest 待合并的 manifest（null = 云端尚无 manifest，只做清理）
 * @param pluginsDir 本机插件实体目录绝对路径
 * @param existsFn 实体存在性判定
 * @param dropNames 经两轮核验确认要移除的本机插件名（空集 = 不清理）
 * @returns next 下一版注册表；added 本轮新登记的插件名；removed 本轮移除的插件名
 */
export function mergeRegistryWithManifest(
  local: any[],
  manifest: RegistryManifest | null,
  pluginsDir: string,
  existsFn: (p: string) => boolean,
  dropNames: ReadonlySet<string>
): { next: any[]; added: string[]; removed: string[] } {
  const next: any[] = []
  const added: string[] = []
  const removed: string[] = []
  const names = new Set<string>()
  for (const record of local || []) {
    const name = typeof record?.name === 'string' ? record.name : ''
    if (name && dropNames.has(name) && isEntityRecord(record, pluginsDir)) {
      removed.push(name)
      continue
    }
    if (name) names.add(name)
    next.push(record)
  }
  for (const m of manifest?.records || []) {
    if (!m || !m.name || names.has(m.name)) continue
    const entityPath = path.join(pluginsDir, ...m.entity.split('/'))
    if (!existsFn(entityPath)) continue
    next.push(manifestRecordToRegistry(m, pluginsDir))
    names.add(m.name)
    added.push(m.name)
  }
  return { next, added, removed }
}

/**
 * 孤儿实体扫描：pluginsDir 顶层「有 plugin.json 但不在注册表里」的实体（目录
 * 插件与 *.asar 文件，点开头条目与 manifest 自身跳过）。覆盖两类来源：本功能
 * 启用前的历史同步孤儿，与「他机用户选择保留、实体经同步恢复但注册记录已不在
 * manifest 中」的实体。asar 内 plugin.json 的读取依赖 Electron 对 fs 的 asar
 * 补丁（preload 内生效）；纯 node / 读取失败一律跳过该实体（不登记半截记录）。
 * @param pluginsDir 插件实体目录绝对路径
 * @param knownNames 已登记的插件名集合（命中即跳过）
 * @param readJsonSafe JSON 文件读取（缺省 fs.readFileSync + JSON.parse）
 * @param listEntries 顶层条目列举（缺省 fs.readdirSync withFileTypes；测试注入）
 * @returns 可采纳的孤儿实体列表（plugin.json 解析结果 + 实体绝对路径 / 形态）
 */
export function scanOrphanEntities(
  pluginsDir: string,
  knownNames: ReadonlySet<string>,
  readJsonSafe: (p: string) => any = readJsonFileSafe,
  listEntries: (p: string) => fs.Dirent[] = (p) => fs.readdirSync(p, { withFileTypes: true })
): Array<{ config: any; entityPath: string; asar: boolean }> {
  let entries: fs.Dirent[]
  try {
    entries = listEntries(pluginsDir)
  } catch {
    return []
  }
  const out: Array<{ config: any; entityPath: string; asar: boolean }> = []
  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith('.')) continue
    if (entry.name === REGISTRY_MANIFEST_NAME) continue
    const asar = entry.isFile() && entry.name.toLowerCase().endsWith('.asar')
    const isDir = entry.isDirectory()
    if (!asar && !isDir) continue
    const entityPath = path.join(pluginsDir, entry.name)
    const config = readJsonSafe(path.join(entityPath, 'plugin.json'))
    if (!config || typeof config !== 'object') continue
    if (typeof config.name !== 'string' || !config.name) continue
    if (knownNames.has(config.name)) continue
    out.push({ config, entityPath, asar })
  }
  return out
}

/**
 * 孤儿实体 → 注册表记录（最小合法形态）：字段直接来自实体内 plugin.json，
 * installedFrom 标记 'unknown'（原生安装会写 npm / market / import 等，孤儿只
 * 可能来自同步或手工放置），storageKind 按实体形态判定，logo 按宿主安装时的
 * 组装规则重建（相对声明 → 指向实体目录内图标的 file:// URL）。
 * @param orphan scanOrphanEntities 的单个产出
 * @returns 可写入注册表的记录
 */
export function orphanEntityToRegistry(orphan: { config: any; entityPath: string; asar: boolean }): any {
  const config = orphan.config
  const logoDeclared = typeof config.logo === 'string' ? config.logo : ''
  const logo =
    logoDeclared && !logoDeclared.startsWith('data:') && !logoDeclared.startsWith('http://') && !logoDeclared.startsWith('https://')
      ? pathToFileURL(path.join(orphan.entityPath, logoDeclared)).href
      : logoDeclared
  return {
    name: config.name,
    title: config.title,
    version: config.version,
    description: typeof config.description === 'string' ? config.description : '',
    author: typeof config.author === 'string' ? config.author : '',
    homepage: typeof config.homepage === 'string' ? config.homepage : '',
    main: config.main,
    preload: config.preload,
    features: config.features,
    path: orphan.entityPath,
    storageKind: orphan.asar ? 'asar' : 'directory',
    sourceType: config.sourceType === 'closed_source' ? 'closed_source' : 'open_source',
    isDevelopment: false,
    installedFrom: 'unknown',
    installedAt: new Date().toISOString(),
    logo,
  }
}

/**
 * 宽松 JSON 文件读取：任何失败（不存在 / 权限 / 解析错误）返回 null。
 * @param p JSON 文件绝对路径
 * @returns 解析结果；不可读或不合法返回 null
 */
function readJsonFileSafe(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * 缺省实体存在性判定（statSync 包装；任何异常按不存在处理）。
 * @param p 实体路径
 * @returns 是否存在
 */
function defaultExists(p: string): boolean {
  try {
    return fs.statSync(p) != null
  } catch {
    return false
  }
}

/**
 * 宽松读取自身高级 API 授权状态：宿主查询失败 / 返回非对象一律按 null 处理，
 * 由调用方退回「直接调用 internal 并按拒绝降级」的旧宿主探测路径。
 * @param port 权限申请通道端口
 * @returns 授权状态；不可得返回 null
 */
async function readPermissionStatus(port: InternalPermissionPort): Promise<InternalApiPermissionStatus | null> {
  try {
    const status = await port.getStatus()
    return status && typeof status === 'object' ? status : null
  } catch {
    return null
  }
}

// ---------- 对账编排（core 与默认接线分离，测试注入 deps） ----------

/** 对账依赖：core 只经此接触世界（内部 API 端口 / 文件系统 / 备份），测试全注入 */
export interface RegistryReconcileDeps {
  /** 内部 API 端口；null = 宿主未注入 internal 命名空间（旧宿主），整体跳过 */
  internal: InternalRegistryPort | null
  /**
   * 高级 API 权限申请通道（查询自身状态 + 提交申请）；缺省 null = 旧宿主，
   * 退回「直接调用 internal 并按拒绝降级（denied）」的探测路径
   */
  permissions?: InternalPermissionPort | null
  /** 实体存在性判定（缺省 fs.statSync 包装） */
  exists?(p: string): boolean
  /** 读 manifest 原文；不存在返回 null（缺省读 pluginsDir 下 REGISTRY_MANIFEST_NAME） */
  readManifestText?(pluginsDir: string): string | null
  /** 写 manifest（调用方保证目录存在；缺省直接覆盖写） */
  writeManifestText?(pluginsDir: string, text: string): void
  /** 读实体内 plugin.json（运行时含 asar 补丁路径；缺省宽松 JSON 读取） */
  readJsonSafe?(p: string): any
  /** 列出 pluginsDir 顶层条目（缺省 fs.readdirSync withFileTypes；测试注入） */
  listEntries?(pluginsDir: string): fs.Dirent[]
  /** 首次写注册表前的备份钩子（入参为写回前的旧记录数组）；缺省 no-op */
  backup?(records: any[]): void
}

/**
 * 对账核心：读注册表 → 读 manifest → 合并（采纳 + 两轮幽灵核验）→ 孤儿采纳 →
 * 必要时备份并写回注册表 + 通知宿主刷新 → 必要时重写 manifest。任何一步失败
 * 都收敛为 error 结果，不抛出（调度器轮末 fire-and-forget 调用）。
 *
 * 幽灵核验推进：实体缺位的本机记录首轮标记（ghostMarks）、下一轮仍缺位才移除；
 * 期间实体回归即撤销标记。manifest 版本高于本插件认识范围时冻结 manifest 维护
 * （不采纳不重写 —— 不让旧版本插件降级覆盖新格式），注册表合并与孤儿采纳照常。
 *
 * @param pluginsDir 本机插件实体目录绝对路径
 * @param deps 对账依赖（测试注入；生产经 reconcilePluginRegistry 的默认接线）
 * @returns 对账结果（status / adopted / removed / wroteManifest / error）
 */
export async function reconcileCore(pluginsDir: string, deps: RegistryReconcileDeps): Promise<RegistryReconcileResult> {
  const result: RegistryReconcileResult = { status: 'noop', adopted: [], removed: [], wroteManifest: false }
  if (!deps.internal) {
    result.status = 'unavailable'
    lastState = { ...result, at: Date.now() }
    return result
  }
  const exists = deps.exists || defaultExists
  try {
    // 1. 高级 API 权限闸（宿主支持「按通道授权 + 主动申请」体系时）：所需通道
    //    全部齐备才动注册表；缺失时主动提交申请（宿主对同插件申请做通道并集，
    //    用户在设置页「高级权限」批准后**实时生效**，下一轮对账自动通过）。
    //    仅当「缺失通道未被已有待审申请覆盖」时才提交 —— 覆盖中的重复提交只会
    //    刷新时间戳与刷日志；被驳回（pending 不再覆盖缺失集）后重新提交，让申请
    //    重新出现在审批队列。permissions 缺失（旧宿主）时跳过本闸，由步骤 2 的
    //    直接调用兜底探测。
    const permPort = deps.permissions ?? null
    const perm = permPort ? await readPermissionStatus(permPort) : null
    if (permPort && perm && !perm.fullAccess) {
      const granted = Array.isArray(perm.granted) ? perm.granted : []
      const pendingList = Array.isArray(perm.pending) ? perm.pending : []
      const missing = REQUIRED_INTERNAL_CHANNELS.filter((c) => !granted.includes(c))
      if (missing.length > 0) {
        result.requested = missing
        if (missing.every((c) => pendingList.includes(c))) {
          // 申请已在审批队列中：本轮不动注册表，等批准后的下一轮
          result.status = 'pending'
          lastState = { ...result, at: Date.now() }
          return result
        }
        const submitted = await permPort.request(missing, REGISTRY_PERMISSION_REQUEST_REASON).catch(() => null)
        if (!submitted || submitted.success !== true || submitted.status !== 'granted') {
          result.status = 'pending'
          if (submitted && submitted.success === false) result.error = submitted.error
          lastState = { ...result, at: Date.now() }
          return result
        }
        // request 返回 granted（提交瞬间已齐备 / 宿主兜底判定）：落闸继续对账
      }
    }

    // 2. 读本机注册表：未授权（宿主 PermissionDenied）或任何失败都按降级处理
    //    —— 绝不把「读不到」当成「空注册表」操作
    let local: any[]
    try {
      const got = await deps.internal.dbGet(ZTOOLS_REGISTRY_KEY)
      local = Array.isArray(got) ? got : []
    } catch (e: any) {
      result.status = 'denied'
      result.error = e && e.message ? e.message : String(e)
      lastState = { ...result, at: Date.now() }
      return result
    }

    // 3. 读 manifest（云端投影）：缺失 / 损坏都按 null 处理，允许本轮重写
    const text = deps.readManifestText ? deps.readManifestText(pluginsDir) : readManifestFile(pluginsDir)
    const diskVersion = manifestVersionOnDisk(text ?? null)
    const foreignVersion = diskVersion != null && diskVersion > MANIFEST_VERSION
    const manifest = foreignVersion ? null : text != null ? parseManifest(text) : null

    // 4. 合并：manifest 采纳 + 幽灵核验（上轮标记、本轮仍缺位的才移除）
    const dropNames = new Set<string>()
    for (const record of local) {
      if (!isEntityRecord(record, pluginsDir)) continue
      const name = typeof record.name === 'string' ? record.name : ''
      if (!name) continue
      if (exists(record.path)) {
        ghostMarks.delete(name)
        continue
      }
      if (ghostMarks.has(name)) dropNames.add(name)
      else ghostMarks.add(name)
    }
    const merged = mergeRegistryWithManifest(local, manifest, pluginsDir, exists, dropNames)
    for (const name of dropNames) ghostMarks.delete(name)
    result.removed = merged.removed

    // 5. 孤儿采纳：实体在、注册表与 manifest 都没有的，从实体内 plugin.json 登记
    const knownNames = new Set<string>(merged.next.map((r: any) => r?.name).filter(Boolean))
    const readJsonSafe = deps.readJsonSafe || readJsonFileSafe
    for (const orphan of scanOrphanEntities(pluginsDir, knownNames, readJsonSafe, deps.listEntries)) {
      merged.next.push(orphanEntityToRegistry(orphan))
      knownNames.add(orphan.config.name)
      merged.added.push(orphan.config.name)
    }
    result.adopted = merged.added

    // 6. 注册表有变化：备份 → 写回 → 通知宿主刷新。通知 API 是宿主需求清单新增
    //    项（internal:notify-plugins-changed），缺失 / 失败静默跳过 —— 登记仍
    //    生效，列表延迟到宿主下一次触发或重启才刷新
    const changed = merged.added.length > 0 || merged.removed.length > 0
    if (changed) {
      try {
        deps.backup?.(local)
      } catch {
        /* 备份失败不阻断登记 */
      }
      await deps.internal.dbPut(ZTOOLS_REGISTRY_KEY, merged.next)
      await deps.internal.notifyChanged()
    }

    // 7. manifest 维护：仅在本轮注册表有变化，或盘上 manifest 缺失 / 损坏时重写
    //    （变化驱动写 —— 决策窗口期两侧按差异轮流改写会无限对传，见文件头约束）；
    //    盘上是更高版本格式（foreignVersion）时冻结，绝不降级覆盖。重写内容 =
    //    本机注册表投影 + 盘上「实体尚未落盘」的在途记录（实体没到 → 没采纳，
    //    但记录是他机的真实意图，重写时保留，等实体到位后的下一轮自然采纳）。
    //    孤儿采纳虽然不动本机已有记录，但改变了注册表整体，同样算 changed。
    if (!foreignVersion) {
      const canonical = buildManifest(merged.next, pluginsDir, exists)
      if (manifest) {
        const canonicalNames = new Set(canonical.records.map((r) => r.name))
        for (const mr of manifest.records) {
          if (!mr.name || canonicalNames.has(mr.name)) continue
          if (exists(path.join(pluginsDir, ...mr.entity.split('/')))) continue
          canonical.records.push(mr)
        }
        canonical.records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      }
      const canonicalText = serializeManifest(canonical)
      const needsRewrite = (changed || text == null || manifest == null) && canonicalText !== (text ?? null)
      if (needsRewrite) {
        deps.writeManifestText ? deps.writeManifestText(pluginsDir, canonicalText) : writeManifestFile(pluginsDir, canonicalText)
        result.wroteManifest = true
      }
    }
    result.status = changed || result.wroteManifest ? 'ok' : 'noop'
    lastState = { ...result, at: Date.now() }
    return result
  } catch (e: any) {
    result.status = 'error'
    result.error = e && e.message ? e.message : String(e)
    lastState = { ...result, at: Date.now() }
    return result
  }
}

// ---------- 默认接线（生产路径）：真实 fs + 内部 API 端口 + 备份 + 串行化 ----------

/**
 * 读 manifest 文件（默认实现）：不存在 / 读取失败返回 null（与「缺失」同语义，
 * 允许本轮重写）。
 * @param pluginsDir 插件实体目录绝对路径
 * @returns manifest 文件内容；不可读返回 null
 */
function readManifestFile(pluginsDir: string): string | null {
  try {
    return fs.readFileSync(path.join(pluginsDir, REGISTRY_MANIFEST_NAME), 'utf-8')
  } catch {
    return null
  }
}

/**
 * 写 manifest 文件（默认实现）：目录必须已存在（slot 只在插件目录 available 时
 * 合成）。写入失败向上抛 → 对账结果 error（注册表已写回、manifest 下一轮变化
 * 时再补 —— 见 reconcileCore 步骤 6 的变化驱动写）。
 * @param pluginsDir 插件实体目录绝对路径
 * @param text 稳定序列化的 manifest 内容
 */
function writeManifestFile(pluginsDir: string, text: string): void {
  fs.writeFileSync(path.join(pluginsDir, REGISTRY_MANIFEST_NAME), text, 'utf-8')
}

/**
 * 备份钩子的默认实现：写回前的旧注册表整体 JSON 落 pluginData/registry-backups，
 * 滚动保留 BACKUP_KEEP 份 —— 注册表是宿主管理面的单一事实源，插件侧 bug 写坏
 * 的后果要有兜底。storageRoot 不可得（无头 / 端口缺失）时为 no-op。
 * @param storageRoot 插件数据根（宿主 getPath('pluginData')；null = 无处可备）
 * @param records 写回前的旧注册表记录
 */
function defaultBackup(storageRoot: string | null, records: any[]): void {
  if (!storageRoot || !Array.isArray(records)) return
  try {
    const dir = path.join(storageRoot, 'registry-backups')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `plugins-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), records }), 'utf-8')
    const old = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('plugins-') && f.endsWith('.json'))
      .sort()
    for (const f of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) {
      try {
        fs.unlinkSync(path.join(dir, f))
      } catch {
        /* 并发清理竞争忽略 */
      }
    }
  } catch {
    /* 备份是尽力而为：失败不阻断登记 */
  }
}

/**
 * 对账进行中标记与「期间又触发了一次」的挂起标记：对账含 IO 与 IPC，串行化防
 * 并发写 manifest / 注册表；挂起标记保证触发不丢（进行中的一轮结束后补跑一次）。
 */
let inFlight: Promise<RegistryReconcileResult> | null = null
let pendingAgain = false

/**
 * 生产路径的对账入口（调度器轮末 / services 手动触发共用）：deps 取默认接线
 * （内部 API 端口 + 真实 fs + pluginData 备份），整体串行化 —— 进行中重复触发
 * 只登记一次补跑。pluginsDir 缺省经 ztools-plugins.mts 的发现逻辑现取（与
 * 调度器合成的 slot 同一目录）。
 * @param pluginsDir 本机插件实体目录绝对路径（缺省自动发现）
 * @returns 对账结果；进行中重复触发时返回进行中那次的同一 Promise
 */
export async function reconcilePluginRegistry(pluginsDir?: string): Promise<RegistryReconcileResult> {
  const dir = pluginsDir || ztoolsPluginsDir()
  if (inFlight) {
    pendingAgain = true
    return inFlight
  }
  inFlight = (async (): Promise<RegistryReconcileResult> => {
    const ports = getHostPorts()
    const backupRoot = ports.storageRoot()
    return reconcileCore(dir, {
      internal: ports.internal,
      permissions: ports.permissions,
      backup: (records) => defaultBackup(backupRoot, records),
    })
  })()
  try {
    return await inFlight
  } finally {
    inFlight = null
    if (pendingAgain) {
      pendingAgain = false
      void reconcilePluginRegistry(dir)
    }
  }
}

/**
 * 最近一次对账状态（渲染层虚拟行提示的数据源；null = 本会话尚未对账过）。
 * @returns 最近一次结果快照（含 at 时间戳）或 null
 */
export function getRegistryReconcileState(): (RegistryReconcileResult & { at: number }) | null {
  return lastState
}

/**
 * 清空模块内状态（测试隔离用：ghostMarks / lastState / 挂起标记归零）。
 * 不在 services 公共门面暴露。
 */
export function __resetRegistryStateForTest(): void {
  ghostMarks.clear()
  lastState = null
  pendingAgain = false
}
