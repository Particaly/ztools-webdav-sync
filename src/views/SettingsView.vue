<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import RemoteDirModal from '../components/RemoteDirModal.vue'
import { AppButton, AppIconButton, AppInput, AppSelect, AppSwitch, InfoTip } from '../components/ui'
import { useStore, defaultPrefs, tierLabel, tierHint } from '../composables/store'
import { toast } from '../composables/toast'
import { intervalOptions, strategyOptions } from '../composables/options'
import { fmtBytes, fmtRelTime } from '../composables/format'

const store = useStore()
const s = store.state

const showDirPicker = ref(false)

const concurrencyOptions = [1, 2, 3, 4, 6, 8].map((n) => ({ value: n, label: `${n}` }))

const testResultText = computed(() => {
  if (!s.testResult) return ''
  if (s.testResult.ok) return `连接成功（响应 ${s.testResult.latencyMs ?? 0} 毫秒）`
  return s.testResult.error ? `连接失败：${s.testResult.error}` : '连接失败'
})

/**
 * 服务器检测结果（面向用户一句话）：运行良好 / 基本可用 / 仅可下载。
 * 技术明细（etag 强弱 / 条件请求 / mtime 精度 / 写权限 / 探测备注）收进结果旁的问号悬浮气泡。
 */
const capabilityText = computed(() => {
  const c = s.capabilities
  if (!c) return ''
  return `服务器检测结果：${tierLabel(c.tier)}`
})

/** 技术详情（结果旁问号悬浮展示，逐行）：能力档位与探测原始明细，供反馈问题时对照 */
const capabilityTechLines = computed<string[]>(() => {
  const c = s.capabilities
  if (!c) return []
  return [
    `能力档位：${tierLabel(c.tier)}`,
    `ETag：${c.etag.present ? (c.etag.weak ? '弱' : '强') : '无'}`,
    `条件请求：${c.conditional.ifMatch && c.conditional.ifNoneMatch ? '可用' : '不可用'}`,
    `mtime 精度：${c.mtimePrecision === 's' ? '秒级' : '毫秒级'}`,
    `写权限：${c.writable ? '可写' : '只读'}`,
    ...(c.notes ?? []).map((n) => `备注：${n}`),
  ]
})

/** 检测结论提示行（B/C 档）；技术原因折叠进悬浮 title */
const capabilityHintText = computed(() => {
  const c = s.capabilities
  if (!c || c.tier === 'A') return ''
  return tierHint(c.tier)
})

/** B / C 档技术原因 + 重探说明（悬浮 title 展示） */
const capabilityHintTitle = computed(() => {
  const c = s.capabilities
  if (!c || !c.writeReason) return ''
  return `${c.writeReason}${c.writeRetrySoon ? '，稍后会自动重新检测' : ''}`
})

const cloudUsageText = computed(() => {
  if (s.cloudUsage) return s.cloudUsage
  const bytes = store.cloudBytes.value
  return bytes > 0 ? fmtBytes(bytes) : '—'
})

const lastSyncText = computed(() => fmtRelTime(store.lastSyncAt.value))

/**
 * 用户排除规则：textarea 逐行编辑，落地回 prefs.excludePatterns。
 * 空行与首尾空白丢弃；上限 200 条（引擎侧同上限，超出部分静默不生效）。
 */
