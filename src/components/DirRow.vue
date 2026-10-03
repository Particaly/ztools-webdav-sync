<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import DirFormModal from './DirFormModal.vue'
import PendingConflictsModal from './PendingConflictsModal.vue'
import { AppDropdown, AppIconButton } from './ui'
import { useStore, dirRootLostOpen } from '../composables/store'
import { fmtBytes, fmtRelTime } from '../composables/format'
import type { SyncDir } from '../env.d'

const props = defineProps<{ dir: SyncDir }>()
const store = useStore()

/** 目录进度载荷（SyncDir.progress 的非空形态，本组件的折算与文案输入） */
type DirProgress = NonNullable<SyncDir['progress']>

/**
 * 把一轮同步的进度折算为整条进度条的百分比（前置 10% + 传输 80% + 后置 10%）：
 *   前置 10% —— 扫描起步 3%，规划 6%，verify 校验在 4–8% 间按完成数推进，锁 9%；
 *   传输 80% —— 10%–90%，按「已完成字节 / 计划上传+下载字节」推进（与文件数无关；
 *               字节分母为 0 的空轮直接落 90%）；
 *   后置 10% —— 收尾阶段定格 95%（批量校验提交 / 基线落盘 / 清理，轮末即达 100%）。
 * 旧事件无 stage 时按 phase 回落；传输段在字节分母缺失时退回按文件数折算。
 */
function syncRoundPercent(p: DirProgress | null): number {
  if (!p) return 0
  const stage = p.stage
  if (stage === 'lockwait' || stage === 'lock') return 9
  if (stage === 'finalize') return 95
  if (stage === 'transfer' || (!stage && p.phase === 'transfer')) {
    if (p.bytesTotal > 0) return Math.min(90, Math.round(10 + (p.bytesDone / p.bytesTotal) * 80))
    if (!stage && p.filesTotal > 0) return Math.min(90, Math.round(10 + (p.filesDone / p.filesTotal) * 80))
    return 90
  }
  if (stage === 'verify' || (!stage && p.phase === 'plan')) {
    if (p.verifyTotal && p.verifyTotal > 0) return Math.round(4 + 4 * Math.min(1, (p.verifyDone ?? 0) / p.verifyTotal))
    return 6
  }
  // scan（本地扫描无既定总量）：低位起步值，随规划 / 锁 / 传输逐段推进
  return 3
}

/** 相对路径取末段文件名（当前任务展示用） */
function baseNameOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i >= 0 ? rel.slice(i + 1) : rel
}

/** 当前正在进行的任务文案（细分阶段 → 「正在…」；旧事件无 stage 时按 phase 回落） */
function syncTaskText(p: DirProgress): string {
  // 旧事件形态兼容：无 stage 时按粗粒度 phase 映射（phase 与 stage 口径一致，
  // 绝不能把传输中的事件误标成「正在扫描」）
  if (!p.stage) {
    if (p.phase === 'plan') return '正在比对文件差异…'
    if (p.phase === 'transfer') return '正在同步文件…'
    return p.filesDone > 0 ? `正在扫描文件（已发现 ${p.filesDone} 个）…` : '正在扫描文件…'
  }
  switch (p.stage) {
    case 'lockwait':
      return '正在等待其他设备完成同步…'
    case 'lock':
      return '正在确认租约锁…'
    case 'verify':
      return p.verifyTotal && p.verifyTotal > 0 ? `正在校验文件内容（${p.verifyDone ?? 0}/${p.verifyTotal}）…` : '正在校验文件内容…'
    case 'finalize':
      return '正在完成收尾…'
    case 'plan':
      return '正在比对文件差异…'
    case 'transfer': {
      const name = p.currentFile ? baseNameOf(p.currentFile) : ''
      if (p.currentOp === 'upload') return name ? `正在上传 ${name}` : '正在上传文件…'
      if (p.currentOp === 'download') return name ? `正在下载 ${name}` : '正在下载文件…'
      if (p.currentOp === 'delete-local' || p.currentOp === 'delete-remote') return name ? `正在删除 ${name}` : '正在删除文件…'
      if (p.currentOp === 'conflict') return name ? `正在处理冲突 ${name}` : '正在处理冲突…'
      return '正在同步文件…'
    }
    default:
      // scan：附已发现文件数（无既定总量，不给百分比预期）
      return p.filesDone > 0 ? `正在扫描文件（已发现 ${p.filesDone} 个）…` : '正在扫描文件…'
  }
}

