<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { AppButton, AppModal } from './ui'
import { useStore, dirRootLostOpen } from '../composables/store'
import { fmtRelTime, fmtBytes } from '../composables/format'
import type { DeleteBatchNode, DeleteScope, SyncDir } from '../env.d'

/**
 * 待处理挂起面板（三类记录统一处理）：
 * ① 冲突：后台（interval/watch）轮的冲突一律 defer 挂起，轮末经系统通知提醒一次；
 *    用户回窗口后在此逐条三选一（本地 / 云端 / 两边都留，= setPendingChoice，
 *    下一轮自动落地）或「暂时忽略」（= clearPendingConflict，该文件再冲突时才重新询问）。
 * ② 删除确认（批量快照 deleteBatch）：单轮待删超过安全阈值时引擎拦截并构建聚合
 *    目录树快照 —— 按目录结构展示，逐节点「不删除 / 确认删除」（= setDeleteScope
 *    落范围决策，天然覆盖逐文件挂起表 500 条上限装不下的部分），底部「全部」按钮
 *    作用于整批（空前缀 scope）。快照缺失（旧数据 / 单文件挂起未到阈值）时退回
 *    逐文件扁平列表（同走 setDeleteScope 单文件范围），保证有挂起必有决策入口。
 * ③ 「云端文件夹丢失」决策（kind='root-lost'）是目录级决策，不在本面板逐条列出，
 *    顶部提供「去处理」入口跳转专门弹窗。
 * 长列表：冲突数据侧已限长（store 按 200 条截断）；删除树节点引擎侧有
 * MAX_BATCH_NODES 上限（深层折叠进父目录聚合计数），渲染侧再分批 —— 默认只
 * 渲染前 50 条，「显示更多」按批展开。本组件渲染在 DirRow 内（位于 relative +
 * overflow 列表容器里），AppModal 的 absolute 遮罩会被钉在列表区域内 —— 与
 * DirFormModal 同款处理：Teleport 到 body，遮罩覆盖整个插件窗口。
 */
const props = defineProps<{ dir: SyncDir }>()
const open = defineModel<boolean>('open', { default: false })

const store = useStore()

/** 打开时刷新一次（事件外兜底：处理动作可能来自其他入口），并重置分批展开 */
watch(open, (v) => {
  if (v) {
    shownCount.value = PAGE_SIZE
    void store.refreshPendingConflicts(props.dir)
  }
})

/** 批量删除快照（null = 无快照：无未决策删除，或快照读取失败走扁平兜底） */
const batch = computed(() => props.dir.deleteBatch ?? null)

/** 逐条列表只承载冲突与根丢失入口；删除确认走快照目录树（扁平兜底见下） */
const items = computed(() => (props.dir.pendingConflicts ?? []).filter((p) => p.kind !== 'root-lost' && p.kind !== 'delete'))
/** 未决策的「云端文件夹丢失」挂起（顶部入口的显示条件） */
const rootLostOpen = computed(() => dirRootLostOpen(props.dir))

function goRootLost() {
  open.value = false
  store.state.rootLostPromptDirId = props.dir.id
}
/** 未处理（无 choice）冲突条目：批量「应用到剩余」的目标 */
const openConflictItems = computed(() => items.value.filter((p) => !p.choice))

// ---------- 删除确认：目录树（快照） ----------

/** 树节点（渲染行）：快照节点 + 层级深度 + 命中的范围决策状态 */
interface TreeRow {
  rel: string
  name: string
  isDir: boolean
  files: number
  bytes: number
  depth: number
  /** 该节点命中（或随上级命中）的范围决策；null = 未决策 */
  scope: DeleteScope | null
  /** 命中的 scope 是否精确作用于本节点（决定徽标文案：已选 vs 已随上级处理） */
  exact: boolean
}

/** 命中某 rel 的最具体（最长前缀）范围决策；无命中返回 null（引擎同款匹配规则） */
function scopeFor(scopes: DeleteScope[], rel: string): DeleteScope | null {
  let best: DeleteScope | null = null
  for (const s of scopes) {
    const hit = s.prefix === '' || s.prefix === rel || rel.startsWith(s.prefix + '/')
    if (hit && (!best || s.prefix.length > best.prefix.length)) best = s
  }
  return best
}

