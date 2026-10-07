/**
 * 渲染层全局 ESC 退层路由（src/composables/esc.ts）单元测试。
 *
 * 宿主契约：ZTools 注入插件页面的 preload 在 window 冒泡阶段监听 ESC，事件未被
 * 页面消费（defaultPrevented = false）时宿主接管「分步退出」，插件退回搜索框；
 * 页面在事件到达 window 之前 preventDefault 即声明消费，宿主不再接管。本文件用
 * 桩 window 捕获 installEscRouter 安装的监听器、另挂一个按宿主 preload 语义建模
 * 的冒泡监听器（未消费 → hostTookOver），喂合成事件验证退层顺序与消费语义：
 *   E1–E3   决策纯函数（弹层 > 路由 > 交还宿主）
 *   E4–E8   栈行为：后开先关、逐层退、注销幂等
 *   E9–E11  路由语义：设置页 / 同步记录页回首页并消费；首页无弹层放行宿主
 *   E12–E15 防误伤：IME 组合中、keyCode 229、已消费事件、非 ESC 键不动
 *   E16     必答弹窗的消费占位（close 为 no-op）：只吞 ESC 不回退路由
 *
 * 运行：npx vitest run test/unit（或 npm run test:unit）
 * 结构说明：esc 模块持有模块级栈与 installed 标记（App 单实例语义），用例间
 * 强顺序依赖，保持单一 test 顺序执行；check() 沿用软失败登记 + 末尾一次性抛出
 * （与 render-store.test.mjs 一致）。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'
import { makeCheck, UNIT_HERE as HERE } from '../harness.mjs'

// 软失败登记收敛到 harness 的 makeCheck（results 保留引用：E15 用例内自检 all-ok）
const { check, results, assertAtEnd } = makeCheck()

// ---- 导入被测模块前装好 window 桩（installEscRouter 要挂 keydown 监听）----
// listeners 记录 (type, capture) 分桶；dispatch 按真实传播顺序先捕获后冒泡
const listeners = new Map()
const hostPreload = (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented) hostTookOver = true
}
let hostTookOver = false
globalThis.window = {
  addEventListener(type, fn, capture) {
    const arr = listeners.get(type) ?? []
    arr.push({ fn, capture: !!capture })
    listeners.set(type, arr)
  },
  removeEventListener(type, fn) {
    listeners.set(type, (listeners.get(type) ?? []).filter((l) => l.fn !== fn))
  },
}

const escMod = await import(pathToFileURL(path.join(HERE, '..', '..', 'src', 'composables', 'esc.ts')).href)
const storeMod = await import(pathToFileURL(path.join(HERE, '..', '..', 'src', 'composables', 'store.ts')).href)
const store = storeMod.useStore()

/** 合成 keydown 事件：preventDefault 落到 defaultPrevented（对齐真实 DOM 行为） */
function escEvent(extra = {}) {
  return {
    key: 'Escape',
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    ...extra,
  }
}

/** 按真实传播顺序派发：window 捕获（插件路由）→ window 冒泡（宿主 preload 模拟） */
function dispatch(ev) {
  for (const { fn, capture } of listeners.get('keydown') ?? []) {
    if (capture) fn(ev)
  }
  for (const { fn, capture } of listeners.get('keydown') ?? []) {
    if (!capture) fn(ev)
  }
  return ev
}

test('渲染层 ESC 退层路由（E1–E16，强顺序链）', async () => {
  try {
    const { resolveEscAction, pushEscLayer, installEscRouter } = escMod

    // ---- E1–E3 决策纯函数 ----
    check('E1 有弹层 → close-layer（无论路由）', resolveEscAction(2, 'settings') === 'close-layer' && resolveEscAction(1, 'main') === 'close-layer')
    check('E2 无弹层非首页 → go-home', resolveEscAction(0, 'settings') === 'go-home' && resolveEscAction(0, 'decisions') === 'go-home')
    check('E3 首页无弹层 → none（交还宿主）', resolveEscAction(0, 'main') === 'none')

    installEscRouter()
    // 挂宿主 preload 语义的冒泡模拟器（在 installEscRouter 之后注册不影响捕获序）
    globalThis.window.addEventListener('keydown', hostPreload, false)

    // ---- E4–E8 栈行为 ----
    const closed = []
    const unA = pushEscLayer(() => {
      closed.push('A')
      unA()
    })
    const unB = pushEscLayer(() => {
      closed.push('B')
      unB()
    })
    store.state.route = 'main'
    hostTookOver = false
    const e4 = dispatch(escEvent())
    check('E4 后开先关：只关最上层 B', closed.join() === 'B' && e4.defaultPrevented && !hostTookOver, JSON.stringify(closed))
    const e5 = dispatch(escEvent())
    check('E5 逐层退：再按关 A', closed.join() === 'B,A' && e5.defaultPrevented && !hostTookOver, JSON.stringify(closed))
    hostTookOver = false
    const e6 = dispatch(escEvent())
    check('E6 栈空回首页语义：首页放行宿主', !e6.defaultPrevented && hostTookOver)

    // ---- E9–E11 路由语义 ----
    store.state.route = 'settings'
    hostTookOver = false
    const e7 = dispatch(escEvent())
    check('E7 设置页 ESC → 回首页并消费', store.state.route === 'main' && e7.defaultPrevented && !hostTookOver)
    store.state.route = 'decisions'
    hostTookOver = false
    const e8 = dispatch(escEvent())
    check('E8 同步记录页 ESC → 回首页并消费', store.state.route === 'main' && e8.defaultPrevented && !hostTookOver)

    // ---- E12–E15 防误伤 ----
    store.state.route = 'settings'
    hostTookOver = false
    const e9 = dispatch(escEvent({ isComposing: true }))
    check('E9 IME 组合中不路由不消费', store.state.route === 'settings' && !e9.defaultPrevented)
    const e10 = dispatch(escEvent({ keyCode: 229 }))
    check('E10 keyCode 229（composition）不路由不消费', store.state.route === 'settings' && !e10.defaultPrevented)
    const e11 = dispatch(escEvent({ defaultPrevented: true }))
    check('E11 已被更早处理者消费的事件不重复处理', store.state.route === 'settings')
    const e12 = dispatch(escEvent({ key: 'Enter' }))
    check('E12 非 ESC 键不干预', store.state.route === 'settings' && !e12.defaultPrevented)

    // ---- E16 必答弹窗（close 为 no-op，如冲突三选一）----
    const unC = pushEscLayer(() => {})
    hostTookOver = false
    const e13 = dispatch(escEvent())
    check('E13 必答弹窗：只消费不关闭、不回退路由', store.state.route === 'settings' && e13.defaultPrevented && !hostTookOver)
    unC()
    unC() // 注销幂等
    const e14 = dispatch(escEvent())
    check('E14 占位注销后恢复路由语义', store.state.route === 'main' && e14.defaultPrevented)

    // ---- 收尾：还原路由，避免影响其他用例 ----
    store.state.route = 'main'
    check('E15 全部用例通过登记', results.every((r) => r.ok))
  } catch (e) {
    check('E16 用例链无异常', false, String(e))
  }

  assertAtEnd({ fail: (failed) => `${failed.length} 项失败：\n${failed.map((r) => `- ${r.name}`).join('\n')}` })
})
