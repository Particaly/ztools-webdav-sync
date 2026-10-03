<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import AppIcon from '../AppIcon.vue'
import AppDropdown from './AppDropdown.vue'

/**
 * 行内说明气泡：设置项标题右侧的问号图标，悬停图标时展示说明文字。
 * 复用 AppDropdown 的 teleport 定位（fixed + 下方空间不足自动翻转 + 视口边缘收拢），
 * 避免气泡被卡片 / 滚动容器裁剪；页面滚动时随 AppDropdown 的逻辑自动收起。
 *
 * 图标显隐由全局样式（main.scss）控制：位于 .pref-row（设置行）内时默认隐藏、
 * 悬停整行时浮现，气泡打开期间加 .is-open 保持可见；.pref-row 之外始终显示。
 * 悬停离开延迟 80ms 收起，穿过图标与气泡之间的 6px 间隙时不闪烁；
 * 鼠标进入气泡内部同样会取消收起计时（面板自身接管悬停），离开气泡才重新计时，
 * 因此可以移入面板内从容阅读 / 复制内容。
 *
 * 自定义触发器：提供 #trigger 插槽时用插槽内容整体作为悬停目标（如首页档位
 * 徽标 hover 展开全部档位说明），插槽外层自动绑定与问号按钮一致的悬停开合行为。
 */
defineProps<{ text: string }>()

const open = ref(false)
let hideTimer: ReturnType<typeof setTimeout> | undefined

/** 悬停进入 / 聚焦：立即展示（清除延迟收起的计时器） */
function show() {
  if (hideTimer) clearTimeout(hideTimer)
  open.value = true
}

/** 悬停离开 / 失焦：延迟收起 */
function hide() {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => (open.value = false), 80)
}

onBeforeUnmount(() => {
  if (hideTimer) clearTimeout(hideTimer)
})
</script>

<template>
  <AppDropdown v-model:open="open" placement="bottom-start" teleport :offset="6" class="info-tip" :class="{ 'is-open': open }">
    <template #trigger>
      <!-- 自定义触发器（如档位徽标整体悬停）：外层 span 承载与默认问号按钮一致的悬停开合行为 -->
      <span
        v-if="$slots.trigger"
        class="info-tip-host"
        @mouseenter="show"
        @mouseleave="hide"
        @focusin="show"
        @focusout="hide"
      >
        <slot name="trigger" />
      </span>
      <button
        v-else
        type="button"
        class="info-tip-btn"
        aria-label="查看说明"
        @mouseenter="show"
        @mouseleave="hide"
        @focus="show"
        @blur="hide"
      >
        <AppIcon name="help" :size="12" />
      </button>
    </template>
    <!-- 面板自身同样接管悬停：进入面板取消延迟收起（可移入面板内阅读 / 复制），
         离开面板才重新计时收起 -->
    <div class="info-tip-panel" role="tooltip" @mouseenter="show" @mouseleave="hide"><slot>{{ text }}</slot></div>
  </AppDropdown>
</template>

<style scoped lang="scss">
.info-tip-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-muted);
  transition: color 0.12s ease;

  &:hover {
    color: var(--text-2);
  }
}

.info-tip-panel {
  width: max-content;
  max-width: 248px;
  padding: 6px 9px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-2);
}
</style>
