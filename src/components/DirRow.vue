<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import DirFormModal from './DirFormModal.vue'
import PendingConflictsModal from './PendingConflictsModal.vue'
import { AppDropdown, AppIconButton } from './ui'
import { useStore } from '../composables/store'
import { fmtBytes, fmtRelTime } from '../composables/format'
import type { SyncDir } from '../env.d'

const props = defineProps<{ dir: SyncDir }>()
const store = useStore()

const pct = computed(() => {
  const p = props.dir.progress
  if (!p || !p.filesTotal) return 0
  return Math.min(100, Math.round((p.filesDone / p.filesTotal) * 100))
})

const enabled = computed(() => store.dirEnabled(props.dir))
const syncing = computed(() => props.dir.status === 'syncing')

/** 未处理（无 choice）的挂起数：冲突（后台轮 defer）+ 删除确认（批量超阈值），面板统一处理 */
const pendingOpen = computed(() => (props.dir.pendingConflicts ?? []).filter((p) => !p.choice).length)
/** 未处理的删除确认数（提示条文案区分「冲突待选择」与「删除待确认」） */
const pendingDeleteOpen = computed(() => (props.dir.pendingConflicts ?? []).filter((p) => !p.choice && p.kind === 'delete').length)

/** 「同步设置」弹窗与「待处理记录」面板开关 */
const settingsOpen = ref(false)
const pendingOpenModal = ref(false)

/** 同步中且有可展示的任务进度（规划期 / 空目录轮 filesTotal 为 0，此时仅有取消入口） */
const hasTaskProgress = computed(() => !!props.dir.progress && props.dir.progress.filesTotal > 0)

const statusText = computed(() => {
  if (!enabled.value) return '已禁用'
  switch (props.dir.status) {
    case 'syncing':
      return '正在同步…'
    case 'conflict':
      return '需要处理'
    case 'error':
      return '同步失败'
    case 'synced':
      return props.dir.justCompleted ? '同步完成' : '已同步'
    default:
      return '等待同步'
  }
})

const timeText = computed(() => {
  const d = props.dir
  if (!enabled.value) return '已停用'
  if (d.status === 'syncing' && d.progress && d.progress.filesTotal) return `进度 ${pct.value}%`
  if (d.status === 'conflict') return '1 个文件'
  if (d.status === 'synced' && d.justCompleted) return '刚刚完成'
  return fmtRelTime(d.lastSyncAt)
})

const summary = computed(() => props.dir.lastResult)

// ---------- 更多操作菜单 ----------

function onSyncNow(close: () => void) {
  void store.syncDir(props.dir)
  close()
}

function onToggleEnabled(close: () => void) {
  store.setDirEnabled(props.dir.id, !enabled.value)
  close()
}

function onOpenSettings(close: () => void) {
  close()
  settingsOpen.value = true
}

function onRemove(close: () => void) {
  const d = props.dir
  if (confirm(`不再同步「${d.name}」？电脑和云端的文件都不会被删除`)) {
    store.removeDir(d.id)
  }
  close()
}

function handleConflict() {
  // demo/兼容路径：真实同步的冲突经引擎 onConflict 即时弹窗，status 不会停在 'conflict'，
  // 本入口仅在 ?demo= 场景可见（详见 store.openConflictFor 注释）
  store.openConflictFor(props.dir)
}

/** 请求取消进行中的同步：置位取消标记，引擎在下一个检查点以「同步已中止」收场，状态回 idle */
function onCancelSync() {
  store.cancelSync(props.dir.id)
}
</script>

