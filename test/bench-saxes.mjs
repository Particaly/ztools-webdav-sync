/**
 * saxes multistatus 解析基准。
 * 样本构成：中文名（原始 UTF-8 与百分号编码交替）、
 * 空格 %20、%23、十进制/十六进制实体、&amp;、每 3 条一个 CDATA etag、每 64 条一个目录、
 * D: 前缀（未在元素上重复声明，验证剥前缀策略）。
 * 用法：node --expose-gc test/bench-saxes.mjs [entries]  （默认 50000；无 --expose-gc 也可跑，内存数据略粗）
 */
import { deflateSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const N = Number(process.argv[2]) || 50000

globalThis.window = {}
await import(pathToFileURL(path.join(HERE, '..', 'src-ztools', 'preload', 'services.js')).href)
const { parseMultistatus, createMultistatusStream } = globalThis.window.services.sync._internals

const parts = ['<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n']
for (let i = 0; i < N; i++) {
  const isDir = i % 64 === 63
  let href
  if (i % 5 === 0) href = `/dav/bench/%E4%B8%AD%E6%96%87%20${i}.txt`
  else if (i % 7 === 0) href = `/dav/bench/tag%23-${i}.txt`
  else if (i % 11 === 0) href = `/dav/bench/&#x4E2D;&#x6587;-${i}.txt`
  else href = `/dav/bench/file-${i}.txt`
  const etag = i % 3 === 0 ? `<![CDATA["e&${i}"]]>` : `"e&amp;${i}"`
  parts.push(
    `  <D:response>\n    <D:href>${href}</D:href>\n    <D:propstat><D:prop>` +
      (isDir
        ? '<D:resourcetype><D:collection/></D:resourcetype>'
        : `<D:resourcetype/><D:getcontentlength>${(i % 1000) + 1}</D:getcontentlength>`) +
      `<D:getlastmodified>2023-11-14T22:13:20.000Z</D:getlastmodified>` +
      (isDir ? '' : `<D:getetag>${etag}</D:getetag>`) +
      `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>\n  </D:response>\n`
  )
}
parts.push('</D:multistatus>')
const xml = parts.join('')
const docBytes = Buffer.byteLength(xml, 'utf-8')
console.log(`entries=${N} doc=${(docBytes / 1048576).toFixed(1)}MB node=${process.version}`)

const gc = typeof globalThis.gc === 'function' ? globalThis.gc : null
const heap = () => process.memoryUsage().heapUsed
const fmtMB = (b) => `${(b / 1048576).toFixed(1)}MB`

// ---- 一次性解析（现状「攒完 body 再 parse」）：预热 1 次 + 3 次取最好 ----
let keep = null
let bestMs = Infinity
let peakDelta = 0
for (let r = 0; r < 4; r++) {
  if (gc) gc()
  const before = heap()
  const t0 = process.hrtime.bigint()
  const entries = parseMultistatus(xml)
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const delta = heap() - before
  if (r === 0) {
    keep = entries
    continue // 预热
  }
  if (ms < bestMs) bestMs = ms
  if (delta > peakDelta) peakDelta = delta
}
console.log(
  `one-shot: best=${bestMs.toFixed(0)}ms (${((docBytes / bestMs) * 1000 / 1048576).toFixed(0)}MB/s) ` +
    `parse-time heapDelta≈${fmtMB(peakDelta)} entries=${keep.length} sample=${JSON.stringify(keep[Math.floor(N / 2)])}`
)
if (gc) {
  keep = null
  gc()
  const empty = heap()
  const entries2 = parseMultistatus(xml)
  keep = entries2
  gc()
  console.log(`one-shot: resident-after-gc(entries only)≈${fmtMB(heap() - empty)}`)
  keep = null
}

// ---- 分块流式（64KiB 模拟网络到达）：StringDecoder 缝合多字节边界 ----
{
  if (gc) gc()
  const base = heap()
  const t0 = process.hrtime.bigint()
  const st = createMultistatusStream()
  const buf = Buffer.from(xml, 'utf-8')
  let peak = 0
  for (let i = 0; i < buf.length; i += 65536) {
    st.write(buf.subarray(i, Math.min(i + 65536, buf.length)))
    peak = Math.max(peak, heap() - base)
  }
  st.close()
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(`stream-64KiB: ${ms.toFixed(0)}ms (${((docBytes / ms) * 1000 / 1048576).toFixed(0)}MB/s) entries=${st.entries().length} peakHeap(gross)≈${fmtMB(peak)}`)
}

// ---- 打包体积（preload bundle 与 saxes 占比） ----
{
  const bundlePath = path.join(HERE, '..', 'src-ztools', 'preload', 'dist', 'services.js')
  try {
    const b = fs.readFileSync(bundlePath)
    const gz = deflateSync(b, { level: 9 })
    console.log(`bundle: ${path.basename(bundlePath)} raw=${(b.length / 1024).toFixed(1)}KB gzip=${(gz.length / 1024).toFixed(1)}KB`)
  } catch (_) {
    console.log('bundle: (先运行 npm run build:preload 再跑基准可附体积数据)')
  }
}
