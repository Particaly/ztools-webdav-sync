<script lang="ts">
/**
 * 全局监听共享单例（模块级）：使用方含目录行（每行一个）、顶栏、表单与设置页
 *（经 AppSelect），逐实例自挂「document mousedown 捕获 + window scroll 捕获 +
 * window resize」三份监听会随实例数线性累积。改为一份全局监听 + 打开实例注册表：
 * 首个实例打开时挂监听、最后一个注销时移除，事件发生时广播给全部登记实例，
 * 由各实例沿用自身原有的判定与关闭逻辑（捕获阶段、同款判定，语义与逐实例挂载一致）。
 * 卸载钩子兜底注销（含 HMR 重挂载时旧实例的卸载路径），监听不会跨模块版本滞留累积。
 */

/** 注册表成员：实例把两类全局事件的处置逻辑交给单例广播 */
interface DropdownClient {
  /** document mousedown（捕获）广播：实例自行判定目标是否在自身外部并收起 */
  onDocMousedown(e: MouseEvent): void
  /** window scroll（捕获）/ resize 广播：teleport 实例收起 fixed 面板 */
  onViewportChange(): void
}

/** 打开中的实例注册表（Set 成员唯一，重复登记幂等） */
const openClients = new Set<DropdownClient>()

/** 全局监听是否已挂载 */
let listenersAttached = false

/** mousedown 广播：快照遍历 —— 广播过程中实例可能收起并注销自身 */
function sharedDocMousedown(e: MouseEvent): void {
  for (const c of Array.from(openClients)) c.onDocMousedown(e)
}

/** scroll / resize 广播（同样快照遍历，防遍历中增删成员） */
function sharedViewportChange(): void {
  for (const c of Array.from(openClients)) c.onViewportChange()
}

/** 挂载全局监听（幂等）：首个实例打开时调用 */
function attachListeners(): void {
  if (listenersAttached) return
  listenersAttached = true
  document.addEventListener('mousedown', sharedDocMousedown, true)
  window.addEventListener('scroll', sharedViewportChange, true)
  window.addEventListener('resize', sharedViewportChange)
}

/** 移除全局监听（幂等）：最后一个实例注销时调用 */
function detachListeners(): void {
  if (!listenersAttached) return
  listenersAttached = false
  document.removeEventListener('mousedown', sharedDocMousedown, true)
  window.removeEventListener('scroll', sharedViewportChange, true)
  window.removeEventListener('resize', sharedViewportChange)
}

/** 登记打开中的实例：需要时先挂全局监听 */
function registerClient(c: DropdownClient): void {
  attachListeners()
  openClients.add(c)
}

/** 注销实例（关闭 / 卸载）：最后一个注销时移除全局监听 */
function unregisterClient(c: DropdownClient): void {
  openClients.delete(c)
  if (openClients.size === 0) detachListeners()
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { pushEscLayer } from '../../composables/esc'

/** 浮层弹出位置：bottom-* 在触发器下方，top-* 在上方（空间不足时自动翻转用） */
type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

/**
 * 浮层原语：负责「开合状态 + 点击外部关闭 + Esc 关闭 + 相对触发器定位」，
 * 菜单（TopBar / DirRow 更多菜单）与下拉选择（AppSelect）都基于它封装。
 * open 支持双向绑定，父组件也可只读不写（如菜单场景）；
 * 默认插槽会收到 close()，供选中 / 点击菜单项后收起。
 *
 * teleport 模式：面板渲染到 body 并用 fixed 定位（坐标取自触发器视口位置，
 * 下方空间不足自动翻转向上；上下都放不下时收拢到视口内并内部滚动兜底），
 * 用于父级有 overflow 裁剪的容器内（如目录列表行），矮窗口下也不会被遮挡。
 * 传送期间滚动 / 缩放窗口直接收起，避免面板与触发器错位。
 */
const props = withDefaults(
  defineProps<{
    placement?: Placement
    /** 浮层与触发器的间距（px） */
    offset?: number
    /** 浮层最小宽度（px），默认撑满触发器宽度 */
    minWidth?: number
    /** 是否传送面板到 body 并改用 fixed 定位 */
    teleport?: boolean
  }>(),
  { placement: 'bottom-start', offset: 4, minWidth: undefined, teleport: false }
)

const open = defineModel<boolean>('open', { default: false })

const rootRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)

/** teleport 模式下面板的 fixed 定位样式（打开时按触发器视口坐标计算） */
const fixedStyle = ref<Record<string, string>>({})

function toggle() {
  open.value = !open.value
}

function close() {
  open.value = false
}

// 点击组件外部时收起浮层（capture 阶段监听，避免被内部 stopPropagation 拦截）；
// teleport 后面板不在 root 内，需一并放行面板内部的点击
function onDocMousedown(e: MouseEvent) {
  if (!open.value) return
  const t = e.target as Node
  if (rootRef.value?.contains(t)) return
  if (panelRef.value?.contains(t)) return
  close()
}

