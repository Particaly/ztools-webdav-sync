/* eslint-disable */
// WebDAV 同步插件 —— 宿主依赖端口层
//
// 定位：同步引擎长期目标是移出渲染进程 preload（独立进程 / CLI 形态），前置条件是
// 引擎对宿主（ZTools）的全部运行期依赖收敛为显式端口、core 无头可跑。本文件把
// preload 里散落的 window.ztools 直连点（storageRoot / trashItem / notify /
// config / lifecycle）收敛为单一 HostPorts 接口；进程拆分本身仍被宿主平台
// sanctioned 后台进程能力的确认阻塞，本层只做端口化、不动进程模型。
//
// 默认端口绑定 window.ztools 且**现取不缓存**（getHostPorts 未被覆盖时每次新建
// defaultHostPorts）—— 宿主注入晚于 preload 加载时依赖仍可用，这也是调度器自举
// 「每次经宿主现取 dbStorage」约束的延续。
//
// 刻意不端口化的依赖：fsx.pickDirectory（showOpenDialog）与渲染层的
// shellOpenExternal —— 纯渲染层 UI 交互，无头形态不触达，仍直连 window.ztools。
//
// lifecycle 时序：宿主 onPluginEnter / onPluginOut 是单回调槽位，由 services.mts
// 在挂载期（import 时一次性）经端口注册并持有 —— 端口化不改变该时序，注入只对
// 「尚未发生的注册」生效（生产路径注册发生在模块加载期，先于任何注入机会）。
import type { ZToolsApi } from './types.mts'

/**
 * preload 运行环境中的 window（宿主注入 ztools API；Node 直跑测试时不存在，
 * 访问前必须判空 —— 与 store / scheduler 原直连形态一致，只是收敛到了本层）。
 */
declare const window: { ztools?: Partial<ZToolsApi> } | undefined

/**
 * 宿主端口：引擎对 ZTools 宿主全部运行期依赖的显式形态。
 * config / lifecycle 的形状直接从 types.mts 的 ZToolsApi 派生（NonNullable /
 * Pick），与类型单一事实源零漂移 —— 宿主接口演进时端口形状自动跟随，不另立副本。
 */
export interface HostPorts {
  /** 持久化根目录（宿主 pluginData 绝对路径）；null = 宿主未注入/不可用（store.storageRoot 自行回退 tmpdir） */
  storageRoot(): string | null
  /** 把文件/目录移入系统回收站（异步，失败 reject）；实现不得退化为直接删除 */
  trashItem(fullPath: string): Promise<void>
  /** 系统通知（尽力而为；实现内部吞异常） */
  notify(body: string): void
  /** 配置权威通道（dbStorage 子集）；null = 不可用（调度器自举等待宿主就绪） */
  config: NonNullable<ZToolsApi['dbStorage']> | null
  /** 宿主生命周期钩子（单回调槽位，由 preload 先注册持有）；null = 宿主未注入 */
  lifecycle: Pick<ZToolsApi, 'onPluginEnter' | 'onPluginOut'> | null
}

/**
 * 默认端口在宿主未注入回收站接口时抛出的固定文案（面向用户一句话；
 * deleteLocalOne 据此识别「接口缺失」与「调用失败」两类形态，见该函数）。
 */
export const HOST_TRASH_MISSING_MESSAGE = '当前 ZTools 版本不支持放入回收站'

/** 当前生效的端口覆盖（null = 未覆盖，走默认端口；测试 / 无头注入点持有） */
let portsOverride: HostPorts | null = null

/**
 * 取宿主对象（判空 + 异常吞掉返回 null）：默认端口各成员的统一入口形态。
 * 宿主对象本身不可得（未注入 / 访问异常）一律按「宿主未注入」处理。
 */
function ztOrNull(): Partial<ZToolsApi> | null {
  try {
    return typeof window !== 'undefined' && window.ztools ? window.ztools : null
  } catch (_) {
    return null
  }
}

