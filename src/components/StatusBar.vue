<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { AppButton } from './ui'
import { useStore } from '../composables/store'
import { fmtRelTime } from '../composables/format'

const store = useStore()

const leftText = computed(() => `共 ${store.state.dirs.length} 个同步目录`)
const syncLabel = computed(() => {
  const pending = store.conflictPendingCount.value
  if (pending > 0) return `最近一次同步：${fmtRelTime(store.lastSyncAt.value)} · ${pending} 个冲突待处理`
  return `${store.anySyncing.value ? '上次同步' : '最近一次同步'}：${fmtRelTime(store.lastSyncAt.value)}`
})
</script>

<template>
  <footer class="flex items-center gap-[14px] h-[52px] px-4 bg-fill-bar border-t border-solid border-line-bar shrink-0">
    <div class="flex items-center gap-[10px] min-w-0">
      <div class="flex items-center gap-[6px]">
        <AppIcon name="list" :size="13" class="text-ink-3" />
        <span class="text-[12px] font-medium text-btn-text whitespace-nowrap">{{ leftText }}</span>
      </div>
      <span class="w-px h-[14px] bg-line-window shrink-0" />
      <span class="text-[12px] text-ink-2 truncate">{{ syncLabel }}</span>
    </div>
    <span class="flex-spacer" />
    <AppButton
      variant="primary"
      :size="32"
      strong
      pad="0 14px"
      :disabled="store.anySyncing.value"
      @click="store.syncAll()"
    >
      <AppIcon name="refresh" :size="14" :class="{ spin: store.anySyncing.value }" />
      {{ store.anySyncing.value ? '同步中…' : '立即同步' }}
    </AppButton>
  </footer>
</template>
