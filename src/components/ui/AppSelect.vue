<script setup lang="ts" generic="T extends string | number">
import { computed, ref, watch } from 'vue'
import AppIcon from '../AppIcon.vue'
import AppDropdown from './AppDropdown.vue'

/** 下拉选项 */
export interface SelectOption<V = string | number> {
  value: V
  label: string
}

/**
 * 自定义下拉选择（替代原生 <select>）：
 * - 触发器展示当前值，浮层展示选项列表（选中项带对勾）
 * - 支持 ↑ ↓ 移动高亮、Enter / Space 选中、Esc 关闭、点击外部关闭
 * - 打开时检测窗口剩余空间，下方不足则自动向上弹出
 * - 泛型 T 保证 v-model 与选项值类型一致（如同步模式等字面量联合类型）
 */
const props = withDefaults(
  defineProps<{
    options: SelectOption<T>[]
    /** 触发器宽度（px），默认随父容器 */
    width?: number
    disabled?: boolean
  }>(),
  { width: undefined, disabled: false }
)

const model = defineModel<T>({ required: true })

const open = ref(false)
/** 键盘 / 悬停高亮的选项下标 */
const activeIndex = ref(-1)
/** 弹出方向：下方空间不足时翻转 */
const placement = ref<'bottom-start' | 'top-start'>('bottom-start')

const rootRef = ref<HTMLElement | null>(null)

const currentLabel = computed(
  () => props.options.find((o) => o.value === model.value)?.label ?? String(model.value)
)

// 打开时：高亮定位到当前选中项，并按窗口剩余空间决定弹出方向
watch(open, (v) => {
  if (!v) return
  activeIndex.value = Math.max(0, props.options.findIndex((o) => o.value === model.value))
  const rect = rootRef.value?.getBoundingClientRect()
  if (rect) {
    const need = props.options.length * 26 + 12
    const spaceBelow = window.innerHeight - rect.bottom
    placement.value = spaceBelow < need && rect.top > need ? 'top-start' : 'bottom-start'
  }
})

function select(opt: SelectOption<T>) {
  model.value = opt.value
  open.value = false
}

/** 触发器键盘导航：未打开时 ↑↓/Enter/Space 打开，打开后 ↑↓ 移动高亮、Enter/Space 选中 */
function onTriggerKeydown(e: KeyboardEvent) {
  if (props.disabled) return
  const n = props.options.length
  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      e.preventDefault()
      if (!open.value) {
        open.value = true
      } else {
        const dir = e.key === 'ArrowDown' ? 1 : -1
        activeIndex.value = (activeIndex.value + dir + n) % n
      }
      break
    case 'Enter':
    case ' ':
      e.preventDefault()
      if (open.value && activeIndex.value >= 0) select(props.options[activeIndex.value])
      else open.value = true
      break
  }
}
</script>

<template>
  <div ref="rootRef" class="select-root">
    <AppDropdown v-model:open="open" :placement="placement">
      <template #trigger>
        <button
          type="button"
          class="select-trigger"
          :style="props.width ? { width: `${props.width}px` } : undefined"
          :disabled="props.disabled"
          role="combobox"
          :aria-expanded="open"
          @click="open = !open"
          @keydown="onTriggerKeydown"
        >
          <span class="label">{{ currentLabel }}</span>
          <AppIcon name="chevron-down" :size="11" class="chev" :class="{ rotate: open }" />
        </button>
      </template>
      <template #default>
        <div class="opts" role="listbox">
          <button
            v-for="(o, i) in props.options"
            :key="o.value"
            type="button"
            class="opt"
            :class="{ active: i === activeIndex, selected: o.value === model }"
            role="option"
            :aria-selected="o.value === model"
            @click="select(o)"
            @mousemove="activeIndex = i"
          >
            <span class="opt-label">{{ o.label }}</span>
            <AppIcon v-if="o.value === model" name="check" :size="12" class="opt-check" />
          </button>
        </div>
      </template>
    </AppDropdown>
  </div>
</template>

<style scoped lang="scss">
.select-root {
  display: inline-flex;
  flex-shrink: 0;
}

.select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--br-input);
  border-radius: 6px;
  background: #fff;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-1);

  &:disabled {
    cursor: default;
    background: var(--bg-track);
    color: var(--text-muted);
  }

  .label {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .chev {
    color: var(--text-muted);
    transition: transform 0.15s;

    &.rotate {
      transform: rotate(180deg);
    }
  }
}

.opts {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-1);
  text-align: left;
  white-space: nowrap;

  &.active {
    background: #f1f3f6;
  }

  &.selected {
    color: var(--blue);

    .opt-check {
      color: var(--blue);
    }
  }

  .opt-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
</style>
