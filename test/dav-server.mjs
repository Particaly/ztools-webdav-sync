/**
 * 迷你 WebDAV 服务器：仅用于本地端到端测试同步引擎。
 * 支持 OPTIONS / PROPFIND(depth 0/1/infinity) / GET / PUT / MKCOL / DELETE / MOVE。
 * 用法：node test/dav-server.mjs [port] [rootDir]
 *
 * 行为开关分两类（均放 ROOT 下标记文件，用完删除）：
 *
 * 一、单行为标记（历史机制，既有用例继续使用）：
 *   .wdsync-test-noetag     —— 服务器不提供 etag（指纹噪声 / 内容消歧用例）
 *   .wdsync-test-redirect   —— 对集合类 PROPFIND 的无尾斜杠路径返回 301 + Location（同源加尾
 *                              斜杠），验证引擎的重定向跟随与集合 URL 尾斜杠规范化
 *   .wdsync-test-ratelimit  —— 前 RL_MAX 次 PUT/GET 返回 429 + Retry-After: 1，之后放行
 *                              （验证 429 重试生效、同步最终成功）；会拖慢整轮 e2e，用完立即删
 *   .wdsync-test-xmlstyle   —— multistatus 输出风格切换（文件内容选档），验证解析器容错：
 *                              d     —— 小写 d: 前缀 + 原始文件名（# 编码为 %23）
 *                              plain —— 无前缀（默认命名空间）
 *                              cdata —— d: 前缀 + CDATA 包裹的原始 href
 *                              entity—— d: 前缀 + 十进制数字实体（&#233;）+ &amp;
 *                              hex   —— d: 前缀 + 十六进制数字实体（&#xE9;）+ &amp;（saxes 用例）
 *                              cdataetag —— d: 前缀 + CDATA 包裹的 getetag（saxes 用例）
 *                              pct   —— d: 前缀 + href 全量百分号编码（%23/%20/UTF-8 字节）
 *   .wdsync-test-midair     —— 「规划后、执行前远端被改」竞态注入（内容选触发点）：
 *                              put     —— 收到目标文件 PUT 时先把远端内容改写为「对端新版本」
 *                                         再评估条件头（A 档 If-Match 必 412；P7 类忽略条件头的服务器
 *                                         会照常覆盖 —— 用于记录静默忽略的后果）
 *                              propfind—— 收到目标文件 Depth:0 PROPFIND 时先改写内容再应答
 *                                         （B 档引擎的「执行前复查」恰好用 Depth:0，必然被拦下）
 *                              目标文件 = 路径 basename 含 'midair'；每文件只触发一次（一次性钩子）。
 *                              注意不采用点前缀（.midair）：e2e 默认 ignoreHidden=true，点开头文件
 *                              进不了扫描候选，钩子永远不会被触发。
 *
 * saxes / 按路径写权限 / 熔断相关标记：
 *   .wdsync-test-badxml     —— multistatus 畸形注入（内容选档，全部 PROPFIND 应答）：
 *                              truncate —— 响应体在条目中间截断（HTTP 分帧完整、XML 不完整）
 *                              unclosed —— 缺少闭合标签（</response> 与 </multistatus>）
 *                              badentity—— href 含未定义实体 &fakeent;
 *                              验证点：引擎必须把扫描判 incomplete（绝不静默返回部分结果→误删）。
 *   .wdsync-test-bigxml     —— 内容为数字 N：对名为 bigxml 的目录 PROPFIND 返回 N 条合成条目
 *                              （不落盘真实文件；含中文名 / %23 名 / 固定 etag），用于 5 万条目
 *                              大响应的解析耗时 / 内存验证。
 *   .wdsync-test-captheaders—— 把 PUT/DELETE 收到的 If-Match / If-None-Match 追加记录到
 *                              .wdsync-test-captheaders.log（每行 `METHOD path | IM=x | INM=y`），
 *                              用于断言 A 档条件头的取值来源。
 *   .wdsync-test-err503     —— 一切 PUT 返回 503（无 Retry-After）：整轮熔断用例。
 *   .wdsync-test-ro-subpaths—— 内容为逗号分隔的只读子路径前缀（相对 ROOT）：其下的
 *                              PUT/DELETE/MKCOL/MOVE 一律 403（按路径写权限用例）。
 *   .wdsync-test-mkcolfail  —— 内容为状态码：MKCOL 一律返回该状态（非权限性失败分类用例，
 *                              如 409 —— 不得把目录按 C 档缓存 7 天）。
 * 永久失败退避 / 瞬时失败当轮重试相关标记：
 *   .wdsync-test-fail413   —— PUT 到路径含 .toolarge 的资源一律 413（永久失败：引擎应
 *                              记入失败退避表并按指数退避跳过，避免每轮撞墙）。
 *   .wdsync-test-fail423   —— 每个 PUT 路径**第一次**返回 423（无 Retry-After），之后
 *                              放行（瞬时失败：当轮重试后应收敛，轮次不报错）。
 *   .wdsync-test-fail423x  —— 内容为次数 N（缺省 4）：每个 PUT 路径**前 N 次**返回 423
 *                              （无 Retry-After），之后放行；启用跳变（禁用 → 启用）时
 *                              清空路径计数（仿 fail423 的记忆模式）。N 超过网络层最大
 *                              重试次数（3）时网络层重试耗尽、以终态 423 抛回引擎，
 *                              驱动引擎级当轮重试循环真实生效（e2e TR1 用例）。
 * 上传按目录批量校验相关标记：
 *   .wdsync-test-reqlog    —— 存在时把每个请求追加一行 `METHOD urlPath` 到
 *                              .wdsync-test-reqlog.log（同步追加，模式仿 captheaders），
 *                              供 e2e 断言「上传后不再有针对文件路径的 PROPFIND」。
 *   .wdsync-test-vanish    —— PROPFIND 目标路径含 'vanish' 时，响应里剔除名为
 *                              gone.vanish.txt 的条目（模拟「上传成功但列表看不到」的
 *                              批量校验失败路径：文件报错、无基线、轮次 error）。
 *
 * 目录级租约锁相关标记：
 *   .wdsync-test-locksteal —— PUT 到路径以 .webdav-sync.lock 结尾时，服务器**落盘后**
 *                              把内容改写为 {"v":1,"deviceId":"peer-device-x",...}（模拟
 *                              写回竞争失败：引擎 1.5s 后回读到别人的 deviceId 应让出）。
 *   .wdsync-test-delefail —— DELETE 一律 500（释放失败 → 左锁记录 → 下轮清理链路；
 *                              注意会让轮内 delete-remote 也失败，用例目录设计避免远端删除）。
 *
 * B 档新上传写前查重相关标记：
 *   .wdsync-test-dedupfail —— 内容为状态码（缺省 503）：路径含 'dedupfail' 的 Depth:1
 *                              目录列举从**第 2 次**起返回该状态码（每路径计数；标记重新
 *                              启用跳变时计数清空，与限流 / 423 标记同模式）。引擎对同一
 *                              目录的第 1 次 Depth:1 列举是扫描（通过）、第 2 次是写前查重
 *                              （失败）—— 用于验证「查重请求失败时不盲目裸 PUT」。
 *
 * 取消中断在途传输相关标记：
 *   .wdsync-test-throttle —— 内容为每块延迟毫秒数（缺省 5；路径含 'throttle' 的 GET
 *                              响应与 PUT 请求体按 64KB 块节流）：把大文件传输拉长到
 *                              秒级，制造「传一半」的取消窗口。PUT 默认仍在**收完全部
 *                              请求体后**才一次性落盘；「半截保留」由 partialput 标记开启。
 *   .wdsync-test-reqlog    —— 既有标记扩展：客户端中途销毁连接（响应未写完即 close）
 *                              时追加一行 `!ABORT METHOD urlPath`，供取消用例断言
 *                              「服务器侧观察到请求被中断」。
 *
 * 半截上传识别与自动重传相关标记：
 *   .wdsync-test-partialput —— 开启后 PUT **边收边落盘**（非原子）：客户端中途取消 /
 *                              连接中断时已收字节保留为目标文件的半截内容（模拟
 *                              Apache mod_dav 类直写目标的服务器；不开启则维持「收完
 *                              才落盘、中断全丢弃」的原子语义）。
 *   .wdsync-test-netcut   —— 内容为 `N` 或 `N:M`：收到第 N 块请求体后**主动销毁连接**
 *                              （不回任何响应）—— 客户端以 NETWORK 类错误收场（区别于
 *                              用户取消的 ABORTED）；M 为每路径最多切断次数（缺省不限）。
 *                              与 partialput 叠用时半截字节保留；单独使用时中断的 PUT
 *                              不落任何字节（原子服务器 + 网络中断）。
 *   .wdsync-test-getfail  —— 内容为路径子串：命中的 GET 一律 404（无重试成本的
 *                              「GET 失败」，用于采纳确认失败回退用例）。
 *
 * 跨平台文件名相关标记：
 *   .wdsync-test-casepair —— 内容为文件名（如 pair.txt）：目录列举（Depth ≥ 1）发现
 *                              该文件时，额外**虚拟**列出首字母大小写翻转的孪生条目
 *                              （Pair.txt，size+1、独立 etag）。模拟 Linux 类大小写敏感
 *                              服务器上「同目录仅大小写不同的两个文件」—— 宿主文件系统
 *                              （macOS/Windows）无法真实落盘两个。虚拟条目仅存在于
 *                              PROPFIND 应答：对它的 GET/PUT/DELETE 走默认 404（引擎
 *                              正常应跳过它们，任何访问都是行为泄漏，测试据此断言）。
 *
 * Depth:infinity 单请求扫描相关标记：
 *   .wdsync-test-noinfinity —— 对一切 Depth:infinity PROPFIND 返回 403（与 profile
 *                              无关）：模拟「能力缓存称支持、服务器实际拒绝」—— 引擎
 *                              必须回落逐目录扫描而不是把轮次判失败。
 *   .wdsync-test-shallowinf —— 对 Depth:infinity PROPFIND 返回 207 但**只列第一层**
 *                              （与 Depth:1 同应答）：模拟「服务器忽略 Depth 头」。
 *                              探测期命中 → depthInfinity 必须判 false（嵌套探测文件
 *                              验证）；同步期命中（缓存已先行落定）→ 引擎的浅响应
 *                              阀门必须把扫描判不完整（零删除），并持久降级能力缓存
 *                              使下一轮改用逐目录形态。
 *   .wdsync-test-root404prop —— 缺失路径的 PROPFIND 改回「207 + 集合自身 404
 *                              propstat」（不回 HTTP 404 状态）：模拟部分网关对缺失
 *                              集合的应答形态。引擎的根探测归一与两种扫描形态都
 *                              必须识别并路由到根丢失决策链。
 *   .wdsync-test-depthlog  —— 存在时把每个 PROPFIND 追加一行 `DEPTH inf|N urlPath`
 *                              到 .wdsync-test-depthlog.log（与 reqlog 同模式；单独
 *                              成日志是因为 reqlog 的既有断言按整行精确匹配请求行，
 *                              不能改格式），供断言「扫描是一次 infinity 请求还是
 *                              逐目录 N 次」。
 *
 * 集合 etag 深层传播相关标记：
 *   .wdsync-test-etagprop   —— 集合条目的 etag 改为递归聚合（树内所有文件 mtimeMs 最大值
 *                              + 树内文件总数；文件条目 etag 保持既有口径不变）：任何深度
 *                              文件的写入 / 新增 / 删除都会改变所有祖先集合的 etag，树无
 *                              变化时值稳定 —— 能力探测据此判 etagPropagation=true。默认档
 *                              集合条目不输出 etag（无值可观测，探测自然判 false）。
 *                              内容为 'shallow' 时聚合只覆盖**直接子文件**（深层写入只改
 *                              本集合 etag、不再影响祖先集合）—— 模拟「服务器侧停止深层
 *                              传播」（能力缓存仍称 true 的界内滞后场景，ES1 e/f 用例）；
 *                              其余 / 空内容 = 全递归。
 *
 * 二、档位矩阵标记：.wdsync-test-profile，内容为档位名。
 * 选择「单个 profile 标记文件」而非继续堆叠单行为标记的理由：P 档是多种行为的组合预设，
 * 档位间切换要求一次原子生效（多个标记文件的写入顺序会让中间态落入错误档位），且单个
 * 文件名可读性更好；既有单行为标记保留，与 profile 叠加时取并集（noetag 与 p2 等价叠加无冲突）。
 *   p1（缺省默认档）—— 全功能：内容哈希强 etag（同内容重传 etag 稳定）、条件请求生效
 *                      （If-Match / If-None-Match 严格评估，PUT 与 DELETE 一致）、
 *                      Depth: infinity 返回 403（多数服务器的保守默认）。
 *                      注：默认档 etag 由 mtime 型（"size-mtimeMs"）改为内容哈希型 —— mtime 型在同
 *                      内容重传时必然变化，会让 P1「强 etag 服务器」的探测误报 etag 不稳定。
 *   p2（nginx 风格） —— 无 etag、静默忽略条件头（照常 2xx）、getlastmodified 捨到整秒。
 *   p3（弱 etag）   —— etag 带 W/ 前缀 + 条件请求生效。弱 etag 时 If-Match 的服务器行为按
 *                      RFC 7232 强比较语义：含弱 etag 的 If-Match 一律不匹配 → 412（比「忽略
 *                      条件头」更接近真实弱 etag 服务器，也更严格）。
 *   p4（重定向）    —— 集合无尾斜杠返回 301（复用 redirect 行为）。
 *   p5（限流）      —— 429/503 + Retry-After（复用 ratelimit 行为）。
 *   p6（异步指纹）  —— PUT 完成后（响应已发出）立即改写 mtime/etag：下一次 PROPFIND 看到的
 *                      指纹与 PUT 响应时不同。etag 因此为「内容 + mtime」组合（mtime 参与才可观测）。
 *   p7（静默忽略）  —— 条件头被忽略照常 2xx（引擎必须探测出 conditional=false → B 档）。
 *   p8（只读）      —— PUT / DELETE / MKCOL / MOVE 一律 403（C 档 download-only）。
 *   p9（递归列举）  —— PROPFIND Depth: infinity 返回递归 multistatus（其余同 p1）。
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const port = Number(process.argv[2]) || 5360
const ROOT = process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), '.dav-root')
fs.mkdirSync(ROOT, { recursive: true })

const HREF_ROOT = '/dav/'
/** 限流档位：前 N 次 PUT/GET 拒绝（N 取 3：恰好等于引擎的最大重试次数，第 4 次放行） */
const RL_MAX = 3
let rlHits = 0
/**
 * 限流启用状态（跨请求记忆）：同一服务器进程会先后服务多个限流用例（RL 系列 / P5 档），
 * 标记重新启用（禁用 → 启用的跳变）时重置预算 —— 与「新起一个进程」的语义对齐，
 * 否则第二个限流用例永远等不到 429。
 */
