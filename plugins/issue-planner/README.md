# Issue 定时规划

独立 DSH Host 插件：完整分页读取 open issues 和父子/依赖关系，从根需求读取上下文，每轮只规划一张已就绪的叶子任务。使用真实 superpowers writing-plans 技能生成实施计划，再由独立规划账号评论 `@wuyj-agent`，要求现有 worker 加载 executing-plans 技能实施。规划交接后即可在下一轮规划另一张，实施并发沿用 Superagent 设置。

## 表单与启停开关

加载 0.1.1 后，打开 DSH 的 **设置 → Issue 定时规划**。这是原生设置页中的新增条目，不替换 Superagent 自有设置或其他插件页面。

- 顶部的“启用定时规划”开关先修改草稿，点击“保存并启用”才实际保存；关闭时点击“保存并关闭”。关闭新规划不停止已交接的实施工单。
- 基础表单包含仓库、独立规划账号 CLI、执行账号、源码目录、技能目录及轮询间隔。启用前须补齐必填项。账号身份、权限、真实目录等仍由运行时预检核对；保存配置不代表预检已通过。
- 折叠的“运行与卡住处理”包含规划超时、最多尝试次数、评论对账间隔、工单接收与进展停滞阈值。
- 显示实际运行状态、未就绪原因和当前 issue，并每 5 秒更新；更新只替换运行状态，不覆盖用户草稿。保存值尚未由运行配置加载时显示等待提示。
- 保存失败保留草稿。并发编辑发生版本冲突时要求重新加载；未保存的内容在重新加载前需确认丢弃。动态配置表达式不会被表单静默改写，遇到此类字段时表单只读。
- 配置通过 ConfigEditor 序列化保存并按 Loader 生命周期重新加载。未在表单中展示的模型、标签及其他字段保持原值。独立设置 Host 条目不随自动化条目的重载销毁，从而保留保存请求的完整生命周期。
- 启用会授予定时读取、模型调用和评论权限，因此只提供用户表单操作，不注册供 agent 调用的配置写工具。

若安装器返回 `restart-required` / `package-moved`，需要重启 DSH 后再刷新页面。本机 0.1.1 已在现有 GUI 加载并完成真实保存验证，当前开关为关闭。重启本身不会启用自动化。

## 配置与启动

通过 DSH `plugin_manager install_bundle` 安装本目录。默认 `enabled: false`，安装不会扫描、调用模型或发表评论。启用前配置：

| 字段 | 含义 |
| --- | --- |
| `repository` | 必须与当前 Superagent GitHub 来源一致的 owner/repo |
| `plannerCli` | 独立规划账号的 gh 包装命令；普通 User 账号，须不同于执行账号、具备仓库写权限并在 Superagent 允许发起工作的名单中 |
| `executorLogin` | 默认 `wuyj-agent`，须与当前执行账号一致 |
| `sourceDirectory` | 目标仓库本地路径；origin 须匹配，须已含 GitHub 默认分支最新 commit。插件不自动 fetch、不读取未提交代码 |
| `skillsDirectory` | 完整 superpowers `skills` 目录，保留所有技能、引用文件和执行脚本。已验证本机 7.0.1 资源布局 |
| `pollSeconds` | 每轮结束后的等待秒数，默认 300，范围 60–3600 |
| `readyLabels` | 默认 `[ready-for-agent]` |
| `blockedLabels` | 默认 `[blocked, on-hold]` |
| `planTimeoutSeconds` | 规划总超时，默认 1200 |
| `maxContextChars` | 默认 180000；超预算不交接 |
| `maxAttempts` | 默认 3；单张 issue 的规划尝试总预算，跨需求编辑和进程重启累计，达到上限转人工 |
| `reconcileSeconds` | 默认 300；评论回执不确定的单张 issue 的对账间隔 |
| `handoffTimeoutMinutes` | 默认 30；评论确认后多久仍未观察到工单时标记异常 |
| `executionStallHours` | 默认 24；权威工单进展多久未更新时标记疑似停滞，不自动重派 |
| `provider` / `model` | 同时设置或同时留空；留空使用当前默认模型 |
| `superagentOrigin` | 默认 `http://127.0.0.1:3200`，仅允许本机 HTTP origin |
| `stateDir` | 留空。状态统一位于 `~/.dsh/state/issue-planner/<repository-hash>/`，禁止为同仓库另配目录绕过锁 |

账号/来源不匹配、未授权、技能/资源缺失、仓库不可读等都会进入 `not_ready`，并记录具体原因。暂停 Superagent 后，规划中的运行在下一次许可检查时取消（每 15 秒一次，网络检查另有 15 秒超时）；发布每条评论前再次检查。停用插件立即发出取消信号并等待本插件任务结束。

## 筛选规则

- 使用 GitHub 原生父子、blocked-by 关系及正文 `Parent` / `Blocked by` / `Depends on`，所有对应章节均参与判定。
- 从最顶层根 issue 沿祖先链读取到目标；native 与正文父级冲突、循环、不明确的依赖或不可见引用均阻止自动执行。
- `T1/T2` 别名仅在同一根需求下唯一解析。依赖须为 closed/completed，not_planned 不作为交付完成。
- ready 标签不覆盖正文、评论中的未批准约束或 blocked 标签。第一版采取保守规则：若历史文字仍表示待批准，先更新或澄清需求后再处理。
- 开放子任务的 tracker 不直接派发；在全部就绪、无阻塞且不处于冷却/隔离中的叶子任务里，严格按 **issue 编号从小到大** 选择。创建时间不参与排序。编号更小但尚未满足依赖的 issue 会跳过，之后满足条件时重新参与排序。
- 已有开放工单或关联实施 PR 的 issue 被排除。GitHub 图和工单列表均须完整分页；超上限/部分错误不使用截断数据。
- 发布前重新扫描和计算上下文指纹，需求、根/依赖或讨论变化时废弃未交接计划。GitHub 的读取与评论不是原子事务，无法消除最后一次读取与 POST 之间的远端变化；执行 worker 必须在实施前再读当前需求。

