import { execFile } from 'node:child_process'
import { executionState } from './execution-window.js'

export class Github {
  constructor(config, signal) { this.config = config; this.signal = signal }
  async gh(args, input, signal = this.signal) {
    // argv never passes through a shell; gh retains the deployment's dedicated identity.
    return await new Promise((resolve, reject) => {
      const child = execFile(this.config.cli, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
        signal, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (error, stdout, stderr) => {
        if (error) reject(new Error(`gh exit ${error.code ?? 'unknown'}: ${stderr.slice(-1500) || error.message}`, { cause: error }))
        else resolve(stdout)
      })
      // Authentication/abort may close the pipe before a large review body is written.
      // This is a separate stream error, not a ChildProcess error.
      child.stdin.on('error', error => { reject(new Error(`gh stdin: ${error.message}`, { cause: error })); child.kill() })
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
    })
  }
  async api(path, input, method, signal = this.signal) {
    const args = ['api', '--hostname', 'github.com', path, '-H', 'Accept: application/vnd.github+json']
    if (input !== undefined) args.push('--method', method ?? 'POST', '--input', '-')
    return JSON.parse(await this.gh(args, input, signal))
  }
  repo(path) { return `repos/${this.config.repository}${path ? '/' + path : ''}` }
  async pages(path, select = value => value) {
    const items = []; let expected
    for (let page = 1; page <= 100; page++) {
      const response = await this.api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      if (page === 1 && Number.isInteger(response.total_count)) expected = response.total_count
      const data = select(response)
      if (!Array.isArray(data)) throw new Error('GitHub 分页响应异常')
      items.push(...data)
      if (data.length < 100) {
        if (expected !== undefined && items.length !== expected) throw new Error('GitHub 列表被截断或读取期间发生变化')
        return items
      }
    }
    throw new Error('GitHub 分页超过上限；不使用截断结果')
  }
  pulls() { return this.pages(this.repo('pulls?state=open')) }
  pull(number, signal) { return this.api(this.repo(`pulls/${number}`), undefined, undefined, signal) }
  files(number) { return this.pages(this.repo(`pulls/${number}/files`)) }
  reviews(number) { return this.pages(this.repo(`pulls/${number}/reviews`)) }
  async discussions(number) {
    const [owner, name] = this.config.repository.split('/')
    const threads = []; let cursor = null; let decision
    for (let page = 0; page < 100; page++) {
      const result = await this.api('graphql', { query: `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision reviewThreads(first:100,after:$cursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}`,
        variables: { owner, name, number, cursor } })
      if (result.errors) throw new Error(`GitHub GraphQL: ${JSON.stringify(result.errors).slice(0, 1000)}`)
      const pr = result.data?.repository?.pullRequest
      if (!pr) throw new Error('无法读取审核讨论')
      decision = pr.reviewDecision
      threads.push(...pr.reviewThreads.nodes)
      if (!pr.reviewThreads.pageInfo.hasNextPage) return { threads, reviewDecision: decision }
      cursor = pr.reviewThreads.pageInfo.endCursor
    }
    throw new Error('审核讨论分页超过上限')
  }
  async checks(sha) {
    // Ref-level check-runs hides suites beyond the latest 1000. Enumerate suites first,
    // and inspect suite state too: rerunning CI may leave the previous run marked success.
    const suites = await this.pages(this.repo(`commits/${sha}/check-suites`), value => value.check_suites)
    const checks = []
    for (const suite of suites) {
      if (suite.head_sha !== sha) throw new Error('CI suite 不属于当前 commit')
      const runs = await this.pages(this.repo(`check-suites/${suite.id}/check-runs?filter=latest`), value => value.check_runs)
      if (runs.length !== suite.latest_check_runs_count) throw new Error('CI suite 的检查数量不完整或读取期间发生变化')
      checks.push(...runs)
    }
    const raw = await this.pages(this.repo(`commits/${sha}/statuses`))
    const latest = new Map()
    for (const status of raw) if (!latest.has(status.context)) latest.set(status.context, status)
    return { checks, suites, statuses: [...latest.values()] }
  }
  async baseIncluded(pr) {
    const comparison = await this.api(this.repo(`compare/${pr.base.sha}...${pr.head.sha}`))
    return comparison.merge_base_commit?.sha === pr.base.sha
  }
  async content(path, sha, signal) {
    const result = await this.api(this.repo(`contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`), undefined, undefined, signal)
    if (result.type !== 'file' || result.encoding !== 'base64' || !result.content && result.size) throw new Error(`无法完整读取文件 ${path}`)
    const bytes = Buffer.from(result.content ?? '', 'base64')
    if (bytes.length !== result.size || bytes.includes(0)) throw new Error(`文件 ${path} 不完整或为二进制`)
    return bytes.toString('utf8')
  }
  async snapshot(pr) {
    const files = await this.files(pr.number)
    if (files.length !== pr.changed_files || files.length > 40) throw new Error('文件数量不完整或超过 40 个，需人工审核')
    const source = []; let chars = 0
    for (const file of files) {
      if (!file.patch && file.changes) throw new Error(`GitHub 未提供完整文本差异：${file.filename}`)
      const old = file.status === 'added' ? '' : await this.content(file.previous_filename ?? file.filename, pr.base.sha)
      const current = file.status === 'removed' ? '' : await this.content(file.filename, pr.head.sha)
      chars += old.length + current.length + (file.patch?.length ?? 0)
      if (chars > this.config.maxContextChars) throw new Error('审核上下文超过上限，需人工审核')
      source.push({ path: file.filename, previous_path: file.previous_filename, status: file.status, patch: file.patch, before: old, after: current })
    }
    // Trusted-revision repository guidance; content remains untrusted as instructions.
    const guidance = []
    const names = new Set(['AGENTS.md', 'README.md', 'package.json'])
    for (const file of files) {
      const parts = file.filename.split('/').slice(0, -1)
      for (let i = 1; i <= parts.length; i++) names.add(parts.slice(0, i).join('/') + '/AGENTS.md')
    }
    for (const path of names) {
      try {
        const text = await this.content(path, pr.base.sha)
        chars += text.length
        if (chars > this.config.maxContextChars) throw new Error('审核上下文超过上限，需人工审核')
        guidance.push({ path, text })
      } catch (error) { if (!/HTTP 404/.test(String(error))) throw error }
    }
    const fresh = await this.pull(pr.number)
    if (fresh.head.sha !== pr.head.sha || fresh.base.sha !== pr.base.sha) throw new Error('读取期间 head/base 已改变，下轮重新审核')
    return { files, context: { number: pr.number, title: pr.title, body: pr.body, head: pr.head.sha, base: pr.base.sha, guidance, files: source } }
  }
  async publish(pr, record, login) {
    const marker = `<!-- dsh-pr-automation:${record.key}:${record.policy} -->`
    const existing = (await this.reviews(pr.number)).find(review => review.user.login.toLowerCase() === login.toLowerCase() && review.body.includes(marker))
    if (existing) return existing.id
    const verdict = record.verdict
    const findings = verdict.findings.map(item => `- **${item.severity}** \`${item.path}:${item.line}\` — ${item.message}`).join('\n')
    const body = `This is by an automated agent, not a human.\n\n自动审核：**${verdict.decision}**\n\n${verdict.summary}\n\n${findings}\n\n审核 head: \`${pr.head.sha}\`\n审核 base: \`${pr.base.sha}\`\n${verdict.requiresHumanReview ? '需要人工确认。\n' : ''}自动审核通过后仍须满足 CI、讨论与仓库保护规则。此审核不代替仓库要求的人工批准。\n\n${marker}`
    // Review deduplication above may take long enough to cross the daily window.
    if (!executionState(this.config).allowed) throw new Error('PR 自动审核已关闭或当前不在允许执行的时间段')
    // COMMENT works on agent-authored PRs too, without impersonating an independent GitHub approval.
    const result = await this.api(this.repo(`pulls/${pr.number}/reviews`), { commit_id: pr.head.sha, event: 'COMMENT', body })
    return result.id
  }
  merge(pr) {
    if (!executionState(this.config).allowed) throw new Error('PR 自动审核已关闭或当前不在允许执行的时间段')
    return this.api(this.repo(`pulls/${pr.number}/merge`), { sha: pr.head.sha, merge_method: this.config.mergeMethod }, 'PUT')
  }
}