<template>
  <div class="row flex flex-col gap-[9px] p-3 bg-white" :class="{ off: !enabled }">
    <div class="flex gap-3">
      <div
        class="w-[30px] h-[30px] rounded-[7px] flex items-center justify-center shrink-0"
        :class="enabled ? 'bg-fill-folder text-primary' : 'bg-fill-track text-ink-4'"
      >
        <AppIcon name="folder" :size="16" />
      </div>
      <div class="flex-1 min-w-0 flex flex-col gap-[3px]">
        <div class="dir-title text-[13px] font-semibold text-ink-1 leading-[1.25]">{{ dir.name }}</div>
        <div class="dir-path font-mono text-[11px] text-ink-2 truncate">{{ dir.localPath }}</div>
        <div class="dir-path flex items-center gap-[5px]">
          <AppIcon name="cloud" :size="12" class="text-ink-4" />
          <span class="font-mono text-[11px] text-ink-3 truncate">{{ dir.remotePath }}</span>
        </div>
      </div>
      <div class="flex items-center gap-[10px] shrink-0 self-center">
        <div class="flex flex-col items-end gap-[3px] min-w-[64px]">
          <!-- 已禁用：目录级开关关闭，自动与手动同步均跳过 -->
          <template v-if="!enabled">
            <div class="flex items-center gap-[5px]">
              <span class="idle-dot" />
              <span class="st muted">{{ statusText }}</span>
            </div>
            <span class="time">{{ timeText }}</span>
          </template>
          <!-- 已同步 / 同步完成 -->
          <template v-else-if="dir.status === 'synced'">
            <div class="flex items-center gap-[5px]">
              <AppIcon name="check-circle" :size="12" bg="var(--green-bg)" class="text-success" />
              <span class="st green">{{ statusText }}</span>
            </div>
            <span class="time">{{ timeText }}</span>
          </template>
          <!-- 正在同步 -->
          <template v-else-if="dir.status === 'syncing'">
            <div class="flex items-center gap-[5px]">
              <span class="pulse-dot" />
              <span class="st amber">{{ statusText }}</span>
            </div>
            <span class="time amber">{{ timeText }}</span>
          </template>
          <!-- 有冲突 -->
          <template v-else-if="dir.status === 'conflict'">
            <div class="flex items-center gap-[5px]">
              <span class="pulse-dot" />
              <span class="st amber">{{ statusText }}</span>
            </div>
            <span class="time amber">{{ timeText }}</span>
          </template>
          <!-- 失败 -->
          <template v-else-if="dir.status === 'error'">
            <div class="flex items-center gap-[5px]">
              <span class="err-dot" />
              <span class="st red">{{ statusText }}</span>
            </div>
            <span class="time" :title="dir.errorDetail || dir.errorMessage || ''">{{ timeText }}</span>
          </template>
          <!-- 等待同步 -->
          <template v-else>
            <div class="flex items-center gap-[5px]">
              <span class="idle-dot" />
              <span class="st muted">{{ statusText }}</span>
            </div>
            <span class="time">{{ timeText }}</span>
          </template>
        </div>
        <AppDropdown placement="bottom-end" teleport :min-width="232" :offset="6">
          <template #trigger="{ toggle }">
            <AppIconButton :size="26" title="更多操作" class="text-ink-3" @click="toggle">
              <AppIcon name="dots-h" :size="9" />
            </AppIconButton>
          </template>
          <template #default="{ close }">
            <div class="dir-menu">
              <button type="button" class="mi" :disabled="!enabled || syncing" @click="onSyncNow(close)">
                <AppIcon name="refresh" :size="13" class="mi-ic" :class="{ spin: syncing }" />
                <span>立即同步</span>
              </button>
              <button type="button" class="mi" @click="onToggleEnabled(close)">
                <AppIcon :name="enabled ? 'pause' : 'play'" :size="13" class="mi-ic" />
                <span>{{ enabled ? '暂停同步' : '恢复同步' }}</span>
              </button>
              <button type="button" class="mi" @click="onOpenSettings(close)">
                <AppIcon name="gear" :size="13" class="mi-ic" />
                <span>同步设置</span>
              </button>
              <div class="mi-sep" />
              <button type="button" class="mi danger" @click="onRemove(close)">
                <AppIcon name="trash" :size="13" class="mi-ic" />
                <span>移除同步</span>
              </button>
            </div>
          </template>
        </AppDropdown>
      </div>
    </div>

    <!-- 同步进行中：进度区 + 取消按钮（次要文字样式，紧邻进度区；规划期无任务时仍可取消） -->
    <div v-if="syncing" class="flex flex-col gap-[6px]">
      <div class="flex items-center gap-2">
        <span v-if="hasTaskProgress" class="text-[11px] font-medium text-btn-text">{{ dir.progress?.filesDone ?? 0 }} / {{ dir.progress?.filesTotal ?? 0 }} 个文件</span>
        <span v-if="hasTaskProgress" class="font-mono text-[11px] text-ink-3">{{ fmtBytes(dir.progress?.bytesDone ?? 0) }} / {{ fmtBytes(dir.progress?.bytesTotal ?? 0) }}</span>
        <span class="flex-spacer" />
        <button type="button" class="cancel-btn" @click="onCancelSync">取消</button>
      </div>
      <div v-if="hasTaskProgress" class="track">
        <div class="fill" :style="{ width: pct + '%' }" />
      </div>
    </div>

    <!-- 同步完成摘要条 -->
    <div v-if="dir.status === 'synced' && dir.justCompleted && summary" class="strip done rise-in-sm">
      <AppIcon name="check-circle" :size="14" bg="var(--green-bg)" class="text-success" />
      <span class="text-[11px] font-semibold text-success-deep">{{ summary.totalFiles }} 个文件已同步</span>
      <span class="sep" />
      <span class="inline-flex items-center gap-[5px] text-[11px] font-medium text-success-deep"><AppIcon name="upload" :size="12" class="text-success" />上传 {{ summary.uploaded }} 个</span>
      <span class="inline-flex items-center gap-[5px] text-[11px] font-medium text-success-deep"><AppIcon name="download" :size="12" class="text-success" />下载 {{ summary.downloaded }} 个</span>
      <span class="inline-flex items-center gap-[5px] text-[11px] font-medium text-success-deep">
        <AppIcon name="check-circle" :size="12" bg="var(--green-solid)" class="text-success-solid" v-if="summary.conflicts === 0" />
        {{ summary.conflicts === 0 ? '无冲突' : `${summary.conflicts} 个冲突` }}
      </span>
    </div>

    <!-- 冲突提示条（demo/兼容：真实同步的冲突经 onConflict 即时弹窗，status 不会停在 'conflict'） -->
    <div v-if="dir.status === 'conflict' && dir.conflictFile" class="strip warn-strip rise-in-sm">
      <AppIcon name="warn" :size="14" class="text-warning-icon" />
      <span class="flex-1 min-w-0 truncate text-[11px] text-warning-deep">{{ dir.conflictFile }} 这个文件在电脑和云端都被改过，请选择保留哪一个</span>
      <button type="button" class="inline-flex items-center gap-[3px] border-0 bg-transparent text-primary text-[11px] font-semibold shrink-0 py-[2px] px-0 hover:underline" @click="handleConflict">
        处理
        <AppIcon name="chevron-right" :size="10" />
      </button>
    </div>

    <!-- 失败提示条：默认只显示摘要，技术细节折叠在悬浮 title -->
    <div v-if="dir.status === 'error' && dir.errorMessage" class="strip error-strip rise-in-sm">
      <AppIcon name="warn" :size="14" class="text-danger" />
      <span class="flex-1 min-w-0 truncate text-[11px] text-[#b3261e]" :title="dir.errorDetail || dir.errorMessage">{{ dir.errorMessage }}</span>
    </div>

    <!-- 待处理挂起条：后台轮 defer 的冲突 + 批量删除超阈值的确认挂起，回窗口统一处理 -->
    <div v-if="pendingOpen > 0" class="strip warn-strip rise-in-sm">
      <AppIcon name="warn" :size="14" class="text-warning-icon" />
      <span class="flex-1 min-w-0 truncate text-[11px] text-warning-deep">{{
        pendingDeleteOpen > 0
          ? `${pendingOpen} 项等你处理（其中 ${pendingDeleteOpen} 项是删除，你确认前不会删除任何文件）`
          : `${pendingOpen} 个文件两边都被改过，等你选择保留哪个`
      }}</span>
      <button
        type="button"
        class="inline-flex items-center gap-[3px] border-0 bg-transparent text-primary text-[11px] font-semibold shrink-0 py-[2px] px-0 hover:underline"
        @click="pendingOpenModal = true"
      >
        处理
        <AppIcon name="chevron-right" :size="10" />
      </button>
    </div>

    <!-- 修改同步目录弹窗：与「添加同步目录」共用 DirFormModal，Teleport 到 body，遮罩覆盖整个插件窗口 -->
    <DirFormModal v-model:open="settingsOpen" :dir="dir" />

    <!-- 待处理冲突面板 -->
    <PendingConflictsModal v-model:open="pendingOpenModal" :dir="dir" />
  </div>