/** 展开状态（目录默认收起，点按展开一层；键为目录 rel） */
const expanded = ref(new Set<string>())
function toggleExpand(rel: string) {
  const next = new Set(expanded.value)
  if (next.has(rel)) next.delete(rel)
  else next.add(rel)
  expanded.value = next
}
const isExpanded = (rel: string) => expanded.value.has(rel)

/**
 * 快照节点 → 渲染行（按展开状态摊平 + 状态标注）。引擎产出顺序为「目录先于其
 * 子节点、同层目录在前文件在后」的深度优先序 —— 父节点必先出现在列表里，按 rel
 * 直接挂接父子；已决策（命中 scope）的节点收拢为其子树的一行（子节点不再展示）。
 * 顶层恒可见；子层仅在父目录展开时下钻（展开集合驱动，默认全部收起）。
 */
const treeRows = computed<TreeRow[]>(() => {
  const b = batch.value
  if (!b) return []
  type TreeRowNode = TreeRow & { children: TreeRowNode[] }
  const byRel = new Map<string, TreeRowNode>()
  const roots: TreeRowNode[] = []
  for (const n of b.nodes) {
    const slash = n.rel.lastIndexOf('/')
    const parentRel = slash < 0 ? '' : n.rel.slice(0, slash)
    const parent = slash < 0 ? null : byRel.get(parentRel)
    const hit = scopeFor(b.scopes, n.rel)
    const row: TreeRowNode = {
      rel: n.rel,
      name: n.rel.slice(slash + 1),
      isDir: n.isDir,
      files: n.files,
      bytes: n.bytes,
      depth: slash < 0 ? 0 : parentRel.split('/').length,
      scope: hit,
      exact: !!hit && hit.prefix === n.rel,
      children: [],
    }
    byRel.set(n.rel, row)
    if (parent) parent.children.push(row)
    else roots.push(row)
  }
  const rows: TreeRow[] = []
  const walk = (list: TreeRowNode[]) => {
    for (const r of list) {
      rows.push(r)
      if (r.scope || !r.children.length) continue
      if (!isExpanded(r.rel)) continue
      walk(r.children)
    }
  }
  walk(roots)
  return rows
})

/** 子层是否已在快照里（目录节点可能有 children；折叠目录 / 叶子没有） */
const hasChildren = (row: TreeRow): boolean => {
  const b = batch.value
  if (!b || !row.isDir || row.scope) return false
  const prefix = row.rel + '/'
  return b.nodes.some((n: DeleteBatchNode) => n.rel.startsWith(prefix))
}

/** 快照缺列时的兜底：未决策的逐文件删除记录（扁平展示，单文件范围决策） */
const flatDeleteItems = computed(() =>
  batch.value ? [] : (props.dir.pendingConflicts ?? []).filter((p) => p.kind === 'delete' && !p.choice)
)

/** 未决策删除总数（快照 undecided 为引擎真值；无快照退回记录口径） */
const deleteUndecided = computed(() => batch.value?.undecided ?? flatDeleteItems.value.length)

/** 渲染分批（长列表限长）：每批 50 条，展开按钮出现在列表底部 */
const PAGE_SIZE = 50
const shownCount = ref(PAGE_SIZE)

const choiceLabel: Record<string, string> = {
  local: '保留电脑版本',
  remote: '保留云端版本',
  both: '两个都留',
  delete: '确认删除',
  keep: '不删除',
}

function applyOne(rel: string, choice: 'local' | 'remote' | 'both') {
  void store.applyPendingChoices(props.dir, [rel], choice)
}

function applyConflicts(choice: 'local' | 'remote' | 'both') {
  void store.applyPendingChoices(props.dir, openConflictItems.value.map((p) => p.rel), choice)
}

/** 目录树节点决策（含底部「全部」= 空前缀范围） */
function applyScope(rel: string, choice: 'delete' | 'keep') {
  void store.applyDeleteScope(props.dir, rel, choice)
}

function ignore(rel: string) {
  void store.ignorePendingConflict(props.dir, rel)
}