// teleport 模式：打开时先按触发器位置出第一帧（过渡首帧透明，无闪烁），
// 面板渲染后按实际高度修正——下方放不下则翻转到触发器上方；上下都放不下时
// 收拢到视口内（极端矮窗口再限制面板高度、面板内部滚动），保证不被遮挡
function positionFixed() {
  const trig = rootRef.value?.firstElementChild as HTMLElement | null
  const rect = trig?.getBoundingClientRect()
  if (!rect) return
  const ph = panelRef.value?.offsetHeight ?? 0
  const margin = 8
  const spaceBelow = window.innerHeight - margin - (rect.bottom + props.offset)
  const spaceAbove = rect.top - props.offset - margin
  const style: Record<string, string> = { position: 'fixed' }
  if (ph <= spaceBelow || ph > spaceAbove) {
    // 下方放得下 → 原位向下；上下都放不下 → 贴视口底边收拢
    style.top = `${ph > spaceBelow ? Math.max(margin, window.innerHeight - margin - ph) : rect.bottom + props.offset}px`
    style.transformOrigin = 'top ' + (props.placement.endsWith('end') ? 'right' : 'left')
    if (ph > window.innerHeight - margin * 2) {
      style.maxHeight = `${window.innerHeight - margin * 2}px`
      style.overflowY = 'auto'
    }
  } else {
    style.bottom = `${window.innerHeight - rect.top + props.offset}px`
    style.transformOrigin = 'bottom ' + (props.placement.endsWith('end') ? 'right' : 'left')
  }
  if (props.placement.endsWith('end')) {
    style.right = `${Math.max(margin, window.innerWidth - rect.right)}px`
  } else {
    const pw = panelRef.value?.offsetWidth ?? 0
    style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - margin - pw))}px`
  }
  style.minWidth = props.minWidth ? `${props.minWidth}px` : '0'
  fixedStyle.value = style
}

watch(open, (v) => {
  if (!v || !props.teleport) return
  void positionFixed()
  void nextTick(positionFixed)
})

// teleport 模式下页面滚动 / 缩放会使 fixed 面板与触发器错位，直接收起
function onViewportChange() {
  if (open.value && props.teleport) close()
}

// 本实例在共享单例中的登记项：广播回调直接复用上面两个处置函数（判定与关闭逻辑不变）
const sharedClient: DropdownClient = { onDocMousedown, onViewportChange }

// 打开期间登记进共享单例（首个打开挂全局监听）；关闭即注销（最后一个注销时移除监听）
watch(open, (v) => {
  if (v) registerClient(sharedClient)
  else unregisterClient(sharedClient)
})

// ESC 退层：浮层打开期间入全局退层栈（composables/esc，后开先关）—— 全局路由
// 先关浮层再谈路由回退，且消费事件不让宿主把插件退回搜索框。原模板上的
// @keydown.esc 依赖焦点在浮层 / 触发器内且不消费事件（ESC 会泄漏给宿主直接
// 退出插件），已由这条与焦点无关的通道取代。
let unregisterEsc: (() => void) | null = null
watch(open, (v) => {
  if (v && !unregisterEsc) unregisterEsc = pushEscLayer(close)
  else if (!v && unregisterEsc) {
    unregisterEsc()
    unregisterEsc = null
  }
})

onBeforeUnmount(() => {
  // 卸载兜底注销（打开中被卸载也要退出注册表，否则单例持有死引用、监听永不摘除）
  unregisterClient(sharedClient)
  unregisterEsc?.()
  unregisterEsc = null
})

// 浮层定位：垂直方向由 placement 决定，水平对齐同侧（非 teleport 模式）；
// transform-origin 与弹出方向一致，缩放入场从触发器一侧生长
const panelStyle = computed(() => ({
  ...(props.placement.startsWith('top')
    ? { bottom: `calc(100% + ${props.offset}px)`, transformOrigin: props.placement.endsWith('end') ? 'bottom right' : 'bottom left' }
    : { top: `calc(100% + ${props.offset}px)`, transformOrigin: props.placement.endsWith('end') ? 'top right' : 'top left' }),
  ...(props.placement.endsWith('end') ? { right: '0' } : { left: '0' }),
  ...(props.minWidth ? { minWidth: `${props.minWidth}px` } : {}),
}))

defineExpose({ close })
</script>

<template>
  <div ref="rootRef" class="pop-wrap">
    <slot name="trigger" :open="open" :toggle="toggle" />
    <Teleport to="body" :disabled="!teleport">
      <Transition name="pop">
        <div
          v-if="open"
          ref="panelRef"
          class="pop-panel"
          :style="teleport ? fixedStyle : panelStyle"
        >
          <slot :close="close" />
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped lang="scss">
.pop-wrap {
  position: relative;
  display: inline-flex;
}

.pop-panel {
  position: absolute;
  z-index: 40;
  min-width: 100%;
  background: #fff;
  border: 1px solid var(--br-card);
  border-radius: 8px;
  box-shadow: var(--shadow-pop);
  padding: 4px;
}
</style>
