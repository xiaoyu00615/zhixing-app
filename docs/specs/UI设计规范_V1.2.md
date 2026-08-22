---
title: 个人知识与行动中枢
subtitle: 全局 UI 设计规范 V1.2
date: 2026-08-19
---

**Web / Windows Desktop 共用设计母版**  
**定位：单用户 · 本地优先 · 高信息密度 · 轻量克制 · 长时间使用不疲劳**  
**状态：CURRENT / UI 四批审核冻结后的正式母版**

# 0. 文档用途与硬性边界

本文件是首页、任务、画布、日记、笔记、搜索、设置等页面的 UI 真值，也是 TRAE / 代码 Agent 的统一设计约束。

| 类别 | 硬性规则 |
|---|---|
| 产品定位 | 单用户、本地优先的个人知识与行动中枢 |
| 禁止出现 | 团队、组织、负责人、协作者、多人头像、在线成员、公开分享、云套餐、会员等多人 SaaS 元素 |
| 同步定义 | 仅同一用户自己的设备之间同步；主业务页面不长期展示大型 Sync UI |
| AI 定位 | 嵌入式工具能力，不作为一级导航或大面积聊天中心 |
| 页面原则 | 一个页面承担一个主要工作目标；列表与编辑器应按需要分离；摘要页不塞完整模块 |
| 平台原则 | Web / Windows Desktop 主 UI 基本一致；Android 后续单独适配 |
| 设计真值 | 规范 Token > 冻结组件母版 > 冻结页面图 > 历史设计 |

# 1. V1.2 变更摘要

V1.2 将四批 UI 审核结果正式写回母版，重点新增：

- Badge 与 Tag 语义分离；
- 首页 CaptureItem / QuickCapture 规则；
- Ctrl+K = Command Palette，Global Search 独立；
- Task status / Importance / Urgency / Overdue 视觉语义分离；
- Canvas sticky Node、列表 / 编辑器分离与 AI Phase 边界；
- Diary / Note 的 Document 共用但产品页面独立；
- Archive / Trash 生命周期视觉规则；
- Settings 简单 / 高级存储模式；
- Local Save 文案；
- Device Sync 无主设备 / 无 Presence / 数据安全交互规则。

# 2. 设计目标

- 专业但不企业化；
- 精致但不花哨；
- 高信息密度但不拥挤；
- 长期使用舒适；
- 模块化一致；
- 数据安全操作可理解、可撤回、可恢复；
- 不用协作 SaaS 视觉套路污染个人工具。

# 3. 设计基准与 App Shell

| 项目 | 规范 |
|---|---|
| 标准高保真设计基准 | 1920 × 1080 px |
| 响应验证 | 1440 × 900 px |
| 最低推荐桌面宽度 | 1280 px |
| 大屏适配 | 1920–2560 px+ |
| 基础字体 | 14 px |
| 根字号 | 16 px |
| Sidebar | 224 px（允许 216–232 px 的实现级微调仅在规范更新后） |
| Topbar | 60 px |
| 页面主 Padding | 24 px；大型页面可 32 px |
| 基础 Grid | 4 px |
| 主滚动 | Sidebar / Topbar 固定，Main Content 独立滚动 |

```text
App Shell
├─ Sidebar 224px
├─ Topbar 60px
└─ Main Content
   ├─ Page Header
   ├─ Toolbar / Filters（可选）
   └─ Page Body
```

高保真 PNG 只用于理解视觉关系，不按实际图片像素测量 CSS。

# 4. 间距系统

| Token | 数值 | 用途 |
|---|---:|---|
| space-1 | 4 px | 图标内部、极小修正 |
| space-2 | 8 px | 紧密元素、Icon 与文字 |
| space-3 | 12 px | 输入框内部、小组件 |
| space-4 | 16 px | 标准组件间距 |
| space-5 | 20 px | 中等内容块 |
| space-6 | 24 px | 页面 / 卡片标准内边距 |
| space-8 | 32 px | 模块之间 |
| space-10 | 40 px | 大型分区 |
| space-12 | 48 px | 特殊大区域 |