const subtitle = computed(() => {
  const parts: string[] = []
  if (openConflictItems.value.length) parts.push(`${openConflictItems.value.length} 个文件等你选择保留哪个`)
  if (deleteUndecided.value) parts.push(`${deleteUndecided.value} 项删除等你确认（确认前不会删除任何文件）`)
  if (!parts.length) return '没有待处理的记录'
  return `${parts.join('；')}（下次同步时生效）`
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal-pop">
      <AppModal
        v-if="open"
        :title="`${dir.name}：待处理`"
        :subtitle="subtitle"
        :width="460"
        @close="open = false"
      >
    <div class="flex flex-col gap-[8px] max-h-[320px] overflow-y-auto">
      <!-- 云端文件夹丢失：目录级决策入口（不在逐条列表内） -->
      <div v-if="rootLostOpen" class="item rootlost-item">
        <AppIcon name="warn" :size="13" class="shrink-0 text-danger" />
        <span class="flex-1 min-w-0 text-[11px] leading-[1.4] text-[#b3261e]">云端的同步文件夹不见了，同步已暂停，等你确认怎么处理</span>
        <button type="button" class="act" @click="goRootLost">去处理</button>
      </div>

      <!-- 删除确认：目录树（快照承载，按目录决策；「全部」按钮见底部） -->
      <template v-if="treeRows.length">
        <div v-for="row in treeRows.slice(0, shownCount)" :key="row.rel" class="item tree-row" :style="{ paddingLeft: `${10 + row.depth * 14}px` }">
          <button
            v-if="row.isDir && !row.scope && hasChildren(row)"
            type="button"
            class="tw"
            :title="isExpanded(row.rel) ? '收起' : '展开'"
            @click="toggleExpand(row.rel)"
          >
            <AppIcon :name="isExpanded(row.rel) ? 'chevron-down' : 'chevron-right'" :size="11" />
          </button>
          <AppIcon v-else-if="row.isDir && !row.scope" name="folder" :size="12" class="tw-spacer text-ink-4" />
          <span v-else class="tw-spacer" />
          <div class="min-w-0 flex-1 flex flex-col gap-[2px]">
            <span class="font-mono text-[12px] text-ink-1 truncate" :class="{ 'text-ink-2': row.scope }" :title="row.rel">
              {{ row.name }}<span v-if="row.isDir" class="text-ink-4">/</span>
            </span>
            <span class="text-[11px] text-ink-4">
              {{ row.isDir ? `${row.files} 个文件` : '1 个文件' }}<template v-if="row.bytes > 0"> · {{ fmtBytes(row.bytes) }}</template>
            </span>
          </div>
          <span v-if="row.scope" class="shrink-0 inline-flex items-center gap-[4px] text-[11px]" :class="row.scope.choice === 'keep' ? 'text-success' : 'text-danger'">
            <AppIcon :name="row.scope.choice === 'keep' ? 'check-circle' : 'warn'" :size="12" />
            {{ row.exact ? (row.scope.choice === 'keep' ? '已选不删除' : '已选删除') : `已随「${row.scope.prefix || '全部'}」处理` }}
          </span>
          <div v-else class="flex items-center gap-[6px] shrink-0">
            <button type="button" class="act" @click="applyScope(row.rel, 'keep')">不删除</button>
            <button type="button" class="act danger" @click="applyScope(row.rel, 'delete')">删除</button>
          </div>
        </div>
        <button v-if="treeRows.length > shownCount" type="button" class="more-btn" @click="shownCount += PAGE_SIZE">
          显示更多（{{ Math.min(shownCount, treeRows.length) }} / {{ treeRows.length }} 行）
        </button>
      </template>

      <!-- 删除确认兜底：无快照但有逐文件记录（扁平列表，单文件范围决策） -->
      <template v-else-if="flatDeleteItems.length">
        <div v-for="it in flatDeleteItems.slice(0, shownCount)" :key="it.rel" class="item">
          <div class="min-w-0 flex-1 flex flex-col gap-[2px]">
            <span class="font-mono text-[12px] text-ink-1 truncate" :title="it.rel">{{ it.rel }}</span>
            <span class="text-[11px] text-ink-4">等你确认删除 · 发现于 {{ fmtRelTime(it.createdAt) }}</span>
          </div>
          <div class="flex items-center gap-[6px] shrink-0">
            <button type="button" class="act" @click="applyScope(it.rel, 'keep')">不删除</button>
            <button type="button" class="act danger" @click="applyScope(it.rel, 'delete')">删除</button>
          </div>
        </div>
        <button v-if="flatDeleteItems.length > shownCount" type="button" class="more-btn" @click="shownCount += PAGE_SIZE">
          显示更多（{{ Math.min(shownCount, flatDeleteItems.length) }} / {{ flatDeleteItems.length }}）
        </button>
      </template>

      <!-- 冲突：逐条三选一（数据侧限长 200，渲染侧分批） -->
      <div v-for="it in items.slice(0, shownCount)" :key="it.rel" class="item">
        <div class="min-w-0 flex-1 flex flex-col gap-[2px]">
          <span class="font-mono text-[12px] text-ink-1 truncate" :title="it.rel">{{ it.rel }}</span>
          <span class="text-[11px] text-ink-4">{{
            it.choice
              ? `已选「${choiceLabel[it.choice] ?? it.choice}」· 下次同步时生效`
              : `发现于 ${fmtRelTime(it.createdAt)}`
          }}</span>
        </div>
        <div v-if="!it.choice" class="flex items-center gap-[6px] shrink-0">
          <button type="button" class="act" @click="applyOne(it.rel, 'local')">保留电脑版本</button>
          <button type="button" class="act" @click="applyOne(it.rel, 'remote')">保留云端版本</button>
          <button type="button" class="act" @click="applyOne(it.rel, 'both')">两个都留</button>
          <button
            type="button"
            class="act muted"
            title="忽略这条提醒，这个文件再次冲突时才会重新询问"
            @click="ignore(it.rel)"
          >忽略</button>
        </div>
        <span v-else class="shrink-0 inline-flex items-center gap-[4px] text-[11px] text-success">
          <AppIcon name="check-circle" :size="12" bg="var(--green-bg)" />
        </span>
      </div>
      <button v-if="items.length > shownCount" type="button" class="more-btn" @click="shownCount += PAGE_SIZE">
        显示更多（{{ Math.min(shownCount, items.length) }} / {{ items.length }}）
      </button>
    </div>
    <template #footer>
      <div class="flex flex-col gap-[8px] w-full">
        <div v-if="deleteUndecided > 1" class="flex items-center gap-[8px] w-full">
          <span class="text-[11px] text-ink-3 shrink-0">{{ deleteUndecided }} 项删除都这样处理：</span>
          <span class="flex-spacer" />
          <AppButton size="sm" @click="applyScope('', 'keep')">全部不删除</AppButton>
          <AppButton size="sm" variant="danger" @click="applyScope('', 'delete')">全部确认删除</AppButton>
        </div>
        <div v-if="openConflictItems.length > 1" class="flex items-center gap-[8px] w-full">
          <span class="text-[11px] text-ink-3 shrink-0">其余 {{ openConflictItems.length }} 个也都这样处理：</span>
          <span class="flex-spacer" />
          <AppButton size="sm" @click="applyConflicts('local')">保留电脑版本</AppButton>
          <AppButton size="sm" @click="applyConflicts('remote')">保留云端版本</AppButton>
          <AppButton size="sm" variant="primary" @click="applyConflicts('both')">两个都留</AppButton>
        </div>
        <AppButton v-if="!openConflictItems.length && !deleteUndecided" size="sm" @click="open = false">关闭</AppButton>
      </div>
    </template>
      </AppModal>
    </Transition>
  </Teleport>
</template>

<style scoped lang="scss">
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--br-divider);
  border-radius: 7px;
}

