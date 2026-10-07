<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { AppButton, AppModal } from './ui'
import { useStore } from '../composables/store'
import { fmtBytes } from '../composables/format'
import { groupOps, opLineText } from '../composables/synclog'
import type { SyncDir, SyncLogEntry } from '../env.d'

/**
 * 预演结果弹窗（目录行「更多操作 → 预演一次」）：发起一轮零副作用的预演轮
 *（store.dryRunDir → 调度器 syncNow opts.dryRun → 引擎 hints.dryRun，只扫描
 * 与规划、不上传不下载不删除不写基线），完成后读取最新一条预演同步记录
 *（trigger='dry-run'）以只读摘要 + 明细列表展示 —— 明细渲染复用同步记录页的
 * 分组与文案口径（groupOps / opLineText），与真实轮同构。
 *
 * 时效性：预演结论是「扫描那一刻」的计划，真实同步前文件可能又有变化 ——
 * 底部固定提示，勾选树 / 单向档等后续动作以真实轮为准。
 */

const props = defineProps<{ dir: SyncDir }>()
const emit = defineEmits<{ close: [] }>()

const store = useStore()

const phase = ref<'running' | 'done' | 'failed'>('running')
const runError = ref('')
const record = ref<SyncLogEntry | null>(null)

const summary = computed(() => record.value)

/** 计划改动摘要（与同步记录简略行同口径的 chips） */
const chips = computed(() => {
  const r = record.value
  if (!r) return []
  const out: Array<{ label: string; count: number; icon: string }> = []
  if (r.uploaded > 0) out.push({ label: '上传', count: r.uploaded, icon: 'upload' })
  if (r.downloaded > 0) out.push({ label: '下载', count: r.downloaded, icon: 'download' })
  if (r.deleted > 0) out.push({ label: '删除', count: r.deleted, icon: 'trash' })
  if ((r.renamed ?? 0) > 0) out.push({ label: '改名', count: r.renamed!, icon: 'swap' })
  if (r.conflicts > 0) out.push({ label: '冲突', count: r.conflicts, icon: 'warn' })
  if ((r.deleteHeld ?? 0) > 0) out.push({ label: '删除待确认', count: r.deleteHeld, icon: 'help' })
  return out
})

/** 明细分组（复用同步记录详尽视图的分组与逐行文案） */
const groups = computed(() => {
  const r = record.value
  if (!r || !r.ops || !r.ops.length) return null
  return groupOps(r.ops)
})

async function run() {
  phase.value = 'running'
  runError.value = ''
  record.value = null
  try {
    const r = await store.dryRunDir(props.dir)
    if (!r.ok) {
      runError.value = r.error || '预演没有完成'
      phase.value = 'failed'
      return
    }
    // 预演记录在轮末落盘（best-effort），稍候再取；取不到时退回摘要形态
    await new Promise((res) => setTimeout(res, 150))
    record.value = await store.latestDryRunRecord(props.dir)
    phase.value = 'done'
  } catch (e) {
    runError.value = e instanceof Error ? e.message : String(e)
    phase.value = 'failed'
  }
}

watch(
  () => props.dir.id,
  () => void run(),
  { immediate: true }
)
</script>

