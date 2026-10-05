<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import { AppIconButton } from '../components/ui'
import { useStore, allPendingSignal } from '../composables/store'
import { fmtBytes, fmtRelTime } from '../composables/format'
import { decisionActionText, type DecisionHistoryRow } from '../composables/decisions'
import {
  demoSyncRecords,
  fmtAbsTime,
  fmtDuration,
  groupOps,
  loadSyncRecords,
  opLineText,
  opText,
  roundBrief,
  statusText,
  statusTone,
  triggerText,
  type SyncRecordRow,
} from '../composables/synclog'

/**
 * 同步记录页（顶栏「同步记录」入口）：把「决策记录」页改造而来的统一时间线 ——
 * 每次同步轮（成功 / 部分完成 / 失败 / 取消 / 让出）与用户决策（待处理挂起的
 * 选择 / 忽略）都按时间倒序记录在此，满足「所有同步操作都有对应记录」。
 * 记录分简略 / 详尽两种形态：简略行展示时间、目录、触发方式、结果与改动计数；
 * 点击展开详尽视图 —— 云端（线上）与电脑（线下）各自做了什么（新增 / 更新 /
 * 删除了哪些文件）、冲突怎么处理、发生哪些错误。全部记录与全部明细一次渲染
 *（不截断不分页）：页面行与明细行经 CSS content-visibility 做渲染层虚拟滚动，
 * 展开区限高内滚，大轮次（数千文件）只渲染视口内的行。待处理事项不在本页处理
 *（全局待处理中心是唯一处理入口），顶部横幅一键直达。
 */
const store = useStore()
const s = store.state

// ---------- 待处理横幅（有未决策事项时提示并直达待处理中心） ----------

const pendingTotal = computed(() => store.pendingConflictTotal.value)

/**
 * 横幅显隐：有待处理事项且未被关闭过。关闭（不再显示）记录当时的全局待处理
 * 信号（prefs.pendingBarMutedAt = 各目录未决策挂起的最新时间），之后出现更新的
 * 挂起（新冲突 / 新删除确认）时重新提示 —— 关闭只对当前这批事项生效。
 */
const pendingSignal = computed(() => allPendingSignal(s.dirs))
const pendingBarVisible = computed(() => pendingTotal.value > 0 && pendingSignal.value > (s.prefs.pendingBarMutedAt ?? 0))

/** 关闭横幅（不再显示）：记录当前的全局待处理信号作为比较基准 */
function dismissPendingBar() {
  s.prefs.pendingBarMutedAt = pendingSignal.value
}

/** 横幅「去处理」：待处理面板挂在主界面的 DirRow 上，先回主界面再打开待处理中心 */
async function goHandlePending() {
  s.route = 'main'
  await nextTick()
  await store.openPendingCenter()
}

// ---------- 记录时间线（进入页面拉取一次） ----------

const records = ref<SyncRecordRow[]>([])
const loading = ref(false)
/** 展开的详尽视图（key = 行标识；简略 / 详尽两种形态按行切换） */
const expandedKeys = ref<Set<string>>(new Set())

/** 行标识（展开状态的记忆键；同毫秒同目录的同类型记录按序号区分） */
function rowKey(r: SyncRecordRow, i: number): string {
  return `${r.type}-${r.at}-${r.dirName}-${i}`
}