</template>

<style scoped lang="scss">
.row + .row {
  border-top: 1px solid var(--br-divider);
}

/* 已禁用：标题与路径弱化，状态区显示「已禁用」 */
.row.off {
  .dir-title,
  .dir-path {
    opacity: 0.5;
  }
}

/* 状态文字与时间：颜色随状态切换 */
.st {
  font-size: 11px;
  font-weight: 500;

  &.green {
    color: var(--green);
  }

  &.amber {
    color: var(--amber);
  }

  &.red {
    color: var(--red);
  }

  &.muted {
    color: var(--text-muted);
  }
}

.time {
  font-size: 11px;
  color: var(--text-muted);

  &.amber {
    color: var(--amber);
  }
}

/* 状态点：同步中呼吸 / 失败 / 空闲 */
.pulse-dot {
  width: 6px;
  height: 6px;
  border-radius: 3px;
  background: var(--amber-icon);
  animation: pulse 1.1s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.err-dot,
.idle-dot {
  width: 6px;
  height: 6px;
  border-radius: 3px;
}

.err-dot {
  background: var(--red);
}

.idle-dot {
  background: var(--text-muted);
}

/* 取消同步：次要文字按钮（同步进行中可见），悬停转危险色提示后果 */
.cancel-btn {
  border: none;
  background: transparent;
  padding: 2px 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);

  &:hover {
    color: var(--red);
  }
}

