// 临时工具：以原生 deviceScaleFactor=2 重拍 demo 场景截图（800×600 布局 → 1600×1200 物理像素）
import puppeteer from 'puppeteer-core'

const base = process.argv[2] || 'http://localhost:5152'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--hide-scrollbars'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 })

  // conflict：弹窗等过渡动画结束再拍
  await page.goto(`${base}/?demo=conflict`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.modal', { visible: true })
  await sleep(900)
  await page.screenshot({ path: 'docs/screenshots/conflict.png' })
  console.log('conflict.png done')

  // settings：真实鼠标点击展开「高级设置」，等展开内容渲染后回到顶部拍（与旧截图同状态）
  await page.goto(`${base}/?demo=settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.adv-header', { visible: true })
  await sleep(300)
  await page.click('.adv-header')
  await page.waitForFunction(() => document.body.textContent.includes('信任此服务器证书'), { timeout: 5000 })
  await sleep(500)
  await page.evaluate(() => {
    const m = document.querySelector('main')
    if (m) m.scrollTop = 0
  })
  await sleep(400)
  await page.screenshot({ path: 'docs/screenshots/settings.png' })
  console.log('settings.png done')
} finally {
  await browser.close()
}
