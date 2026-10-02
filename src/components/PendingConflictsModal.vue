<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { AppButton, AppModal } from './ui'
import { useStore } from '../composables/store'
import { fmtRelTime } from '../composables/format'
import type { SyncDir } from '../env.d'

/**
 * 待处理挂起面板（两类记录统一处理）：
 * ① 冲突：后台（interval/watch）轮的冲突一律 defer 挂起，轮末经系统通知提醒一次；
 *    用户回窗口后在此逐条三选一（本地 / 云端 / 两边都留，= setPendingChoice，
 *    下一轮自动落地）或「暂时忽略」（= clearPendingConflict，该文件再冲突时才重新询问）。
 * ② 删除确认（kind='delete'）：单轮待删超过安全阈值时引擎整批登记，确认前零删除；
 *    在此逐条「确认删除 / 保留不删」，或批量处理。
 * 已选条目展示「已选 · 待下轮生效」，不重复处理。
 * 长列表：数据侧已限长（store 按 200 条截断），渲染侧再分批 —— 默认只
 * 渲染前 50 条，「显示更多」按批展开；条目最多 200 条，全部仍可达。
 */
const props = defineProps<{ dir: SyncDir }>()
const open = defineModel<boolean>('open', { default: false })

const store = useStore()

/** 打开时刷新一次（事件外兜底：处理动作可能来自其他入口），并重置分批展开 */
watch(open, (v) => {
  if (v) {
    shownCount.value = PAGE_SIZE
    void store.refreshPendingConflicts(props.dir)
  }
})

const items = computed(() => props.dir.pendingConflicts ?? [])
/** 未处理（无 choice）条目：批量「应用到剩余」的目标 */
const openItems = computed(() => items.value.filter((p) => !p.choice))
const openConflictItems = computed(() => openItems.value.filter((p) => p.kind !== 'delete'))
const openDeleteItems = computed(() => openItems.value.filter((p) => p.kind === 'delete'))

/** 渲染分批（长列表限长）：每批 50 条，展开按钮出现在列表底部 */
const PAGE_SIZE = 50
const shownCount = ref(PAGE_SIZE)
const shownItems = computed(() => items.value.slice(0, shownCount.value))

const choiceLabel: Record<string, string> = {
  local: '保留电脑版本',
  remote: '保留云端版本',
  both: '两个都留',
  delete: '确认删除',
  keep: '不删除',
}

function applyOne(rel: string, choice: 'local' | 'remote' | 'both' | 'delete' | 'keep') {
  void store.applyPendingChoices(props.dir, [rel], choice)
}

function applyConflicts(choice: 'local' | 'remote' | 'both') {
  void store.applyPendingChoices(props.dir, openConflictItems.value.map((p) => p.rel), choice)
}

function applyDeletes(choice: 'delete' | 'keep') {
  void store.applyPendingChoices(props.dir, openDeleteItems.value.map((p) => p.rel), choice)
}

function ignore(rel: string) {
  void store.ignorePendingConflict(props.dir, rel)
}

const subtitle = computed(() => {
  if (!openItems.value.length) return '没有待处理的记录'
  const parts: string[] = []
  if (openConflictItems.value.length) parts.push(`${openConflictItems.value.length} 个文件等你选择保留哪个`)
  if (openDeleteItems.value.length) parts.push(`${openDeleteItems.value.length} 项删除等你确认（确认前不会删除任何文件）`)
  return `${parts.join('；')}（下次同步时生效）`
})
</script>