主要优先使用 8 / 12 / 16 / 24 / 32 px，避免无理由随机值。

# 5. 字体与信息层级

| 用途 | 字号 | 行高 | 字重 |
|---|---:|---:|---:|
| 大页面标题 | 28 px | 36 px | 600 |
| 页面标题 | 24 px | 32 px | 600 |
| KPI 数字 | 30–34 px | 40 px | 600 |
| 一级模块标题 | 18 px | 26 px | 600 |
| 二级模块标题 | 16 px | 24 px | 600 |
| 强调正文 | 14 px | 22 px | 500 |
| 默认正文 | 14 px | 22 px | 400 |
| 辅助文字 | 13 px | 20 px | 400 |
| Caption | 12 px | 18 px | 400 |
| Tag / Badge | 12 px | 16 px | 500 |

字体：

```css
font-family: Inter, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
```

文字颜色：Primary `#18181B`；Secondary `#52525B`；Tertiary `#8A8F98`；Disabled `#B4B8C1`。

# 6. 色彩系统

| Token | 值 | 用途 |
|---|---|---|
| primary-600 | #565DE8 | Pressed / 强调 |
| primary-500 | #6269F2 | 主按钮 / 选中 / Focus |
| primary-400 | #7B81F5 | Hover / 次级强调 |
| primary-100 | #EDEEFF | 选中背景 |
| primary-50 | #F5F5FF | 极浅强调背景 |
| app-bg | #F7F8FA | 应用背景 |
| sidebar-bg | #FAFAFB | Sidebar |
| surface | #FFFFFF | 卡片 / 内容表面 |
| surface-secondary | #F6F7F9 | 次级表面 |
| border | #E7E9EE | 标准边框 |

状态色：Danger `#E5484D` / `#FFF1F1`；Warning `#D97706` / `#FFF7E8`；Success `#2E9B64` / `#EEF9F3`；Info `#3E73DC` / `#EFF5FF`。

状态色只用于小面积提示、Badge、图标、边框或极浅背景。

# 7. Badge、Tag、Project Chip

这是 V1.2 的重要语义分离。

## Badge

系统状态语义，例如：错误、警告、完成、进行中、归档提示等。颜色由系统语义决定。

## Tag

用户自定义分类标签，允许低饱和自定义颜色。不得固定“红 Tag = 紧急”“绿 Tag = 完成”等业务意义。

## Project Chip

Task 内部 Project 的轻量视觉表示，可有用户自定义低饱和颜色，但 Project 不是 Tag。

# 8. 圆角、边框与阴影

| 元素 | 圆角 |
|---|---:|
| Badge | 6 px |
| 小按钮 | 8 px |
| Input | 8 px |
| 普通按钮 | 9 px |
| Dropdown | 10 px |
| 小卡片 | 10 px |
| 标准卡片 | 12 px |
| 大卡片 | 14 px |
| Modal | 16 px |
| Drawer | 16 px |

普通卡片主要使用 1px `#E7E9EE` 边框和轻阴影；重阴影只用于浮层 / Modal。

# 9. Button 与交互状态

| 尺寸 | 高度 | Padding X | 字号 |
|---|---:|---:|---:|
| Small | 30 px | 10 px | 12 px |
| Medium | 36 px | 14 px | 14 px |
| Large | 40 px | 18 px | 14 px |

按钮类型：Primary / Secondary / Ghost / Danger / Icon。

所有交互控件至少有：Default / Hover / Focus / Disabled。关键按钮额外有 Pressed。Input / Select 不强制“Pressed”状态。

禁止复杂渐变、弹跳、持续旋转和夸张缩放。

# 10. Form Controls

| 组件 | 标准 |
|---|---|
| Input | 36 px 高；8 px 圆角；10–12 px Padding；14 px |
| Search | 38 px 高；320–420 px 常规宽度；10 px 圆角 |
| Select | 36 px |
| Dropdown | min 180 px；max 320 px；10 px 圆角 |
| Menu Item | 32–36 px |
| Checkbox | 默认 16×16；任务核心场景 18×18 |
| Tag | 22–24 px 高；6 px 圆角 |

