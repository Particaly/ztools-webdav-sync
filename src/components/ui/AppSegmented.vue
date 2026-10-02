<script setup lang="ts" generic="T extends string">
import AppIcon from '../AppIcon.vue'

/** 分段选项（可带图标） */
export interface SegmentedOption<V = string> {
  value: V
  label: string
  icon?: string
}

/** 分段选择器：一组互斥选项，如「双向同步 / 仅上传 / 仅下载」 */
defineProps<{ options: SegmentedOption<T>[] }>()

const model = defineModel<T>({ required: true })
</script>

<template>
  <div class="segmented">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      class="seg"
      :class="{ active: model === o.value }"
      @click="model = o.value"
    >
      <AppIcon v-if="o.icon" :name="o.icon" :size="13" />
      {{ o.label }}
    </button>
  </div>
</template>

<style scoped lang="scss">
.segmented {
  display: flex;
  gap: 3px;
  background: var(--bg-seg);
  border-radius: 7px;
  padding: 3px;
}

.seg {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 26px;
  border: none;
  border-radius: 5px;
  background: transparent;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-2);
  transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;

  &.active {
    background: #fff;
    color: var(--blue);
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(33, 41, 51, 0.08);
  }
}
</style>
