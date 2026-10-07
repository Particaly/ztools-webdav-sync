<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { AppButton, AppModal } from './ui'
import { useStore } from '../composables/store'
import { fmtBytes, relBaseName } from '../composables/format'
import type { SyncDir } from '../env.d'

/**
 * 选择性同步树（勾选弹窗）：对远端同步根做一次完整扫描（services.dav.listTree，
 * 不做任何排除 —— 已被排除的条目也要可见，勾回去的前提），按目录树勾选「哪些
 * 同步 / 哪些不同步」。勾选结果以精确 rel 列表落地到 dir.overrides.excludeRels
 *（引擎侧 compileSyncExcludes：字面精确匹配 + 祖先目录命中即整棵子树排除），
 * 与 glob 排除规则（设置页 / 同步设置）互不替代、合并生效。
 *
 * 状态语义（与引擎的祖先排除口径一致，Dropbox 式）：
 *   - 取消勾选一个目录 = 整棵子树不同步（子节点展示为灰置未勾选）；
 *   - 勾选灰置的子节点 = 它的全部祖先恢复勾选（引擎没有「父关子开」的中间态），
 *     兄弟节点的取消状态保持不变；
 *   - 扫描不完整（部分目录列举失败 / 根缺失）时禁用树 —— 残缺清单上勾选会把
 *     「没列出来」误判成「不用同步」。
 */

const props = defineProps<{ dir: SyncDir }>()
const emit = defineEmits<{ close: [] }>()

const store = useStore()

/** 树节点（entries → 层级结构；rel 为远端相对路径，原始字节形态 —— 与引擎排除匹配同源） */
interface TreeNode {
  rel: string
  name: string
  isDir: boolean
  size: number
  children: TreeNode[]
  /** 展开状态（仅目录；默认收起，根层默认展开） */
  open: boolean
}

const loading = ref(true)
/** 扫描结论：null = 失败（showError 展示）；complete=false = 不完整（禁用树） */
const tree = ref<TreeNode[] | null>(null)
const complete = ref(true)
const errors = ref<Array<{ rel: string; message: string }>>([])
const showError = ref('')
/** 「取消同步」集合（祖先命中即整棵子树排除；与 dir.overrides.excludeRels 同形） */
const off = ref<Set<string>>(new Set())
/** 已有的 glob 排除规则条数（树上不展示，但仍然生效 —— 提示避免「勾了还不同步」的困惑） */
const globRuleCount = computed(() => {
  const o = props.dir.overrides
  const rules = Array.isArray(o?.excludePatterns) ? o.excludePatterns : store.state.prefs.excludePatterns
  return Array.isArray(rules) ? rules.length : 0
})

/** 由扫描 entries 建树：缺失的父目录按需合成（空目录 / 隐藏父目录下的可见文件） */
function buildTree(
  entries: Array<{ rel: string; isDir: boolean; size: number }>,
  ignoreHidden: boolean
): TreeNode[] {
  const byRel = new Map<string, TreeNode>()
  const root: TreeNode[] = []
  const hidden = (rel: string) => ignoreHidden && rel.split('/').some((seg) => seg.startsWith('.'))
  const ensureDir = (rel: string): TreeNode => {
    let node = byRel.get(rel)
    if (node) return node
    node = { rel, name: relBaseName(rel), isDir: true, size: 0, children: [], open: false }
    byRel.set(rel, node)
    const i = rel.lastIndexOf('/')
    if (i < 0) root.push(node)
    else ensureDir(rel.slice(0, i)).children.push(node)
    return node
  }
  for (const e of entries) {
    if (hidden(e.rel)) continue
    const node: TreeNode = { rel: e.rel, name: relBaseName(e.rel), isDir: e.isDir, size: e.size, children: [], open: false }
    byRel.set(e.rel, node)
    const i = e.rel.lastIndexOf('/')
    if (i < 0) root.push(node)
    else ensureDir(e.rel.slice(0, i)).children.push(node)
  }
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, 'zh-Hans-CN')))
    for (const n of nodes) if (n.children.length) sortRec(n.children)
  }
  sortRec(root)
  return root
}

