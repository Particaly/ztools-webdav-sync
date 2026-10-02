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
  transition: background 0.15s;
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
    transition: left 0.15s;
  }

  &.on .knob {
    left: 16px;
  }

  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
}
</style>