Focus：`border-color: #6269F2; box-shadow: 0 0 0 3px rgba(98,105,242,.12);`

Toggle / Switch 的具体尺寸在实现时依据组件母版统一，不自行发明第二套体系。

# 11. Card、Table、List

| 组件 | 规范 |
|---|---|
| 标准 Card | 白底；1px border；12 px radius；16–20 px padding |
| 大 Card | 14 px radius；20–24 px padding |
| Table Header | 40 px |
| Table Row | 48–52 px，推荐 50 px |
| Row Hover | #F8F9FB |
| Row Selected | #F3F4FF |

不使用大量竖线。任务列表应降低 Excel 感，标题是视觉主项。

# 12. Modal、Drawer、Toast、Tooltip

| 组件 | 尺寸 / 行为 |
|---|---|
| Modal Small | 400–420 px |
| Modal Medium | 520–560 px |
| Modal Large | 720–800 px，尽量 ≤ 840 px |
| Drawer | 默认 420 px；范围 380–480 px |
| Toast | 300–380 px；右上角 |
| Tooltip | Icon-only；约 500 ms Hover 后出现 |

Drawer 默认覆盖主内容，不通过挤压页面改变原布局。

# 13. 导航与快捷键

Sidebar 一级导航统一：

- 首页；
- 任务；
- 画布；
- 日记；
- 笔记；
- 搜索；
- 标签；
- 归档；
- 回收站；
- 设置。

Topbar 只保留搜索 / Command 入口、快速创建、必要设置入口，不出现团队头像堆。

**Ctrl+K 固定为 Command Palette**：快速导航、快速命令、快速创建、最近访问。

Global Search 是独立一级页面；旧搜索设计图里出现的 Ctrl+K 仅作为历史视觉细节，不是当前快捷键规则。

# 14. 系统状态

## Empty

64–100 px 简洁插图 / 图标 + 标题 + 说明 + 单一主行动按钮。

## Loading

页面 / 卡片优先 Skeleton；局部操作才用 Spinner。

## Error

说明问题并提供重试 / 恢复操作。

## Local Save

编辑器使用：

- 正在保存；
- 已保存到本地；
- 保存失败。

避免用容易让用户误解为云端同步的“已同步”作为普通编辑保存文案。

## Sync

主要出现在设置 → 设备同步；主业务页面只在必要时轻量临时提示。

# 15. 首页 Today 规则

首页是摘要页。

- 1920 与 1440 优先保持 KPI 四列横排；
- 条目数量以版面阶段验证为准，设计图里的 5 / 4 / 4 不是硬规则；
- “最近记录” = CaptureItem，不等于 Diary；
- 快速记录在正常文档流最后，不是 Sticky Footer；
- `@` 如保留，只引用本地实体，不表示人员；
- 快速创建入口存在，但不提前锁定一定是 Modal / Dropdown / Popover；
- 首页不展示完整任务系统、完整月历、完整 Canvas 编辑器；
- 日程中不得出现“团队成员 / 参会成员”一类多人字段。

# 16. Task 页面规则

一级视图：列表 / 四象限 / 日历 / 时间线。

UI 必须区分：

- Status；
- Importance；
- Urgency；
- Overdue；
- Project；
- Tag。

Archive 不是 Task Status。Overdue 用 Danger 语义提示但不是数据库 status。

Create/Edit 不允许用一个含糊“优先级”字段把 Importance 与 Urgency 混合。

Project 是 Task 内部轻量分组，不出现负责人 / 协作者。

Timeline 的具体视觉形式留到实现评审，不默认甘特图。

# 17. Canvas 页面规则

画布列表页与画布编辑器必须分离。

## Canvas List

找画布、建画布、打开画布；不展示完整编辑器工具栏。

## Canvas Editor

沉浸式 100% 可用宽高，包含工具栏、无限画布、按需属性面板、MiniMap 等。

