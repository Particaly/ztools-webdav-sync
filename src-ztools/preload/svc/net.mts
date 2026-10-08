/* eslint-disable */
// svc/net.mts —— 网络层与请求管线：CONNECT 隧道
// 代理 / TLS 信任分池 / keep-alive 连接池 / 每源限速与带宽字节桶 / 三段超时 /
// 幂等重试与退避 / 同源重定向 / Digest 挑战应答 / 整轮熔断器 / 错误对象工厂
// （mkOpError —— 全库操作层错误形状的单一出口）。davRequest 是全部 WebDAV
// 请求的总入口（HTTP 错误状态码正常 resolve、网络异常才 reject）。
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import path from 'node:path'
import crypto from 'node:crypto'
import nodeTimers from 'node:timers'
import { Transform, pipeline } from 'node:stream'
import type { NetOpts } from '../types.mts'
import { fs, sleep, type DavResponse, type EngineCfg, type ReqOpts, type RoundBreaker } from './base.mts'
import { authHeader, digestCacheKey, digestChallengeOf, digestChallenges, nextDigestHeader, parseDigestChallenge, remoteUrl } from './dav-parse.mts'


// ---------- dav：WebDAV 客户端网络层（重定向 / 状态码分类 / 幂等重试 / 三段超时 / pipeline 传输 / 连接复用） ----------

/** 网络层默认参数：全部可经 cfg.netOpts 覆盖，写死为常量便于整体审计 */
const NET_DEFAULTS = {
  connectTimeoutMs: 10000, // TCP/TLS 建连超时：宁可早失败早重试，也不长时间挂在半开连接上
  idleTimeoutMs: 30000, // socket 空闲（无数据活动）超时：沿用旧版 30s 语义
  stallMs: 60000, // 传输「无进展」判死：收到响应后持续无任何字节的阈值（每块数据都会重置）
  maxSockets: 8, // 每源（host:port）并发连接上限（keep-alive 池）
  ratePerSec: 0, // 每源每秒请求上限，0 = 不限制
  uploadKBps: 0, // 上传带宽上限（KB/s），0 = 不限制
  downloadKBps: 0, // 下载带宽上限（KB/s），0 = 不限制
  proxyUrl: '', // HTTP 代理地址，空 = 直连
}

/**
 * 解析后的代理目标（resolveNetOpts 产物；null = 直连）。http 代理 = 明文 TCP、
 * https 代理 = TLS 连代理（少见的企业中间人形态）；代理认证取 URL userinfo。
 */
interface ProxyTarget {
  protocol: string
  hostname: string
  port: number
  /** 代理认证头（URL userinfo 存在时携带：Proxy-Authorization: Basic …） */
  authHeader: Record<string, string>
  origin: string
}

/** resolveNetOpts 的返回形态：必填化的 NetOpts + 解析好的代理目标 */
type ResolvedNetOpts = Required<NetOpts> & { proxy: ProxyTarget | null }

/**
 * 解析代理地址：仅 http:// 与 https://；非法 / 缺省返回 null（按直连处理 ——
 * 配置错误不应放大成连接失败，UI 侧负责在保存时提示格式）。
 */
function parseProxyUrl(raw: unknown): ProxyTarget | null {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname) return null
    const auth: Record<string, string> = u.username
      ? {
          'Proxy-Authorization': `Basic ${Buffer.from(
            `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`
          ).toString('base64')}`,
        }
      : {}
    return { protocol: u.protocol, hostname: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), authHeader: auth, origin: u.origin }
  } catch (_) {
    return null
  }
}
/** 重定向最大跟随次数：与常见浏览器/客户端默认一致，防重定向环 */
const MAX_REDIRECTS = 3

/**
 * 已知服务器档案：按 host 匹配，命中且用户未显式配置
 * netOpts.ratePerSec 时提供保守默认限速。目前只有坚果云 —— 官方对 WebDAV
 * 请求频率有配额（具体数额未公开，超限返回 429），且不支持 Depth:infinity
 * （逐目录 N+1 扫描请求多），是「最容易撞配额」的服务器形态。引擎已尊重
 * Retry-After 并按网络类失败做跨轮退避，档案默认再从源头压低请求速率。
 * 数值是保守取舍（4 次/秒 ≈ 500 目录空扫 2 分钟出头），用户可随时在设置页覆盖。
 */
const SERVER_PROFILES = [
  { label: '坚果云', hostSuffix: 'jianguoyun.com', netOpts: { ratePerSec: 4 } },
]

/** 档案匹配缓存（serverUrl 字符串 → 档案或 null）：resolveNetOpts 每请求调用，避免反复解析 URL */
const profileCache = new Map()

/**
 * 按服务器地址匹配已知服务器档案；无地址 / URL 不合法 / 未命中返回 null。
 * 匹配规则：host 全等或以「.<后缀>」结尾 —— evil-jianguoyun.com 与
 * jianguoyun.com.evil.com 均不命中。目录级 serverUrl 覆盖各自获得生效地址
 * 的档案（cfgOf 已把目录生效地址放进 cfg.serverUrl）。
 */
export function serverProfileFor(serverUrl: string | null | undefined): any {
  const key = String(serverUrl || '')
  if (profileCache.has(key)) return profileCache.get(key)
  let profile: any = null
  try {
    const host = new URL(key).hostname.toLowerCase()
    if (host) {
      for (const p of SERVER_PROFILES) {
        if (host === p.hostSuffix || host.endsWith('.' + p.hostSuffix)) {
          profile = p
          break
        }
      }
    }
  } catch (_) {
    /* URL 不合法 = 无档案 */
  }
  if (profileCache.size > 32) profileCache.clear() // 同步目录数有限，兜底防膨胀
  profileCache.set(key, profile)
  return profile
}
/** 网络层 / 限流类失败的最大重试次数：首次之外再重试 3 次 */
const MAX_RETRIES = 3
/** 指数退避基数：500ms * 2^n，±25% 抖动 */
const RETRY_BASE_MS = 500
/** Retry-After 上限：服务端给再长也只等 30s，避免整轮同步被单个请求卡死 */
const RETRY_AFTER_CAP_MS = 30000
/**
 * 取消轮询间隔：shouldAbort 触发到在途请求被销毁的最大延迟。
 * 网络层没有「请求开始 / 结束」之外的统一挂点（下载在响应流、上传在读流、
 * 其余在等响应头），轮询是覆盖全部阶段的最低成本方案；间隔内的误差对
 * 取消体验无感（远小于任何一次真实传输的剩余时长）。
 */
const ABORT_POLL_MS = 100
/** 幂等方法：网络层异常时允许自动重试（PUT 不在其中，见 requestWithRetry 注释） */
const IDEMPOTENT_METHODS = new Set(['GET', 'PROPFIND', 'OPTIONS', 'DELETE', 'MKCOL'])
/** 这些状态码代表服务端「明确未处理请求」（没有落地任何字节），因此对 PUT 重发也是安全的 */
const RETRYABLE_STATUS_ANY_METHOD = new Set([429, 503, 423])
/** 允许跟随的重定向状态码（一律保留方法与请求体） */
export const REDIRECT_STATUS = new Set([301, 302, 307, 308])

/**
 * 整轮熔断阈值：连续「网络类终态失败」达到该次数后，本轮剩余请求快速失败
 * 并终止轮次。只计网络层异常（重试耗尽后抛出的 NETWORK）与终态 5xx/429 响应 ——
 * 它们是「服务器整体不可用」的信号；4xx / 条件头 412 / 本地 IO 等文件级失败不计数
 * （每个文件独立，连续失败不代表服务器宕机）。
 *
 * 时间预算推导（最坏情形）：单请求 = 首次尝试 + 3 次重试，重试间隔为
 * min(Retry-After, 30s)：最坏 3×30s + 4 次响应耗时 ≈ 92s；熔断前最多 5 个这样的
 * 请求串行 ≈ 460s（并发传输时更快触发），此后本轮立即终止 —— 单轮总时长有上界，
 * 持续 503 的服务器不再把每个待传文件各拖 ~92 秒。
 */
