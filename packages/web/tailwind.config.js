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
          soft: 'rgb(var(--primary) / 0.06)',
        },
        'primary-soft': 'var(--primary-soft)',
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
        destructive: {
          DEFAULT: 'rgb(var(--destructive) / <alpha-value>)',
          foreground: 'rgb(var(--destructive-foreground) / <alpha-value>)',
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
        // 保留 brand/warm 以便渐进迁移（组件迁移完成后可删除）
        brand: {
          50:  '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
        warm: {
          50:  '#fafaf9',
          100: '#f5f5f4',
          200: '#e7e5e4',
          300: '#d6d3d1',
          400: '#a8a29e',
          500: '#78716c',
          600: '#57534e',
          700: '#44403c',
          800: '#292524',
          900: '#1c1917',
        },
        'color-primary': 'rgb(var(--primary) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        serif: ['"Source Serif 4"', '"Source Serif Pro"', 'Iowan Old Style', 'Charter', 'Georgia', 'Songti SC', 'serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', '"SF Mono"', 'ui-monospace', 'Menlo', 'monospace'],
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
      boxShadow: {
        'card':       'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)',
        'btn':        'var(--shadow-btn)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        card: 'var(--radius-card)',
        btn:  'var(--radius-btn)',
      },
      transitionTimingFunction: {
        soft: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}