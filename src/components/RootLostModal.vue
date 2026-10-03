<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { AppButton, AppModal } from './ui'
import { useStore } from '../composables/store'
import type { SyncDir } from '../env.d'

/**
 * 「云端文件夹丢失」决策弹窗（kind='root-lost' 挂起的统一处理入口）：
 * 云端同步根被删除 / 挪走后，引擎在决策落地前零删除零传输，每轮以「等待确认」
 * 收场。这里让用户二选一：
 *   重新上传到云端 —— 重建云端文件夹，电脑上的文件按根重建保护语义恢复上传；
 *   删除电脑上的文件 —— 跟随云端删除，已同步的文件移入系统回收站；从未同步过
 *   的新文件与本地有改动的文件会保留（后者会重新上传）。
 * 「暂不处理」只关闭弹窗，决策仍以待处理挂起保留（行内提示条可再进入）。
 * 「删除电脑上的文件」为批量破坏性动作：两段式确认（先预览后果，再点一次执行）。
 */
const store = useStore()

const dir = computed<SyncDir | null>(() =>
  store.state.rootLostPromptDirId ? (store.state.dirs.find((d) => d.id === store.state.rootLostPromptDirId) ?? null) : null
)
const open = computed({
  get: () => !!dir.value,
  set: (v: boolean) => {
    if (!v) store.state.rootLostPromptDirId = null
  },
})

/** 受影响的已同步文件数（引擎登记挂起时写入 local.size = 基线条目数） */
const affectedCount = computed(() => {
  const rec = dir.value?.pendingConflicts?.find((p) => p.kind === 'root-lost')
  const n = Number(rec?.local?.size) || 0
  return n > 0 ? n : 0
})

const choice = ref<'upload' | 'remove-local'>('upload')
/** remove-local 的第二段确认：首次点确认只展示后果摘要，再点才执行 */
const armed = ref(false)
watch(open, (v) => {
  if (v) {
    choice.value = 'upload'
    armed.value = false
    // 展示即记下这条 root-lost 挂起（自动补弹与「去处理」直达共用）：同一登记
    // 之后不再被 autoPromptRootLost 自动重复弹出（数据随目录配置持久化）
    const rec = dir.value?.pendingConflicts?.find((p) => p.kind === 'root-lost' && !p.choice)
    if (dir.value && rec) dir.value.rootLostPromptedAt = rec.createdAt
  }
})

function confirm() {
  const d = dir.value
  if (!d) return
  if (choice.value === 'remove-local' && !armed.value) {
    armed.value = true
    return
  }
  void store.resolveRootLost(d, choice.value)
}
</script>

<template>
  <Transition name="modal-pop">
    <AppModal
      v-if="dir && open"
      :key="dir.id"
      title="云端的同步文件夹不见了"
      :subtitle="`${dir.name} 的同步已暂停，等你决定怎么处理`"
      :width="440"
      @close="open = false"
    >
      <div class="flex flex-col gap-[10px]">
        <div class="flex items-start gap-[8px] rounded-[6px] bg-fill-seg px-[10px] py-[8px]">
          <AppIcon name="cloud" :size="13" class="mt-[2px] shrink-0 text-ink-3" />
          <span class="font-mono text-[11px] text-ink-2 break-all leading-[1.4]">{{ dir.remotePath }}</span>
        </div>
        <p class="m-0 text-[12px] text-ink-2 leading-[1.55]">
          云端的这个文件夹已被删除或移走（可能是在网页上操作的）。为防止误删文件，本次同步已停止，
          请选择如何处理电脑上的 {{ affectedCount > 0 ? `${affectedCount} 个` : '' }}已同步文件：
        </p>

        <button
          type="button"
          class="opt"
          :class="{ active: choice === 'upload' }"
          @click="choice = 'upload'"
        >
          <AppIcon name="upload" :size="14" class="opt-ic" />
          <span class="flex-1 min-w-0 flex flex-col gap-[2px] text-left">
            <span class="opt-title">重新上传到云端</span>
            <span class="opt-desc">重建云端文件夹，把电脑上的文件传回去。适合误删了云端文件夹，或想以电脑内容为准</span>
          </span>
          <span class="radio" :class="{ on: choice === 'upload' }" />
        </button>

        <button
          type="button"
          class="opt"
          :class="{ active: choice === 'remove-local', danger: choice === 'remove-local' }"
          @click="choice = 'remove-local'"
        >
          <AppIcon name="trash" :size="14" class="opt-ic" />
          <span class="flex-1 min-w-0 flex flex-col gap-[2px] text-left">
            <span class="opt-title">删除电脑上的文件</span>
            <span class="opt-desc">跟随云端删除，已同步的文件会移入系统回收站。从未同步过的新文件和有改动的文件会保留</span>
          </span>
          <span class="radio" :class="{ on: choice === 'remove-local' }" />
        </button>

        <div v-if="choice === 'remove-local' && armed" class="armed-note">
          <AppIcon name="warn" :size="12" class="shrink-0 text-danger" />
          <span>再点一次「确认删除」。文件会移入系统回收站，还能找回；这个操作下次同步时执行</span>
        </div>
      </div>

      <template #footer>
        <AppButton size="sm" @click="open = false">暂不处理</AppButton>
        <span class="flex-spacer" />
        <AppButton
          size="sm"
          :class="{ 'danger-btn': choice === 'remove-local' }"
          :variant="choice === 'remove-local' ? 'secondary' : 'primary'"
          pad="0 14px"
          @click="confirm"
        >
          {{ choice === 'upload' ? '重新上传到云端' : armed ? '确认删除' : '删除电脑上的文件' }}
        </AppButton>
      </template>
    </AppModal>
  </Transition>
</template>

<style scoped lang="scss">
/* 选项卡：整行可点，选中态用主色描边 + 淡底；remove-local 选中转危险色系 */
.opt {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--br-divider);
  border-radius: 7px;
  background: #fff;
  text-align: left;
  transition: border-color 0.12s ease, background 0.12s ease;

  &:hover {
    border-color: #c9d2da;
    background: #fafbfc;
  }

  .opt-ic {
    margin-top: 2px;
    color: var(--text-3);
  }

  .opt-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-1);
  }

  .opt-desc {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.45;
  }

  &.active {
    border-color: #a8c8f5;
    background: #f5f9ff;

    .opt-ic {
      color: var(--blue);
    }
  }

  &.danger.active {
    border-color: #f0c4c0;
    background: #fdf5f4;

    .opt-ic,
    .opt-title {
      color: var(--red);
    }
  }
}

.radio {
  width: 14px;
  height: 14px;
  margin-top: 2px;
  border: 1.5px solid #c4ccd4;
  border-radius: 50%;
  background: #fff;
  position: relative;
  flex-shrink: 0;
  transition: border-color 0.12s ease;

  &.on {
    border-color: var(--blue);

    &::after {
      content: '';
      position: absolute;
      inset: 2.5px;
      border-radius: 50%;
      background: var(--blue);
    }
  }
}

/* remove-local 二段确认的提示条 */
.armed-note {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--red-strip-bg, #fdf0ef);
  border: 1px solid var(--red-strip-br, #f3cfcb);
  font-size: 11px;
  color: #b3261e;
  line-height: 1.45;
}

/* remove-local 确认按钮的危险色覆盖（AppButton 无 danger 变体，secondary 底 + 覆写） */
:deep(.danger-btn) {
  color: #fff !important;
  background: var(--red, #d93025) !important;
  border-color: var(--red, #d93025) !important;

  &:hover {
    background: #c32d23 !important;
  }
}
</style>