const ROUND_BREAKER_THRESHOLD = 5

/**
 * 整轮熔断器（每轮同步一个实例，经 cfg.__wdsyncBreaker 传入网络层）。
 * consecutive 在任一成功请求后清零：偶发失败不熔断，只有「连续挂」才判定服务器不可用。
 */
export function createRoundBreaker(threshold = ROUND_BREAKER_THRESHOLD): RoundBreaker {
  const st = { consecutive: 0, open: false, reason: '' }
  return {
    noteSuccess() {
      st.consecutive = 0
    },
    noteFailure(msg: any) {
      st.consecutive++
      if (!st.open && st.consecutive >= threshold) {
        st.open = true
        st.reason = String(msg || '')
      }
    },
    /** 熔断后网络层快速失败用的错误（permanent=true：不再进入重试）；一句人话 + 技术原因放 detail */
    error() {
      return mkOpError('服务器连续多次出错，本次同步已暂停，剩余文件会在下次同步时继续', 'CIRCUIT_OPEN', {
        permanent: true,
        detail: `连续失败 ${st.consecutive} 次（${st.reason}）`,
      })
    },
    get open() {
      return st.open
    },
    get reason() {
      return st.reason
    },
    get consecutive() {
      return st.consecutive
    },
  }
}
/**
 * 合并 cfg.netOpts 与默认值；非法值（非正数等）回退默认，配置错误不应放大成奇怪行为。
 * ratePerSec 的分层：用户显式配置（含显式 0 = 明确不限速）>
 * 服务器档案默认（坚果云等，见 SERVER_PROFILES）> NET_DEFAULTS（0）。0 是合法
 * 显式值，不能用 num() 的「>0」口径吞掉，单独处理。
 */
export function resolveNetOpts(cfg: EngineCfg): ResolvedNetOpts {
  const raw = cfg && typeof cfg.netOpts === 'object' && cfg.netOpts ? cfg.netOpts : {}
  const num = (v: any, dflt: any) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt)
  const profile = serverProfileFor(cfg && cfg.serverUrl)
  const dfltRate =
    profile && Number.isFinite(profile.netOpts.ratePerSec) && profile.netOpts.ratePerSec > 0
      ? profile.netOpts.ratePerSec
      : NET_DEFAULTS.ratePerSec
  const proxyUrl = typeof raw.proxyUrl === 'string' ? raw.proxyUrl.trim() : ''
  return {
    connectTimeoutMs: num(raw.connectTimeoutMs, NET_DEFAULTS.connectTimeoutMs),
    idleTimeoutMs: num(raw.idleTimeoutMs, NET_DEFAULTS.idleTimeoutMs),
    stallMs: num(raw.stallMs, NET_DEFAULTS.stallMs),
    maxSockets: num(raw.maxSockets, NET_DEFAULTS.maxSockets),
    ratePerSec:
      typeof raw.ratePerSec === 'number' && Number.isFinite(raw.ratePerSec) && raw.ratePerSec >= 0
        ? raw.ratePerSec
        : dfltRate,
    // 带宽限速：0 = 不限制（显式 0 与缺省同义，无档案分层）
    uploadKBps: num(raw.uploadKBps, NET_DEFAULTS.uploadKBps),
    downloadKBps: num(raw.downloadKBps, NET_DEFAULTS.downloadKBps),
    proxyUrl,
    proxy: parseProxyUrl(proxyUrl),
  }
}

/**
 * 模块级 keep-alive 连接池：按「协议 + maxSockets + TLS 信任键 + 代理源」缓存
 * Agent，Agent 内部再按 host:port 复用。TLS 信任配置不同的连接绝不共用 Agent
 *（信任开关 / CA 追加会改变 TLS 握手行为，共用会让先建的 Agent 决定后到的请求）；
 * 代理配置不同同样分池（连接去向完全不同）。
 */
