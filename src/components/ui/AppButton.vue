<script setup lang="ts">
import { computed } from 'vue'

/** 按钮风格：primary 蓝底主按钮 / secondary 白底描边 / ghost 白底浅描边 */
type Variant = 'primary' | 'secondary' | 'ghost'

/**
 * 尺寸：sm=28px / md=30px / lg=34px（lg 字号 13px），
 * 也可直接传数字自定义高度（如 32）。
 */
type Size = 'sm' | 'md' | 'lg' | number

/** 各尺寸默认的高度与水平内边距 */
const SIZE_MAP = {
  sm: { h: 28, pad: '0 11px', fs: 12 },
  md: { h: 30, pad: '0 12px', fs: 12 },
  lg: { h: 34, pad: '0 18px', fs: 13 },
} as const

const props = withDefaults(
  defineProps<{
    variant?: Variant
    size?: Size
    /** 加粗字重（600），用于主操作按钮 */
    strong?: boolean
    /** 覆盖水平内边距，如 '0 14px' */
    pad?: string
  }>(),
  { variant: 'secondary', size: 'md', strong: false, pad: undefined }
)

const height = computed(() => (typeof props.size === 'number' ? props.size : SIZE_MAP[props.size].h))
const padding = computed(() => props.pad ?? (typeof props.size === 'number' ? SIZE_MAP.md.pad : SIZE_MAP[props.size].pad))
const fontSize = computed(() => (typeof props.size === 'number' ? SIZE_MAP.md.fs : SIZE_MAP[props.size].fs))
</script>

<template>
  <button
    type="button"
    class="app-btn"
    :class="variant"
    :style="{ height: `${height}px`, padding, fontSize: `${fontSize}px`, fontWeight: strong ? 600 : 500 }"
  >
    <slot />
  </button>
</template>

<style scoped lang="scss">
.app-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--btn-text);
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.12s, border-color 0.12s, box-shadow 0.12s, transform 0.1s ease;

  // 按压微反馈：轻微缩放
  &:active:not(:disabled) {
    transform: scale(0.96);
  }

  &:disabled {
    cursor: default;
  }

  &.primary {
    background: var(--blue);
    color: #fff;
    box-shadow: var(--shadow-btn);

    &:hover:not(:disabled) {
      background: #1b66c8;
    }

    &:disabled {
      background: var(--blue-disabled);
    }
  }

  &.secondary {
    background: #fff;
    border-color: var(--br-input);

    &:hover:not(:disabled) {
      background: #f5f7f9;
    }
  }

  &.ghost {
    background: #fff;
    border-color: var(--br-window);

    &:hover:not(:disabled) {
      background: #f5f7f9;
    }
  }
}
</style>
