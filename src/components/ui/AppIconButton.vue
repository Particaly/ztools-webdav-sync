<script setup lang="ts">
import { computed } from 'vue'

/**
 * 图标按钮：方形小按钮，用于标题栏返回/设置/更多、行内更多操作等。
 * outline：白底描边；ghost：透明无边框（如弹窗右上角关闭）。
 */
const props = withDefaults(
  defineProps<{
    /** 边长（px） */
    size?: number
    variant?: 'outline' | 'ghost'
    title?: string
  }>(),
  { size: 30, variant: 'outline', title: undefined }
)

// 圆角随尺寸缩放：大按钮 7px，小按钮（行内更多等）6px
const radius = computed(() => (props.size >= 28 ? 7 : 6))
</script>

<template>
  <button
    type="button"
    class="icon-btn"
    :class="variant"
    :style="{ width: `${size}px`, height: `${size}px`, borderRadius: `${radius}px` }"
    :title="title"
  >
    <slot />
  </button>
</template>

<style scoped lang="scss">
.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 0;
  transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease, transform 0.1s ease;

  // 按压微反馈：轻微缩放
  &:active:not(:disabled) {
    transform: scale(0.92);
  }

  &.outline {
    background: #fff;
    border: 1px solid var(--br-window);

    &:hover:not(:disabled) {
      background: #f5f7f9;
      border-color: #d3d9df;
    }
  }

  &.ghost {
    background: transparent;
    border: none;

    &:hover:not(:disabled) {
      background: #eef1f5;
    }
  }
}
</style>