const agentPool = new Map()
function agentFor(protocol: string, maxSockets: number, tlsOpts?: TlsAgentOpts, proxy?: ProxyTarget | null): http.Agent {
  const mod = protocol === 'https:' ? https : http
  const tlsKey = protocol === 'https:' && tlsOpts && tlsOpts.key ? tlsOpts.key : ''
  const key = proxy ? `px|${protocol}|${maxSockets}|${tlsKey}|${proxy.origin}` : `${protocol}|${maxSockets}|${tlsKey}`
  let agent = agentPool.get(key)
  if (!agent) {
    agent = proxy
      ? new TunnelAgent(proxy, protocol === 'https:', maxSockets, tlsKey ? tlsOpts : undefined, NET_DEFAULTS.connectTimeoutMs)
      : protocol === 'https:' && tlsKey && tlsOpts
        ? new https.Agent({
            keepAlive: true,
            maxSockets,
            ...(tlsOpts.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
            ...(tlsOpts.ca ? { ca: [tlsOpts.ca] } : {}),
          })
        : new mod.Agent({ keepAlive: true, maxSockets })
    agentPool.set(key, agent)
  }
  return agent
}

/** 代理类失败的统一包装：一句话人话 + code='NETWORK'（可重试；配置错误的最终由重试耗尽暴露） */
function proxyFail(detail: string): any {
  return mkOpError(`无法通过代理服务器连接，请检查代理地址是否填写正确（${detail}）`, 'NETWORK', { permanent: false, detail })
}

/**
 * CONNECT 隧道代理 Agent（netOpts.proxyUrl 的落地；无外部依赖的 Node 原生实现）。
 * 连接形态按「代理协议 × 目标协议」组合：
 *   http 代理 + https 目标 —— 明文 TCP 到代理 → CONNECT 隧道 → TLS 端到端
 *     （代理只见加密流，TLS 信任选项作用于隧道内的目标握手）；
 *   http 代理 + http  目标 —— 不建隧道：普通 TCP 到代理，请求行改绝对 URI
 *     （singleRequest 已改写 host/port/path，本 Agent 只负责把连接打到代理）；
 *   https 代理（任意目标）—— 先 TLS 连上代理本身，再按目标协议走上述两种形态。
 * keep-alive / maxSockets 语义继承 http.Agent：隧道建成后的 socket 照常入池复用。
 */
class TunnelAgent extends http.Agent {
  /** 目标协议标记（Node 客户端校验 agent.protocol 与请求协议一致；@types 未公开父类同名属性，子类显式声明） */
  declare protocol: string
  declare defaultPort: number
  private px: ProxyTarget
  private targetHttps: boolean
  private tlsOpts?: TlsAgentOpts
  private connectTimeoutMs: number

  constructor(px: ProxyTarget, targetHttps: boolean, maxSockets: number, tlsOpts: TlsAgentOpts | undefined, connectTimeoutMs: number) {
    super({ keepAlive: true, maxSockets })
    // Agent 的协议标记按目标协议对齐：Node 客户端会校验 agent.protocol 与请求
    // 协议一致（http.Agent 默认 'http:'，直接服务 https 请求会被拒绝）
    this.protocol = targetHttps ? 'https:' : 'http:'
    this.defaultPort = targetHttps ? 443 : 80
    this.px = px
    this.targetHttps = targetHttps
    this.tlsOpts = tlsOpts
    this.connectTimeoutMs = connectTimeoutMs
  }

  createConnection(options: any, cb: (err: Error | null, socket?: any) => void): any {
    const targetHost = String(options.host || options.hostname || '')
    const targetPort = Number(options.port) || (this.targetHttps ? 443 : 80)
    this.dial(targetHost, targetPort)
      .then((sock) => cb(null, sock))
      .catch((e) => cb(e))
    // createConnection 的返回值语义（socket | void）与回调式并存；此处只用回调
  }

  /** 建立到目标的可用连接（连接代理 [+ CONNECT 隧道] [+ 目标 TLS]），全链路受建连超时约束 */
  private async dial(targetHost: string, targetPort: number): Promise<any> {
    const deadline = Date.now() + this.connectTimeoutMs
    const wrap = (p: Promise<any>): Promise<any> =>
      new Promise((resolve, reject) => {
        const timer = nodeTimers.setTimeout(() => {
          reject(
            mkOpError('连接代理服务器超时，请检查代理地址或网络', 'NETWORK', {
              permanent: false,
              detail: `${this.px.origin} → ${targetHost}:${targetPort}`,
            })
          )
        }, Math.max(1, deadline - Date.now()))
        if (typeof timer === 'object' && timer && typeof (timer as any).unref === 'function') (timer as any).unref()
        p.then(
          (v) => {
            nodeTimers.clearTimeout(timer)
            resolve(v)
          },
          (e) => {
            nodeTimers.clearTimeout(timer)
            reject(e)
          }
        )
      })
    // 1. 连接代理本体（http 代理 = 明文 TCP；https 代理 = TLS）
    let sock: any
    if (this.px.protocol === 'https:') {
      sock = await wrap(
        new Promise((resolve, reject) => {
          const s = tls.connect({ host: this.px.hostname, port: this.px.port, servername: this.px.hostname })
          s.once('secureConnect', () => resolve(s))
          s.once('error', (e: any) => reject(proxyFail(`${this.px.origin} ${e && e.message ? e.message : e}`)))
        })
      )
    } else {
      sock = await wrap(
        new Promise((resolve, reject) => {
          const s = net.connect({ host: this.px.hostname, port: this.px.port })
          s.once('connect', () => resolve(s))
          s.once('error', (e: any) => reject(proxyFail(`${this.px.origin} ${e && e.message ? e.message : e}`)))
        })
      )
    }
    // 2. http 目标：不建隧道（singleRequest 已按绝对 URI 改写请求行），直接可用
    if (!this.targetHttps) return sock
    // 3. https 目标：CONNECT 隧道 + 目标 TLS（信任选项作用于这一层握手）
    const tunnel = await wrap(
      new Promise<any>((resolve, reject) => {
        const req = http.request({
          createConnection: (): any => sock,
          method: 'CONNECT',
          path: `${targetHost}:${targetPort}`,
          headers: { ...this.px.authHeader },
        })
        req.once('connect', (res: any, tun: any) => {
          if (res.statusCode === 200) resolve(tun)
          else {
            tun.destroy()
            reject(proxyFail(`隧道建立被拒绝（HTTP ${res.statusCode}）`))
          }
        })
        req.once('error', (e: any) => reject(proxyFail(`${this.px.origin} ${e && e.message ? e.message : e}`)))
        req.end()
      })
    )
    return wrap(
      new Promise((resolve, reject) => {
        const ts = tls.connect({
          socket: tunnel,
          servername: targetHost,
          ...(this.tlsOpts && this.tlsOpts.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
          ...(this.tlsOpts && this.tlsOpts.ca ? { ca: [this.tlsOpts.ca] } : {}),
        })
        ts.once('secureConnect', () => resolve(ts))
        ts.once('error', (e: any) => reject(normalizeNetError(e, null)))
      })
    )
  }
}

/** TLS Agent 选项的解析形态：key 为连接池分池键（信任开关 + CA 指纹），Agent 构造项按需携带 */
interface TlsAgentOpts {
  key: string
  rejectUnauthorized?: boolean
  ca?: string
}

/**
 * 从连接配置解析 TLS Agent 选项（https 专用；http 与未配置返回空 key = 默认 Agent）。
 * - trustServerCertificate → rejectUnauthorized:false（跳过校验，仍加密）；
 * - caPem（PEM 文本）→ 追加信任的 CA（校验照常，只是多了自建根）。
 * key 用「信任开关 + CA 内容哈希前 16 位」：不同信任配置各自分池，同配置共享池。
 */
export function tlsAgentOptsFor(cfg: EngineCfg): TlsAgentOpts {
  const tls: any = cfg && (cfg as any).tls
  if (!tls || typeof tls !== 'object') return { key: '' }
  const trust = tls.trustServerCertificate === true
  const caPem = typeof tls.caPem === 'string' ? tls.caPem.trim() : ''
  if (!trust && !caPem) return { key: '' }
  const caKey = caPem ? crypto.createHash('sha256').update(caPem).digest('hex').slice(0, 16) : ''
  return {
    key: `${trust ? '1' : '0'}|${caKey}`,
    ...(trust ? { rejectUnauthorized: false } : {}),
    ...(caPem ? { ca: caPem } : {}),
  }
}

/** 自签名 / 无法验证链的 Node TLS 错误码（跨 Node 版本的既有命名） */
const SELF_SIGNED_TLS_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])

/**
 * TLS 握手失败的友好映射（自签名 / 过期 / 域名不匹配 / 协议不符四类）。
 * 命中返回已分类错误（code='TLS'、permanent=true —— 确定性失败，重试与熔断都无意义；
 * 归因 'other' 而非 network：与 401 同属配置类问题，调度层不该按网络故障退避），
 * 非 TLS 错误返回 null 交回 normalizeNetError 的既有包装。
 */
export function normalizeTlsError(e: any): any | null {
  const code = String((e && e.code) || '')
  const selfSigned = SELF_SIGNED_TLS_CODES.has(code)
  const expired = code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID' || code === 'ERR_TLS_CERT_NOT_YET_VALID' || code === 'ERR_CERT_NOT_YET_VALID'
  const nameMismatch = code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  const proto = code === 'EPROTO' || code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'ERR_SSL_UNKNOWN_PROTOCOL' || code === 'UNSUPPORTED_PROTOCOL'
  if (!selfSigned && !expired && !nameMismatch && !proto) return null
  return mkOpError(
    selfSigned
      ? '无法安全连接：服务器使用的证书无法通过验证（自签名）。群晖、QNAP 等 NAS 常用自签名证书 —— 确认服务器是自己可控的设备后，可在「设置 → WebDAV」打开「信任此服务器证书」再试'
      : expired
        ? '无法安全连接：服务器证书已过期或尚未生效。请先在服务器上更新证书；若服务器是自己可控的设备，也可在「设置 → WebDAV」打开「信任此服务器证书」再试'
        : nameMismatch
          ? '无法安全连接：证书与服务器地址不匹配。请核对地址是否写错（证书只对特定域名有效）；若确需连接，可在「设置 → WebDAV」打开「信任此服务器证书」再试'
          : '无法建立加密连接：服务器可能不支持 HTTPS，或地址的 http:// 与 https:// 写反了，请检查服务器地址',
    'TLS',
    { permanent: true, detail: `${code} ${(e && e.reason) || (e && e.message) || ''}` }
  )
}

/** 销毁全部自建 Agent 与限速器（插件退出 / 测试收尾调用，避免存活 socket 阻止进程退出） */
export function destroyNetPools(): void {
  for (const agent of agentPool.values()) agent.destroy()
  agentPool.clear()
  rateLimiters.clear()
  byteBuckets.clear()
  liveLimits.clear()
  digestChallenges.clear()
}

