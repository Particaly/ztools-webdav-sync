<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import RemoteDirModal from '../components/RemoteDirModal.vue'
import { AppButton, AppIconButton, AppInput, AppSelect, AppSwitch, InfoTip } from '../components/ui'
import { useStore, defaultPrefs, tierLabel, tierHint, serverLabel } from '../composables/store'
import type { DavServerEntry, ZtoolsPluginsSyncDesc } from '../env.d'
import { toast } from '../composables/toast'
import { intervalOptions, strategyOptions, concurrencyOptions } from '../composables/options'
import { fmtBytes, fmtRelTime } from '../composables/format'

const store = useStore()
const s = store.state

const showDirPicker = ref(false)

// ---------- 服务器列表（多账号 / 多服务器） ----------

/** 服务器下拉选项（展示名 = 显式名称 > 地址 host > 序号） */
const serverOptions = computed(() => s.servers.map((sv: DavServerEntry, i: number) => ({ value: sv.id, label: serverLabel(sv, i) })))

/** 活跃服务器（下拉切换：连接指示按新服务器归零，目录的 serverId 不受影响） */
const activeServerModel = computed<string>({
  get: () => s.activeServerId,
  set: (v) => store.setActiveServer(v),
})

/** 添加服务器：空白条目入列并切换为活跃（立即开始填写） */
function addServer() {
  store.addServer()
  toast.info('已添加服务器', '填写地址与账号后点「测试连接」验证')
}

/**
 * 删除当前服务器：最后一台不可删（改为提示清空）；仍有同步目录使用时明确
 * 拒绝 —— 静默把这些目录改连另一台服务器是危险操作（远端路径不存在会触发
 * 「云端文件夹丢失」保护）。删除的只是配置，不动电脑与云端文件。
 */
function removeActiveServer() {
  store.removeServer(s.activeServerId)
}

/**
 * 明文 http 警告的显隐：地址是明文 http 且未被当前地址关闭过。关闭（不再显示）
 * 记录的是关闭时的服务器地址（prefs.insecureHttpDismissedFor，与主界面服务器
 * 卡片同一条警告共用标记），之后换成另一个 http 地址会重新提示。
 */
const insecureHttpVisible = computed(
  () => store.insecureHttp.value && s.server.serverUrl !== (s.prefs.insecureHttpDismissedFor ?? '')
)

/** 关闭明文 http 警告（不再显示）：记录当前服务器地址作为情境指纹 */
function dismissInsecureHttp() {
  s.prefs.insecureHttpDismissedFor = s.server.serverUrl
}

// ---------- 证书信任（自签名 NAS 的 https 连接通道） ----------

