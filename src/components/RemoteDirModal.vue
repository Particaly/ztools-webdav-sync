<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { AppButton, AppModal } from './ui'
import { useStore } from '../composables/store'

/** 子目录条目（preload dav.listDirs 返回结构） */
interface DirEntry {
  name: string
  path: string
}

/**
 * 远端目录选择弹窗：从服务器根目录逐级浏览 WebDAV 目录树并选中一个目录，
 * 供「设置 - 默认 WebDAV 目录」与「添加同步目录 - WebDAV 目录」的浏览入口复用。
 * 连接配置取自全局 store 的当前值（允许使用尚未保存的输入）；
 * 无 preload 的浏览器预览环境使用内置演示目录树。
 * 点选列表条目进入下一级，「选择当前目录」通过 pick 事件把当前路径回传给使用方。
 */
const props = withDefaults(
  defineProps<{
    /** 打开时进入的初始远端路径，'' 或未传表示服务器根目录 */
    initialPath?: string
    /** 弹窗标题 */
    title?: string
    /** 弹窗副标题：说明本次选择的用途（同步位置 / 功能测试目录等） */
    subtitle?: string
  }>(),
  { initialPath: '', title: '选择云端文件夹', subtitle: '选择云端的一个文件夹作为同步位置' }
)

const emit = defineEmits<{ pick: [path: string]; close: [] }>()

const store = useStore()

const currentPath = ref('/')
const loading = ref(false)
const error = ref('')
const subDirs = ref<DirEntry[]>([])

/**
 * 长列表限长：服务器根目录可能平铺数千个子目录（网盘类服务器常见），
 * 一次性渲染全部条目会卡住弹窗。默认只渲染前 MAX_SHOWN 条，「显示更多」按批展开；
 * 列表容器本身可滚动，全部条目仍可达（只是不一次性进 DOM）。
 */
const MAX_SHOWN = 200
const shownCount = ref(MAX_SHOWN)
/** 当前实际渲染的子目录切片（进入新目录时重置） */
const shownDirs = computed(() => subDirs.value.slice(0, shownCount.value))

/** 规范化远端路径：以 / 开头、去尾部斜杠；空值视为根目录 */
function normalize(p: string): string {
  const trimmed = String(p || '').replace(/\/+$/, '')
  return trimmed ? (trimmed.startsWith('/') ? trimmed : '/' + trimmed) : '/'
}

/** 面包屑片段（根目录由独立的「根目录」按钮表示，不入列） */
const crumbs = computed(() => {
  const segs = currentPath.value.split('/').filter(Boolean)
  return segs.map((seg, i) => ({ name: seg, path: '/' + segs.slice(0, i + 1).join('/') }))
})

/** 浏览器预览用演示目录树：仅服务 ?demo= 场景，数据结构与真实返回一致 */
const DEMO_TREE: Record<string, string[]> = {
  '/': ['Documents', 'Photos', 'Backups'],
  '/Documents': ['Projects', 'Archive'],
  '/Documents/Projects': ['ZTools'],
  '/Documents/Archive': [],
  '/Photos': ['2025', '2026'],
  '/Photos/2025': [],
  '/Photos/2026': [],
  '/Backups': [],
}

