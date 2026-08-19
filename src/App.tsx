/**
 * Phase 1A · Step 2 · Design Tokens Smoke UI
 * 仅验证 Token 是否正确应用，非正式页面
 */

const surfaces = [
  { label: '应用背景', value: '#F7F8FA', cls: 'bg-background' },
  { label: '侧边栏', value: '#FAFAFB', cls: 'bg-sidebar' },
  { label: '卡片表面', value: '#FFFFFF', cls: 'bg-surface' },
  { label: '次级表面', value: '#F6F7F9', cls: 'bg-surface-secondary' },
  { label: '行 Hover', value: '#F8F9FB', cls: 'bg-hover' },
  { label: '行选中', value: '#F3F4FF', cls: 'bg-selected' },
]

const textColors = [
  { label: '主要文字', value: '#18181B', cls: 'text-foreground' },
  { label: '次要文字', value: '#52525B', cls: 'text-foreground-secondary' },
  { label: '辅助文字', value: '#8A8F98', cls: 'text-foreground-tertiary' },
  { label: '禁用文字', value: '#B4B8C1', cls: 'text-foreground-disabled' },
]

const primaryColors = [
  { label: '主色', value: '#6269F2', cls: 'bg-primary' },
  { label: 'Hover', value: '#7B81F5', cls: 'bg-primary-hover' },
  { label: 'Pressed', value: '#565DE8', cls: 'bg-primary-pressed' },
  { label: 'Soft', value: '#EDEEFF', cls: 'bg-primary-soft' },
  { label: 'Softest', value: '#F5F5FF', cls: 'bg-primary-softest' },
]

const statusColors = [
  { label: '危险', solid: 'bg-danger', soft: 'bg-danger-soft', text: 'text-danger' },
  { label: '警告', solid: 'bg-warning', soft: 'bg-warning-soft', text: 'text-warning' },
  { label: '成功', solid: 'bg-success', soft: 'bg-success-soft', text: 'text-success' },
  { label: '信息', solid: 'bg-info', soft: 'bg-info-soft', text: 'text-info' },
]

const typography = [
  { name: '大标题', cls: 'text-hero', weight: 'font-semibold' },
  { name: '页面标题', cls: 'text-title', weight: 'font-semibold' },
  { name: 'KPI 数字', cls: 'text-kpi', weight: 'font-semibold' },
  { name: '模块标题', cls: 'text-module', weight: 'font-semibold' },
  { name: '二级标题', cls: 'text-subtitle', weight: 'font-semibold' },
  { name: '正文', cls: 'text-body', weight: 'font-normal' },
  { name: '辅助文字', cls: 'text-auxiliary', weight: 'font-normal' },
  { name: '说明', cls: 'text-caption', weight: 'font-normal' },
]

const radii = [
  { label: 'xs 6px', cls: 'rounded-xs' },
  { label: 'sm 8px', cls: 'rounded-sm' },
  { label: 'md 10px', cls: 'rounded-md' },
  { label: 'lg 12px', cls: 'rounded-lg' },
  { label: 'xl 14px', cls: 'rounded-xl' },
  { label: '2xl 16px', cls: 'rounded-2xl' },
]

const shadows = [
  { label: '卡片', cls: 'shadow-card' },
  { label: '浮层', cls: 'shadow-overlay' },
  { label: '弹窗', cls: 'shadow-modal' },
]

