/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 语义化 Design Token — 所有组件应使用这些名称
        background: 'rgb(var(--background) / <alpha-value>)',
        foreground: 'rgb(var(--foreground) / <alpha-value>)',
        card: {
          DEFAULT: 'rgb(var(--card) / <alpha-value>)',
          foreground: 'rgb(var(--card-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'rgb(var(--popover) / <alpha-value>)',
          foreground: 'rgb(var(--popover-foreground) / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'rgb(var(--primary) / <alpha-value>)',
          foreground: 'rgb(var(--primary-foreground) / <alpha-value>)',
        },
        'primary-soft': 'var(--primary-soft)',
        'primary-softer': 'var(--primary-softer)',
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          foreground: 'rgb(var(--ink-foreground) / <alpha-value>)',
          hover: 'rgb(var(--ink-hover) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'rgb(var(--secondary) / <alpha-value>)',
          foreground: 'rgb(var(--secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'rgb(var(--muted) / <alpha-value>)',
          foreground: 'rgb(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          foreground: 'rgb(var(--accent-foreground) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'rgb(var(--success) / <alpha-value>)',
          foreground: 'rgb(var(--success-foreground) / <alpha-value>)',
          soft: 'var(--success-soft)',
        },
        warning: {
          DEFAULT: 'rgb(var(--warning) / <alpha-value>)',
          foreground: 'rgb(var(--warning-foreground) / <alpha-value>)',
          soft: 'var(--warning-soft)',
        },
        destructive: {
          DEFAULT: 'rgb(var(--destructive) / <alpha-value>)',
          foreground: 'rgb(var(--destructive-foreground) / <alpha-value>)',
          soft: 'var(--destructive-soft)',
        },
        warn: 'rgb(var(--warn) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        'border-strong': 'rgb(var(--border-strong) / <alpha-value>)',
        input: 'rgb(var(--input) / <alpha-value>)',
        ring: 'rgb(var(--ring) / <alpha-value>)',
        'editor-bg': 'rgb(var(--editor-bg) / <alpha-value>)',
        'editor-gutter': 'rgb(var(--editor-gutter-bg) / <alpha-value>)',
        sidebar: {
          DEFAULT: 'rgb(var(--sidebar-background) / <alpha-value>)',
          foreground: 'rgb(var(--sidebar-foreground) / <alpha-value>)',
          accent: 'rgb(var(--sidebar-accent) / <alpha-value>)',
          'accent-foreground': 'rgb(var(--sidebar-accent-foreground) / <alpha-value>)',
          border: 'rgb(var(--sidebar-border) / <alpha-value>)',
          muted: 'rgb(var(--sidebar-muted) / <alpha-value>)',
        },
        'color-primary': 'rgb(var(--primary) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"PingFang SC"', '"Microsoft YaHei"', '"Noto Sans CJK SC"', 'sans-serif'],
        serif: ['"Source Serif 4"', '"Source Serif Pro"', 'Iowan Old Style', 'Charter', 'Georgia', 'Songti SC', 'serif'],
        // 等宽栈补 CJK 回退：JetBrains Mono/Consolas 无中文字形，缺了会掉到宋体
        mono: ['"JetBrains Mono"', '"Fira Code"', '"SF Mono"', 'ui-monospace', 'Menlo', 'Consolas', '"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"', '"Noto Sans CJK SC"', 'monospace'],
      },
      fontSize: {
        xs:    ['var(--text-xs)',     { lineHeight: '1.5' }],
        sm:    ['var(--text-sm)',     { lineHeight: '1.5' }],
        base:  ['var(--text-base)',   { lineHeight: '1.6' }],
        md:    ['var(--text-md)',     { lineHeight: '1.65' }],
        lg:    ['var(--text-lg)',     { lineHeight: '1.55' }],
        xl:    ['var(--text-xl)',     { lineHeight: '1.45' }],
        '2xl': ['var(--text-2xl)',    { lineHeight: '1.3' }],
        '3xl': ['var(--text-3xl)',    { lineHeight: '1.25' }],
        display: ['var(--text-display)', { lineHeight: '1.15' }],
      },
      maxWidth: {
        prose: '42rem',
        '4xl': '56rem',
      },
      zIndex: {
        sticky: 'var(--z-sticky)',
        header: 'var(--z-header)',
        dropdown: 'var(--z-dropdown)',
        panel: 'var(--z-panel)',
        sheet: 'var(--z-sheet)',
        popover: 'var(--z-popover)',
        dialog: 'var(--z-dialog)',
        modal: 'var(--z-modal)',
        auth: 'var(--z-auth)',
        tooltip: 'var(--z-tooltip)',
      },
      boxShadow: {
        'card':       'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)',
        'btn':        'var(--shadow-btn)',
        'floating':   'var(--shadow-floating)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        card: 'var(--radius-card)',
        btn:  'var(--radius-btn)',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}