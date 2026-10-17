<script setup lang="ts">
import { computed, ref, useAttrs } from 'vue'
import AppIcon from '../AppIcon.vue'

/**
 * 通用输入框：带前置图标、等宽字体、小号字体与校验失败态。
 * 密码框（type="password"）自带「显示 / 隐藏」切换。未声明的属性
 *（maxlength、@input 等）会透传到内部 <input> 上。
 */
const props = withDefaults(
  defineProps<{
    placeholder?: string
    /** 输入框类型，默认 text（密码框传 password，自动附带可见切换） */
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

/** 密码可见切换：仅 type="password" 时出现（应用密码核对位数 / 排错时不必清空重输） */
const revealed = ref(false)
const isPassword = computed(() => props.type === 'password')
const effectiveType = computed(() => (isPassword.value && revealed.value ? 'text' : props.type))

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
      :type="effectiveType"
      :spellcheck="false"
      :placeholder="props.placeholder"
      :class="{ mono: props.mono, sm: props.sm }"
    />
    <button
      v-if="isPassword"
      type="button"
      class="reveal-btn"
      :title="revealed ? '隐藏密码' : '显示密码'"
      :aria-label="revealed ? '隐藏密码' : '显示密码'"
      @click="revealed = !revealed"
    >
      <AppIcon name="eye" :size="13" :class="revealed ? 'text-primary' : 'text-ink-4'" />
    </button>
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
  transition: border-color 0.15s ease, box-shadow 0.15s ease;

  &:hover {
    border-color: var(--br-input-hover);
  }

  &:focus-within {
    border-color: var(--blue);
    /* 焦点光晕：描边外一圈低透明度蓝，键盘与鼠标输入一致 */
    box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.12);
  }

  &.invalid {
    border-color: var(--red);

    &:focus-within {
      box-shadow: 0 0 0 3px rgba(234, 67, 53, 0.12);
    }
  }

  .input-icon {
    color: var(--text-muted);
  }

  /* 密码可见切换：右侧无边框小按钮，悬停 / 展示态由图标色区分 */
  .reveal-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    padding: 0 1px;
    cursor: pointer;
    flex-shrink: 0;

    &:hover .text-ink-4 {
      color: var(--text-2);
    }
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
