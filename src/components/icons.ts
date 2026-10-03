/**
 * 内联 SVG 图标库：与设计稿矢量一致，使用 24x24 viewBox、currentColor 描边。
 * 特殊占位符 __BG__ 会被 AppIcon 替换为背景色（用于带底色的圆形状态图标）。
 */
export const ICONS: Record<string, string> = {
  // 云 + 上传箭头（Logo / 配置按钮）
  'cloud-sync': `<path d="M7 17.5a4.5 4.5 0 0 1-.42-8.98 6 6 0 0 1 11.7 1.6A4 4 0 0 1 17.5 18h-1"/>
    <path d="M12 20.5v-6.2" stroke-width="1.8"/>
    <path d="m9.6 16.3 2.4-2.4 2.4 2.4" stroke-width="1.8"/>`,
  // 云（描边）
  cloud: `<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>`,
  'cloud-up': `<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><path d="M12 16v-5m0 0-2.2 2.2M12 11l2.2 2.2"/>`,
  // 空状态插画：云 + 文件夹
  'cloud-folder': `<path d="M15.5 10H8.5a5.5 5.5 0 1 1 5.27-7h1.73a3.5 3.5 0 1 1 0 7Z" transform="translate(4.5 0.5) scale(0.62)"/>
    <path d="M3 11.5a1.5 1.5 0 0 1 1.5-1.5h4.2l1.6 1.8h9.2a1.5 1.5 0 0 1 1.5 1.5v6.2a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 19.5v-8Z" stroke-width="1.6"/>`,
  // 设置齿轮：原始齿形路径的绘制中心偏在 (10.6, 14.4)，需经 translate+scale
  // 校正到 (12,12) 居中，缩放 0.77 使视觉尺寸与其余 24px 线性图标一致
  gear: `<circle cx="12" cy="12" r="1.8"/>
    <path d="M12 3.2 13 5.4a6.8 6.8 0 0 1 2.1.87l2.35-.7 1.98 1.98-.7 2.35c.4.64.69 1.35.87 2.1l2.2 1v2.8l-2.2 1a6.8 6.8 0 0 1-.87 2.1l.7 2.35-1.98 1.98-2.35-.7a6.8 6.8 0 0 1-2.1.87l-1 2.2h-2.8l-1-2.2a6.8 6.8 0 0 1-2.1-.87l-2.35.7-1.98-1.98.7-2.35a6.8 6.8 0 0 1-.87-2.1l-2.2-1v-2.8l2.2-1a6.8 6.8 0 0 1 .87-2.1l-.7-2.35 1.98-1.98 2.35.7A6.8 6.8 0 0 1 10.4 5.4l1-2.2h.6Z" stroke-width="2.15" transform="translate(3.84 0.91) scale(0.77)"/>`,
  // 三点（横向 / 纵向）
  'dots-h': `<g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></g>`,
  'dots-v': `<g fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></g>`,
  // 箭头类
  'chevron-right': `<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>`,
  'chevron-down': `<path d="m6 9.5 6 6 6-6"/>`,
  'chevron-left': `<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>`,
  close: `<path d="m6.5 6.5 11 11m0-11-11 11"/>`,
  // 地球
  globe: `<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.2 3.6 5.2 3.6 8.5s-1.3 6.3-3.6 8.5c-2.3-2.2-3.6-5.2-3.6-8.5s1.3-6.3 3.6-8.5Z"/>`,
  // 刷新
  refresh: `<path d="M20.5 12a8.5 8.5 0 1 1-8.5-8.5c2.6 0 4.9 1.15 6.4 2.96L20.5 8.5"/><path d="M20.5 3.5v5h-5"/>`,
  // 加号
  plus: `<path d="M12 5.5v13M5.5 12h13"/>`,
  // 文件夹
  folder: `<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17V7Z"/>`,
  // 对勾 / 带底圆的对勾
  check: `<path d="m5 12.5 4.5 4.5L19 7.5"/>`,
  'check-circle': `<circle cx="12" cy="12" r="10" fill="__BG__" stroke="none"/><path d="m7.5 12.5 3 3 6-6.5" stroke-width="2.2"/>`,
  // 警告三角
  warn: `<path d="M12 3.8 2.8 19.6h18.4L12 3.8Z" stroke-width="1.6"/><path d="M12 10v4.2" stroke-width="1.7"/><circle cx="12" cy="16.9" r="0.9" fill="currentColor" stroke="none"/>`,
  // 列表（状态栏）
  list: `<path d="M4 6.5h16M4 12h16M4 17.5h16"/>`,
  // 历史（决策记录页：时钟 + 逆时针回绕箭头）
  history: `<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.4"/><path d="M3.5 3.4v5h5"/><path d="M12 7.6v4.9l3.2 1.9"/>`,
  // 上传 / 下载 / 双向
  upload: `<path d="M12 18.5v-13m0 0-4.2 4.2M12 5.5l4.2 4.2"/>`,
  download: `<path d="M12 5.5v13m0 0 4.2-4.2M12 18.5l-4.2-4.2"/>`,
  swap: `<path d="M8.5 17.5v-11m0 0L5.5 9.5m3-3 3 3"/><path d="M15.5 6.5v11m0 0 3-3m-3 3-3-3"/>`,
  // 显示器（本地版本）
  monitor: `<rect x="3.5" y="5" width="17" height="11" rx="1.2"/><path d="M9.5 19.5h5"/>`,
  // 文档
  file: `<path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5l-5-5Z"/><path d="M13.5 3.5v5h5"/>`,
  // 信息
  info: `<circle cx="12" cy="12" r="8.5"/><path d="M12 11.2v4.6"/><circle cx="12" cy="8.2" r="0.9" fill="currentColor" stroke="none"/>`,
  // 问号（行内说明气泡 InfoTip）
  help: `<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.2a2.5 2.5 0 0 1 4.9.83c0 1.67-2.45 2.3-2.4 3.35"/><circle cx="12" cy="16.4" r="0.9" fill="currentColor" stroke="none"/>`,
  // 用户 / 锁（设置页输入框）
  user: `<circle cx="12" cy="8.2" r="3.4"/><path d="M5.2 19.5a6.8 6.8 0 0 1 13.6 0"/>`,
  lock: `<rect x="5.5" y="10.5" width="13" height="9" rx="1.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>`,
  // 垃圾桶（删除配置）
  trash: `<path d="M4.5 6.5h15"/><path d="M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5"/><path d="m6.5 6.5.7 12.1a2 2 0 0 0 2 1.9h5.6a2 2 0 0 0 2-1.9l.7-12.1"/><path d="M10 10.5v6M14 10.5v6"/>`,
  // 暂停 / 播放（停用 / 启用同步）
  pause: `<path d="M9.5 5.5v13M14.5 5.5v13"/>`,
  play: `<path d="M8.5 5.9v12.2a.5.5 0 0 0 .76.43l10.06-6.1a.5.5 0 0 0 0-.86L9.26 5.47a.5.5 0 0 0-.76.43Z"/>`,
}

export type IconName = keyof typeof ICONS | string
