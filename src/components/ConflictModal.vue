<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { AppButton, AppModal } from './ui'
import { useStore } from '../composables/store'
import { fmtClock, fmtSize, relBaseName } from '../composables/format'

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
</script>

<template>
  <Transition name="modal-pop">
    <AppModal
      v-if="info"
      title="这个文件两边都改过了"
      subtitle="电脑上和云端的版本都有新的修改，请选择保留哪一个"
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
      <div class="flex items-center gap-[6px] bg-fill-seg rounded-[5px] px-2 py-[4px] text-ink-2">
        <AppIcon name="file" :size="12" />
        <span class="font-mono text-[11px] font-medium text-btn-text">{{ fileName }}</span>
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
      <div class="text-[11px] text-ink-4">选「两个都留」，云端的文件会另存为 {{ conflictCopyName }}，电脑上的文件不变</div>
      <div v-if="info.hint === 'partial-upload'" class="flex items-start gap-[6px] rounded-[5px] bg-fill-seg px-[10px] py-[6px] text-ink-2 leading-[1.4]">
        <AppIcon name="warn" :size="12" class="mt-[2px] shrink-0 text-warning-icon" />
        <span>云端的文件比电脑上的小，而且这台电脑有一次没传完的上传记录，云端的可能是上次中断后留下的不完整文件。建议选「保留电脑版本」，会重新完整上传。</span>
      </div>
      <div class="text-[11px] text-ink-4 leading-[1.4]">
        两台设备的系统时间可能不一致，修改时间仅供参考，请结合文件大小和内容判断。
      </div>
      <label class="flex items-center gap-[6px] text-[11px] text-ink-2 select-none cursor-pointer">
        <input v-model="applyAll" type="checkbox" class="accent-[var(--blue)] w-[13px] h-[13px] cursor-pointer" />
        其余的冲突也都这样处理
      </label>
    </div>

    <template #footer>
      <AppButton @click="choose('both')">两个都留</AppButton>
      <span class="flex-spacer" />
      <AppButton @click="choose('remote')">保留云端版本</AppButton>
      <AppButton variant="primary" pad="0 14px" @click="choose('local')">保留电脑版本</AppButton>
    </template>
    </AppModal>
  </Transition>
</template>
