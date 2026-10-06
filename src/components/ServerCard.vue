<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { AppButton, AppIconButton, InfoTip } from './ui'
import { useStore, tierLabel, tierHint } from '../composables/store'
import { fmtBytes, fmtRelTime } from '../composables/format'
import type { DavTier } from '../env.d'

const store = useStore()

/**
 * 云端剩余空间（RFC 4331 配额属性随连接测试带出）：服务器返回 quota-available-bytes
 * 且为正数时展示「云端剩余 X」；未返回 / 返回 0 或负数（部分服务器把 0 当「无限制」
 * 误报）的服务器不展示 —— 无配额信息的形态零行为变化。
 */
const quotaText = computed(() => {
  const q = store.state.quota
  if (!q || !Number.isFinite(q.available) || (q.available ?? 0) <= 0) return ''
  return fmtBytes(q.available as number)
})
const quotaTitle = computed(() => {
  const q = store.state.quota
  if (!q) return ''
  const parts: string[] = []
  if (Number.isFinite(q.used) && (q.used ?? 0) > 0) parts.push(`已用 ${fmtBytes(q.used as number)}`)
  if (Number.isFinite(q.available) && (q.available ?? 0) > 0) parts.push(`剩余 ${fmtBytes(q.available as number)}`)
  return `云端空间：${parts.join('，') || '未知'}（服务器报告，随「测试连接」刷新）`
})

const metaText = computed(() => {
  if (store.connStatus.value === 'connected') {
    const last = store.lastSyncAt.value
    // B / C 档的服务器能力边界用一句话呈现（A 档无需提示）；
    // 检测到的技术原因（writeReason）折叠进悬浮 title
    const caps = store.state.capabilities
    const tierNote =
      caps && caps.tier === 'B'
        ? ' · 多台设备同时改同一个文件时，可能互相覆盖'
        : caps && caps.tier === 'C'
          ? ' · 仅可下载：服务器不允许上传'
          : ''
    return (last ? `已连接 · 上次同步：${fmtRelTime(last)}` : '已连接') + tierNote
  }
  if (store.connStatus.value === 'disconnected') return '未连接 · 点击「测试连接」检查'
  return '未配置 · 填写服务器信息后开始同步'
})

/** 档位短标签（运行良好 / 基本可用 / 仅可下载），已连接且已检测时展示 */
const tierText = computed(() => {
  const caps = store.state.capabilities
  if (!caps || store.connStatus.value !== 'connected') return ''
  return tierLabel(caps.tier)
})

/** B / C 档的技术原因（悬浮 title 展示，界面默认不出现） */
const tierNoteTitle = computed(() => {
  const caps = store.state.capabilities
  return caps && caps.writeReason ? caps.writeReason : ''
})

/**
 * 档位图例（档位徽标悬浮气泡内容）：列出全部档位与各自说明，当前档位标注
 * 「当前」—— 单看「基本可用」不知道好在哪 / 差在哪，对照全表才好理解边界。
 */
const tierLegend = computed(() => {
  const current = store.state.capabilities?.tier
  return (['A', 'B', 'C'] as DavTier[]).map((t) => ({
    tier: t,
    label: tierLabel(t),
    hint: tierHint(t),
    current: current === t,
  }))
})

const testing = computed(() => store.state.testing)

/**
 * 明文 http 警告的显隐：地址是明文 http 且未被当前地址关闭过。关闭（不再显示）
 * 记录的是关闭时的服务器地址（prefs.insecureHttpDismissedFor，与设置页同一条
 * 警告共用），之后换成另一个 http 地址会重新提示。
 */
const insecureHttpVisible = computed(
  () => store.insecureHttp.value && store.state.server.serverUrl !== (store.state.prefs.insecureHttpDismissedFor ?? '')
)

/** 关闭明文 http 警告（不再显示）：记录当前服务器地址作为情境指纹 */
function dismissInsecureHttp() {
  store.state.prefs.insecureHttpDismissedFor = store.state.server.serverUrl
}

/**
 * 「已信任此服务器证书」提示行：https 地址 + 信任开关开启时出现（不可关闭 ——
 * 信任是持续生效的安全放宽，主界面应常驻可见，与浏览器的「不安全」标记同取向）。
 */
const tlsTrustVisible = computed(() => {
  const s = store.state.server
  return /^https:\/\//i.test(s.serverUrl.trim()) && s.tls?.trustServerCertificate === true
})
</script>

