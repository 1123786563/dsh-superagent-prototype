import { randomBytes } from 'node:crypto'
import { mkdir, writeFile, lstat, unlink, rm, realpath, chmod } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parse, stringify } from 'yaml'
import { eligible, revisionKey } from './policy.js'
import { buildActPlan } from './act-plan.js'
import { executionState } from './execution-window.js'
import { validateLocalActions } from './act-actions.js'
import { actObserver, command, isolatedEnvironment, runActProcess, cleanupActResources } from './act-process.js'

import { localCiKey, taskIdentity } from './ci-policy.js'
export { localCiKey, localCiBlockers, taskIdentity } from './ci-policy.js'
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

export class LocalCi {
  constructor({ config, github, store, signal, available, onProgress = () => {}, runProcess = runActProcess, cleanupResources = cleanupActResources }) {
    Object.assign(this, { config, github, store, signal, available, onProgress, runProcess, cleanupResources })
    this.options = config.localCi; this.configKey = localCiKey(this.options)
    this.store.data.ciRecords ??= {}
  }
  async initialize() {
    const options = this.options
    if (!options.sourceDirectory?.startsWith('/')) throw new Error('sourceDirectory 必须是仓库绝对路径')
    if (!options.jobs?.length) throw new Error('本地 CI 必须配置至少一个必要 job')
    if (new Set(options.jobs.map(item => item.workflow + ':' + item.job)).size !== options.jobs.length) throw new Error('本地 CI job 重复')
    for (const item of options.jobs) {
      if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(item.workflow) || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(item.job)) throw new Error('本地 CI 工作流或 job 标识无效')
    }
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 })
    const stateRoot = await realpath(this.config.stateDir)
    this.root = resolve(stateRoot, 'ci')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    this.root = await realpath(this.root)
    if (resolve(this.root, '..') !== stateRoot) throw new Error('CI 状态目录不能通过符号链接离开 stateDir')
    await chmod(this.root, 0o700)
    this.actVersion = await command(options.actCli, ['--version'])
    if (this.actVersion !== 'act version 0.2.97-dsh2') throw new Error('需要使用本包 build-isolated-act.sh 构建的独立 toolcache 版 act 0.2.97-dsh2')
    this.dockerHost = options.dockerHost || await command(options.dockerCli, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
    if (!/^unix:\/\/\//.test(this.dockerHost)) throw new Error('首版本地 CI 只支持本机 Unix Docker socket')
    const images = JSON.parse(await command(options.dockerCli, ['image', 'inspect', options.runnerImage]))
    this.runnerImage = images[0]?.Id
    if (!/^sha256:[a-f0-9]{64}$/.test(this.runnerImage ?? '') || this.runnerImage !== options.runnerImage) throw new Error('runnerImage 必须填写已存在镜像的不可变 sha256 ID')
    const origin = await command(options.gitCli, ['-C', options.sourceDirectory, 'remote', 'get-url', 'origin'])
    const normalized = origin.replace(/^git@github.com:/, 'https://github.com/').replace(/\.git$/, '').replace(/\/$/, '').toLowerCase()
    if (normalized !== `https://github.com/${this.config.repository}`.toLowerCase()) throw new Error('本地检出的 origin 与监听仓库不一致')
  }
  checked(path) {
    const target = resolve(path)
    if (!target.startsWith(this.root + '/') || target === this.root) throw new Error('拒绝访问 CI 状态目录之外的路径')
    return target
  }
  async stillCurrent(pr, signal = this.signal) {
    if (signal.aborted || !executionState(this.config).allowed || !await this.available(signal)) return false
    const fresh = await this.github.pull(pr.number, signal)
    return executionState(this.config).allowed && eligible(fresh, this.config) && revisionKey(fresh) === revisionKey(pr)
  }
  async prepareCheckout(pr, workspace, signal) {
    const options = this.options
    if (signal.aborted) throw signal.reason ?? new Error('CI 已取消')
    if (!/^[a-f0-9]{40}$/.test(pr.head.sha) || !/^[a-f0-9]{40}$/.test(pr.base.sha)) throw new Error('CI 只接受完整 Git SHA')
    await mkdir(this.checked(workspace), { recursive: true, mode: 0o700 })
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    const git = args => {
      if (signal.aborted) throw signal.reason ?? new Error('CI 已取消')
      return command(options.gitCli, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-C', workspace, ...args], { env, signal })
    }
    await git(['init', '-q'])
    // Fetch objects, never copy the user's dirty checkout, hooks, environment files or git config.
    try { await git(['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--depth=1', resolve(options.sourceDirectory), pr.head.sha]) }
    catch {
      if (signal.aborted) throw signal.reason ?? new Error('检出已取消')
      await git(['-c', `credential.helper=!${quote(this.config.cli)} auth git-credential`, 'fetch', '--no-tags', '--depth=1', `https://github.com/${this.config.repository}.git`, pr.head.sha])
    }
    await git(['checkout', '--detach', '-q', pr.head.sha])
    // act's file archive omits empty directories. Keep refs nonempty so the
    // copied .git remains a valid repository for submodule/Git workflow steps.
    await git(['update-ref', 'refs/heads/dsh-ci-head', pr.head.sha])
    if (await git(['rev-parse', 'HEAD']) !== pr.head.sha) throw new Error('CI 检出版本不匹配')
    await git(['remote', 'add', 'origin', `https://github.com/${this.config.repository}.git`])
    // Even act's restricted project config must not select a different image, workflow, job or dry-run mode.
    if (signal.aborted) throw signal.reason ?? new Error('CI 已取消')
    const actrc = this.checked(join(workspace, '.actrc'))
    try { await lstat(actrc); await unlink(actrc) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  event(pr) {
    const [owner, name] = this.config.repository.split('/')
    const repository = { full_name: this.config.repository, name, owner: { login: owner }, private: true,
      default_branch: this.config.baseBranch, clone_url: `https://github.com/${this.config.repository}.git`, html_url: `https://github.com/${this.config.repository}` }
    return { action: 'synchronize', number: pr.number, repository, sender: { login: this.config.login },
      pull_request: { number: pr.number, state: 'open', title: pr.title ?? '', draft: false, labels: pr.labels,
        additions: pr.additions, deletions: pr.deletions, changed_files: pr.changed_files,
        head: { sha: pr.head.sha, ref: pr.head.ref, repo: repository },
        base: { sha: pr.base.sha, ref: pr.base.ref, repo: repository } } }
  }
  async publish(pr, state, description) {
    if (!this.options.publishStatus || !await this.stillCurrent(pr)) return
    await this.github.api(this.github.repo(`statuses/${pr.head.sha}`), { state, context: 'dsh/act', description: description.slice(0, 140) })
  }
  async ensure(pr) {
    const key = revisionKey(pr), cacheKey = `${key}:${this.configKey}`, existing = this.store.data.ciRecords[cacheKey]
    if (existing && ['success', 'failure'].includes(existing.status)) return existing
    if (existing && ['error', 'cancelled'].includes(existing.status)
        && existing.retryAt && Date.parse(existing.retryAt) > Date.now()) return existing
    if (this.busy) throw new Error('本地 CI 执行器正忙；不会启动重叠任务')
    this.busy = true
    const nonce = randomBytes(12).toString('hex'), directory = this.checked(join(this.root, `pr-${pr.number}-${nonce}`))
    const attempt = (existing?.attempt ?? 0) + 1
    const record = { key, configKey: this.configKey, head: pr.head.sha, base: pr.base.sha, status: 'running', attempt,
      startedAt: new Date().toISOString(), runnerImage: this.runnerImage, actVersion: this.actVersion,
      requiredJobs: this.options.jobs.map(({ workflow, job }) => ({ workflow, job })), expectedTasks: [], tasks: [], directory }
    this.store.data.ciRecords[cacheKey] = record
    const abort = new AbortController(), signal = AbortSignal.any([this.signal, abort.signal])
    let monitoring = false, monitoringPromise = Promise.resolve(), timedOut = false
    const timer = setTimeout(() => { timedOut = true; abort.abort(new Error('本地 CI 整轮超时')) }, this.options.timeoutSeconds * 1000)
    timer.unref?.()
    const monitor = setInterval(() => {
      if (monitoring || signal.aborted) return
      monitoring = true
      monitoringPromise = this.stillCurrent(pr, signal).then(current => {
        if (!current) abort.abort(new Error('PR 版本、标签或暂停状态已变化'))
        return current
      }).catch(error => {
        record.monitorErrors ??= []
        record.monitorErrors.push(String(error))
        return undefined
      }).finally(() => { monitoring = false })
    }, 30000)
    monitor.unref?.()
    try {
      await mkdir(directory, { recursive: false, mode: 0o700 }); await this.store.save()
      if (!await this.stillCurrent(pr, signal)) { abort.abort(); throw new Error('PR 已退出当前 CI 范围') }
      await this.publish(pr, 'pending', 'DSH act：正在本地验证指定 jobs / 矩阵')
      const workspace = join(directory, 'workspace'), home = join(directory, 'home'), empty = join(directory, 'empty')
      await mkdir(home, { mode: 0o700 }); await writeFile(empty, '', { mode: 0o600 })
      await this.prepareCheckout(pr, workspace, signal)
      const eventPath = join(directory, 'event.json')
      await writeFile(eventPath, JSON.stringify(this.event(pr)), { mode: 0o600 })
      const env = isolatedEnvironment(home, this.dockerHost)
      const workflowCache = new Map(), tasks = []
      for (const job of this.options.jobs) {
        if (signal.aborted) throw signal.reason ?? new Error('CI 已取消')
        if (!workflowCache.has(job.workflow)) workflowCache.set(job.workflow, await this.github.content(job.workflow, pr.base.sha, signal))
        const workflowText = workflowCache.get(job.workflow)
        const plan = buildActPlan({ workflowText, workflowPath: job.workflow, jobId: job.job, serviceProxies: job.services ?? [] })
        for (const matrix of plan.matrices) tasks.push({ job, matrix, workflowText, identity: taskIdentity(job.workflow, job.job, matrix) })
      }
      record.expectedTasks = tasks.map(task => task.identity); await this.store.save()
      for (const [index, task] of tasks.entries()) {
        if (signal.aborted || !await this.stillCurrent(pr, signal)) { abort.abort(); break }
        const taskNonce = randomBytes(12).toString('hex')
        const plan = buildActPlan({ workflowText: task.workflowText, workflowPath: task.job.workflow, jobId: task.job.job,
          serviceProxies: task.job.services ?? [], matrix: task.matrix, witnessToken: taskNonce })
        const workflow = parse(plan.workflowText)
        await validateLocalActions(workflow, workspace)
        workflow.name = `dsh-ci-${taskNonce}`
        const serviceImages = []
        for (const [name, service] of Object.entries(workflow.jobs[task.job.job].services ?? {})) {
          if (signal.aborted) throw signal.reason ?? new Error('CI 已取消')
          await command(this.options.dockerCli, ['pull', '--platform', this.options.architecture, service.image], { env, signal, timeout: 300000 })
          const image = JSON.parse(await command(this.options.dockerCli, ['image', 'inspect', service.image], { env, signal }))[0]
          if (!/^sha256:[a-f0-9]{64}$/.test(image?.Id ?? '')) throw new Error('无法固定服务镜像版本')
          serviceImages.push({ name, source: service.image, image: image.Id })
          service.image = image.Id
          service.options = `${service.options ?? ''} --label dsh.pr-ci=${taskNonce}`.trim()
        }
        const workflowPath = join(directory, `workflow-${index}.yml`), logPath = join(directory, `job-${index}.jsonl`)
        const taskCache = this.checked(join(directory, `action-cache-${taskNonce}`))
        await mkdir(taskCache, { recursive: false, mode: 0o700 })
        await writeFile(workflowPath, stringify(workflow), { mode: 0o600 })
        const args = ['pull_request', '--directory', workspace, '--workflows', workflowPath, '--job', task.job.job,
          '--remote-name', 'origin',
          '--json', '--strict', '--no-recurse', '--platform', `ubuntu-latest=${this.runnerImage}`,
          '--platform', `ubuntu-22.04=${this.runnerImage}`, '--platform', `ubuntu-24.04=${this.runnerImage}`,
          '--container-architecture', this.options.architecture, '--pull=false', '--rebuild=false',
          '--container-daemon-socket', '-', '--container-options-policy', 'restrict', '--network', 'bridge',
          '--container-options', `--label dsh.pr-ci=${taskNonce} --memory=${this.options.memoryGb}g --cpus=${this.options.cpus}`,
          '--env-file', empty, '--secret-file', empty, '--input-file', empty, '--var-file', empty,
          '--eventpath', eventPath, '--actor', this.config.login, '--defaultbranch', this.config.baseBranch,
          '--action-cache-path', taskCache, '--no-cache-server', '--rm', '--concurrent-jobs', '1']
        for (const [axis, value] of Object.entries(task.matrix)) args.push('--matrix', `${axis}:${value}`)
        const actEnv = { ...env, DSH_ACT_TOOLCACHE_VOLUME: `dsh-ci-toolcache-${taskNonce}` }
        const item = { identity: task.identity, workflow: task.job.workflow, job: task.job.job, matrix: task.matrix,
          workflowDigest: plan.workflowDigest, serviceImages, logPath, command: [this.options.actCli, ...args], startedAt: new Date().toISOString(), passed: false }
        record.tasks.push(item); this.onProgress({ ...record, activeTask: item.identity }); await this.store.save()
        try {
          Object.assign(item, await this.runProcess({ executable: this.options.actCli, args, cwd: directory, env: actEnv, logPath,
            signal, observer: actObserver(task.job.job, task.matrix, plan.witnessStepId, plan.expectedStepIds) }))
        } catch (error) { item.error = String(error); item.passed = false }
        finally {
          try { item.cleanup = await this.cleanupResources({ docker: this.options.dockerCli, env, nonce: taskNonce }) }
          catch (error) { item.cleanup = { success: false, error: String(error) }; item.passed = false }
          try { await rm(taskCache, { recursive: true, force: true }); item.actionCacheRemoved = true }
          catch (error) { item.actionCacheRemoved = false; item.cleanup.success = false; item.cleanup.error = String(error); item.passed = false }
          item.completedAt = new Date().toISOString(); await this.store.save()
        }
      }
      record.status = timedOut ? 'error' : signal.aborted ? 'cancelled' : record.tasks.length === record.expectedTasks.length && record.tasks.every(task => task.passed && task.cleanup?.success) ? 'success' : 'failure'
      record.summary = record.status === 'success' ? `${record.tasks.length} 个必要 job / 矩阵全部成功` : '本地 CI 未通过；查看逐项结果及日志'
    } catch (error) { record.status = timedOut ? 'error' : signal.aborted ? 'cancelled' : 'error'; record.error = String(error) }
    finally {
      clearTimeout(timer); clearInterval(monitor); await monitoringPromise
      record.completedAt = new Date().toISOString()
      if (signal.aborted) record.cancelReason = String(signal.reason ?? 'CI 已取消')
      try {
        const workspace = this.checked(join(directory, 'workspace'))
        await rm(workspace, { recursive: true, force: true })
        record.workspaceRemoved = true
      } catch (error) { record.workspaceRemoved = false; record.status = 'error'; record.error = String(error) }
      if (['error', 'cancelled'].includes(record.status)) {
        const delaySeconds = Math.min(900, 30 * 2 ** Math.min(record.attempt - 1, 5))
        record.retryAt = new Date(Date.now() + delaySeconds * 1000).toISOString()
      }
      this.busy = false
      await this.store.save()
    }
    try { await this.publish(pr, record.status === 'success' ? 'success' : record.status === 'failure' ? 'failure' : 'error', `DSH act：${record.summary ?? record.status}`) }
    catch (error) { record.statusPublishError = String(error); await this.store.save() }
    this.onProgress(record)
    return record
  }
}
