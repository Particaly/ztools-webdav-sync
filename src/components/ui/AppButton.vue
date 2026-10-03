<script setup lang="ts">
import { computed } from 'vue'

/** 按钮风格：primary 蓝底主按钮 / secondary 白底描边 / ghost 白底浅描边 / danger 红底危险操作 */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

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
  transition: background 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease, color 0.14s ease, transform 0.1s ease;

  // 按压微反馈：轻微缩放
  &:active:not(:disabled) {
    transform: scale(0.96);
  }

  &:disabled {
    cursor: default;
  }

  // 主按钮自带蓝色投影，键盘焦点环需叠加而非覆盖
  &.primary:focus-visible {
    box-shadow: var(--focus-ring), var(--shadow-btn);
  }

  &.primary {
    background: var(--blue);
    color: #fff;
    box-shadow: var(--shadow-btn);

    &:hover:not(:disabled) {
      background: #1b66c8;
      box-shadow: 0 2px 6px rgba(26, 115, 232, 0.35);
    }

    &:active:not(:disabled) {
      background: #185cb8;
    }

    &:disabled {
      background: var(--blue-disabled);
      box-shadow: none;
    }
  }

  // 危险操作（批量删除确认等）：与 primary 同权重、红色系 —— 最高危动作
  // 不复用「前进」语义的蓝色主按钮，避免批量误触
  &.danger {
    background: var(--red);
    color: #fff;
    box-shadow: 0 1px 3px rgba(234, 67, 53, 0.35);

    &:hover:not(:disabled) {
      background: #d63a2c;
      box-shadow: 0 2px 6px rgba(234, 67, 53, 0.4);
    }

    &:active:not(:disabled) {
      background: #c2352a;
      box-shadow: none;
    }

    &:disabled {
      background: #f0a8a1;
      box-shadow: none;
    }
  }

  &.secondary {
    background: #fff;
    border-color: var(--br-input);

    &:hover:not(:disabled) {
      background: #f5f7f9;
      border-color: #c9d0d7;
    }

    &:active:not(:disabled) {
      background: #eef1f4;
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