/**
 * 现取配置权威通道（dbStorage 子集）：宿主未注入 / dbStorage 缺失 / 无 getItem /
 * 访问异常一律返回 null（调度器自举据此走「等待宿主就绪」路径，语义与原直连判定一致）。
 */
function configNow(): HostPorts['config'] {
  try {
    const zt = ztOrNull()
    return zt && zt.dbStorage && typeof zt.dbStorage.getItem === 'function' ? zt.dbStorage : null
  } catch (_) {
    return null
  }
}

/**
 * 现取生命周期钩子对：两个钩子齐才返回（半注入视同未注入 —— 宿主注入是全量的，
 * 拆分注入只会出现在畸形测试桩里，按 null 跳过注册更安全）；访问异常同样返回 null。
 */
function lifecycleNow(): HostPorts['lifecycle'] {
  try {
    const zt = ztOrNull()
    if (!zt || typeof zt.onPluginEnter !== 'function' || typeof zt.onPluginOut !== 'function') return null
    return {
      onPluginEnter: zt.onPluginEnter.bind(zt),
      onPluginOut: zt.onPluginOut.bind(zt),
    }
  } catch (_) {
    return null
  }
}

/**
 * 构造绑定 window.ztools 的默认端口。现取不缓存：函数 / 属性在构造或调用时
 * 现读宿主对象，绝不持有旧引用 —— 「宿主注入晚于 preload 加载」与「注入被移除」
 * 两种时序下行为都正确（getHostPorts 未覆盖时每次调用本函数，动态性由此保证）。
 */
export function defaultHostPorts(): HostPorts {
  return {
    // 存储根：宿主 pluginData 绝对路径；未注入 / 接口缺失 / 异常 / 空串 → null
    //（tmpdir 回退逻辑留在 store.storageRoot，端口只负责报告宿主侧事实）
    storageRoot(): string | null {
      const zt = ztOrNull()
      if (!zt || typeof zt.getPath !== 'function') return null
      try {
        return zt.getPath('pluginData') || null
      } catch (_) {
        return null
      }
    },
    // 回收站：接口缺失时 reject 固定文案（HOST_TRASH_MISSING_MESSAGE），
    // 其余失败原样透传 —— 上层（deleteLocalOne）统一包装，绝不退化为直接删除
    trashItem(fullPath: string): Promise<void> {
      const zt = ztOrNull()
      if (!zt || typeof zt.shellTrashItem !== 'function') {
        return Promise.reject(new Error(HOST_TRASH_MISSING_MESSAGE))
      }
      return zt.shellTrashItem(fullPath)
    },
    // 系统通知：showNotification 缺失为 no-op、调用异常吞掉（与原 notifyBestEffort
    // 内联实现行为等价 —— 「尽力而为」的语义在默认端口内闭环）
    notify(body: string): void {
      try {
        const zt = ztOrNull()
        if (zt && typeof zt.showNotification === 'function') zt.showNotification(body)
      } catch (_) {
        /* 提醒失败无害 */
      }
    },
    config: configNow(),
    lifecycle: lifecycleNow(),
  }
}

/**
 * 取当前宿主端口：未覆盖时**不缓存**默认端口 —— 每次现调 defaultHostPorts()，
 * 保证对 window.ztools 的读取永远是动态的（宿主晚注入 / 移除即时生效）。
 */
export function getHostPorts(): HostPorts {
  return portsOverride || defaultHostPorts()
}

/**
 * 覆盖 / 还原宿主端口（无头运行与测试的注入后门）：p = null 还原为默认端口。
 * 注意注入只影响「调用方所在的模块图」—— esbuild 产物与源码是两个模块实例，
 * 跨实例需各自注入（services.host 门面注释同样注明了这一点）。
 */
export function setHostPorts(p: HostPorts | null): void {
  portsOverride = p
}
