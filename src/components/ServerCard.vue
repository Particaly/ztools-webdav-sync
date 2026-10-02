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
    // B / C 档的服务器能力边界直接呈现在状态行（A 档无需提示）；
    // C 档附写权限降级原因（如「服务器拒绝写入（HTTP 403）」）
    const caps = store.state.capabilities
    const tierNote =
      caps && caps.tier === 'B'
        ? ` · B 档：无法完全保证多设备并发安全${caps.writeRetrySoon && caps.writeReason ? `（${caps.writeReason}）` : ''}`
        : caps && caps.tier === 'C'
          ? ` · C 档：只读${caps.writeReason ? `（${caps.writeReason}）` : '，仅下载'}`
          : ''
    return (last ? `已连接 · 上次同步：${fmtRelTime(last)}` : '已连接') + tierNote
  }
  if (store.connStatus.value === 'disconnected') return '未连接 · 点击「测试连接」检查'
  return '未配置 · 填写服务器信息后开始同步'
})

/** 档位短标签（A 强保证 / B 尽力 / C 只读），已连接且已探测时展示 */
const tierText = computed(() => {
  const caps = store.state.capabilities
  if (!caps || store.connStatus.value !== 'connected') return ''
  return tierLabel(caps.tier)
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
        <span class="text-[11px]" :class="store.connStatus.value === 'disconnected' ? 'text-warning' : 'text-ink-2'">{{ metaText }}</span>
      </div>
      <!-- http 明文连接警告：密码与文件内容可被窃听，提醒但不阻止 -->
      <div v-if="store.insecureHttp.value" class="flex items-center gap-[5px]">
        <AppIcon name="warn" :size="11" class="text-warning-icon shrink-0" />
        <span class="text-[11px] text-warning-icon truncate">http 明文连接：密码与文件内容可被网络中间人窃听，建议改用 https</span>
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