/** 每源简单令牌桶：容量 = ratePerSec，按速率持续补充；经串行链发放（不精确但足够） */
const rateLimiters = new Map()
function acquireRateSlot(origin: string, ratePerSec: number): Promise<void> {
  let bucket = rateLimiters.get(origin)
  if (!bucket) {
    bucket = { tokens: ratePerSec, last: Date.now(), chain: Promise.resolve() }
    rateLimiters.set(origin, bucket)
  }
  const run = bucket.chain.then(async () => {
    const now = Date.now()
    bucket.tokens = Math.min(ratePerSec, bucket.tokens + ((now - bucket.last) / 1000) * ratePerSec)
    bucket.last = now
    if (bucket.tokens < 1) {
      await sleep(Math.ceil((1 - bucket.tokens) * (1000 / ratePerSec)))
      bucket.tokens = Math.max(bucket.tokens, 1) // 补眠后至少按 1 枚发放
    }
    bucket.tokens -= 1
  })
  bucket.chain = run.catch(() => {})
  return run
}

// ---------- 带宽限速（netOpts.uploadKBps / downloadKBps 的字节令牌桶） ----------
//
// 每源（origin）× 方向（上传 / 下载）各一只桶：同一服务器并发传输经串行链共享
// 同一总额（限的是总量，不是单流）。取令牌按 ≤64KB 的小块进行，且「有多少取
// 多少、取到就放行」—— 低限速下 socket 持续有小块流量，不会触发空闲 / 无进展
// 超时；容量 = 1 秒速率，允许约 1 秒的突发吸收。
//
// 速率的生效口径分两路：调度器轮次（cfg.__wdsyncLiveLimits）以实时限额表
// （liveLimits）为准，设置保存推送后「正在传输的文件」的下一个 64KB 切片即按
// 新速率执行；直调 / 测试路径沿用请求侧快照值（显式限速才挂桶），互不干扰。

/** 带宽桶的最小取块（字节）：低于 1 秒速率的限速仍按此粒度放行首块 */
const BW_SLICE_BYTES = 64 * 1024

/**
 * 「不限制」的桶速率哨兵（字节/秒）：用超大有限值而非 Infinity —— 补充公式
 * dt × rate 在 dt=0（同毫秒连续取块）时 0 × Infinity = NaN，会静默截断传输
 * （NaN < 1 为 false 跳过补眠、floor(NaN) 放行空块）；有限值下 0 × r = 0 安全。
 */
export const BW_UNLIMITED_BPS = 1e15

/**
 * 每源实时带宽限额（KB/s）：调度器 applyConfig 在配置应用时经 applyNetLimits
 * 逐台推送，是「限速修改立即生效」的数据源。字段缺省 = 不限制（渲染层对
 * 「不限」写 undefined，持久化后与「从未配置」同形 —— 推送语义按当前配置
 * 全量覆盖，不存在「保留旧值」的中间态）。
 */
export const liveLimits = new Map<string, { uploadKBps: number; downloadKBps: number }>()

/**
 * 推送一台服务器的实时带宽限额（调度器 applyConfig 每次应用配置时逐台调用；
 * 同源多入口以最后一次推送为准）。serverUrl 不合法时忽略 —— 配置错误不应放大
 * 成运行时异常；非法数值（负数 / 非有限）按 0（不限制）处理，与 resolveNetOpts
 * 的防御口径一致。
 */
export function applyNetLimits(serverUrl: unknown, netOpts: unknown): void {
  let origin: string
  try {
    origin = new URL(String(serverUrl || '')).origin
  } catch (_) {
    return
  }
  const raw = netOpts && typeof netOpts === 'object' ? (netOpts as Record<string, unknown>) : {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  liveLimits.set(origin, { uploadKBps: num(raw.uploadKBps), downloadKBps: num(raw.downloadKBps) })
}

/** 请求侧的生效带宽（KB/s）：调度器轮次读实时限额表（表外源回退快照值），直调路径用快照值 */
function liveBandwidthKBps(origin: string, dirKey: 'up' | 'down', snapshotKBps: number, live: boolean): number {
  if (!live) return snapshotKBps
  const l = liveLimits.get(origin)
  if (!l) return snapshotKBps
  return dirKey === 'up' ? l.uploadKBps : l.downloadKBps
}

/** 每源 × 方向的字节带宽桶（rate 单位为字节/秒；BW_UNLIMITED_BPS = 不限制） */
export const byteBuckets = new Map()

/**
 * 从带宽桶取至多 want 字节：先等桶补充到 ≥1 字节，再取 min(want, floor(tokens))。
 * 返回实际取得的字节数（恒 ≥1）—— 调用方按返回值放行数据块，令牌渐补渐放。
 * 速率每次取块现算（live 路径读实时限额表）：与桶记录值不同则原地迁移
 * （容量按新速率重算、余量按新容量封顶），正在补眠的取块下一轮循环即读到新值 ——
 * 这是「改限速立即生效，含传输中的文件」的落地机制。
 */
function takeBytes(origin: string, dirKey: 'up' | 'down', snapshotKBps: number, want: number, live: boolean): Promise<number> {
  const key = `${origin}|${dirKey}`
  const kb = liveBandwidthKBps(origin, dirKey, snapshotKBps, live)
  const rate = kb > 0 ? kb * 1024 : BW_UNLIMITED_BPS
  let bucket = byteBuckets.get(key)
  if (!bucket) {
    const cap = Math.max(rate, 4096)
    bucket = { rate, capacity: cap, tokens: cap, last: Date.now(), chain: Promise.resolve() }
    byteBuckets.set(key, bucket)
  } else if (live && rate !== bucket.rate) {
    // 原地迁移仅限调度器轮次（live）：直调 / 测试路径沿用既有桶的速率（旧口径），
    // 避免渲染层直调流量与调度器轮次在同一源上互相翻转速率
    bucket.rate = rate
    bucket.capacity = Math.max(rate, 4096)
    bucket.tokens = Math.min(bucket.tokens, bucket.capacity)
  }
  const run = bucket.chain.then(async (): Promise<number> => {
    for (;;) {
      const now = Date.now()
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + ((now - bucket.last) / 1000) * bucket.rate)
      bucket.last = now
      if (bucket.tokens < 1) {
        await sleep(Math.max(5, Math.ceil((1 - bucket.tokens) * (1000 / bucket.rate))))
        bucket.tokens = Math.max(bucket.tokens, 1)
        continue
      }
      const take = Math.min(want, Math.floor(bucket.tokens))
      bucket.tokens -= take
      return take
    }
  })
  bucket.chain = run.catch(() => {})
  return run
}

/**
 * 带宽限速 Transform：把数据块按 ≤64KB 小块经字节令牌桶放行（边取边 push）。
 * live = 调度器轮次：每次取块都从实时限额表现算速率（修改限速对在途传输即时生效）；
 * 直调 / 测试路径 live=false，沿用请求发起时的快照速率。失败 / 销毁语义交由
 * pipeline 传播（与 hashTransform 同构）。
 */
function throttleTransform(origin: string, dirKey: 'up' | 'down', snapshotKBps: number, live: boolean): Transform {
  return new Transform({
    async transform(chunk: any, _enc: any, cb: any) {
      try {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        for (let off = 0; off < buf.length; ) {
          const want = Math.min(buf.length - off, BW_SLICE_BYTES)
          const got = await takeBytes(origin, dirKey, snapshotKBps, want, live)
          this.push(buf.subarray(off, off + got))
          off += got
        }
        cb()
      } catch (e) {
        cb(e)
      }
    },
  })
}

/**
 * 解析 Retry-After 头：兼容「秒数」与「HTTP 日期」两种形态。
 * 返回 { ms, capped } 或 null；ms 已截断到 [0, 30s]，超上限时 capped = true（调用方据此标注）。
 */
function parseRetryAfter(raw: unknown): { ms: number; capped: boolean } | null {
  if (raw == null) return null
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim()
  if (!s) return null
  let ms: any = null
  if (/^\d+$/.test(s)) ms = Number(s) * 1000
  else {
    const t = Date.parse(s)
    if (!Number.isNaN(t)) ms = t - Date.now()
  }
  if (ms == null) return null
  const capped = ms > RETRY_AFTER_CAP_MS
  return { ms: Math.max(0, capped ? RETRY_AFTER_CAP_MS : ms), capped }
}