<template>
  <AppModal
    v-if="open"
    :title="`${dir.name}：待处理`"
    :subtitle="subtitle"
    :width="440"
    @close="open = false"
  >
    <div class="flex flex-col gap-[8px] max-h-[280px] overflow-y-auto">
      <div v-for="it in shownItems" :key="it.rel" class="item">
        <div class="min-w-0 flex-1 flex flex-col gap-[2px]">
          <span class="font-mono text-[12px] text-ink-1 truncate" :title="it.rel">{{ it.rel }}</span>
          <span class="text-[11px] text-ink-4">{{
            it.choice
              ? `已选「${choiceLabel[it.choice] ?? it.choice}」· 下次同步时生效`
              : it.kind === 'delete'
                ? `等你确认删除 · 发现于 ${fmtRelTime(it.createdAt)}`
                : `发现于 ${fmtRelTime(it.createdAt)}`
          }}</span>
        </div>
        <div v-if="!it.choice" class="flex items-center gap-[6px] shrink-0">
          <template v-if="it.kind === 'delete'">
            <button type="button" class="act" title="下次同步时删除（电脑上的文件会放进回收站）" @click="applyOne(it.rel, 'delete')">确认删除</button>
            <button type="button" class="act" @click="applyOne(it.rel, 'keep')">不删除</button>
          </template>
          <template v-else>
            <button type="button" class="act" @click="applyOne(it.rel, 'local')">保留电脑版本</button>
            <button type="button" class="act" @click="applyOne(it.rel, 'remote')">保留云端版本</button>
            <button type="button" class="act" @click="applyOne(it.rel, 'both')">两个都留</button>
          </template>
          <button
            type="button"
            class="act muted"
            :title="it.kind === 'delete' ? '忽略这条提醒。如果之后又出现，还会再问你，不会自动删除任何文件' : '忽略这条提醒，这个文件再次冲突时才会重新询问'"
            @click="ignore(it.rel)"
          >忽略</button>
        </div>
        <span v-else class="shrink-0 inline-flex items-center gap-[4px] text-[11px] text-success">
          <AppIcon name="check-circle" :size="12" bg="var(--green-bg)" />
        </span>
      </div>
      <!-- 分批展开：条目最多 200 条（store 截断），一次只渲染 50 条避免长列表卡顿 -->
      <button v-if="items.length > shownItems.length" type="button" class="more-btn" @click="shownCount += PAGE_SIZE">
        显示更多（{{ shownItems.length }} / {{ items.length }}）
      </button>
    </div>
    <template #footer>
      <div v-if="openItems.length > 1" class="flex flex-col gap-[8px] w-full">
        <div v-if="openConflictItems.length > 1" class="flex items-center gap-[8px] w-full">
          <span class="text-[11px] text-ink-3 shrink-0">其余 {{ openConflictItems.length }} 个也都这样处理：</span>
          <span class="flex-spacer" />
          <AppButton size="sm" @click="applyConflicts('local')">保留电脑版本</AppButton>
          <AppButton size="sm" @click="applyConflicts('remote')">保留云端版本</AppButton>
          <AppButton size="sm" variant="primary" @click="applyConflicts('both')">两个都留</AppButton>
        </div>
        <div v-if="openDeleteItems.length > 1" class="flex items-center gap-[8px] w-full">
          <span class="text-[11px] text-ink-3 shrink-0">其余 {{ openDeleteItems.length }} 项删除都这样处理：</span>
          <span class="flex-spacer" />
          <AppButton size="sm" @click="applyDeletes('keep')">全部不删除</AppButton>
          <AppButton size="sm" variant="primary" @click="applyDeletes('delete')">全部确认删除</AppButton>
        </div>
      </div>
      <AppButton v-else size="sm" @click="open = false">关闭</AppButton>
    </template>
  </AppModal>
</template>

<style scoped lang="scss">
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--br-divider);
  border-radius: 7px;
}

.act {
  border: 1px solid var(--br-divider);
  border-radius: 5px;
  background: transparent;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-1);
  white-space: nowrap;

  &:hover {
    background: #f1f3f6;
  }

  &.muted {
    color: var(--text-muted);
  }
}

/* 分批展开按钮（长列表限长）：弱化的文字按钮，贴在滚动列表底部 */
.more-btn {
  border: 1px solid var(--br-divider);
  border-radius: 5px;
  background: transparent;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--blue);
  align-self: center;

  &:hover {
    background: #f1f3f6;
  }
}
</style>
