<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import PendingConflictsModal from '../components/PendingConflictsModal.vue'
import { AppIconButton } from '../components/ui'
import { useStore, type DecisionGroup } from '../composables/store'
import { loadDecisionHistory, decisionActionText, demoDecisionRows, HISTORY_SHOWN, type DecisionHistoryRow } from '../composables/decisions'
import { fmtRelTime } from '../composables/format'
import type { SyncDir } from '../env.d'

/**
 * 决策记录页（顶栏「决策记录」入口）：对同步文件夹的所有用户决策统一查看与续办 ——
 * ① 待决策：有未决策事项且同批尚未做过任何选择的目录（根丢失 / 删除确认 / 冲突），
 *    「去处理」直达对应的决策弹窗 / 待处理面板；
 * ② 部分决策：同一批事项里已做出部分选择但还有剩余未决策的目录（删除树已随范围
 *    决策一部分、冲突已选一部分文件），「继续处理」打开待处理面板完成剩余决策；
 * ③ 决策历史：decision-log.json 的全部条目（何时、哪个目录、选了什么、影响多少
 *    文件），只读回看。
 * 根丢失是目录级决策，走全局 RootLostModal（读 rootLostPromptDirId，App.vue 挂载）；
 * 其余经本页自持的 PendingConflictsModal 处理（主界面的 pendingPanelDirId 一次性
 * 通道依赖 DirRow 挂载，本页不经过该通道）。
 */
const store = useStore()
const s = store.state

const pendingGroups = computed(() => store.decisionGroups.value.pending)
const partialGroups = computed(() => store.decisionGroups.value.partial)

// ---------- 目录待处理面板（冲突三选一 / 删除确认目录树的统一处理入口） ----------

const panelDir = ref<SyncDir | null>(null)
const panelOpen = computed({
  get: () => !!panelDir.value,
  set: (v: boolean) => {
    if (!v) panelDir.value = null
  },
})

/**
 * 分组行「去处理 / 继续处理」直达：与待处理中心 goPendingDir 同规则 —— 根丢失
 * 优先弹专门的决策弹窗；其余打开本页托管的目录待处理面板。
 */
function goGroup(g: DecisionGroup) {
  if (g.rootLost > 0) s.rootLostPromptDirId = g.dir.id
  else panelDir.value = g.dir
}

// ---------- 决策历史（进入页面拉取一次；页内处理面板关闭后重拉） ----------

const history = ref<DecisionHistoryRow[]>([])
const historyLoading = ref(false)
const shownCount = ref(HISTORY_SHOWN)

async function reloadHistory() {
  historyLoading.value = true
  const rows = await loadDecisionHistory(s.dirs)
  // 演示形态读不到磁盘侧日志：历史为空时落静态样例，保证预览布局完整
  history.value = rows.length || !s.demo ? rows : demoDecisionRows()
  shownCount.value = HISTORY_SHOWN
  historyLoading.value = false
}

// 进入页面：刷新各目录挂起列表（本地磁盘读，无网络开销）+ 重拉历史；
// 页内面板关闭：期间可能落了新决策，重拉历史保持口径
watch(
  () => s.route,
  (r) => {
    if (r !== 'decisions') return
    void store.refreshAllPendingConflicts()
    void reloadHistory()
  },
  { immediate: true }
)
watch(panelOpen, (v) => {
  if (!v) void reloadHistory()
})

// ---------- 分组行文案（与待处理中心 / 各处理弹窗的选项文案同口径） ----------

/** 待决策行：只列未决策事项（根丢失 / 删除确认 / 冲突） */
function pendingDetail(g: DecisionGroup): string {
  const parts: string[] = []
  if (g.rootLost > 0) parts.push('云端的同步文件夹不见了，同步已暂停')
  if (g.deleteConfirm > 0) parts.push(`${g.deleteConfirm} 项删除等你确认`)
  if (g.conflict > 0) parts.push(`${g.conflict} 个文件两边都被改过`)
  return parts.join('；')
}

/** 部分决策行：先展示已做出的进度，再指出剩余待决策项 */
function partialDetail(g: DecisionGroup): string {
  const parts: string[] = []
  if (g.rootLost > 0) parts.push('云端的同步文件夹不见了，同步已暂停')
  if (g.decidedDelete > 0 && g.deleteConfirm > 0) parts.push(`删除已决定 ${g.decidedDelete} 项，还有 ${g.deleteConfirm} 项等你确认`)
  else if (g.deleteConfirm > 0) parts.push(`${g.deleteConfirm} 项删除等你确认`)
  if (g.decidedConflict > 0 && g.conflict > 0) parts.push(`冲突已选择 ${g.decidedConflict} 个，还有 ${g.conflict} 个等你选择`)
  else if (g.conflict > 0) parts.push(`${g.conflict} 个文件两边都被改过`)
  return parts.join('；')
}
</script>