/** 读取当前目录的子目录列表；失败时清空列表并记录 error 供界面重试 */
async function load() {
  loading.value = true
  error.value = ''
  shownCount.value = MAX_SHOWN // 换目录重置限长展开
  try {
    if (window.services) {
      subDirs.value = await window.services.dav.listDirs({ ...store.state.server }, currentPath.value)
    } else {
      // 纯浏览器预览：模拟一次网络往返后返回演示树数据
      await new Promise((r) => setTimeout(r, 200))
      const prefix = currentPath.value === '/' ? '' : currentPath.value
      subDirs.value = (DEMO_TREE[currentPath.value] || []).map((name) => ({ name, path: `${prefix}/${name}` }))
    }
  } catch (e) {
    subDirs.value = []
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

/** 进入某个子目录 */
function enter(dir: DirEntry) {
  currentPath.value = dir.path
  void load()
}

/** 跳转到面包屑上的某一级目录 */
function jump(path: string) {
  if (path === currentPath.value) return
  currentPath.value = path
  void load()
}

/** 返回上一级 */
function goUp() {
  const segs = currentPath.value.split('/').filter(Boolean)
  segs.pop()
  jump(segs.length ? '/' + segs.join('/') : '/')
}

/** 确认选择当前目录 */
function confirm() {
  emit('pick', currentPath.value)
}

onMounted(() => {
  currentPath.value = normalize(props.initialPath)
  void load()
})
</script>

<template>
  <AppModal
    :title="title"
    :subtitle="subtitle"
    :width="380"
    @close="emit('close')"
  >
    <div class="flex flex-col gap-[10px]">
      <!-- 面包屑：当前路径逐级可点 -->
      <div class="crumb-bar">
        <button type="button" class="crumb" :class="{ current: !crumbs.length }" @click="jump('/')">根目录</button>
        <template v-for="(c, i) in crumbs" :key="c.path">
          <AppIcon name="chevron-right" :size="10" class="crumb-sep" />
          <button type="button" class="crumb" :class="{ current: i === crumbs.length - 1 }" @click="jump(c.path)">
            {{ c.name }}
          </button>
        </template>
      </div>

      <!-- 子目录列表 -->
      <div class="dir-list">
        <div v-if="loading" class="dir-state">
          <AppIcon name="refresh" :size="13" class="spin text-ink-3" />
          <span class="text-ink-3">正在读取…</span>
        </div>
        <div v-else-if="error" class="dir-state flex-col items-start gap-[8px]">
          <span class="inline-flex items-center gap-[6px] text-danger">
            <AppIcon name="warn" :size="13" />
            {{ error }}
          </span>
          <AppButton size="sm" @click="load">重试</AppButton>
        </div>
        <div v-else-if="!subDirs.length" class="dir-state text-ink-4">这里面没有文件夹了</div>
        <template v-else>
          <button v-for="d in shownDirs" :key="d.path" type="button" class="dir-row" @click="enter(d)">
            <AppIcon name="folder" :size="14" class="text-icon-dark shrink-0" />
            <span class="dir-name">{{ d.name }}</span>
            <AppIcon name="chevron-right" :size="11" class="text-ink-4 shrink-0" />
          </button>
          <!-- 限长提示 + 展开：全部条目仍可达，只是不一次性渲染 -->
          <div v-if="subDirs.length > shownDirs.length" class="dir-more">
            <span class="text-[11px] text-ink-4">已显示 {{ shownDirs.length }} / {{ subDirs.length }} 个文件夹</span>
            <button type="button" class="more-btn" @click="shownCount += MAX_SHOWN">显示更多</button>
          </div>
        </template>
      </div>
    </div>

    <template #footer>
      <AppButton :disabled="loading || currentPath === '/'" @click="goUp">
        <AppIcon name="chevron-left" :size="12" />
        上一级
      </AppButton>
      <span class="flex-spacer" />
      <AppButton @click="emit('close')">取消</AppButton>
      <AppButton variant="primary" :disabled="loading" @click="confirm">
        <AppIcon name="check" :size="13" />
        选择当前目录
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped lang="scss">
.crumb-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  min-height: 28px;
  padding: 4px 10px;
  background: var(--bg-bar);
  border: 1px solid var(--br-bar);
  border-radius: 6px;
  font-size: 11px;

  .crumb {
    border: none;
    background: transparent;
    padding: 2px 4px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--blue);
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: background 0.12s ease;

    &:hover:not(.current) {
      background: var(--bg-badge);
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    // 当前级不可点，弱化为正文色
    &.current {
      color: var(--text-1);
      font-weight: 600;
      cursor: default;
    }
  }

  .crumb-sep {
    color: var(--text-muted);
    flex-shrink: 0;
  }
}

.dir-list {
  height: 216px;
  overflow-y: auto;
  border: 1px solid var(--br-divider);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  padding: 4px;

  .dir-row {
    display: flex;
    align-items: center;
    gap: 8px;
    border: none;
    background: transparent;
    padding: 7px 8px;
    border-radius: 6px;
    text-align: left;
    transition: background 0.12s ease;

    &:hover {
      background: var(--bg-seg);
    }

    .dir-name {
      flex: 1;
      min-width: 0;
      font-size: 12px;
      color: var(--text-1);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .dir-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex: 1;
    font-size: 11px;
    padding: 12px;

    &.flex-col {
      flex-direction: column;
      align-items: center;
    }
  }

  /* 限长展开条：列在滚动容器底部，展开下一批 */
  .dir-more {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border-top: 1px solid var(--br-divider);
    margin-top: 2px;

    .more-btn {
      border: 1px solid var(--br-divider);
      border-radius: 5px;
      background: transparent;
      padding: 2px 10px;
      font-size: 11px;
      color: var(--blue);

      &:hover {
        background: var(--bg-seg);
      }
    }
  }
}
</style>
