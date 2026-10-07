/* eslint-disable */
// WebDAV 同步插件 —— 宿主依赖端口层
//
// 定位：引擎对宿主（ZTools）的全部运行期依赖收敛为显式端口、core 无头可跑
// （不直接触达 window.ztools）。本文件把 preload 里散落的 window.ztools 直连点
// （storageRoot / trashItem / notify / config / lifecycle）收敛为单一 HostPorts
// 接口，本层只做端口化、不动进程模型。
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
import type { InternalApiPermissionStatus, ZToolsApi, ZToolsInternalApi } from './types.mts'

/**
 * preload 运行环境中的 window（宿主注入 ztools API；Node 直跑测试时不存在，
 * 访问前必须判空 —— 与 store / scheduler 原直连形态一致，只是收敛到了本层）。
 */
declare const window: { ztools?: Partial<ZToolsApi> } | undefined

/**
 * 内部 API 端口（ZTOOLS 注册表读写 + 列表变更通知的通道）：宿主未注入
 * internal 命名空间（旧版宿主）时为 null —— 调用方据此整体降级为纯实体同步
 * （不做注册表写入）。注意端口只承载「通道」：授权与否由宿主在每次调用时鉴权，
 * 未授权的调用会 reject，授权探测在 ztools-registry.mts 统一处理。
 */
export interface InternalRegistryPort {
  /** 读取 ZTOOLS/ 命名空间文档（未授权时 reject，调用方按降级处理） */
  dbGet(key: string): Promise<any>
  /** 覆盖写 ZTOOLS/ 命名空间文档（未授权时 reject） */
  dbPut(key: string, value: unknown): Promise<unknown>
  /**
   * 通知宿主刷新插件列表与指令索引（可选能力）：宿主未提供该方法
   * 或通知失败时 no-op —— 登记仍生效，列表延迟到宿主下一次触发或重启才刷新
   */
  notifyChanged(): Promise<void>
}

/**
 * 高级 API 权限申请端口（window.ztools 顶层能力，不走 internal 鉴权）：
 * 查询自身授权状态 + 提交授权申请。宿主支持「按通道授权 + 主动申请」体系时
 * 存在；旧宿主缺失时为 null —— 对账层退回「直接调用并按拒绝降级」的探测路径。
 */
export interface InternalPermissionPort {
  /**
   * 查询自身授权状态：{ fullAccess, granted, pending }；查询失败 reject / 返回
   * 非对象时由调用方按「旧宿主」降级
   */
  getStatus(): Promise<InternalApiPermissionStatus>
  /**
   * 提交授权申请（宿主对同插件多次申请做通道并集）。resolve 值形如
   * { success, status: 'granted' | 'pending', ... }；失败时 { success: false, error }
   */
  request(apis: string[], reason?: string): Promise<any>
}

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
  /**
   * 内部 API 通道（window.ztools.internal 的端口化）：null = 旧宿主未注入或
   * 方法缺失 —— 注册表对账整体跳过（ztools-registry.mts 据此降级）。与 config /
   * lifecycle 相同的「现取不缓存」语义：宿主注入 / 移除即时生效。
   */
  internal: InternalRegistryPort | null
  /**
   * 高级 API 权限申请通道（查询自身状态 + 提交申请）：null = 旧宿主缺失这两个
   * 顶层方法 —— 对账层退回「直接调用并按拒绝降级」的探测路径。与 config /
   * lifecycle 相同的「现取不缓存」语义。
   */
  permissions: InternalPermissionPort | null
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
 * 现取内部 API 通道（window.ztools.internal 端口化）：宿主未注入 / internal
 * 命名空间缺失 / dbGet 或 dbPut 不是函数一律返回 null（ztools-registry.mts
 * 据此整体降级为纯实体同步）。notifyChanged 对宿主缺失的 notifyPluginsChanged
 * 与通知失败静默吞掉 —— 通知是增强不是关键路径，绝不回滚已生效的登记。
 */
function internalNow(): InternalRegistryPort | null {
  try {
    const zt = ztOrNull()
    const it: Partial<ZToolsInternalApi> | undefined = zt ? zt.internal : undefined
    if (!it || typeof it.dbGet !== 'function' || typeof it.dbPut !== 'function') return null
    return {
      dbGet: (key: string) => it.dbGet!(key),
      dbPut: (key: string, value: unknown) => it.dbPut!(key, value),
      notifyChanged: async () => {
        try {
          if (typeof it.notifyPluginsChanged === 'function') await it.notifyPluginsChanged()
        } catch (_) {
          /* 通知失败不回滚登记 */
        }
      },
    }
  } catch (_) {
    return null
  }
}

/**
 * 现取权限申请通道（window.ztools 顶层的 getInternalApiPermissions /
 * requestInternalApiPermissions 端口化）：任一方法缺失或访问异常返回 null ——
 * 对账层据此退回「直接调用 internal 并按拒绝降级」的旧宿主探测路径。
 */
function permissionsNow(): InternalPermissionPort | null {
  try {
    const zt = ztOrNull()
    if (
      !zt ||
      typeof zt.getInternalApiPermissions !== 'function' ||
      typeof zt.requestInternalApiPermissions !== 'function'
    ) {
      return null
    }
    return {
      getStatus: () => zt.getInternalApiPermissions!(),
      request: (apis: string[], reason?: string) => zt.requestInternalApiPermissions!(apis, reason),
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
    internal: internalNow(),
    permissions: permissionsNow(),
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