/* 根丢失决策入口条：与错误条同色系（红）以区别于逐条记录 */
.rootlost-item {
  border-color: var(--red-strip-br, #f3cfcb);
  background: var(--red-strip-bg, #fdf5f4);
}

/* 目录树行：缩进由行内 style 承载（depth × 14px）；展开钮 / 占位对齐 */
.tree-row {
  .tw {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    color: var(--text-muted);
    transition: background 0.12s ease;

    &:hover {
      background: #f1f3f6;
    }
  }

  .tw-spacer {
    width: 16px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
}

.act {
  border: 1px solid var(--br-divider);
  border-radius: 5px;
  background: transparent;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-1);
  white-space: nowrap;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;

  &:hover {
    background: #f1f3f6;
    border-color: #d3d9df;
  }

  &.muted {
    color: var(--text-muted);
  }

  &.danger {
    color: #b3261e;
    border-color: #ecc8c4;

    &:hover {
      background: #fdf5f4;
      border-color: #e0b4af;
    }
  }
}

/* 分批展开按钮（长列表限长）：弱化的文字按钮，贴在滚动列表底部 */
.more-btn {
  border: 1px solid var(--br-divider);
  border-radius: 5px;
  background: transparent;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--blue);
  align-self: center;
  transition: background 0.12s ease;

  &:hover {
    background: #f1f3f6;
  }
}
</style>