初始 Node Types：text / sticky / image / link / task / note / diary。

Group 是组织能力；Frame 不是 V1 Node Type。

AI 整理面板属于 Phase 8 能力展示，Phase 3 不实现正式 AI 业务。

Node Property 与 AI 面板不应默认同时常驻。

# 18. Diary / Note 页面规则

Diary 和 Note 是两个一级模块，虽然底层共用 Document。

## Diary

偏日期记录与回看；页面正文建议 720–820 px；使用 `diary_date` 的产品语义；智能日记夹是 Saved View，不是 AI / Folder。

## Note

偏知识编辑；支持 Note List / Folder / Favorite / Tag / Editor / Related Content。Folder 与 Tag 不混。

自动保存只承诺可靠本地保存，不在 UI 规范锁死具体 debounce 毫秒。

# 19. Global Search / Tag / Archive / Trash

## Global Search

独立全文搜索中心。主要动作是“预览 → 打开原实体”。不要默认把危险 Delete 放进 Result Preview。

结果 Entity Type 基线：Task / Canvas / CanvasNode / Note / Diary / CaptureItem。

## Tag

跨模块自定义标签。

## Archive

默认从主工作页面隐藏，可恢复。Archive 里的 Delete → Trash；不直接 Permanent Delete。

## Trash

Soft Delete 管理入口。Global Search 默认排除 Trash。Permanent Delete / Clear Trash 必须强确认；V1 不默认自动物理清空核心数据。

Attachment 暂不作为 Trash 一级类型。

# 20. Settings 页面结构

进入设置后：全局 Sidebar + 200–220 px 二级设置导航 + 右侧内容。

长期分类：

- 常规；
- 外观；
- 任务；
- 编辑器；
- 通知；
- 数据与存储；
- 备份与恢复；
- 设备同步；
- 快捷键；
- AI 设置；
- 关于。

# 21. 数据与存储 UI 规则

## 简单模式

一个“知行数据位置”，应用内部管理 database / attachments / thumbnails / backup / metadata。

## 高级模式

分别配置 Database / Attachments / Backup / Cache。

Cache 只表示明确可重建数据。

数据位置失效时显示：无法访问当前数据位置，并提供重试、重新连接磁盘、定位已有数据目录、重新指定位置、从 Backup 恢复等入口。不得用“新建空库”掩盖位置故障。

数据迁移必须展示明确的高风险说明和进度，迁移成功后旧数据不立即自动删除。

# 22. Backup / Restore UI 规则

Backup 页面区分：Manual / Auto / History / Restore。

设计图中的“每天、30 份、具体时间”都是示例，默认值在 Phase 6 决定。

Restore 是高风险操作：先验证 Backup，再 Safety Snapshot，再 Staging Restore，验证通过后切换。

Portable Settings 与 Device-local Settings 必须在文案 / 逻辑中区分。

# 23. Device Sync UI 规则

仅同一用户自己的设备。

- 不存在“主设备”默认概念；
- IP 只作为连接信息；
- Pair Code / QR 是临时配对凭证；
- Remove Device = 撤销 Trust，不远程删除业务数据；
- 不做多人 Presence；
- 状态优先使用“可连接 / 不可连接 / 正在同步 / 同步完成 / 需要处理”；
- Conflict 至少允许理解本机版本 / 其他设备版本，并给出保留本机 / 保留其他 / 保留两份等方向；具体 UI 可按 Entity 不同；
- 不宣传尚未完成验证的端到端加密 / 零知识等安全能力。

# 24. 响应式与页面宽度

| 页面 | 宽度策略 |
|---|---|
| 首页 | 1920 下建议主内容约 1500–1600 px；1440 下保持舒适密度 |
| 任务 | 尽量 Full Width |
| Canvas Editor | 100% 可用宽高 |
| Diary | 正文约 720–820 px |
| Note | 2–3 栏动态布局 |
| Search | 结果 + Preview，控制舒适阅读宽度 |
| Settings | 二级导航 + 右侧内容，正文不宜过宽 |

