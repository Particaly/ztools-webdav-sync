<script setup lang="ts">
/** 开关切换：v-model 绑定布尔值；disabled 时不可切换并置灰 */
withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false })
const model = defineModel<boolean>({ required: true })
</script>

<template>
  <button
    type="button"
    class="switch"
    :class="{ on: model }"
    role="switch"
    :aria-checked="model"
    :disabled="disabled"
    @click="model = !model"
  >
    <span class="knob" />
  </button>
</template>

<style scoped lang="scss">
.switch {
  position: relative;
  width: 34px;
  height: 20px;
  border-radius: 10px;
  background: #d5d9de;
  border: none;
  padding: 0;
  /* 底色随状态渐变，缓动与滑块一致保证整体感 */
  transition: background 0.2s var(--ease-swift);
  flex-shrink: 0;

  &.on {
    background: var(--blue);
  }

  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 8px;
    background: #fff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    /* swift 缓动：出手快、停得稳，比线性更接近物理直觉 */
    transition: left 0.2s var(--ease-swift), width 0.15s var(--ease-swift);
  }

  &.on .knob {
    left: 16px;
  }

  /* 按压微反馈：滑块横向拉伸，松手回弹；开启态同步左移保持 2px 右边距 */
  &:active:not(:disabled) .knob {
    width: 18px;
  }

  &.on:active:not(:disabled) .knob {
    left: 14px;
  }

  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
}
</style>
