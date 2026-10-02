<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import RemoteDirModal from '../components/RemoteDirModal.vue'
import { AppButton, AppIconButton, AppInput, AppSelect, AppSwitch } from '../components/ui'
import { useStore, defaultPrefs, tierLabel, tierHint } from '../composables/store'
import { toast } from '../composables/toast'
import { intervalOptions, strategyOptions } from '../composables/options'
import { fmtBytes, fmtRelTime } from '../composables/format'

const store = useStore()
const s = store.state

const showDirPicker = ref(false)
/** 「技术详情」展开状态：能力探测的原始明细（etag / 条件请求 / mtime / 探测备注），默认收起 */
const showTechDetail = ref(false)

const concurrencyOptions = [1, 2, 3, 4, 6, 8].map((n) => ({ value: n, label: `${n}` }))

const testResultText = computed(() => {
  if (!s.testResult) return ''
  if (s.testResult.ok) return `连接成功（响应 ${s.testResult.latencyMs ?? 0} 毫秒）`
  return s.testResult.error ? `连接失败：${s.testResult.error}` : '连接失败'
})

/**
 * 服务器检测结果（面向用户一句话）：运行良好 / 基本可用 / 仅下载。
 * 技术明细（etag 强弱 / 条件请求 / mtime 精度 / 写权限 / 探测备注）收进「技术详情」。
 */
const capabilityText = computed(() => {
  const c = s.capabilities
  if (!c) return ''
  return `服务器检测结果：${tierLabel(c.tier)}`
})

