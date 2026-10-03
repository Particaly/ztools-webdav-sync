/**
 * 渲染层 store（src/composables/store.ts）单元测试：「云端文件夹丢失」决策弹窗的
 * 自动触发语义（autoPromptRootLost）。
 *
 * 背景：自动弹窗曾只认 pending-conflicts 事件上的 newlyNotified（只在轮末发一次），
 * 后台轮登记挂起时渲染层不在场 → 事件丢失 → 用户回窗口只见错误文案不见弹窗。
 * 修复后任一数据到手路径（refreshPendingConflicts 是兜底主通道）都会检查补弹，
 * 是否弹过由弹窗展示时写入的 dir.rootLostPromptedAt（= 挂起 createdAt）判定。
 *
 * 运行：npx vitest run test/unit（或 npm run test:unit）
 * 结构说明：store 模块是单例 reactive 状态，用例间强顺序依赖，保持单一 test 顺序
 * 执行；check() 沿用软失败登记 + 末尾一次性抛出（与 store.test.mjs 一致）。
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

// ---- 导入 store 前装好 window.services 桩（refreshPendingConflicts 的数据源）----
const pendingsByDir = new Map()
globalThis.window = {
  services: {
    sync: {
      async listPendingConflicts(d) {
        const items = pendingsByDir.get(d.id) || []
        return JSON.parse(JSON.stringify(items))
      },
    },
  },
}

const storeMod = await import(pathToFileURL(path.join(HERE, '..', '..', 'src', 'composables', 'store.ts')).href)
const store = storeMod.useStore()

/** 造一个最小可用目录（refreshPendingConflicts 只取 id / localPath / remotePath / mode） */
const makeDir = (id) => ({
  id,
  name: `目录-${id}`,
  localPath: `C:/sync/${id}`,
  remotePath: `/${id}`,
  mode: 'two-way',
  pendingConflicts: null,
})
const rootLostItem = (createdAt, extra = {}) => ({ rel: '.', createdAt, kind: 'root-lost', local: { size: 3 }, ...extra })

test('渲染层 store：根丢失决策弹窗自动触发（R1–R6，强顺序链）', async () => {
  try {
    const d1 = makeDir('r-dir-1')
    const d2 = makeDir('r-dir-2')
    store.state.dirs = [d1, d2]
    store.state.rootLostPromptDirId = null
    store.state.pendingCenterOpen = false

    // R1 事件丢失形态：冷启动 / 回窗口兜底刷新拿到未决策 root-lost 挂起 → 自动补弹
    pendingsByDir.set(d1.id, [rootLostItem(1000)])
    await store.refreshPendingConflicts(d1)
    check('R1 兜底刷新发现未决策根丢失 → 自动弹窗', store.state.rootLostPromptDirId === d1.id, String(store.state.rootLostPromptDirId))

    // R2 弹窗展示过（RootLostModal watch 写 rootLostPromptedAt 的效果）：同一登记不再自动弹
    d1.rootLostPromptedAt = 1000
    store.state.rootLostPromptDirId = null
    await store.refreshPendingConflicts(d1)
    check('R2 同一登记已展示过 → 不再自动重复弹窗', store.state.rootLostPromptDirId === null, String(store.state.rootLostPromptDirId))

    // R3 决策落地（choice 已选）→ 不弹；云端再次丢失（新登记、新 createdAt）→ 重新弹
    pendingsByDir.set(d1.id, [rootLostItem(1000, { choice: 'upload' })])
    await store.refreshPendingConflicts(d1)
    check('R3a 已决策的登记不触发弹窗', store.state.rootLostPromptDirId === null, String(store.state.rootLostPromptDirId))
    pendingsByDir.set(d1.id, [rootLostItem(2000)])
    await store.refreshPendingConflicts(d1)
    check('R3b 新登记（新 createdAt）→ 重新自动弹窗', store.state.rootLostPromptDirId === d1.id, String(store.state.rootLostPromptDirId))

    // R4 待处理中心开着时跳过（弹窗会被面板压住）；中心关闭后恢复补弹
    store.state.rootLostPromptDirId = null
    d1.rootLostPromptedAt = undefined
    store.state.pendingCenterOpen = true
    await store.refreshPendingConflicts(d1)
    check('R4a 待处理中心打开 → 暂不自动弹窗', store.state.rootLostPromptDirId === null, String(store.state.rootLostPromptDirId))
    store.state.pendingCenterOpen = false
    store.autoPromptRootLost()
    check('R4b 中心关闭后 autoPromptRootLost 恢复补弹', store.state.rootLostPromptDirId === d1.id, String(store.state.rootLostPromptDirId))

    // R5 弹窗目标目录已不存在（stale id）→ 清理并让位给有挂起的目录
    store.state.rootLostPromptDirId = 'removed-dir'
    store.state.dirs = [d2]
    d2.pendingConflicts = [rootLostItem(3000)]
    store.autoPromptRootLost()
    check('R5 stale 目标清理并转移弹窗', store.state.rootLostPromptDirId === d2.id, String(store.state.rootLostPromptDirId))

    // R6 多目录都有未决策挂起：弹窗被占用时不抢；目标清空后补弹下一个未展示目录
    d2.rootLostPromptedAt = 3000
    store.state.dirs = [d1, d2]
    d1.pendingConflicts = [rootLostItem(4000)]
    store.state.rootLostPromptDirId = null
    store.autoPromptRootLost()
    check('R6a 空闲时弹第一个未展示目录', store.state.rootLostPromptDirId === d1.id, String(store.state.rootLostPromptDirId))
    store.state.rootLostPromptDirId = d2.id // 模拟弹窗正被 d2 占用
    store.autoPromptRootLost()
    check('R6b 弹窗被占用时不抢占', store.state.rootLostPromptDirId === d2.id, String(store.state.rootLostPromptDirId))

    // R7 与根丢失无关的挂起（冲突 / 删除确认）不触发该弹窗
    store.state.rootLostPromptDirId = null
    store.state.dirs = [makeDir('r-dir-3')]
    const d3 = store.state.dirs[0]
    pendingsByDir.set(d3.id, [
      { rel: 'a.txt', createdAt: 5000, kind: 'delete' },
      { rel: 'b.txt', createdAt: 6000 },
    ])
    await store.refreshPendingConflicts(d3)
    check('R7 冲突 / 删除确认挂起不弹根丢失弹窗', store.state.rootLostPromptDirId === null, String(store.state.rootLostPromptDirId))
  } catch (e) {
    check('unexpected error', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e))
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    throw new Error(`渲染层 store 测试失败 ${failed.length}/${results.length} 条:\n${failed.map((f) => `  - ${f.name} ${f.detail}`).join('\n')}`)
  }
})