<template>
  <div class="h-screen flex flex-col bg-white">
    <!-- 页头（与设置页同构）：返回 + 标题 -->
    <header class="flex items-center gap-3 h-14 px-5 border-b border-solid border-line-bar shrink-0">
      <AppIconButton title="返回" variant="ghost" :size="28" class="text-btn-text" @click="s.route = 'main'">
        <AppIcon name="chevron-left" :size="13" />
      </AppIconButton>
      <div class="flex flex-col gap-px">
        <div class="text-[14px] font-semibold text-ink-1 leading-[1.2]">决策记录</div>
        <div class="text-[11px] text-ink-3 leading-[1.2]">待决策、进行中与已完成的决策</div>
      </div>
      <span class="flex-spacer" />
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto px-4 py-[14px] flex flex-col gap-[16px]">
      <!-- 全部处理完毕：正面反馈卡（有待决策 / 部分决策时不出现） -->
      <div v-if="!pendingGroups.length && !partialGroups.length" class="all-clear">
        <AppIcon name="check-circle" :size="14" bg="var(--green-bg)" class="text-success shrink-0" />
        <span>所有决策都已完成，没有等你处理的事项</span>
      </div>

      <!-- 待决策：有未决策事项且同批尚未做过任何选择 -->
      <section v-if="pendingGroups.length" class="flex flex-col gap-[8px]">
        <div class="sec-head">
          <AppIcon name="warn" :size="12" class="text-warning-icon" />
          <span>待决策</span>
          <span class="count">{{ pendingGroups.length }}</span>
        </div>
        <div v-for="g in pendingGroups" :key="g.dir.id" class="grp" :class="{ 'grp-danger': g.rootLost > 0 }">
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
          <button type="button" class="act" @click="goGroup(g)">去处理</button>
        </div>
      </section>

      <!-- 部分决策：同批已做部分选择、还有剩余未决策，可继续完成 -->
      <section v-if="partialGroups.length" class="flex flex-col gap-[8px]">
        <div class="sec-head">
          <AppIcon name="info" :size="12" class="text-ink-3" />
          <span>部分决策</span>
          <span class="count">{{ partialGroups.length }}</span>
        </div>
        <div v-for="g in partialGroups" :key="g.dir.id" class="grp grp-progress">
          <div class="min-w-0 flex-1 flex flex-col gap-[3px]">
            <span class="truncate text-[12px] font-semibold text-ink-1">{{ g.dir.name }}</span>
            <span class="text-[11px] text-ink-3 leading-[1.4]">{{ partialDetail(g) }}</span>
          </div>
          <button type="button" class="act" @click="goGroup(g)">继续处理</button>
        </div>
      </section>

      <!-- 决策历史：全部条目倒序回看（进入页面拉取，页内处理完自动刷新） -->
      <section class="flex flex-col gap-[6px]">
        <div class="sec-head">
          <AppIcon name="history" :size="12" class="text-ink-3" />
          <span>决策历史</span>
          <span v-if="history.length" class="count">{{ history.length }}</span>
        </div>
        <div v-if="historyLoading" class="text-[11px] text-ink-4 px-[2px]">读取中…</div>
        <div v-else-if="!history.length" class="text-[11px] text-ink-4 px-[2px]">还没有决策记录</div>
        <template v-else>
          <div class="flex flex-col gap-[4px]">
            <div v-for="(h, i) in history.slice(0, shownCount)" :key="`${h.at}-${i}`" class="hist">
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
          <button v-if="history.length > shownCount" type="button" class="more-btn" @click="shownCount += HISTORY_SHOWN">
            显示更多（已显示 {{ shownCount }} / {{ history.length }} 条）
          </button>
        </template>
      </section>
    </main>

    <!-- 目录待处理面板：冲突三选一 / 删除确认目录树（本页自持实例，Teleport 到 body） -->
    <PendingConflictsModal v-if="panelDir" v-model:open="panelOpen" :dir="panelDir" />
  </div>
</template>

<style scoped lang="scss">
/* 分组行：与待处理中心同构 —— 根丢失条转红色系，部分决策条转蓝色系 */
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

  &.grp-progress {
    border-color: var(--blue-strip-br, #d7e6fb);
    background: var(--blue-strip-bg, #f5f9ff);
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

/* 区块标题：图标 + 名称 + 计数徽标 */
.sec-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px;

  span {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-3);
  }

  .count {
    min-width: 16px;
    height: 15px;
    padding: 0 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    background: var(--bg-seg, #eef1f5);
    font-size: 10px;
    font-weight: 600;
    color: var(--text-2);
  }
}

/* 全部处理完毕的正面反馈条 */
.all-clear {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--green-strip-br, #cdebd4);
  border-radius: 7px;
  background: var(--green-strip-bg, #f2fbf5);
  font-size: 12px;
  color: var(--green-deep, #1c7d38);
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

/* 分批展开按钮（历史长列表限长） */
.more-btn {
  border: 1px solid var(--br-divider);
  border-radius: 5px;
  background: transparent;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--blue);
  align-self: center;
  transition: background 0.12s ease;

  &:hover {
    background: #f1f3f6;
  }
}
</style>
