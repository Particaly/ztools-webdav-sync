<script setup lang="ts">
import { computed, reactive } from 'vue'
import AppIcon from './AppIcon.vue'
import { AppButton, AppModal } from './ui'
import { useStore } from '../composables/store'

const store = useStore()
const prompt = computed(() => store.state.activePluginPrompt)

/**
 * 展示条目（按名称去重保序）：同一插件的多个文件命中时只展示一次；name 已是
 * 「title 优先」的展示名（引擎侧解析，无记录时为实体文件名）；logo 为可直接
 * 展示的图标地址（file:// / data: / http(s):），无图标回退通用插件图标。
 */
const plugins = computed(() => {
  const seen = new Set<string>()
  return (prompt.value?.items ?? []).filter((it) => {
    if (seen.has(it.name)) return false
    seen.add(it.name)
    return true
  })
})

/** 加载失败的图标地址集合（回退通用插件图标；reactive Set 驱动模板重渲染） */
const brokenLogos = reactive(new Set<string>())

/** 「重新安装并同步」：卸载这些插件（保留插件数据），随即自动同步云端版本并重新安装 */
function reinstall() {
  store.resolvePluginPrompt('uninstall')
}

/** 「暂不处理」：本轮跳过这些文件（两侧保持原样），下次同步再试 */
function skip() {
  store.resolvePluginPrompt('skip')
}
</script>

<template>
  <Transition name="modal-pop">
    <AppModal
      v-if="prompt"
      title="这些插件将被重新安装"
      subtitle="它们正在运行，文件被占用，需要先卸载旧版本才能完成同步"
      :width="420"
      :show-close="false"
      :close-on-mask="false"
      :esc-close="false"
      footer-justify="start"
    >
      <template #icon>
        <AppIcon name="warn" :size="16" class="text-warning-icon" />
      </template>

      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-[6px] rounded-[5px] bg-fill-seg px-[10px] py-[8px]">
          <div v-for="it in plugins" :key="it.entityPath" class="flex items-center gap-[8px] text-[12px] text-ink-1" :title="it.rel">
            <img
              v-if="it.logo && !brokenLogos.has(it.entityPath)"
              :src="it.logo"
              alt=""
              draggable="false"
              class="h-[18px] w-[18px] shrink-0 rounded-[4px] object-contain"
              @error="brokenLogos.add(it.entityPath)"
            />
            <AppIcon v-else name="box" :size="14" class="shrink-0 text-ink-3" />
            <span class="truncate font-medium">{{ it.name }}</span>
          </div>
        </div>
        <div class="text-[11px] leading-[1.5] text-ink-2">
          卸载会关闭这些插件并移除旧版本文件（<b>保留插件数据</b>），随后自动同步云端版本并重新安装 —— 完成后重新打开即可使用。未保存的工作可能丢失，请先确认。
        </div>
        <div class="text-[11px] leading-[1.4] text-ink-4">
          选择「暂不处理」时，本轮跳过这些插件的更新（其余文件照常同步），下次同步会再次询问。
        </div>
      </div>

      <template #footer>
        <AppButton title="本轮跳过这些插件的更新（文件保持原样），下次同步再试" @click="skip">暂不处理</AppButton>
        <span class="flex-spacer" />
        <AppButton variant="primary" pad="0 14px" title="卸载这些插件（保留数据），同步并重新安装" @click="reinstall">重新安装并同步</AppButton>
      </template>
    </AppModal>
  </Transition>
</template>