<template>
  <AppModal title="预演结果" :subtitle="dir.name" :width="460" @close="emit('close')">
    <template #icon>
      <AppIcon name="eye" :size="14" class="text-primary" />
    </template>

    <!-- 预演进行中 -->
    <div v-if="phase === 'running'" class="flex flex-col items-center gap-3 py-10">
      <AppIcon name="refresh" :size="18" class="spin text-primary" />
      <p class="text-[12px] text-ink-2">正在预演…</p>
      <p class="text-[11px] text-ink-3">只扫描和比对，不会改动电脑和云端的任何文件</p>
    </div>

    <!-- 预演失败（忙时拒绝 / 扫描失败 / 预检中止） -->
    <div v-else-if="phase === 'failed'" class="flex flex-col items-center gap-3 py-8">
      <AppIcon name="warn" :size="20" class="text-warning-icon" />
      <p class="max-w-[320px] text-center text-[12px] leading-[1.7] text-ink-2">{{ runError }}</p>
      <AppButton variant="secondary" @click="run">重试</AppButton>
    </div>

    <!-- 预演结果（只读摘要 + 明细） -->
    <template v-else>
      <div v-if="!summary || (!chips.length && !(summary.errors || []).length)" class="flex flex-col items-center gap-2 py-8">
        <AppIcon name="check-circle" :size="22" class="text-primary" />
        <p class="text-[13px] font-medium text-ink-1">两边已经一致</p>
        <p class="text-[11px] text-ink-3">预演没有发现需要同步的改动</p>
      </div>
      <div v-else class="flex flex-col gap-3">
        <!-- 计划改动 chips -->
        <div class="flex flex-wrap gap-[6px]">
          <span v-for="c in chips" :key="c.label" class="chip">
            <AppIcon :name="c.icon" :size="11" />
            {{ c.label }} {{ c.count }}
          </span>
        </div>
        <p v-if="summary && (summary.bytesUp > 0 || summary.bytesDown > 0)" class="text-[11px] text-ink-3">
          预计传输：上传 {{ fmtBytes(summary.bytesUp) }}、下载 {{ fmtBytes(summary.bytesDown) }}
        </p>

        <!-- 明细（同步记录同口径分组；预演记录大列表同样分批不限高内滚） -->
        <div v-if="groups" class="detail-box">
          <template v-for="(items, key) in groups" :key="key">
            <template v-if="items.length">
              <p class="group-title">
                {{ key === 'cloudUp' ? '将上传到云端' : key === 'cloudDel' ? '将从云端删除' : key === 'cloudRename' ? '将在云端改名' : key === 'localDown' ? '将下载到电脑' : key === 'localDel' ? '将从电脑删除' : key === 'localRename' ? '将在电脑上改名' : '将询问你怎么处理' }}
              </p>
              <p v-for="(o, i) in items" :key="key + i" class="op-line">
                <span class="truncate">{{ o.rel }}</span>
                <span class="shrink-0 text-ink-4">{{ opLineText(o) }}</span>
              </p>
            </template>
          </template>
        </div>

        <!-- 待确认删除（预演如实反映删除安全闸的拦截） -->
        <p v-if="summary && (summary.deleteHeld ?? 0) > 0" class="flex items-start gap-[5px] text-[11px] leading-[1.7] text-warning-icon">
          <AppIcon name="warn" :size="11" class="shrink-0 mt-[2px]" />
          有 {{ summary!.deleteHeld }} 项删除数量偏多，真实同步时会先挂起等你确认，不会直接删除
        </p>
        <!-- 预演错误（预检中止等；警告不落同步记录，已在计划明细中体现） -->
        <p v-for="(e, i) in (summary && summary.errors) || []" :key="'e' + i" class="text-[11px] leading-[1.7] text-warning-icon">{{ e }}</p>
      </div>

      <p class="note-line">预演只是提前看一眼，没有改动任何文件。文件内容在真正同步前可能又有变化，以真实同步为准。</p>
    </template>

    <template #footer>
      <AppButton variant="ghost" @click="emit('close')">关闭</AppButton>
      <AppButton v-if="phase === 'done'" @click="store.syncDir(props.dir); emit('close')">立即同步</AppButton>
    </template>
  </AppModal>
</template>

<style scoped lang="scss">
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-seg);
}

.detail-box {
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--border-card);
  border-radius: 8px;
  padding: 8px 10px;
}

.group-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-4);
  margin: 6px 0 2px;
}

.op-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  line-height: 1.8;
  color: var(--text-1);

  span:first-child {
    flex: 1;
    min-width: 0;
  }
}

.note-line {
  border-top: 1px solid var(--border-card);
  padding-top: 8px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-4);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
