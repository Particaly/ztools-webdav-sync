/* eslint-disable */
// WebDAV 同步插件 —— ZTools 插件目录同步（实验功能）的发现与描述
//
// 定位：实验开关（prefs.ztoolsPluginSync）开启后，同步列表会出现一条固定 id 的
// 虚拟记录，把本机 ZTools 的插件实体目录（~/.ztools/plugins，asar 文件与插件
// 目录混放）双向同步到云端。本模块是该记录的**单一事实源**：
//   - 本地目录自动发现（对齐 ZTools 宿主 appDataPaths 的解析约定：环境变量
//     ZTOOLS_DATA_ROOT 优先，缺省 ~/.ztools），用户不可修改 —— 宿主 getPath
//     不暴露该目录，preload 的 Node 能力是唯一发现通道；
//   - 远端目录 = 用户可选的父目录（prefs.ztoolsPluginSyncRemoteDir，缺省云端根）
//     之后**固定**跟上 ztools-plugins/<platformKey> 两段：父目录可配置，但后缀
//     恒定 —— 多台设备各选同一个父目录即可互通；插件可能含平台相关的原生
//     二进制，不同平台的设备各用各的远端文件夹，绝不互相同步。
//
// 消费方两处，共用同一份发现结果：
//   - 调度器 loadConfig（scheduler.mts）：开关开启时合成固定 id 的目录配置
//     （slot 与普通目录完全同构，冲突 / 根丢失 / 删除确认 / 租约锁全部复用）；
//   - 渲染层虚拟行（store.ts）：经 services.ztoolsPlugins.describe() 取描述
//     展示（渲染层无 Node 能力，不能直接 import 本模块）。
//
// 本文件是叶子模块：仅依赖 node 内置与 types.mts，被 scheduler.mts 与
// services.mts 同时 import（esbuild 单文件产物 / vitest 直载源码双通道通用）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZTOOLS_PLUGINS_DIR_ID, type ZtoolsPluginsSyncDesc } from './types.mts'

/**
 * 插件同步虚拟记录的固定 id：渲染层列表行、调度器 slot、round-end / 冲突等
 * 事件据此对齐。字面量的单一事实源在 types.mts（前后端共用：渲染层 store.ts
 * 也直接 import 同一常量，不再有字面量镜像）；此处 re-export 保持既有消费方
 *（scheduler.mts 与单元测试）的导入路径不变。
 */
export { ZTOOLS_PLUGINS_DIR_ID }

/**
 * 远端固定后缀（不提供用户配置）：`/ztools-plugins/<platformKey>` 两段恒定地
 * 追加在用户所选父目录之后 —— 「可配置」只到父目录为止，后缀是两侧设备的
 * 通用约定（选同一个父目录即解析出同一远端根），任何对后缀的可配置都会让
 * 不同设备的配置漂移后互相看不到对方的数据。
 */
export const ZTOOLS_PLUGINS_REMOTE_BASE = '/ztools-plugins'

/**
 * 规范化用户所选的云端父目录（ztoolsPluginsRemotePath 的纯函数前半）：
 * 统一正斜杠、去尾斜杠、补起始斜杠；空串 / 根目录视为「未选择」回落云端根。
 * 宽松处理手输形态（'backup'、'/backup/'、'\\backup'），渲染层选择器返回的
 * 绝对路径原样通过。
 * @param remoteBase 用户所选父目录（'' / null / undefined / '/' = 未选择）
 * @returns 规范化后的父目录：''（云端根）或以 / 开头、无尾斜杠的绝对路径
 */