const excludeText = computed<string>({
  get: () => (s.prefs.excludePatterns ?? []).join('\n'),
  set: (v) => {
    const lines = String(v ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    s.prefs.excludePatterns = lines.slice(0, 200)
  },
})

/**
 * 已知服务器档案：按当前服务器地址匹配 preload 的档案表
 * （坚果云等有请求频率配额的服务）。命中且用户未显式配置限速时，引擎按档案
 * 默认限速 —— 这里只做提示展示；纯浏览器预览（无 preload）不提示。
 */
const serverProfile = computed(() => {
  try {
    return window.services?.dav?.serverProfile?.({ serverUrl: s.server.serverUrl }) ?? null
  } catch {
    return null
  }
})

/**
 * 每秒请求上限：空 = 未设置（回落档案默认或 0），0 = 明确
 * 不限速，>0 = 显式限速。写回 s.server.netOpts.ratePerSec（随 server 配置
 * 持久化；调度器 cfgOf 展开后引擎每请求经 resolveNetOpts 分层生效）。
 */
const ratePerSecInput = computed<string>({
  get: () => {
    const v = s.server.netOpts?.ratePerSec
    return typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
  },
  set: (val) => {
    const t = String(val ?? '').trim()
    if (t === '') {
      // 清空 = 回到「未设置」：移除显式键，档案默认（若有）重新生效；
      // undefined 键经 persist 的 JSON 往返被丢弃，内存态与落盘态一致
      if (s.server.netOpts) s.server.netOpts = { ...s.server.netOpts, ratePerSec: undefined }
      return
    }
    const n = Number(t)
    if (Number.isFinite(n) && n >= 0 && n <= 100) {
      s.server.netOpts = { ...s.server.netOpts, ratePerSec: n }
    }
  },
})

/** 限速输入占位与提示：档案命中时展示默认值，并说明覆盖语义 */
const ratePlaceholder = computed(() =>
  serverProfile.value ? `默认 ${serverProfile.value.netOpts.ratePerSec}` : '0',
)
const rateHint = computed(() => {
  const p = serverProfile.value
  if (!p) return ''
  return `已识别为${p.label}：该服务对请求频率有配额限制，已自动限速为每秒 ${p.netOpts.ratePerSec} 次请求；填 0 可解除`
})

/** 深度校验开关（prefs.deepVerify 可选布尔 → AppSwitch 必填 model 的适配） */
const deepVerifyModel = computed<boolean>({
  get: () => s.prefs.deepVerify === true,
  set: (v) => {
    s.prefs.deepVerify = v
  },
})

/** 打开远端目录选择器：未填服务器地址时直接提示，避免必然失败的请求 */
function browseDefaultDir() {
  if (!s.server.serverUrl.trim()) {
    toast.warning('请先填写服务器地址', '填写 WebDAV 地址后再浏览云端目录')
    return
  }
  showDirPicker.value = true
}

/**
 * 确认默认云端文件夹（设置页浏览入口）。
 * 写入 prefs.defaultRemoteDir（经 prefs 深度 watch 自动持久化）并关闭弹窗，
 * 以成功提示回显所选路径；与当前值相同（未发生修改）时只关闭弹窗，不提示。
 * @param path 远端目录选择器回传的绝对路径（以 / 开头；容错补齐缺省的起始斜杠）
 */
function confirmDefaultDir(path: string) {
  showDirPicker.value = false
  const p = String(path || '').trim()
  if (!p || p === s.prefs.defaultRemoteDir) return
  s.prefs.defaultRemoteDir = p.startsWith('/') ? p : '/' + p
  toast.success('默认云端文件夹已更新', p)
}

/**
 * 打开功能测试目录选择器（与默认云端文件夹的浏览入口同一形态）。
 * 确认选择由 confirmProbeDir 落地：持久化并自动以新目录执行一次功能测试；
 * 未填服务器地址时直接提示，避免必然失败的目录列表请求。
 */
function browseProbeDir() {
  if (!s.server.serverUrl.trim()) {
    toast.warning('请先填写服务器地址', '填写 WebDAV 地址后再选择测试目录')
    return
  }
  s.showProbeDirPicker = true
}

function restoreDefaults() {
  Object.assign(s.prefs, defaultPrefs())
}

function save() {
  store.persist()
  s.saved = true
  toast.success('设置已保存', '所有修改均已生效')
  setTimeout(() => {
    s.saved = false
  }, 1600)
}
</script>

<template>
  <div class="h-screen flex flex-col bg-white">
    <!-- 页头 -->
    <header class="flex items-center gap-3 h-14 px-5 border-b border-solid border-line-bar shrink-0">
      <AppIconButton title="返回" variant="ghost" :size="28" class="text-btn-text" @click="s.route = 'main'">
        <AppIcon name="chevron-left" :size="13" />
      </AppIconButton>
      <div class="flex flex-col gap-px">
        <div class="text-[14px] font-semibold text-ink-1 leading-[1.2]">设置</div>
        <div class="text-[11px] text-ink-3 leading-[1.2]">连接、同步与高级选项</div>
      </div>
      <span class="flex-spacer" />
      <!-- 测试结果（连接 / 能力检测）挂在设置栏右侧：正文只留操作与配置；
           过长时截断并以 title 提示全文 -->
      <span v-if="s.testResult" class="inline-flex min-w-0 max-w-full items-center gap-[5px] text-[11px] text-ink-2" :title="testResultText">
        <AppIcon v-if="s.testResult.ok" name="check-circle" :size="12" bg="var(--green-bg)" class="text-success shrink-0" />
        <AppIcon v-else name="warn" :size="12" class="text-warning-icon shrink-0" />
        <span class="truncate">{{ testResultText }}</span>
      </span>
      <span v-if="capabilityText" class="inline-flex min-w-0 max-w-full items-center gap-[5px] text-[11px] text-ink-2">
        <AppIcon name="check-circle" :size="12" bg="var(--green-bg)" class="text-success shrink-0" />
        <span class="truncate">{{ capabilityText }}</span>
        <InfoTip v-if="capabilityTechLines.length" text="">
          <div v-for="line in capabilityTechLines" :key="line">{{ line }}</div>
        </InfoTip>
      </span>
    </header>

    <!-- 内容：md（≥768px）以上双栏，窄窗口（插件小窗）收成单栏避免挤压 -->
    <main class="flex-1 min-h-0 overflow-y-auto px-4 py-3">
      <div class="flex flex-col md:flex-row gap-3 md:items-start">
        <!-- 左栏 -->
        <div class="flex-1 min-w-0 flex flex-col gap-3">
          <!-- WebDAV 卡片 -->
          <section class="card">
            <div class="card-head flex items-center gap-2 px-[14px] py-[8px]">
              <span class="card-title text-[12px] font-semibold text-ink-1">WebDAV</span>
              <span v-if="store.connStatus.value === 'connected'" class="inline-flex items-center gap-1 bg-success-bg rounded-[4px] pt-[2px] pr-[7px] pb-[2px] pl-[6px] text-[10px] font-medium text-success-deep">
                <span class="w-[5px] h-[5px] rounded-full bg-success-dot" />
                已连接
              </span>
            </div>
            <div class="flex flex-col gap-[10px] px-[14px] py-[11px]">
              <div class="flex flex-col gap-[6px]">
                <span class="text-[11px] font-medium text-ink-2">服务器地址</span>
                <AppInput
                  v-model="s.server.serverUrl"
                  icon="globe"
                  mono
                  sm
                  placeholder="https://dav.example.com/remote.php/dav/files/user/"
                />
                <!-- http 明文连接警告：内网回环地址不打扰 -->
                <div v-if="store.insecureHttp.value" class="flex items-start gap-[5px]">
                  <AppIcon name="warn" :size="11" class="text-warning-icon shrink-0 mt-[2px]" />
                  <span class="text-[11px] text-warning-icon leading-[1.5]">当前地址使用 http 明文传输，账号密码与文件内容均未加密，存在被截取的风险，建议改用 https</span>
                </div>
              </div>
              <div class="flex gap-[10px]">
                <div class="flex-1 min-w-0 flex flex-col gap-[6px]">
                  <span class="text-[11px] font-medium text-ink-2">用户名</span>
                  <AppInput v-model="s.server.username" icon="user" sm placeholder="用户名" />
                </div>
                <div class="flex-1 min-w-0 flex flex-col gap-[6px]">
                  <span class="text-[11px] font-medium text-ink-2">密码</span>
                  <AppInput v-model="s.server.password" icon="lock" type="password" sm placeholder="应用密码" />
                </div>
              </div>
              <div class="flex flex-col gap-[6px]">
                <div class="flex items-center gap-[3px]">
                  <span class="text-[11px] font-medium text-ink-2">默认云端文件夹</span>
                  <InfoTip text="添加同步目录时自动填入的云端位置；留空则以本地文件夹名作为云端目录名" />
                </div>
                <div class="flex gap-2">
                  <AppInput
                    v-model="s.prefs.defaultRemoteDir"
                    icon="cloud"
                    mono
                    sm
                    class="flex-1 min-w-0"
                    placeholder="/Sync"
                  />
                  <AppButton @click="browseDefaultDir">浏览…</AppButton>
                </div>
              </div>
              <!-- 测试目录：功能测试写权限的实测目标（服务器各子树写权限可能不同，
                   根目录不一定可写），形态与默认云端文件夹一致；留空时首次点击
                   「功能测试」会先弹目录选择器 -->
              <div class="flex flex-col gap-[6px]">
                <div class="flex items-center gap-[3px]">
                  <span class="text-[11px] font-medium text-ink-2">测试目录</span>
                  <InfoTip text="功能测试会在该文件夹内实际创建并删除一个临时文件夹来检测服务器能力；WebDAV 服务器不一定所有目录都允许写入，请选择一个可写的文件夹" />
                </div>
                <div class="flex gap-2">
                  <AppInput
                    v-model="s.prefs.probeRemoteDir"
                    icon="cloud"
                    mono
                    sm
                    class="flex-1 min-w-0"
                    placeholder="/Sync"
                  />
                  <AppButton @click="browseProbeDir">浏览…</AppButton>
                </div>
              </div>
              <!-- 操作行：两个测试入口右对齐，结果统一在卡片标题右侧展示 -->
              <div class="flex items-center justify-end gap-[10px]">
                <AppButton variant="primary" :disabled="s.testing" @click="store.testConnection()">
                  <AppIcon name="refresh" :size="13" :class="{ spin: s.testing }" />
                  {{ s.testing ? '测试中…' : '测试连接' }}
                </AppButton>
                <AppButton :disabled="s.probing || !s.server.serverUrl.trim()" @click="store.reprobe()">
                  <AppIcon name="refresh" :size="13" :class="{ spin: s.probing }" />
                  {{ s.probing ? '测试中…' : '功能测试' }}
                </AppButton>
              </div>
              <div v-if="capabilityHintText" class="text-[11px] text-warning-icon" :title="capabilityHintTitle">
                {{ capabilityHintText }}
              </div>
            </div>
          </section>

          <!-- 同步卡片 -->
          <section class="card">
            <div class="card-head flex items-center gap-2 px-[14px] py-[8px]">
              <span class="card-title text-[12px] font-semibold text-ink-1">同步</span>
            </div>
            <div class="flex flex-col gap-[10px] px-[14px] py-[11px]">
              <div class="pref-row flex items-center gap-3">
                <div class="flex items-center gap-[3px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">自动同步</span>
                  <InfoTip text="本地或云端文件发生变更时自动执行同步，无需手动触发" />
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="s.prefs.autoSync" />
              </div>
              <div class="pref-row flex items-center gap-3">
                <div class="flex items-center gap-[3px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">检查频率</span>
                  <InfoTip text="轮询检查云端变更的时间间隔" />
                </div>
                <span class="flex-spacer" />
                <AppSelect v-model="s.prefs.intervalMin" :options="intervalOptions" :width="104" />
              </div>
              <div class="pref-row flex items-center gap-3">
                <div class="flex items-center gap-[3px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">启动时自动同步</span>
                  <InfoTip text="启动 ZTools 时先检查一次云端变更" />
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="s.prefs.syncOnStartup" />
              </div>
            </div>
          </section>
        </div>

        <!-- 右栏 -->
        <div class="flex-1 min-w-0 flex flex-col gap-3">
          <!-- 高级卡片 -->
          <section class="card">
            <div class="card-head flex items-center gap-2 px-[14px] py-[8px]">
              <span class="card-title text-[12px] font-semibold text-ink-1">高级</span>
            </div>
            <div class="flex flex-col gap-[10px] px-[14px] py-[11px]">
              <div class="pref-row flex items-center gap-3">
                <div class="flex items-center gap-[3px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">冲突处理</span>
                  <InfoTip text="同一文件在本地与云端均被修改时的处理策略；「每次询问」会将冲突挂起，由你逐个确认" />
                </div>
                <span class="flex-spacer" />
                <AppSelect v-model="s.prefs.conflictStrategy" :options="strategyOptions" :width="104" />
              </div>
              <div class="pref-row flex items-center gap-3">
                <div class="flex items-center gap-[3px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">忽略隐藏文件</span>
                  <InfoTip text="路径中以 . 开头的隐藏文件与目录不参与同步" />
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="s.prefs.ignoreHidden" />
              </div>
              <div class="pref-row flex items-center gap-3">
                <div class="flex items-center gap-[3px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">并发传输数</span>
                  <InfoTip text="同时上传 / 下载的文件数量上限；值越大同步越快，过高可能触发服务器限流" />
                </div>
                <span class="flex-spacer" />
                <AppSelect v-model="s.prefs.concurrency" :options="concurrencyOptions" :width="104" />
              </div>
              <!-- 请求限速：server.netOpts.ratePerSec；档案命中时给出默认值提示 -->
              <div class="pref-row flex items-center gap-3">
                <div class="flex items-center gap-[3px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">请求频率限制</span>
                  <InfoTip text="每秒向服务器发起的最大请求数，0 表示不限制；检测到坚果云等有频率配额的服务时会自动应用默认限速" />
                </div>
                <span class="flex-spacer" />
                <AppInput v-model="ratePerSecInput" sm type="number" class="!w-[104px]" :placeholder="ratePlaceholder" />
              </div>
              <div v-if="rateHint" class="flex items-start gap-[5px]">
                <AppIcon name="info" :size="11" class="text-ink-4 shrink-0 mt-[2px]" />
                <span class="text-[11px] text-ink-4 leading-[1.5]">{{ rateHint }}</span>
              </div>
              <!-- 防多设备同时同步（目录租约锁）：说明细节收进气泡 -->
              <div class="pref-row flex items-center gap-3">
                <div class="flex items-center gap-[3px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">多设备互斥同步</span>
                  <InfoTip text="每轮同步前先获取远端目录租约锁，同一时刻仅允许一台设备执行同步，避免多设备并发写入互相覆盖；每次同步约增加 1~2 秒开销" />
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="s.prefs.leaseLock" />
              </div>
              <!-- 深度校验：定期重算 hash 比对基线（默认关） -->
              <div class="pref-row flex items-center gap-3">
                <div class="flex items-center gap-[3px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">深度校验</span>
                  <InfoTip text="定期重新计算本地文件的内容校验值（hash）并与基线比对，可发现大小与修改时间均未变化的改动；文件较多时耗时与磁盘读取开销显著，默认关闭" />
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="deepVerifyModel" />
              </div>
              <!-- 用户排除规则：逐行 glob；内置 OS 垃圾规则不可关闭 -->
              <div class="flex flex-col gap-[6px]">
                <div class="flex items-center gap-[3px]">
                  <span class="text-[12px] font-medium text-ink-1">排除规则</span>
                  <InfoTip text="每行一条通配规则（glob），匹配的文件或目录不参与同步，如 *.iso、node_modules/；内置的系统临时文件规则始终生效" />
                </div>
                <textarea
                  v-model="excludeText"
                  rows="3"
                  spellcheck="false"
                  class="exclude-input font-mono"
                  placeholder="每行一条，如 *.iso&#10;node_modules/"
                />
              </div>
            </div>
          </section>

          <!-- 同步状态卡片 -->
          <section class="card">
            <div class="card-head flex items-center gap-2 px-[14px] py-[8px]">
              <span class="card-title text-[12px] font-semibold text-ink-1">同步状态</span>
            </div>
            <div class="px-[14px] py-[10px]">
              <div class="flex items-center justify-between py-[4px]">
                <span class="text-[11px] text-ink-2">同步文件夹</span>
                <span class="font-mono text-[11px] font-medium text-ink-1">{{ s.dirs.length }} 个</span>
              </div>
              <div class="flex items-center justify-between py-[4px]">
                <span class="text-[11px] text-ink-2">上次同步</span>
                <span class="font-mono text-[11px] font-medium text-ink-1">{{ lastSyncText }}</span>
              </div>
              <div class="flex items-center justify-between py-[4px]">
                <span class="text-[11px] text-ink-2">云端占用</span>
                <span class="font-mono text-[11px] font-medium text-ink-1">{{ cloudUsageText }}</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>

    <!-- 底部操作 -->
    <footer class="flex items-center gap-[10px] h-[52px] px-5 bg-fill-bar border-t border-solid border-line-bar shrink-0">
      <AppIcon name="info" :size="13" class="text-ink-4" />
      <span class="text-[11px] text-ink-2">{{ s.saved ? '设置已保存' : '设置修改后立即生效' }}</span>
      <span class="flex-spacer" />
      <AppButton @click="restoreDefaults">恢复默认</AppButton>
      <AppButton variant="primary" strong pad="0 14px" @click="save">保存设置</AppButton>
    </footer>

    <!-- 弹窗：远端目录选择（默认 WebDAV 目录的浏览入口） -->
    <Transition name="modal-pop">
      <RemoteDirModal
        v-if="showDirPicker"
        title="选择默认云端文件夹"
        :initial-path="s.prefs.defaultRemoteDir"
        @pick="confirmDefaultDir"
        @close="showDirPicker = false"
      />
    </Transition>

    <!-- 弹窗：功能测试目录选择（首次功能测试的引导 + 「修改测试目录」入口共用；
         确认后由 confirmProbeDir 持久化并自动以新目录执行一次功能测试） -->
    <Transition name="modal-pop">
      <RemoteDirModal
        v-if="s.showProbeDirPicker"
        title="选择功能测试目录"
        subtitle="功能测试会在所选文件夹内创建并删除临时文件来检测服务器能力，请选择一个允许写入的文件夹"
        :initial-path="s.prefs.probeRemoteDir"
        @pick="store.confirmProbeDir"
        @close="s.showProbeDirPicker = false"
      />
    </Transition>
  </div>
</template>

<style scoped lang="scss">
/* 卡片节标题：字距微调，与正文行标题拉开质感差 */
.card-title {
  letter-spacing: 0.02em;
}

/* 卡片节标题底部 ⇒ 分隔线：必须用单边 border（Uno 的 border-solid 会把未设宽度的其余三边按 medium 宽度画出） */
.card-head {
  border-bottom: 1px solid var(--br-bar);
}

/* 排除规则 textarea：与 AppInput 小号形态同视觉（设计令牌），等宽字体便于编辑 glob */
.exclude-input {
  width: 100%;
  resize: vertical;
  min-height: 56px;
  padding: 6px 9px;
  border: 1px solid var(--br-input);
  border-radius: 7px;
  background: #fff;
  color: var(--text-1);
  font-size: 11px;
  line-height: 1.6;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;

  &::placeholder {
    color: var(--text-muted);
  }

  &:hover {
    border-color: #c9d0d7;
  }

  &:focus {
    border-color: var(--blue);
    box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.12);
  }
}
</style>
