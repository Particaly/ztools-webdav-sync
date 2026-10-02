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

const concurrencyOptions = [1, 2, 3, 4, 6, 8].map((n) => ({ value: n, label: `${n}` }))

const testResultText = computed(() => {
  if (!s.testResult) return ''
  if (s.testResult.ok) return `连接正常 · ${s.testResult.latencyMs ?? 0} ms`
  return s.testResult.error || '连接失败'
})

/**
 * 服务器档位展示：档位标签 + 能力摘要一行。
 * 摘要按能力结果拼装（etag 强弱 / 条件请求 / mtime 精度 / Depth infinity）。
 */
const capabilityText = computed(() => {
  const c = s.capabilities
  if (!c) return ''
  const parts = [
    `etag ${c.etag.present ? (c.etag.weak ? '弱' : '强') : '无'}`,
    `条件请求 ${c.conditional.ifMatch && c.conditional.ifNoneMatch ? '可用' : '不可用'}`,
    c.mtimePrecision === 's' ? 'mtime 秒级' : 'mtime 毫秒级',
  ]
  // 写权限按远端根路径判定，摘要注明本次探测的目标路径与结论
  parts.push(c.writable ? '可写' : '只读')
  return `${tierLabel(c.tier)}（${parts.join(' · ')}）`
})

/** 档位提示行（B/C 档）；附写权限降级原因（如「只读：服务器拒绝写入（HTTP 403）」） */
const capabilityHintText = computed(() => {
  const c = s.capabilities
  if (!c || c.tier === 'A') return ''
  const hint = tierHint(c.tier)
  return c.writeReason ? `${hint}（${c.writeReason}${c.writeRetrySoon ? '，下轮将重探' : ''}）` : hint
})

const cloudUsageText = computed(() => {
  if (s.cloudUsage) return s.cloudUsage
  const bytes = store.cloudBytes.value
  return bytes > 0 ? fmtBytes(bytes) : '—'
})

const lastSyncText = computed(() => fmtRelTime(store.lastSyncAt.value))