function toggleRow(key: string) {
  const next = new Set(expandedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedKeys.value = next
}

async function reloadRecords() {
  loading.value = true
  const rows = await loadSyncRecords(s.dirs)
  // 演示形态读不到磁盘侧日志：记录为空时落静态样例，保证预览布局完整
  records.value = rows.length || !s.demo ? rows : demoSyncRecords()
  expandedKeys.value = new Set()
  loading.value = false
}

// 进入页面：刷新各目录挂起列表（横幅计数）+ 重拉记录时间线
watch(
  () => s.route,
  (r) => {
    if (r !== 'decisions') return
    void store.refreshAllPendingConflicts()
    void reloadRecords()
  },
  { immediate: true }
)

// ---------- 简略行 / 详尽视图的渲染辅助 ----------

const TONE_COLOR: Record<string, string> = {
  good: 'var(--green-dot, #1e9e4a)',
  warn: '#d97706',
  bad: 'var(--red, #d93025)',
  muted: 'var(--text-muted, #9aa4ad)',
}

/** 决策行的动作文案（与待处理中心「最近处理记录」同口径） */
function decisionText(r: DecisionHistoryRow): string {
  return decisionActionText(r)
}

/** 详尽视图的逐文件操作分组（云端 / 本地 / 冲突三段） */
function groupsOf(r: SyncRecordRow) {
  return r.type === 'round' ? groupOps(r.ops) : null
}
</script>

<template>
  <div class="h-screen flex flex-col bg-white">
    <!-- 页头（与设置页同构）：返回 + 标题 -->
    <header class="flex items-center gap-3 h-14 px-5 border-b border-solid border-line-bar shrink-0">
      <AppIconButton title="返回" variant="ghost" :size="28" class="text-btn-text" @click="s.route = 'main'">
        <AppIcon name="chevron-left" :size="13" />
      </AppIconButton>
      <div class="flex flex-col gap-px">
        <div class="text-[14px] font-semibold text-ink-1 leading-[1.2]">同步记录</div>
        <div class="text-[11px] text-ink-3 leading-[1.2]">每次同步的触发方式、时间与改动明细</div>
      </div>
      <span class="flex-spacer" />
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto px-4 py-[14px] flex flex-col gap-[14px]">
      <!-- 待处理横幅：本页只回看记录，待处理事项集中到全局待处理中心处理；
           关闭（不再显示）后出现新的挂起会重新提示（div + 内嵌按钮：button 不能嵌套 button） -->
      <div v-if="pendingBarVisible" class="pending-bar" role="button" tabindex="0" @click="goHandlePending" @keydown.enter="goHandlePending">
        <AppIcon name="warn" :size="13" class="text-warning-icon shrink-0" />
        <span class="flex-1 text-left">有 {{ pendingTotal }} 项待处理事项等你确认，确认前不会改动这些文件</span>
        <span class="pending-act">去处理</span>
        <AppIconButton :size="18" variant="ghost" title="不再显示" class="shrink-0 text-ink-3" @click.stop="dismissPendingBar">
          <AppIcon name="close" :size="10" />
        </AppIconButton>
      </div>

      <!-- 记录时间线：同步轮 + 用户决策，按时间倒序 -->
      <section class="flex flex-col gap-[6px]">
        <div class="sec-head">
          <AppIcon name="history" :size="12" class="text-ink-3" />
          <span>全部记录</span>
          <span v-if="records.length" class="count">{{ records.length }}</span>
        </div>
        <div v-if="loading" class="text-[11px] text-ink-4 px-[2px]">读取中…</div>
        <div v-else-if="!records.length" class="text-[11px] text-ink-4 px-[2px]">还没有同步记录，完成一次同步后这里会显示每次的改动明细</div>
        <template v-else>
          <!-- 全部记录一次渲染（不分页）：行级 content-visibility 做渲染层虚拟滚动 -->
          <div class="flex flex-col gap-[4px]">
            <template v-for="(r, i) in records" :key="rowKey(r, i)">
              <!-- 同步轮：简略行（点击展开详尽） -->
              <div v-if="r.type === 'round'" class="rec" :class="{ 'rec-open': expandedKeys.has(rowKey(r, i)) }" @click="toggleRow(rowKey(r, i))">
                <div class="rec-main">
                  <span class="tone-dot" :style="{ background: TONE_COLOR[statusTone(r)] }" />
                  <span class="min-w-0 flex-1 flex flex-col gap-[2px]">
                    <span class="flex items-center gap-[6px] min-w-0">
                      <span class="truncate text-[12px] font-semibold text-ink-1">{{ r.dirName }}</span>
                      <span class="text-[11px]" :style="{ color: TONE_COLOR[statusTone(r)] }">{{ statusText(r) }}</span>
                      <span class="text-[11px] text-ink-4 truncate">{{ triggerText(r.trigger) }}<template v-if="opText(r.op)"> · {{ opText(r.op) }}</template></span>
                    </span>
                    <span v-if="roundBrief(r).length" class="flex flex-wrap items-center gap-x-[8px] gap-y-[2px]">
                      <span v-for="c in roundBrief(r)" :key="c.label" class="chip">{{ c.label }} {{ c.count }}</span>
                      <span v-if="r.status === 'error' && r.error" class="text-[11px] text-danger truncate">{{ r.error }}</span>
                    </span>
                    <span v-else-if="r.status === 'error' && r.error" class="text-[11px] text-danger truncate">{{ r.error }}</span>
                  </span>
                  <span class="shrink-0 flex items-center gap-[4px]">
                    <span class="text-[10px] text-ink-4 whitespace-nowrap">{{ fmtRelTime(r.at) }}</span>
                    <AppIcon name="chevron-down" :size="11" class="text-ink-4 rec-chev" />
                  </span>
                </div>
                <!-- 详尽视图：线上线下各自做了什么（新增 / 更新 / 删除）、冲突处理与错误；
                     限高内滚 —— 元信息行固定在顶部，数千行明细在内部滚动 -->
                <div v-if="expandedKeys.has(rowKey(r, i))" class="rec-detail" @click.stop>
                  <div class="meta-row">
                    <span>开始时间 {{ fmtAbsTime(r.at) }}</span>
                    <span>耗时 {{ fmtDuration(r.endAt - r.at) }}</span>
                    <span>触发方式 {{ triggerText(r.trigger) }}<template v-if="opText(r.op)">（{{ opText(r.op) }}）</template></span>
                  </div>
                  <div class="rec-detail-scroll">
                    <template v-if="groupsOf(r)">
                      <div v-if="groupsOf(r)!.cloudUp.length || groupsOf(r)!.cloudDel.length" class="grp">
                        <div class="grp-title">云端（线上）</div>
                        <div v-for="(o, j) in groupsOf(r)!.cloudUp" :key="`u${j}`" class="op-line" :title="o.rel">
                          <span class="op-text">{{ opLineText(o) }}</span>
                          <span class="font-mono op-rel">{{ o.rel }}</span>
                          <span v-if="o.bytes" class="op-bytes">{{ fmtBytes(o.bytes) }}</span>
                        </div>
                        <div v-for="(o, j) in groupsOf(r)!.cloudDel" :key="`cd${j}`" class="op-line" :title="o.rel">
                          <span class="op-text">{{ opLineText(o) }}</span>
                          <span class="font-mono op-rel">{{ o.rel }}</span>
                        </div>
                      </div>
                      <div v-if="groupsOf(r)!.localDown.length || groupsOf(r)!.localDel.length" class="grp">
                        <div class="grp-title">电脑（线下）</div>
                        <div v-for="(o, j) in groupsOf(r)!.localDown" :key="`d${j}`" class="op-line" :title="o.rel">
                          <span class="op-text">{{ opLineText(o) }}</span>
                          <span class="font-mono op-rel">{{ o.rel }}</span>
                          <span v-if="o.bytes" class="op-bytes">{{ fmtBytes(o.bytes) }}</span>
                        </div>
                        <div v-for="(o, j) in groupsOf(r)!.localDel" :key="`cl${j}`" class="op-line" :title="o.rel">
                          <span class="op-text">{{ opLineText(o) }}</span>
                          <span class="font-mono op-rel">{{ o.rel }}</span>
                        </div>
                      </div>
                      <div v-if="groupsOf(r)!.conflicts.length" class="grp">
                        <div class="grp-title">冲突处理</div>
                        <div v-for="(o, j) in groupsOf(r)!.conflicts" :key="`c${j}`" class="op-line" :title="o.rel">
                          <span class="op-text">{{ opLineText(o) }}</span>
                          <span class="font-mono op-rel">{{ o.rel }}</span>
                        </div>
                      </div>
                      <div v-if="!r.ops.length" class="note-line">{{ r.status === 'yielded' ? '本次让行，没有做任何改动' : '本次没有文件改动' }}</div>
                      <div v-if="r.adopted > 0" class="note-line">另有 {{ r.adopted }} 个文件两边内容一致，已自动对齐记录</div>
                      <div v-if="r.deferredConflicts > 0" class="note-line">{{ r.deferredConflicts }} 个冲突等你处理，处理后会自动同步</div>
                      <div v-if="r.deleteHeld > 0" class="note-line">{{ r.deleteHeld }} 项删除等你确认，确认前不会删除任何文件</div>
                      <div v-if="r.errors.length" class="grp grp-err">
                        <div class="grp-title">发生的错误</div>
                        <div v-for="(e, j) in r.errors" :key="`e${j}`" class="op-line"><span class="text-danger">{{ e }}</span></div>
                        <div v-if="r.errorsDropped" class="note-line">另有 {{ r.errorsDropped }} 条错误没有显示</div>
                      </div>
                    </template>
                  </div>
                </div>
              </div>
              <!-- 用户决策：单行记录（动作文案与待处理中心「最近处理记录」同口径） -->
              <div v-else class="rec rec-plain">
                <div class="rec-main">
                  <AppIcon name="check-circle" :size="13" bg="var(--green-bg)" class="text-success shrink-0" />
                  <span class="min-w-0 flex-1 truncate" :title="`${r.dirName} / ${r.rel}`">
                    <span class="text-ink-2">{{ r.dirName }}</span>
                    <span class="rec-sep">·</span>
                    <span class="text-ink-3">{{ r.kind === 'ignore' ? '忽略了这条提醒（再次出现才会询问）' : decisionText(r) }}</span>
                    <span v-if="r.rel !== '.'" class="rec-sep">·</span>
                    <span v-if="r.rel !== '.'" class="font-mono text-ink-4">{{ r.rel }}</span>
                  </span>
                  <span class="shrink-0 text-[10px] text-ink-4 whitespace-nowrap">{{ fmtRelTime(r.at) }}</span>
                </div>
              </div>
            </template>
          </div>
        </template>
      </section>
    </main>
  </div>
</template>

<style scoped lang="scss">
/* 待处理横幅：琥珀色提示条（与删除确认提示条同色系），整条可点击 */
.pending-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--amber-strip-br, #f0dfb6);
  border-radius: 7px;
  background: var(--amber-strip-bg, #fdf8ec);
  font-size: 12px;
  color: var(--text-1);
  cursor: pointer;
  transition: background 0.12s ease;

  &:hover {
    background: #faf1da;
  }

  .pending-act {
    border: 1px solid var(--br-divider);
    border-radius: 5px;
    padding: 3px 9px;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
    background: #fff;
  }
}

/* 区块标题：图标 + 名称 + 计数徽标 */
.sec-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px;

  span {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-3);
  }

  .count {
    min-width: 16px;
    height: 15px;
    padding: 0 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    background: var(--bg-seg, #eef1f5);
    font-size: 10px;
    font-weight: 600;
    color: var(--text-2);
  }
}