let rlWasEnabled = false

/** 读取档位标记内容（存在才生效；内容为空时按 'x' 处理） */
function flagContent(name) {
  try {
    return fs.readFileSync(path.join(ROOT, name), 'utf-8').trim() || 'x'
  } catch {
    return null
  }
}

const hasFlag = (name) => fs.existsSync(path.join(ROOT, name))

// ---- 档位行为推导：profile 是单行为标记的组合预设 ----
const profile = () => flagContent('.wdsync-test-profile') || 'p1'
const noetag = () => hasFlag('.wdsync-test-noetag') || profile() === 'p2'
const weakEtagServed = () => profile() === 'p3'
const ignoreConditional = () => profile() === 'p2' || profile() === 'p7'
const readOnly = () => profile() === 'p8'
const secondMtime = () => profile() === 'p2'
const depthInfinityAllowed = () => profile() === 'p9'
const redirectEnabled = () => hasFlag('.wdsync-test-redirect') || profile() === 'p4'
const ratelimitEnabled = () => hasFlag('.wdsync-test-ratelimit') || profile() === 'p5'
const churnAfterPut = () => profile() === 'p6'
const midairMode = () => flagContent('.wdsync-test-midair') // 'put' | 'propfind' | null
// ---- saxes / 按路径写权限 / 熔断标记 ----
const badxmlMode = () => flagContent('.wdsync-test-badxml') // 'truncate' | 'unclosed' | 'badentity'
const bigxmlN = () => Number(flagContent('.wdsync-test-bigxml')) || 0
const capHeadersOn = () => hasFlag('.wdsync-test-captheaders')
const err503On = () => hasFlag('.wdsync-test-err503')
const roSubpaths = () => String(flagContent('.wdsync-test-ro-subpaths') || '').split(',').map((s) => s.trim()).filter(Boolean)
const mkcolFailStatus = () => Number(flagContent('.wdsync-test-mkcolfail')) || 0
// ---- 永久失败退避 / 瞬时失败当轮重试标记 ----
const fail413On = () => hasFlag('.wdsync-test-fail413')
const fail423On = () => hasFlag('.wdsync-test-fail423')
/** fail423x 档（TR1）：内容为每路径失败次数 N（缺省 4）；标记不存在返回 0（关闭） */
const fail423xN = () => {
  const raw = flagContent('.wdsync-test-fail423x')
  if (raw == null) return 0
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4
}
// ---- 上传按目录批量校验标记 ----
const reqlogOn = () => hasFlag('.wdsync-test-reqlog')
const vanishOn = () => hasFlag('.wdsync-test-vanish')
// ---- 目录级租约锁标记 ----
const lockStealOn = () => hasFlag('.wdsync-test-locksteal')
const deleFailOn = () => hasFlag('.wdsync-test-delefail')
// ---- B 档新上传写前查重标记 ----
const dedupFailStatus = () => Number(flagContent('.wdsync-test-dedupfail')) || 0
// ---- 取消中断在途传输标记 ----
/** 节流延迟（毫秒 / 64KB 块）：0 = 关闭；仅对路径含 'throttle' 的 GET / PUT 生效 */
const throttleMs = () => Number(flagContent('.wdsync-test-throttle')) || 0
// ---- 半截上传识别与自动重传标记 ----
/** PUT 边收边落盘（非原子：中断时已收字节保留为半截文件） */
const partialPutOn = () => hasFlag('.wdsync-test-partialput')
/** netcut 档：收到第 N 块请求体后主动销毁连接（客户端以 NETWORK 收场）；返回 [N, maxHitsPerPath] */
const netcutSpec = () => {
  const raw = flagContent('.wdsync-test-netcut')
  if (raw == null) return [0, Infinity]
  const [nRaw, mRaw] = raw.split(':').map((s) => Number(s.trim()))
  const n = Number.isFinite(nRaw) && nRaw > 0 ? Math.floor(nRaw) : 2
  const m = Number.isFinite(mRaw) && mRaw > 0 ? Math.floor(mRaw) : Infinity
  return [n, m]
}
/** getfail 档：命中的 GET 一律 404（路径子串匹配） */
const getfailSubstring = () => flagContent('.wdsync-test-getfail')
/** casepair 档：目录列举发现同名文件时额外虚拟列出首字母大小写翻转的孪生条目 */
const casepairName = () => flagContent('.wdsync-test-casepair')
// ---- Depth:infinity 单请求扫描标记 ----
/** noinfinity：一切 Depth:infinity PROPFIND 一律 403（模拟能力缓存过期的服务器拒绝） */
const noInfinityOn = () => hasFlag('.wdsync-test-noinfinity')
/** shallowinf：Depth:infinity 请求按 Depth:1 应答（模拟忽略 Depth 头、只回第一层） */
const shallowInfOn = () => hasFlag('.wdsync-test-shallowinf')
/** root404prop：缺失路径的 PROPFIND 不回 HTTP 404，改回 207 + 集合自身 404 propstat
 *  （模拟部分网关对缺失集合的应答形态 —— 引擎的根探测归一与扫描层识别用例） */
