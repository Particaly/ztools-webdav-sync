/**
 * 宿主加载验证：用宿主仓库自带的 Electron（41.4.0）按宿主
 * pluginManager 的 webPreferences 形态（sandbox:false / contextIsolation:false /
 * nodeIntegration:false / webSecurity:false / backgroundThrottling:false + preload）
 * 真实加载 preload 产物，并完成一次「连接测试 + 上传 + 空轮 no-op」真实同步。
 *
 * 两种安装形态各验一遍：
 *   1) 目录形态：preload 直接指向 src-ztools/preload/dist/services.js；
 *   2) asar 形态（zpx 的实体即 asar）：先用宿主的 @electron/asar 把 src-ztools
 *      打成 asar，再让 preload 指向 asar 内的虚拟路径（Electron 内建 asar 支持）。
 * 打 asar 后顺带做打包产物内容检查：asar 内不得含 test/、node_modules/ 等仓库资产。
 *
 * 用法：node test/host-load-check.mjs [hostRepoRoot]
 * （hostRepoRoot 缺省按平台推断：插件仓库的同级 ../ZTools，不存在再退回
 *   Windows 宿主仓 D:\workspace\self\ZTools；须先 npm run build）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..')
const DEFAULT_HOST_CANDIDATES = [
  path.join(PLUGIN, '..', '..', 'ZTools'), // 本仓库的同级宿主仓（macOS / 任意平台 checkout）
  'D:\\workspace\\self\\ZTools', // Windows 宿主仓（原始开发机）
]
const HOST =
  process.argv[2] ||
  DEFAULT_HOST_CANDIDATES.find((p) => fs.existsSync(path.join(p, 'package.json'))) ||
  DEFAULT_HOST_CANDIDATES[DEFAULT_HOST_CANDIDATES.length - 1]
// electron 发行物形态按平台：win32 = dist/electron.exe；darwin = dist/Electron.app/Contents/MacOS/Electron
const ELECTRON =
  process.platform === 'darwin'
    ? path.join(HOST, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(HOST, 'node_modules', 'electron', 'dist', 'electron.exe')
const ASAR_BIN = path.join(HOST, 'node_modules', '@electron', 'asar', 'bin', 'asar.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const missing = [ELECTRON, ASAR_BIN].filter((p) => !fs.existsSync(p))
  if (missing.length) {
    console.log(`SKIP: host runtime not found: ${missing.join(', ')}`)
    process.exit(0)
  }
  const results = []

  // 迷你 DAV 服务器（与 e2e 同一份实现）
  const davRoot = path.join(os.tmpdir(), `wdsync-hostcheck-dav-${Date.now()}`)
  const dav = spawn(process.execPath, [path.join(HERE, 'dav-server.mjs'), '5377', davRoot], { stdio: 'pipe' })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('dav start timeout')), 5000)
    dav.stdout.on('data', (d) => {
      if (String(d).includes('listening')) {
        clearTimeout(t)
        resolve()
      }
    })
    dav.stderr.on('data', (d) => console.error('[dav]', String(d)))
  })

  // 待测形态：目录 与 asar
  const asarFile = path.join(os.tmpdir(), `wdsync-hostcheck-${Date.now()}.asar`)
  fs.mkdirSync(path.dirname(asarFile), { recursive: true })
  const pack = spawn(process.execPath, [ASAR_BIN, 'pack', path.join(PLUGIN, 'src-ztools'), asarFile], { stdio: 'pipe' })
  await new Promise((resolve, reject) => {
    pack.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`asar pack exit ${c}`))))
    pack.stderr.on('data', (d) => console.error('[asar]', String(d)))
  })
  // 打包产物内容检查：asar（zpx 的实体格式）内不得出现仓库内的测试
  // 资产 —— test/、src/ 等。
  // 宿主 zpx = brotli(asar(src-ztools))，本检查即对最终安装实体生效。
  const list = spawn(process.execPath, [ASAR_BIN, 'list', asarFile], { stdio: 'pipe' })
  const listOut = await new Promise((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error('asar list timeout')), 15000)
    list.stdout.on('data', (d) => (buf += String(d)))
    list.stderr.on('data', (d) => console.error('[asar]', String(d)))
    list.on('exit', (c) => {
      clearTimeout(t)
      c === 0 ? resolve(buf) : reject(new Error(`asar list exit ${c}`))
    })
  })
  const entries = listOut.split('\n').map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean)
  const forbidden = entries.filter((e) => /(^|\/)(test|node_modules)(\/|$)|\.throttle-bench|\.dav-root/.test(e.replace(/^\/+/, '')))
  const required = ['plugin.json', 'preload/dist/services.js', 'dist/index.html']
  const missingRequired = required.filter((r) => !entries.some((e) => e.replace(/^\/+/, '') === r))
  const packOk = forbidden.length === 0 && missingRequired.length === 0
  console.log(`${packOk ? '✅' : '❌'} host-load [package] entries=${entries.length} forbidden=${forbidden.length} missing=${missingRequired.length ? missingRequired.join(',') : '-'}`)
  if (!packOk) {
    if (forbidden.length) console.log('   forbidden sample: ' + forbidden.slice(0, 5).join(' | '))
    process.exit(1)
  }
  const forms = [
    { name: 'directory', preload: path.join(PLUGIN, 'src-ztools', 'preload', 'dist', 'services.js') },
    // asar 内虚拟路径一律正斜杠（Windows 上 Electron 亦接受；反斜杠在 darwin 上必败）
    { name: 'asar', preload: `${asarFile.split(path.sep).join('/')}/preload/dist/services.js` },
  ]

  try {
    for (const form of forms) {
      // 每形态独立的本地目录 / 远端路径 / 存储根（pluginData 缺失时 store.js 回退系统临时目录，测试再显式切根隔离）
      const localDir = path.join(os.tmpdir(), `wdsync-hostcheck-local-${form.name}-${Date.now()}`)
      const storeRoot = path.join(os.tmpdir(), `wdsync-hostcheck-store-${form.name}-${Date.now()}`)
      const remotePath = `/hostcheck-${form.name}`
      await fsp.mkdir(localDir, { recursive: true })
      await fsp.writeFile(path.join(localDir, 'hello.txt'), 'host-load-check')
      const out = await runInElectron(form.preload, localDir, storeRoot, remotePath)
      results.push({ form: form.name, ...out })
      await fsp.rm(localDir, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(storeRoot, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    dav.stdout.destroy()
    dav.stderr.destroy()
    dav.kill()
    await fsp.rm(davRoot, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(asarFile, { force: true }).catch(() => {})
  }

  let allOk = true
  for (const r of results) {
    const ok = r.loaded && r.connOk === true && r.tier === 'A' && r.uploaded === 1 && r.noop === true && r.capsWriteProbed === true
    allOk = allOk && ok
    console.log(`${ok ? '✅' : '❌'} host-load [${r.form}] loaded=${r.loaded} conn=${r.connOk} tier=${r.tier} uploaded=${r.uploaded} noop=${r.noop} perPathWrite=${r.capsWriteProbed} err=${r.error || '-'}`)
  }
  process.exit(allOk ? 0 : 1)
}

/** 在宿主 Electron 里按宿主 webPreferences 形态加载 preload 并跑真实同步；返回结果对象 */
function runInElectron(preloadPath, localDir, storeRoot, remotePath) {
  return new Promise((resolve) => {
    // harness 在父进程拼好（路径等经 JSON.stringify 一次性编码），再以字符串字面量嵌入
    // mainJs——避免模板字面量双层求值吞掉 Windows 路径的反斜杠（\U 会被当作无效转义丢弃）
    const harness = `
      (async () => {
        const cfg = { serverUrl: 'http://127.0.0.1:5377/dav/', username: 'u', password: 'p' }
        const conn = await window.services.dav.testConnection(cfg)
        const caps = await window.services.dav.probeCapabilities(cfg, true, ${JSON.stringify(remotePath)})
        const dir = ${JSON.stringify({ id: 'hostcheck', localPath: localDir, remotePath: remotePath, mode: 'two-way' })}
        const prefs = { ignoreHidden: true, concurrency: 4, conflictStrategy: 'ask' }
        const sum = await window.services.sync.syncDirectory(cfg, dir, prefs, {})
        const sum2 = await window.services.sync.syncDirectory(cfg, dir, prefs, {})
        return { connOk: conn.ok, tier: conn.tier, capsTier: caps.tier, capsWritable: caps.writable,
                 capsWriteProbed: typeof caps.writeProbedAt === 'number',
                 uploaded: sum.uploaded, noop: sum2.uploaded === 0 && sum2.downloaded === 0 }
      })()
    `
    const mainJs = `
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const PRELOAD = ${JSON.stringify(preloadPath)}
const STORE_ROOT = ${JSON.stringify(storeRoot)}
const HARNESS = ${JSON.stringify(harness)}
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: {
    // 宿主 pluginManager.createPluginWebContentsView 的形态（src/main/managers/pluginManager.ts）
    sandbox: false, contextIsolation: false, nodeIntegration: false, webSecurity: false,
    backgroundThrottling: false, preload: PRELOAD,
  }})
  const html = path.join(require('os').tmpdir(), 'wdsync-hostcheck-' + Date.now() + '.html')
  fs.writeFileSync(html, '<!doctype html><title>hostcheck</title>')
  try {
    await win.loadURL('file:///' + html.split(path.sep).join('/'))
    const loaded = await win.webContents.executeJavaScript('!!window.services && !!window.services.dav && !!window.services.sync && !!window.services.storage')
    await win.webContents.executeJavaScript('window.services.storage.setRootForTest(' + JSON.stringify(STORE_ROOT) + ')')
    const out = await win.webContents.executeJavaScript(HARNESS)
    console.log('HOSTLOAD-PAYLOAD ' + JSON.stringify({ loaded, ...out }))
    app.exit(0)
  } catch (e) {
    console.log('HOSTLOAD-PAYLOAD ' + JSON.stringify({ loaded: false, error: String(e && e.message || e) }))
    app.exit(2)
  }
})
`
    const mainFile = path.join(os.tmpdir(), `wdsync-hostcheck-main-${Date.now()}.cjs`)
    fs.writeFileSync(mainFile, mainJs)
    const child = spawn(ELECTRON, [mainFile], { stdio: 'pipe' })
    let payload = null
    let buf = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ loaded: false, error: 'timeout' })
    }, 60000)
    child.stdout.on('data', (d) => {
      buf += String(d)
      const m = buf.match(/HOSTLOAD-PAYLOAD (\{.*\})/)
      if (m) {
        payload = JSON.parse(m[1])
        clearTimeout(timer)
        resolve(payload)
        child.kill()
      }
    })
    child.stderr.on('data', (d) => console.error('[electron]', String(d)))
    child.on('exit', () => {
      clearTimeout(timer)
      if (!payload) resolve({ loaded: false, error: 'electron exited without payload: ' + buf.slice(0, 300) })
    })
  })
}

main().catch((e) => {
  console.error('host-load-check failed:', e && e.message)
  process.exit(1)
})
