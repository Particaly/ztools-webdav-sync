<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import AppDropdown from './ui/AppDropdown.vue'
import AppIconButton from './ui/AppIconButton.vue'
import { useStore } from '../composables/store'

const store = useStore()

const statusText = computed(() =>
  store.connStatus.value === 'connected' ? '已连接' : store.connStatus.value === 'disconnected' ? '未连接' : '未配置'
)
</script>

<template>
  <header class="topbar">
    <div class="logo">
      <AppIcon name="cloud-sync" :size="18" />
    </div>
    <div class="flex flex-col gap-px">
      <div class="app-name">WebDAV Sync</div>
      <div class="flex items-center gap-[5px]">
        <span class="dot" :class="store.connStatus.value" />
        <span class="text-[11px] text-ink-2 leading-[1.2]">{{ statusText }}</span>
      </div>
    </div>
    <span class="flex-spacer" />
    <AppIconButton title="设置" class="text-icon-dark" @click="store.state.route = 'settings'">
      <AppIcon name="gear" :size="14" />
    </AppIconButton>
    <AppDropdown placement="bottom-end" :min-width="128">
      <template #trigger="{ toggle }">
        <AppIconButton title="更多" class="text-icon-dark" @click="toggle">
          <AppIcon name="dots-v" :size="14" />
        </AppIconButton>
      </template>
      <template #default="{ close }">
        <button type="button" class="menu-item" @click="store.openGuide(); close()">查看配置指南</button>
        <button type="button" class="menu-item" @click="store.state.route = 'settings'; close()">打开设置</button>
      </template>
    </AppDropdown>
  </header>
</template>

<style scoped lang="scss">
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 56px;
  padding: 0 20px;
  border-bottom: 1px solid var(--br-bar);
  flex-shrink: 0;
}

.logo {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: var(--bg-badge);
  color: var(--blue);
  display: flex;
  align-items: center;
  justify-content: center;
}

.app-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.2;
}

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

.menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px 10px;
  border: none;
  background: transparent;
  border-radius: 5px;
  font-size: 12px;
  color: var(--text-1);

  &:hover {
    background: #f1f3f6;
  }
}
</style>