export default function App() {
  return (
    <main className="min-h-screen bg-background p-6 font-sans">
      <div className="mx-auto max-w-3xl space-y-8">
        {/* 标题 */}
        <header className="space-y-2">
          <h1 className="text-hero font-semibold text-foreground">知行 · Token 验证</h1>
          <p className="text-body text-foreground-secondary">
            Phase 1A · Step 2 · Design Tokens Smoke UI
          </p>
        </header>

        {/* 背景与 Surface */}
        <section className="space-y-3">
          <h2 className="text-module font-semibold text-foreground">背景与 Surface</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {surfaces.map((s) => (
              <div
                key={s.label}
                className={`${s.cls} flex flex-col gap-1 rounded-lg border border-border p-4`}
              >
                <span className="text-caption text-foreground-tertiary">{s.label}</span>
                <span className="text-auxiliary text-foreground-secondary">{s.value}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 文字颜色 */}
        <section className="space-y-3">
          <h2 className="text-module font-semibold text-foreground">文字颜色</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {textColors.map((t) => (
              <div
                key={t.label}
                className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4"
              >
                <span className={`text-body font-medium ${t.cls}`}>{t.label}</span>
                <span className="text-caption text-foreground-tertiary">{t.value}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 主色 */}
        <section className="space-y-3">
          <h2 className="text-module font-semibold text-foreground">主色</h2>
          <div className="flex flex-wrap gap-3">
            {primaryColors.map((p) => (
              <div
                key={p.label}
                className={`${p.cls} flex h-20 w-28 flex-col justify-end gap-1 rounded-lg border border-border p-3`}
              >
                <span
                  className={`text-caption ${p.cls.includes('soft') ? 'text-foreground-secondary' : 'text-on-primary'}`}
                >
                  {p.label}
                </span>
                <span
                  className={`text-caption ${p.cls.includes('soft') ? 'text-foreground-tertiary' : 'text-on-primary'}`}
                >
                  {p.value}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* 状态色 */}
        <section className="space-y-3">
          <h2 className="text-module font-semibold text-foreground">状态色</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {statusColors.map((s) => (
              <div
                key={s.label}
                className={`flex flex-col gap-2 rounded-lg border border-border p-4 ${s.soft}`}
              >
                <div className={`${s.solid} h-8 w-full rounded-sm`} />
                <span className={`text-body font-medium ${s.text}`}>{s.label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 字号 */}
        <section className="space-y-3">
          <h2 className="text-module font-semibold text-foreground">字号层级</h2>
          <div className="space-y-2 rounded-lg border border-border bg-surface p-6">
            {typography.map((t) => (
              <div key={t.name} className="flex items-baseline gap-4">
                <span className="w-24 shrink-0 text-caption text-foreground-tertiary">{t.name}</span>
                <span className={`${t.cls} ${t.weight} text-foreground`}>知行个人知识与行动中枢</span>
              </div>
            ))}
          </div>
        </section>

        {/* 圆角 */}
        <section className="space-y-3">
          <h2 className="text-module font-semibold text-foreground">圆角</h2>
          <div className="flex flex-wrap gap-4 rounded-lg border border-border bg-surface p-6">
            {radii.map((r) => (
              <div key={r.label} className="flex flex-col items-center gap-2">
                <div className={`h-16 w-16 border border-border bg-primary-soft ${r.cls}`} />
                <span className="text-caption text-foreground-tertiary">{r.label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 阴影 */}
        <section className="space-y-3">
          <h2 className="text-module font-semibold text-foreground">阴影</h2>
          <div className="flex flex-wrap gap-6 rounded-lg border border-border bg-surface p-6">
            {shadows.map((s) => (
              <div key={s.label} className="flex flex-col items-center gap-2">
                <div className={`h-16 w-28 rounded-lg border border-border bg-surface ${s.cls}`} />
                <span className="text-caption text-foreground-tertiary">{s.label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 焦点环 */}
        <section className="space-y-3">
          <h2 className="text-module font-semibold text-foreground">焦点环</h2>
          <div className="space-y-3 rounded-lg border border-border bg-surface p-6">
            <label className="flex flex-col gap-2">
              <span className="text-auxiliary text-foreground-secondary">点击输入框查看 Focus Ring</span>
              <input
                type="text"
                placeholder="焦点环 = #6269F2 + rgba(98,105,242,.12) 3px"
                className="h-9 w-full rounded-sm border border-border bg-surface px-3 text-body text-foreground placeholder:text-foreground-tertiary"
              />
            </label>
            <button
              type="button"
              className="h-9 rounded-sm bg-primary px-4 text-body font-medium text-on-primary transition-colors duration-150 hover:bg-primary-hover active:bg-primary-pressed"
            >
              主按钮（Hover / Pressed 状态）
            </button>
          </div>
        </section>
      </div>
    </main>
  )
}
