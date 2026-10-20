<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { AppButton, AppModal } from './ui'
import { useStore } from '../composables/store'
import { fmtClock, fmtSize, relBaseName, joinLocalPath } from '../composables/format'

const store = useStore()
const info = computed(() => store.state.activeConflict)
/** 「对本轮剩余冲突都这样处理」：随弹窗打开重置，勾选后透传给引擎（applyToRemaining） */
const applyAll = ref(false)
watch(info, (v) => {
  if (v) applyAll.value = false
})

/** 冲突文件名展示（badge）：远端 rel 取末段 */
const fileName = computed(() => relBaseName(info.value?.rel ?? ''))

/** 「同时保留」提示中的另存文件名：README.md -> README.conflict.md */
const conflictCopyName = computed(() => {
  const name = fileName.value
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)}.conflict${fileName.value.slice(dot)}` : `${name}.conflict`
})

function fmtTime(ms: number) {
  const d = new Date(ms)
  const now = new Date()
  const prefix = d.toDateString() === now.toDateString() ? '今天 ' : ''
  return `${prefix}${fmtClock(ms)}`
}

function choose(choice: 'local' | 'remote' | 'both') {
  store.state.conflictApplyAll = applyAll.value
  store.resolveConflict(choice)
}

/** 冲突所属目录（打开本地文件的入口需要其本地根路径） */
const dir = computed(() => store.state.dirs.find((d) => d.id === info.value?.dirId) ?? null)

/**
 * 冲突文件在电脑上的完整路径：本地目录连接远端 rel（拼接规则见 joinLocalPath）。
 * 「打开此文件」与「在资源管理器中定位」两个入口共用。
 */
const localFilePath = computed(() => {
  const d = dir.value
  const rel = info.value?.rel
  if (!d || !rel || rel === '.') return ''
  return joinLocalPath(d.localPath, rel)
})

/** 稍后处理：以 defer 结算本轮冲突，登记进待处理中心（两侧文件保持原样） */
function defer() {
  store.deferConflict()
}

/** 在电脑上打开冲突文件（shellOpenPath 对文件同样适用；路径缺失时静默） */
function openLocalFile() {
  if (localFilePath.value) store.openLocalFolder(localFilePath.value)
}

/** 在访达 / 资源管理器中定位冲突文件（打开所在文件夹并选中；路径缺失时静默） */
function revealLocalFile() {
  if (localFilePath.value) store.revealLocalFile(localFilePath.value)
}
</script>

<template>
  <Transition name="modal-pop">
    <AppModal
      v-if="info"
      title="检测到同步冲突"
      subtitle="本地与云端版本均有新的修改，请选择要保留的版本"
      :width="420"
      :show-close="false"
      :close-on-mask="false"
      :esc-close="false"
      footer-justify="start"
    >
    <template #icon>
      <AppIcon name="warn" :size="16" class="text-warning-icon" />
    </template>
    <template #title-extra>
      <div
        class="flex items-center gap-[6px] bg-fill-seg rounded-[5px] px-2 py-[4px] text-ink-2 min-w-0 max-w-[160px]"
        :title="info?.rel"
      >
        <AppIcon name="file" :size="12" class="shrink-0" />
        <span class="font-mono text-[11px] font-medium text-btn-text select-text truncate">{{ fileName }}</span>
      </div>
    </template>

    <div class="flex flex-col gap-3">
      <div class="flex gap-[10px]">
        <span class="w-[62px] shrink-0" />
        <span class="flex-1 flex items-center justify-center gap-[6px] rounded-[5px] px-[10px] py-[5px] text-[11px] font-semibold bg-fill-badge text-primary border border-solid border-[#c6dcf9]">
          <AppIcon name="monitor" :size="12" />
          电脑上的版本
        </span>
        <span class="flex-1 flex items-center justify-center gap-[6px] rounded-[5px] px-[10px] py-[5px] text-[11px] font-semibold bg-fill-seg text-btn-text border border-solid border-line-card-alt">
          <AppIcon name="cloud" :size="12" />
          云端的版本
        </span>
      </div>
      <div class="flex gap-[10px]">
        <span class="w-[62px] shrink-0 py-2 text-[11px] text-ink-3 leading-[1.2]">修改时间</span>
        <span class="flex-1 py-2 font-mono text-[11px] text-ink-1">{{ fmtTime(info.local.mtimeMs) }}</span>
        <span class="flex-1 py-2 font-mono text-[11px] text-ink-1">{{ fmtTime(info.remote.mtimeMs) }}</span>
      </div>
      <div class="flex gap-[10px]">
        <span class="w-[62px] shrink-0 py-2 text-[11px] text-ink-3 leading-[1.2]">文件大小</span>
        <span class="flex-1 py-2 font-mono text-[11px] text-ink-1">{{ fmtSize(info.local.size) }}</span>
        <span class="flex-1 py-2 font-mono text-[11px] text-ink-1">{{ fmtSize(info.remote.size) }}</span>
      </div>
      <div v-if="localFilePath" class="flex gap-[10px]">
        <span class="w-[62px] shrink-0" />
        <span class="flex-1 flex items-center gap-[14px]">
          <button
            type="button"
            class="open-link"
            :title="`${localFilePath}（用系统默认程序打开，看清内容再决定）`"
            @click="openLocalFile"
          >打开此文件</button>
          <button
            type="button"
            class="open-link"
            :title="`${localFilePath}（在访达 / 资源管理器中打开所在文件夹并选中该文件）`"
            @click="revealLocalFile"
          >在资源管理器中定位</button>
        </span>
      </div>
      <div class="text-[11px] text-ink-4">选择「同时保留」时，云端文件将另存为 {{ conflictCopyName }}，本地文件保持不变</div>
      <div class="text-[11px] text-ink-4 leading-[1.4]">
        选择「保留电脑版本 / 保留云端版本」时，未被保留的一侧将被覆盖：电脑上的旧版本会先移入系统回收站；云端没有回收站，被覆盖的云端版本将无法找回。不确定时建议「同时保留」。
      </div>
      <div v-if="info.hint === 'partial-upload'" class="flex items-start gap-[6px] rounded-[5px] bg-fill-seg px-[10px] py-[6px] text-ink-2 leading-[1.4]">
        <AppIcon name="warn" :size="12" class="mt-[2px] shrink-0 text-warning-icon" />
        <span>云端文件小于本地文件，且本机存在一次未完成的上传记录，云端文件可能是上次传输中断留下的不完整文件。建议选择「保留电脑版本」，将重新完整上传。</span>
      </div>
      <div class="text-[11px] text-ink-4 leading-[1.4]">
        两台设备的系统时间可能不一致，修改时间仅供参考，请结合文件大小和内容判断。
      </div>
      <label class="flex items-center gap-[6px] text-[11px] text-ink-2 select-none cursor-pointer">
        <input v-model="applyAll" type="checkbox" class="accent-[var(--blue)] w-[13px] h-[13px] cursor-pointer" />
        对其余冲突应用相同处理
      </label>
    </div>

    <template #footer>
      <AppButton variant="ghost" title="本轮先跳过这个文件（两侧保持原样），稍后在「待处理中心」里选择" @click="defer">稍后处理</AppButton>
      <span class="flex-spacer" />
      <AppButton @click="choose('both')">同时保留</AppButton>
      <AppButton @click="choose('remote')">保留云端版本</AppButton>
      <AppButton variant="primary" pad="0 14px" @click="choose('local')">保留电脑版本</AppButton>
    </template>
    </AppModal>
  </Transition>
</template>

<style scoped lang="scss">
/* 打开本地冲突文件：文字链形态（与首页帮助链接同款视觉），悬浮提示完整路径 */
.open-link {
  border: none;
  background: transparent;
  padding: 0;
  font-size: 11px;
  font-weight: 500;
  color: var(--blue);

  &:hover {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
}
</style>
