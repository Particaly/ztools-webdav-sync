/**
 * 离线安装包打包脚本：把 src-ztools 打成 ZTools 可离线安装的 .zpx。
 *
 * ZPX 格式与宿主 src/main/utils/zpxArchive.ts 的 packZpx 一致：
 *   zpx = brotli(quality 5)( asar( src-ztools ) )
 *
 * 打包后自动做产物内容检查（与 test/host-load-check.mjs 同一标准）：
 *   - 必需文件：plugin.json、preload/dist/services.js、dist/index.html
 *   - 违禁条目：test/、node_modules/、.throttle-bench*、.dav-root*
 *
 * 用法：npm run build && node scripts/pack-zpx.mjs
 * 产物：release/webdav-sync-<version>.zpx
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createBrotliCompress, constants as zlibConstants } from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..')
const SRC = path.join(PLUGIN, 'src-ztools')
const OUT_DIR = path.join(PLUGIN, 'release')

// @electron/asar 优先用本地依赖，缺失时借用宿主仓库（与 host-load-check.mjs 相同的候选顺序）
const HOST_CANDIDATES = [
  path.join(PLUGIN, '..', '..', 'ZTools'),
  'D:\\workspace\\self\\ZTools',
]

async function resolveAsar() {
  try {
    return await import('@electron/asar')
  } catch {}
  for (const host of HOST_CANDIDATES) {
    const pkgDir = path.join(host, 'node_modules', '@electron', 'asar')
    const pkgJsonPath = path.join(pkgDir, 'package.json')
    if (!fs.existsSync(pkgJsonPath)) continue
    // 按该包自己的 exports / main 解析入口，避免依赖特定版本的内部分支路径
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
    const entry = typeof pkg.exports === 'string' ? pkg.exports : pkg.main
    if (!entry) continue
    return import(pathToFileUrl(pkgDir, entry))
  }
  throw new Error('找不到 @electron/asar：请先 npm i -D @electron/asar，或确认宿主仓库 ZTools 已检出')
}

function pathToFileUrl(p, entry) {
  return 'file:///' + path.join(p, entry).replace(/\\/g, '/')
}

async function main() {
  const asar = await resolveAsar()
  const pluginConfig = JSON.parse(await fsp.readFile(path.join(SRC, 'plugin.json'), 'utf-8'))
  const version = pluginConfig.version
  if (!version) throw new Error('plugin.json 缺少 version')

  // 构建产物前置检查：缺了就提示先跑构建，避免打出残缺包
  const required = ['plugin.json', 'logo.png', 'dist/index.html', 'preload/dist/services.js']
  const missing = required.filter((r) => !fs.existsSync(path.join(SRC, r)))
  if (missing.length) {
    throw new Error(`缺少构建产物：${missing.join(', ')} —— 请先执行 npm run build`)
  }

  await fsp.mkdir(OUT_DIR, { recursive: true })
  const outPath = path.join(OUT_DIR, `webdav-sync-${version}.zpx`)

  // 1) src-ztools → asar（宿主 packZpx 同款 createPackage）
  const tempAsar = path.join(os.tmpdir(), `zpx-pack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.asar`)
  let entryCount = 0
  try {
    await asar.createPackage(SRC, tempAsar)

    // 2) 产物内容检查：必需文件齐全、无仓库资产混入
    asar.uncache(tempAsar)
    const entries = asar
      .listPackage(tempAsar, { isPack: false })
      .map((p) => p.replace(/\\/g, '/').replace(/^\/+/, ''))
    const forbidden = entries.filter((e) =>
      /(^|\/)(test|node_modules)(\/|$)|\.throttle-bench|\.dav-root/.test(e)
    )
    const missingInAsar = required.filter((r) => !entries.includes(r))
    if (forbidden.length || missingInAsar.length) {
      if (forbidden.length) console.error('违禁条目样例:', forbidden.slice(0, 5).join(' | '))
      if (missingInAsar.length) console.error('缺失文件:', missingInAsar.join(', '))
      throw new Error('打包产物内容检查未通过')
    }
    entryCount = entries.length

    // 3) asar → brotli(quality 5) → .zpx
    await pipeline(
      fs.createReadStream(tempAsar),
      createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }),
      fs.createWriteStream(outPath)
    )
  } finally {
    await fsp.rm(tempAsar, { force: true })
  }

  const size = (await fsp.stat(outPath)).size
  console.log(`✅ ${outPath} (${(size / 1024).toFixed(1)} KB, ${entryCount} 个文件, v${version})`)
}

main().catch((e) => {
  console.error('❌ 打包失败:', e && e.message)
  process.exit(1)
})
