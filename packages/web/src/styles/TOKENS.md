# NoteFast 设计 Token 与主题系统

NoteFast 的视觉只通过 **CSS 变量 token** 定义。所有组件应通过 Tailwind 的语义色名（`bg-card`、`text-foreground`、`border`）或 `var(--token-name)` 引用 token；**禁止在组件层写死颜色 / 字号 / 字号差 / 阴影值**。

## 1. Token 分层

### 1.1 平面（surface）
| Token | 角色 | 备注 |
|---|---|---|
| `--background` | 整页背景 | 暖色 #FCFAF4（light）/ 深色 22 21 19 |
| `--card` | 卡片 / 浮层 | 纯白 / dark 32 30 27 |
| `--popover` | popup | 同 card |
| `--sidebar-background` | 侧栏 | 比 background 暖一档 |
| `--editor-bg` | 编辑器正文区 | 比 background 暖一档 |
| `--editor-gutter-bg` | 编辑器行号区 | 比 editor-bg 暗一档 |

### 1.2 文字（content）
| Token | 角色 |
|---|---|
| `--foreground` | 主文字 |
| `--card-foreground` | 卡片上的主文字（语义同 foreground，备用） |
| `--muted-foreground` | 次级文字、占位符 |
| `--sidebar-muted` | 侧栏次级 |
| `--accent-foreground` | hover 高亮态文字 |

### 1.3 主色（action）
低饱和品牌靛蓝（light #5A74B0 / dark #95A4C6），只用于三处：选中态（sidebar active、tag 选中 pill）、主要操作（主按钮）、AI 功能标识（AI 图标 / AI 头像）。
| Token | 角色 |
|---|---|
| `--primary` | 品牌主色：主按钮 / 选中态文字 / focus ring |
| `--primary-foreground` | 主按钮上的字 |
| `--primary-hover` | 主按钮 hover |
| `--primary-soft` | 选中态底色 / hover 背景 / focus halo |
| `--primary-softer` | 极低强调 hover |

### 1.4 状态（status）
亮/暗在 `:root[data-theme='dark']` 翻转，组件用 `text-success` / `bg-warning-soft` 等，**不要写 `dark:` 变体**。
| Token | 角色 |
|---|---|
| `--success` / `--success-foreground` / `--success-soft` | 成功 / 已保存 / 在线 |
| `--warning` / `--warning-foreground` / `--warning-soft` | 警告 / 脏状态 / 进行中 |
| `--warn` | 与 `--warning` 同值，兼容既有 `rgb(var(--warn))` |
| `--destructive` / `--destructive-foreground` / `--destructive-soft` | 删除 / 不可逆 / diff 删除 |

### 1.5 边框与圆角
| Token | 值 |
|---|---|
| `--border` | hairline 主边框 |
| `--border-strong` | 强调边框（暂未启用，留扩展） |
| `--input` | 输入框边框（同 border） |
| `--ring` | focus ring（= primary） |
| `--radius` | 6px（控件默认） |
| `--radius-card` | 8px |
| `--radius-btn` | 6px |
| `--radius-xl` | 12px（toast / 空态图标 / think 块） |
| `--radius-2xl` | 16px（命令面板） |
| 焦点环 | 全局 `:focus-visible` outline；不要写 `focus:ring-*` |

### 1.6 排版
字体栈走 `var(--font-sans/serif/mono)`。UI 字号用 `text-2xs`（10.5px，侧栏/徽章）到 `text-display`；文档标题用 `text-h1`…`text-h6`（与编辑态 `--text-h1`…同源）。不要写 `text-[12px]` 这类任意值，`bun lint` 会拦。`font-serif` 只给阅读正文。

### 1.6.1 阅读列宽
`--reading-max-w`（48rem）— 仅 doc 路由的内层阅读列引用，外层页面容器仍走 `max-w-4xl`。详见 `routes/doc.tsx` 的 `reading-col` 包裹。

### 1.7 阴影
| Token | 用处 |
|---|---|
| `--shadow-card` | 卡片基础阴影（1px hairline + 2px blur）；类名 `shadow-card` |
| `--shadow-card-hover` | 卡片 hover 抬起；类名 `shadow-card-hover` |
| `--shadow-floating` | 浮层（popover / modal）；类名 `shadow-floating` |
| `--shadow-btn` | 主按钮压感；类名 `shadow-btn`。inset kbd / 图谱 flood 不走这套 |

### 1.8 动效
| Token | 值 | 用处 |
|---|---|---|
| `--ease` | `cubic-bezier(0.2, 0, 0, 1)` | 唯一缓动 |
| `--dur-fast` | 120ms | 轻提示 / 软淡入 |
| `--dur` | 150ms | 控件默认（已广泛引用） |
| `--dur-normal` | 200ms | 页切换 / 指示器 |
| `--dur-slow` | 320ms | 浮层入场 / toast |

JS 动画（平滑滚动、图谱模拟）读 `prefersReducedMotion()`，系统减弱动态效果时瞬时落地。

### 1.9 层级（z-index）
按现状登记，组件用 `z-popover` / `z-dialog` 等，不要写 `z-[80]`。
`sticky=10 < header=20 < dropdown=30 < panel=40 < sheet=50 < popover=80 < dialog=90 < modal=100 < auth=200 < tooltip=300`。toast 与命令面板同为 `--z-modal`。

## 2. 主题系统

**当前状态**：
- 仅 light / dark 两套 token
- `:root {}` 为 light 默认
- `:root[data-theme='dark']` 翻转暗色值
- 切换由 `<html data-theme="light|dark">` 控制（`index.html` 防闪烁脚本 + 设置里的 system/light/dark）
- 组件用语义 token，禁止 `dark:` 变体（Tailwind `darkMode: 'class'` 仍在配置里，但不再被消费）

## 3. 添加新主题的步骤（未来）

1. 复制 `:root {}` 全部 token，重命名为目标主题名（`[data-theme="warm"]`）
2. 替换颜色 / 字号 / 圆角值
3. 验证所有 surface / text / action / status 在新主题下都能读出来（对比度 ≥ 4.5:1）
4. 在 `Settings` page 加 picker（**未实现**）
5. localStorage 持久化选择

## 4. 反例（不要做的事）

- ❌ `bg-[#FAF9F5]` —— 写死颜色，bypass token
- ❌ `text-[14px]` —— 写死字号，bypass `--text-sm`
- ❌ 组件里 inline `style={{ color: 'red' }}`
- ❌ 给某处加粗 / 阴影却没有在 token 里定义

## 5. 工具栏 / 编辑器专属 token

- `--editor-bg`：textarea 区背景
- `--editor-gutter-bg`：行号侧栏，比 editor-bg 略冷
- `--border-strong`：将来需要"二档边框"时启用

## 6. CodeMirror / 第三方接入

如果未来切换 CodeMirror / Lexical 等编辑组件，**不要再重申一套颜色**：基于 `--editor-bg`、`--editor-gutter-bg`、`--border`、`--muted-foreground` 进行主题映射即可。