const root404PropOn = () => hasFlag('.wdsync-test-root404prop')
/** depthlog：把每个 PROPFIND 的深度记入独立日志（inf | 数字） */
const depthLogOn = () => hasFlag('.wdsync-test-depthlog')
// ---- 集合 etag 深层传播标记 ----
/** etagprop：集合条目的 etag 改为树内聚合（深层传播形态；文件条目 etag 不受影响） */
const etagPropOn = () => hasFlag('.wdsync-test-etagprop')
/** etagprop 的 shallow 变体：聚合只覆盖直接子文件 —— 深层写入不再传播到祖先集合（模拟服务器停止深层传播） */
const etagPropShallow = () => flagContent('.wdsync-test-etagprop') === 'shallow'
/** 记录一次 PROPFIND 深度（depthlog 档）：行格式 `DEPTH inf urlPath` / `DEPTH 1 urlPath`（infinity 归一化为 inf） */
function logDepth(depthRaw, urlPath) {
  if (!depthLogOn()) return
  try {
    fs.appendFileSync(path.join(ROOT, '.wdsync-test-depthlog.log'), `DEPTH ${depthRaw === 'infinity' ? 'inf' : depthRaw} ${urlPath}\n`)
  } catch {
    /* 记录失败不影响服务 */
  }
}
/**
 * netcut 的每路径切断计数：urlPath → 已切断次数（达到 maxHits 后该路径放行）。
 * 与限流预算同理，标记重新启用（禁用 → 启用跳变）时清空。
 */
const netcutHits = new Map()
let netcutWasOn = false
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/**
 * dedupfail 的每路径 Depth:1 列举计数：urlPath → 已见次数（≥2 起返回注入状态码）。
 * 与限流预算同理，标记重新启用（禁用 → 启用跳变）时清空 —— 同一服务器进程先后服务
 * 多个用例，每个用例都应从「第 1 次列举 = 扫描（放行）」重新开始。
 */
const pfFailHits = new Map()
let dedupFailWasOn = false
/**
 * 423 一次性失败的记忆：已吃过一次 423 的 PUT 路径集合（之后放行）。
 * 与限流预算同理，标记重新启用（禁用 → 启用跳变）时清空 —— 同一服务器进程先后服务
 * 多个 fail423 用例，每个用例都应从「每个路径第一次 423」重新开始。
 */
