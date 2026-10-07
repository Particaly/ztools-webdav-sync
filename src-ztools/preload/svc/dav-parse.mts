/* eslint-disable */
// svc/dav-parse.mts —— URL / 认证头 / multistatus XML 解析域：
//   远端 URL 拼接与逐段编码（remoteUrl / stripRemoteSlashes / joinRemote）、Basic /
//   Digest 认证头（含按 origin+账号 的挑战缓存与 nc 序号）、saxes 流式 multistatus
//   解析（createMultistatusStream / parseMultistatus / relFromHref）。纯解析域：
//   不发请求、不碰存储、无模块级可变状态（digestChallenges 缓存除外，见其注释）。
import crypto from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { SaxesParser } from 'saxes'
import type { EngineCfg } from './base.mts'

/**
 * 剥离远端路径首尾的连续斜杠（URL 拼接 / 路径分段前的「形状清理」用）。
 * 与 normalizeRemoteKey（storage 层）的分工：本函数只动斜杠、不改写 Unicode
 * 归一形态；同步键的 NFC 归一一律走 normalizeRemoteKey，两者不可互换。
 */
export function stripRemoteSlashes(p: string): string {
  return String(p || '').replace(/^\/+|\/+$/g, '')
}

/** 将远端相对路径拼接为绝对 URL，并对每个路径段做 URI 编码 */
export function remoteUrl(cfg: EngineCfg, remotePath: string): string {
  const base = String(cfg.serverUrl || '').replace(/\/+$/, '')
  const rel = stripRemoteSlashes(remotePath)
  const encoded = rel ? rel.split('/').map(encodeURIComponent).join('/') : ''
  return encoded ? `${base}/${encoded}` : `${base}/`
}

/** Basic 认证头 */
export function authHeader(cfg: EngineCfg): Record<string, string> {
  if (!cfg.username && !cfg.password) return {}
  const token = Buffer.from(`${cfg.username || ''}:${cfg.password || ''}`).toString('base64')
  return { Authorization: `Basic ${token}` }
}

// ---------- Digest 认证（401 挑战应答，与 Basic 共存） ----------
//
// 请求默认先带 Basic；服务器回 401 且携带 Digest 挑战（WWW-Authenticate: Digest …）
// 时按 RFC 7616 计算应答头重试 —— 部分老 NAS / 路由器 / Apache 只支持 Digest，
// 命中即「连不上」，这是它们的唯一通道。挑战参数按 origin+账号缓存复用：后续
// 请求直接预带 Digest 头（省一次 401 往返），nonce 更换 / stale=true 时刷新重试。
// 401 表示服务器未处理请求（未落地任何字节），对 PUT 重发安全，与 WAL 语义不冲突。

/** 解析后的 Digest 挑战参数（WWW-Authenticate: Digest 头的值部分） */
interface DigestChallenge {
  realm: string
  nonce: string
  /** 服务器提供的 qop 列表（逗号分隔原串，如 "auth,auth-int"）；缺省 = RFC 2069 旧式 */
  qop?: string
  opaque?: string
  /** 算法 token（缺省按 MD5）；带 '-sess' 后缀时 HA1 经 nonce+cnonce 再哈希 */
  algorithm?: string
  /** 服务器声明 nonce 过期但凭据有效（客户端应换 cnonce 重试，不必重新要凭据） */
  stale?: boolean
}

/** 挑战缓存：origin|username → { ch, nc }；nc 为该 nonce 已消耗的序号（8 位十六进制输出） */
export const digestChallenges = new Map<string, { ch: DigestChallenge; nc: number }>()

/** 缓存键：origin + 账号（与能力缓存同粒度 —— 同一服务器多账号各自应答） */
export function digestCacheKey(cfg: EngineCfg, url: URL): string {
  return `${url.origin}|${(cfg && cfg.username) || ''}`
}

/**
 * 解析 Digest 挑战参数：形如 realm="x", nonce="y", qop="auth", opaque="z" 的
 * 逗号分隔键值对（值可带双引号，引号内逗号不分隔）。realm / nonce 缺失、引号
 * 未闭合等畸形挑战返回 null（按无法应答处理，401 按原语义上抛）。
 */
export function parseDigestChallenge(raw: string): DigestChallenge | null {
  const s = String(raw || '')
  const params: Record<string, string> = {}
  let i = 0
  while (i < s.length) {
    while (i < s.length && (s[i] === ',' || s[i] === ' ' || s[i] === '\t')) i++
    const eq = s.indexOf('=', i)
    if (eq < 0) break
    const key = s.slice(i, eq).trim().toLowerCase()
    let val = ''
    i = eq + 1
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1)
      if (end < 0) return null
      val = s.slice(i + 1, end)
      i = end + 1
    } else {
      let j = i
      while (j < s.length && s[j] !== ',') j++
      val = s.slice(i, j).trim()
      i = j
    }
    if (key) params[key] = val
  }
  if (!params.realm || !params.nonce) return null
  return {
    realm: params.realm,
    nonce: params.nonce,
    qop: params.qop,
    opaque: params.opaque,
    algorithm: params.algorithm,
    stale: params.stale === 'true',
  }
}