async function load() {
  loading.value = true
  showError.value = ''
  tree.value = null
  // 窄化到局部常量再进 try：无 preload（浏览器预览）时按加载失败收场，与原先
  // 直取抛错进 catch 的路径同去处
  const services = window.services
  if (!services) {
    showError.value = '浏览器预览模式没有连接服务器的能力'
    loading.value = false
    return
  }
  try {
    const r = await services.dav.listTree(store.dirEngineCfg(props.dir), props.dir.remotePath, store.dirSyncPrefs(props.dir).ignoreHidden)
    complete.value = r.complete === true
    errors.value = r.errors || []
    tree.value = buildTree(r.entries || [], store.dirSyncPrefs(props.dir).ignoreHidden)
    off.value = new Set(Array.isArray(props.dir.overrides?.excludeRels) ? props.dir.overrides!.excludeRels! : [])
  } catch (e) {
    showError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(
  () => props.dir.id,
  () => void load(),
  { immediate: true }
)

/** rel 是否被取消同步（自身或任一祖先在取消集合中 —— 与引擎祖先排除同口径） */
function isOff(rel: string): boolean {
  let cur = rel
  for (;;) {
    if (off.value.has(cur)) return true
    const i = cur.lastIndexOf('/')
    if (i < 0) return false
    cur = cur.slice(0, i)
  }
}
/** 目录自身未取消、但祖先被取消（灰置展示：跟随祖先的取消状态） */
function isInheritedOff(rel: string): boolean {
  let cur = rel
  for (;;) {
    const i = cur.lastIndexOf('/')
    if (i < 0) return false
    cur = cur.slice(0, i)
    if (off.value.has(cur)) return true
  }
}

function toggle(node: TreeNode) {
  if (!complete.value) return
  const next = new Set(off.value)
  if (isOff(node.rel)) {
    // 勾选：移除自身与全部祖先的取消标记（祖先必须恢复，引擎没有「父关子开」）；
    // 兄弟节点已勾选的取消状态不动 —— isOff 只在祖先链上，删除精确按键即可
    let cur = node.rel
    for (;;) {
      next.delete(cur)
      const i = cur.lastIndexOf('/')
      if (i < 0) break
      cur = cur.slice(0, i)
    }
  } else {
    // 取消：登记自身；已在集合中的后代条目清掉（父级取消已覆盖，保持列表最小）
    next.add(node.rel)
    const prefix = node.rel + '/'
    for (const k of Array.from(next)) if (k.startsWith(prefix)) next.delete(k)
  }
  off.value = next
}

/** 取消同步的条目数（自身登记数；展示口径 —— 子树覆盖数由引擎祖先语义承担） */
const offCount = computed(() => off.value.size)

function save() {
  store.setDirOverrides(props.dir.id, { excludeRels: Array.from(off.value).sort() })
  emit('close')
}

/** 展开层级的扁平可见行（折叠的子树不渲染 —— 数万条目的树只渲染展开部分） */
interface FlatRow {
  node: TreeNode
  depth: number
}
const flatRows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ node: n, depth })
      if (n.isDir && n.open && n.children.length) walk(n.children, depth + 1)
    }
  }
  if (tree.value) walk(tree.value, 0)
  return out
})
</script>

