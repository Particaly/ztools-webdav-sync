<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import RemoteDirModal from './RemoteDirModal.vue'
import { AppButton, AppInput, AppModal, AppSegmented, AppSelect, AppSwitch, InfoTip } from './ui'
import { useStore, suggestRemote } from '../composables/store'
import { concurrencyOptions, intervalOptions, strategyOptions } from '../composables/options'
import { toast } from '../composables/toast'
import type { DirOverrides, Prefs, SyncDir, SyncMode } from '../env.d'

/**
 * 同步目录「创建 / 修改」共用弹窗：传入 dir 为修改模式，不传为创建模式，仅标题不同。
 * 基础字段：本地目录 / WebDAV 目录 / 同步方式；「高级设置」默认收起，
 * 内含「单独设置这个文件夹」开关与全部可覆盖项（是否自动同步 / 检查频率 /
 * 冲突处理 / 忽略隐藏文件 / 并发传输数 / 请求频率限制 / 多设备互斥同步 /
 * 深度校验 / 排除规则）：未开启覆盖时各项只读展示全局当前值，开启后可单独
 * 编辑并随保存整体写入目录级覆盖（关闭覆盖 = 整体恢复跟随全局，不做逐字段回退）。
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

/** 目录级覆盖的合法键（overrideOn 判定与 initForm 取值共用） */
const OVERRIDE_KEYS = [
  'autoSync',
  'intervalMin',
  'conflictStrategy',
  'ignoreHidden',
  'concurrency',
  'ratePerSec',
  'leaseLock',
  'deepVerify',
  'excludePatterns',
] as const

const localPath = ref('')
const remotePath = ref('')
const mode = ref<SyncMode>('two-way')
/** 高级设置折叠区展开状态：默认收起 */
const advancedOpen = ref(false)
/** 「单独设置这个文件夹」开关：关闭时各项只读跟随全局，开启后可单独编辑 */
const overrideOn = ref(false)
// 打开时由 initForm 按覆盖值 ?? 全局当前值重设；此处初值仅占位
const autoSync = ref(true)
const conflictStrategy = ref<Prefs['conflictStrategy']>('ask')
const ignoreHidden = ref(true)
const intervalMin = ref(60)
const concurrency = ref(4)
/** 每秒请求上限（字符串形态承载「空 = 跟随全局」：空串保存时不写入该键） */
const ratePerSec = ref('')
const leaseLock = ref(true)
const deepVerify = ref(false)
/** 排除规则 textarea 逐行编辑（与设置页同口径：空行丢弃、上限 200 条） */
const excludeText = ref('')
const localError = ref('')
const remoteError = ref('')
const showRemotePicker = ref(false)

/** 全局生效的每秒请求上限（显式值；未设置显示空 —— 分层口径下档案默认仍可能生效） */
const globalRatePerSec = computed(() => {
  const v = store.state.server.netOpts?.ratePerSec
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
})

