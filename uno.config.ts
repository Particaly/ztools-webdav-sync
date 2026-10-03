import { defineConfig, presetWind3 } from 'unocss'

/**
 * UnoCSS 配置
 *
 * 颜色不直接写死，而是引用 main.scss 中的 CSS 设计令牌（--blue / --text-1 等），
 * 这样工具类（text-ink-2、border-line-card、bg-fill-bar…）与 SCSS 内的 var() 始终同源。
 */
export default defineConfig({
  presets: [presetWind3()],
  // AppIconButton 的 variant class "outline" 会被 Wind 预设误解析为
  // outline-style: solid 工具类，在按钮上画出 outline，这里屏蔽该工具类
  blocklist: ['outline'],
  theme: {
    colors: {
      // 主色与语义色
      primary: 'var(--blue)',
      success: {
        DEFAULT: 'var(--green)',
        deep: 'var(--green-deep)',
        dot: 'var(--green-dot)',
        bg: 'var(--green-bg)',
        solid: 'var(--green-solid)',
      },
      warning: {
        DEFAULT: 'var(--amber)',
        deep: 'var(--amber-deep)',
        icon: 'var(--amber-icon)',
        bg: 'var(--amber-bg)',
      },
      danger: 'var(--red)',
      // 特定用途的文字色
      'btn-text': 'var(--btn-text)',
      'icon-dark': 'var(--icon-dark)',
      // 文字（ink-1 最深，ink-4 最浅）
      ink: {
        1: 'var(--text-1)',
        2: 'var(--text-2)',
        3: 'var(--text-3)',
        4: 'var(--text-muted)',
      },
      // 边框
      line: {
        window: 'var(--br-window)',
        card: 'var(--br-card)',
        'card-alt': 'var(--br-card-alt)',
        input: 'var(--br-input)',
        divider: 'var(--br-divider)',
        bar: 'var(--br-bar)',
      },
      // 浅色填充
      fill: {
        bar: 'var(--bg-bar)',
        folder: 'var(--bg-folder)',
        seg: 'var(--bg-seg)',
        badge: 'var(--bg-badge)',
        track: 'var(--bg-track)',
      },
    },
    fontFamily: {
      ui: "-apple-system, 'Inter', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
      mono: "ui-monospace, 'JetBrains Mono', 'SF Mono', 'Cascadia Mono', Menlo, Consolas, 'Courier New', monospace",
    },
    boxShadow: {
      card: 'var(--shadow-card)',
      btn: 'var(--shadow-btn)',
      pop: 'var(--shadow-pop)',
    },
  },
  shortcuts: {
    // 弹性撑开剩余空间（替代各组件里重复的 .spacer）
    'flex-spacer': 'flex-1 h-px min-w-0',
    // 白底卡片容器（服务器卡片 / 设置卡片 / 目录列表外壳）
    card: 'bg-white border border-solid border-line-card rounded-lg shadow-card',
  },
})