const lock423Hit = new Set()
let lock423WasEnabled = false
/**
 * fail423x 的每路径失败计数：urlPath → 已返回 423 的次数（达到 N 后放行）。
 * 与 lock423Hit 同理，标记重新启用（禁用 → 启用跳变）时清空 —— 同一服务器进程先后
 * 服务多个 fail423x 用例，每个用例都应从「每个路径前 N 次 423」重新开始。
 */
const lock423xHits = new Map()
let lock423xWasEnabled = false
/** urlPath → 相对 ROOT 的解码路径（只读子路径匹配用；坏百分号按原值） */
function relOfUrl(urlPath) {
  let rel
  if (urlPath === HREF_ROOT.slice(0, -1)) rel = ''
  else if (urlPath.startsWith(HREF_ROOT)) rel = urlPath.slice(HREF_ROOT.length)
  else rel = urlPath.replace(/^\//, '')
  try {
    return decodeURIComponent(rel)
  } catch {
    return rel
  }
}
/** 请求目标是否落在只读子路径下（写方法将被 403） */
function roSubpathHit(urlPath) {
  const rel = relOfUrl(urlPath)
  return roSubpaths().some((p) => rel === p || rel.startsWith(p.endsWith('/') ? p : p + '/'))
}
/** 记录一次写请求的条件头（captheaders 档）：供 e2e 断言 If-Match / If-None-Match 取值；
 *  AUTH 一并落日志（测试工件，非引擎输出）—— 供凭据链路用例断言「解密后的密码正确送达网络层」 */
function logCapHeaders(req, urlPath) {
  if (!capHeadersOn()) return
  try {
    fs.appendFileSync(
      path.join(ROOT, '.wdsync-test-captheaders.log'),
      `${req.method} ${urlPath} | IM=${req.headers['if-match'] ?? '-'} | INM=${req.headers['if-none-match'] ?? '-'} | AUTH=${req.headers.authorization ?? '-'}\n`
    )
  } catch {
    /* 记录失败不影响服务 */
  }
}

/**
 * 请求日志（reqlog 档）：把每个请求追加一行 `METHOD urlPath` 到
 * .wdsync-test-reqlog.log（同步追加，模式仿 logCapHeaders）。供 e2e 断言上传改为按目录
 * 批量校验后「不再有针对单个文件路径的 PROPFIND」—— 用完删除标记与日志文件。
 * 取消中断在途传输扩展：客户端中途销毁连接（响应未写完即 close）时
 * 追加一行 `!ABORT METHOD urlPath`，供取消用例断言服务器侧确实观察到请求被中断。
 */
function logReq(req, urlPath, res) {
  if (!reqlogOn()) return
  try {
    fs.appendFileSync(path.join(ROOT, '.wdsync-test-reqlog.log'), `${req.method} ${urlPath}\n`)
    res.on('close', () => {
      // writableEnded=false：响应未写完就断开 = 客户端主动销毁了连接（正常完成不会命中）
      if (!res.writableEnded) {
        try {
          fs.appendFileSync(path.join(ROOT, '.wdsync-test-reqlog.log'), `!ABORT ${req.method} ${urlPath}\n`)
        } catch {
          /* 记录失败不影响服务 */
        }
      }
    })
  } catch {
    /* 记录失败不影响服务 */
  }
}

/** 依输出风格生成带命名空间前缀的标签名：默认 D:、xmlstyle 档位 d:、plain 档位无前缀 */
function tagOf(style) {
  if (style === 'plain') return (t) => t
  if (style) return (t) => `d:${t}`
  return (t) => `D:${t}`
}

/** 将 URL path 映射到本地文件（限制在 ROOT 内）。'/dav'（无尾斜杠的集合根）与 '/dav/' 指向同一集合 */
function toLocal(urlPath) {
  let rel
  if (urlPath === HREF_ROOT.slice(0, -1)) rel = ''
  else if (urlPath.startsWith(HREF_ROOT)) rel = urlPath.slice(HREF_ROOT.length)
  else rel = urlPath.replace(/^\//, '')
  let decoded
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    decoded = rel // 坏百分号序列：按原值处理（不让单个坏路径炸掉整个请求）
  }
  const abs = path.resolve(ROOT, '.' + path.sep + decoded)
  if (!abs.startsWith(path.resolve(ROOT))) return null
  return abs
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ---- 内容哈希 etag（带缓存：同 size+mtime 不重复读盘） ----
const etagCache = new Map()

/** 计算文件内容 sha1 前 16 hex（按 size+mtimeMs 缓存，避免 PROPFIND 全目录时反复读盘） */
async function contentHash(abs, st) {
  const key = `${st.size}:${Number(st.mtimeMs)}`
  const c = etagCache.get(abs)
  if (c && c.key === key) return c.h
  const buf = await fsp.readFile(abs)
  const h = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)
  etagCache.set(abs, { key, h })
  return h
}

/**
 * 生成某文件的当前 etag（空串 = 该档位不提供 etag）。
 *   默认 / p4 / p5 / p7 / p8 / p9：内容哈希（同内容重传稳定 —— 全功能服务器的探测口径）；
 *   p3：内容哈希 + W/ 弱前缀；p6：内容哈希 + mtime（PUT 后 mtime 被异步改写 → etag 随之变）。
 */
async function etagFor(abs, st) {
  if (noetag()) return ''
  const h = await contentHash(abs, st)
  const body = churnAfterPut() ? `${st.size}-${h}-${Number(st.mtimeMs)}` : `${st.size}-${h}`
  return weakEtagServed() ? `W/"${body}"` : `"${body}"`
}

/**
 * 生成某集合的聚合 etag ——「参与文件 mtimeMs 最大值 - 参与文件总数」。
 * depthLimit = Infinity（默认 / etagprop 全递归档）：参与文件为树内**所有**文件，
 * 任何深度文件的写入（mtime 前进）/ 新增 / 删除（计数变化）都会改变所有祖先集合的
 * 该聚合值，树无变化时值稳定 —— 用于能力探测判 etagPropagation。
 * depthLimit = 1（etagprop 'shallow' 档）：参与文件仅为**直接子**文件 —— 深层写入
 * 只改变所在集合自身的 etag，不再影响祖先集合（模拟「服务器停止深层传播」，
 * 能力缓存仍称 true 时的界内滞后场景）。
 * 刻意不缓存：POSIX 目录 mtime 只在直接子项增删改名时变化，以目录 mtime 为键的
 * 缓存会漏掉深层写入（恰恰是要模拟的行为）；测试目录规模小，直接重算最简单也最可靠。
 */
async function collectionEtagAgg(abs, depthLimit = Infinity) {
  let maxMtime = 0
  let count = 0
  const walk = async (dir, depth) => {
    const list = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const ent of list) {
      const st = await fsp.stat(path.join(dir, ent.name)).catch(() => null)
      if (!st) continue
      if (st.isDirectory()) {
        if (depth < depthLimit) await walk(path.join(dir, ent.name), depth + 1)
      } else {
        count++
        if (Number(st.mtimeMs) > maxMtime) maxMtime = Number(st.mtimeMs)
      }
    }
  }
  await walk(abs, 1)
  return `"${maxMtime}-${count}"`
}

