/**
 * 渲染层 store 单元测试：全局暂停自动同步（顶栏一键暂停）的渲染层语义。
 *
 * 覆盖：默认未暂停 / 定时暂停的到期归一 / 已过期视同未暂停 / -1 一直暂停 /
 * 手动恢复清标记。调度器侧的门控与补跑由 e2e 调度器分片的假时钟节覆盖，本文件只测
 * 渲染层状态归一与动作（persist 的调度器 reload 通知在无 preload 桩下自然跳过）。
 *
 * 运行：npx vitest run test/unit
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'
import { makeCheck, UNIT_HERE as HERE } from '../harness.mjs'

// 软失败登记收敛到 harness 的 makeCheck（顺带修复旧本地副本的日志模板变异：
// detail 分支曾被拆成「分隔符 + 再拼一次 detail」的形态，统一回标准模板）
const { check, assertAtEnd } = makeCheck()

// ---- 导入 store 前装好 window 桩（shellOpenPath 捕获打开调用；无 dbStorage → persist 走 localStorage 兜底） ----
const openCalls = []
globalThis.window = {
  ztools: {
    shellOpenPath: (p) => openCalls.push(p),
  },
  services: {},
}

const storeMod = await import(pathToFileURL(path.join(HERE, '..', '..', 'src', 'composables', 'store.ts')).href)
const store = storeMod.useStore()

test('渲染层 store：全局暂停自动同步（P1–P6）', async () => {
  try {
    // P1 默认未暂停
    check('P1 default: not paused, pauseUntil=0', store.autoSyncPaused.value === false && store.globalPauseUntil.value === 0, JSON.stringify({ paused: store.autoSyncPaused.value, until: store.globalPauseUntil.value }))

    // P2 定时暂停：未来时刻归一保留，状态文案含「已暂停」
    store.pauseAutoSync(60 * 60000)
    const until2 = store.globalPauseUntil.value
    check(
      'P2 pauseAutoSync(60min) books a future expiry and reports paused',
      store.autoSyncPaused.value === true && until2 - Date.now() > 55 * 60000 && until2 - Date.now() <= 60 * 60000 && /已暂停/.test(store.pauseStatusText.value),
      JSON.stringify({ until: until2, text: store.pauseStatusText.value })
    )

    // P3 已过期的到期货视同未暂停（prefs 赋值触发 computed 重估）
    store.state.prefs.globalPauseUntil = Date.now() - 1000
    check('P3 expired pause reads as not paused', store.autoSyncPaused.value === false && store.globalPauseUntil.value === 0, JSON.stringify({ until: store.globalPauseUntil.value }))

    // P4 -1 一直暂停：无到期文案（不含「自动恢复」）
    store.pauseAutoSync(0)
    check(
      'P4 indefinite pause (-1) stays paused without auto-resume wording',
      store.globalPauseUntil.value === -1 && store.autoSyncPaused.value === true && store.pauseStatusText.value === '已暂停同步',
      JSON.stringify({ until: store.globalPauseUntil.value, text: store.pauseStatusText.value })
    )

    // P5 手动恢复：清标记（调度器经 reload 感知迁移并补跑，e2e 假时钟节覆盖）
    store.resumeAutoSync()
    check(
      'P5 resumeAutoSync clears the flag (and is a no-op when not paused)',
      store.autoSyncPaused.value === false && store.state.prefs.globalPauseUntil === 0,
      JSON.stringify({ until: store.state.prefs.globalPauseUntil })
    )
    store.resumeAutoSync() // 未暂停时再次调用必须无害

    // P6 打开电脑文件夹：经宿主 shellOpenPath（UI 交互不端口化的既有约定）
    store.openLocalFolder('/tmp/some-dir')
    check('P6 openLocalFolder routes through host shellOpenPath', openCalls.length === 1 && openCalls[0] === '/tmp/some-dir', JSON.stringify(openCalls))
  } catch (e) {
    check('unexpected error', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e))
  } finally {
    // 收尾清恢复：停掉暂停期间的展示用跳动时钟，不给 vitest 留悬挂 interval
    store.resumeAutoSync()
  }

  assertAtEnd({ fail: (failed) => `${failed.length} check(s) failed:\n${failed.map((f) => `- ${f.name}`).join('\n')}` })
})