/**
 * HTTP 状态码统一分类表。
 * 只回答「这类失败是什么」，不决定要不要重试 —— 重试还与方法幂等性有关（见 requestWithRetry）。
 * 405 的「MKCOL 已存在」语义保留给调用方解释（mkdirDeep 把它当成功）。
 */
function classifyStatus(status: number, headers: Record<string, any>): { code: string; permanent: boolean; retryAfterMs?: number; retryAfterCapped?: boolean } {
  if (status === 401 || status === 403) return { code: 'AUTH', permanent: true }
  if (status === 404) return { code: 'NOT_FOUND', permanent: true }
  if (status === 405) return { code: 'NOT_ALLOWED', permanent: true }
  if (status === 409) return { code: 'PARENT_MISSING', permanent: true }
  if (status === 412) return { code: 'PRECONDITION', permanent: true }
  if (status === 413 || status === 414) return { code: 'TOO_LARGE', permanent: true }
  if (status === 423) return { code: 'LOCKED', permanent: false } // 被锁：稍后重试通常可解除
  const ra = parseRetryAfter(headers && headers['retry-after'])
  if (status === 429) {
    return { code: 'RATE_LIMITED', permanent: false, ...(ra ? { retryAfterMs: ra.ms, retryAfterCapped: ra.capped } : {}) }
  }
  if (status === 503) {
    // 503 与 429 同属「限流/过载」：都尊重 Retry-After；code 归 SERVER（与其他 5xx 一致）
    return { code: 'SERVER', permanent: false, ...(ra ? { retryAfterMs: ra.ms, retryAfterCapped: ra.capped } : {}) }
  }
  if (status >= 500) return { code: 'SERVER', permanent: false }
  return { code: 'HTTP', permanent: true } // 其余 4xx：请求本身有问题，重试无意义
}

/**
 * 操作层错误对象工厂：收敛「new Error + 逐字段挂 status / code / permanent / detail」
 * 的手搓样板，保证全库错误形状一致。字段契约（消费方：requestWithRetry 的重试闸、
 * classifyOpFailure 的三分类、networkFailure 的网络归因）：
 *   - status：失败归因的状态码。0 表示非 HTTP 归因（网络层 / 本地层失败，没有
 *     响应状态码可带）——缺省即 0；>0 为真实 HTTP 状态码（如 412 条件保护命中）；
 *   - code：机器可读分类码（NETWORK / LOCAL_IO / TLS / PRECONDITION / REMOTE_CHANGED …）；
 *   - permanent：true = 确定性失败，重试无意义（本地 IO / 配置错误 / 条件保护命中）；
 *     false = 瞬时失败，重试与整轮熔断的失败统计有意义；缺省 = 不预设该字段，
 *     交 classifyOpFailure 按 status / code 判定（随响应状态透传的 HTTP 失败即此形态）；
 *   - detail：技术细节（排障用），用户可读的话只放 message；
 *   - extra：其余随错字段（如 source='body-read' 标记上传读流失败）。
 */
export function mkOpError(
  message: string,
  code: string,
  opts: { status?: number; permanent?: boolean; detail?: string; extra?: Record<string, unknown> }
): Error & Record<string, unknown> {
  const err: any = new Error(message)
  err.status = opts.status ?? 0
  err.code = code
  if (opts.permanent !== undefined) err.permanent = opts.permanent
  if (opts.detail !== undefined) err.detail = opts.detail
  if (opts.extra) for (const [k, v] of Object.entries(opts.extra)) err[k] = v
  return err
}

/** 网络层错误统一包装：已分类的错误原样透传，其余包装为 status=0 / code='NETWORK' / permanent=false */
function normalizeNetError(e: any, url: any): any {
  if (e && (e.code === 'NETWORK' || e.code === 'LOCAL_IO' || e.code === 'REDIRECT' || e.code === 'ABORTED' || e.code === 'TLS')) return e
  const tls = normalizeTlsError(e) // TLS 握手失败是确定性配置问题：映射成人话 + 指引信任开关
  if (tls) return tls
  return mkOpError('网络连接失败，请检查网络和服务器地址', 'NETWORK', {
    permanent: false,
    detail: `${(e && e.code) || (e && e.message) || e} ${url ? url.href : ''}`,
  })
}

/**
 * 构造「用户取消」类中止错误。取消必须能打断在途传输：网络层轮询
 * shouldAbort（cfg.__wdsyncAbort）后以本错误销毁请求，各错误出口优先以它收场 ——
 * 销毁动作引出的 ECONNRESET / PREMATURE_CLOSE 不得被误判为网络故障（否则会
 * 触发幂等重试与整轮熔断计数，让取消「复活」或污染失败统计）。
 * code='ABORTED' 是执行层的取消标记：该类错误不计失败分类、不进退避表、
 * 不产生用户可见错误（轮次整体按既有「同步已中止」语义收场）。
 */
function makeAbortError(url: any): any {
  return mkOpError('已取消同步', 'ABORTED', { permanent: false, detail: url ? url.href : '' })
}

/** 重试等待：服务端给了 Retry-After 就尊重（已在 parseRetryAfter 截断）；否则指数退避 + 抖动 */
function backoffDelayMs(attempt: number, cls: any): number {
  if (cls && cls.retryAfterMs != null) return cls.retryAfterMs
  const base = RETRY_BASE_MS * Math.pow(2, attempt)
  return Math.round(base * (0.75 + Math.random() * 0.5)) // ±25% 抖动，避免多文件同步的重试风暴对齐
}

/** 上传/下载时旁路计算内容 hash 的 Transform（不额外读盘，边传边算；hash 对象按次创建，重试互不污染） */
function hashTransform(h: { update(c: unknown): void }): Transform {
  return new Transform({
    transform(chunk, _enc, cb) {
      h.update(chunk)
      cb(null, chunk)
    },
  })
}

/** 下载落盘错误映射：ENOSPC / EACCES / EPERM 等转可读中文（技术细节放 detail） */
function mapLocalWriteError(e: any, sinkFile: any): any {
  const code = (e && e.code) || ''
  const known = code === 'ENOSPC' || code === 'EDQUOT' || code === 'EACCES' || code === 'EPERM'
  return mkOpError(
    known
      ? code === 'ENOSPC' || code === 'EDQUOT' ? '电脑磁盘空间不足，写入文件失败。请清理空间后重新同步' : '没有写入权限，无法保存文件。请检查文件夹权限后重新同步'
      : `保存文件「${path.basename(sinkFile || '')}」失败`,
    'LOCAL_IO',
    { permanent: true, detail: `${code || (e && e.message) || e} ${sinkFile || ''}` }
  )
}

// ---------- 实时速率的流量计数（UI「上传 / 下载速度」的数据源） ----------
//
// 只计「文件内容通道」：上传 = PUT 请求体（bodyFile 读流 / body 缓冲）、下载 =
// GET 响应体（落盘流 / 缓冲聚合）。PROPFIND 清单、DELETE / MOVE / MKCOL 等控制
// 请求不计 —— 扫描规划期的目录列表流量不会伪装成「下载速度」；锁文件的 PUT/GET
// 体量只有几十字节，混入可忽略。字节在管道末端（限速块之后）计数：用户看到的
// 速率 = 实际交给网络的速率，与「按服务器限速」的观感一致。

/**
 * 进程级累计流量（字节，单调递增）：调度器按秒差分采样折算实时速率，经
 * net-speed 事件外发渲染层。挂在模块级（全引擎唯一实例）—— 跨轮次、跨目录
 * 并发传输自然汇成全局总量。
 */
export const netTraffic = { upBytes: 0, downBytes: 0 }