/** etag 规范化（与引擎 normEtag 同口径：去 W/ 前缀、去引号；仅用于相等比较） */
const normTag = (s) => String(s == null ? '' : s).trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1')

/**
 * 评估 If-Match（强比较语义，RFC 7232）。
 * cur 为服务器当前 etag（可能是弱 etag）；含弱 etag 的 If-Match 一律不匹配（p3 档行为），
 * '*' 仅要求资源存在。返回 true = 条件满足可继续。
 */
function ifMatchSatisfied(header, cur, exists) {
  const tags = String(header).split(',').map((s) => s.trim())
  if (!exists) return false
  if (tags.includes('*')) return true
  if (tags.some((t) => /^W\//i.test(t))) return false // 弱 etag 不参与 If-Match 强比较
  return tags.some((t) => normTag(t) === normTag(cur))
}

/** 评估 If-None-Match（弱比较语义：去 W/ 后按字面比较）；'*' 表示「存在即失败」 */
function ifNoneMatchSatisfied(header, cur, exists) {
  const tags = String(header).split(',').map((s) => s.trim())
  if (!exists) return false
  if (tags.includes('*')) return true
  return tags.some((t) => normTag(t) === normTag(cur))
}

/**
 * midair 竞态钩子（一次性 / 每文件）：把远端文件内容改写为「对端新版本」，
 * 模拟「规划后、执行前远端被对端修改」。只在 basename 含 midair 的文件上触发。
 */
const midairDone = new Set()
async function midairMutate(abs) {
  const mode = midairMode()
  if (!mode || midairDone.has(abs)) return
  if (!path.basename(abs).includes('midair')) return
  midairDone.add(abs)
  try {
    const prev = await fsp.readFile(abs)
    await fsp.writeFile(abs, Buffer.concat([Buffer.from('MIDAIR-PEER-EDIT-'), prev]))
  } catch {
    /* 文件不存在等：钩子无操作 */
  }
}

async function entryXml(href, st, style, abs) {
  const isDir = st.isDirectory()
  const tag = tagOf(style)
  // href 文本按档位切换（解析容错用例）。注意 # 在 RFC 3986 中是 fragment 分隔符，
  // 服务器必须编码为 %23（否则客户端 URL 解析会截断），因此所有显式档位都做 # → %23；
  // 默认档位（无标记）保持原始输出不动，避免影响其他既有用例
  let hrefText
  if (style === 'pct') {
    hrefText = href.split('/').map(encodeURIComponent).join('/')
  } else if (style === 'cdata') {
    hrefText = `<![CDATA[${href.replace(/#/g, '%23')}]]>`
  } else if (style === 'entity') {
    hrefText = Array.from(href)
      .map((ch) => {
        if (ch === '#') return '%23'
        if (ch === '&') return '&amp;'
        if (ch === '<') return '&lt;'
        if (ch === '>') return '&gt;'
        if (ch === '"') return '&quot;'
        return ch > '\x7f' ? `&#${ch.codePointAt(0)};` : ch
      })
      .join('')
  } else if (style === 'hex') {
    // 十六进制数字实体（&#xE9; / &#x4E2D;）：saxes 解码用例
    hrefText = Array.from(href)
      .map((ch) => {
        if (ch === '#') return '%23'
        if (ch === '&') return '&amp;'
        return ch > '\x7f' ? `&#x${ch.codePointAt(0).toString(16)};` : ch
      })
      .join('')
  } else if (style) {
    hrefText = escapeXml(href.replace(/#/g, '%23'))
  } else {
    hrefText = escapeXml(href)
  }
  // getlastmodified 精度按档位切换：默认档输出 ISO-8601（含毫秒 —— 少数服务器的高精度形态，
  // 用于区分 mtime 精度探测）；p2 档输出 IMF-fixdate 并捨到整秒（HTTP 标准日期只有秒级）。
  // 引擎 Date.parse 两种格式都能解析。
  const lmDate = secondMtime() ? new Date(Math.floor(st.mtimeMs / 1000) * 1000) : st.mtime
  const lm = secondMtime() ? lmDate.toUTCString() : lmDate.toISOString()
  // 集合条目默认不输出 etag（多数真实服务器的形态）；etagprop 档改为树内聚合，
  // 使任何深度的文件变更都反映到所有祖先集合的 etag（文件条目仍走 etagFor 既有口径）；
  // 'shallow' 变体只聚合直接子文件（见 collectionEtagAgg 的 depthLimit 注释）
  const etag = isDir ? (etagPropOn() ? await collectionEtagAgg(abs, etagPropShallow() ? 1 : Infinity) : '') : await etagFor(abs, st)
  // cdataetag 档：etag 用 CDATA 包裹（部分服务器对含特殊字符的 etag 的做法）
  const etagText = style === 'cdataetag' && etag ? `<![CDATA[${etag}]]>` : escapeXml(etag)
  return `  <${tag('response')}>
    <${tag('href')}>${hrefText}</${tag('href')}>
    <${tag('propstat')}>
      <${tag('prop')}>
        <${tag('resourcetype')}>${isDir ? `<${tag('collection')}/>` : ''}</${tag('resourcetype')}>
        ${isDir ? '' : `<${tag('getcontentlength')}>${st.size}</${tag('getcontentlength')}>`}
        <${tag('getlastmodified')}>${lm}</${tag('getlastmodified')}>
        ${!etag ? '' : `<${tag('getetag')}>${etagText}</${tag('getetag')}>`}
      </${tag('prop')}>
      <${tag('status')}>HTTP/1.1 200 OK</${tag('status')}>
    </${tag('propstat')}>
  </${tag('response')}>`
}

async function propfind(absPath, urlPath, depth, res) {
  let st
  try {
    st = await fsp.stat(absPath)
  } catch {
    // root404prop 档：缺失路径的 PROPFIND 改回「207 + 集合自身 404 propstat」——
    // 真实抓包中部分网关对缺失集合就是这么应答的（HTTP 状态 207、唯一 response 的
    // propstat 为 404）。引擎必须在根探测与扫描层都识别该形态并路由到根丢失决策，
    // 绝不能解读成「远端为空」
    if (root404PropOn()) {
      const t = tagOf(flagContent('.wdsync-test-xmlstyle'))
      const selfHref = `${urlPath.replace(/\/+$/, '')}/`
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
      res.end(
        `<?xml version="1.0" encoding="utf-8"?>\n<${t('multistatus')} xmlns:D="DAV:">\n` +
          `  <${t('response')}>\n    <${t('href')}>${escapeXml(selfHref)}</${t('href')}>\n` +
          `    <${t('propstat')}><${t('prop')}/><${t('status')}>HTTP/1.1 404 Not Found</${t('status')}></${t('propstat')}>\n` +
          `  </${t('response')}>\n</${t('multistatus')}>`
      )
      return
    }
    res.writeHead(404).end()
    return
  }
  const style = flagContent('.wdsync-test-xmlstyle')
  const tag = tagOf(style)
  // bigxml 档：对名为 bigxml 的目录返回 N 条合成条目（不落盘真实文件），
  // 用于 5 万条目大响应的解析耗时 / 内存验证；含中文名与 %23 名
  if (bigxmlN() > 0 && st.isDirectory() && path.basename(absPath) === 'bigxml') {
    const n = bigxmlN()
    const parts = [`<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n`]
    for (let i = 0; i < n; i++) {
      let seg
      if (i % 1000 === 7) seg = encodeURIComponent(`中 文${i}.txt`)
      else if (i % 1000 === 11) seg = `tag%23-${i}.txt`
      else seg = `f${i}.txt`
      parts.push(
        `  <D:response>\n    <D:href>/dav/bigxml/${seg}</D:href>\n    <D:propstat><D:prop>` +
          `<D:resourcetype/><D:getcontentlength>${(i % 97) + 1}</D:getcontentlength>` +
          `<D:getlastmodified>2023-11-14T22:13:20.000Z</D:getlastmodified>` +
          `<D:getetag>&quot;e${i}&quot;</D:getetag>` +
          `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>\n  </D:response>\n`
      )
    }
    parts.push(`</D:multistatus>`)
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
    res.end(parts.join(''))
    return
  }
  const entries = [await entryXml(HREF_ROOT + path.relative(ROOT, absPath).split(path.sep).join('/'), st, style, absPath)]
  if (st.isDirectory() && depth >= 1) {
    // vanish 档：PROPFIND 目标路径含 'vanish' 时剔除 gone.vanish.txt
    // 条目 —— 模拟「PUT 成功但目录列表看不到该文件」，驱动引擎批量校验失败路径
    const vanishFilter = vanishOn() && urlPath.includes('vanish')
    const list = await fsp.readdir(absPath, { withFileTypes: true })
    for (const ent of list) {
      if (vanishFilter && ent.name === 'gone.vanish.txt') continue
      const childAbs = path.join(absPath, ent.name)
      const childHref = HREF_ROOT + path.relative(ROOT, childAbs).split(path.sep).join('/')
      const cst = await fsp.stat(childAbs)
      entries.push(await entryXml(childHref, cst, style, childAbs))
      if (ent.isDirectory() && depth >= 2) {
        // depth infinity 简化：递归收集
        await collectDeep(childAbs, entries, style)
      }
      // casepair 档：命中标记文件名时虚拟列出首字母大小写翻转的孪生条目
      //（size+1、独立 etag；仅存在于列举 —— 模拟大小写敏感服务器上的同名对）
      const cp = casepairName()
      if (cp && ent.isFile() && ent.name === cp) {
        const flipped = cp.charAt(0) === cp.charAt(0).toLowerCase() ? cp.charAt(0).toUpperCase() + cp.slice(1) : cp.charAt(0).toLowerCase() + cp.slice(1)
        const twinHref = HREF_ROOT + path.relative(ROOT, path.join(absPath, flipped)).split(path.sep).join('/')
        const t = tagOf(style)
        entries.push(
          `  <${t('response')}>
    <${t('href')}>${escapeXml(twinHref)}</${t('href')}>
    <${t('propstat')}>
      <${t('prop')}>
        <${t('resourcetype')}/>
        <${t('getcontentlength')}>${cst.size + 1}</${t('getcontentlength')}>
        <${t('getlastmodified')}>${new Date(cst.mtimeMs).toISOString()}</${t('getlastmodified')}>
        <${t('getetag')}>&quot;virtual-twin-${cst.size + 1}&quot;</${t('getetag')}>
      </${t('prop')}>
      <${t('status')}>HTTP/1.1 200 OK</${t('status')}>
    </${t('propstat')}>
  </${t('response')}>`
        )
      }
    }
  }
  const nsDecl = style === 'plain' ? 'xmlns="DAV:"' : `xmlns:${style ? 'd' : 'D'}="DAV:"`
  let xml = `<?xml version="1.0" encoding="utf-8"?>\n<${tag('multistatus')} ${nsDecl}>\n${entries.join('\n')}\n</${tag('multistatus')}>`
  // badxml 档：在「HTTP 分帧完整」的前提下输出畸形 XML ——
  // 验证的是解析器行为（引擎应把扫描判 incomplete），而不是网络层截断
  const bad = badxmlMode()
  if (bad === 'truncate') {
    xml = xml.slice(0, Math.floor(xml.length * 0.6))
  } else if (bad === 'unclosed') {
    xml = xml.replace(`\n</${tag('multistatus')}>`, '')
  } else if (bad === 'badentity') {
    // 追加一个含未定义实体（&fakeent;）的条目：saxes 必须报错而非静默放行
    const t = tag
    xml = xml.replace(
      `</${t('multistatus')}>`,
      `  <${t('response')}><${t('href')}>/dav/bad&amp;%E4%B8%AD&fakeent;.txt</${t('href')}>` +
        `<${t('propstat')}><${t('prop')}/><${t('status')}>HTTP/1.1 200 OK</${t('status')}></${t('propstat')}></${t('response')}>\n</${t('multistatus')}>`
    )
  }
  res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
  res.end(xml)
}

async function collectDeep(dir, entries, style) {
  const list = await fsp.readdir(dir, { withFileTypes: true })
  for (const ent of list) {
    const abs = path.join(dir, ent.name)
    const href = HREF_ROOT + path.relative(ROOT, abs).split(path.sep).join('/')
    const st = await fsp.stat(abs)
    entries.push(await entryXml(href, st, style, abs))
    if (ent.isDirectory()) await collectDeep(abs, entries, style)
  }
}

async function mkdirpDeep(absDir) {
  await fsp.mkdir(absDir, { recursive: true })
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0]
  // 4.0.3：客户端销毁连接后，响应流可能异步抛错（write-after-destroy 等）—— 测试
  // 服务器吞掉响应流错误，让「连接被中断」只体现在 reqlog 的 !ABORT 行上
  res.on('error', () => {})
  logReq(req, urlPath, res)
  const abs = toLocal(urlPath)
  // 限流预算的启用跳变检测（每个请求都查）：重新启用 = 新用例开始，重置已消耗额度
  const rlNow = ratelimitEnabled()
  if (rlNow && !rlWasEnabled) rlHits = 0
  rlWasEnabled = rlNow
  // fail423 一次性失败记忆的启用跳变检测：重新启用 = 新用例开始，路径记忆清空
  const l423Now = fail423On()
  if (l423Now && !lock423WasEnabled) lock423Hit.clear()
  lock423WasEnabled = l423Now
  // fail423x 每路径失败计数的启用跳变检测：重新启用 = 新用例开始，路径计数清空
  const l423xNow = fail423xN() > 0
  if (l423xNow && !lock423xWasEnabled) lock423xHits.clear()
  lock423xWasEnabled = l423xNow
  // dedupfail 列举计数的启用跳变检测：重新启用 = 新用例开始，每路径计数清空
  const dfNow = dedupFailStatus() > 0
  if (dfNow && !dedupFailWasOn) pfFailHits.clear()
  dedupFailWasOn = dfNow
  // netcut 切断计数的启用跳变检测：重新启用 = 新用例开始，每路径计数清空
  const ncNow = netcutSpec()[0] > 0
  if (ncNow && !netcutWasOn) netcutHits.clear()
  netcutWasOn = ncNow
  if (!abs) {
    res.writeHead(403).end()
    return
  }
  try {
    // 测试档位：集合类 PROPFIND（无尾斜杠路径）→ 301 同源加尾斜杠（重定向跟随用例）
    if (req.method === 'PROPFIND' && redirectEnabled()) {
      const st = await fsp.stat(abs).catch(() => null)
      if (st && st.isDirectory() && !urlPath.endsWith('/')) {
        const host = req.headers.host || `127.0.0.1:${port}`
        res.writeHead(301, { Location: `http://${host}${urlPath}/` }).end()
        return
      }
    }
    // 测试档位：前 RL_MAX 次 PUT/GET 返回 429 + Retry-After: 1（限流重试用例）。
    // PUT 先消费请求体再拒绝：keep-alive 连接上不读完请求体就响应会打乱 framing
    if ((req.method === 'PUT' || req.method === 'GET') && ratelimitEnabled()) {
      if (rlHits < RL_MAX) {
        rlHits++
        if (req.method === 'PUT') await new Promise((r) => { req.resume(); req.on('end', r) })
        res.writeHead(429, { 'Retry-After': '1' }).end()
        return
      }
    }
    // p8 只读档：一切写方法 403（C 档 download-only 用例；请求体先消费以保持 framing）
    if (readOnly() && (req.method === 'PUT' || req.method === 'DELETE' || req.method === 'MKCOL' || req.method === 'MOVE')) {
      if (req.method === 'PUT') await new Promise((r) => { req.resume(); req.on('end', r) })
      res.writeHead(403).end()
      return
    }
    // 只读子路径档（按路径写权限用例）：落在声明前缀下的写方法 403，其余照常
    if (roSubpathHit(urlPath) && (req.method === 'PUT' || req.method === 'DELETE' || req.method === 'MKCOL' || req.method === 'MOVE')) {
      if (req.method === 'PUT') await new Promise((r) => { req.resume(); req.on('end', r) })
      res.writeHead(403).end()
      return
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(200, { DAV: '1', Allow: 'OPTIONS, PROPFIND, GET, PUT, MKCOL, DELETE, MOVE' }).end()
    } else if (req.method === 'PROPFIND') {
      const depthRaw = String(req.headers.depth ?? '1').trim().toLowerCase()
      logDepth(depthRaw, urlPath)
      if (depthRaw === 'infinity') {
        // Depth: infinity：默认档（p1 等）按多数真实服务器习惯拒绝；p9 档放行递归
        // multistatus。测试标记优先于 profile：noinfinity 一律 403（缓存过期
        // 回落用例）；shallowinf 返回 207 但只列第一层（探测硬化 / 浅响应阀门用例）
        if (noInfinityOn()) {
          res.writeHead(403).end()
          return
        }
        if (shallowInfOn()) {
          await propfind(abs, urlPath, 1, res)
          return
        }
        if (!depthInfinityAllowed()) {
          res.writeHead(403).end()
          return
        }
        await propfind(abs, urlPath, 2, res)
      } else {
        // midair 钩子（propfind 触发点）：B 档引擎「执行前复查」用 Depth:0 命中此处
        if (midairMode() === 'propfind' && Number(depthRaw) === 0) await midairMutate(abs)
        // dedupfail 标记（4.0.2）：路径含 dedupfail 的 Depth:1 目录列举从第 2 次起返回
        // 注入状态码 —— 引擎的第 1 次列举是扫描（放行）、第 2 次是 B 档写前查重（失败）
        if (dedupFailStatus() > 0 && Number(depthRaw) === 1 && urlPath.includes('dedupfail')) {
          const n = (pfFailHits.get(urlPath) || 0) + 1
          pfFailHits.set(urlPath, n)
          if (n >= 2) {
            res.writeHead(dedupFailStatus()).end()
            return
          }
        }
        await propfind(abs, urlPath, Number(depthRaw) || 0, res)
      }
    } else if (req.method === 'GET') {
      // getfail 档：路径命中子串的 GET 一律 404 —— 404 属 permanent 分类，
      // 网络层不重试，是「GET 失败」的成本最低注入（采纳确认失败回退用例）
      const gf = getfailSubstring()
      if (gf && urlPath.includes(gf)) {
        res.writeHead(404).end()
        return
      }
      const st = await fsp.stat(abs).catch(() => null)
      if (!st || !st.isFile()) {
        res.writeHead(404).end()
      } else {
        const data = await fsp.readFile(abs)
        // Last-Modified：真实 WebDAV 服务器的标准应答头；租约锁的「服务器时钟过期判定」
        // 依赖 date（Node 自动携带）与 last-modified（此处）的差值
        const headers = { 'Content-Length': data.length, 'Last-Modified': st.mtime.toUTCString() }
        const etag = await etagFor(abs, st)
        if (etag) headers.Etag = etag
        res.writeHead(200, headers)
        // throttle 档（4.0.3）：路径含 throttle 的响应按 64KB 块 + 每块延迟节流，
        // 把大文件下载拉长到秒级，制造「传一半」的取消窗口。客户端销毁连接后
        // 提前收工（剩余写入无意义；close 事件是最可靠的断连信号）
        if (throttleMs() > 0 && urlPath.includes('throttle')) {
          let gone = false
          res.on('close', () => {
            gone = true
          })
          const CHUNK = 65536
          for (let off = 0; off < data.length; off += CHUNK) {
            if (gone || res.destroyed) return
            res.write(data.subarray(off, off + CHUNK))
            await sleep(throttleMs())
          }
          res.end()
          return
        }
        res.end(data)
      }
    } else if (req.method === 'PUT') {
      logCapHeaders(req, urlPath)
      // err503 档：一切 PUT 返回 503（无 Retry-After）—— 整轮熔断用例
      if (err503On()) {
        await new Promise((r) => { req.resume(); req.on('end', r) })
        res.writeHead(503).end()
        return
      }
      // 测试钩子：按路径注入上传失败（路径含 .failput 的文件一律 500）
      if (urlPath.includes('.failput')) {
        await new Promise((r) => { req.resume(); req.on('end', r) })
        res.writeHead(500).end()
        return
      }
      // 测试档位：路径含 .toolarge 的 PUT 一律 413 —— 永久失败退避用例
      //（引擎应记入失败退避表并按指数退避跳过，故障移除且退避到期后才恢复重试）
      if (fail413On() && urlPath.includes('.toolarge')) {
        await new Promise((r) => { req.resume(); req.on('end', r) })
        res.writeHead(413).end()
        return
      }
      // 测试档位：每个 PUT 路径第一次返回 423（无 Retry-After），之后
      // 放行 —— 瞬时失败用例（当轮重试后收敛，轮次不报错；与限流 / 只读等档位互不影响）
      if (fail423On() && !lock423Hit.has(urlPath)) {
        lock423Hit.add(urlPath)
        await new Promise((r) => { req.resume(); req.on('end', r) })
        res.writeHead(423).end()
        return
      }
      // 测试档位（TR1 用例）：每个 PUT 路径前 N 次返回 423（无 Retry-After），之后放行。
      // N（缺省 4）超过网络层最大重试次数（3）时，网络层以终态 423 抛回引擎 →
      // classifyOpFailure 判 transient → 引擎级当轮重试循环接管（第 N+1 次放行收敛）
      if (fail423xN() > 0) {
        const hits = (lock423xHits.get(urlPath) || 0) + 1
        lock423xHits.set(urlPath, hits)
        if (hits <= fail423xN()) {
          await new Promise((r) => { req.resume(); req.on('end', r) })
          res.writeHead(423).end()
          return
        }
      }
      // midair 钩子（put 触发点）：先把远端内容改写为「对端新版本」，再评估条件头
      if (midairMode() === 'put') await midairMutate(abs)
      const st0 = await fsp.stat(abs).catch(() => null)
      // 条件 PUT（RFC 7232）：If-Match / If-None-Match（p2/p7 档静默忽略 —— 照常 2xx）
      if (!ignoreConditional()) {
        const ifMatch = req.headers['if-match']
        if (ifMatch != null) {
          const cur = st0 ? await etagFor(abs, st0) : null
          if (!ifMatchSatisfied(ifMatch, cur, !!st0)) {
            await new Promise((r) => { req.resume(); req.on('end', r) })
            res.writeHead(412).end()
            return
          }
        }
        const ifNoneMatch = req.headers['if-none-match']
        if (ifNoneMatch != null) {
          const cur = st0 ? await etagFor(abs, st0) : null
          if (ifNoneMatchSatisfied(ifNoneMatch, cur, !!st0)) {
            await new Promise((r) => { req.resume(); req.on('end', r) })
            res.writeHead(412).end()
            return
          }
        }
      }
      // partialput = PUT 边收边落盘（非原子，中断时已收字节保留为半截）；
      // netcut = 收到第 N 块后主动销毁连接（客户端以 NETWORK 收场，区别于取消），
      // 每路径最多切断 M 次。netcut 单独使用时切断的 PUT 不落任何字节（原子服务器 +
      // 网络中断）；与 partialput 叠用时半截字节保留
      const [cutAfter, cutMax] = netcutSpec()
      const willCut = cutAfter > 0 && (netcutHits.get(urlPath) || 0) < cutMax
      const partial = partialPutOn()
      const chunks = []
      let ws = null
      const ensureWs = async () => {
        if (!ws) {
          await mkdirpDeep(path.dirname(abs))
          ws = fs.createWriteStream(abs)
          ws.on('error', () => {})
        }
      }
      /** 结束写流并等落盘完成：等 close（finish / error / destroy 后必发，不会悬挂） */
      const finishWs = () =>
        new Promise((r) => {
          ws.once('close', () => r())
          ws.end()
        })
      // throttle 档（4.0.3）：路径含 throttle 的请求体按「每收到一块睡 delay 毫秒」节流
      // —— 读流暂停经 TCP 背压传导回客户端，把大文件上传拉长到秒级（制造取消窗口）
      const slowPut = throttleMs() > 0 && urlPath.includes('throttle')
      let cutNow = false
      try {
        let chunkIdx = 0
        for await (const c of req) {
          if (partial) {
            await ensureWs()
            if (!ws.write(c)) await new Promise((r) => ws.once('drain', r))
          } else {
            chunks.push(c)
          }
          chunkIdx++
          if (willCut && chunkIdx >= cutAfter) {
            netcutHits.set(urlPath, (netcutHits.get(urlPath) || 0) + 1)
            cutNow = true
            break
          }
          if (slowPut) await sleep(throttleMs())
        }
        if (cutNow) {
          // partial：半截字节落盘；非 partial：仅内存缓冲，直接丢弃。随后销毁连接，
          // 不回任何响应（客户端见 ECONNRESET → NETWORK）
          if (ws) await finishWs()
          res.socket?.destroy()
          req.destroy()
          return
        }
        if (partial) {
          if (ws) await finishWs()
          else {
            // 空请求体：等价于写入空文件
            await mkdirpDeep(path.dirname(abs))
            await fsp.writeFile(abs, Buffer.alloc(0))
          }
        } else {
          const data = Buffer.concat(chunks)
          await mkdirpDeep(path.dirname(abs))
          await fsp.writeFile(abs, data)
        }
      } catch (e) {
        // 客户端取消（销毁连接）会让请求体读取抛错 —— partialput 模式下已收字节
        // 保留为目标文件的半截内容（这正是该标记的语义），随后交由外层 catch 收尾
        if (ws) {
          try {
            await finishWs()
          } catch {
            /* 尽力冲刷已收字节 */
          }
        }
        throw e
      }
      // locksteal 标记：锁文件 PUT 落盘后把内容改写为他人 deviceId ——
      // 模拟「写回竞争失败」：引擎静置 1.5s 后回读将看到 peer-device-x 而让出本轮
      if (lockStealOn() && urlPath.endsWith('.webdav-sync.lock')) {
        await fsp.writeFile(
          abs,
          JSON.stringify({ v: 1, deviceId: 'peer-device-x', startedAt: new Date().toISOString(), ttlMs: 180000 })
        )
      }
      const st = await fsp.stat(abs)
      // PUT 响应头携带「写入时刻」的 etag；p6 档在响应发出后立即改写 mtime/etag，
      // 使下一次 PROPFIND 看到的指纹与 PUT 响应时不同（异步指纹扰动）
      const etag = await etagFor(abs, st)
      res.writeHead(201, etag ? { Etag: etag } : {}).end()
      if (churnAfterPut()) {
        const later = new Date(st.mtimeMs + 3000)
        setTimeout(() => {
          fsp.utimes(abs, later, later).catch(() => {})
        }, 0)
      }
    } else if (req.method === 'MKCOL') {
      // mkcolfail 档：MKCOL 一律返回注入状态码（非权限性失败分类用例，如 409）
      if (mkcolFailStatus()) {
        res.writeHead(mkcolFailStatus()).end()
        return
      }
      try {
        await fsp.mkdir(abs)
        res.writeHead(201).end()
      } catch (e) {
        res.writeHead(405).end()
      }
    } else if (req.method === 'DELETE') {
      logCapHeaders(req, urlPath)
      // delefail 标记：DELETE 一律 500 —— 释放失败 → 引擎记左锁标记
      // → 下一轮开头补删的完整链路；会让轮内 delete-remote 同样失败，用例避免远端删除
      if (deleFailOn()) {
        res.writeHead(500).end()
        return
      }
      // 测试钩子：按路径注入远端删除失败（路径含 .faildelete 的资源一律 500）
      if (urlPath.includes('.faildelete')) {
        res.writeHead(500).end()
        return
      }
      // 条件 DELETE（A 档删除保护用）：If-Match 与 PUT 同一套强比较语义
      if (!ignoreConditional()) {
        const ifMatch = req.headers['if-match']
        if (ifMatch != null) {
          const st0 = await fsp.stat(abs).catch(() => null)
          const cur = st0 ? await etagFor(abs, st0) : null
          if (!ifMatchSatisfied(ifMatch, cur, !!st0)) {
            res.writeHead(412).end()
            return
          }
        }
      }
      await fsp.rm(abs, { recursive: true, force: true })
      res.writeHead(204).end()
    } else if (req.method === 'MOVE') {
      const dest = toLocal(req.headers.destination?.split('?')[0] || '')
      if (!dest) {
        res.writeHead(403).end()
      } else {
        await mkdirpDeep(path.dirname(dest))
        await fsp.rename(abs, dest)
        res.writeHead(201).end()
      }
    } else {
      res.writeHead(405).end()
    }
  } catch (e) {
    // 客户端中途销毁连接（取消中断）会让请求体读取等 await 抛错 —— 响应已无处可写，
    // 只跳过应答（!ABORT 记录由 logReq 的 close 钩子负责），绝不再向死连接写 500
    if (!res.destroyed && !res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(e && e.message ? e.message : e))
    }
  }
})

// keep-alive 空闲超时对齐真实服务器（nginx 默认 75s / 常见网关 30s+），而非 Node 默认 5s：
// 引擎端 keep-alive 池复用「恰好被服务器关闭」的 socket 时会收到 ECONNRESET（上传按
// 保守语义当轮不重试）——5s 窗口在并行测试负载下会被随机命中，30s 使竞态 practically 消失
server.keepAliveTimeout = 30000

server.listen(port, '127.0.0.1', () => {
  console.log(`mini-dav listening at http://127.0.0.1:${port}${HREF_ROOT} root=${ROOT}`)
})
