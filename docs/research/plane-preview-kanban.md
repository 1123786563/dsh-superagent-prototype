# Plane preview 看板源码研究

研究日期：2026-11-06。目标：为当前 Superagent 面板换成类似 Plane 的工作看板提供源码依据；本次只研究，不实现、不安装 Plane 依赖、不修改运行中的插件。

## 1. 版本、证据与结论

研究入口为 [makeplane/plane 的 preview 分支](https://github.com/makeplane/plane/tree/preview)。GitHub branches API 与独立 sparse clone 的 `git rev-parse HEAD` 一致，固定到 **`618d0eb74658329a6f6e92434ac54231422c5b96`**，提交日期为 2026-11-03。下文所有 Plane 源码链接均使用此 SHA，不随 preview 移动。[提交记录](https://github.com/makeplane/plane/commit/618d0eb74658329a6f6e92434ac54231422c5b96)

本次实际读取原始文件，临时 checkout 位于 `/tmp/plane-preview-research.eO3Mq1`。未运行 Plane、未安装其依赖、未做截图或动态行为验证。文中的“已读事实”指代码中可直接确认的结构与分支；“推断/建议”是面向 Superagent 的设计判断。函数存在不代表所有部署都开启该能力。

核心判断：**值得借鉴的是“同一批工作项的多种视图、可折叠分组列、简洁卡片、保留上下文的详情面板、准确的分组计数与分页”；不宜把 Plane 的任务实体、可编辑状态和自由拖拽直接移植到 Superagent。** Plane 的状态是 Issue 的外键字段，拖列会修改它；Superagent 的阶段则由 Ticket/Assignment/Report 等事实推导，创建 Ticket 也需要 Eval 授权。[Plane 状态模型][P21]、[拖拽字段更新][P14]；本地依据：[领域模型](../001-domain.md)、[阶段分类](../../src/core/stage.ts)。

研究前已读本仓库 [面板约定](../005-panel.md)、[领域约定](../001-domain.md)、[架构说明](../007-architecture.md) 的相关段落：保留领域术语、数字与实际结果一致、优先暴露需人工处理的事项、沿用 DSH tokens。具体接入建议另见 [Superagent 看板替换建议](superagent-kanban-plan.md)。

## 2. 前端应用与 packages 分工

### 2.1 应用边界

| 应用 | 已读事实 | 对本次研究的意义 |
| --- | --- | --- |
| `apps/web` | 主工作台。项目 issues 路由进入 `ProjectIssuesPage`，再渲染 `ProjectLayoutRoot`；布局枚举包含 List、Kanban、Calendar、Gantt、Spreadsheet。[路由][P05]、[页面][P06]、[布局根][P07] | 真正需要追踪的看板实现位于这里，不能只看公共 UI 包 |
| `apps/admin` | 单独的 Admin UI；路由包含 general、workspace、email、authentication、ai 等。[manifest][P30]、[路由][P31] | 实例管理界面，不是项目看板入口 |
| `apps/space` | 单独的发布访问应用；项目入口通过 `SitesProjectPublishService` 查询发布设置，重定向到 `issues/:anchor`，并传递 `board/peekId` 参数。[manifest][P32]、[发布跳转][P33] | 对外发布的项目内容入口，不能与 web 的内部看板代码混为一谈 |
| `apps/live` | manifest 明确为富文本编辑器的实时协作服务，依赖 Hocuspocus、Yjs、Express 等。[manifest][P34] | 不能据此推断看板卡片也通过 WebSocket 实时同步；本次未验证看板的多人并发同步 |
| `apps/api` | Django 模型、Issue 查询/分组分页、局部更新和 serializer 校验。[查询及更新][P23]、[serializer][P24] | 看板准确计数、分页、状态合法性并非全由前端承担 |
| `apps/proxy` | Caddy 将 `/spaces/*`、`/god-mode/*`、`/live/*`、`/api/*` 分别转给上述服务，其他路径转 web。[Caddy 配置][P35] | 这是多应用系统，不是可直接嵌入 DSH 的单个看板应用 |

**版本辨识：该 SHA 的 web 已使用 React Router + Vite，而不是依据历史文章就认定为 Next.js。** manifest 使用 `react-router dev/build`，workspace pin 为 React 19.2.8、React Router 8.3.0；部分组件仍 import `next/navigation`，但 Vite 明确把它 alias 到兼容 shim。[web manifest][P02]、[workspace catalog][P03]、[Vite 配置][P04]

### 2.2 公共包边界

| 包 | 从已读文件可确认的职责 | 不应误判的部分 |
| --- | --- | --- |
| `@plane/blocks` | Plane 复合组件：layout、portal、property-select、work-item-properties、toast、virtual-list 等 exports，建立在 `@makeplane/propel` primitives 上。[manifest][P25] | 当前不是旧版 `@plane/ui`；Issue 看板的业务根仍在 web |
| 外部 `@makeplane/propel` | web 与 blocks 的依赖；看板实际 import Button、Menu、Tooltip、图标等。token/animation 样式也由它提供。[manifest][P02]、[卡片][P11]、[样式入口][P29] | 它不在本仓库 `packages` 源码中；本次没有读取其发布包源码或单独许可证，不能声称审计了该库 |
| `@plane/types` | Issue、状态、布局、响应、Store 类型；`TIssue` 含 `state_id/sort_order/assignee_ids/label_ids/cycle_id/module_ids` 等。[Issue 类型][P20]、[状态类型][P22] | 这些是 Plane 领域契约，不是 Superagent 已有能力 |
| `@plane/constants` | 筛选/布局选项、可拖分组集合等。[筛选常量][P18]、[拖拽白名单][P17] | 配置了一个分组选项，不等于该分组允许拖动 |
| `@plane/services` | 共享服务 exports 与 Axios API 基类。[exports][P26]、[APIService][P27] | web 仍有自己的 `services/issue/issue.service.ts`；核心 Issue PATCH 并非都在公共 services 包中。[实际服务][P16] |
| `@plane/shared-state` | MobX 筛选实例与 rich-filter 管理；按 entity type/id 复用实例。[筛选 Store][P28] | web 的 Issue 数据、分组与分页 Store 仍在应用内，不能只抽走 shared-state 就获得完整看板 |
| `@plane/utils` | 被看板调用的通用链接、className、日期等工具；而分组列生成和 drop-to-fields 的业务工具位于 web。[卡片 import][P11]、[业务工具][P14] | 不要把名称为 utils 的所有代码都看成无业务依赖 |
| `@plane/editor` | 暴露 CollaborativeDocument、Document、LiteText、RichText editors 及扩展。[exports][P36] | 主要用于详情描述与文档；最小看板无需引入整套协作编辑器 |
| `@plane/hooks` / `@plane/i18n` | 通用 dialog、local-storage、outside-click 等 hooks；翻译 provider、hook 与语言配置。[hooks][P37]、[i18n][P38] | Superagent 已有本地化与上下文，可复用本地实现 |
| `@plane/tailwind-config` / `@plane/typescript-config` | 样式入口引用 Propel styles；提供 React Router 的 TS 编译配置。[样式][P29]、[TS 配置][P39] | 不应为换看板而整体替换 DSH 的样式与构建体系 |
| `decorators` / `logger` / `codemods` | 前两者的仓库说明分别用于 Express 控制器装饰器和日志；codemods 的说明是 jscodeshift 操作。[decorators][P40]、[logger][P41]、[codemods][P42] | 这些不在本次 Issue 看板交互主链中；仅阅读了说明，未审计实现 |

**推断/建议：**最适合借鉴的是“领域数据 → 分组投影 → 列/卡片 → 操作回调”的组织方式。直接复制 web 的看板会牵入 root Store、用户权限、项目状态、路由 shim、筛选、国际化与编辑器等依赖；这不是导入一个 Kanban 组件就能解决的任务。[看板根依赖][P08]、[列生成对全局 Store 的依赖][P14]

## 3. 看板入口与组件调用链

已读的项目路径如下。这里是源码静态调用关系，不是运行时性能追踪。[路由][P05]、[页面][P06]、[布局根][P07]、[项目看板][P43]、[通用看板根][P08]

```text
/:workspaceSlug/projects/:projectId/issues
  → ProjectIssuesPage
  → ProjectLayoutRoot
      ├─ 读取 project 用户筛选/显示设置
      ├─ IssuesStoreContext = PROJECT
      ├─ ProjectLevelWorkItemFiltersHOC + WorkItemFiltersRow
      ├─ 按 displayFilters.layout 选择列表/看板/日历等
      │   → KanBanLayout（项目权限适配）
      │   → BaseKanBanRoot（取数、操作、折叠、自动滚动）
      │       ├─ 无 sub_group_by：KanBan
      │       └─ 有 sub_group_by：KanBanSwimLanes
      └─ IssuePeekOverview（详情，不与布局一起切换）
```

`BaseKanBanRoot` 通过 `useIssues(storeType)`、`useIssuesActions(storeType)` 读取分组数据和行为，类型支持 Project、Cycle、Module、Project View、Profile 等场景；本次完整追踪的是 Project 路径，没有逐个验证所有其他入口。初始化获取分组数据时，普通列每组 30 条，有子分组时每组 10 条；列加载更多另传 group/subgroup。[通用根第 34–105 行][P08]

仓库还存在 `components/base-layouts/kanban/layout.tsx`：它是泛型 items/groups/renderItem/onDrop 接口，支持内部或外部折叠状态，拖拽默认关闭。**已读的 Issue 路径使用上面的专用 KanBan，而非这个泛型 BaseKanbanLayout。** 不能看到后者就把它当作实际任务看板主入口。[泛型布局][P44]、[专用根][P08]

## 4. 分组列、卡片与数据规模

### 4.1 列由领域元数据生成

`getGroupByColumns` 按 groupBy 分派到 state、state group、priority、assignees、labels、cycle、module、project、created_by 等列生成器。state 列使用项目状态数据，列 id 是 state id，名称/颜色/icon 来自状态，创建 payload 是 `{state_id}`；labels、assignees、cycle、module 有 None 列。列不是由当前已加载卡片“碰巧出现的值”枚举出来的。[列生成器第 119–300 行][P14]

`KanBan` 对每列分别计算：是否显示空列、是否折叠、group count、该列已加载 issueIds。展开列宽写为 336px；普通看板固定列头，外层横向滚动，列内部纵向滚动；swimlane 按 sub_group_by 展开二维分组。折叠列保留可展开的按钮和计数。[普通列][P09]、[列主体][P10]、[swimlanes][P45]

列头负责 icon、标题、总数、折叠、创建/加入已有任务入口；Quick Add 会从所在列预填 state、priority、assignees 等字段，并受创建权限控制。[列头][P46]、[预填逻辑][P10]

**可借鉴：**先定义稳定的列集合，空列仍能说明工作流；将“总量”“已加载量”“折叠”分开处理。Superagent 可保留列头与折叠机制，但每列的 `+` 创建入口需要重新设计授权流程。[Plane 列渲染][P09]；本地：[Ticket 创建规则](../001-domain.md)

### 4.2 卡片为摘要，详情承载长内容

卡片主要由三段组成：IssueIdentifier、标题、按 displayProperties 显示的属性区；快速操作按钮在 hover/focus 或菜单打开时显示，移动端保持可见。属性控件复用 `IssueProperties`，根据权限 readonly，并把修改交给 updateIssue 回调。state/priority/labels/assignees 等属性确实可编辑，不只是装饰 badge。[卡片第 66–144 行][P11]、[属性更新第 157–170 行][P47]

卡片有真实链接与点击详情行为；正在 peek 的卡片有边框提示。临时乐观创建的 `tempId` 卡片不能拖动，也不能打开详情。卡片与列都用 `RenderIfVisible` 延迟渲染，按属性数量估算占位高度；这与服务端分页一起控制开销，不能简单称为整板采用固定行高虚拟列表。[卡片第 169–294 行][P11]、[普通列][P09]

**可借鉴：**Superagent 卡片显示标题、关联来源/Issue/PR、更新时间，待人工卡片优先显示 question 或失败/受阻原因；长授权信息、Inputs 与 Assignment 历史放右侧详情。不要为模仿外观而虚构成员、优先级、标签等本项目没有的字段。[Plane 卡片结构][P11]；本地：[工单摘要投影](../../src/app/views/records.ts#L118)

### 4.3 计数与分页是看板正确性的一部分

前端 `getGroupIssueCount` 与 `issueIds.length` 分开使用；列用 IntersectionObserver 和“加载更多”获取下一页，防止一次渲染全部任务。后端读取 `group_by/sub_group_by`，分别选择 `GroupedOffsetPaginator` 或 `SubGroupedOffsetPaginator`；相同主/子分组返回 400，分组计数来自查询集。[列级加载][P10]、[API 第 298–403 行][P23]

**推断/建议：**Superagent 现有 `GET tickets` 默认只有 20 条，上限 1000，不能先取一页再前端分组并把各组长度标为总数。最小正式版本应增加只读 board 聚合，五列在同一读取快照内产生 total、首批卡片与分页信息，或明确保证拿到完整集合再分组；搜索/筛选先作用于候选集，再分组/计数/分页。[Plane 分组接口依据][P23]；本地：[TicketsQuery](../../src/app/http.ts#L140)、[接入计划](superagent-kanban-plan.md)

## 5. 拖拽如何变成状态更新

### 5.1 已读完整主链

| 步骤 | 实际代码行为 | 源码 |
| --- | --- | --- |
| 注册拖拽源 | 卡片 `draggable` 的 payload 是 `{id, type: 'ISSUE'}`；权限、可拖分组和 tempId 共同决定 canDrag | [block.tsx 第 183–240 行][P11] |
| 确定落点 | 列是 COLUMN drop target，提供 groupId/subGroupId/columnId；卡片也是 drop target，用于定位插入位置 | [kanban-group.tsx 第 129–197 行][P10] |
| 解析源/目标 | 从初始/当前 dropTargets 提取列与卡片信息，读取 reorder-below instruction | [utils.tsx 第 401–466 行][P14] |
| 构造字段补丁 | 计算新 sort_order；跨列时将 groupBy 映射成实际字段。标量直接换值；数组删除来源组、添加目标组；主/子分组都处理 | [utils.tsx 第 475–632 行][P14] |
| 分派特殊关系 | cycle/module 通过专门关联方法处理，其余交给 updateIssue；错误 toast | [use-group-dragndrop.ts][P13] |
| 先更新本地 | clone 旧 Issue；更新主 issue map、所在列表和父级统计，再发 PATCH；失败恢复旧 Issue 与列表并抛出错误 | [base-issues.store.ts 第 555–588 行][P15] |
| 发送请求 | PATCH `/api/workspaces/{slug}/projects/{projectId}/issues/{issueId}/`，默认 serviceType 为 issues | [issue.service.ts 第 24–30、226–231 行][P16] |
| 服务端保存 | partial_update 经权限控制，使用 IssueCreateSerializer(partial=True)，合法后保存，并排队记录 Issue/model activity | [base.py 第 628–708 行][P23] |
| 校验与派生 | serializer 验证 state 属于当前 project；模型在 state 变化时同步 completed_at | [serializer 第 178–186 行][P24]、[模型第 240–255 行][P21] |

列内排序使用浮点 `sort_order`：首项之前减 65535、末项之后加 65535、中间取相邻值平均、空列默认 65535。这是持久化的任务排序值，不只是重排 React 数组。[排序算法][P14]

### 5.2 不能推断成“任何列都可自由拖”

`DRAG_ALLOWED_GROUPS` 只含 state、priority、assignees、labels、module、cycle。project、created_by、state group 等不在该列表；有主/子分组时两者都要允许。非 `sort_order` 排序时，不应向用户暗示可任意决定卡片插入次序，列 overlay 与高亮用于反馈此行为。[白名单][P17]、[判断 Store][P19]、[列反馈][P10]、[drop 参数][P13]

普通 Issue UI 调用了名为 workflow 的 hook，**但该 checkout 的 `use-workflow-drag-n-drop.ts` 实际是 no-op：`isWorkflowDropDisabled: false`，状态处理为空函数。** 因而不能声称已读到了强制状态迁移图、复杂审批流或企业版 workflow 实现。[实际 hook][P48]

**建议：**第一版 Superagent 自动归列，不提供改阶段的拖拽。重试、停止、回复来源、打开执行 Session 才是当前真实操作；若以后增加拖拽，先为每种目标明确领域命令、前置条件、并发冲突与失败恢复，再让拖拽调用命令。不得新增一个 UI 可随意写入的 stage 字段。[Plane 字段变更事实][P14]；本地：[阶段推导](../../src/core/stage.ts)、[现有详情操作](../../src/client/ticket.tsx#L108)

## 6. 筛选、布局和保存视图

Plane 的过滤并非一个混合对象。已读 Store 明确分为：[项目筛选 Store][P12]、[筛选类型常量][P18]

| 类型 | 保存内容 | 已读持久化路径 |
| --- | --- | --- |
| `richFilters` | 工作项条件表达式，决定哪些任务符合条件 | 更新 project user properties 的 `rich_filters` 并重新获取任务 |
| `displayFilters` | layout、group_by、sub_group_by、order_by、show_empty_groups 等 | 更新 user properties 的 `display_filters`；必要时 clear/refetch |
| `displayProperties` | 卡片/列表中显示哪些属性 | 更新 `display_properties` |
| `kanbanFilters` | 收起了哪些主列/子组 | 读取按当前用户、workspace、entity 区分的本地持久化配置 |

切到看板且 group_by 为空时，Store 自动设为 state；主/子分组相同时去掉 sub_group_by。ProjectLayoutRoot 渲染的过滤 HOC 会创建/复用 filter instance，并在卸载时删除实例；公共 shared-state 管实例与表达式，web 负责项目字段配置及回调。[归一化规则][P12]、[过滤 HOC][P49]、[公共 Store][P28]

“保存视图”是把当前 `rich_filters + display_filters + display_properties` 组合成一个命名 View。项目 HOC 负责创建/更新权限、锁定/所有者判断并打开 View modal；Project View 的 Store 从 ViewService 读取配置，再配合本地折叠状态。它是完整的实体与权限能力，不只是 localStorage 中保存一个 layout 字符串。[保存 View payload 第 118–150 行][P50]、[View 筛选 Store][P51]

**可借鉴：**Superagent 初版也应分开“哪些 Ticket”“如何排列”“显示什么”“哪列折叠”，Board/List 共用筛选。先做已有来源与阶段语义的简洁过滤，最多保存个人显示偏好；复杂 AND/OR 表达式和可共享/可锁定 View 暂不纳入最小版。[Plane 分层依据][P12]、[View 的额外成本][P50]

## 7. 详情面板如何保留看板上下文

卡片点击经 `useIssuePeekOverviewRedirection`：桌面调用 `setPeekIssue({workspaceSlug, projectId, issueId, ...})`；移动端 push 完整 work item 链接。ProjectLayoutRoot 将 `IssuePeekOverview` 与布局并列挂载，打开详情无需换掉整个看板。[跳转 hook][P52]、[布局根][P07]

详情根根据 peekIssue 获取 Issue、加载属性、计算编辑权限；修改后请求 activities 刷新，错误 toast。详情 View 默认 `side-peek`，另有 modal/full-screen 模式，通过 portal 挂载。side-peek 位于右侧，桌面宽 50%、窄屏全宽；内容包括标题/描述、widgets、properties、activity。[详情根][P53]、[详情 View][P54]

关闭行为考虑 Escape、外部点击、编辑器弹层和其他 modal；Escape 逻辑尝试把 focus 放回 `issue-{id}` 元素。这里仅说明已读到恢复意图，未验证目标元素是否可聚焦及完整键盘可达性，也未验证屏幕阅读器表现。[关闭与焦点代码][P54]

**可借鉴：**Superagent 详情抽屉应保留看板滚动、筛选和卡片选中状态；使用既有 Ticket 内容与命令，窄屏全宽，有明确关闭按钮、Escape 和可靠焦点恢复。第一版只需右侧/全宽两种表现，无需同时实现三种 peek 模式。[Plane 详情依据][P52]、[P54]；本地：[TicketPage](../../src/client/ticket.tsx#L108)

## 8. 状态模型与许可证边界

### 8.1 状态不是五个写死的列

后端 `State` 是项目内实体，含 name、color、sequence、group、default 等，Issue 通过 state 外键引用它。一个 group 可以包含多个自定义 State；State.sequence 决定状态顺序，Issue.sort_order 决定任务顺序，是不同层次。[State 模型][P55]、[Issue 模型][P21]

该 SHA 有一个容易漏看的差异：后端 `StateGroup` 包含 **backlog、unstarted、started、completed、cancelled、triage 六种**，DEFAULT_STATES 也包含 Triage；但普通 `StateManager` 默认排除 triage，前端常规 `TStateGroups` 只有前五种。因此不能笼统说 Plane 全系统只存在五个状态组，也不能因此把 Triage 当成普通看板必显第六列。[后端第 14–97 行][P55]、[前端类型][P22]

Issue 保存时无 state 会补项目默认/首个非 triage 状态；state 变成 completed 组时设置 completed_at，离开该组则清空。可见“完成”有明确字段和派生逻辑，不是把卡片挪到一个名字叫 Done 的容器。[Issue 默认状态与完成时间][P21]

### 8.2 可以借鉴交互，复制源码要处理 AGPL

根 manifest、web 和 blocks manifest 声明 `AGPL-3.0`，本次读取的看板、Store、types 和 API 源文件头更精确标注 **`SPDX-License-Identifier: AGPL-3.0-only`**。不能按 MIT/Apache 的可任意复制前提处理这些文件。[根 manifest][P01]、[web manifest][P02]、[看板文件头][P08]、[LICENSE.txt][P56]

许可证正文第 5、6 节涉及修改版本及非源码形式的传播条件，第 13 节要求：若修改该程序并让用户经网络交互，应显著提供取得该版本 Corresponding Source 的机会。具体组合/衍生作品范围需根据实际复用方式判断；本研究没有给出“仅复制某个组件就一定无需开放其他部分”的结论。[许可证第 5/6 节](https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/LICENSE.txt#L196-L309)、[第 13 节](https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/LICENSE.txt#L540-L559)

**建议：**按照本文总结的交互原则，以 Superagent 数据契约和 DSH 控件自行实现；暂不复制 Plane TSX/Store/CSS，不引入其工作区依赖。若决定移植具体源码，再按每个文件与外部依赖实际许可证审查。Propel 的独立许可未在本次 checkout 内核实。[已核实许可证][P56]、[Propel 为外部依赖][P25]

## 9. 最小第一版建议及不直接搬用的部分

以下均为**面向本项目的建议，尚未实现**。详细文件接入、验收次序见 [Superagent 看板替换建议](superagent-kanban-plan.md)。

| 第一版保留 | 理由与源码依据 |
| --- | --- |
| 沿用 DSH 的 Superagent 侧栏入口，内部默认 Board，可切 List；来源/触发/评估/设置保留二级入口 | Plane 同一对象集有多种布局；本地现有 main/sidebar slots 与六 tab 可调整外壳。[Plane 布局根][P07]；[本地注册](../../src/client/index.tsx#L53)、[页面切换](../../src/client/app.tsx#L141) |
| 全宽横向看板、稳定列头、真实总数、空态、可折叠列、列内分页 | Plane 列与分页模式可直接作为交互参考；本地现有 960px 最大宽不适合多列。[Plane 列][P09]、[分页][P23]；[本地样式](../../src/client/client.css#L7) |
| Ticket 摘要卡片，突出待人工问题与关联来源；右侧详情复用现有内容 | Plane 卡片与 peek 的职责分离；本地已有 title、stage/action、note、attention、sessionId、threads 等投影。[Plane 卡片][P11]、[peek][P54]；[本地摘要](../../src/app/views/records.ts#L118) |
| 只提供已有真实命令：打开 Session/来源、retry、stop；自动更新列归属 | Plane 的字段补丁逻辑不能套用到推导阶段。[Plane 拖拽][P14]；[本地阶段](../../src/core/stage.ts)、[本地操作](../../src/client/ticket.tsx#L131) |
| 复用本地化、caller、轮询、错误提示与重启恢复 | 不需要为了视觉换成 MobX、SWR 或 Plane 服务层。[Plane 根依赖][P08]；[本地 PanelProvider](../../src/client/provider.tsx) |

建议五列由一个统一分类函数产生，不新增可写 stage，不重复卡片：

| 列 | 本地判定 | 产品文案要求 |
| --- | --- | --- |
| 待启动 | `stage === 'working' && action === 'queued'` | 已获授权、Assignment 尚未启动 |
| 执行中 | `stage === 'working' && action !== 'queued'` | 不把“执行中”解释为持续输出 token |
| 待人工 | `stage === 'person'` | 继续区分 answer/review/blocked/failed/delivery，显示原因与适用操作 |
| 等待事件 | `stage === 'idle'` | 等后续输入/线程事件，不能混同待人工 |
| 已结束 | `stage === 'ended'` | 保留具体 outcome；停止/关闭/合并均可能结束，不能统称“已完成” |

该表直接依据本地 [ticketStage](../../src/core/stage.ts#L9)；与 Plane 的 `state_id` 可编辑模型的差别见 [状态模型][P55]、[字段更新][P14]。需人工事项可通过排序或快捷筛选优先展示，避免为突出它而复制同一 Ticket 到第二列。

第一版排除：自由拖阶段、列内 `+` 直接创建 Ticket、自定义状态工作流、成员分配、优先级、标签、Cycle/Module、多项目空间、协作富文本编辑器、共享/锁定 Views。它们在 Plane 中都有额外的领域模型、权限、关系更新或协作服务；Superagent 当前没有这些契约。若以后做新建，应从“提交请求 → Eval/授权 → Ticket”设计，而不是跳过 Mandate。[Plane 字段与特殊更新][P20]、[P13]、[保存视图权限][P50]、[协作服务][P34]；本地：[领域模型](../001-domain.md)

最先验证三个场景：待启动进入执行中；blocked/failed 与人回复之后的重新归类；不同 ended outcome 的正确展示。同时检查筛选后的列总数、超过首屏分页、详情关闭后的上下文与焦点、失败操作后的真实状态。此处是后续验收建议，不表示本次运行过这些测试。[Plane 分页/回滚/详情依据][P10]、[P15]、[P54]

## 10. 已读范围与待验证项

主链文件均已读取正文相关段落：路由/页面、ProjectLayoutRoot、项目 KanBanLayout、BaseKanBanRoot、KanBan、KanbanGroup、block、swimlanes/列头相关段落、utils 的列生成与完整拖拽函数、drag hook、Issue Store 更新/回滚、IssueService GET/PATCH、API 的分组分页与 partial_update、IssueCreateSerializer 校验、State/Issue 模型关键段落、filter Stores/HOC、peek hook/root/view、LICENSE。上文链接即为源码索引；对较长文件只读与本题有关段落，不表示穷尽整文件所有逻辑。

辅助范围：各应用 manifest/路由、blocks manifest、services/types/editor/hooks/i18n/shared-state 的相关 exports 或实现、样式入口、构建别名；decorators/logger/codemods 只读仓库说明。没有审计全部后端任务、所有 public Space 看板、所有 View/Cycle/Module 入口、企业版扩展、Propel 发布包、权限全链或所有并发情形。

仍需后续独立验证：拖拽的键盘替代、完整可访问性、多个客户端同时更新时的冲突、离线重试、大量卡片的性能、真实主题/窄屏呈现。源码中的乐观回滚证明存在失败恢复路径，不能据此承诺没有竞态或已经通过端到端测试。[回滚实现][P15]、[卡片交互][P11]、[详情关闭][P54]

<!-- 以下为全文源码引用定义，全部固定到研究 SHA。 -->

[P01]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/package.json
[P02]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/package.json
[P03]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/pnpm-workspace.yaml
[P04]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/vite.config.ts#L24-L31
[P05]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/app/routes/core.ts#L134-L147
[P06]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/app/(all)/%5BworkspaceSlug%5D/(projects)/projects/(detail)/%5BprojectId%5D/issues/(list)/page.tsx
[P07]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/issues/issue-layouts/roots/project-layout-root.tsx
[P08]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/issues/issue-layouts/kanban/base-kanban-root.tsx
[P09]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/issues/issue-layouts/kanban/default.tsx
[P10]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/issues/issue-layouts/kanban/kanban-group.tsx
[P11]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/issues/issue-layouts/kanban/block.tsx
[P12]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/store/issue/project/filter.store.ts
[P13]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/hooks/use-group-dragndrop.ts
[P14]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/issues/issue-layouts/utils.tsx
[P15]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/store/issue/helpers/base-issues.store.ts#L546-L589
[P16]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/services/issue/issue.service.ts
[P17]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/constants/src/issue/common.ts#L93-L100
[P18]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/constants/src/issue/filter.ts
[P19]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/store/issue/issue_kanban_view.store.ts
[P20]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/types/src/issues/issue.ts
[P21]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/api/plane/db/models/issue.py
[P22]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/types/src/state.ts
[P23]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/api/plane/app/views/issue/base.py
[P24]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/api/plane/app/serializers/issue.py#L82-L186
[P25]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/blocks/package.json
[P26]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/services/src/index.ts
[P27]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/services/src/api.service.ts
[P28]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/shared-state/src/store/work-item-filters/filter.store.ts
[P29]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/tailwind-config/index.css#L1-L17
[P30]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/admin/package.json
[P31]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/admin/app/routes.ts
[P32]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/space/package.json
[P33]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/space/app/%5BworkspaceSlug%5D/%5BprojectId%5D/page.tsx
[P34]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/live/package.json
[P35]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/proxy/Caddyfile.ce
[P36]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/editor/src/index.ts
[P37]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/hooks/src/index.ts
[P38]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/i18n/src/index.ts
[P39]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/typescript-config/react-router.json
[P40]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/decorators/README.md
[P41]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/logger/README.md
[P42]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/packages/codemods/instructions.md
[P43]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/issues/issue-layouts/kanban/roots/project-root.tsx
[P44]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/base-layouts/kanban/layout.tsx
[P45]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/issues/issue-layouts/kanban/swimlanes.tsx
[P46]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/issues/issue-layouts/kanban/headers/group-by-card.tsx
[P47]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/issues/issue-layouts/properties/all-properties.tsx
[P48]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/workflow/use-workflow-drag-n-drop.ts
[P49]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/work-item-filters/filters-hoc/base.tsx
[P50]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/work-item-filters/filters-hoc/project-level.tsx
[P51]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/store/issue/project-views/filter.store.ts
[P52]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/hooks/use-issue-peek-overview-redirection.tsx
[P53]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/issues/peek-overview/root.tsx
[P54]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/web/components/issues/peek-overview/view.tsx
[P55]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/apps/api/plane/db/models/state.py
[P56]: https://github.com/makeplane/plane/blob/618d0eb74658329a6f6e92434ac54231422c5b96/LICENSE.txt
