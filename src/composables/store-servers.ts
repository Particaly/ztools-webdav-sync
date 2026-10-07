/* eslint-disable */
// store-servers.ts —— 服务器 / 账号域：多服务器列表的
// 规范化与增删切换。state.server 恒指向 servers 内的活跃代理条目（别名一致性由
// normalizeServers / setActiveServer 维护）。
import type { DavConfig, DavServerEntry, SyncDir } from '../env.d'
import { state, schedulePersist, uid, persist, isPluginSyncDir } from './store-core'
import { toast } from './toast'


// ---------- 服务器列表（多账号 / 多服务器） ----------

/** 服务器条目的展示名：显式名称优先，缺省按地址推断 host（再缺省「服务器 N」） */
export function serverLabel(sv: DavServerEntry, idx = 0): string {
  if (sv.name && sv.name.trim()) return sv.name.trim()
  const u = String(sv.serverUrl || '').trim()
  if (u) {
    try {
      return new URL(u).hostname
    } catch {
      return u
    }
  }
  return `服务器 ${idx + 1}`
}

/** 确保服务器列表至少一条且 state.server 指向活跃条目（init 与增删后统一收口） */
export function normalizeServers(activeId?: string): void {
  if (!state.servers.length) {
    state.servers.push({ id: uid(), name: '', serverUrl: '', username: '', password: '' })
  }
  const hit = activeId && state.servers.find((s) => s.id === activeId)
  state.activeServerId = (hit || state.servers[0]).id
  state.server = state.servers.find((s) => s.id === state.activeServerId) || state.servers[0]
}

/**
 * 切换活跃服务器（设置页下拉 / 主界面卡片）：连接状态指示按新服务器归零
 *（connected / 档位 / 配额都是旧服务器的观测值，不得串显），随后由启动探测
 * 或用户测试重建。切换只影响编辑视图与主界面卡片展示 —— 各同步目录的
 * serverId 不变，照常使用各自的服务器。
 */
export function setActiveServer(id: string): void {
  const hit = state.servers.find((s) => s.id === id)
  if (!hit || id === state.activeServerId) return
  state.activeServerId = id
  state.server = hit
  state.connected = false
  state.connChecked = false
  state.testResult = null
  state.capabilities = null
  state.quota = null
  // 立即 persist（不防抖）：activeServerId 唯一的写路径，servers watch 只序列化
  // 列表内容、覆盖不到该字段 —— 防抖窗口内宿主关闭 / 崩溃会丢掉这次切换；且
  // 切换是一次性点击，没有连续编辑可合并
  persist()
}

/** 添加服务器：空白条目入列并切换为活跃（设置页立即开始填写新服务器） */
export function addServer(): void {
  const entry: DavServerEntry = { id: uid(), name: '', serverUrl: '', username: '', password: '' }
  state.servers.push(entry)
  state.activeServerId = entry.id
  state.server = entry
  state.connected = false
  state.connChecked = false
  state.testResult = null
  state.capabilities = null
  state.quota = null
  // 防抖即可：push 会触发 servers watch 的防抖 persist；这里显式再排一次是为
  // activeServerId 的同步改写（watch 覆盖不到该字段）—— 与 watch 共用同一挂起
  // timer，合并为一次落盘，不会双重深克隆
  schedulePersist()
}

/**
 * 删除服务器：最后一台不可删（形态退化为空白可编辑条目）；仍有同步目录使用
 *（显式 serverId 指向它，或目录未写 serverId 而它是第一台 —— 删除会让这些
 * 目录静默改连另一台服务器）时明确拒绝并提示先改挂其他服务器。删除的是配置
 * 条目，不影响电脑与云端文件。
 */
export function removeServer(id: string): void {
  if (state.servers.length <= 1) {
    toast.warning('至少保留一台服务器', '可以清空地址与账号来停用这台服务器')
    return
  }
  const idx = state.servers.findIndex((s) => s.id === id)
  if (idx < 0) return
  const isFirst = idx === 0
  const used = state.dirs.filter((d) => !isPluginSyncDir(d) && (d.serverId === id || (d.serverId == null && isFirst)))
  if (used.length) {
    toast.warning('这台服务器正在被使用', `有 ${used.length} 个同步文件夹使用它，请先在这些文件夹的设置里改用其他服务器`)
    return
  }
  state.servers.splice(idx, 1)
  normalizeServers()
  // 防抖即可：splice 触发 servers watch 的防抖 persist；显式再排一次是为
  // normalizeServers 可能改写的 activeServerId（watch 覆盖不到该字段），共用挂起 timer
  schedulePersist()
}

/** 目录生效的服务器条目（dirEngineCfg 与 UI 展示共用）：serverId 显式指向优先，缺省回落第一台（与调度器 serverEntryOf 同口径） */
export function serverOfDir(d: SyncDir): DavServerEntry {
  const hit = (d.serverId && state.servers.find((s) => s.id === d.serverId)) || null
  return hit || state.servers[0] || state.server
}