const pct = computed(() => syncRoundPercent(props.dir.progress))
/** 当前任务文案（同步中才有意义；「正在同步…」兜底给无 progress 的排队态） */
const taskText = computed(() => (props.dir.progress ? syncTaskText(props.dir.progress) : '正在同步…'))
/** 传输字节展示：分母存在时（传输 / 收尾段）显示「已完成 / 计划总量」 */
const bytesText = computed(() => {
  const p = props.dir.progress
  if (!p || !p.bytesTotal) return ''
  return `${fmtBytes(p.bytesDone)} / ${fmtBytes(p.bytesTotal)}`
})

const enabled = computed(() => store.dirEnabled(props.dir))
const syncing = computed(() => props.dir.status === 'syncing')

/** 未处理（无 choice）的挂起数：冲突（后台轮 defer）+ 删除确认（批量超阈值），面板统一处理；
 *  根丢失决策（kind='root-lost'）是独立的目录级决策，由专门提示条承载，不计入这里 */
const pendingOpen = computed(
  () =>
    (props.dir.pendingConflicts ?? []).filter((p) => !p.choice && p.kind !== 'root-lost' && p.kind !== 'delete').length +
    (props.dir.deleteBatch?.undecided ?? 0)
)
/** 未处理的删除确认数（提示条文案区分「冲突待选择」与「删除待确认」）：批量快照的
 *  undecided 是引擎真值 —— 逐文件记录有 500 条上限，超出部分只有快照知道 */
const pendingDeleteOpen = computed(() => props.dir.deleteBatch?.undecided ?? 0)
/** 未决策的「云端文件夹丢失」挂起：同步已暂停（零删除零传输），展示专门提示条 */
const rootLostOpen = computed(() => dirRootLostOpen(props.dir))

/** 错误详情的首条具体原因（跳过与摘要重复的首行）：失败条第二行展示「为什么失败」，
 *  扫描类失败（如没能完整读取文件列表）的具体原因（HTTP 码 / 哪一侧 / 哪个目录）在此可见 */
