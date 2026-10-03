<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { AppButton } from './ui'
import { useStore } from '../composables/store'
import { fmtRelTime } from '../composables/format'

const store = useStore()

const leftText = computed(() => `共 ${store.state.dirs.length} 个同步文件夹`)
/** 未决策挂起总数（含根丢失 / 删除确认 / 冲突三类）：>0 时状态栏变为可点击入口 */
const pendingTotal = computed(() => store.pendingConflictTotal.value)
const syncLabel = computed(() => {
  if (pendingTotal.value > 0) return `最近一次同步：${fmtRelTime(store.lastSyncAt.value)} · ${pendingTotal.value} 项待处理`
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
      <!-- 有待决策挂起时整段变为高亮入口（点击打开全局待处理中心）；无待处理保持纯展示 -->
      <button
        v-if="pendingTotal > 0"
        type="button"
        class="pending-entry"
        title="查看各文件夹的待决策事项与最近处理记录"
        @click="store.openPendingCenter()"
      >
        <AppIcon name="warn" :size="12" class="shrink-0 text-warning-icon" />
        <span class="truncate">{{ syncLabel }}</span>
      </button>
      <span v-else class="text-[12px] text-ink-2 truncate">{{ syncLabel }}</span>
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

<style scoped lang="scss">
/* 待处理入口：与两侧展示文案同号但可点（hover 浮起 + 下划线提示可交互） */
.pending-entry {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 2px 4px;
  margin-left: -4px;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 500;
  color: var(--warning-deep, #8a5a00);
  cursor: pointer;
  transition: background 0.12s ease;

  &:hover {
    background: var(--warn-strip-bg, #fdf6e7);
  }
}
</style>
