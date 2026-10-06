<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import AppDropdown from './ui/AppDropdown.vue'
import AppIconButton from './ui/AppIconButton.vue'
import { useStore } from '../composables/store'

const store = useStore()

const statusText = computed(() =>
  store.autoSyncPaused.value
    ? store.pauseStatusText.value
    : store.connStatus.value === 'connected'
      ? '已连接'
      : store.connStatus.value === 'disconnected'
        ? '未连接'
        : '未配置'
)
/** 暂停以琥珀点覆盖连接状态展示（恢复时机在 title / 下拉里），点击入口转「恢复」 */
const dotClass = computed(() => (store.autoSyncPaused.value ? 'paused' : store.connStatus.value))
</script>

<template>
  <header class="topbar">
    <div class="logo">
      <AppIcon name="cloud-sync" :size="17" />
    </div>
    <div class="flex flex-col gap-px">
      <div class="app-name">WebDAV 同步</div>
      <div class="flex items-center gap-[5px]">
        <span class="dot" :class="dotClass" />
        <span class="text-[11px] text-ink-2 leading-[1.2]" :title="store.autoSyncPaused.value ? '自动同步已暂停，手动「立即同步」仍可用' : ''">{{ statusText }}</span>
      </div>
    </div>
    <span class="flex-spacer" />
    <!-- 全局暂停 / 恢复自动同步（手动「立即同步」不受影响） -->
    <AppDropdown placement="bottom-end" :min-width="168">
      <template #trigger="{ toggle }">
        <AppIconButton
          :title="store.autoSyncPaused.value ? '自动同步已暂停' : '暂停自动同步'"
          variant="ghost"
          class="text-icon-dark"
          :class="{ 'pause-active': store.autoSyncPaused.value }"
          @click="toggle"
        >
          <AppIcon :name="store.autoSyncPaused.value ? 'play' : 'pause'" :size="15" />
        </AppIconButton>
      </template>
      <template #default="{ close }">
        <template v-if="!store.autoSyncPaused.value">
          <button type="button" class="menu-item" @click="store.pauseAutoSync(30 * 60000); close()">暂停 30 分钟</button>
          <button type="button" class="menu-item" @click="store.pauseAutoSync(60 * 60000); close()">暂停 1 小时</button>
          <button type="button" class="menu-item" @click="store.pauseAutoSync(4 * 60 * 60000); close()">暂停 4 小时</button>
          <button type="button" class="menu-item" @click="store.pauseAutoSync(0); close()">一直暂停（手动恢复）</button>
        </template>
        <button type="button" class="menu-item" @click="store.resumeAutoSync(); close()">恢复自动同步</button>
      </template>
    </AppDropdown>
    <!-- 同步记录入口：有待处理事项时图标角标红点提示（事项本身经待处理中心处理） -->
    <AppIconButton title="同步记录" variant="ghost" class="text-icon-dark dec-entry" @click="store.state.route = 'decisions'">
      <AppIcon name="history" :size="15" />
      <span v-if="store.pendingConflictTotal.value > 0" class="badge-dot" />
    </AppIconButton>
    <AppIconButton title="设置" variant="ghost" class="text-icon-dark" @click="store.state.route = 'settings'">
      <AppIcon name="gear" :size="15" />
    </AppIconButton>
    <AppDropdown placement="bottom-end" :min-width="128">
      <template #trigger="{ toggle }">
        <AppIconButton title="更多" variant="ghost" class="text-icon-dark" @click="toggle">
          <AppIcon name="dots-v" :size="15" />
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
  width: 30px;
  height: 30px;
  border-radius: 8px;
  /* 顶部提亮的单色渐变 + 内描边：小面积立体感，不抢主体 */
  background: linear-gradient(180deg, #eaf3fe 0%, #dcebfd 100%);
  box-shadow: inset 0 0 0 1px rgba(26, 115, 232, 0.14);
  color: var(--blue);
  display: flex;
  align-items: center;
  justify-content: center;
}

.app-name {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--text-1);
  line-height: 1.2;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 3px;
  background: var(--text-muted);
  transition: background-color 0.3s ease, box-shadow 0.3s ease;

  &.connected {
    background: var(--green-dot);
    /* 连接态光晕：小面积低饱和，让状态「活」而不噪 */
    box-shadow: 0 0 0 3px rgba(30, 158, 74, 0.14);
  }

  &.disconnected {
    background: #d97706;
    box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.14);
  }

  /* 全局暂停：琥珀常亮（与「警告但可控」的语义一致，不用红色） */
  &.paused {
    background: #d97706;
    box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.14);
  }
}

/* 暂停按钮激活态：图标转琥珀，提示当前处于暂停中 */
.pause-active {
  color: #d97706 !important;
}

/* 同步记录入口的待处理角标：图标右上角红点（描白边避免与图标粘连） */
.dec-entry {
  position: relative;

  .badge-dot {
    position: absolute;
    top: 5px;
    right: 5px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--red, #d93025);
    box-shadow: 0 0 0 1.5px #fff;
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
  transition: background 0.12s ease;

  &:hover {
    background: #f1f3f6;
  }
}
</style>
