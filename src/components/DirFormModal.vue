<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import RemoteDirModal from './RemoteDirModal.vue'
import { AppButton, AppInput, AppModal, AppSegmented, AppSelect, AppSwitch } from './ui'
import { useStore, suggestRemote } from '../composables/store'
import { intervalOptions, strategyOptions } from '../composables/options'
import { toast } from '../composables/toast'
import type { DirOverrides, Prefs, SyncDir, SyncMode } from '../env.d'

/**
 * 同步目录「创建 / 修改」共用弹窗：传入 dir 为修改模式，不传为创建模式，仅标题不同。
 * 基础字段：本地目录 / WebDAV 目录 / 同步方式；「高级设置」默认收起，
 * 内含「覆盖全局设置」开关与冲突处理 / 忽略隐藏文件 / 同步间隔三项：
 * 未开启覆盖时三项只读展示全局当前值，开启后可单独编辑并随保存写入目录级覆盖。
 * 所有值先暂存在本地 ref，点击主按钮才提交；关闭（取消 / 遮罩 / 右上角）即丢弃未保存修改。
 * 通过 Teleport 挂到 body：DirRow 位于 relative 列表容器内，
 * 直接渲染会让 AppModal 的 absolute 遮罩被限制在列表卡片里。
 */
const props = defineProps<{ dir?: SyncDir }>()
const open = defineModel<boolean>('open', { default: false })

const store = useStore()
const prefs = store.state.prefs

/** 修改模式（传入 dir）/ 创建模式（不传 dir） */
const isEdit = computed(() => !!props.dir)

// ---------- 表单暂存值 ----------

const localPath = ref('')
const remotePath = ref('')
const mode = ref<SyncMode>('two-way')
/** 高级设置折叠区展开状态：默认收起 */
const advancedOpen = ref(false)
/** 「覆盖全局设置」开关：关闭时三项只读跟随全局，开启后可单独编辑 */
const overrideOn = ref(false)
const conflictStrategy = ref<Prefs['conflictStrategy']>('ask')
const ignoreHidden = ref(true)
const intervalMin = ref(15)
const localError = ref('')
const remoteError = ref('')
const showRemotePicker = ref(false)

/** 每次打开时按当前模式初始化表单：创建取全局默认，修改取目录当前生效值（覆盖 ?? 全局） */
function initForm() {
  const o = props.dir?.overrides
  overrideOn.value = !!o && (o.conflictStrategy !== undefined || o.ignoreHidden !== undefined || o.intervalMin !== undefined)
  if (props.dir) {
    localPath.value = props.dir.localPath
    remotePath.value = props.dir.remotePath
    mode.value = props.dir.mode
  } else {
    localPath.value = ''
    remotePath.value = prefs.defaultRemoteDir
    mode.value = 'two-way'
  }
  // 三项展示值：有目录级覆盖取覆盖值，否则展示全局当前值（未开启覆盖时为只读预览）
  conflictStrategy.value = (overrideOn.value ? o?.conflictStrategy : undefined) ?? prefs.conflictStrategy
  ignoreHidden.value = (overrideOn.value ? o?.ignoreHidden : undefined) ?? prefs.ignoreHidden
  intervalMin.value = (overrideOn.value ? o?.intervalMin : undefined) ?? prefs.intervalMin
  advancedOpen.value = false
  localError.value = ''
}

// immediate：创建模式在 ?demo=add 场景下 open 挂载时即为 true，不会触发 watch，需要在初始化时跑一次
watch(open, (v) => v && initForm(), { immediate: true })

// ---------- 标题与文案 ----------

const title = computed(() => (isEdit.value ? '修改同步目录' : '添加同步目录'))
const subtitle = computed(() => (isEdit.value ? props.dir!.name : '将本地目录与 WebDAV 云端目录建立同步关系'))
const submitText = computed(() => (isEdit.value ? '保存修改' : '添加目录'))

const modeOptions = [
  { value: 'two-way', label: '双向同步', icon: 'swap' },
  { value: 'upload', label: '仅上传', icon: 'upload' },
  { value: 'download', label: '仅下载', icon: 'download' },
] satisfies { value: SyncMode; label: string; icon?: string }[]

const remoteHint = computed(() => {
  switch (mode.value) {
    case 'two-way':
      return '双向同步：本地与云端任意一侧变更都会同步到另一侧'
    case 'upload':
      return '仅上传：本地文件的变更将上传到云端，云端变更不会下载'
    case 'download':
      return '仅下载：云端文件的变更将下载到本地，本地变更不会上传'
  }
  return ''
})

// ---------- 高级设置展开 / 收起的高度过渡（JS 钩子设定显式 height，兼容性优于 grid 0fr 插值） ----------