/** 技术详情内容：能力探测的原始摘要与备注，供反馈问题时复制 */
const capabilityTechText = computed(() => {
  const c = s.capabilities
  if (!c) return ''
  const parts = [
    `etag ${c.etag.present ? (c.etag.weak ? '弱' : '强') : '无'}`,
    `条件请求 ${c.conditional.ifMatch && c.conditional.ifNoneMatch ? '可用' : '不可用'}`,
    c.mtimePrecision === 's' ? 'mtime 秒级' : 'mtime 毫秒级',
    c.writable ? '可写' : '只读',
  ]
  const notes = c.notes && c.notes.length ? `；备注：${c.notes.join('；')}` : ''
  return `${tierLabel(c.tier)}（${parts.join(' · ')}）${notes}`
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
  return `检测到你在用${p.label}：该服务限制访问频率，已自动限制为每秒 ${p.netOpts.ratePerSec} 次，避免触发限流。如需取消限制，填 0`
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
      <AppIconButton title="返回" :size="28" class="text-btn-text" @click="s.route = 'main'">
        <AppIcon name="chevron-left" :size="12" />
      </AppIconButton>
      <div class="flex flex-col gap-px">
        <div class="text-[14px] font-semibold text-ink-1 leading-[1.2]">设置</div>
        <div class="text-[11px] text-ink-3 leading-[1.2]">连接、同步与高级选项</div>
      </div>
      <span class="flex-spacer" />
      <AppIconButton title="关闭" :size="28" class="text-btn-text" @click="store.outPlugin()">
        <AppIcon name="close" :size="12" />
      </AppIconButton>
    </header>

    <!-- 内容 -->
    <main class="flex-1 min-h-0 overflow-y-auto px-4 py-[10px]">
      <div class="flex gap-3 items-start">
        <!-- 左栏 -->
        <div class="flex-1 min-w-0 flex flex-col gap-3">
          <!-- WebDAV 卡片 -->
          <section class="card">
            <div class="flex items-center gap-2 px-[14px] py-[9px]">
              <span class="text-[12px] font-semibold text-ink-1">WebDAV</span>
              <span v-if="store.connStatus.value === 'connected'" class="inline-flex items-center gap-1 bg-success-bg rounded-[4px] pt-[2px] pr-[7px] pb-[2px] pl-[6px] text-[10px] font-medium text-success-deep">
                <span class="w-[5px] h-[5px] rounded-full bg-success-dot" />
                已连接
              </span>
            </div>
            <div class="flex flex-col gap-2 px-[14px] pt-[2px] pb-[10px]">
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
                  <span class="text-[11px] text-warning-icon leading-[1.5]">当前地址以 http 开头，密码和文件在传输时没有加密，可能被他人截获。建议改用 https 开头的地址</span>
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
                <span class="text-[11px] font-medium text-ink-2">默认云端文件夹</span>
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
                <div class="text-[11px] text-ink-4">添加同步文件夹时会自动填入这个位置；不填则使用电脑上的文件夹名</div>
              </div>
              <div class="flex items-center gap-[10px]">
                <AppButton variant="primary" :disabled="s.testing" @click="store.testConnection()">
                  <AppIcon name="refresh" :size="13" :class="{ spin: s.testing }" />
                  {{ s.testing ? '测试中…' : '测试连接' }}
                </AppButton>
                <span v-if="s.testResult" class="inline-flex items-center gap-[5px] text-[11px] text-ink-2">
                  <AppIcon v-if="s.testResult.ok" name="check-circle" :size="12" bg="var(--green-bg)" class="text-success" />
                  <AppIcon v-else name="warn" :size="12" class="text-warning-icon" />
                  {{ testResultText }}
                </span>
              </div>
              <!-- 服务器检测结果：一句话结论 + 技术详情折叠 + 重新检测入口 -->
              <div class="flex items-center gap-[10px] pt-[2px]">
                <AppButton :disabled="s.probing || !s.server.serverUrl.trim()" @click="store.reprobe()">
                  <AppIcon name="refresh" :size="13" :class="{ spin: s.probing }" />
                  {{ s.probing ? '检测中…' : '重新检测服务器' }}
                </AppButton>
                <span v-if="capabilityText" class="inline-flex items-center gap-[5px] text-[11px] text-ink-2">
                  <AppIcon name="check-circle" :size="12" bg="var(--green-bg)" class="text-success" />
                  {{ capabilityText }}
                </span>
                <button v-if="capabilityTechText" type="button" class="tech-toggle" @click="showTechDetail = !showTechDetail">
                  {{ showTechDetail ? '收起技术详情' : '查看技术详情' }}
                </button>
              </div>
              <div v-if="capabilityHintText" class="text-[11px] text-warning-icon" :title="capabilityHintTitle">
                {{ capabilityHintText }}
              </div>
              <div v-if="showTechDetail && capabilityTechText" class="rounded-[5px] bg-fill-seg px-[10px] py-[6px] font-mono text-[11px] text-ink-3 leading-[1.6] break-all">
                {{ capabilityTechText }}
              </div>
            </div>
          </section>

          <!-- 同步卡片 -->
          <section class="card">
            <div class="flex items-center gap-2 px-[14px] py-[9px]">
              <span class="text-[12px] font-semibold text-ink-1">同步</span>
            </div>
            <div class="flex flex-col gap-[6px] px-[14px] pt-[2px] pb-[10px]">
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">自动同步</span>
                  <span class="text-[11px] text-ink-4">发现文件有改动时，自动同步</span>
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="s.prefs.autoSync" />
              </div>
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">检查频率</span>
                  <span class="text-[11px] text-ink-4">每隔多久检查一次云端有没有更新</span>
                </div>
                <span class="flex-spacer" />
                <AppSelect v-model="s.prefs.intervalMin" :options="intervalOptions" :width="104" />
              </div>
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">启动时自动同步</span>
                  <span class="text-[11px] text-ink-4">打开 ZTools 时，先检查一次云端有没有更新</span>
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
            <div class="flex items-center gap-2 px-[14px] py-[9px]">
              <span class="text-[12px] font-semibold text-ink-1">高级</span>
            </div>
            <div class="flex flex-col gap-[6px] px-[14px] pt-[2px] pb-[10px]">
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">两边都改了怎么办</span>
                  <span class="text-[11px] text-ink-4">同一个文件在电脑和云端都被修改时，默认怎么处理</span>
                </div>
                <span class="flex-spacer" />
                <AppSelect v-model="s.prefs.conflictStrategy" :options="strategyOptions" :width="104" />
              </div>
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">不同步隐藏文件和系统文件</span>
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="s.prefs.ignoreHidden" />
              </div>
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">同时传输文件数</span>
                  <span class="text-[11px] text-ink-4">数字越大越快，但可能被服务器限流</span>
                </div>
                <span class="flex-spacer" />
                <AppSelect v-model="s.prefs.concurrency" :options="concurrencyOptions" :width="104" />
              </div>
              <!-- 请求限速：server.netOpts.ratePerSec；档案命中时给出默认值提示 -->
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">访问频率限制</span>
                  <span class="text-[11px] text-ink-4">每秒最多向服务器发送多少次请求，0 表示不限制。一般保持默认即可</span>
                </div>
                <span class="flex-spacer" />
                <AppInput v-model="ratePerSecInput" sm type="number" class="w-[104px]" :placeholder="ratePlaceholder" />
              </div>
              <div v-if="rateHint" class="flex items-start gap-[5px] -mt-[2px]">
                <AppIcon name="info" :size="11" class="text-ink-4 shrink-0 mt-[2px]" />
                <span class="text-[11px] text-ink-4 leading-[1.5]">{{ rateHint }}</span>
              </div>
              <!-- 防多设备同时同步（原「目录租约锁」）：改用人话表述，归入高级 -->
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">防止多台设备同时同步</span>
                  <span class="text-[11px] text-ink-4">开启后，同一个文件夹同一时间只允许一台设备同步，更安全，但每次会慢约 1~2 秒。关闭后，多台设备同时同步时可能互相覆盖</span>
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="s.prefs.leaseLock" />
              </div>
              <!-- 深度校验：定期核对文件内容（默认关；放在高级，文字说清代价） -->
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">彻底检查</span>
                  <span class="text-[11px] text-ink-4">定期逐个核对电脑上所有文件的内容，能发现「大小和时间都没变」的改动。文件很多时会明显变慢、占用硬盘</span>
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="deepVerifyModel" />
              </div>
              <!-- 用户排除规则：逐行 glob；内置 OS 垃圾规则不可关闭 -->
              <div class="flex flex-col gap-[6px] pt-[4px] pb-[5px]">
                <span class="text-[12px] font-medium text-ink-1">不同步的文件</span>
                <textarea
                  v-model="excludeText"
                  rows="3"
                  spellcheck="false"
                  class="exclude-input font-mono"
                  placeholder="每行一条，如 *.iso&#10;node_modules/"
                />
                <span class="text-[11px] text-ink-4">每行写一个要跳过的文件或文件夹，例如 *.iso（所有 iso 文件）、node_modules/（这个文件夹）。临时文件和系统垃圾文件（如 .DS_Store、Thumbs.db）已自动跳过</span>
              </div>
            </div>
          </section>

          <!-- 同步状态卡片 -->
          <section class="card">
            <div class="flex items-center gap-2 px-[14px] py-[9px]">
              <span class="text-[12px] font-semibold text-ink-1">同步状态</span>
            </div>
            <div class="px-[14px] pt-[6px] pb-[2px]">
              <div class="flex items-center justify-between pt-[2px] pb-[6px]">
                <span class="text-[11px] text-ink-2">同步文件夹</span>
                <span class="font-mono text-[11px] font-medium text-ink-1">{{ s.dirs.length }} 个</span>
              </div>
              <div class="flex items-center justify-between pt-[2px] pb-[6px]">
                <span class="text-[11px] text-ink-2">上次同步</span>
                <span class="font-mono text-[11px] font-medium text-ink-1">{{ lastSyncText }}</span>
              </div>
              <div class="flex items-center justify-between pt-[2px] pb-[6px]">
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
        @pick="(p) => (s.prefs.defaultRemoteDir = p)"
        @close="showDirPicker = false"
      />
    </Transition>
  </div>
</template>

<style scoped lang="scss">
/* 技术详情开关：弱化文字按钮，仅在有检测结果时出现 */
.tech-toggle {
  border: none;
  background: transparent;
  padding: 2px 0;
  font-size: 11px;
  color: var(--blue);
  white-space: nowrap;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
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

  &::placeholder {
    color: var(--text-muted);
  }

  &:focus {
    border-color: var(--blue);
  }
}
</style>
