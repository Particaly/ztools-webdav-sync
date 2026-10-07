/* eslint-disable */
// svc/excludes.mts —— 同步候选排除链（两侧共用的单一实现）：
//   五步排除链 isExcludedRel（SYNC_SKIP_NAMES → 引擎临时 → 内置垃圾 → 用户规则 →
//   ignoreHidden）与其全部构件（isHiddenRel / isJunkRel / compileExcludePatterns /
//   compileExactRels / compileSyncExcludes / isSyncTemp*）。安全不变量：本地侧
//   （scanDirSafe / scanDirtyFast）与远端侧（acceptRemoteItem 文件分支）必须走同一
//   份规则 —— 本模块是被两侧共同 import 的唯一实现，任何一侧独有例外都会造成
//   「一侧可见、另一侧不可见」的错误传播。纯函数域：零依赖。


/**
 * 历史版本功能（已不存在）存放在远端 / 本地同步目录内的状态文件名；
 * 保留扫描层排除仅为「用户把插件指到含残留文件的目录时不被同步下去」。
 */
const MANIFEST_NAME = '.webdav-sync.json'
const PENDING_NAME = '.webdav-sync-pending.json'
/**
 * 目录级租约锁文件名：位于远端同步根第一层，内容为 JSON
 * { v: 1, deviceId, startedAt, ttlMs }。本地与远端扫描层一律排除（远端在根、
 * rel 全等命中；与旧 manifest 同规则，与 ignoreHidden 取值无关）。
 */
export const LOCK_NAME = '.webdav-sync.lock'
/** 扫描层一律排除的同步系统文件（本地与远端同规则，与 ignoreHidden 取值无关） */
export const SYNC_SKIP_NAMES = new Set([MANIFEST_NAME, PENDING_NAME, LOCK_NAME])
/**
 * 同步引擎自身产生的临时文件名前缀。
 * .wdsync-dl- 为下载临时（downloadOne）；.wdsync-verify- 为内容消歧临时下载；
 * .wdsync-tmp- 为日志等其他临时写入；.wdsync-probe- 为能力探测在远端创建的探测
 * 目录 / 文件（探测放用户配置的远端根目录，必须被扫描排除以
 * 免干扰同步）。识别规则由扫描排除与启动期清理共用。
 */
export const SYNC_TMP_PREFIXES = ['.wdsync-dl-', '.wdsync-tmp-', '.wdsync-verify-', '.wdsync-probe-']
/** 判定相对路径中任一段是否为隐藏文件（点前缀；系统垃圾另行见 isJunkRel，两者独立判定） */
export function isHiddenRel(rel: string): boolean {
  return String(rel)
    .split('/')
    .some((seg) => seg.startsWith('.'))
}

// ---------- 跨平台默认排除 ----------
//
// 两层排除，均在扫描层生效（本地 scanDirSafe 与远端 listRemoteSafe 同规则），
// 决策层（decideAction）永远看不到被排除的条目：
//   1. 内置垃圾规则 isJunkRel —— 与 ignoreHidden 无关、用户不可关闭：这些是
//      OS / Office 的本机临时产物，不是用户业务文件；跨平台同步它们只会制造
//      垃圾传播、大小写冲突噪声与空目录清理误判；
//   2. 用户规则 compileExcludePatterns —— prefs.excludePatterns（glob，逐行），
//      默认空。模式含 '/' 时按完整 rel 匹配（可排除子树），否则对每一段名匹配。
//      仅支持 * 与 ?（* 不跨越 '/'），其余字符按字面；条数与长度设上限防误配。

/** 内置垃圾文件精确名（小写比较）：macOS Finder / Windows 资源管理器 / Office 的本机产物 */
const JUNK_EXACT = new Set([
  '.ds_store', // macOS Finder 目录元数据
  '.spotlight-v100', // macOS 索引卷标（外置盘根常见）
  '.trashes', // macOS 废纸篓卷目录
  'thumbs.db', // Windows 缩略图缓存
  'ehthumbs.db', // Windows 媒体缩略图缓存
  'desktop.ini', // Windows 文件夹定制配置（本机视角设置，跨机无意义）
])
/** 内置垃圾文件前缀：._*（AppleDouble，macOS 在非 HFS 卷 / SMB 上的资源分叉）与 ~$*（Office 所有者锁临时文件） */
const JUNK_PREFIXES = ['._', '~$']