/** 服务器地址是 https 连接：证书信任设置只对加密连接有意义（http 无证书可谈） */
const isHttps = computed(() => /^https:\/\//i.test(s.server.serverUrl.trim()))

/** 「信任此服务器证书」开关（server.tls.trustServerCertificate → AppSwitch 必填 model） */
const trustCertModel = computed<boolean>({
  get: () => s.server.tls?.trustServerCertificate === true,
  set: (v) => {
    s.server.tls = { ...s.server.tls, trustServerCertificate: v }
  },
})

/** 是否已导入 CA 证书（server.tls.caPem 非空即视为已导入） */
const caImported = computed(() => !!s.server.tls?.caPem?.trim())

/**
 * 导入 CA 证书：文件选择器（.pem / .crt 等文本格式）→ preload 读取（256KB 上限）
 * → 简单校验含 PEM 证书段后写入 server.tls.caPem。导入后按「系统信任的 CA +
 * 导入的 CA」一并校验服务器证书 —— 校验照常进行，只是多了自建根，比信任开关安全。
 */
async function importCa() {
  let picked: string | null = null
  try {
    const r = window.ztools?.showOpenDialog?.({ title: '选择 CA 证书文件（PEM 格式）', properties: ['openFile'] })
    picked = Array.isArray(r) && r.length > 0 ? r[0] : null
  } catch {
    picked = null
  }
  if (!picked) return
  let text: string | null = null
  try {
    text = (await window.services?.fsx?.readTextFile?.(picked)) ?? null
  } catch {
    text = null
  }
  if (!text || !/BEGIN CERTIFICATE/.test(text)) {
    toast.error('导入失败', '无法读取证书内容：请选择 PEM 格式（.pem / .crt）的证书文件')
    return
  }
  s.server.tls = { ...s.server.tls, caPem: text.trim() }
  toast.success('CA 证书已导入', '之后会连同系统证书一起校验服务器证书')
}

/** 移除已导入的 CA 证书（回到仅系统信任的默认校验） */
function removeCa() {
  const { caPem: _dropped, ...rest } = s.server.tls ?? {}
  s.server.tls = rest
}

/** 插件同步云端文件夹选择器显隐（实验卡片区「浏览…」入口） */
const showPluginDirPicker = ref(false)

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

/**
 * 档位结论提示行的显隐：有 B/C 档结论且未被当前档位关闭过。关闭（不再显示）
 * 记录的是关闭时的档位（prefs.tierHintDismissed），档位变化（服务器变更 /
 * 重新检测出不同结论）后重新提示。
 */
const capabilityHintVisible = computed(() => !!capabilityHintText.value && (s.prefs.tierHintDismissed ?? '') !== s.capabilities?.tier)

/** B / C 档技术原因 + 重探说明（悬浮 title 展示） */
const capabilityHintTitle = computed(() => {
  const c = s.capabilities
  if (!c || !c.writeReason) return ''
  return `${c.writeReason}${c.writeRetrySoon ? '，稍后会自动重新检测' : ''}`
})

/** 云端占用展示：由各目录最近扫描字节（Σ lastBytesTotal）派生，无数据时占位「—」 */
const cloudUsageText = computed(() => {
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

/**
 * 上传带宽上限（KB/s）：空 / 0 = 不限制。写回当前服务器 netOpts.uploadKBps
 *（同一服务器的全部上传共享该总额；跨服务器互不影响）。
 */
const uploadKBpsInput = computed<string>({
  get: () => {
    const v = s.server.netOpts?.uploadKBps
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? String(v) : ''
  },
  set: (val) => {
    const t = String(val ?? '').trim()
    const n = Number(t)
    const apply = (v: number | undefined) => {
      s.server.netOpts = { ...s.server.netOpts, uploadKBps: v }
    }
    if (t === '' || !Number.isFinite(n) || n <= 0) apply(undefined)
    else apply(Math.min(10_000_000, Math.floor(n)))
  },
})

/** 下载带宽上限（KB/s）：口径同 uploadKBps，方向为下载 */
const downloadKBpsInput = computed<string>({
  get: () => {
    const v = s.server.netOpts?.downloadKBps
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? String(v) : ''
  },
  set: (val) => {
    const t = String(val ?? '').trim()
    const n = Number(t)
    const apply = (v: number | undefined) => {
      s.server.netOpts = { ...s.server.netOpts, downloadKBps: v }
    }
    if (t === '' || !Number.isFinite(n) || n <= 0) apply(undefined)
    else apply(Math.min(10_000_000, Math.floor(n)))
  },
})

/** HTTP 代理地址：写回当前服务器 netOpts.proxyUrl（留空 = 直连） */
const proxyUrlInput = computed<string>({
  get: () => s.server.netOpts?.proxyUrl ?? '',
  set: (val) => {
    s.server.netOpts = { ...s.server.netOpts, proxyUrl: String(val ?? '').trim() }
  },
})

/** 代理地址形态校验：非空且不是 http(s):// 开头时提示（引擎对非法地址按直连处理） */
const proxyInvalid = computed(() => {
  const v = proxyUrlInput.value.trim()
  return v !== '' && !/^https?:\/\/\S+$/i.test(v)
})

/** 深度校验开关（prefs.deepVerify 可选布尔 → AppSwitch 必填 model 的适配） */
const deepVerifyModel = computed<boolean>({
  get: () => s.prefs.deepVerify === true,
  set: (v) => {
    s.prefs.deepVerify = v
  },
})

/**
 * 【实验：ZTools 插件同步】开关（prefs.ztoolsPluginSync 可选布尔 → AppSwitch
 * 必填 model 的适配）。开启后同步列表出现自动发现的虚拟行（store.refreshPluginSyncRow
 * 经 prefs watch 维护），调度器侧按同一开关合成 slot；开启瞬间不触发同步，
 * 首轮由调度器排到下一个自动同步时间点。
 */
const pluginSyncModel = computed<boolean>({
  get: () => s.prefs.ztoolsPluginSync === true,
  set: (v) => {
    s.prefs.ztoolsPluginSync = v
  },
})

/**
 * 插件同步的自动发现结果（preload describe：本机目录 / 平台隔离的远端目录）。
 * describe 内部有磁盘 IO（fs.statSync），不能放进 computed 里随渲染同步重跑 ——
 * 改为 ref 存结果：挂载时先拉一次，云端父目录（ztoolsPluginSyncRemoteDir，
 * base 来源）变化时再拉；无 preload（浏览器预览）或 describe 不存在时为 null，
 * 开关下方信息行不显示（与原回退一致）。
 */
const pluginSyncDesc = ref<ZtoolsPluginsSyncDesc | null>(null)

/** 拉取自动发现结果：base 取当前父目录；任何异常按无结果处理，不打断设置页 */
function refreshPluginSyncDesc() {
  const base = s.prefs.ztoolsPluginSyncRemoteDir || ''
  try {
    pluginSyncDesc.value = window.services?.ztoolsPlugins?.describe?.(base) ?? null
  } catch {
    pluginSyncDesc.value = null
  }
}

onMounted(refreshPluginSyncDesc)
watch(
  () => s.prefs.ztoolsPluginSyncRemoteDir,
  () => {
    refreshPluginSyncDesc()
  }
)

/** 开关下方的说明文案（两行展示）：本机插件目录、平台隔离的云端目录（含所选父目录） */
const pluginSyncDescLines = computed(() => {
  const d = pluginSyncDesc.value
  if (!d) return null
  return {
    local: `本机插件目录 ${d.pluginsDir}`,
    cloud: `云端 ${d.remotePath}（${d.platformKey} 平台专用）`,
  }
})

/** 打开插件同步的云端文件夹选择器（与默认云端文件夹同一形态） */
function browsePluginSyncDir() {
  if (!s.server.serverUrl.trim()) {
    toast.warning('请先填写服务器地址', '填写 WebDAV 地址后再选择云端文件夹')
    return
  }
  showPluginDirPicker.value = true
}

/**
 * 确认插件同步的云端文件夹：写入 prefs.ztoolsPluginSyncRemoteDir（经 prefs
 * 深度 watch 自动持久化，调度器 reload 后按同一父目录合成远端根）。最终同步
 * 根 = 所选目录之后固定跟上 ztools-plugins/<平台>；清空输入即恢复默认云端根。
 * 更换位置后旧云端内容不迁移不删除，首轮同步会把本机插件重新上传到新位置。
 * @param path 远端目录选择器回传的绝对路径（以 / 开头；容错补齐缺省的起始斜杠）
 */
function confirmPluginSyncDir(path: string) {
  showPluginDirPicker.value = false
  const p = String(path || '').trim().replace(/\/+$/, '')
  const next = p ? (p.startsWith('/') ? p : '/' + p) : ''
  if (next === (s.prefs.ztoolsPluginSyncRemoteDir ?? '')) return
  s.prefs.ztoolsPluginSyncRemoteDir = next
  toast.success(
    '插件云端文件夹已更新',
    next ? `插件将同步到 ${next}/ztools-plugins 下的平台子文件夹；旧位置的内容不会自动迁移` : '已恢复默认位置（云端的 ztools-plugins 文件夹）'
  )
}

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
              <!-- 服务器列表（多账号 / 多服务器）：下方全部字段编辑当前选中的服务器；
                   各同步文件夹在添加时记住使用的服务器，切换选中只影响这里的编辑视图 -->
              <div class="flex flex-col gap-[6px]">
                <div class="flex items-center gap-[3px]">
                  <span class="text-[11px] font-medium text-ink-2">服务器</span>
                  <InfoTip text="可以添加多台 WebDAV 服务器（如坚果云 + 家用 NAS）：每个同步文件夹使用添加时选定的服务器，凭据与设置互不影响" />
                </div>
                <div class="flex gap-2 items-center">
                  <AppSelect
                    v-if="s.servers.length > 1"
                    v-model="activeServerModel"
                    :options="serverOptions"
                    class="flex-1 min-w-0"
                  />
                  <span v-else class="flex-1 min-w-0 truncate text-[12px] text-ink-1">{{ serverOptions[0]?.label || '未命名' }}</span>
                  <AppButton :disabled="s.servers.length <= 1" title="删除当前服务器" @click="removeActiveServer">删除</AppButton>
                  <AppButton variant="primary" @click="addServer">添加</AppButton>
                </div>
              </div>
              <div class="flex flex-col gap-[6px]">
                <span class="text-[11px] font-medium text-ink-2">服务器地址</span>
                <AppInput
                  v-model="s.server.serverUrl"
                  icon="globe"
                  mono
                  sm
                  placeholder="https://dav.example.com/remote.php/dav/files/user/"
                />
                <!-- http 明文连接警告：内网回环地址不打扰；关闭（不再显示）记录当时
                     的服务器地址（与主界面服务器卡片同一条警告共用标记） -->
                <div v-if="insecureHttpVisible" class="flex items-start gap-[5px]">
                  <AppIcon name="warn" :size="11" class="text-warning-icon shrink-0 mt-[2px]" />
                  <span class="flex-1 min-w-0 text-[11px] text-warning-icon leading-[1.5]">当前地址使用 http 明文传输，账号密码与文件内容均未加密，存在被截取的风险，建议改用 https</span>
                  <AppIconButton :size="18" variant="ghost" title="不再显示" class="shrink-0 text-ink-3 -mt-[2px]" @click="dismissInsecureHttp">
                    <AppIcon name="close" :size="10" />
                  </AppIconButton>
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
              <!-- 证书信任（仅 https 地址显示）：自签名证书 NAS（群晖 / QNAP 等）的连接
                   通道。信任开关 = 跳过校验（附安全提示）；CA 导入 = 追加信任自建根（校验照常） -->
              <div v-if="isHttps" class="flex flex-col gap-[6px]">
                <div class="pref-row flex items-center gap-3">
                  <div class="flex items-center gap-[3px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">信任此服务器证书</span>
                    <InfoTip text="服务器使用自签名证书（群晖、QNAP 等 NAS 常见）导致无法连接时可打开。打开后连接不再校验证书真伪，仅建议用于自己可控的服务器" />
                  </div>
                  <span class="flex-spacer" />
                  <AppSwitch v-model="trustCertModel" />
                </div>
                <div v-if="trustCertModel" class="flex items-start gap-[5px]">
                  <AppIcon name="warn" :size="11" class="text-warning-icon shrink-0 mt-[2px]" />
                  <span class="flex-1 min-w-0 text-[11px] text-warning-icon leading-[1.5]">已开启信任：连接不再校验服务器证书。若网络中有人假冒服务器，账号密码与文件内容可能被窃取，请仅在可控网络中使用</span>
                </div>
                <div class="pref-row flex items-center gap-3">
                  <div class="flex items-center gap-[3px] min-w-0">
                    <span class="text-[12px] font-medium text-ink-1">CA 证书</span>
                    <InfoTip text="自建 CA 签发证书的服务器可导入 CA 根证书（PEM 格式）：照常完整校验证书链，比「信任此服务器证书」更安全" />
                  </div>
                  <span class="flex-spacer" />
                  <template v-if="caImported">
                    <span class="text-[11px] font-medium text-success-deep shrink-0">已导入</span>
                    <AppButton @click="removeCa">移除</AppButton>
                  </template>
                  <AppButton v-else @click="importCa">导入…</AppButton>
                </div>
              </div>
              <!-- 带宽限速与代理（当前服务器的网络层配置）：限速限的是这台服务器的
                   传输总量（上传 / 下载各自独立）；代理用于公司内网等直连不可达的场景 -->
              <div class="flex gap-[10px]">
                <div class="flex-1 min-w-0 flex flex-col gap-[6px]">
                  <div class="flex items-center gap-[3px]">
                    <span class="text-[11px] font-medium text-ink-2">上传限速</span>
                    <InfoTip text="上传到这台服务器的总带宽上限（KB/s），同一服务器的多个文件夹共享该额度；留空或 0 表示不限制" />
                  </div>
                  <AppInput v-model="uploadKBpsInput" sm type="number" placeholder="不限" />
                </div>
                <div class="flex-1 min-w-0 flex flex-col gap-[6px]">
                  <div class="flex items-center gap-[3px]">
                    <span class="text-[11px] font-medium text-ink-2">下载限速</span>
                    <InfoTip text="从这台服务器下载的总带宽上限（KB/s），口径同上传限速" />
                  </div>
                  <AppInput v-model="downloadKBpsInput" sm type="number" placeholder="不限" />
                </div>
              </div>
              <div class="flex flex-col gap-[6px]">
                <div class="flex items-center gap-[3px]">
                  <span class="text-[11px] font-medium text-ink-2">代理服务器</span>
                  <InfoTip text="公司内网等无法直连云端时可填 HTTP 代理（如 http://127.0.0.1:7890，可带 user:pass@ 认证）；https 连接经隧道端到端加密，代理看不到内容；留空 = 直连" />
                </div>
                <AppInput v-model="proxyUrlInput" icon="globe" mono sm placeholder="留空 = 直连" />
                <div v-if="proxyInvalid" class="flex items-start gap-[5px]">
                  <AppIcon name="warn" :size="11" class="text-warning-icon shrink-0 mt-[2px]" />
                  <span class="flex-1 min-w-0 text-[11px] text-warning-icon leading-[1.5]">代理地址需以 http:// 或 https:// 开头，当前填写不会被使用</span>
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
              <!-- 档位结论提示行（B/C 档说明）：关闭（不再显示）后同档位不再出现，
                   档位变化（服务器变更 / 重新检测）后重新提示 -->
              <div v-if="capabilityHintVisible" class="flex items-start gap-[5px]" :title="capabilityHintTitle">
                <span class="flex-1 min-w-0 text-[11px] text-warning-icon leading-[1.5]">{{ capabilityHintText }}</span>
                <AppIconButton :size="18" variant="ghost" title="不再显示" class="shrink-0 text-ink-3 -mt-[2px]" @click="s.prefs.tierHintDismissed = s.capabilities?.tier || ''">
                  <AppIcon name="close" :size="10" />
                </AppIconButton>
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

          <!-- 实验卡片：ZTools 插件同步（默认关） -->
          <section class="card">
            <div class="card-head flex items-center gap-2 px-[14px] py-[8px]">
              <span class="card-title text-[12px] font-semibold text-ink-1">实验</span>
            </div>
            <div class="flex flex-col gap-[10px] px-[14px] py-[11px]">
              <div class="pref-row flex items-center gap-3">
                <div class="flex items-center gap-[3px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">ZTools 插件同步</span>
                  <InfoTip text="实验功能：把本机 ZTools 的插件同步到云端，换机或重装后可找回。电脑上的插件文件夹由 ZTools 自动发现，不能修改；云端按操作系统分文件夹存放（互不相通），避免不同系统的设备互相同步不兼容的插件。开启后不会立刻同步，会在下一个自动同步时间点执行" />
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="pluginSyncModel" />
              </div>
              <!-- 云端存储位置：最终同步根 = 所选目录之后固定跟上 ztools-plugins/<平台>；
                   留空 = 默认云端根。多台设备须选择同一个文件夹才能互通 -->
              <div v-if="pluginSyncModel" class="flex flex-col gap-[6px]">
                <div class="flex items-center gap-[3px]">
                  <span class="text-[12px] font-medium text-ink-1">云端文件夹</span>
                  <InfoTip text="插件会存到所选文件夹下的 ztools-plugins 子文件夹（其中再按操作系统分文件夹）；多台设备请选择同一个文件夹。留空时默认放在云端的 ztools-plugins 文件夹；更换位置后旧云端内容不会自动迁移" />
                </div>
                <div class="flex gap-2">
                  <AppInput
                    v-model="s.prefs.ztoolsPluginSyncRemoteDir"
                    icon="cloud"
                    mono
                    sm
                    class="flex-1 min-w-0"
                    placeholder="默认（/ztools-plugins）"
                  />
                  <AppButton @click="browsePluginSyncDir">浏览…</AppButton>
                </div>
              </div>
              <div v-if="pluginSyncModel && pluginSyncDescLines" class="flex items-start gap-[5px]">
                <AppIcon name="info" :size="11" class="text-ink-4 shrink-0 mt-[2px]" />
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[11px] text-ink-4 leading-[1.5] break-words" :title="pluginSyncDescLines.local">{{ pluginSyncDescLines.local }}</span>
                  <span class="text-[11px] text-ink-4 leading-[1.5] break-words" :title="pluginSyncDescLines.cloud">{{ pluginSyncDescLines.cloud }}</span>
                </div>
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

    <!-- 弹窗：插件同步的云端文件夹选择（实验卡片区「浏览…」入口；
         确认后由 confirmPluginSyncDir 写入 prefs.ztoolsPluginSyncRemoteDir） -->
    <Transition name="modal-pop">
      <RemoteDirModal
        v-if="showPluginDirPicker"
        title="选择插件云端文件夹"
        subtitle="插件将同步到所选文件夹下的 ztools-plugins 子文件夹（其中再按操作系统分文件夹）；多台设备请选择同一个文件夹"
        :initial-path="s.prefs.ztoolsPluginSyncRemoteDir"
        @pick="confirmPluginSyncDir"
        @close="showPluginDirPicker = false"
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