/* 记录行：简略 / 详尽两态；普通行（决策）无展开态。
   content-visibility：渲染层虚拟滚动 —— 视口外的行跳过渲染（布局占位按
   contain-intrinsic-size 估算），全部记录一次渲染也不因行数多而卡顿 */
.rec {
  border: 1px solid var(--br-divider);
  border-radius: 7px;
  padding: 8px 10px;
  cursor: pointer;
  transition: background 0.12s ease;
  content-visibility: auto;
  contain-intrinsic-size: auto 52px;

  &:hover {
    background: #fafbfc;
  }

  &.rec-open {
    background: #fafbfc;
    cursor: default;
  }

  &.rec-plain {
    cursor: default;
    padding: 6px 10px;
    contain-intrinsic-size: auto 30px;

    &:hover {
      background: #fff;
    }
  }
}

.rec-main {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rec-chev {
  transition: transform 0.15s ease;
}

.rec-open .rec-chev {
  transform: rotate(180deg);
}

.tone-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.chip {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  height: 15px;
  border-radius: 8px;
  background: var(--bg-seg, #eef1f5);
  font-size: 10px;
  font-weight: 600;
  color: var(--text-2);
}

.rec-sep {
  margin: 0 4px;
  color: var(--text-muted);
}

/* 详尽视图：元信息行固定 + 明细限高内滚。展开区最高 ~340px，数千行明细在
   rec-detail-scroll 内滚动（不撑长页面）；overscroll-behavior 防止滚到边界时
   连锁翻动外层页面 */
.rec-detail {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--br-divider);
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 340px;
}

.rec-detail-scroll {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 11px;
  color: var(--text-3);
}

.grp {
  display: flex;
  flex-direction: column;
  gap: 3px;

  &.grp-err {
    border-top: 1px dashed var(--br-divider);
    padding-top: 8px;
  }
}

.grp-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
}

.op-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  line-height: 1.5;
  min-width: 0;
  /* 明细行级虚拟滚动：数千行的展开区内只渲染滚动位置附近的行 */
  content-visibility: auto;
  contain-intrinsic-size: auto 18px;

  .op-text {
    color: var(--text-2);
    white-space: nowrap;
  }

  .op-rel {
    color: var(--text-muted);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .op-bytes {
    color: var(--text-muted);
    white-space: nowrap;
    font-size: 10px;
  }
}

.note-line {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.5;
}
</style>
