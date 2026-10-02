<script setup lang="ts">
import { computed, useAttrs } from 'vue'
import AppIcon from '../AppIcon.vue'

/**
 * 通用输入框：带前置图标、等宽字体、小号字体与校验失败态。
 * 未声明的属性（maxlength、@input 等）会透传到内部 <input> 上。
 */
const props = withDefaults(
  defineProps<{
    placeholder?: string
    /** 输入框类型，默认 text（密码框传 password） */
    type?: string
    /** 前置图标（AppIcon 名称） */
    icon?: string
    /** 等宽字体，用于路径 / URL */
    mono?: boolean
    /** 小号字体（11px） */
    sm?: boolean
    /** 校验失败：红色描边 */
    invalid?: boolean
  }>(),
  { placeholder: undefined, type: 'text', icon: undefined, mono: false, sm: false, invalid: false }
)

/** 允许 number：数值型偏好（如内容校验上限）经 v-model.number 绑定 */
const model = defineModel<string | number>({ default: '' })

const attrs = useAttrs()
// class / style 留给外层容器，其余属性透传给 input
const rootClass = computed(() => attrs.class)
const rootStyle = computed(() => attrs.style)
const inputAttrs = computed(() => {
  const { class: _, style: __, ...rest } = attrs
  return rest
})
</script>

<template>
  <div class="field-input" :class="[{ invalid: props.invalid }, rootClass]" :style="rootStyle">
    <AppIcon v-if="props.icon" :name="props.icon" :size="14" class="input-icon" />
    <!-- spellcheck 置于 v-bind 之后：全局禁用拼写检查，且不会被透传属性覆盖 -->
    <input
      v-bind="inputAttrs"
      v-model="model"
      :type="props.type"
      :spellcheck="false"
      :placeholder="props.placeholder"
      :class="{ mono: props.mono, sm: props.sm }"
    />
  </div>
</template>

<style scoped lang="scss">
.field-input {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--br-input);
  border-radius: 6px;
  background: #fff;
  width: 100%;

  &:focus-within {
    border-color: var(--blue);
  }

  &.invalid {
    border-color: var(--red);
  }

  .input-icon {
    color: var(--text-muted);
  }

  input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    font-size: 12px;
    color: var(--text-1);
    height: 100%;

    &.mono {
      font-family: var(--font-mono);
      font-size: 12px;
    }

    &.sm {
      font-size: 11px;

      &.mono {
        font-size: 11px;
      }
    }
  }
}
</style>
