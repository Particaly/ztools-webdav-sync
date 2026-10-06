import { useStore } from './store'

/**
 * 全局 ESC 退层路由（渲染层）。
 *
 * 宿主契约：ZTools 注入插件页面的 preload（resources/preload.js）在 window
 * 冒泡阶段监听 keydown —— ESC 事件未被页面消费（defaultPrevented = false）时，
 * preload 经同步 IPC（plugin-esc-pressed）交宿主接管并执行「分步退出」，插件
 * 退回搜索框；页面只要在事件到达 window 之前 preventDefault 即可声明消费，
 * 宿主不再接管（preload 注释明示的插件侧通道）。
 *
 * 本插件据此在 window 捕获阶段（先于页面内一切元素监听与 preload 的冒泡监听）
 * 实现统一退层顺序：
 *   1. 有弹窗 / 浮层 —— 关最上层（后开先关），消费事件；
 *   2. 无弹层且不在首页 —— 回首页，消费事件（设置页 / 同步记录页按 ESC 回首页，
 *      不再掉进宿主搜索框）；
 *   3. 首页且无弹层 —— 不消费，交还宿主（保留「ESC 回搜索框」的既有语义）。
 */

/** 退层动作（resolveEscAction 的返回值）：close-layer 关最上层弹层 / go-home 回首页 / none 交还宿主 */
export type EscAction = 'close-layer' | 'go-home' | 'none'

/**
 * ESC 路由决策（纯函数，便于单测）：按「弹层 → 路由」的退层顺序判定动作。
 * @param layerCount 当前打开的弹窗 / 浮层数（ESC 栈深度）
 * @param route 当前路由（'main' = 首页）
 * @returns 应执行的动作；'none' 表示不消费事件、交还宿主
 */
export function resolveEscAction(layerCount: number, route: string): EscAction {
  if (layerCount > 0) return 'close-layer'
  if (route !== 'main') return 'go-home'
  return 'none'
}

/** ESC 栈（数组末位 = 最上层）：AppModal / AppDropdown 打开期间注册，随关闭 / 卸载注销 */
const escLayers: Array<() => void> = []

/**
 * 注册一层 ESC 消费者（弹层打开时调用）：全局 ESC 路由命中「关最上层」时调用
 * 该回调。重复注销安全。
 * @param close 关闭该弹层的动作（如 emit('close') / 置 open = false）
 * @returns 注销函数，弹层关闭或组件卸载时调用
 */
export function pushEscLayer(close: () => void): () => void {
  escLayers.push(close)
  let popped = false
  return () => {
    if (popped) return
    popped = true
    const i = escLayers.lastIndexOf(close)
    if (i >= 0) escLayers.splice(i, 1)
  }
}

/** 全局监听是否已安装（App 常驻单实例，重复调用幂等） */
let installed = false

/**
 * 全局 ESC keydown（window 捕获阶段 —— 必须先于宿主 preload 的 window 冒泡
 * 监听执行，「消费与否」的决定权才在插件手里）。
 */
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // 输入法组合中的 ESC（取消候选词）：保持原生语义，不路由也不消费
  if (e.isComposing || e.keyCode === 229) return
  // 已被更早的处理者消费：不重复处理
  if (e.defaultPrevented) return
  const action = resolveEscAction(escLayers.length, useStore().state.route)
  if (action === 'none') return
  // 消费事件：宿主 preload 检查 defaultPrevented，据此跳过「分步退出」接管
  e.preventDefault()
  if (action === 'close-layer') escLayers[escLayers.length - 1]?.()
  else useStore().state.route = 'main'
}

/** 安装全局 ESC 路由（App.vue 挂载时调用一次；重复调用幂等） */
export function installEscRouter(): void {
  if (installed) return
  installed = true
  window.addEventListener('keydown', onGlobalKeydown, true)
}