/** 每次打开时按当前模式初始化表单：创建取全局默认，修改取目录当前生效值（覆盖 ?? 全局） */
function initForm() {
  const o = props.dir?.overrides
  overrideOn.value =
    !!o && OVERRIDE_KEYS.some((k) => (o as Record<string, unknown>)[k] !== undefined)
  if (props.dir) {
    localPath.value = props.dir.localPath
    remotePath.value = props.dir.remotePath
    mode.value = props.dir.mode
  } else {
    localPath.value = ''
    remotePath.value = prefs.defaultRemoteDir
    mode.value = 'two-way'
  }
  // 各项展示值：有目录级覆盖取覆盖值，否则展示全局当前值（未开启覆盖时为只读预览）
  autoSync.value = (overrideOn.value ? o?.autoSync : undefined) ?? prefs.autoSync
  conflictStrategy.value = (overrideOn.value ? o?.conflictStrategy : undefined) ?? prefs.conflictStrategy
  ignoreHidden.value = (overrideOn.value ? o?.ignoreHidden : undefined) ?? prefs.ignoreHidden
  intervalMin.value = (overrideOn.value ? o?.intervalMin : undefined) ?? prefs.intervalMin
  concurrency.value = (overrideOn.value ? o?.concurrency : undefined) ?? prefs.concurrency
  const rateVal = (overrideOn.value ? o?.ratePerSec : undefined) ?? store.state.server.netOpts?.ratePerSec
  ratePerSec.value = typeof rateVal === 'number' && Number.isFinite(rateVal) ? String(rateVal) : ''
  leaseLock.value = (overrideOn.value ? o?.leaseLock : undefined) ?? prefs.leaseLock !== false
  deepVerify.value = (overrideOn.value ? o?.deepVerify : undefined) ?? prefs.deepVerify === true
  excludeText.value = ((overrideOn.value ? o?.excludePatterns : undefined) ?? prefs.excludePatterns ?? []).join('\n')
  advancedOpen.value = false
  localError.value = ''
}

// immediate：创建模式在 ?demo=add 场景下 open 挂载时即为 true，不会触发 watch，需要在初始化时跑一次
watch(open, (v) => v && initForm(), { immediate: true })

// ---------- 标题与文案 ----------

const title = computed(() => (isEdit.value ? '修改同步文件夹' : '添加同步文件夹'))
const subtitle = computed(() => (isEdit.value ? props.dir!.name : '让电脑上的文件夹和云端文件夹保持一致'))
const submitText = computed(() => (isEdit.value ? '保存修改' : '添加文件夹'))

const modeOptions = [
  { value: 'two-way', label: '双向同步', icon: 'swap' },
  { value: 'upload', label: '只上传', icon: 'upload' },
  { value: 'download', label: '只下载', icon: 'download' },
] satisfies { value: SyncMode; label: string; icon?: string }[]