/** 内容校验上限以 MB 展示 / 编辑，落地回 prefs.verifyMaxBytes（字节） */
const verifyMaxMb = computed<number>({
  get: () => Math.round((s.prefs.verifyMaxBytes ?? 50 * 1024 * 1024) / 1024 / 1024),
  set: (v) => {
    const mb = Number(v)
    s.prefs.verifyMaxBytes = Number.isFinite(mb) && mb > 0 ? Math.min(2048, Math.round(mb)) * 1024 * 1024 : 50 * 1024 * 1024
  },
})

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
  return `检测到${p.label}：该服务有请求频率配额，未单独设置时已默认限速 ${p.netOpts.ratePerSec} 次/秒（填 0 可明确不限速）`
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
                  <span class="text-[11px] text-warning-icon leading-[1.5]">http 明文连接：密码与文件内容在网络上不加密，可被中间人窃听，建议改用 https</span>
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
                <span class="text-[11px] font-medium text-ink-2">默认 WebDAV 目录</span>
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
                <div class="text-[11px] text-ink-4">添加同步目录时自动填入该路径，留空则按本地目录名生成</div>
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
              <!-- 服务器档位：当前档位 + 能力摘要 + 重新探测入口 -->
              <div class="flex items-center gap-[10px] pt-[2px]">
                <AppButton :disabled="s.probing || !s.server.serverUrl.trim()" @click="store.reprobe()">
                  <AppIcon name="refresh" :size="13" :class="{ spin: s.probing }" />
                  {{ s.probing ? '探测中…' : '重新探测' }}
                </AppButton>
                <span v-if="capabilityText" class="inline-flex items-center gap-[5px] text-[11px] text-ink-2">
                  <AppIcon name="check-circle" :size="12" bg="var(--green-bg)" class="text-success" />
                  {{ capabilityText }}
                </span>
              </div>
              <div v-if="capabilityHintText" class="text-[11px] text-warning-icon">
                {{ capabilityHintText }}
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
                  <span class="text-[11px] text-ink-4">检测到变更后自动执行同步</span>
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="s.prefs.autoSync" />
              </div>
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">同步间隔</span>
                  <span class="text-[11px] text-ink-4">自动同步的轮询周期</span>
                </div>
                <span class="flex-spacer" />
                <AppSelect v-model="s.prefs.intervalMin" :options="intervalOptions" :width="104" />
              </div>
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">启动时自动同步</span>
                  <span class="text-[11px] text-ink-4">打开 ZTools 时检查一次云端变更</span>
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="s.prefs.syncOnStartup" />
              </div>
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">目录租约锁</span>
                  <span class="text-[11px] text-ink-4">开启时多设备同一目录互斥，每轮约多 4 个请求与 1.5s 获取等待；关闭时仅依赖服务器档位保护，B 档服务器并发风险更高</span>
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="s.prefs.leaseLock" />
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
                  <span class="text-[12px] font-medium text-ink-1">冲突处理</span>
                  <span class="text-[11px] text-ink-4">两侧同时修改时的默认行为</span>
                </div>
                <span class="flex-spacer" />
                <AppSelect v-model="s.prefs.conflictStrategy" :options="strategyOptions" :width="104" />
              </div>
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">忽略隐藏文件</span>
                  <span class="text-[11px] text-ink-4">跳过以 . 开头的文件和系统文件</span>
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="s.prefs.ignoreHidden" />
              </div>
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">最大并发</span>
                  <span class="text-[11px] text-ink-4">同时传输的文件数量</span>
                </div>
                <span class="flex-spacer" />
                <AppSelect v-model="s.prefs.concurrency" :options="concurrencyOptions" :width="104" />
              </div>
              <!-- 请求限速：server.netOpts.ratePerSec；档案命中时给出默认值提示 -->
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">请求限速</span>
                  <span class="text-[11px] text-ink-4">每秒向同一服务器发出的请求数上限</span>
                </div>
                <span class="flex-spacer" />
                <AppInput v-model="ratePerSecInput" sm type="number" class="w-[104px]" :placeholder="ratePlaceholder" />
              </div>
              <div v-if="rateHint" class="flex items-start gap-[5px] -mt-[2px]">
                <AppIcon name="info" :size="11" class="text-ink-4 shrink-0 mt-[2px]" />
                <span class="text-[11px] text-ink-4 leading-[1.5]">{{ rateHint }}</span>
              </div>
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">内容校验上限</span>
                  <span class="text-[11px] text-ink-4">指纹模糊时下载比对的文件大小上限（MB）</span>
                </div>
                <span class="flex-spacer" />
                <AppInput v-model.number="verifyMaxMb" icon="file" sm type="number" placeholder="50" />
              </div>
              <div class="flex items-center gap-3 pt-[4px] pb-[5px]">
                <div class="flex flex-col gap-[2px] min-w-0">
                  <span class="text-[12px] font-medium text-ink-1">深度校验</span>
                  <span class="text-[11px] text-ink-4">按周期重算本地全部文件哈希，可发现大小与时间均未变的修改；大目录会明显增加耗时与磁盘读取</span>
                </div>
                <span class="flex-spacer" />
                <AppSwitch v-model="deepVerifyModel" />
              </div>
              <!-- 用户排除规则：逐行 glob；内置 OS 垃圾规则不可关闭 -->
              <div class="flex flex-col gap-[6px] pt-[4px] pb-[5px]">
                <span class="text-[12px] font-medium text-ink-1">排除规则</span>
                <textarea
                  v-model="excludeText"
                  rows="3"
                  spellcheck="false"
                  class="exclude-input font-mono"
                  placeholder="每行一条，如 *.iso&#10;node_modules/&#10;~$* 已内置，无需重复添加"
                />
                <span class="text-[11px] text-ink-4">每行一条 glob（* 不跨目录）；含 / 时按完整路径匹配，否则按文件名匹配。.DS_Store、._*、~$*、Thumbs.db 等系统垃圾已默认排除且不可关闭</span>
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
                <span class="text-[11px] text-ink-2">同步目录</span>
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
        title="选择默认 WebDAV 目录"
        :initial-path="s.prefs.defaultRemoteDir"
        @pick="(p) => (s.prefs.defaultRemoteDir = p)"
        @close="showDirPicker = false"
      />
    </Transition>
  </div>
</template>

<style scoped lang="scss">
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