/** 展开动画：高度从 0 过渡到内容实际高度 */
function onAdvEnter(el: Element) {
  const h = el as HTMLElement
  h.style.height = '0'
  void h.offsetHeight // 强制回流，让起始高度先生效，过渡才能触发
  h.style.height = `${h.scrollHeight}px`
}

/** 展开结束：清除显式高度，交还给内容自适应（避免后续内容变化被固定高度截断） */
function onAdvAfterEnter(el: Element) {
  ;(el as HTMLElement).style.height = ''
}

/** 收起动画：先固定为当前内容高度，再过渡到 0 */
function onAdvLeave(el: Element) {
  const h = el as HTMLElement
  h.style.height = `${h.scrollHeight}px`
  void h.offsetHeight
  h.style.height = '0'
}

/** 收起结束：清除显式高度（元素已被 v-show 隐藏） */
function onAdvAfterLeave(el: Element) {
  ;(el as HTMLElement).style.height = ''
}

// ---------- 提交 ----------

/** 当前表单对应的目录级覆盖：未开启覆盖为 null（跟随全局）；开启时三项全部按当前值单独保存 */
function currentOverrides(): DirOverrides | null {
  if (!overrideOn.value) return null
  return { conflictStrategy: conflictStrategy.value, ignoreHidden: ignoreHidden.value, intervalMin: intervalMin.value }
}

function close() {
  open.value = false
}

function submit() {
  const local = localPath.value.trim()
  if (!local) {
    localError.value = '请选择要同步的本地目录'
    return
  }
  const remote = remotePath.value.trim() || suggestRemote(local)
  // 目录重叠校验：本地侧与远端侧分别判定，嵌套 / 重复的配置在保存时
  // 报错阻止 —— 两个同步对写同一棵子树会互相传播删除、watcher 互相触发。
  // 校验实现位于 preload（纯函数，e2e 直检覆盖）；浏览器预览无 preload 时跳过。
  if (window.services?.sync) {
    const overlap = window.services.sync.checkDirOverlap(
      { localPath: local, remotePath: remote },
      store.state.dirs,
      props.dir?.id
    )
    if (overlap) {
      if (overlap.side === 'local') localError.value = overlap.message + '：同步目录之间不能嵌套或重叠'
      else remoteError.value = overlap.message + '：同步目录之间不能嵌套或重叠'
      return
    }
  }
  localError.value = ''
  remoteError.value = ''
  const overrides = currentOverrides()
  if (props.dir) {
    store.updateDir(props.dir.id, { localPath: local, remotePath: remote, mode: mode.value, overrides })
  } else {
    store.addDir(local, remote, mode.value, overrides)
  }
  close()
}

// ---------- 浏览入口 ----------

function browse() {
  const picked = window.services?.fsx.pickDirectory('选择要同步的本地目录')
  if (picked) {
    localPath.value = picked
    // 远端路径为空或仍是另一目录的派生值时，按「默认 WebDAV 目录 > 本地目录名」补初值
    if (!remotePath.value.trim()) remotePath.value = store.state.prefs.defaultRemoteDir || suggestRemote(picked)
    localError.value = ''
  }
}