/**
 * 判定相对路径是否命中内置垃圾规则（与 ignoreHidden 取值无关，任何一段命中即排除）。
 * 纯函数；本地与远端扫描共用同一份名单。
 */
export function isJunkRel(rel: string): boolean {
  return String(rel)
    .split('/')
    .some((seg) => {
      const low = seg.toLowerCase()
      return JUNK_EXACT.has(low) || JUNK_PREFIXES.some((p) => low.startsWith(p))
    })
}

/** 用户排除规则的数量与单条长度上限：防误配置把规则表变成正则炸弹 */
const EXCLUDE_PATTERN_MAX = 200
const EXCLUDE_PATTERN_LEN_MAX = 200

/**
 * 把一条 glob 编译为 RegExp（仅 * 与 ? 有特殊含义；* 不跨越 '/'）。
 * 无效输入（空 / 超长）返回 null，调用方跳过该条。
 */
function compileGlobPattern(pat: string): any {
  const p = String(pat == null ? '' : pat).trim()
  if (!p || p.length > EXCLUDE_PATTERN_LEN_MAX) return null
  let re = '^'
  for (const ch of p) {
    if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  try {
    return new RegExp(re + '$')
  } catch (_) {
    return null
  }
}

/**
 * 编译用户排除规则为一个匹配函数（纯函数，输入 patterns 数组）。
 * 返回 null 表示「无有效规则」（调用方零开销直通）。规则含 '/' → 匹配完整 rel；
 * 否则 → 对 rel 的每一段名匹配（与 isHiddenRel / isJunkRel 同粒度）。
 * @param {string[]} patterns glob 规则数组
 * @returns {((rel: string) => boolean) | null}
 */
export function compileExcludePatterns(patterns: string[] | null | undefined): ((rel: string) => boolean) | null {
  if (!Array.isArray(patterns) || patterns.length === 0) return null
  const full: any[] = []
  const seg: any[] = []
  for (const pat of patterns.slice(0, EXCLUDE_PATTERN_MAX)) {
    const re = compileGlobPattern(pat)
    if (!re) continue
    ;(String(pat).includes('/') ? full : seg).push(re)
  }
  if (full.length === 0 && seg.length === 0) return null
  return (rel) => {
    const s = String(rel || '')
    if (full.some((re) => re.test(s))) return true
    return seg.some((re) => s.split('/').some((name) => re.test(name)))
  }
}

/**
 * 勾选树「取消同步」的精确 rel 集合（渲染层选择性同步树落地到
 * dir.overrides.excludeRels，经 prefs.excludeRels 透传引擎）。与 glob 规则的
 * 差异：完全字面匹配（不做 * / ? 展开，文件名碰巧含通配符也不会误伤），子树
 * 语义由 selfOrAncestorMatch 的祖先命中承担。返回 null 表示「无条目」。
 */
export function compileExactRels(rels: string[] | null | undefined): Set<string> | null {
  if (!Array.isArray(rels) || rels.length === 0) return null
  const set = new Set<string>()
  for (const r of rels) {
    const s = String(r == null ? '' : r)
    if (s && s !== '.' && s !== '/' && s.length <= EXCLUDE_PATTERN_LEN_MAX) set.add(s)
  }
  return set.size ? set : null
}

/**
 * 「自身或任一祖先命中」包装：把一个匹配函数升级为「rel 本身或其任一祖先目录
 * rel 命中即排除」。两层意义：
 *   1. 勾选树精确 rel（compileExactRels）的子树语义 —— 取消勾选目录即整棵子树
 *      不上行也不下行；
 *   2. 修正 Depth:infinity 形态下全路径 glob（含 '/'）不排除后代的不一致：
 *      逐目录形态靠「目录未入表 ⇒ 不入队递归」天然剪枝，单请求形态逐条目判定
 *      时曾只匹配条目自身 —— 同一份规则在两种扫描形态下结果应当一致（祖先链
 *      逐段上溯后过同一匹配函数，段级 glob 的既有行为不变 —— 它本就逐段命中）。
 */
function selfOrAncestorMatch(match: (rel: string) => boolean): (rel: string) => boolean {
  return (rel: string) => {
    let cur = String(rel || '')
    for (;;) {
      if (match(cur)) return true
      const i = cur.lastIndexOf('/')
      if (i < 0) return false
      cur = cur.slice(0, i)
    }
  }
}

/**
 * 本轮生效的排除匹配器（单一出口，两侧扫描共用）：用户 glob 规则
 *（prefs.excludePatterns，compileExcludePatterns 口径）+ 勾选树精确 rel
 *（prefs.excludeRels），二者任一命中（含祖先目录命中，见 selfOrAncestorMatch）
 * 即排除。null = 无任何规则（零开销直通）。
 */
export function compileSyncExcludes(patterns: string[] | null | undefined, exactRels: string[] | null | undefined): ((rel: string) => boolean) | null {
  const glob = compileExcludePatterns(patterns)
  const exact = compileExactRels(exactRels)
  if (!glob && !exact) return null
  return selfOrAncestorMatch((rel) => (glob ? glob(rel) : false) || (exact ? exact.has(String(rel || '')) : false))
}

/**
 * 判定文件名是否为同步引擎自身产生的临时文件（下载临时 / 消歧临时下载 / 日志临时写入）。
 * 临时文件一律不允许进入同步候选集合：扫描层在 ignoreHidden 判定之前先做本检查，
 * 因此 ignoreHidden=false 时同样被排除 —— 临时文件不是用户业务文件。
 * 命名空间（.wdsync-dl- / .wdsync-verify- / .wdsync-tmp-）由引擎独占使用。
 */
export function isSyncTempName(name: string): boolean {
  return SYNC_TMP_PREFIXES.some((p) => String(name).startsWith(p))
}

/** 同 isSyncTempName，但作用于相对路径的任意一段（子目录中的残留同样排除） */
export function isSyncTempRel(rel: string): boolean {
  return String(rel)
    .split('/')
    .some(isSyncTempName)
}

/**
 * 同步候选的完整排除链（五步，次序固定）：SYNC_SKIP_NAMES（同步系统自身文件）→
 * isSyncTempRel（引擎临时）→ isJunkRel（内置垃圾）→ excludeMatcher（用户排除
 * 规则）→ ignoreHidden（隐藏文件）。前四步与 ignoreHidden 无关：系统文件 / 临时 /
 * 垃圾不是用户业务文件，用户规则是显式意图，ignoreHidden=false 时同样排除。
 * 安全不变量：本地侧（scanDirSafe / scanDirtyFast）与远端侧（acceptRemoteItem
 * 文件分支）必须走同一规则 —— 任一侧独有例外都会造成「一侧可见、另一侧不可见」，
 * 单侧可见的条目会被误判为新增 / 删除而错误传播。刻意不走本链的位置：acceptRemoteItem
 * 的目录分支少 SYNC_SKIP_NAMES 一步（那是文件名集合，不适用于目录）；规划层
 * （runSyncRound）只查 excludeMatcher（扫描层已挡过、基线残留的出清判定，见该处注释）。
 */
export function isExcludedRel(rel: string, opts: { ignoreHidden: boolean; excludeMatcher?: ((rel: string) => boolean) | null }): boolean {
  if (SYNC_SKIP_NAMES.has(rel)) return true
  if (isSyncTempRel(rel)) return true
  if (isJunkRel(rel)) return true
  if (opts.excludeMatcher && opts.excludeMatcher(rel)) return true
  return opts.ignoreHidden && isHiddenRel(rel)
}
