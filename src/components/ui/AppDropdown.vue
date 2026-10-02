<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/** 浮层弹出位置：bottom-* 在触发器下方，top-* 在上方（空间不足时自动翻转用） */
type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

/**
 * 浮层原语：负责「开合状态 + 点击外部关闭 + Esc 关闭 + 相对触发器定位」，
 * 菜单（TopBar / DirRow 更多菜单）与下拉选择（AppSelect）都基于它封装。
 * open 支持双向绑定，父组件也可只读不写（如菜单场景）；
 * 默认插槽会收到 close()，供选中 / 点击菜单项后收起。
 *
 * teleport 模式：面板渲染到 body 并用 fixed 定位（坐标取自触发器视口位置，
 * 下方空间不足自动翻转向上），用于父级有 overflow 裁剪的容器内（如目录列表行）。
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
// 面板渲染后按实际高度修正——下方放不下则翻转到触发器上方
function positionFixed() {
  const trig = rootRef.value?.firstElementChild as HTMLElement | null
  const rect = trig?.getBoundingClientRect()
  if (!rect) return
  const ph = panelRef.value?.offsetHeight ?? 0
  const margin = 8
  const fitsBelow = rect.bottom + props.offset + ph <= window.innerHeight - margin
  const style: Record<string, string> = { position: 'fixed' }
  if (fitsBelow || rect.top - ph - props.offset < margin) {
    style.top = `${rect.bottom + props.offset}px`
  } else {
    style.bottom = `${window.innerHeight - rect.top + props.offset}px`
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

onMounted(() => {
  document.addEventListener('mousedown', onDocMousedown, true)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMousedown, true)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
})

// 浮层定位：垂直方向由 placement 决定，水平对齐同侧（非 teleport 模式）
const panelStyle = computed(() => ({
  ...(props.placement.startsWith('top')
    ? { bottom: `calc(100% + ${props.offset}px)` }
    : { top: `calc(100% + ${props.offset}px)` }),
  ...(props.placement.endsWith('end') ? { right: '0' } : { left: '0' }),
  ...(props.minWidth ? { minWidth: `${props.minWidth}px` } : {}),
}))

defineExpose({ close })
</script>

<template>
  <div ref="rootRef" class="pop-wrap" @keydown.esc="close">
    <slot name="trigger" :open="open" :toggle="toggle" />
    <Teleport to="body" :disabled="!teleport">
      <Transition name="pop">
        <div
          v-if="open"
          ref="panelRef"
          class="pop-panel"
          :style="teleport ? fixedStyle : panelStyle"
          @keydown.esc="close"
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
