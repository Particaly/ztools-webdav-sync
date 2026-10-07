/* eslint-disable */
// store-connection.ts —— 连接探测域：testConnection /
// 重新探测 / 功能测试目录确认。探测结论（连通性 / 档位 / 配额）写回 state。
import { state, suggestRemote, tierLabel, tierHint, type TestResult } from './store-core'
import { toast } from './toast'
import type { DavCapabilities, DavTier } from '../env.d'


// ---------- 连接 ----------

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
      // 附带能力摘要按已选测试目录取（未选择时为基址），档位展示口径与「功能测试」一致
      result = await window.services.dav.testConnection(state.server, state.prefs.probeRemoteDir || undefined)
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
    else toast.error('连接失败', result.error || '连不上服务器，请检查地址、用户名和密码')
  }
  return result
}

/**
 * 重新探测服务器能力与档位（设置页「功能测试」入口）。
 * 复用 preload 的 probeCapabilities(cfg, force=true, remotePath)：忽略缓存现场实测，
 * 结果写回 state.capabilities 并以通知反馈档位结论。
 * 探测目标为用户指定的测试目录（prefs.probeRemoteDir）—— WebDAV 服务器不同子树
 * 的写权限可能不同，根目录不一定可写，写权限必须按用户认可的目录实测；尚未选择
 * 测试目录时（首次功能测试）先弹远端目录选择器，确认后自动开始本次测试。
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
  if (!state.prefs.probeRemoteDir) {
    state.showProbeDirPicker = true
    return
  }
  state.probing = true
  try {
    const caps = await window.services.dav.probeCapabilities({ ...state.server }, true, state.prefs.probeRemoteDir)
    state.capabilities = caps
    toast.success(`检测完成：${tierLabel(caps.tier)}`, tierHint(caps.tier))
  } catch (e) {
    toast.error('检测失败', e instanceof Error ? e.message : String(e))
  } finally {
    state.probing = false
  }
}

/**
 * 确认功能测试目录（首次功能测试的选择与设置页「修改测试目录」共用入口）。
 * 写入 prefs.probeRemoteDir（经 prefs 深度 watch 自动持久化）并立即以新目录执行
 * 一次功能测试 —— 换目录的动机通常是原目录不可写，当场重测直接给出结论；
 * 选择了相同目录时只关闭弹窗，不重复发起探测。
 * @param path 远端目录选择器回传的绝对路径（以 / 开头；容错补齐缺省的起始斜杠）
 */
export function confirmProbeDir(path: string) {
  state.showProbeDirPicker = false
  const p = String(path || '').trim()
  if (!p || p === state.prefs.probeRemoteDir) return
  state.prefs.probeRemoteDir = p.startsWith('/') ? p : '/' + p
  void reprobe()
}
