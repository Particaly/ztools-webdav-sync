<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue'
import TopBar from '../components/TopBar.vue'
import ServerCard from '../components/ServerCard.vue'
import DirRow from '../components/DirRow.vue'
import StatusBar from '../components/StatusBar.vue'
import DirFormModal from '../components/DirFormModal.vue'
import { AppButton } from '../components/ui'
import { useStore } from '../composables/store'

const store = useStore()
</script>

<template>
  <div class="h-screen flex flex-col bg-white">
    <TopBar />
    <main class="flex-1 min-h-0 overflow-y-auto px-4 py-[14px] flex flex-col gap-[14px]">
      <ServerCard v-if="store.configured.value" />

      <template v-if="store.configured.value">
        <div class="flex items-center gap-[7px]">
          <div class="flex items-center gap-[7px]">
            <span class="text-[13px] font-semibold text-ink-1">同步目录</span>
            <span class="text-[11px] text-ink-4">{{ store.state.dirs.length }}</span>
          </div>
          <span class="flex-spacer" />
          <AppButton variant="primary" size="sm" @click="store.state.showAdd = true">
            <AppIcon name="plus" :size="13" />
            添加目录
          </AppButton>
        </div>

        <div class="relative bg-white border border-solid border-line-card-alt rounded-lg overflow-hidden">
          <TransitionGroup name="list">
            <DirRow v-for="d in store.state.dirs" :key="d.id" :dir="d" />
          </TransitionGroup>
        </div>
      </template>

      <!-- 首次未配置：空状态 -->
      <div v-else class="flex-1 flex items-center justify-center">
        <div class="rise-in flex flex-col items-center">
          <div class="mb-[14px]">
            <svg width="68" height="64" viewBox="0 0 68 64" fill="none">
              <!-- 云（蓝） -->
              <path
                d="M18 30.5a9.5 9.5 0 0 1-.89-18.98A12.75 12.75 0 0 1 41.6 14.4a8.5 8.5 0 0 1-2.1 16.7H18Z"
                stroke="#1a73e8"
                stroke-width="2.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M29.75 26.5v-7.9m0 0-4.2 4.2m4.2-4.2 4.2 4.2"
                stroke="#1a73e8"
                stroke-width="2.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <!-- 文件夹（深灰，右上与云轻微重叠） -->
              <path
                d="M24 37.5A3.5 3.5 0 0 1 27.5 34h9.8l3.7 4.2h19a3.5 3.5 0 0 1 3.5 3.5v7.8a3.5 3.5 0 0 1-3.5 3.5H27.5a3.5 3.5 0 0 1-3.5-3.5v-12Z"
                fill="#fff"
                stroke="#4a5056"
                stroke-width="2.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
          <h1 class="m-0 text-[18px] font-semibold text-ink-1">开始使用 WebDAV Sync</h1>
          <p class="mt-[6px] mb-0 text-[12px] text-ink-2">连接 WebDAV 服务器，并选择需要同步的本地目录</p>
          <div class="h-[22px]" />
          <div class="flex gap-[10px]">
            <AppButton variant="primary" size="lg" strong pad="0 16px" @click="store.state.route = 'settings'">
              <AppIcon name="cloud-up" :size="15" />
              配置 WebDAV
            </AppButton>
            <AppButton size="lg" @click="store.openGuide()">了解 WebDAV</AppButton>
          </div>
          <div class="h-[26px]" />
          <p class="m-0 text-[11px] text-ink-4">支持坚果云、Nextcloud、Synology 等标准 WebDAV 服务</p>
        </div>
      </div>
    </main>

    <!-- 底部：已配置显示状态栏；未配置显示帮助栏 -->
    <StatusBar v-if="store.configured.value" />
    <footer v-else class="flex items-center gap-2 h-[44px] px-4 bg-fill-bar border-t border-solid border-line-bar shrink-0">
      <AppIcon name="info" :size="13" class="text-ink-4" />
      <span class="text-[12px] text-ink-2">首次使用？查看配置指南了解如何连接你的 WebDAV 服务器</span>
      <button type="button" class="help-link" @click="store.openGuide()">查看指南</button>
    </footer>

    <!-- 弹窗：创建同步目录（与「修改同步目录」共用 DirFormModal，仅标题不同） -->
    <DirFormModal v-model:open="store.state.showAdd" />
  </div>
</template>

<style scoped lang="scss">
.help-link {
  border: none;
  background: transparent;
  padding: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--blue);

  &:hover {
    text-decoration: underline;
  }
}
</style>
