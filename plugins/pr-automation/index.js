import s from '@deepseek-ai/schemastery'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import lockfile from 'proper-lockfile'
import { resolve, join } from 'node:path'
import { Github } from './github.js'
import { Automation, policyKey } from './engine.js'
import { reviewWithLlm } from './reviewer.js'
import { LocalCi } from './local-ci.js'

export const name = 'dsh-pr-automation'
export const inject = ['llm', 'agentDefaultModel', 'webServer']
export const Config = s.object({
  repository: s.string().pattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).required().description('监听仓库，owner/repo。'),
  cli: s.string().default('gh-agent').description('专用机器人 GitHub CLI。'),
  baseBranch: s.string().default('main').description('允许自动合并的目标分支。'),
  label: s.string().default('auto-review').description('加入审核与合并流程的标签。'),
  autoMerge: s.boolean().default(false).description('审核和全部门禁通过后自动合并。'),
  mergeMethod: s.union(['merge', 'squash', 'rebase']).default('merge').description('GitHub 合并方式。'),
  pollSeconds: s.number().min(60).max(3600).step(1).default(60).description('轮询间隔，秒。'),
  maxChangedLines: s.number().min(1).max(5000).step(1).default(500).description('自动处理的行数上限（不含该值）。'),
  maxContextChars: s.number().min(10000).max(500000).step(1).default(180000).description('审核上下文字符上限；超出转人工。'),
  stateDir: s.string().pattern(/^\//).required().description('审核记录与锁的绝对目录。'),
  superagentOrigin: s.string().default('http://127.0.0.1:3200').description('现有 Superagent 地址；跟随其暂停和来源开关。'),
  provider: s.string().default('').description('审核模型 provider；留空使用当前默认模型。'),
  model: s.string().default('').description('审核模型名称，与 provider 配对；留空使用默认模型。'),
  reasoningEffort: s.string().default('').description('审核模型推理强度；留空使用模型默认值。'),
  ciMode: s.union(['github', 'local', 'both']).default('github').description('CI 来源：GitHub、本地 act，或两者同时通过；平台保护规则始终生效。'),
  localCi: s.object({
    sourceDirectory: s.string().default('').description('现有仓库的绝对路径；只读取 Git 对象，不复制或修改未提交文件。'),
    actCli: s.string().default('act').description('本包构建的 act 0.2.97-dsh1 隔离版；拒绝共享 toolcache 的普通发行版。'),
    dockerCli: s.string().default('docker'), gitCli: s.string().default('git'),
    dockerHost: s.string().default('').description('Unix Docker socket；留空读取当前 Docker context。'),
    runnerImage: s.string().default('').description('已安装 runner 镜像的不可变 sha256 ID。'),
    architecture: s.union(['linux/arm64', 'linux/amd64']).default('linux/arm64'),
    timeoutSeconds: s.number().min(60).max(7200).step(1).default(3600).description('一轮全部 jobs / 矩阵的总超时。'),
    cpus: s.number().min(1).max(16).step(1).default(4), memoryGb: s.number().min(2).max(32).step(1).default(8),
    publishStatus: s.boolean().default(true).description('回写独立的 dsh/act commit status；不会修改原 GitHub Actions 检查。'),
    jobs: s.array(s.object({
      workflow: s.string().required(), job: s.string().required(),
      services: s.array(s.object({ service: s.string().required(), hostPort: s.number().min(1).max(65535).step(1).required(),
        containerPort: s.number().min(1).max(65535).step(1).default(5432) })).default([]),
    })).default([]).description('必须实际成功的 workflow / job；静态矩阵逐项运行，跳过或缺项不放行。'),
  }).default({}),
})