<template>
  <AppModal :title="'选择性同步'" :subtitle="dir.name" :width="460" @close="emit('close')">
    <template #icon>
      <AppIcon name="folder" :size="14" class="text-primary" />
    </template>

    <div class="flex flex-col gap-3">
      <p class="text-[12px] leading-[1.7] text-ink-2">
        取消勾选的文件夹和文件不会同步 —— 既不上传到云端，也不下载到电脑；重新勾选后恢复同步。改动在下次同步时生效。
      </p>

      <!-- 扫描中 / 失败 / 不完整 -->
      <div v-if="loading" class="flex items-center justify-center gap-2 py-10 text-[12px] text-ink-3">
        <AppIcon name="refresh" :size="14" class="spin" />
        正在读取云端文件列表…
      </div>
      <div v-else-if="showError" class="flex flex-col items-center gap-3 py-8">
        <AppIcon name="warn" :size="20" class="text-warning-icon" />
        <p class="text-[12px] text-ink-2">{{ showError }}</p>
        <AppButton variant="secondary" @click="load">重试</AppButton>
      </div>
      <div v-else-if="!complete" class="flex flex-col gap-2">
        <div class="flex items-start gap-2 rounded-md bg-[var(--amber-bg)] px-3 py-2">
          <AppIcon name="warn" :size="13" class="text-warning-icon shrink-0 mt-[1px]" />
          <p class="text-[11px] leading-[1.7] text-warning-icon">
            云端文件列表这次没有读完整，暂时不能勾选。请稍后重试；如果一直这样，先在设置里「测试连接」排查。
          </p>
        </div>
        <p class="text-[11px] text-ink-3 truncate" :title="(errors[0] && errors[0].message) || ''">
          {{ (errors[0] && errors[0].message) || '' }}
        </p>
      </div>

      <!-- 勾选树（懒展开：折叠子树不渲染，数万条目只画展开部分） -->
      <template v-else>
        <div class="tree-box">
          <div v-if="!flatRows.length" class="py-8 text-center text-[12px] text-ink-3">云端还没有文件</div>
          <div
            v-for="row in flatRows"
            :key="row.node.rel"
            class="tree-row"
            :class="{ dim: isInheritedOff(row.node.rel) }"
            :style="{ paddingLeft: `${8 + row.depth * 16}px` }"
          >
            <!-- 目录展开箭头 -->
            <button v-if="row.node.isDir" type="button" class="twist" @click="row.node.open = !row.node.open">
              <AppIcon :name="row.node.open ? 'chevron-down' : 'chevron-right'" :size="11" />
            </button>
            <span v-else class="twist" />
            <!-- toggle 只绑 label：input 点击/空格的合成 click 会冒泡到 label，双绑会一加一减互相抵消；
                 label 的 .prevent 阻止把点击转发给内部 input 的默认行为，勾选状态以 :checked 为唯一来源 -->
            <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-[6px]" @click.prevent="toggle(row.node)">
              <input type="checkbox" class="tree-check" :checked="!isOff(row.node.rel)" :disabled="!complete" />
              <AppIcon :name="row.node.isDir ? 'folder' : 'file'" :size="12" class="shrink-0 text-ink-4" />
              <span class="truncate text-[12px] text-ink-1">{{ row.node.name }}</span>
              <span v-if="!row.node.isDir && row.node.size" class="ml-auto shrink-0 text-[10px] text-ink-4">{{ fmtBytes(row.node.size) }}</span>
            </label>
          </div>
        </div>
        <p v-if="offCount > 0" class="text-[11px] text-ink-3">已选择不同步 {{ offCount }} 项</p>
        <p v-if="globRuleCount > 0" class="text-[11px] text-ink-3">
          另有 {{ globRuleCount }} 条手动排除规则在设置里配置，它们仍然生效（树上不展示）。
        </p>
      </template>
    </div>

    <template #footer>
      <AppButton variant="ghost" @click="emit('close')">取消</AppButton>
      <AppButton :disabled="loading || !!showError || !complete" @click="save">保存</AppButton>
    </template>
  </AppModal>
</template>

<style scoped lang="scss">
.tree-box {
  max-height: 300px;
  overflow: auto;
  border: 1px solid var(--border-card);
  border-radius: 8px;
  padding: 6px 4px;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 26px;
  border-radius: 5px;
  padding-right: 8px;

  &:hover {
    background: var(--bg-fill-track);
  }

  &.dim {
    .tree-row-name,
    .text-ink-1 {
      color: var(--text-4);
    }
  }
}

.twist {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-4);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}

.tree-check {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  accent-color: var(--primary);
  cursor: pointer;
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
