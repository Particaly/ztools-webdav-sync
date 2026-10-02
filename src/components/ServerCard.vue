<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { AppButton } from './ui'
import { useStore, tierLabel } from '../composables/store'
import { fmtRelTime } from '../composables/format'

const store = useStore()

const metaText = computed(() => {
  if (store.connStatus.value === 'connected') {
    const last = store.lastSyncAt.value
    // B / C 档的服务器能力边界用一句话呈现（A 档无需提示）；
    // 检测到的技术原因（writeReason）折叠进悬浮 title
    const caps = store.state.capabilities
    const tierNote =
      caps && caps.tier === 'B'
        ? ' · 多台设备同时改同一个文件时，可能互相覆盖'
        : caps && caps.tier === 'C'
          ? ' · 仅下载：服务器不允许上传'
          : ''
    return (last ? `已连接 · 上次同步：${fmtRelTime(last)}` : '已连接') + tierNote
  }
  if (store.connStatus.value === 'disconnected') return '未连接 · 点击「测试连接」检查'
  return '未配置 · 填写服务器信息后开始同步'
})

/** 档位短标签（运行良好 / 基本可用 / 仅下载），已连接且已检测时展示 */
const tierText = computed(() => {
  const caps = store.state.capabilities
  if (!caps || store.connStatus.value !== 'connected') return ''
  return tierLabel(caps.tier)
})

/** B / C 档的技术原因（悬浮 title 展示，界面默认不出现） */
const tierNoteTitle = computed(() => {
  const caps = store.state.capabilities
  return caps && caps.writeReason ? caps.writeReason : ''
})

const testing = computed(() => store.state.testing)
</script>

<template>
  <section class="card flex items-center gap-3 px-[14px] py-3">
    <div class="flex-1 min-w-0 flex flex-col gap-1 cursor-pointer" @click="store.state.route = 'settings'">
      <div class="flex items-center gap-2">
        <span class="text-[12px] font-semibold text-ink-1">WebDAV 服务器</span>
        <span v-if="tierText" class="tier-chip" :class="store.state.capabilities?.tier">{{ tierText }}</span>
        <AppIcon name="chevron-right" :size="12" class="text-ink-4" />
      </div>
      <div class="flex items-center gap-[7px] min-w-0">
        <AppIcon name="globe" :size="13" class="text-ink-4" />
        <span class="font-mono text-[12px] text-ink-2 truncate">{{ store.state.server.serverUrl || '尚未配置服务器地址' }}</span>
      </div>
      <div class="flex items-center gap-[6px]">
        <span class="dot" :class="store.connStatus.value" />
        <span class="text-[11px]" :class="store.connStatus.value === 'disconnected' ? 'text-warning' : 'text-ink-2'" :title="tierNoteTitle">{{ metaText }}</span>
      </div>
      <!-- http 明文连接警告：密码与文件内容可被窃听，提醒但不阻止 -->
      <div v-if="store.insecureHttp.value" class="flex items-center gap-[5px]">
        <AppIcon name="warn" :size="11" class="text-warning-icon shrink-0" />
        <span class="text-[11px] text-warning-icon truncate">当前地址以 http 开头，密码和文件在传输时没有加密，可能被他人截获。建议改用 https 开头的地址</span>
      </div>
    </div>
    <AppButton :disabled="testing" @click="store.testConnection()">
      <AppIcon name="refresh" :size="13" :class="{ spin: testing }" />
      {{ testing ? '测试中…' : '测试连接' }}
    </AppButton>
  </section>
</template>

<style scoped lang="scss">
.dot {
  width: 6px;
  height: 6px;
  border-radius: 3px;
  background: var(--text-muted);
  transition: background-color 0.3s ease;

  &.connected {
    background: var(--green-dot);
  }

  &.disconnected {
    background: #d97706;
  }
}

/* 档位徽标：A 绿 / B 琥珀 / C 中性灰，仅用既有色板变量与近似色 */
.tier-chip {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 1.4;
  color: #15803d;
  background: var(--green-bg, #f0fdf4);

  &.B {
    color: #b45309;
    background: #fffbeb;
  }

  &.C {
    color: var(--text-muted, #6b7280);
    background: var(--fill-bar, #f3f4f6);
  }
}
</style>