/**
 * 累加一次流量：全局总量恒累计；cfg 携带每轮流量袋（__wdsyncTraffic，调度器
 * 每轮挂载）时同步累加，供「每目录速率」归因。n ≤ 0 直接忽略。
 */
function noteTraffic(cfg: EngineCfg | null | undefined, dir: 'up' | 'down', n: number): void {
  if (!(n > 0)) return
  if (dir === 'up') netTraffic.upBytes += n
  else netTraffic.downBytes += n
  const bag = cfg && cfg.__wdsyncTraffic
  if (bag) bag[dir === 'up' ? 'upBytes' : 'downBytes'] += n
}

/**
 * 流量计数 Transform：把流经字节累加后原样放行（挂在传输管道末端 —— 计数 =
 * 实际交给网络 / 写盘的字节，限速开启时自动反映被限后的真实速率）。
 * opts.onBytes（ReqOpts）：文件传输进度的逐块回调 —— 与流量计数同口径同挂点，
 * 每块实际数据把字节数交给调用方（引擎侧据此推进 bytesDone / 刷新进度事件）。
 */
function countTransform(cfg: EngineCfg, dir: 'up' | 'down', onBytes?: (n: number) => void): Transform {
  return new Transform({
    transform(chunk: any, _enc: any, cb: any) {
      const n = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      noteTraffic(cfg, dir, n)
      if (onBytes && n > 0) {
        try {
          onBytes(n)
        } catch (_) {
          /* 进度回调异常不影响传输（引擎侧只做累加与节流外发） */
        }
      }
      cb(null, chunk)
    },
  })
}

/**
 * 发送单次请求（不含重试与重定向）。三段超时：
 *   连接超时（默认 10s）—— TCP/TLS 建立，仅对「正在建连」的 socket 生效；
 *   空闲超时（默认 30s）—— socket 无数据活动（沿用旧版语义，经 request timeout 实现）；
 *   无进展（默认 60s）—— 收到响应后持续无任何字节（stall 计时器随每块数据重置；上传方向由
 *   空闲超时兜底：读流停摆时 socket 同样无活动）。
 * 传输一律走 stream.pipeline：下载 res → 可选 hash → 写文件；上传 读流 → 可选 hash → req。
 * backpressure 与错误销毁交由 pipeline：读流/写流错误都会终结请求而不是悬挂。
 * 非成功（非 2xx）响应不落盘、不喂 hash —— 重试 / 重定向不得污染最终内容与摘要。
 */
