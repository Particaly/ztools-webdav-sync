/* eslint-disable */
// svc/dav.mts —— WebDAV 客户端与服务器能力探测：
//   目录列举（listRemoteSafe / listDirs：Depth:infinity 与逐目录两形态 + 子集合
//   etag 跳过）、mkdirDeep、单条目属性查询（remotePropsEx）、写前查重与上传后
//   批量校验共用的 propfindChildMap、B 档紧邻复查（recheckRemoteUnchanged）、
//   能力探测与档位判定（probeCapabilities：A 条件保护 / B 复查 / C 只读，缓存
//   分层与探测序列见探测段注释）。
import * as storage from '../store.mts'
import type { DavCapabilities } from '../types.mts'
import { REMOTE_FP_TOL_MS, maybeYield, nfc, type EngineCfg, type RemoteItem } from './base.mts'
import { joinRemote, parseMultistatus, relFromHref, remoteUrl, stripRemoteSlashes } from './dav-parse.mts'
import { isExcludedRel, isHiddenRel, isJunkRel, isSyncTempRel } from './excludes.mts'
import { REDIRECT_STATUS, davRequest, mkOpError, requestWithRetry, resolveNetOpts } from './net.mts'
import { remoteChangedMsg, remoteUnverifiableMsg } from './planning.mts'


/** 递归创建远端目录（逐级 MKCOL，405 视为已存在）。失败时抛错带 status（探测按其分类权限性失败） */
export async function mkdirDeep(cfg: EngineCfg, remotePath: string): Promise<void> {
  const segs = stripRemoteSlashes(remotePath).split('/').filter(Boolean)
  let cur = ''
  for (const seg of segs) {
    cur += '/' + seg
    const r = await davRequest(cfg, 'MKCOL', cur)
    if (r.status !== 201 && r.status !== 405 && r.status !== 301) {
      const err: any = new Error(`无法在云端创建文件夹「${cur}」，请检查账号是否有写入权限`)
      err.status = r.status
      err.detail = `MKCOL HTTP ${r.status}`
      throw err
    }
  }
}

/**
 * 远端条目入表（逐目录与 Depth:infinity 两种扫描形态共用的排除链）。
 * 排除次序与语义和旧逐目录实现逐行一致：探测残留旁路登记（仅同步根第一层）→
 * 引擎临时前缀 → 内置垃圾 → 用户排除规则 → ignoreHidden。目录与文件分别入表
 *（目录条目 isDir:true，规划层跳过其传输决策）。
 * @returns {boolean} true = 条目已入表（目录也由本函数入表，是否递归列举由调用方决定）
 */
function acceptRemoteItem(files: Map<string, any>, probeResidue: Array<{ rel: string; mtimeMs: number }>, rel: string, item: RemoteItem, isRootLevel: boolean, ignoreHidden: boolean, excludeMatcher: ((rel: string) => boolean) | null): boolean {
  if (item.isDir) {
    // 同步根第一层的探测目录：旁路登记给 syncDirectory 的残留清理；
    // 只登记不排除例外 —— 登记完仍走下方排除链，不进 files、不参与同步
    if (isRootLevel && rel.startsWith(PROBE_PREFIX)) probeResidue.push({ rel, mtimeMs: item.mtime })
    if (isSyncTempRel(rel)) return false
    if (isJunkRel(rel)) return false
    if (excludeMatcher && excludeMatcher(rel)) return false
    if (ignoreHidden && isHiddenRel(rel)) return false
    files.set(rel, { isDir: true, size: 0, mtimeMs: item.mtime, etag: item.etag })
    return true
  }
  // 文件分支：完整五步排除链（含 SYNC_SKIP_NAMES），与本地扫描同规则（见 isExcludedRel）
  if (isExcludedRel(rel, { ignoreHidden, excludeMatcher })) return false
  files.set(rel, { isDir: false, size: item.size, mtimeMs: item.mtime, etag: item.etag })
  return true
}

/**
 * 深度列举远端目录（完整性感知版）。
 * 返回 { files: Map(rel -> {size, mtimeMs, etag, isDir}), complete: boolean, errors: [{rel, message}],
 *         probeResidue: [{rel, mtimeMs}], depth: 'infinity' | 'per-dir',
 *         collections: Map(NFC rel -> {e, m}), skippedDirs: [NFC rel] }（后两项见「子集合 etag 跳过」）。
 *
 * 与本地扫描对齐的安全性要求：
 *   - 根目录 / 子目录 PROPFIND 404 一律记为「无法确认」而不是「远端已删除」：
 *     子树缺失可能来自权限、瞬时故障或挂载前缀变化，绝不能触发删除传播。
 *     同口径覆盖「207 + 根条目 404 propstat」形态（部分网关对缺失路径不回
 *     HTTP 404 状态）：集合自身条目携带 404 propstat 时同样上报根缺失。
 *   - 非 207 响应同样记为扫描错误。complete === false 时调用方必须禁止本轮删除。
 *   - 同步系统自身文件（SYNC_SKIP_NAMES）与引擎临时文件在 ignoreHidden
 *     判定之前一律排除：它们不是用户业务文件，ignoreHidden=false 时同样不可进入候选集合。
 *   - 内置垃圾规则（isJunkRel）与用户排除规则（excludeMatcher）同样先于
 *     ignoreHidden 判定：垃圾文件不是业务文件；用户规则是显式意图，与隐藏开关无关。
 * probeResidue 为旁路登记（不进 files）：同步根第一层的 `.wdsync-probe-` 探测目录
 *（能力探测的崩溃残留，见 runCapabilityProbe）。登记复用本次扫描结果，专供
 * syncDirectory 扫描后的残留清理使用，不产生额外请求；探测目录本身仍被排除，
 * 绝不进入同步候选集合。
 * 扫描形态：
 *   - opts.depthInfinity 为 true（能力探测结论支持）时先对同步根发一次
 *     Depth:infinity PROPFIND —— 整棵树一个请求拿全（数万文件 / 数百目录的
 *     逐目录扫描要发 N+1 个请求，infinity 服务器上单请求快一个量级）；
 *   - 非 207 状态（能力缓存过期 / 服务器行为变化）或 multistatus 解析失败一律
 *     **回落逐目录模式**重扫（不用残缺结果；逐目录模式自己会给出完整性结论）。
 *     网络层异常不回落 —— 它已被网络层重试 3 次，回落只会对同一故障再发一串
 *     请求、成倍计入整轮熔断；
 *   - 「207 但只回第一层」的浅响应在扫描层无法识别（长得和合法的全平树一样），
 *     由 runSyncRound 的基线嵌套条目阀门兜底（见该处注释）；
 *   - depth 字段标记实际使用的形态，供调用方区分（阀门只对单请求形态生效）。
 *
 * 子集合 etag 跳过（仅逐目录形态）：
 *   - opts.collectionEtasg（上一轮完整扫描落盘的集合 etag 表，NFC rel 键；
 *     null / 缺省 = 不跳过，行为与既有完全一致）。BFS 在子目录入队处判定：
 *     该子条目 etag 非空且与缓存一致 → 不入队（省一次 PROPFIND），记入
 *     skippedDirs；否则照旧入队。根目录永不跳过（队首必然列举）。etag 缺失 /
 *     为空的服务器自然永不跳过（无须特判 —— 空串与任何缓存值都不相等）。
 *   - 正确性契约：跳过的前提是服务器能力 etagPropagation 已被探测验证
 *    （深层修改会传播到所有祖先集合的 etag），因此「子集合 etag 未变 ⇒ 子树
 *     内容未变」；**本函数不做能力判断，能力判断在调用方**（runSyncRound 按
 *     caps.etagPropagation / 缓存新鲜期统一裁决后才传入非空 map）。
 *   - collections 返回本轮实际观测到的每个子集合的 etag+mtime（NFC rel 键）：
 *     两种形态统一从 files 表的目录条目收割 —— 目录条目在两种形态下都带
 *     etag/mtime（acceptRemoteItem 入表），被跳过的目录在父清单里的条目同样是
 *     本轮的有效观测。调用方据此收割 scan-cache（仅完整扫描轮可落盘）。
 *   - skippedDirs 为本轮按「父清单里子集合 etag 与缓存一致」跳过 PROPFIND 的
 *     子集合 rel（NFC）。调用方负责把被跳过子树按基线合成回 files 表。
 * @param excludeMatcher compileExcludePatterns 的产物（用户排除规则；null = 无规则直通）
 * @param opts { depthInfinity?: boolean, collectionEtasg?: Map<string, { e: string; m: number }> | null }
 *        （缺省 falsy = 逐目录模式 + 不跳过，兼容既有调用方）
 */