const remoteHint = computed(() => {
  switch (mode.value) {
    case 'two-way':
      return '双向同步：电脑和云端任何一侧的改动都会同步到另一侧'
    case 'upload':
      return '只上传（备份到云端）：电脑上的改动会传到云端，云端的改动不会下载到电脑'
    case 'download':
      return '只下载：云端的改动会下载到电脑，电脑上的改动不会上传'
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

/** 排除规则 textarea → 数组（与设置页同口径：去首尾空白、空行丢弃、上限 200 条） */
function excludeLines(): string[] {
  return String(excludeText.value ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 200)
}

/**
 * 当前表单对应的目录级覆盖：未开启覆盖为 null（全部跟随全局）；开启时全部字段
 * 按当前值整体写入（关闭覆盖 = 恢复跟随全局，不做逐字段回退）。
 * 限速留空 = 不写入该键（跟随全局的分层口径：全局显式值 > 档案默认 > 不限制）。
 */
function currentOverrides(): DirOverrides | null {
  if (!overrideOn.value) return null
  const out: DirOverrides = {
    autoSync: autoSync.value,
    intervalMin: intervalMin.value,
    conflictStrategy: conflictStrategy.value,
    ignoreHidden: ignoreHidden.value,
    concurrency: concurrency.value,
    leaseLock: leaseLock.value,
    deepVerify: deepVerify.value,
    excludePatterns: excludeLines(),
  }
  const rateRaw = String(ratePerSec.value ?? '').trim()
  if (rateRaw !== '') {
    const n = Number(rateRaw)
    if (Number.isFinite(n) && n >= 0 && n <= 100) out.ratePerSec = n
  }
  return out
}

function close() {
  open.value = false
}

function submit() {
  const local = localPath.value.trim()
  if (!local) {
    localError.value = '请选择要同步的电脑文件夹'
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
      // 服务侧 message 已是人话（含既有同步名）；补一句规则说明与例子
      const rule = '同步文件夹之间不能互相包含（例如不能同时同步 D:\\A 和 D:\\A\\B）'
      if (overlap.side === 'local') localError.value = `${overlap.message}。${rule}`
      else remoteError.value = `${overlap.message}。${rule}`
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
  const picked = window.services?.fsx.pickDirectory('选择要同步的文件夹')
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
    toast.warning('请先填写服务器地址', '填写服务器地址后才能浏览云端文件夹')
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
          <!-- 电脑上的文件夹 -->
          <div class="flex flex-col gap-[6px]">
            <div class="flex items-center gap-[6px]">
              <span class="text-[12px] font-medium text-btn-text">电脑上的文件夹</span>
              <span class="text-danger font-medium">*</span>
            </div>
            <div class="flex gap-2">
              <AppInput
                v-model="localPath"
                icon="folder"
                mono
                class="flex-1 min-w-0"
                :invalid="!!localError"
                placeholder="选择或输入电脑上的文件夹路径"
                @update:model-value="localError = ''"
              />
              <AppButton @click="browse">浏览…</AppButton>
            </div>
            <div class="text-[11px]" :class="localError ? 'text-danger' : 'text-ink-4'">
              {{ localError || '这个文件夹里的文件改动会同步到云端' }}
            </div>
          </div>

          <!-- 云端文件夹 -->
          <div class="flex flex-col gap-[6px]">
            <span class="text-[12px] font-medium text-btn-text">云端文件夹</span>
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
                <!-- 「单独设置这个文件夹」开关：位于首行，说明同时涵盖开 / 关两种状态 -->
                <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                  <div class="flex items-center gap-[3px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">单独设置这个文件夹</span>
                    <InfoTip text="开启后，以下选项仅对此文件夹生效；关闭时全部跟随「设置」里的全局选项" />
                  </div>
                  <span class="flex-spacer" />
                  <AppSwitch v-model="overrideOn" />
                </div>
                <!-- 是否自动同步：目录级开关，关闭后只手动同步（不影响「暂停同步」的整体停用） -->
                <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                  <div class="flex items-center gap-[3px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">自动同步</span>
                    <InfoTip text="关闭后这个文件夹不再自动同步，只在点「立即同步」或菜单里的单向同步时执行" />
                  </div>
                  <span class="flex-spacer" />
                  <AppSwitch v-model="autoSync" :disabled="!overrideOn" />
                </div>
                <!-- 检查频率（同步频率）：自动同步的轮询间隔 -->
                <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                  <div class="flex items-center gap-[3px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">检查频率</span>
                    <InfoTip text="自动同步开启时，检查这个文件夹变更的时间间隔" />
                  </div>
                  <span class="flex-spacer" />
                  <AppSelect v-model="intervalMin" :options="intervalOptions" :width="104" :disabled="!overrideOn" />
                </div>
                <!-- 冲突处理 -->
                <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                  <div class="flex items-center gap-[3px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">冲突处理</span>
                    <InfoTip text="同一文件在本地与云端均被修改时的处理策略；「每次询问」会将冲突挂起，由你逐个确认" />
                  </div>
                  <span class="flex-spacer" />
                  <AppSelect v-model="conflictStrategy" :options="strategyOptions" :width="104" :disabled="!overrideOn" />
                </div>
                <!-- 忽略隐藏文件 -->
                <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                  <div class="flex items-center gap-[3px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">忽略隐藏文件</span>
                    <InfoTip text="路径中以 . 开头的隐藏文件与目录不参与同步" />
                  </div>
                  <span class="flex-spacer" />
                  <AppSwitch v-model="ignoreHidden" :disabled="!overrideOn" />
                </div>
                <!-- 并发传输数 -->
                <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                  <div class="flex items-center gap-[3px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">并发传输数</span>
                    <InfoTip text="同时上传 / 下载的文件数量上限；值越大同步越快，过高可能触发服务器限流" />
                  </div>
                  <span class="flex-spacer" />
                  <AppSelect v-model="concurrency" :options="concurrencyOptions" :width="104" :disabled="!overrideOn" />
                </div>
                <!-- 请求频率限制：留空 = 跟随全局（占位展示全局显式值）；0 = 明确不限速 -->
                <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                  <div class="flex items-center gap-[3px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">请求频率限制</span>
                    <InfoTip text="每秒向服务器发起的最大请求数；留空跟随全局设置，0 表示不限制" />
                  </div>
                  <span class="flex-spacer" />
                  <AppInput
                    v-model="ratePerSec"
                    sm
                    type="number"
                    class="rate-input !w-[104px]"
                    :disabled="!overrideOn"
                    :placeholder="globalRatePerSec || '0'"
                  />
                </div>
                <!-- 多设备互斥同步（目录租约锁） -->
                <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                  <div class="flex items-center gap-[3px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">多设备互斥同步</span>
                    <InfoTip text="每轮同步前先获取云端目录锁，同一时刻只允许一台设备同步，避免多设备并发写入互相覆盖；每次同步约增加 1~2 秒开销" />
                  </div>
                  <span class="flex-spacer" />
                  <AppSwitch v-model="leaseLock" :disabled="!overrideOn" />
                </div>
                <!-- 深度校验（默认关） -->
                <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                  <div class="flex items-center gap-[3px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">深度校验</span>
                    <InfoTip text="定期重新计算本地文件的内容校验值（hash）并与基线比对，可发现大小与修改时间均未变化的改动；文件较多时耗时与磁盘读取开销显著，默认关闭" />
                  </div>
                  <span class="flex-spacer" />
                  <AppSwitch v-model="deepVerify" :disabled="!overrideOn" />
                </div>
                <!-- 排除规则：逐行 glob；内置 OS 垃圾规则不可关闭 -->
                <div class="flex flex-col gap-[6px] pt-[4px] pb-[5px]">
                  <div class="flex items-center gap-[3px]">
                    <span class="text-[12px] font-medium text-ink-1">排除规则</span>
                    <InfoTip text="每行一条通配规则（glob），匹配的文件或目录不参与同步，如 *.iso、node_modules/；内置的系统临时文件规则始终生效" />
                  </div>
                  <textarea
                    v-model="excludeText"
                    rows="2"
                    spellcheck="false"
                    class="exclude-input font-mono"
                    :disabled="!overrideOn"
                    placeholder="每行一条，如 *.iso&#10;node_modules/"
                  />
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

/* 高级设置折叠头：可点击整行展开 / 收起，悬停给底色反馈 */
.adv-header {
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  padding: 4px 6px;
  margin: -4px -6px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s ease;

  &:hover {
    background: #f1f3f6;
  }

  .adv-chev {
    color: var(--text-muted);
    transition: transform 0.2s var(--ease-swift);

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

/* 请求频率限制输入：禁用（跟随全局）时整体置灰 —— AppInput 的 disabled 透传到
   内部 input，外层用 :has 感知后降透明度保持视觉一致 */
.rate-input {
  transition: opacity 0.15s ease;

  &:has(input:disabled) {
    opacity: 0.55;
  }
}

/* 排除规则 textarea：与 AppInput 小号形态同视觉（设计令牌同款），等宽字体便于编辑 glob */
.exclude-input {
  width: 100%;
  resize: vertical;
  min-height: 48px;
  padding: 6px 9px;
  border: 1px solid var(--br-input);
  border-radius: 7px;
  background: #fff;
  color: var(--text-1);
  font-size: 11px;
  line-height: 1.6;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;

  &::placeholder {
    color: var(--text-muted);
  }

  &:hover:not(:disabled) {
    border-color: #c9d0d7;
  }

  &:focus:not(:disabled) {
    border-color: var(--blue);
    box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.12);
  }

  &:disabled {
    cursor: default;
    background: var(--bg-track);
    color: var(--text-muted);
  }
}
</style>