function normalizeRemoteBase(remoteBase: string | null | undefined): string {
  let t = String(remoteBase ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  if (!t || t === '/') return ''
  return t.startsWith('/') ? t : '/' + t
}

/**
 * 组装插件同步的远端根目录（纯函数）：`<父目录>/ztools-plugins/<platformKey>`。
 * 父目录未选择（空 / 根）时即默认的 `/ztools-plugins/<platformKey>`（与历史
 * 行为兼容）；更换父目录后远端基线随 remotePath 键更换 —— 首轮把本机插件
 * 重新上传到新位置，旧位置内容不迁移不删除（与普通目录改远端路径同语义）。
 * @param remoteBase 用户所选父目录（'' / null / undefined = 云端根）
 * @param platformKey 平台目录名（缺省当前平台）
 * @returns 平台隔离的远端同步根（以 / 开头）
 */
export function ztoolsPluginsRemotePath(remoteBase: string | null | undefined, platformKey: string = ztoolsPlatformKey()): string {
  return `${normalizeRemoteBase(remoteBase)}${ZTOOLS_PLUGINS_REMOTE_BASE}/${platformKey}`
}

/**
 * 把 process.platform 映射为远端目录的平台段名（面向用户可读，而非内核三元组）。
 * 未知平台原样使用传入值（保持「不同平台不同目录」的隔离语义，绝不折叠到
 * 某个已知平台目录）。
 * @param platform 平台标识（缺省 process.platform）
 * @returns 平台目录名：darwin → 'mac'，win32 → 'windows'，linux → 'linux'，其余原样
 */
export function ztoolsPlatformKey(platform: string = process.platform): string {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return platform
}

/**
 * 发现本机 ZTools 插件实体目录的绝对路径。
 * 解析顺序与 ZTools 宿主 appDataPaths.getZToolsRoot / getPluginsPath 一致：
 * 环境变量 ZTOOLS_DATA_ROOT 优先（宿主测试 / 自定义数据盘场景），缺省
 * ~/.ztools —— 宿主启动时 ensure3Layout 会确保 plugins 子目录存在。
 * @param homeDir 用户主目录（缺省 os.homedir()；测试可注入）
 * @returns 插件目录绝对路径（<数据根>/plugins；只做路径拼接，不检查存在性）
 */
export function ztoolsPluginsDir(homeDir: string = os.homedir()): string {
  const root = process.env.ZTOOLS_DATA_ROOT || path.join(homeDir, '.ztools')
  return path.join(root, 'plugins')
}

/**
 * 描述「ZTools 插件同步」虚拟记录的完整配置（渲染层虚拟行与调度器合成配置
 * 共用的单一事实源）。每次调用现取（不缓存）：目录发现结果可能随环境变量与
 * 磁盘状态变化，虚拟行的生命周期内按需重取。
 * @param remoteBase 用户所选的云端父目录（prefs.ztoolsPluginSyncRemoteDir；
 *        '' / undefined = 云端根，远端根组装见 ztoolsPluginsRemotePath）
 * @returns 固定 id、自动发现的本地目录、平台目录名与平台隔离的远端目录；
 *          available 标记插件目录当前是否可用（存在且为目录），不可用时附
 *          面向用户的一句话原因（UI 提示条展示）
 */
export function describeZtoolsPluginsSync(remoteBase?: string): ZtoolsPluginsSyncDesc {
  const pluginsDir = ztoolsPluginsDir()
  const platformKey = ztoolsPlatformKey()
  let available = false
  let reason = '本机还没有找到 ZTools 插件目录，等 ZTools 创建后会自动开始同步'
  try {
    const st = fs.statSync(pluginsDir)
    if (st.isDirectory()) {
      available = true
      reason = ''
    } else {
      reason = '插件目录的位置被同名文件占用，无法同步'
    }
  } catch {
    /* 不存在 / 不可访问：保持 available=false 与默认原因 */
  }
  const desc: ZtoolsPluginsSyncDesc = {
    id: ZTOOLS_PLUGINS_DIR_ID,
    pluginsDir,
    platformKey,
    remotePath: ztoolsPluginsRemotePath(remoteBase, platformKey),
    available,
  }
  if (!available) desc.reason = reason
  return desc
}
