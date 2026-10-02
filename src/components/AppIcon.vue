<script setup lang="ts">
import { computed } from 'vue'
import { ICONS } from './icons'

// 通用图标组件：name 对应 icons.ts 中的键，bg 用于带底色圆形图标的底色
const props = defineProps<{ name: string; size?: number; bg?: string }>()

const html = computed(() => (ICONS[props.name] || '').replace(/__BG__/g, props.bg || 'transparent'))
const dim = computed(() => props.size ?? 14)
</script>

<template>
  <svg
    :width="dim"
    :height="dim"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    style="flex-shrink: 0; display: block"
    v-html="html"
  />
</template>