const errDetailLine = computed(() => {
  const lines = String(props.dir.errorDetail || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  return lines.find((l) => l !== props.dir.errorMessage) || ''
})

/** 打开「云端文件夹丢失」决策弹窗（与本弹窗的全局挂载点共用 store 状态） */
function openRootLost() {
  store.state.rootLostPromptDirId = props.dir.id
}

/** 「同步设置」弹窗与「待处理记录」面板开关 */
const settingsOpen = ref(false)
const pendingOpenModal = ref(false)

/**
 * 全局待处理中心「去处理」的一次性直达通道：store.pendingPanelDirId 指到本目录时
 * 打开本地待处理面板并立刻清回 null（通道只消费一次，不留残留状态）。
 */
watch(
  () => store.state.pendingPanelDirId,
  (v) => {
    if (v === props.dir.id) {
      store.state.pendingPanelDirId = null
      pendingOpenModal.value = true
    }
  }
)

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
  if (d.status === 'syncing' && d.progress) return `进度 ${pct.value}%`
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
  <div class="row flex flex-col gap-[9px] p-3 bg-white" :class="{ off: !enabled }">    <div class="flex gap-3">
      <div
        class="w-[30px] h-[30px] rounded-[7px] flex items-center justify-center shrink-0"
        :class="enabled ? 'bg-fill-folder text-primary' : 'bg-fill-track text-ink-4'"
      >
        <AppIcon name="folder" :size="16" />
      </div>
      <div class="flex-1 min-w-0 flex flex-col gap-[3px]">
        <div class="dir-title text-[13px] font-semibold text-ink-1 leading-[1.25]">{{ dir.name }}</div>
        <div class="dir-path font-mono text-[11px] text-ink-2 truncate" :title="dir.localPath">{{ dir.localPath }}</div>
        <div class="dir-path flex items-center gap-[5px]">
          <AppIcon name="cloud" :size="12" class="text-ink-4" />
          <span class="font-mono text-[11px] text-ink-3 truncate" :title="dir.remotePath">{{ dir.remotePath }}</span>
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
            <AppIconButton :size="26" variant="ghost" title="更多操作" class="text-ink-3" @click="toggle">
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

    <!-- 同步进行中：当前任务 + 字节进度 + 整条进度条 + 取消（前置 10% / 传输字节 80% / 后置 10% 折算） -->
    <div v-if="syncing" class="flex flex-col gap-[6px]">
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-[11px] font-medium text-btn-text truncate" :title="taskText">{{ taskText }}</span>
        <span class="flex-spacer" />
        <span v-if="bytesText" class="font-mono text-[11px] text-ink-3 shrink-0">{{ bytesText }}</span>
        <span class="font-mono text-[11px] text-ink-3 shrink-0">{{ pct }}%</span>
        <button type="button" class="cancel-btn" @click="onCancelSync">取消</button>
      </div>
      <div class="track">
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
      <button type="button" class="inline-flex items-center gap-[3px] border-0 bg-transparent text-primary text-[11px] font-semibold shrink-0 py-[2px] px-0 [text-underline-offset:2px] hover:underline" @click="handleConflict">
        处理
        <AppIcon name="chevron-right" :size="10" />
      </button>
    </div>

    <!-- 失败提示条：摘要 + 首条具体原因（完整细节折叠在悬浮 title），并提供「重试同步」；
         云端文件夹丢失待决策时由下方专门提示条承载，不重复展示 -->
    <div v-if="dir.status === 'error' && dir.errorMessage && !rootLostOpen" class="strip error-strip rise-in-sm">
      <AppIcon name="warn" :size="14" class="text-danger shrink-0" />
      <span class="flex-1 min-w-0 flex flex-col gap-[1px]" :title="dir.errorDetail || dir.errorMessage">
        <span class="truncate text-[11px] text-[#b3261e]">{{ dir.errorMessage }}</span>
        <span v-if="errDetailLine" class="truncate text-[10px] text-[#b3261e] opacity-80">{{ errDetailLine }}</span>
      </span>
      <button
        type="button"
        class="inline-flex items-center gap-[3px] border-0 bg-transparent text-primary text-[11px] font-semibold shrink-0 py-[2px] px-0 [text-underline-offset:2px] hover:underline"
        @click="store.syncDir(props.dir)"
      >
        重试同步
      </button>
    </div>

    <!-- 云端文件夹丢失待决策条：引擎已停止该目录同步（零删除零传输），点开决策弹窗二选一 -->
    <div v-if="rootLostOpen" class="strip error-strip rise-in-sm">
      <AppIcon name="warn" :size="14" class="text-danger" />
      <span class="flex-1 min-w-0 truncate text-[11px] text-[#b3261e]">云端的同步文件夹不见了，同步已暂停，等你确认是重新上传还是删除本地文件</span>
      <button
        type="button"
        class="inline-flex items-center gap-[3px] border-0 bg-transparent text-primary text-[11px] font-semibold shrink-0 py-[2px] px-0 [text-underline-offset:2px] hover:underline"
        @click="openRootLost"
      >
        处理
        <AppIcon name="chevron-right" :size="10" />
      </button>
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
        class="inline-flex items-center gap-[3px] border-0 bg-transparent text-primary text-[11px] font-semibold shrink-0 py-[2px] px-0 [text-underline-offset:2px] hover:underline"
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
.row {
  transition: background-color 0.15s ease;

  &:hover {
    background: #fafbfc;
  }
}

.row + .row {
  border-top: 1px solid var(--br-divider);
}

/* 最后一条底部收边：列表未撑满容器时（白色背景上）避免列表块底部无边界 */
.row:last-child {
  border-bottom: 1px solid var(--br-divider);
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
  transition: color 0.12s ease;

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
  position: relative;
  height: 100%;
  border-radius: 2px;
  background: var(--blue);
  transition: width 0.3s var(--ease-swift);
  overflow: hidden;

  /* 流动光特效：高光带沿已加载部分从左到右循环扫过（传输中的动感反馈） */
  &::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: linear-gradient(100deg, transparent 15%, rgba(255, 255, 255, 0.55) 50%, transparent 85%);
    transform: translateX(-100%);
    animation: fill-shimmer 1.5s ease-in-out infinite;
  }
}

@keyframes fill-shimmer {
  to {
    transform: translateX(100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .fill::after {
    animation: none;
  }
}

/* 摘要 / 提示条：三种语义同构（浅底 + 同色系细边），仅色相区分 */
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
    border: 1px solid var(--amber-strip-br);
  }

  &.error-strip {
    background: var(--red-strip-bg);
    border: 1px solid var(--red-strip-br);
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
  transition: background 0.12s ease;

  .mi-ic {
    color: var(--text-3);
    transition: color 0.12s ease;
  }

  &:hover:not(:disabled) {
    background: #f1f3f6;

    .mi-ic {
      color: var(--text-1);
    }
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