function singleRequest(cfg: EngineCfg, method: string, url: URL, opts: ReqOpts, netOpts: ResolvedNetOpts): Promise<DavResponse> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const px = netOpts.proxy
    const viaProxyHttp = !!(px && url.protocol !== 'https:')
    // http 目标经代理：请求改打代理本体、请求行用绝对 URI（代理据此得知目标）；
    // Host 头保持目标主机（Node 默认按连接对象取值，会错写成代理）。https 目标
    // 经代理走 CONNECT 隧道（TunnelAgent 内处理），请求形态与直连完全一致。
    const headers = { ...authHeader(cfg), ...(px ? px.authHeader : {}), ...opts.headers } as Record<string, any>
    if (viaProxyHttp) headers.Host = url.host
    let bodyBuf: any = null
    if (opts.bodyFile) {
      // bodyFile 每次尝试都重新 stat + 建流：重试 / 重定向绝不能复用已消费的读流
      let st
      try {
        st = fs.statSync(opts.bodyFile)
      } catch (e: any) {
        reject(
          mkOpError(`「${path.basename(opts.bodyFile)}」未上传：文件已经不在电脑上了`, 'LOCAL_IO', {
            permanent: true,
            detail: opts.bodyFile,
          })
        )
        return
      }
      headers['Content-Length'] = st.size
    } else if (opts.body != null) {
      bodyBuf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body), 'utf-8')
      headers['Content-Length'] = bodyBuf.length
    }
    // hash 按次创建（而非复用调用方传入的对象）：重试 / 重定向后摘要只覆盖最终成功的那一次传输
    const h = opts.hashAlg ? crypto.createHash(opts.hashAlg) : null
    let connectTimer: any = null
    let stallTimer: any = null
    let abortTimer: any = null // 取消轮询（见下方 req 创建后的挂载点）
    let settled = false
    const clearTimers = () => {
      if (connectTimer) nodeTimers.clearTimeout(connectTimer)
      if (stallTimer) nodeTimers.clearTimeout(stallTimer)
      if (abortTimer) nodeTimers.clearInterval(abortTimer)
      connectTimer = stallTimer = abortTimer = null
    }
    const finish = (fn: any, arg: any) => {
      if (settled) return
      settled = true
      clearTimers()
      fn(arg)
    }
    const armStall = () => {
      if (stallTimer) nodeTimers.clearTimeout(stallTimer)
      stallTimer = nodeTimers.setTimeout(() => {
        req.destroy(
          mkOpError(`传输卡住了：${Math.round(netOpts.stallMs / 1000)} 秒没有收到数据，请检查网络`, 'NETWORK', {
            permanent: false,
            detail: url ? url.href : '',
          })
        )
      }, netOpts.stallMs)
    }
    const onResponse = (res: any) => {
      const status = res.statusCode || 0
      if (status < 200 || status >= 300) {
        // 失败 / 重定向响应：不落盘、不喂 hash，只消费响应体（释放 keep-alive 连接），
        // 结构化分类信息随结果带出供调用方（及后续阶段）使用
        res.resume()
        res.on('end', () =>
          finish(resolve, {
            status,
            headers: res.headers,
            body: null,
            etag: res.headers.etag || '',
            classification: classifyStatus(status, res.headers),
          })
        )
        res.on('error', (e: any) => finish(reject, abortErr || normalizeNetError(e, url)))
        return
      }
      armStall()
      res.on('data', () => armStall()) // 每收到一块数据就重置无进展计时
      if (opts.sinkFile && !opts.bodyFile) {
        // 下载：res → 可选 hash Transform → 写文件（pipeline 处理 backpressure / 错误传播）
        const sink = fs.createWriteStream(opts.sinkFile)
        // 与上传读流同理（见 bodyFile 分支注释）：请求侧（res）失败时 pipeline 的
        // 拆除会把同一错误传播进写流，若只看「sink 是否报过错」，网络中断会被误判
        // 成「文件写不进去」。以首个报错的来源区分发起方：sink 先报 = 真写失败。
        let firstErrFrom: '' | 'res' | 'sink' = ''
        sink.on('error', () => {
          if (!firstErrFrom) firstErrFrom = 'sink'
        })
        res.on('error', () => {
          if (!firstErrFrom) firstErrFrom = 'res'
        })
        const chain = [res]
        // 调度器轮次（live）一律挂限速 Transform：速率每次取块从实时限额表现算，
        // 修改限速（含改 0 = 不限制）对传输中的文件即时生效；直调 / 测试路径维持
        // 「显式限速才挂桶」的旧口径（请求侧快照速率，全程不变）
        const liveBW = !!(cfg && cfg.__wdsyncLiveLimits)
        if (liveBW || netOpts.downloadKBps > 0) chain.push(throttleTransform(url.origin, 'down', netOpts.downloadKBps, liveBW))
        if (h) chain.push(hashTransform(h))
        // 下载流量计数（挂管道末端 = 实际落盘的字节；限速开启时反映被限后的真实速率）
        // onBytes：下载进度的逐块回调（引擎侧推进 bytesDone）
        chain.push(countTransform(cfg, 'down', opts.onBytes))
        chain.push(sink)
        pipeline(chain, (err) => {
          if (err) {
            // 取消销毁引出的错误一律以 ABORTED 收场（abortErr 非空 = 取消已发生）
            const mapped = abortErr || (firstErrFrom === 'sink' ? mapLocalWriteError(err, opts.sinkFile) : normalizeNetError(err, url))
            req.destroy(mapped)
            finish(reject, mapped)
            return
          }
          finish(resolve, { status, headers: res.headers, body: null, etag: res.headers.etag || '', hashHex: h ? h.digest('hex') : undefined })
        })
      } else {
        const chunks: any[] = []
        res.on('data', (c: any) => {
          // 上传场景的 h 属于请求体，响应体不得混入摘要
          if (h && !opts.bodyFile) h.update(c)
          chunks.push(c)
          // 缓冲形态的下载内容计数（verify 下载比对等；只计 GET —— PROPFIND 清单不算下载）
          if (method === 'GET') noteTraffic(cfg, 'down', Buffer.isBuffer(c) ? c.length : Buffer.byteLength(c))
        })
        res.on('end', () =>
          finish(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), etag: res.headers.etag || '', hashHex: h ? h.digest('hex') : undefined })
        )
        res.on('error', (e: any) => finish(reject, abortErr || normalizeNetError(e, url)))
      }
    }
    const req = mod.request(
      {
        method,
        host: viaProxyHttp ? px!.hostname : url.hostname,
        port: viaProxyHttp ? px!.port : url.port || (url.protocol === 'https:' ? 443 : 80),
        path: viaProxyHttp ? url.href : url.pathname + url.search,
        headers,
        agent: agentFor(url.protocol, netOpts.maxSockets, tlsAgentOptsFor(cfg), px),
        timeout: netOpts.idleTimeoutMs,
      },
      onResponse
    )
    // 连接超时：复用 keep-alive 连接（sock.connecting === false）时跳过；
    // https 需等到 TLS 握手完成（secureConnect）才算连接建立
    req.on('socket', (sock) => {
      if (!sock || !sock.connecting) return
      connectTimer = nodeTimers.setTimeout(() => {
        req.destroy(
          mkOpError('连接服务器超时，请检查网络或服务器地址', 'NETWORK', {
            permanent: false,
            detail: `${netOpts.connectTimeoutMs}ms ${url.origin}`,
          })
        )
      }, netOpts.connectTimeoutMs)
      sock.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        if (connectTimer) nodeTimers.clearTimeout(connectTimer)
        connectTimer = null
      })
    })
    req.on('timeout', () => {
      req.destroy(
        mkOpError('服务器长时间没有响应，请稍后重试', 'NETWORK', {
          permanent: false,
          detail: `${Math.round(netOpts.idleTimeoutMs / 1000)}s ${url.host}`,
        })
      )
    })
    req.on('error', (e) => finish(reject, abortErr || normalizeNetError(e, url)))
    // 取消中断：shouldAbort 经 cfg.__wdsyncAbort 注入（runSyncRound 逐轮挂载，
    // 释放锁 / 批量校验等收尾请求会显式置空以豁免）。短周期轮询 + destroy：取消一旦
    // 触发，在途请求（下载响应流 / 上传读流 / 等待响应头任一阶段）立即销毁，不再等
    // 大文件传完；读写流由 pipeline 的错误传播一并终结。abortErr 记录中止事实，
    // 上方各错误出口优先以它收场（见 makeAbortError 注释）。unref：请求正常收尾
    // 前 finally 会 clearTimers，这里只为异常路径不阻塞进程退出加双保险。
    const abortPoll = cfg && typeof cfg.__wdsyncAbort === 'function' ? cfg.__wdsyncAbort : null
    let abortErr: any = null
    if (abortPoll) {
      abortTimer = nodeTimers.setInterval(() => {
        if (!settled && abortPoll()) {
          abortErr = abortErr || makeAbortError(url)
          req.destroy(abortErr)
        }
      }, ABORT_POLL_MS)
      if (typeof abortTimer.unref === 'function') abortTimer.unref()
    }
    if (opts.bodyFile) {
      // 上传：读流 → 可选 hash → req（pipeline：读流错误会销毁 req，不会悬挂）
      const rs = fs.createReadStream(opts.bodyFile)
      // 只有读流**自身**报错才按本地 IO 归类。请求侧失败（stall 看门狗 / 空闲超时 /
      // 连接被重置等 req.destroy(err)）时，pipeline 的拆除会把同一错误传播进读流
      //（destroy(err, rs) → rs 的 'error' 再冒一次）—— 若只看「rs 是否报过错」，网络
      // 卡顿会被误判成「文件暂时读不出来」并标记 permanent（不再重试）。因此以
      // **首个报错的来源**区分发起方：rs 先报 = 真读不出来；req 先报 = 网络故障，
      // 读流其后冒出的同一错误只是拆除回声，按 NETWORK 归类交给既有重试 / 退避。
      let firstErrFrom: '' | 'rs' | 'req' = ''
      let rsErr: any = null
      rs.on('error', (e) => {
        if (!firstErrFrom) {
          firstErrFrom = 'rs'
          rsErr = e
        }
      })
      req.on('error', () => {
        if (!firstErrFrom) firstErrFrom = 'req'
      })
      const chain: any[] = [rs]
      // 口径同下载分支（liveBW 见彼处注释）：调度器轮次一律挂桶、速率实时可变
      const liveBW = !!(cfg && cfg.__wdsyncLiveLimits)
      if (liveBW || netOpts.uploadKBps > 0) chain.push(throttleTransform(url.origin, 'up', netOpts.uploadKBps, liveBW))
      if (h) chain.push(hashTransform(h))
      // 上传流量计数（挂管道末端 = 实际交给网络的字节；限速开启时反映被限后的真实速率）
      // onBytes：上传进度的逐块回调（引擎侧推进 bytesDone）
      chain.push(countTransform(cfg, 'up', opts.onBytes))
      chain.push(req)
      pipeline(chain, (err) => {
        if (!err) return // 正常收尾交由响应回调 resolve
        // 取消销毁（abortErr 非空）优先于读流失败判定 —— 取消不是本地 IO 故障
        if (abortErr) {
          finish(reject, abortErr)
          return
        }
        if (firstErrFrom === 'rs') {
          const e2 = mkOpError(`「${path.basename(opts.bodyFile || '')}」未上传：文件暂时读不出来`, 'LOCAL_IO', {
            permanent: true,
            // source='body-read'：上传读流失败 —— 已发出的字节服务器可能已收，意图须保持开放
            detail: `${(rsErr && rsErr.code) || (rsErr && rsErr.message) || err} ${opts.bodyFile || ''}`,
            extra: { source: 'body-read' },
          })
          req.destroy(e2)
          finish(reject, e2)
          return
        }
        finish(reject, normalizeNetError(err, url))
      })
    } else if (bodyBuf != null) {
      // 缓冲形态的 PUT 请求体同样计入上传流量（锁写回等小体积请求混入可忽略）
      if (method === 'PUT') noteTraffic(cfg, 'up', bodyBuf.length)
      req.end(bodyBuf)
    } else {
      req.end()
    }
  })
}

/**
 * 带重试的单 URL 请求：
 *  - 幂等方法（GET/PROPFIND/OPTIONS/DELETE/MKCOL）：网络异常或 429/503/423/5xx 最多重试 3 次；
 *  - PUT 仅在 429/503/423 上重试 —— 这些状态代表服务端明确「未处理请求」（未落地任何字节），
 *    重发不会造成二次应用；而纯网络层异常无法判断对端是否已收到/应用部分字节，PUT 一律不重试
 *    （引擎的 WAL / 基线语义都假定每次上传至多应用一次），宁可直接失败交给整轮重规划兜底；
 *  - 其余 4xx 不重试；本地 IO 类错误（LOCAL_IO，permanent）不重试。
 * 退避：500ms × 2^n ± 25% 抖动；429/503 优先采用 Retry-After（已截断 30s 上限，超限标记 capped）。
 */