/* 进度条 */
.track {
  height: 4px;
  border-radius: 2px;
  background: var(--bg-track);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: 2px;
  background: var(--blue);
  transition: width 0.25s ease;
}

/* 摘要 / 提示条 */
.strip {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11px;

  &.done {
    background: var(--green-strip-bg);
    border: 1px solid var(--green-strip-br);
  }

  &.warn-strip {
    background: var(--amber-bg);
  }

  &.error-strip {
    background: #fdf3f2;
  }
}

.sep {
  width: 3px;
  height: 3px;
  border-radius: 2px;
  background: var(--green-dot-br);
}

/* ---------- 更多操作菜单（AppDropdown 面板内） ---------- */
.dir-menu {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.mi {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 5px;
  background: transparent;
  font-size: 12px;
  color: var(--text-1);
  text-align: left;

  .mi-ic {
    color: var(--text-3);
  }

  &:hover:not(:disabled) {
    background: #f1f3f6;
  }

  &:disabled {
    cursor: default;
    color: var(--text-muted);

    .mi-ic {
      color: var(--text-muted);
    }
  }

  &.danger {
    color: var(--red);

    .mi-ic {
      color: var(--red);
    }

    &:hover:not(:disabled) {
      background: #fdf3f2;
    }
  }
}

.mi-sep {
  height: 1px;
  margin: 3px 6px;
  background: var(--br-divider);
}
</style>