## 技能与规划能力

将原 superpowers 目录中的技能注册为 DSH 合法名称，例如 `superpowers-writing-plans`、`superpowers-executing-plans`；原 `/superpowers:...` 写法保留在交接说明中并标明 DSH 名称。技能资源基目录仍指向完整原目录。插件校验执行链中的必需技能和脚本，再为现有 workers 提供运行时别名。

规划创建独立 DSH Session，使用固定 commit 的 Git 对象读取器。仅开放技能加载、资源读取、源码文件发现/读取/字面检索和计划提交；没有 shell、通用写入或 GitHub 发布工具。通过 `planner_submit` 输出的计划保存在本机持久记录中。完成要求同时存在真实 writing-plans 加载、源码读取、结构校验和成功结束的规划回合。

计划评论以外层 Markdown 代码围栏保留全部原文，包括 npm scopes、装饰器等 `@` 字符；围栏中的账号文本不产生额外 mention。长计划分段发送，最后一条 manifest 评论链接全部分段并且只有它在正文发出执行 mention。执行 worker 读取评论里的完整计划，不依赖规划机上的本地路径。

## 锁、去重和恢复

统一按仓库小写标识派生本机锁目录，10 秒心跳、30 秒 stale；同主机同用户的不同 profile 共用该锁根。仅规划串行，工单实施使用已有并发设置。文件锁不覆盖多主机部署。

记录先落盘再发出副作用。每一条评论有独立稳定隐藏标记，记录成功 receipt 后才能清除该条 outbound intent。回放较早分段不会清除较晚评论的不确定 intent。重启先对账；POST 超时、失败回执不明确或 intent 尚未确认时，转 `publish_uncertain`，只查评论，不自动重发。已交接的 issue 不因普通编辑再次 @。

`publish_uncertain` 仅隔离当前 issue，其余独立就绪任务继续处理。每轮最多对账 5 张到期记录，优先对账最久未查询的记录；单张默认每 5 分钟一次，仍保留原 outbound intent，不自动重发、不重复 @。对账恢复出有效评论则回填 receipt。确认是否存在对应评论后由维护者处理长期未决记录；第一版不提供强制重发按钮。人工处理应先停用插件、备份记录，确认远端效果，再修正该条状态。不要清空状态目录或更换用户/主机后直接重启，否则会丢失去重历史。

## 某张 issue 一直卡住

| 场景 | 自动处理 | 对后续任务的影响 |
| --- | --- | --- |
| 规划调用卡住 | 受 `planTimeoutSeconds` 限制，默认最多 20 分钟；失败后先冷却，默认第 1 次后 2 分钟、第 2 次后 4 分钟再尝试 | 冷却期间跳过它，处理下一张最小编号的就绪 issue |
| 规划反复失败/需求反复变化 | 每张默认累计最多 3 次规划，需求编辑或崩溃重启不重置预算；耗尽后标记 `needs_attention` | 隔离当前 issue，不拖住其余任务 |
| 评论请求结果不确定 | 保留去重记录，标记 `publish_uncertain`，按上文定期对账 | 不重发该条评论，其余任务继续 |
| 评论确认但未形成工单 | 等待正常接收；超过默认 30 分钟标记 `handoff_unacknowledged` | 不重复 @，其余任务继续；维护者检查来源、权限与工单接收 |
| Worker 明确报告受阻/失败 | 标记 `execution_blocked` / `execution_failed` | 保留原工单，不自动启动第二个执行者 |
| 工单长期无进展 | 依据工单 `updatedAt`，默认 24 小时标记 `execution_stalled`；插件的观察时间不算进展 | 仅提示疑似停滞，不自动停止 worker 或重派 |
| 工单等待人回答/审核 | 标记 `awaiting_answer` / `awaiting_review`；达到停滞阈值后提示 | 等待相关人员处理，其他独立任务继续 |

这些告警体现在只读状态接口中，不额外向 issue 刷提醒评论。一个前置 issue 卡住时，依赖它的任务仍须等待，插件不会绕过依赖。仓库锁失效、全局暂停、身份变更或完整来源不可读仍会暂停整个插件；单张任务隔离不绕过这些全局门禁。

工单离开 open 清单时只标记 `ticket_not_open`，不据此猜测已完成，也不自动重派。维护者应补充需求、修复环境、拆分过大任务或处理原工单，再明确恢复；恢复规划预算与不确定评论需保留其原有远端去重证据。

## 运行状态

```sh
curl -fsS -H 'x-issue-planner-request: 1' \
  'http://127.0.0.1:3200/issue-planner/api/status?offset=0&limit=50'
```

仅本机/同源 GET，必须带专用请求头。返回 enabled、账号、阶段、下一轮时间、候选编号、跳过原因和分页记录。`handed_off` 只表示评论已确认；`ticketId` 在后续轮询观察到实际工单后填入，不能把评论成功当成已经执行。

## 开发验证

```sh
node --test plugins/issue-planner/tests/*.node.js
```

测试不发表评论、不创建真实工单。验证范围及现场部署结果见 [VERIFICATION.md](./VERIFICATION.md)。图标为本项目原创 SVG，按 MIT 许可分发。