export async function listRemoteSafe(cfg: EngineCfg, remotePath: string, ignoreHidden: boolean, excludeMatcher: ((rel: string) => boolean) | null = null, opts: any = {}): Promise<any> {
  const base = String(remotePath).replace(/\/+$/, '')
  const files = new Map()
  const errors: any[] = []
  const probeResidue: any[] = [] // 同步根第一层的探测目录残留（旁路，见函数头注释）
  /** 本轮实际观测到的子集合 etag 表（NFC rel → { e, m }）：两种形态统一在收尾时从 files 表收割 */
  const collections = new Map<any, any>()
  /** 按缓存 etag 跳过 PROPFIND 的子集合 rel 列表（NFC；正确性契约见函数头注释） */
  const skippedDirs: string[] = []
  /**
   * 从 files 表收割子集合观测（目录条目 → collections，NFC 键）。数万条目的
   * 遍历按既有入表循环同规格分片让出。
   */
  const harvestCollections = async () => {
    for (const [rel, info] of files) {
      await maybeYield()
      if (info.isDir) collections.set(nfc(rel), { e: info.etag || '', m: info.mtimeMs || 0 })
    }
  }
  let complete = true
  if (opts.depthInfinity) {
    let r: any
    let netErr: any = null
    try {
      r = await davRequest(cfg, 'PROPFIND', base, {
        isCollection: true,
        headers: { Depth: 'infinity', 'Content-Type': 'application/xml' },
        body: PROBE_PROPFIND_BODY,
      })
    } catch (e: any) {
      netErr = e
    }
    if (netErr == null && (r.status === 207 || r.status === 200)) {
      let items
      try {
        items = parseMultistatus(r.body ? r.body.toString('utf-8') : '')
      } catch (e: any) {
        items = null // 解析失败 → 回落逐目录（文档过大截断等场景逐目录小文档可解）
      }
      if (items) {
        for (const item of items) {
          await maybeYield() // 数万条目的入表循环分片让出（与本地扫描同规格）
          // href 为集合自身的条目返回空 rel；infinity 响应的其余条目 rel 即
          // 相对同步根的完整路径（可能多段）
          const rel = relFromHref(cfg, base, item.href).replace(/\/+$/, '')
          if (!rel) {
            // 集合自身条目携带 404 propstat = 服务器以 207 形态告知「集合不存在」
            //（部分网关 / 服务对缺失路径不回 HTTP 404 状态，而是 207 + 404 propstat；
            // 根探测 Depth:0 也只见 207）。与 HTTP 404 分支同语义上报，交由 I1 闸门
            // 的根丢失兜底接管 —— 绝不能解读成「远端为空」触发批量删除
            if (/404/.test(String(item.status || ''))) {
              complete = false
              errors.push({ rel: '.', message: '云端找不到这个文件夹，或没有访问权限（HTTP 404）' })
              return { files, complete, errors, probeResidue, depth: 'infinity', collections, skippedDirs }
            }
            continue
          }
          acceptRemoteItem(files, probeResidue, rel, item, !rel.includes('/'), ignoreHidden, excludeMatcher)
        }
        await harvestCollections()
        return { files, complete, errors, probeResidue, depth: 'infinity', collections, skippedDirs }
      }
    }
    if (netErr == null && r.status !== 404) {
      // 非 207 且非 404（403/400/501 等 = 服务器对 infinity 说不，缓存已过期）：
      // 回落逐目录。404 不回落 —— 根缺失要与逐目录模式同语义上报（触发根重建
      // 保护链路），网络异常同样不回落（见函数头注释）
    } else if (netErr != null) {
      complete = false
      errors.push({ rel: '.', message: (netErr && netErr.message) || String(netErr) })
      return { files, complete, errors, probeResidue, depth: 'infinity', collections, skippedDirs }
    } else {
      // 404：与逐目录模式的首请求同语义（根缺失 → incomplete，绝不解读为「远端已删除」）
      complete = false
      errors.push({ rel: '.', message: '云端找不到这个文件夹，或没有访问权限（HTTP 404）' })
      return { files, complete, errors, probeResidue, depth: 'infinity', collections, skippedDirs }
    }
  }
  // 队列元素：{ path: 远端绝对路径, prefix: 相对基准目录的目录前缀 }。
  // 头指针遍历（i 递增、push 追加）：免掉 shift() 每次出队的 O(n) 整体搬移
  //（数千目录的扫描轮里是纯浪费）；queue.length 随 push 增长，for 条件每次
  // 重取，行为与旧 while+shift 完全一致（continue 即出队语义）。
  const queue: Array<{ path: string; prefix: string }> = [{ path: base, prefix: '' }]
  for (let i = 0; i < queue.length; i++) {
    const { path: cur, prefix } = queue[i]
    let r
    try {
      // isCollection：目录列举目标一律是集合，URL 补尾斜杠发起；body 与探测 / 写前
      // 查重 / 批量校验共用的同一组 props（PROBE_PROPFIND_BODY）
      r = await davRequest(cfg, 'PROPFIND', cur, {
        isCollection: true,
        headers: { Depth: '1', 'Content-Type': 'application/xml' },
        body: PROBE_PROPFIND_BODY,
      })
    } catch (e: any) {
      complete = false
      errors.push({ rel: prefix || '.', message: (e && e.message) || String(e) })
      continue
    }
    if (r.status === 404) {
      complete = false
      errors.push({ rel: prefix || '.', message: '云端找不到这个文件夹，或没有访问权限（HTTP 404）' })
      continue
    }
    if (r.status !== 207) {
      complete = false
      errors.push({ rel: prefix || '.', message: `云端文件夹暂时读不出来（HTTP ${r.status}）` })
      continue
    }
    let items
    try {
      items = parseMultistatus(r.body ? r.body.toString('utf-8') : '')
    } catch (e: any) {
      // 畸形 XML（截断 / 未闭合 / 坏实体）：整目录判 incomplete，绝不把部分条目当全量
      //（否则残缺列表会被决策层解释成「远端已删除」→ 误删本地文件）
      complete = false
      errors.push({ rel: prefix || '.', message: (e && e.message) || String(e) })
      continue
    }
    for (const item of items) {
      const childRel = relFromHref(cfg, cur, item.href)
      if (!childRel) {
        // 集合自身条目（根级 = prefix 为空）：携带 404 propstat 时与 infinity 分支
        // 同语义上报根缺失 —— 否则该 207 会被解读成「远端为空」，非空基线下
        // 规划出批量 delete-local（仅靠删除阈值兜底）
        if (!prefix && /404/.test(String(item.status || ''))) {
          complete = false
          errors.push({ rel: '.', message: '云端找不到这个文件夹，或没有访问权限（HTTP 404）' })
        }
        continue // 集合自身
      }
      const rel = prefix ? `${prefix}/${childRel.replace(/\/+$/, '')}` : childRel.replace(/\/+$/, '')
      if (acceptRemoteItem(files, probeResidue, rel, item, !prefix, ignoreHidden, excludeMatcher) && item.isDir) {
        // 子集合 etag 跳过判定：缓存有该子集合的非空 etag 且与
        // 父清单里观测一致 → 子树内容未变（正确性契约见函数头注释），不再入队列举。
        // 根目录不经此路径（队首必然列举），天然永不跳过。
        const dirRel = nfc(rel)
        const cached = opts.collectionEtasg ? opts.collectionEtasg.get(dirRel) : null
        if (cached && item.etag && cached.e === item.etag) {
          skippedDirs.push(dirRel)
        } else {
          queue.push({ path: `${base}/${rel}`, prefix: rel })
        }
      }
    }
  }
  await harvestCollections()
  return { files, complete, errors, probeResidue, depth: 'per-dir', collections, skippedDirs }
}

