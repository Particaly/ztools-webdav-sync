<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { AppButton, AppModal } from './ui'
import { useStore } from '../composables/store'
import { fmtRelTime } from '../composables/format'
import { loadDecisionHistory, decisionActionText, HISTORY_SHOWN, type DecisionHistoryRow } from '../composables/decisions'

/**
 * 全局待处理中心（状态栏「N 项待处理」入口打开）：跨目录聚合两块信息 ——
 * 上半部是各目录的未决策挂起分组（根丢失 / 删除确认 / 冲突三类计数，根丢失排
 * 最前），点「去处理」直达对应目录的处理入口（根丢失弹 RootLostModal，其余经
 * pendingPanelDirId 通道打开该目录的待处理面板）；下半部是「最近处理记录」
 *（decision-log.json，打开时经 listDecisionLog 拉取各目录日志合并，只读回看
 * 「当时选了什么、影响了多少文件」）。解决「提示分散在各目录行内、找不到入口」。
 * 历史拉取与文案渲染由 composables/decisions 单点维护（决策记录页共用同口径）；
 * 底部入口可跳转决策记录页（待决策 / 部分决策 / 全部历史的完整视图）。
 */
const store = useStore()

const open = computed({
  get: () => store.state.pendingCenterOpen,
  set: (v: boolean) => {
    store.state.pendingCenterOpen = v
  },
})

/** 有未决策挂起的目录分组（根丢失排最前），数据源 store.pendingCenterGroups */
const groups = computed(() => store.pendingCenterGroups.value)

// ---------- 最近处理记录（决策历史，打开时拉取一次） ----------

const history = ref<DecisionHistoryRow[]>([])
const historyLoading = ref(false)

watch(open, (v) => {
  if (v) void loadHistory()
})

/** 打开时拉取全部目录的决策历史（best-effort：单目录失败不拖累整体） */
async function loadHistory() {
  if (!window.services || store.state.demo) {
    history.value = []
    return
  }
  historyLoading.value = true
  history.value = (await loadDecisionHistory(store.state.dirs)).slice(0, HISTORY_SHOWN)
  historyLoading.value = false
}

/** 打开决策记录页（待决策 / 部分决策 / 全部历史的完整视图） */
function openDecisionsPage() {
  open.value = false
  store.state.route = 'decisions'
}
</script>

<template>
  <Transition name="modal-pop">
    <AppModal
      v-if="open"
      title="待处理与处理记录"
      :subtitle="groups.length ? '各同步文件夹的待决策事项集中在这里处理' : '没有待处理的记录'"
      :width="460"
      @close="open = false"
    >
      <div class="flex flex-col gap-[14px]">
        <!-- 待决策分组：根丢失目录级决策排最前（红色），其余为逐文件类 -->
        <div v-if="groups.length" class="flex flex-col gap-[8px]">
          <div
            v-for="g in groups"
            :key="g.dir.id"
            class="grp"
            :class="{ 'grp-danger': g.rootLost > 0 }"
          >
            <div class="min-w-0 flex-1 flex flex-col gap-[3px]">
              <span class="truncate text-[12px] font-semibold" :class="g.rootLost > 0 ? 'text-[#b3261e]' : 'text-ink-1'">{{ g.dir.name }}</span>
              <span class="flex flex-wrap items-center gap-x-[8px] gap-y-[2px] text-[11px]" :class="g.rootLost > 0 ? 'text-[#b3261e]' : 'text-ink-3'">
                <span v-if="g.rootLost > 0" class="inline-flex items-center gap-[4px]">
                  <AppIcon name="warn" :size="12" class="text-danger" />云端的同步文件夹不见了，同步已暂停
                </span>
                <span v-if="g.deleteConfirm > 0">{{ g.deleteConfirm }} 项删除等你确认</span>
                <span v-if="g.conflict > 0">{{ g.conflict }} 个文件两边都被改过</span>
              </span>
            </div>
            <button type="button" class="act" @click="store.goPendingDir(g.dir)">去处理</button>
          </div>
        </div>

        <!-- 最近处理记录（决策历史，只读） -->
        <div class="flex flex-col gap-[6px]">
          <div class="flex items-center gap-[6px]">
            <AppIcon name="list" :size="12" class="text-ink-3" />
            <span class="text-[11px] font-semibold text-ink-3">最近处理记录</span>
          </div>
          <div v-if="historyLoading" class="text-[11px] text-ink-4 px-[2px]">读取中…</div>
          <div v-else-if="!history.length" class="text-[11px] text-ink-4 px-[2px]">还没有处理记录</div>
          <div v-else class="flex flex-col gap-[4px] max-h-[180px] overflow-y-auto">
            <div v-for="(h, i) in history" :key="`${h.at}-${i}`" class="hist">
              <span class="min-w-0 flex-1 truncate" :title="`${h.dirName} / ${h.rel}`">
                <span class="text-ink-2">{{ h.dirName }}</span>
                <span class="hist-sep">·</span>
                <span class="text-ink-3">{{ decisionActionText(h) }}</span>
                <span v-if="h.rel !== '.'" class="hist-sep">·</span>
                <span v-if="h.rel !== '.'" class="font-mono text-ink-4">{{ h.rel }}</span>
              </span>
              <span class="shrink-0 text-[10px] text-ink-4 whitespace-nowrap">{{ fmtRelTime(h.at) }}</span>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <AppButton size="sm" @click="openDecisionsPage">查看决策记录页</AppButton>
        <span class="flex-spacer" />
        <AppButton size="sm" @click="open = false">关闭</AppButton>
      </template>
    </AppModal>
  </Transition>
</template>

<style scoped lang="scss">
/* 目录分组条：根丢失条转红色系（与 DirRow 错误条同口径） */
.grp {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid var(--br-divider);
  border-radius: 7px;

  &.grp-danger {
    border-color: var(--red-strip-br, #f3cfcb);
    background: var(--red-strip-bg, #fdf5f4);
  }
}

.act {
  border: 1px solid var(--br-divider);
  border-radius: 5px;
  background: transparent;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-1);
  white-space: nowrap;
  transition: background 0.12s ease, border-color 0.12s ease;

  &:hover {
    background: #f1f3f6;
    border-color: #d3d9df;
  }
}

/* 历史行：单行摘要 + 右侧相对时间 */
.hist {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 2px;
  font-size: 11px;
  line-height: 1.4;

  .hist-sep {
    margin: 0 4px;
    color: var(--text-muted);
  }
}
</style>