/** 打开远端目录选择器：未配置服务器时直接提示，避免必然失败的请求 */
function browseRemote() {
  if (!store.state.server.serverUrl.trim()) {
    toast.warning('请先填写服务器地址', '在设置中填写 WebDAV 地址后再浏览云端目录')
    return
  }
  showRemotePicker.value = true
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal-pop">
      <AppModal v-if="open" :title="title" :subtitle="subtitle" :width="408" @close="close">
        <template v-if="isEdit" #icon>
          <AppIcon name="gear" :size="16" class="text-ink-3" />
        </template>

        <div class="flex flex-col gap-[14px]">
          <!-- 本地目录 -->
          <div class="flex flex-col gap-[6px]">
            <div class="flex items-center gap-[6px]">
              <span class="text-[12px] font-medium text-btn-text">本地目录</span>
              <span class="text-danger font-medium">*</span>
            </div>
            <div class="flex gap-2">
              <AppInput
                v-model="localPath"
                icon="folder"
                mono
                class="flex-1 min-w-0"
                :invalid="!!localError"
                placeholder="选择或输入本地目录路径"
                @update:model-value="localError = ''"
              />
              <AppButton @click="browse">浏览…</AppButton>
            </div>
            <div class="text-[11px]" :class="localError ? 'text-danger' : 'text-ink-4'">
              {{ localError || '该目录下的文件变更会同步到云端' }}
            </div>
          </div>

          <!-- WebDAV 目录 -->
          <div class="flex flex-col gap-[6px]">
            <span class="text-[12px] font-medium text-btn-text">WebDAV 目录</span>
            <div class="flex gap-2">
              <AppInput v-model="remotePath" icon="cloud" mono class="flex-1 min-w-0" :invalid="!!remoteError" placeholder="/Projects" @update:model-value="remoteError = ''" />
              <AppButton @click="browseRemote">浏览…</AppButton>
            </div>
            <div v-if="remoteError" class="text-[11px] text-danger">{{ remoteError }}</div>
          </div>

          <!-- 同步方式 -->
          <div class="flex flex-col gap-[6px]">
            <span class="text-[12px] font-medium text-btn-text">同步方式</span>
            <AppSegmented v-model="mode" :options="modeOptions" />
            <div class="text-[11px] text-ink-4">{{ remoteHint }}</div>
          </div>

          <div class="divider" />

          <!-- 高级设置：默认收起，覆盖开关开启前三项只读跟随全局 -->
          <div class="flex flex-col gap-[6px]">
            <button type="button" class="adv-header" @click="advancedOpen = !advancedOpen">
              <AppIcon name="chevron-right" :size="11" class="adv-chev" :class="{ open: advancedOpen }" />
              <span class="text-[12px] font-medium text-ink-1">高级设置</span>
              <span v-if="overrideOn" class="adv-badge">已单独设置</span>
            </button>

            <!-- 高度过渡：JS 钩子设定显式 height（0 ↔ scrollHeight），展开 / 收起均平滑，弹窗高度随之变化；
                 name 用于生成 adv-enter-active / adv-leave-active 类，与下方过渡样式对应 -->
            <Transition
              name="adv"
              @enter="onAdvEnter"
              @after-enter="onAdvAfterEnter"
              @leave="onAdvLeave"
              @after-leave="onAdvAfterLeave"
            >
              <div v-show="advancedOpen" class="flex flex-col gap-[6px]">
                <!-- 覆盖全局设置开关：位于冲突处理上方，说明同时涵盖开 / 关两种状态 -->
                <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                  <div class="flex flex-col gap-[2px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">覆盖全局设置</span>
                    <span class="text-[11px] text-ink-4">开启后以下设置按此目录单独保存，关闭则跟随全局</span>
                  </div>
                  <span class="flex-spacer" />
                  <AppSwitch v-model="overrideOn" />
                </div>
                <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                  <div class="flex flex-col gap-[2px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">冲突处理</span>
                    <span class="text-[11px] text-ink-4">两侧同时修改时的处理方式</span>
                  </div>
                  <span class="flex-spacer" />
                  <AppSelect v-model="conflictStrategy" :options="strategyOptions" :width="104" :disabled="!overrideOn" />
                </div>
                <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                  <div class="flex flex-col gap-[2px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">忽略隐藏文件</span>
                    <span class="text-[11px] text-ink-4">跳过以 . 开头的文件和系统文件</span>
                  </div>
                  <span class="flex-spacer" />
                  <AppSwitch v-model="ignoreHidden" :disabled="!overrideOn" />
                </div>
                <div class="flex items-center gap-3 pt-[4px] mb-[2px]">
                  <div class="flex flex-col gap-[2px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">同步间隔</span>
                    <span class="text-[11px] text-ink-4">此目录自动同步的轮询周期</span>
                  </div>
                  <span class="flex-spacer" />
                  <AppSelect v-model="intervalMin" :options="intervalOptions" :width="104" :disabled="!overrideOn" />
                </div>
              </div>
            </Transition>
          </div>
        </div>

        <template #footer>
          <span class="flex-spacer" />
          <AppButton @click="close">取消</AppButton>
          <AppButton variant="primary" @click="submit">
            <AppIcon v-if="!isEdit" name="plus" :size="13" />
            {{ submitText }}
          </AppButton>
        </template>

        <!-- 弹窗：远端目录选择（WebDAV 目录的浏览入口） -->
        <RemoteDirModal
          v-if="showRemotePicker"
          :initial-path="remotePath"
          @pick="(p) => (remotePath = p)"
          @close="showRemotePicker = false"
        />
      </AppModal>
    </Transition>
  </Teleport>
</template>

<style scoped lang="scss">
.divider {
  height: 1px;
  background: var(--br-divider);
}

/* 高级设置折叠头：可点击整行展开 / 收起 */
.adv-header {
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;

  .adv-chev {
    color: var(--text-muted);
    transition: transform 0.15s;

    &.open {
      transform: rotate(90deg);
    }
  }
}

/* 高级设置展开 / 收起的高度过渡：
   时长写在这里供 Vue Transition 识别结束时机，高度值由 JS 钩子设定；
   用对称缓动保证弹窗受 max-height 截断时（小窗口）高度变化仍全程平滑可见；
   仅动画期间 overflow: hidden，动画结束即恢复，避免裁剪下拉浮层 */
.adv-enter-active,
.adv-leave-active {
  overflow: hidden;
  transition: height 0.28s cubic-bezier(0.33, 0, 0.2, 1);
}

/* 折叠头右侧徽标：目录使用了单独设置时提示（收起时也可见） */
.adv-badge {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-badge);
  font-size: 10px;
  font-weight: 500;
  color: var(--blue);
}
</style>