/** 兼容旧 API：仅需要文件表（Map）的调用方使用；扫描不完整时抛出，避免把残缺列表当全量 */
export async function listRemote(cfg: EngineCfg, remotePath: string, ignoreHidden: boolean): Promise<Map<string, any>> {
  const scan = await listRemoteSafe(cfg, remotePath, ignoreHidden)
  if (!scan.complete) {
    const e: any = new Error('无法读取云端文件夹的内容，本次同步已停止，没有改动任何文件')
    e.scanErrors = scan.errors
    e.detail = `${scan.errors[0].rel}: ${scan.errors[0].message}`
    throw e
  }
  return scan.files
}

/**
 * 浅层列举远端目录的直接子目录（Depth 1 PROPFIND，不递归）。
 * 供渲染层的远端目录选择器逐级浏览使用。
 * @param cfg WebDAV 连接配置
 * @param remotePath 基准目录（'' 表示服务器根目录）
 * @returns 子目录数组 [{ name: 目录名, path: 以 / 开头的远端路径 }]，按名称排序；
 *          隐藏目录（以 . 开头）不返回；目录不存在 / 权限错误时抛出异常
 */
export async function listDirs(cfg: EngineCfg, remotePath: string): Promise<Array<{ name: string; path: string }>> {
  const base = stripRemoteSlashes(remotePath)
  // 浏览器式逐级浏览的目标是集合：URL 补尾斜杠发起
  const r = await davRequest(cfg, 'PROPFIND', base, {
    isCollection: true,
    headers: { Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
  })
  if (r.status === 404) throw new Error('云端找不到这个文件夹，或没有访问权限')
  const body = r.body ? r.body.toString('utf-8') : ''
  // 个别服务器对成功的 PROPFIND 返回 200 + multistatus 而非 207，一并接受
  if (r.status !== 207 && !(r.status === 200 && /multistatus/i.test(body))) {
    const err: any = new Error('无法读取云端文件夹的内容')
    err.detail = `HTTP ${r.status}`
    throw err
  }
  const dirs: any[] = []
  for (const item of parseMultistatus(body)) {
    // isDir 解析不出来时的兜底：RFC 约定集合的 href 以 / 结尾
    if (!item.isDir && !/\/$/.test(item.href)) continue
    const rel = relFromHref(cfg, base, item.href).replace(/\/+$/, '')
    if (!rel) continue // 集合自身
    // 异常服务器可能在 href 里带出嵌套路径：路径按完整 rel 拼接，名称只取最后一段
    const name = rel.split('/').pop() || rel
    if (isHiddenRel(name) || isJunkRel(name)) continue
    dirs.push({ name, path: `${base ? `/${base}` : ''}/${rel}` })
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  return dirs
}

// ---------- 服务器能力探测与档位（写权限按远端根路径） ----------
//
// 背景：WebDAV 服务器对条件请求（If-Match / If-None-Match）、etag 强弱、Depth:
// infinity、集合 URL 尾斜杠等行为差异极大，且「静默忽略条件头」的服务器很常见 ——
// 不能按 RFC 假设，必须实测后落档。缓存存于 pluginData 存储根（store.js 的
// ServerStateStore / capabilities.json），绝不放 dbStorage / 用户同步目录 / 远端。
//
// 缓存粒度（两层）：
//   - 公共能力字段（etag 行为 / 条件请求 / depthInfinity / mtime 精度 / 尾斜杠重定向）
//     按「origin（scheme://host:port）+ username」粒度共享 —— 同一服务器同账号的行为
//     属性与具体目录无关；
//   - 写权限（writable，即 C 档判定）按「远端根路径」粒度（capabilities.json 的
//     writePaths 表）：同一账号下不同共享 / 子树的写权限可能不同（只读分享等），
//     探测文件就写在目标路径下实测。探测序列整体在目标路径执行：公共字段只在
//     无可信缓存时探测一次，后续目录仅补一次写探测（约 3 个请求）。
//
// 写失败分类：权限性失败（401/403/507；PUT 另含 405）→ C 档 +
// 原因（writeReason，UI 展示），缓存 7 天；非权限性失败（409 父目录缺失 / 5xx /
// 网络错误）→ 不得按 C 档长期缓存，当轮按 B 档保守处理（照常尝试写入 + 复查
// 保护），写结论不落缓存，下一轮自动重探。
//
// 目标根目录不存在：先确保根目录存在（PROPFIND 404 → mkdirDeep，
// 与同步轮自身的建根行为一致）再探测 —— 探测不「探测到父级」。
//
// 档位判定规则：
//   C —— 目标路径写探测被权限性拒绝：download-only，跳过一切上传与删除；
//   A —— 条件请求两侧实测均被遵守（If-Match 过期得 412 且 If-None-Match:* 对已存在
//         文件得 412），且 PROPFIND 返回强 etag（非 W/ 前缀）：上传 / 删除带条件头；
//   B —— 其余（可写，但条件请求不可用或 etag 弱 / 缺失 / 未知）：覆盖 / 删除前紧邻复查。
// 注意：etag「跨 PUT 稳定性」（etag.stable）只记录不参与档位判定 —— nginx/Apache 的
// mtime 型 etag 同内容重传也会变，属正常现象，不影响 If-Match 的正确使用。

/** 能力缓存 TTL：7 天（远端服务器行为变化通常伴随部署，周期性重探足够） */
export const PROBE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * etag 跳过扫描缓存（scan-cache.json）的最大新鲜期：6 小时。
 * etag 跳过依赖「服务器正确传播集合 etag」这一探测结论 —— 探测是 7 天前的快照，
 * 服务器行为可能已变（停止传播的深层修改会被跳过漏掉）；周期性强制一次全量下降
 * 把这类「界内滞后」限制在有界时间内。同时也覆盖 watch 缺失的远端侧对账
 *（对端直改远端、本机无任何触发时，全量下降是唯一的发现通道）。
 */
export const ETAG_SKIP_FULL_SCAN_MS = 6 * 3600 * 1000
/** 探测目录名前缀（已加入 SYNC_TMP_PREFIXES，扫描层排除） */
const PROBE_PREFIX = '.wdsync-probe-'
/**
 * 崩溃残留清理的最低时龄：小于该值的同前缀目录可能是「并发探测正在使用」，不得删。
 * 清理策略：按 `.wdsync-probe-` 前缀 + 时龄 ≥ 10 分钟（本常量）清理**所有设备**的
 * 崩溃残留 —— 前缀匹配不区分设备（活跃探测必然年轻，年龄门槛保护并发探测）。
 * 双通道执行：同步轮扫描后清理（syncDirectory 3.2 步，复用扫描结果、不额外列目录）
 * + 探测启动时清理（runCapabilityProbe 第 2 步，仅 needCommon 分支 —— 公共缓存命中
 * 时的按路径写探测不列表，依赖同步轮通道兜底）。两个通道都只删同步根第一层的
 * 探测目录（探测只产生第一层残留），绝不递归其他内容。
 */
export const PROBE_RESIDUE_MIN_AGE_MS = 10 * 60 * 1000
/** 探测请求总量软上限（典型序列约 14 个、含 MOVE 实测至多 18 个）：超限立即降级收尾，绝不拖垮轮次 */
const PROBE_MAX_REQUESTS = 20
const PROBE_BODY = 'wdsync-capability-probe'
export const PROBE_PROPFIND_BODY =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>'
/**
 * 配额探测 PROPFIND 请求体：resourcetype + RFC 4331 配额属性（quota-available-bytes /
 * quota-used-bytes）。轮前根探测（配额预检数据源）与 testConnection（服务器卡片剩余
 * 空间展示）共用 —— 服务器不返回该属性时按 404 propstat 缺省、消费侧静默跳过。
 */
export const QUOTA_PROPFIND_BODY =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:quota-available-bytes/><d:quota-used-bytes/></d:prop></d:propfind>'
/**
 * 写探测的「权限性失败」状态码：只有明确「不让写」才允许按 C 档长期缓存。
 * MKCOL 的 405 例外 = 集合已存在（RFC 4918），沿用旧语义视为可用；
 * PUT 的 405 = 方法不允许（该资源不可覆盖），归权限性失败。
 */
const MKCOL_DENIED_STATUS = new Set([401, 403, 507])
const PUT_DENIED_STATUS = new Set([401, 403, 405, 507])

/**
 * 计算配置的服务器 origin（scheme://host:port）——能力与噪声的缓存键之一。
 * 解析失败回退原始字符串（探测本身随后会因无效地址降级）。
 */
export function originOf(cfg: EngineCfg): string {
  try {
    return new URL(remoteUrl(cfg, '')).origin
  } catch (_) {
    return String((cfg && cfg.serverUrl) || '')
  }
}

/**
 * etag 规范化（仅用于相等比较）：去首尾空白、去 W/ 弱标记前缀、去包裹引号。
 * 全链路（探测 / B 档复查 / 测试断言）共用这一处口径，避免「带引号 vs 不带」的假不相等。
 */
export function normEtag(e: string | null | undefined): string {
  let t = String(e == null ? '' : e).trim()
  if (/^W\//i.test(t)) t = t.slice(2)
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1)
  return t
}

/** 是否弱 etag（W/ 前缀）——弱 etag 绝不用于 If-Match（RFC 7232 强比较语义） */
function isWeakEtag(e: string | null | undefined): boolean {
  return /^W\//i.test(String(e == null ? '' : e).trim())
}

/** 取「可用于 If-Match 的强 etag」：弱 / 空返回 null，否则返回规范化后的裸 tag */
export function strongEtagOf(e: string | null | undefined): string | null {
  if (!e || isWeakEtag(e)) return null
  const t = normEtag(e)
  return t ? t : null
}

/** 降级能力结果：探测无法完成时按 B 档（可写假设 + 无条件请求）保守执行，不落缓存 */
function degradedCaps(note: string, tech?: string): DavCapabilities {
  return {
    probedAt: 0,
    tier: 'B',
    writable: true,
    degraded: true,
    writeReason: note,
    writeRetrySoon: true,
    etag: { present: false, weak: false, stable: false },
    conditional: { ifMatch: false, ifNoneMatch: false },
    depthInfinity: false,
    etagPropagation: false,
    mtimePrecision: 'ms',
    collectionRedirect: false,
    notes: tech ? [note, tech] : [note],
  }
}

/** 权限性拒绝的写结论（C 档，可缓存 7 天）：reason 为面向用户一句话，tech 为技术明细（进 notes） */
function deniedWrite(reason: string, tech?: string): any {
  return { writable: false, reason, tech, probedAt: Date.now() }
}

/** 非权限性失败的写结论（409 / 5xx / 网络错误）：当轮按 B 档保守处理，不落缓存，下轮重探 */
function retryWrite(note: string, tech?: string): any {
  return { retry: true, note, tech, probedAt: Date.now() }
}

/**
 * 由「公共能力 + 目标路径写结论」组装该路径的生效能力视图（tier 在此判定）。
 * write 缺失 / retry 一律按可写处理（B 档保守：照常尝试写入 + 复查保护，
 * 绝不因探测故障跳过传输）；权限性拒绝才降到 C 档。
 */
export function effectiveCaps(common: any, write: any): any {
  const writable = !(write && write.writable === false)
  const tier = !writable
    ? 'C'
    : common.conditional.ifMatch && common.conditional.ifNoneMatch && common.etag.present && !common.etag.weak
      ? 'A'
      : 'B'
  const notes = Array.isArray(common.notes) ? common.notes.slice() : []
  const eff: any = {
    probedAt: common.probedAt || 0,
    tier,
    writable,
    etag: { ...common.etag },
    conditional: { ...common.conditional },
    depthInfinity: !!common.depthInfinity,
    // 缺省 undefined = 未探测（旧缓存）：按「可用」乐观处理，运行时 405/501 降级兜底
    moveSupported: common.moveSupported === false ? false : true,
    etagPropagation: !!common.etagPropagation,
    mtimePrecision: common.mtimePrecision || 'ms',
    collectionRedirect: !!common.collectionRedirect,
    notes,
  }
  if (common.commonProbed === false) eff.commonProbed = false
  if (write) {
    eff.writeProbedAt = write.probedAt
    if (write.writable === false && write.reason) {
      eff.writeReason = write.reason
      notes.push(write.reason)
      if (write.tech) notes.push(write.tech)
    } else if (write.retry && write.note) {
      eff.writeReason = write.note
      eff.writeRetrySoon = true
      notes.push(write.note)
      if (write.tech) notes.push(write.tech)
    }
  }
  return eff
}

/**
 * 把「服务器不支持 MOVE（405/501）」持久降级进能力缓存（best-effort）。
 * 同步期 MOVE 被明确拒绝时调用：下一轮起改名配对被 moveSupported=false 挡住，
 * 自然回落「删除 + 重新上传」的既有语义；降级写入失败无害 —— 下一轮的 MOVE
 * 会再试一次并被同一路径捕获。探测期未测到（旧缓存 / 探测期不可写）的场景
 * 由这条运行时通道兜底。
 */
export async function persistMoveUnsupported(cfg: EngineCfg): Promise<void> {
  try {
    const state = await storage.openServerState(originOf(cfg), (cfg && cfg.username) || '')
    const cached = state.getCachedCapabilities(PROBE_TTL_MS)
    if (cached && cached.moveSupported !== false) {
      const toSave = { ...cached, moveSupported: false }
      toSave.notes = [...(toSave.notes || []), '同步期 MOVE 被拒绝（405/501）：改名已回落为删除+重新上传']
      await state.saveCapabilities(toSave)
    }
  } catch (_) {
    /* 降级失败：下一轮 MOVE 再试一次，无害 */
  }
}

/**
 * 执行一次能力探测（任一步失败降级收尾、绝不抛出）。
 * 探测在目标路径 pathKey（同步目录的远端根路径；'/' 为服务器基址）整体执行：
 *   确保根目录存在（PROPFIND 404 → mkdirDeep，与同步轮建根行为一致）
 *   →（需补公共字段时）基址无尾斜杠 PROPFIND 观测重定向 + 清理同前缀崩溃残留
 *   → MKCOL 探测目录 → PUT 探测文件（写权限按路径实测，失败按权限性 / 非权限性分类）
 *   →（仅无可信公共缓存时）PROPFIND/PUT/PROPFIND（etag 稳定性与 mtime 精度）
 *     → 过期 If-Match PUT（须 412）→ If-None-Match:* PUT（须 412）
 *     → Depth: infinity PROPFIND → DELETE 清理探测目录。
 * 探测全部写入目标路径下的专用子目录 `<root>/.wdsync-probe-<rand>/`（整体创建：
 * MKCOL 目录 → 内部写 probe.txt，不向根目录直接写任何探测文件；整体删除：结束时
 * DELETE 整个目录）。目录被扫描层排除（isSyncTempRel）；崩溃残留按
 * `.wdsync-probe-` 前缀 + 时龄 ≥ PROBE_RESIDUE_MIN_AGE_MS 双通道清理（见该常量
 * 注释：同步轮扫描后 + 探测启动时，清理所有设备的残留）。
 * @param cfg WebDAV 连接配置
 * @param pathKey 规范化远端根路径（'/' = 服务器基址）
 * @param cachedCommon 可信的公共能力缓存（origin+用户 粒度）；null = 需现场探测
 * @returns { common, write, commonProbed }：
 *   write = { writable, reason?, probedAt }（权限性结论，可缓存）| { retry, note, probedAt }
 *   （非权限性失败，当轮按 B 档保守处理、不落缓存）；
 *   commonProbed = 公共字段是否在本轮完整探测（写被拒时公共字段不可信）；
 *   返回 { fatal } 表示探测无法进行（网络级失败），调用方按 degraded 处理且不缓存。
 */
async function runCapabilityProbe(cfg: EngineCfg, pathKey: string, cachedCommon: any): Promise<any> {
  const needCommon = !cachedCommon
  const common =
    cachedCommon ||
    {
      probedAt: Date.now(),
      etag: { present: false, weak: false, stable: false },
      conditional: { ifMatch: false, ifNoneMatch: false },
      depthInfinity: false,
      // MOVE 支持（改名同步）：默认乐观 true，探测期若可写会实测改写（第 6.5 步）
      moveSupported: true,
      etagPropagation: false,
      mtimePrecision: 'ms',
      collectionRedirect: false,
      notes: [],
    }
  const notes = common.notes
  let used = 0
  const req = (method: any, remotePath: any, opts: any = {}) => {
    // 软预算：超限后调用方步骤自行跳过，保证探测请求总量受控（~10 量级）
    if (used >= PROBE_MAX_REQUESTS) throw new Error('探测请求预算已用尽')
    used++
    return davRequest(cfg, method, remotePath, opts)
  }
  /** 提前收尾：写结论已定，公共字段本轮不可信（cachedCommon 存在时保持其可信标记） */
  const fail = (write: any) => {
    if (!cachedCommon) common.commonProbed = false
    return { common, write, commonProbed: false }
  }
  /** pathKey 对应 davRequest 的远端路径（'/' 基址 → ''） */
  const pathRel = pathKey === '/' ? '' : pathKey.replace(/^\/+/, '')

  let baseNoSlash = ''
  try {
    baseNoSlash = String((cfg && cfg.serverUrl) || '').replace(/\/+$/, '')
    new URL(baseNoSlash) // 仅验证可解析
  } catch (_) {
    return fail(retryWrite('服务器地址不正确', `服务器地址无效：${(cfg && cfg.serverUrl) || ''}`))
  }

  // 1. 确保目标根目录存在。mkdirDeep 失败按状态码分类：
  //    权限性拒绝 → C；其余（409 / 5xx / 网络错误）→ retry（B 档保守，不缓存）
  try {
    const r0 = await req('PROPFIND', pathRel, {
      isCollection: true,
      headers: { Depth: '0', 'Content-Type': 'application/xml' },
      body: PROBE_PROPFIND_BODY,
    })
    if (r0.status !== 207 && r0.status !== 200) {
      if (r0.status === 404) {
        try {
          await mkdirDeep(cfg, pathRel)
        } catch (e: any) {
          if (e && MKCOL_DENIED_STATUS.has(Number(e.status))) {
            return fail(deniedWrite('服务器不允许创建文件夹，请检查账号权限', `创建目录被拒（HTTP ${e.status}）`))
          }
          return fail(retryWrite('云端文件夹暂时不可用，稍后会自动重试', `根目录不存在且创建失败：${(e && e.message) || e}`))
        }
      } else if (r0.status === 401 || r0.status === 403) {
        return fail(deniedWrite('没有访问云端文件夹的权限，请检查账号权限', `目录不可访问（HTTP ${r0.status}）`))
      } else {
        return fail(retryWrite('云端文件夹暂时不可用，稍后会自动重试', `根目录 PROPFIND：HTTP ${r0.status}`))
      }
    }
  } catch (e: any) {
    return { fatal: '暂时无法检测服务器能力，稍后会自动重试', fatalTech: `根目录探测失败：${(e && e.message) || e}` }
  }

  // 2. 残留清理 +（仅基址）尾斜杠重定向观测。只在需要补公共字段时做：
  //    写探测不依赖目录清单，每轮同步前的按路径写探测不必重复列目录。
  if (needCommon) {
    let listEntries: any = null
    try {
      if (pathKey === '/') {
        const netOpts = resolveNetOpts(cfg)
        const r1 = await requestWithRetry(
          cfg,
          'PROPFIND',
          new URL(baseNoSlash),
          { headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: PROBE_PROPFIND_BODY },
          netOpts
        )
        if (REDIRECT_STATUS.has(r1.status) && r1.headers && r1.headers.location != null) {
          common.collectionRedirect = true
          // 重定向服务器：按规范尾斜杠形态重新列举一次取清单
          const r2 = await davRequest(cfg, 'PROPFIND', '', { isCollection: true, headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: PROBE_PROPFIND_BODY })
          if (r2.status === 207 || r2.status === 200) listEntries = parseMultistatus(r2.body ? r2.body.toString('utf-8') : '')
          else notes.push(`根目录 PROPFIND（重定向后）：HTTP ${r2.status}`)
        } else if (r1.status === 207 || r1.status === 200) {
          listEntries = parseMultistatus(r1.body ? r1.body.toString('utf-8') : '')
        } else {
          notes.push(`根目录 PROPFIND：HTTP ${r1.status}`)
        }
      } else {
        const r1 = await davRequest(cfg, 'PROPFIND', pathRel, { isCollection: true, headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: PROBE_PROPFIND_BODY })
        if (r1.status === 207 || r1.status === 200) listEntries = parseMultistatus(r1.body ? r1.body.toString('utf-8') : '')
        else notes.push(`目录 PROPFIND：HTTP ${r1.status}`)
      }
    } catch (e: any) {
      return { fatal: '暂时无法检测服务器能力，稍后会自动重试', fatalTech: `根目录探测失败：${(e && e.message) || e}` }
    }
    // 崩溃残留清理（通道之二；通道之一为 syncDirectory 扫描后清理，见 PROBE_RESIDUE_MIN_AGE_MS
    // 注释）：同前缀且时龄超阈值的目录 / 文件。前缀匹配不区分设备 —— 清理所有设备的
    // 残留；新近创建的可能是并发探测在用（含其他设备的活跃探测），由年龄门槛保护
    if (listEntries) {
      for (const item of listEntries) {
        const rel = relFromHref(cfg, pathRel, item.href)
        if (!rel) continue
        const name = String(rel).split('/').pop() || ''
        if (!name.startsWith(PROBE_PREFIX)) continue
        if (!item.mtime || Date.now() - item.mtime < PROBE_RESIDUE_MIN_AGE_MS) continue
        await davRequest(cfg, 'DELETE', joinRemote(pathRel, name)).catch(() => {})
      }
    }
  }

  // 3. 探测目录与写权限（MKCOL 405 = 已存在，视为可用）。
  //    探测文件放在探测目录的一层子目录里（<probe>/sub/probe.txt）——
  //    第 6 步的 Depth:infinity 探测据此直接验证「响应确实包含 ≥2 层后代」，
  //    对「返回 207 但把 infinity 当 Depth:1 应答」的服务器（真实存在）不会误判
  //    为支持递归列举（误判会让引擎的单请求扫描拿到残缺树 → 决策层把它解读成
  //    「远端已删除」→ 批量误删本地文件）。代价仅 +1 个 MKCOL。
  const dirName = `${PROBE_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const dirRel = joinRemote(pathRel, dirName)
  const nestedRel = joinRemote(dirRel, 'sub')
  const fileRel = joinRemote(nestedRel, 'probe.txt')
  let dirReady = false
  try {
    const mk = await req('MKCOL', dirRel)
    if (mk.status === 201 || mk.status === 405) dirReady = true
    else if (MKCOL_DENIED_STATUS.has(mk.status)) return fail(deniedWrite('服务器不允许创建文件夹，请检查账号权限', `创建目录被拒（HTTP ${mk.status}）`))
    else return fail(retryWrite('暂时无法确认服务器是否允许上传，稍后会自动重新检测', `创建探测目录：HTTP ${mk.status}`))
  } catch (e: any) {
    return fail(retryWrite('暂时无法确认服务器是否允许上传，稍后会自动重新检测', `创建探测目录失败：${(e && e.message) || e}`))
  }
  if (dirReady) {
    try {
      const mk2 = await req('MKCOL', nestedRel)
      if (mk2.status !== 201 && mk2.status !== 405) {
        if (MKCOL_DENIED_STATUS.has(mk2.status)) return fail(deniedWrite('服务器不允许创建文件夹，请检查账号权限', `创建目录被拒（HTTP ${mk2.status}）`))
        return fail(retryWrite('暂时无法确认服务器是否允许上传，稍后会自动重新检测', `创建探测子目录：HTTP ${mk2.status}`))
      }
    } catch (e: any) {
      return fail(retryWrite('暂时无法确认服务器是否允许上传，稍后会自动重新检测', `创建探测子目录失败：${(e && e.message) || e}`))
    }
  }

  // 4. 写探测文件：权限性拒绝（401/403/405/507）→ C 档 + 原因；
  //    其他失败（含 5xx）→ retry：当轮 B 档保守处理，不落缓存。
  //    不提前 return：探测目录已建，无论写探测成败都要走到第 7 步清理
  let write: any = null
  if (dirReady) {
    try {
      const p = await req('PUT', fileRel, { body: PROBE_BODY })
      if (p.status >= 200 && p.status < 300) write = { writable: true, probedAt: Date.now() }
      else if (PUT_DENIED_STATUS.has(p.status)) write = deniedWrite('服务器不允许上传文件，请检查账号权限', `写入被拒（HTTP ${p.status}）`)
      else write = retryWrite('暂时无法确认服务器是否允许上传，稍后会自动重新检测', `写入探测文件失败：HTTP ${p.status}`)
    } catch (e: any) {
      write = retryWrite('暂时无法确认服务器是否允许上传，稍后会自动重新检测', `写入探测文件失败：${(e && e.message) || e}`)
    }
  } else {
    write = retryWrite('暂时无法确认服务器是否允许上传，稍后会自动重新检测', '探测目录不可用')
  }
  const wrote = !!write && write.writable === true

  // 5. 公共能力字段（仅无可信缓存且本路径可写时；写被拒的轮次这些字段不可信，
  //    统一保持保守默认值，由 commonProbed=false 阻止其被当作可信缓存）
  if (wrote && needCommon) {
    const propsOnce = async () => {
      const r = await req('PROPFIND', fileRel, { headers: { Depth: '0', 'Content-Type': 'application/xml' }, body: PROBE_PROPFIND_BODY })
      if (r.status !== 207 || !r.body) return null
      const list = parseMultistatus(r.body.toString('utf-8'))
      return list[0] || null
    }
    let e1 = ''
    let lm1 = 0
    try {
      const p = await propsOnce()
      if (p) {
        e1 = p.etag
        lm1 = p.mtime
      } else notes.push('探测文件属性读取为空')
    } catch (e: any) {
      notes.push(`探测文件 PROPFIND 失败：${(e && e.message) || e}`)
    }
    let e2 = ''
    let lm2 = 0
    try {
      await req('PUT', fileRel, { body: PROBE_BODY }) // 同内容重传：观察 etag 跨 PUT 稳定性
      const p = await propsOnce()
      if (p) {
        e2 = p.etag
        lm2 = p.mtime
      }
    } catch (e: any) {
      notes.push(`探测文件二次写入/读取失败：${(e && e.message) || e}`)
    }
    common.etag.present = !!normEtag(e1)
    common.etag.weak = isWeakEtag(e1)
    common.etag.stable = common.etag.present && !!normEtag(e2) && normEtag(e1) === normEtag(e2)
    // mtime 精度：两次观测都落在整秒 → 秒级（服务端把 getlastmodified 捨到整秒），
    // 否则毫秒级。比「与本机时钟差」更稳：不受服务器时钟偏移影响。
    const wholeSec = (t: any) => t > 0 && t % 1000 === 0
    common.mtimePrecision = wholeSec(lm1) && wholeSec(lm2) ? 's' : 'ms'
    // 条件请求必须实测：静默忽略条件头的服务器很常见。
    // 过期 If-Match PUT 应得 412；对已存在文件 If-None-Match:* PUT 应得 412；
    // 两者都被遵守才判 conditional 可用。被忽略（2xx 照常写入）→ false。
    try {
      const c1 = await req('PUT', fileRel, { body: PROBE_BODY, headers: { 'If-Match': '"wdsync-probe-stale"' } })
      common.conditional.ifMatch = c1.status === 412
      if (c1.status !== 412 && (c1.status < 200 || c1.status >= 300)) notes.push(`If-Match 探测：HTTP ${c1.status}`)
    } catch (e: any) {
      notes.push(`If-Match 探测失败：${(e && e.message) || e}`)
    }
    try {
      const c2 = await req('PUT', fileRel, { body: PROBE_BODY, headers: { 'If-None-Match': '*' } })
      common.conditional.ifNoneMatch = c2.status === 412
      if (c2.status !== 412 && (c2.status < 200 || c2.status >= 300)) notes.push(`If-None-Match 探测：HTTP ${c2.status}`)
    } catch (e: any) {
      notes.push(`If-None-Match 探测失败：${(e && e.message) || e}`)
    }
  }

  // 5.5 集合 etag 深层传播。逐目录扫描按「子集合 etag 未变」跳过其
  //     PROPFIND 的正确性前提是：任意深度后代的变更都会反映到所有祖先集合的 etag ——
  //     只要存在一层不传播，跳过就会漏检深层变更。探测布局只有两层（探测目录/sub/probe.txt），
  //     因此只能实测到「文件→父集合」与「父集合→祖先集合」两级，两级都传播才判 true
  //     （保守：观测不到 = 不支持）。写入内容必须变化（PROBE_BODY + '-prop'）：mtime 型
  //     etag 服务器对同内容重传也视为写入，但内容变化对内容哈希型（dedup）服务器同样
  //     成立，两种 etag 实现都覆盖。请求预算：本步 4 个 PROPFIND + 1 个 PUT，加上
  //     6.5 步的 MOVE 实测至多 2 个 —— 全序列 ≤ 18 < PROBE_MAX_REQUESTS(20)；
  //     预算耗尽会抛错，被下方 try/catch 吞成 notes（etagPropagation 保持 false）。
  if (wrote && needCommon && common.etag.present) {
    try {
      /**
       * 对 listDir 发 Depth:1 PROPFIND，取名为 childName 的直接子条目的 etag。
       * 为什么不 Depth:0 直取子集合：观察的是「父集合的列表应答里，子集合条目的
       * etag 是否随深层写入变化」—— 引擎逐目录扫描读的正是父列表里的子条目 etag，
       * 探测口径必须与使用口径一致。非 207 / 找不到条目 / 无 etag 一律返回 ''（判 false）。
       */
      const etagOf = async (listDir: string, childName: string): Promise<string> => {
        const r = await req('PROPFIND', listDir, { isCollection: true, headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: PROBE_PROPFIND_BODY })
        if (r.status !== 207 || !r.body) return ''
        for (const item of parseMultistatus(r.body.toString('utf-8'))) {
          if (relFromHref(cfg, listDir, item.href).replace(/\/+$/, '') === childName) return String(item.etag || '')
        }
        return ''
      }
      const subBefore = await etagOf(dirRel, 'sub')
      const topBefore = await etagOf(pathRel, dirName)
      await req('PUT', fileRel, { body: `${PROBE_BODY}-prop` }) // 内容必须变：两种 etag 实现都必然视为写入
      const subAfter = await etagOf(dirRel, 'sub')
      const topAfter = await etagOf(pathRel, dirName)
      // 一层：文件→父集合（sub）；两层：→祖先集合（探测目录的父 = 目标根）。二者都
      // 要求「有 etag 可观测 且 前后不同」—— 任一空串（集合无 etag 的默认服务器形态）
      // 直接判不传播
      const oneLevel = !!(subBefore && subAfter && subBefore !== subAfter)
      const twoLevel = !!(topBefore && topAfter && topBefore !== topAfter)
      common.etagPropagation = oneLevel && twoLevel
      if (!common.etagPropagation) notes.push('集合 etag 不随深层修改传播（或无法观测）：逐目录扫描不跳过子集合')
    } catch (e: any) {
      // 整段失败只记 notes，etagPropagation 保持 false（保守：能力探测绝不让单步故障连坐轮次）
      notes.push(`集合 etag 传播探测失败：${(e && e.message) || e}`)
    }
  }

  // 6. Depth: infinity（只读探测；只对探测目录发起，避免对真实大目录递归列举；
  //    仅在本路径可写且需补公共字段时有意义 —— commonProbed=false 的轮次该值不可信）。
  //    硬化：状态码 207/200 只是必要条件，响应里必须实际出现 ≥2 层的后代
  //    条目（sub/probe.txt）才判支持 —— 探测文件已特意放进一层子目录，「207 但只
  //    回第一层」的服务器在此直接露馅（按不支持处理，扫描走逐目录模式）
  if (dirReady && wrote && needCommon) {
    try {
      const d = await req('PROPFIND', dirRel, { isCollection: true, headers: { Depth: 'infinity', 'Content-Type': 'application/xml' }, body: PROBE_PROPFIND_BODY })
      let nested = false
      if (d.status === 207 || d.status === 200) {
        try {
          for (const item of parseMultistatus(d.body ? d.body.toString('utf-8') : '')) {
            if (relFromHref(cfg, dirRel, item.href).includes('/')) {
              nested = true
              break
            }
          }
        } catch (_) {
          nested = false // 响应畸形：按不支持处理（保守，扫描层有逐目录回落兜底）
        }
      } else {
        notes.push(`Depth: infinity：HTTP ${d.status}`)
      }
      common.depthInfinity = nested
      if (!nested && (d.status === 207 || d.status === 200)) notes.push('Depth: infinity 响应未包含嵌套条目，按不支持处理')
    } catch (e: any) {
      notes.push(`Depth: infinity 探测失败：${(e && e.message) || e}`)
    }
  }

  // 6.5 MOVE 支持（改名同步的开关）：把探测文件改名一次实测。2xx = 支持；
  //     405/501 = 明确不支持（false，改名回落删传）；其余失败保守保持乐观 true
  //    （运行时 405/501 有持久降级兜底，见 persistMoveUnsupported）。
  //     仅在本路径可写时测（不可写 = C 档，改名方向本就不触发）。
  if (dirReady && wrote) {
    try {
      const mv = await req('MOVE', fileRel, { headers: { Destination: remoteUrl(cfg, joinRemote(nestedRel, 'probe-moved.txt')), Overwrite: 'F' } })
      if (mv.status >= 200 && mv.status < 300) {
        common.moveSupported = true
        // 改名成功后把文件改回原名，后续步骤（etag 观测等）与清理路径不受影响
        await req('MOVE', joinRemote(nestedRel, 'probe-moved.txt'), { headers: { Destination: remoteUrl(cfg, fileRel), Overwrite: 'F' } }).catch(() => {})
      } else if (mv.status === 405 || mv.status === 501) {
        common.moveSupported = false
        notes.push(`MOVE 不被支持（HTTP ${mv.status}）：改名同步将按删除+重新上传处理`)
      } else {
        notes.push(`MOVE 探测：HTTP ${mv.status}（按支持处理，运行时失败会自动回落）`)
      }
    } catch (e: any) {
      notes.push(`MOVE 探测失败：${(e && e.message) || e}（按支持处理，运行时失败会自动回落）`)
    }
  }

  // 7. 清理探测目录（只要建了就删，写探测失败也不例外；失败仅记录，下轮再清）
  if (dirReady) {
    try {
      const del = await req('DELETE', dirRel)
      if (del.status >= 400) notes.push(`清理探测目录：HTTP ${del.status}`)
    } catch (e: any) {
      notes.push(`清理探测目录失败：${(e && e.message) || e}`)
    }
  }

  if (!cachedCommon) common.commonProbed = wrote
  return { common, write, commonProbed: needCommon && wrote }
}

/**
 * 探测 / 读取服务器能力（对外入口）。
 * @param cfg 连接配置
 * @param force true 时忽略缓存强制重探（设置页「重新探测」入口）
 * @param remotePath 远端根路径（按路径判定写权限）；缺省为服务器基址（UI / 连接测试场景）
 * @returns 目标路径的生效能力视图（含 tier / writable / writeReason）；探测无法进行时
 *          返回 degraded 结果（不抛出、不落缓存）
 */
export async function probeCapabilities(cfg: EngineCfg, force?: boolean, remotePath?: string): Promise<DavCapabilities> {
  const pathKey = storage.normalizeRemoteKey(remotePath || '/')
  let state: any = null
  try {
    state = await storage.openServerState(originOf(cfg), (cfg && cfg.username) || '')
  } catch (e: any) {
    return degradedCaps('暂时无法检测服务器能力，稍后会自动重试', `能力缓存存储不可用：${(e && e.message) || e}`)
  }
  const cached = (!force && state.getCachedCapabilities(PROBE_TTL_MS)) || null
  const writePaths = { ...((cached && cached.writePaths) || {}) }
  // 公共字段仅信「完整探测过」的缓存；写结论仅信权限性结论（retry 型从不落缓存）。
  // etagPropagation 必须存在：旧版插件落盘的缓存可能缺该字段 → 视为
  // 缓存缺失强制补一次公共重探 —— 一次性迁移成本，避免新结论要等 7 天 TTL 自然过期才出现
  let common = cached && cached.commonProbed !== false && typeof cached.etagPropagation === 'boolean' ? cached : null
  let write = cached && writePaths[pathKey] && typeof writePaths[pathKey].writable === 'boolean' ? writePaths[pathKey] : null
  let probed = false
  if (!common || !write) {
    probed = true
    const r = await runCapabilityProbe(cfg, pathKey, common)
    if (r.fatal) return degradedCaps(r.fatal, r.fatalTech)
    common = r.common
    write = r.write
  }
  const eff = effectiveCaps(common, write)
  if (probed && !eff.degraded) {
    if (write && typeof write.writable === 'boolean') writePaths[pathKey] = write
    // common 整体落盘（含 commonProbed 标记）：写被拒轮次的 best-effort 公共字段
    // 全部取保守值（false / 秒级），缓存它安全；commonProbed=false 阻止其被当作可信
    const commonToSave = common === cached ? cached : { ...common }
    commonToSave.writePaths = writePaths
    await state.saveCapabilities(commonToSave).catch((e: any) => eff.notes.push(`能力缓存写入失败：${(e && e.message) || e}`))
  }
  return eff
}

/**
 * 同步轮内部取能力：缓存优先，缺失 / 过期才现场探测（请求计入轮次开销但不计入传输进度）。
 * 写权限按同步目录的远端根路径判定：同一服务器下不同子树可各自落 A/B/C 档。
 */
export async function getSyncCapabilities(cfg: EngineCfg, remotePath?: string): Promise<DavCapabilities> {
  try {
    return await probeCapabilities(cfg, false, remotePath)
  } catch (e: any) {
    return degradedCaps('暂时无法检测服务器能力，稍后会自动重试', `能力探测异常：${(e && e.message) || e}`)
  }
}

/**
 * 打开本配置对应的服务器噪声存储（fingerprint-unstable，按 origin+username 粒度）。
 * 存储层异常时返回空实现：噪声标记只是优化（跳过不必要的下载比对），不得因它阻断同步。
 */
export async function openServerNoiseSafe(cfg: EngineCfg): Promise<any> {
  try {
    return await storage.openServerState(originOf(cfg), (cfg && cfg.username) || '')
  } catch (_) {
    return {
      // 与 ServerStateStore 同形的内存空实现：B 档提醒标记只进内存（每进程至多一次），
      // saveNoise 为 no-op —— 存储层异常时降级，不阻断同步
      noise: { fingerprintUnstable: false, noiseFiles: {}, concurrencyWarned: false },
      fingerprintUnstable: false,
      noteFingerprintNoise: () => false,
      resetFingerprintNoise: () => false,
      saveNoise: async () => {},
    }
  }
}

/** 查询单个远端条目属性；区分「已不存在」与「查询失败」，网络异常直接抛出 */
export async function remotePropsEx(cfg: EngineCfg, remotePath: string): Promise<any> {
  const r = await davRequest(cfg, 'PROPFIND', remotePath, { headers: { Depth: '0' } })
  if (r.status === 404) return { gone: true }
  if (r.status !== 207 || !r.body) return { error: `HTTP ${r.status}` }
  const list = parseMultistatus(r.body.toString('utf-8'))
  if (!list.length) return { error: 'empty multistatus' }
  return { props: list[0] }
}

/**
 * 单个父目录的 PROPFIND Depth:1 子条目图（写前查重与上传后批量校验两阶段共用的
 * 请求形态与解析口径：isCollection 带尾斜杠发起、PROBE_PROPFIND_BODY 同一组 props、
 * relFromHref 相对化、跳过集合自身、key NFC 归一）。三态结果，404 决策留给调用方：
 * 写前查重把「父目录不存在」当作比空列举更强的无冲突证据放行；批量校验无此特判
 * （父目录都不在了，该组 pending 必须按核对失败收场）。
 * @param cfg 请求配置（写前查重传 cfg 受取消控制；批量校验传豁免取消的 calmCfg）
 * @returns ok + childMap（键为相对父目录的 NFC 子条目名，尾斜杠已剥离）| notFound（404）| err（网络异常 / 非 207 / 解析失败）
 */
export async function propfindChildMap(cfg: EngineCfg, dirRemote: string): Promise<{ ok: true; childMap: Map<string, any> } | { notFound: true } | { err: Error }> {
  try {
    const r = await davRequest(cfg, 'PROPFIND', dirRemote, {
      isCollection: true,
      headers: { Depth: '1', 'Content-Type': 'application/xml' },
      body: PROBE_PROPFIND_BODY,
    })
    if (r.status === 404) return { notFound: true }
    if (r.status !== 207 || !r.body) return { err: new Error(`HTTP ${r.status}`) }
    const childMap = new Map<string, any>()
    // key 统一 NFC（与 remoteByNfc 同口径）：NFD 服务器名也能命中 NFC rel
    for (const item of parseMultistatus(r.body.toString('utf-8'))) {
      const childRel = relFromHref(cfg, dirRemote, item.href)
      if (!childRel) continue // 集合自身
      childMap.set(nfc(childRel.replace(/\/+$/, '')), item)
    }
    return { ok: true, childMap }
  } catch (e: any) {
    return { err: e instanceof Error ? e : new Error(String(e)) }
  }
}

/**
 * B 档复查：覆盖已存在远端文件 / 删除远端文件前，紧邻做一次 PROPFIND Depth 0，
 * 与扫描期指纹比对（etag 用统一的规范化比较——去引号、去 W/ 前缀；etag 缺任一侧时
 * 退化为 size 严格 + mtime 2000ms 容差）。不符 → 抛 REMOTE_CHANGED（放弃该文件并记录），
 * 下轮重新规划自然收敛。复查失败（网络 / 非 207）同样放弃：复查的目的就是保护，
 * 无法确认「远端未变」时按已变处理是唯一安全方向。远端已消失（gone）不算不符：
 * 覆盖语义下 PUT 本就是重建，删除语义下 DELETE 幂等达成目标状态。
 * @param cfg 配置 @param remoteAbs 远端绝对路径（相对服务器根）
 * @param scan 扫描期远端指纹 { etag, size, mtimeMs } @param rel 展示用相对路径
 */
export async function recheckRemoteUnchanged(cfg: EngineCfg, remoteAbs: string, scan: any, rel: string): Promise<any> {
  const changed = (why: any) => {
    throw mkOpError(remoteChangedMsg(rel, '暂未上传', true), 'REMOTE_CHANGED', { permanent: true, detail: why })
  }
  let props
  try {
    props = await remotePropsEx(cfg, remoteAbs)
  } catch (e: any) {
    throw mkOpError(remoteUnverifiableMsg(rel), 'REMOTE_CHANGED', { permanent: true, detail: (e && e.message) || e })
  }
  if (props.gone) return
  if (props.error) {
    throw mkOpError(remoteUnverifiableMsg(rel), 'REMOTE_CHANGED', { permanent: true, detail: props.error })
  }
  const p = props.props
  const se = normEtag(scan.etag)
  const pe = normEtag(p.etag)
  if (se && pe) {
    if (se !== pe) changed(`etag ${se} → ${pe}`)
    return
  }
  if (p.size !== scan.size) changed(`大小 ${scan.size} → ${p.size}`)
  if (scan.mtimeMs > 0 && p.mtime > 0 && Math.abs(scan.mtimeMs - p.mtime) > REMOTE_FP_TOL_MS) {
    changed(`mtime 偏差 ${Math.abs(scan.mtimeMs - p.mtime)}ms 超容差`)
  }
}