/** 算法 token → Node 哈希名（'-sess' 变体取基底；不支持的算法返回 null = 放弃应答） */
function digestHashName(algorithm?: string): string | null {
  const t = String(algorithm || 'MD5').trim().toUpperCase()
  const base = t.replace(/-SESS$/, '')
  const mapped = base === 'MD5' ? 'md5' : base === 'SHA-256' ? 'sha256' : base === 'SHA-512-256' ? 'sha512-256' : null
  if (!mapped) return null
  try {
    crypto.createHash(mapped)
  } catch (_) {
    return null
  }
  return mapped
}

/**
 * Authorization 头 quoted-string 转义（RFC 7616 3.4 节：头字段值以 "..." 包裹时，
 * 值内的反斜杠与双引号必须分别转义为 \\ 与 \"）。username 是用户自由输入、
 * realm / nonce / opaque 来自服务器挑战原文，都可能含这两个字符 —— 裸拼进引号会
 * 提前闭合 quoted-string、破坏头结构（被服务器 401 拒绝或解析出错误字段）。
 * 只作用于头展示层：response / HA1 / HA2 的哈希输入仍用未转义原文（RFC 语义）。
 */
function qdEscape(v: string): string {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * 计算 Digest Authorization 头的值（含 'Digest ' 前缀）。
 * qop 协商：服务器提供 auth 则用 auth（带 nc / cnonce）；未提供 qop 按 RFC 2069
 * 旧式应答（response = H(HA1:nonce:HA2)）；只提供 auth-int 时不支持（引擎传输
 * 流式进行、无法在头里给出请求体哈希）返回 null。算法不支持 / 参数不全同 null。
 * @param nc 该 nonce 的已消耗序号（调用方先递增再传入；输出补零至 8 位十六进制）
 */
export function digestAuthorization(ch: DigestChallenge, nc: number, cnonce: string, username: string, password: string, method: string, uri: string): string | null {
  const hashName = digestHashName(ch.algorithm)
  if (!hashName || !ch.realm || !ch.nonce || !username) return null
  const H = (s: string) => crypto.createHash(hashName).update(s).digest('hex')
  const qopList = String(ch.qop || '').split(',').map((q) => q.trim()).filter(Boolean)
  if (qopList.length && !qopList.includes('auth')) return null
  const qop = qopList.includes('auth') ? 'auth' : ''
  const sess = /-SESS$/i.test(String(ch.algorithm || ''))
  const ha1Plain = H(`${username}:${ch.realm}:${password}`)
  const ha1 = sess ? H(`${ha1Plain}:${ch.nonce}:${cnonce}`) : ha1Plain
  const ha2 = H(`${method}:${uri}`)
  const ncHex = String(nc).padStart(8, '0')
  const response = qop === 'auth' ? H(`${ha1}:${ch.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${ch.nonce}:${ha2}`)
  const parts = [
    // 引号包裹的字段一律 qdEscape（规则与风险见其函数注释）；response / cnonce /
    // nc / qop / algorithm 只含十六进制或固定 token，无须转义
    `username="${qdEscape(username)}"`,
    `realm="${qdEscape(ch.realm)}"`,
    `nonce="${qdEscape(ch.nonce)}"`,
    `uri="${qdEscape(uri)}"`,
    `response="${response}"`,
    ...(qop === 'auth' ? [`qop=${qop}`, `nc=${ncHex}`, `cnonce="${cnonce}"`] : []),
    ...(ch.algorithm ? [`algorithm=${String(ch.algorithm).trim().toUpperCase()}`] : []),
    ...(ch.opaque ? [`opaque="${qdEscape(ch.opaque)}"`] : []),
  ]
  return `Digest ${parts.join(', ')}`
}

/**
 * 从响应头提取 Digest 挑战（WWW-Authenticate 可为数组 / 逗号并置多方案）；
 * 服务器未提供 Digest 方案返回 null（Basic 专用服务器的 401 维持原语义）。
 */
export function digestChallengeOf(headers: Record<string, any> | undefined): string | null {
  const raw = headers && headers['www-authenticate']
  if (raw == null) return null
  const list = Array.isArray(raw) ? raw : [raw]
  for (const v of list) {
    const s = String(v)
    if (/^digest\s+/i.test(s)) return s.replace(/^digest\s+/i, '')
  }
  return null
}

/**
 * 为当前请求构建 Digest 应答头：消耗缓存条目的下一个 nc 序号。
 * 挑战无效 / 算法不支持返回 null（调用方维持原请求形态）。
 */
export function nextDigestHeader(cfg: EngineCfg, url: URL, method: string): string | null {
  const entry = digestChallenges.get(digestCacheKey(cfg, url))
  if (!entry || !cfg.username) return null
  entry.nc++
  const cnonce = crypto.randomBytes(8).toString('hex')
  return digestAuthorization(entry.ch, entry.nc, cnonce, cfg.username, cfg.password || '', method, url.pathname + url.search)
}

/**
 * multistatus 提取器（saxes 流式实现）。
 *
 * 语义要点：
 *  - 不开 xmlns 选项：真实抓包偶见「未声明的前缀」，开了会在 opentag 处硬错误；
 *    前缀剥离沿用 localName 策略，D: / d: / 无前缀（乃至任意前缀）统一覆盖；
 *  - <response> 内同名 prop 首次出现生效（first-match，
 *    含 404 propstat 与 200 propstat 并存时的取舍顺序）；
 *  - <response> / <collection> 标签容忍携带属性（逐元素 xmlns 声明等）；
 *  - CDATA 与普通文本按出现顺序拼进同一缓冲：text 事件已按 XML 规范解码实体
 *    （十进制 / 十六进制 / 预定义实体），CDATA 为字面文本不解码 —— 两者直接相连即可，
 *    <![CDATA[...]]> 标记本身不会进入取值。
 *
 * 错误语义（安全关键）：saxes 出错只发 error 事件不抛异常；此处记下首个错误，
 * close() 之后统一 throw —— 畸形 XML（截断 / 未闭合 / 坏实体 / 标签不匹配）
 * 必须让调用方把该目录扫描判为 incomplete，绝不静默返回部分结果（否则残缺
 * 列表会被决策层解释成「远端已删除」触发误删）。
 *
 * 流式接口：write() 接受 string 或 Buffer（Buffer 经 StringDecoder 转 utf-8，
 * 防止多字节中文文件名被网络块边界拆断）；条目在 <response> 闭合时即产出，
 * 不为整篇文档建树 —— Depth: infinity 大响应的内存驻留只与条目数相关。
 */
/** 数字属性解析：非有限数字（缺失 / 服务器回了非数字文本）返回 undefined */
function finiteNumOrNull(v: string): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function createMultistatusStream(): any {
  const decoder = new StringDecoder('utf8')
  const parser = new SaxesParser({})
  const entries: any[] = []
  let firstError: any = null
  let cur: any = null // 当前 <response> 的累积条目
  let capture: any = null // 正在收集文本的 prop：{ field, buf }
  // quota-available-bytes / quota-used-bytes（RFC 4331）：集合条目可选携带的配额
  // 属性 —— 云端剩余空间的展示与轮前预检的数据来源；不返回的服务器条目上缺省。
  const FIELDS = new Set(['href', 'getcontentlength', 'getlastmodified', 'getetag', 'status', 'quota-available-bytes', 'quota-used-bytes'])
  parser.on('error', (e) => {
    if (firstError == null) firstError = e
  })
  parser.on('opentag', (node) => {
    const name = localName(node.name)
    if (name === 'response') {
      if (!cur) cur = { href: '', isDir: false, size: 0, mtime: 0, etag: '', quotaAvailable: undefined, quotaUsed: undefined, seen: new Set<any>() }
      return
    }
    if (!cur) return
    if (name === 'collection') {
      cur.isDir = true
      return
    }
    // first-match：同名 prop 只取首次出现；已在本字段收集期间不重开（防嵌套同名元素）
    if (FIELDS.has(name) && !cur.seen.has(name) && !capture) {
      cur.seen.add(name)
      capture = { field: name, buf: '' }
    }
  })
  const appendText = (t: any) => {
    if (capture) capture.buf += t
  }
  parser.on('text', appendText)
  parser.on('cdata', appendText)
  parser.on('closetag', (tag) => {
    const name = localName(typeof tag === 'string' ? tag : tag.name)
    if (capture && name === capture.field) {
      const v = capture.buf.trim()
      if (capture.field === 'href') cur.href = v
      else if (capture.field === 'getcontentlength') cur.size = Number(v) || 0
      else if (capture.field === 'getlastmodified') cur.mtime = v ? Date.parse(v) || 0 : 0
      else if (capture.field === 'status') cur.status = v
      else if (capture.field === 'quota-available-bytes') cur.quotaAvailable = finiteNumOrNull(v)
      else if (capture.field === 'quota-used-bytes') cur.quotaUsed = finiteNumOrNull(v)
      else cur.etag = v
      capture = null
      return
    }
    if (name === 'response' && cur) {
      // href 的百分号序列可能是坏的（文件名含裸 % 的服务器未编码输出）：
      // 解码失败退回原串，不能让单个坏条目炸掉整次目录解析
      let href = cur.href
      try {
        href = decodeURIComponent(href)
      } catch (_) {
        /* 保留原值 */
      }
      entries.push({
        href,
        isDir: cur.isDir,
        size: cur.size,
        mtime: cur.mtime,
        etag: cur.etag,
        status: cur.status || '',
        // 配额属性可选携带（服务器未返回 / 非 404 propstat 缺失时为 undefined）
        ...(cur.quotaAvailable !== undefined ? { quotaAvailable: cur.quotaAvailable } : {}),
        ...(cur.quotaUsed !== undefined ? { quotaUsed: cur.quotaUsed } : {}),
      })
      cur = null
    }
  })
  return {
    /** 喂入一段响应（string 或 Buffer；Buffer 经 StringDecoder 防多字节拆断） */
    write(chunk: any) {
      parser.write(typeof chunk === 'string' ? chunk : decoder.write(chunk))
    },
    /** 收尾；存在任一解析错误时统一抛出（调用方据此把扫描判为 incomplete） */
    close() {
      parser.close()
      if (firstError) {
        // 面向用户一句话；原始解析错误放 detail（反馈问题时可见）
        const err: any = new Error('服务器返回的内容无法识别，请确认地址是 WebDAV 地址')
        err.code = 'XML_PARSE'
        err.detail = firstError.message
        throw err
      }
    },
    /** 已成功产出的条目（close() 抛错时调用方不得使用本结果） */
    entries() {
      return entries
    },
  }
}

/** 标签名剥命名空间前缀：D:href / d:href / href（乃至任意未声明前缀）统一取 localName */
function localName(name: string): string {
  const i = String(name).indexOf(':')
  return i >= 0 ? String(name).slice(i + 1) : String(name)
}

/**
 * 解析 WebDAV multistatus XML，返回条目数组（与命名空间前缀无关）。
 * 签名与输出形状：[{ href, isDir, size, mtime, etag }]；
 * 集合条目可选携带 quotaAvailable / quotaUsed（RFC 4331 配额属性，服务器未
 * 返回时字段缺省 —— 云端剩余空间展示与轮前预检的数据来源）。
 * 畸形 XML 一律 throw（code='XML_PARSE'）——绝不静默返回部分结果。
 */
export function parseMultistatus(xml: string): any {
  const stream = createMultistatusStream()
  stream.write(String(xml))
  stream.close()
  return stream.entries()
}

/**
 * 依据服务端返回的 href 计算其相对于集合路径的 rel 路径（posix 分隔）。
 * 以集合自身的 URL pathname 为基准剥离，可正确处理 /remote.php/dav/ 之类的挂载前缀。
 * 返回空字符串表示条目是集合自身。
 */
export function relFromHref(cfg: EngineCfg, collectionRemote: string, href: string): string {
  let itemPath = href
  try {
    const u = new URL(href, cfg.serverUrl)
    // 规范的 href 不会含未编码的 #（那会变成 fragment），因此 hash 非空必然意味着
    // 文件名本身带 #（parseMultistatus 已把 %23 提前解码成 #）：并回路径，否则文件名被截断
    itemPath = decodeURIComponent(u.pathname + (u.hash || ''))
  } catch (_) {
    /* 保留原值 */
  }
  let colPath
  try {
    // 与 itemPath 同样解码后再比对：remoteUrl 会逐段做百分号编码，
    // 不解码时中文等非 ASCII 目录名比对失败，会退化成返回整条 itemPath（相对路径错误）
    colPath = decodeURIComponent(new URL(remoteUrl(cfg, collectionRemote)).pathname)
  } catch (_) {
    colPath = '/' + stripRemoteSlashes(collectionRemote)
  }
  if (!colPath.endsWith('/')) colPath += '/'
  if (itemPath === colPath || itemPath === colPath.replace(/\/$/, '')) return ''
  if (itemPath.startsWith(colPath)) {
    return itemPath.slice(colPath.length).replace(/\/+$/, '')
  }
  // 回退：按段剥离基准目录（href 与集合不同源等异常情况）
  const baseSeg = stripRemoteSlashes(collectionRemote)
    .split('/')
    .filter(Boolean)
  const segs = itemPath.replace(/^\/+/, '').split('/').filter(Boolean)
  let i = 0
  while (i < baseSeg.length && segs[segs.length - baseSeg.length + i] === baseSeg[i]) i++
  if (i === baseSeg.length) return segs.slice(0, segs.length - baseSeg.length).join('/')
  return segs.join('/')
}
/** 拼接远端子路径 */
export function joinRemote(base: string, name: string): string {
  return `${String(base).replace(/\/+$/, '')}/${name}`
}
