/* eslint-disable */
// store-connection.ts —— 连接探测域：testConnection /
// 重新探测 / 测试目录自动解析。探测结论（连通性 / 档位 / 配额）写回 state。
import { state, tierLabel, tierHint, isPluginSyncDir, type TestResult } from './store-core'
import { toast } from './toast'
import type { DavCapabilities, DavTier, SyncDir } from '../env.d'


// ---------- 连接 ----------

/**
 * 解析功能测试的目标远端目录（测试目录配置已移除，每次按当前数据动态推导）：
 *   1. 当前服务器下「已成功同步」的目录（status='synced'，最近同步的优先）——
 *      该目录确定存在于云端且刚刚被写入过，是最可靠的实测目标；
 *   2. 其余已创建的同步目录（同上按最近同步排序）—— 路径经用户认可，只是尚无
 *      成功同步记录；
 *   3. 默认云端文件夹（prefs.defaultRemoteDir）—— 添加目录时的缺省位置；
 *   4. 都没有时返回 ''，调用方提示先添加一个同步目录。
 * 只看当前活跃服务器的目录（serverId 显式指向，或未写 serverId 且活跃即第一台
 * —— 与 removeServer / serverOfDir 的归属口径一致）：探测请求发往活跃服务器，
 * 其他服务器的目录路径对它没有意义。插件同步虚拟行不参与。
 */
export function resolveProbeDir(): string {
  const isFirst = state.servers[0]?.id === state.activeServerId
  const mine = state.dirs.filter(
    (d: SyncDir) => !isPluginSyncDir(d) && (d.serverId === state.activeServerId || (d.serverId == null && isFirst))
  )
  // 按最近同步时间降序（从未同步的排后面），同分保持列表顺序
  const byRecency = (a: SyncDir, b: SyncDir) => (b.lastSyncAt ?? 0) - (a.lastSyncAt ?? 0)
  const synced = mine.filter((d) => d.status === 'synced').sort(byRecency)
  const rest = mine.filter((d) => d.status !== 'synced').sort(byRecency)
  const hit = synced[0] ?? rest[0]
  const p = (hit?.remotePath || state.prefs.defaultRemoteDir || '').trim()
  return p ? (p.startsWith('/') ? p : '/' + p).replace(/\/+$/, '') || '/' : ''
}

/** 测试连接结果（附带档位与能力摘要，字段向后兼容） */

/**
 * 测试连接（设置页 / 主界面卡片按钮）。
 * 结果会回写 state（testResult / connected / capabilities）并默认弹顶部通知：
 * 成功展示延迟，失败展示原因；preload 抛出的异常也兜底为失败通知。
 * @param opts.notify 结果是否以顶部通知反馈，启动时的自动探测传 false 静默执行
 */
export async function testConnection(opts?: { notify?: boolean }): Promise<TestResult> {
  const notify = opts?.notify !== false

  // 未填地址：直接提示，不打扰后端
  if (!state.server.serverUrl.trim()) {
    if (notify) toast.warning('请先填写服务器地址', '填写服务器地址后才能测试连接')
    return { ok: false, error: '未填写服务器地址' }
  }

  let result: TestResult
  if (!window.services) {
    // 纯浏览器预览（无 preload）时的模拟
    await new Promise((r) => setTimeout(r, 400))
    const ok = state.server.serverUrl.startsWith('https://')
    result = ok ? { ok: true, latencyMs: 128 } : { ok: false, error: '服务器返回 HTTP 401' }
  } else {
    state.testing = true
    try {
      // 附带能力摘要按解析出的测试目录取（无可用目录时为基址），档位展示口径与「功能测试」一致
      result = await window.services.dav.testConnection(state.server, resolveProbeDir() || undefined)
    } catch (e) {
      // 网络异常等 preload 抛错同样要给出可见反馈，而不是静默失败
      result = { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      state.testing = false
    }
  }

  state.testResult = result
  state.connected = result.ok
  state.connChecked = true
  // 保存最近一次探测结果（档位展示来源；探测失败保留 null）
  if (result.capabilities) state.capabilities = result.capabilities
  // 云端配额随连接测试刷新（服务器未返回 / 探测失败 → null，卡片不展示）
  state.quota = result.quota ?? null

  if (notify) {
    if (result.ok) toast.success('连接成功', `服务器响应 ${result.latencyMs ?? 0} 毫秒`)
    else toast.error('连接失败', result.error || '无法连接服务器，请检查地址、用户名和密码')
  }
  return result
}

/**
 * 重新探测服务器能力与档位（设置页「功能测试」入口）。
 * 复用 preload 的 probeCapabilities(cfg, force=true, remotePath)：忽略缓存现场实测，
 * 结果写回 state.capabilities 并以通知反馈档位结论。
 * 探测目标由 resolveProbeDir 动态解析（测试目录已无手动配置）：优先已成功同步的
 * 云端目录 —— 该目录确定存在且写入过，实测口径最贴近真实同步；无任何可用目录
 * （无同步目录且未设置默认云端文件夹）时提示先添加一个同步目录。
 */
export async function reprobe(): Promise<void> {
  if (!state.server.serverUrl.trim()) {
    toast.warning('请先填写服务器地址', '填写服务器地址后才能检测服务器')
    return
  }
  if (!window.services) {
    toast.warning('当前环境不可用', '浏览器预览模式没有连接服务器的能力')
    return
  }
  const probeDir = resolveProbeDir()
  if (!probeDir) {
    toast.warning('请先添加一个同步目录', '功能测试需要一个云端文件夹实测写权限；添加同步目录（或设置默认云端文件夹）后即可检测')
    return
  }
  state.probing = true
  try {
    const caps = await window.services.dav.probeCapabilities({ ...state.server }, true, probeDir)
    state.capabilities = caps
    toast.success(`检测完成：${tierLabel(caps.tier)}`, tierHint(caps.tier))
  } catch (e) {
    toast.error('检测失败', e instanceof Error ? e.message : String(e))
  } finally {
    state.probing = false
  }
}