<template>
  <section class="card flex flex-col gap-1 px-[14px] py-3">
    <div class="flex items-center gap-3">
      <div class="server-info flex-1 min-w-0 flex flex-col gap-1 cursor-pointer" @click="store.state.route = 'settings'">
        <div class="flex items-center gap-2">
          <span class="text-[12px] font-semibold text-ink-1">WebDAV 服务器</span>
          <!-- 多服务器计数（多账号形态）：点击卡片进设置可切换 / 管理 -->
          <span v-if="store.state.servers.length > 1" class="text-[10px] text-ink-3 bg-fill-seg rounded-[4px] px-[5px] py-px" title="已配置多台服务器：各同步文件夹使用各自的服务器，点击进设置查看与切换">共 {{ store.state.servers.length }} 台</span>
          <!-- 档位徽标：悬停展开全部档位与说明（当前档位标注），单独一个词看不出好差边界 -->
          <InfoTip v-if="tierText" text="">
            <template #trigger>
              <span class="tier-chip" :class="store.state.capabilities?.tier">{{ tierText }}</span>
            </template>
            <div class="tier-legend">
              <div v-for="row in tierLegend" :key="row.tier" class="tier-legend-row">
                <span class="tier-chip" :class="[row.tier, { current: row.current }]">{{ row.label }}</span>
                <span class="tier-legend-text">{{ row.hint }}<template v-if="row.current">（当前）</template></span>
              </div>
            </div>
          </InfoTip>
          <AppIcon name="chevron-right" :size="12" class="chev text-ink-4" />
        </div>
        <div class="flex items-center gap-[7px] min-w-0">
          <AppIcon name="globe" :size="13" class="text-ink-4" />
          <span class="font-mono text-[12px] text-ink-2 truncate">{{ store.state.server.serverUrl || '尚未配置服务器地址' }}</span>
        </div>
        <div class="flex items-center gap-[6px]">
          <span class="dot" :class="store.connStatus.value" />
          <span class="text-[11px]" :class="store.connStatus.value === 'disconnected' ? 'text-warning' : 'text-ink-2'" :title="tierNoteTitle">{{ metaText }}</span>
        </div>
        <!-- 云端剩余空间：服务器返回 RFC 4331 配额属性时展示（未返回的服务器不出现） -->
        <div v-if="quotaText" class="flex items-center gap-[6px]" :title="quotaTitle">
          <AppIcon name="cloud" :size="12" class="text-ink-4" />
          <span class="text-[11px] text-ink-2">云端剩余 {{ quotaText }}</span>
        </div>
      </div>
      <AppButton :disabled="testing" @click="store.testConnection()">
        <AppIcon name="refresh" :size="13" :class="{ spin: testing }" />
        {{ testing ? '测试中…' : '测试连接' }}
      </AppButton>
    </div>
    <!-- http 明文连接警告：密码与文件内容可被窃听，提醒但不阻止。
         全宽行放在信息行之外 —— 关闭按钮才能贴到卡片最右侧；
         关闭（不再显示）记录当时的服务器地址，换成另一个 http 地址后重新提示 -->
    <div v-if="insecureHttpVisible" class="flex items-center gap-[5px]">
      <AppIcon name="warn" :size="11" class="text-warning-icon shrink-0" />
      <span class="flex-1 min-w-0 text-[11px] text-warning-icon truncate">当前地址以 http 开头，密码和文件在传输时没有加密，可能被他人截获。建议改用 https 开头的地址</span>
      <AppIconButton :size="18" variant="ghost" title="不再显示" class="shrink-0 text-ink-3" @click.stop="dismissInsecureHttp">
        <AppIcon name="close" :size="10" />
      </AppIconButton>
    </div>
    <!-- 已信任证书提示：连接不再校验证书真伪（自签名 NAS 场景的持续安全放宽），
         常驻可见不可关闭 —— 与设置页的信任开关同源（server.tls.trustServerCertificate） -->
    <div v-if="tlsTrustVisible" class="flex items-center gap-[5px]" title="已开启「信任此服务器证书」：连接不再校验服务器证书真伪，仅建议在自己可控的 NAS / 内网设备上使用。可在「设置 → WebDAV」关闭">
      <AppIcon name="warn" :size="11" class="text-warning-icon shrink-0" />
      <span class="flex-1 min-w-0 text-[11px] text-warning-icon truncate">已信任此服务器的证书：连接不再校验证书真伪，请确认服务器可控</span>
    </div>
  </section>
</template>

<style scoped lang="scss">
/* 可点击区：悬停时箭头右移暗示「进入设置」 */
.server-info:hover .chev {
  transform: translateX(2px);
}

.chev {
  transition: transform 0.18s var(--ease-swift);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 3px;
  background: var(--text-muted);
  transition: background-color 0.3s ease, box-shadow 0.3s ease;

  &.connected {
    background: var(--green-dot);
    box-shadow: 0 0 0 3px rgba(30, 158, 74, 0.14);
  }

  &.disconnected {
    background: #d97706;
    box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.14);
  }
}

/* 档位徽标：运行良好 绿 / 基本可用 琥珀 / 仅可下载 中性灰，全部取自设计令牌 */
.tier-chip {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 1.4;
  font-weight: 500;
  color: var(--green-deep);
  background: var(--green-bg);

  &.B {
    // --amber-bg（#fffbf3 近白）在白卡片上几乎看不出是徽标，改用深一档的琥珀底；
    // 文字同步用 --amber-deep 保证浅黄底上的对比度
    color: var(--amber-deep);
    background: #fde68a;
  }

  &.C {
    color: var(--text-2);
    background: var(--bg-seg);
  }
}

/* 档位图例（徽标悬浮气泡）：徽标列 + 说明文，两列顶对齐便于逐行对照 */
.tier-legend {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 3px 1px;

  .tier-legend-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;

    .tier-chip {
      flex-shrink: 0;
      margin-top: 1px;

      // 当前档位：以徽标自身文字色（currentColor，随档位绿/琥珀/灰）描 outline
      // 作为选中效果；outline 不占布局、默认贴住内容（无间距）
      &.current {
        outline: 1px solid currentColor;
      }
    }

    .tier-legend-text {
      font-size: 11px;
      line-height: 1.6;
      color: var(--text-2);
      min-width: 0;
    }
  }
}
</style>