export async function openStore(directory) {
  const root = resolve(directory)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const path = join(root, 'reviews.json'), pending = join(root, 'reviews.pending.json')
  const checked = candidate => {
    if (![path, pending].includes(resolve(candidate))) throw new Error('Unexpected state path')
    return candidate
  }
  let compromised, closed = false
  const release = await lockfile.lock(root, { retries: 0, stale: 30000, update: 10000,
    onCompromised: error => { compromised = error } })
  const assertHeld = () => { if (closed || compromised) throw compromised ?? new Error('审核状态锁已释放') }
  const close = async () => { if (closed) return; closed = true; if (!compromised) await release() }
  try {
    let data
    try { data = JSON.parse(await readFile(path, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    data ??= { version: 1, records: {} }
    if (data.version !== 1 || !data.records || typeof data.records !== 'object' || Array.isArray(data.records)) throw new Error('不支持的审核记录格式')
    return { data, assertHeld,
      async save() { assertHeld(); await writeFile(pending, JSON.stringify(data, null, 2), { mode: 0o600 }); assertHeld(); await rename(checked(pending), checked(path)) },
      close,
    }
  } catch (error) { await close(); throw error }
}

export async function apply(ctx, input) {
  if (!!input.provider !== !!input.model) throw new Error('provider 和 model 必须同时设置')
  const origin = new URL(input.superagentOrigin)
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.pathname !== '/') throw new Error('Superagent 地址须为本机 HTTP origin')
  const controller = new AbortController()
  ctx.effect(() => () => controller.abort())
  const signal = controller.signal
  const github = new Github(input, signal)
  const login = (await github.api('user')).login
  const model = input.provider ? { provider: input.provider, model: input.model,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}) } : ctx.agentDefaultModel.currentSelection()
  await ctx.llm.resolveModelInfo(model.provider, model.model, signal)
  const config = { ...input, model, login }; config.policyKey = policyKey(config)
  const store = await openStore(input.stateDir)
  let running = Promise.resolve(), timer, route
  ctx.effect(() => async () => {
    controller.abort(); clearTimeout(timer); route?.(); await running; await store.close()
  })
  const get = async (route, requestSignal = signal) => {
    const response = await fetch(`${origin.origin}/orchestrator/api/${route}`, { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.any([requestSignal, AbortSignal.timeout(15000)]) })
    if (!response.ok) throw new Error(`Superagent ${route}: HTTP ${response.status}`)
    return response.json()
  }
  const available = async (availabilitySignal = signal) => {
    store.assertHeld()
    const [state, settings] = await Promise.all([get('state', availabilitySignal), get('settings', availabilitySignal)])
    const source = settings.sources.find(item => item.id === 'github')
    return !state.paused && !state.setup.problem && source?.value.enabled
      && source.value.config.repository.toLowerCase() === input.repository.toLowerCase()
      && state.setup.accounts?.agent?.toLowerCase() === login.toLowerCase()
  }
  let automation
  const localCi = input.ciMode === 'local' || input.ciMode === 'both' ? new LocalCi({ config, github, store, available, signal,
    onProgress: record => { if (automation) automation.status.localCi = { key: record.key, status: record.status, activeTask: record.activeTask, completedTasks: record.tasks.length, expectedTasks: record.expectedTasks.length } },
  }) : undefined
  if (localCi) await localCi.initialize()
  automation = new Automation({ config, github, store, available, signal, localCi,
    review: context => reviewWithLlm(ctx.llm, model, context, AbortSignal.any([signal, AbortSignal.timeout(600000)])) })
  route = ctx.webServer.register({ kind: 'exact', path: '/pr-automation/api/status', handler: (req, res) => {
    const host = req.headers.host, port = new URL(ctx.webServer.getOrigin()).port
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)
      || req.headers['x-pr-automation-request'] !== '1'
      || req.headers.origin && req.headers.origin !== `http://${host}`) { res.writeHead(403); res.end(); return }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    const ciRuns = Object.values(store.data.ciRecords ?? {}).slice(-10).map(record => ({
      key: record.key, status: record.status, startedAt: record.startedAt, completedAt: record.completedAt,
      head: record.head, base: record.base, summary: record.summary, error: record.error, runnerImage: record.runnerImage,
      expectedTasks: record.expectedTasks, workspaceRemoved: record.workspaceRemoved,
      tasks: record.tasks.map(task => ({ identity: task.identity, workflow: task.workflow, job: task.job, matrix: task.matrix,
        passed: task.passed, exitCode: task.exitCode, reasons: task.reasons, error: task.error, logPath: task.logPath, cleanup: task.cleanup })),
    }))
    res.end(JSON.stringify({ repository: config.repository, label: config.label, autoMerge: config.autoMerge,
      ciMode: config.ciMode, ciJobs: config.localCi.jobs.map(({ workflow, job }) => ({ workflow, job })), ciRuns,
      model, policy: config.policyKey, ...automation.status }))
  } })
  const cycle = () => {
    running = automation.tick().catch(error => { ctx.logger.error('PR automation: %s', String(error)) })
      .finally(() => { if (!signal.aborted) { timer = setTimeout(cycle, config.pollSeconds * 1000); timer.unref?.() } })
  }
  cycle()
  ctx.logger.info('PR 自动审核已启动：%s，标签 %s，自动合并 %s', config.repository, config.label, config.autoMerge)
}
