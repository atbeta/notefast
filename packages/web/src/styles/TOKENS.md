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
| Token | 角色 |
|---|---|
| `--destructive` / `--destructive-foreground` | 删除 / 不可逆操作 |
| `--warn` | 警告（MD 编辑器空文档提示等） |

### 1.5 边框与圆角
| Token | 值 |
|---|---|
| `--border` | hairline 主边框 |
| `--border-strong` | 强调边框（暂未启用，留扩展） |
| `--input` | 输入框边框（同 border） |
| `--ring` | focus ring（= primary） |
| `--radius` | 0.375rem |
| `--radius-card` | 0.625rem |
| `--radius-btn` | 0.375rem |

### 1.6 排版
字体栈 + Tailwind `text-xs / sm / base / md / lg / xl / 2xl / 3xl / display`，映射到 `--text-*` 变量。`font-serif` 为阅读视图的衬线字体，不要在 UI 控件上用。

### 1.6.1 阅读列宽
`--reading-max-w`（48rem）— 仅 doc 路由的内层阅读列引用，外层页面容器仍走 `max-w-4xl`。详见 `routes/doc.tsx` 的 `reading-col` 包裹。

### 1.7 阴影
| Token | 用处 |
|---|---|
| `--shadow-card` | 卡片基础阴影（1px hairline + 2px blur） |
| `--shadow-card-hover` | 卡片 hover 抬起 |
| `--shadow-floating` | 浮层（popover / modal） |

### 1.8 动效
`--ease: 180ms cubic-bezier(0.4, 0, 0.2, 1)`，全 app 统一。

## 2. 主题系统（v0.1 雏形）

**当前状态**：
- 仅 light / dark 两套
- `:root {}` 为 light 默认
- `.dark {}` 为 dark 主题
- 模式切换由 `<html class="dark">` 或 light class 控制

**未来主题钩子**（已就位）：
- `<html data-theme="default">` —— 当前生效
- 新增主题时：复制 `:root {}` 改成 `[data-theme="warm"] {}` 或 `[data-theme="high-contrast"] {}`，`<html>` 上同步切换 `data-theme`
- 主题切换 UI 不在 v0.1 / Wave 1-6 范围内；下一次"主题"需求出现时再补 ThemeProvider + Settings picker

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