export async function requestWithRetry(cfg: EngineCfg, method: string, url: URL, opts: ReqOpts, netOpts: ResolvedNetOpts): Promise<DavResponse> {
  const idempotent = IDEMPOTENT_METHODS.has(method)
  const breaker = cfg && cfg.__wdsyncBreaker
  let waitMs = 0
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) await sleep(waitMs)
    // 整轮熔断：open 后本轮所有请求快速失败，不再消耗重试预算
    if (breaker && breaker.open) throw breaker.error()
    // 取消：取消后不再发起新的尝试（首次 / 幂等重试 / 重定向跟随一律拦截）
    if (cfg && typeof cfg.__wdsyncAbort === 'function' && cfg.__wdsyncAbort()) throw makeAbortError(url)
    if (netOpts.ratePerSec > 0) await acquireRateSlot(url.origin, netOpts.ratePerSec)
    let res
    try {
      res = await singleRequest(cfg, method, url, opts, netOpts)
    } catch (e: any) {
      if (e && e.permanent) throw e // 本地 IO 类失败：重试无意义
      // 在途传输被取消销毁 —— 立即透传，绝不进入幂等重试（重试会让取消失效）
      if (e && e.code === 'ABORTED') throw e
      if (idempotent && attempt < MAX_RETRIES && !opts.noRetry) {
        waitMs = backoffDelayMs(attempt, null)
        continue
      }
      // 网络层异常耗尽重试：计入整轮熔断（服务器整体不可用的信号）
      if (breaker && e && e.code === 'NETWORK') breaker.noteFailure(`${method} ${url.host}：${e.message}`)
      throw e
    }
    const s = res.status
    // 由 RETRYABLE_STATUS_ANY_METHOD（429/503/423）推导 + 5xx 全段：语义与原字面
    // 逐码等价（503 本就落在 5xx 区间内），口径只在这两处声明
    const retryable = RETRYABLE_STATUS_ANY_METHOD.has(s) || (s >= 500 && s < 600)
    const methodAllowed = RETRYABLE_STATUS_ANY_METHOD.has(s) || idempotent
    if (retryable && methodAllowed && attempt < MAX_RETRIES && !opts.noRetry) {
      waitMs = backoffDelayMs(attempt, res.classification || classifyStatus(s, res.headers))
      continue
    }
    // 终态结果：5xx/429 计入熔断计数（文件级 4xx / 2xx / 3xx 一律视为服务器健康）
    if (breaker) {
      if (retryable) breaker.noteFailure(`${method} ${url.host}：HTTP ${s}`)
      else breaker.noteSuccess()
    }
    return res
  }
}

/**
 * 发送一个 WebDAV 请求（网络层总入口）。
 * opts: { headers, body(Buffer|string), bodyFile(本地路径，流式上传), sinkFile(本地路径，流式下载),
 *         hashAlg(如 'sha256'：bodyFile 时对请求体、否则对响应体计算，结果在返回值 hashHex),
 *         isCollection(目标为集合：URL 统一补尾斜杠), noRetry(禁用自动重试的逃生口) }
 * 返回 { status, headers, body, etag, hashHex?, classification? }。
 *
 * 框架约定：HTTP 错误状态码正常 resolve（调用方检查 r.status / r.classification），
 * 只有网络层异常（重试耗尽后）才 reject —— 错误对象带 status=0、code='NETWORK'、permanent=false。
 *
 * 重定向：301/302/307/308 最多跟随 3 次，仅同源，保留方法与请求体（bodyFile 场景每次
 * 跟随都重新创建文件读流）；相对 Location 以当前 URL 解析为绝对；跨源拒绝跟随并抛出含
 * 源与目标 URL 的可读错误（认证头绝不能被引到另一个源）。
 */
export async function davRequest(cfg: EngineCfg, method: string, remotePath: string, opts: ReqOpts = {}): Promise<DavResponse> {
  const netOpts = resolveNetOpts(cfg)
  let startUrl
  try {
    startUrl = new URL(remoteUrl(cfg, remotePath))
  } catch (e: any) {
    const invalid: any = new Error('服务器地址格式不对，应以 http:// 或 https:// 开头')
    invalid.detail = cfg && cfg.serverUrl
    throw invalid
  }
  // 集合类 URL 统一带尾斜杠：部分服务器对无尾斜杠的集合 PROPFIND 返回 301，
  // 与其每次跟随重定向，不如一开始就按规范形态发起
  if (opts.isCollection && !startUrl.pathname.endsWith('/')) startUrl.pathname += '/'
  let current = startUrl
  // Digest 预热：该 origin+账号已有缓存挑战时直接预带应答头（省一次 401 往返；
  // 应答被拒时服务器回 401 + 新挑战，由下方挑战分支刷新缓存重试）
  let curOpts = opts
  const preheat = nextDigestHeader(cfg, current, method)
  if (preheat) curOpts = { ...opts, headers: { ...opts.headers, Authorization: preheat } }
  let redirects = 0
  let authRetries = 0
  for (;;) {
    const res = await requestWithRetry(cfg, method, current, curOpts, netOpts)
    // Digest 挑战应答：401 + Digest 挑战 → 更新缓存并带应答头重试（上限 2 次：
    // Basic 降级 + nonce 更换各一次）。401 = 服务器未处理请求（未落地字节），
    // 对任何方法（含 PUT）重发安全；nc 按缓存序号递增，stale 时沿用原 nonce 计数
    if (res.status === 401 && authRetries < 2 && cfg && cfg.username) {
      const rawChallenge = digestChallengeOf(res.headers)
      const parsed = rawChallenge != null ? parseDigestChallenge(rawChallenge) : null
      if (parsed) {
        const dk = digestCacheKey(cfg, current)
        const cached = digestChallenges.get(dk)
        const nonceChanged = !cached || cached.ch.nonce !== parsed.nonce
        if (nonceChanged || parsed.stale) {
          digestChallenges.set(dk, { ch: parsed, nc: nonceChanged ? 0 : cached ? cached.nc : 0 })
          const hdr = nextDigestHeader(cfg, current, method)
          if (hdr) {
            curOpts = { ...opts, headers: { ...opts.headers, Authorization: hdr } }
            authRetries++
            continue
          }
        }
      }
    }
    if (!REDIRECT_STATUS.has(res.status) || !res.headers || res.headers.location == null) {
      // 附带已跟随的重定向次数：能力探测据此观察「集合 URL 无尾斜杠是否被 301」
      // 一类服务器行为；其余调用方不受影响（新增字段）
      res.redirectCount = redirects
      return res
    }
    if (redirects >= MAX_REDIRECTS) {
      const loop: any = new Error('服务器地址一直在跳转，无法连接，请检查地址是否正确')
      loop.detail = `重定向超过 ${MAX_REDIRECTS} 次：${startUrl.href}`
      throw loop
    }
    let next
    try {
      next = new URL(String(res.headers.location), current)
    } catch (e: any) {
      const badLoc: any = new Error('服务器地址一直在跳转，无法连接，请检查地址是否正确')
      badLoc.detail = `重定向地址无效（${res.headers.location}）：${current.href}`
      throw badLoc
    }
    if (next.origin !== current.origin) {
      throw mkOpError(`服务器想把请求转到另一个网站（${next.origin}），出于安全已拒绝。如果新地址可信，请直接填写新地址`, 'REDIRECT', {
        status: res.status,
        permanent: true,
        detail: `${current.href} → ${next.href}`,
      })
    }
    // 重定向后的新 URL：Digest 应答头里的 uri 与路径绑定，回到无认证形态重走
    //（同源重定向不换挑战缓存，401 时上方分支按新路径重建应答）
    current = next
    curOpts = opts
    authRetries = 0
    redirects++
  }
}
