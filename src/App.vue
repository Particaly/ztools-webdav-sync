<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import MainView from './views/MainView.vue'
import SettingsView from './views/SettingsView.vue'
import SyncRecordsView from './views/SyncRecordsView.vue'
import ConflictModal from './components/ConflictModal.vue'
import RootLostModal from './components/RootLostModal.vue'
import PendingCenterModal from './components/PendingCenterModal.vue'
import AppToasts from './components/ui/AppToasts.vue'
import { useStore } from './composables/store'

const store = useStore()

/** 路由过渡方向：进设置 / 同步记录自右滑入，返回主页自左滑入 */
const routeAnim = ref('route-next')
watch(
  () => store.state.route,
  (to) => {
    routeAnim.value = to === 'main' ? 'route-prev' : 'route-next'
  }
)

onMounted(async () => {
  await store.init()
  // 插件生命周期钩子（onPluginOut / onPluginEnter）由 preload 侧先注册持有槽位
  // （宿主为单回调槽位、后注册会覆盖），并经调度器订阅转发 plugin-out / plugin-enter
  // 事件 —— 渲染层不再自行注册。
})
</script>

<template>
  <div class="app-shell">
    <Transition :name="routeAnim" mode="out-in">
      <MainView v-if="store.state.route === 'main'" />
      <SyncRecordsView v-else-if="store.state.route === 'decisions'" />
      <SettingsView v-else />
    </Transition>
    <ConflictModal />
    <RootLostModal />
    <PendingCenterModal />
    <AppToasts />
  </div>
</template>

<style scoped>
.app-shell {
  position: relative;
  height: 100vh;
  overflow: hidden;
}
</style>