Mobile 后续单独设计，不把 Desktop 等比缩小。

# 25. 可访问性与动效

- 所有键盘可操作元素有可见 Focus；
- 禁止只写 `outline: none` 而无替代 Focus Ring；
- Icon-only 提供 Tooltip / aria-label；
- 常用操作预留快捷键；
- 普通 Hover 120–160ms；
- Modal 180–220ms；
- Drawer 200–240ms；
- easing：`cubic-bezier(.2,.8,.2,1)`；
- 禁止弹跳、持续旋转、大幅缩放、夸张浮动。

# 26. Z-Index

| 层级 | Z-Index |
|---|---:|
| 普通内容 | 0 |
| Sticky Header | 100 |
| Dropdown | 300 |
| Drawer | 500 |
| Modal | 600 |
| Toast | 700 |
| Tooltip | 800 |

# 27. CSS Token 建议

```css
:root {
  --app-bg: #F7F8FA;
  --sidebar-bg: #FAFAFB;
  --surface: #FFFFFF;
  --surface-secondary: #F6F7F9;
  --border: #E7E9EE;

  --text-primary: #18181B;
  --text-secondary: #52525B;
  --text-tertiary: #8A8F98;
  --text-disabled: #B4B8C1;

  --primary-600: #565DE8;
  --primary-500: #6269F2;
  --primary-400: #7B81F5;
  --primary-100: #EDEEFF;
  --primary-50: #F5F5FF;

  --danger: #E5484D;
  --warning: #D97706;
  --success: #2E9B64;
  --info: #3E73DC;

  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;

  --sidebar-width: 224px;
  --topbar-height: 60px;
  --control-height: 36px;
  --page-padding: 24px;
}
```

# 28. TRAE / 代码 Agent 不可违反清单

1. 默认正文 14 px；默认按钮 / Input 36 px。
2. Sidebar 224 px；Topbar 60 px；页面主 Padding 24 px。
3. 标准 Card 12 px；Modal / Drawer 16 px。
4. Task Drawer 约 420 px。
5. 统一 4 px Grid；主要间距 8 / 12 / 16 / 24 / 32。
6. 不用大面积高饱和、玻璃拟态、重渐变、发光描边。
7. 一级导航中文；Lucide React 图标。
8. 主界面不出现团队、负责人、协作者、多人头像、升级套餐等。
9. 所有交互控件有 Default / Hover / Focus / Disabled；关键按钮额外 Pressed。
10. 所有正式页面考虑 Empty / Loading / Error。
11. Ctrl+K = Command Palette，不等于 Global Search。
12. Tag 与 Badge、Project、Folder 不混。
13. 首页最近记录 = CaptureItem；快速记录非 Sticky Footer。
14. Task 的 Importance / Urgency / Overdue / Status 分离。
15. Canvas List / Editor 分离；sticky Node 不得遗漏；AI 不在 Phase 3。
16. Diary / Note UI 独立；智能日记夹是 Saved View。
17. Archive 不直接 Permanent Delete；Trash 默认排除于 Global Search。
18. Local Save 使用“已保存到本地”等准确文案。
19. Storage 有简单 / 高级模式；数据位置失效不得创建空库。
20. Backup / Restore / Sync UI 必须体现数据安全边界。
21. Device Sync 无主设备、无多人 Presence。
22. 图片尺寸只作视觉参考，规范 Token 才是 CSS 真值。

# 29. 设计稿交付映射

- `design/1.基础UI.png`：组件视觉母版；
- `design/2.首页.png`：首页与 App Shell；
- `design/3.任务.png`：Task 功能展示板；
- `design/4.画布.png`：Canvas 功能展示板，正式实现需拆列表 / 编辑器；
- `design/5.日记 - 笔记.png`：Diary / Note；
- `design/6.搜索.png`：Global Search / Tag / Archive / Trash；
- `design/7.设置.png`：Settings / Storage / Backup / Sync。

所有四批 UI 已 FROZEN。若后续重大视觉或交互变更，必须先升级规范版本，再进入开发。
