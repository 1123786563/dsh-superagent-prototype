import { createHash } from 'node:crypto'
import { eligible, mergeBlockers, revisionKey, VERSION } from './policy.js'
import { REVIEW_PROMPT } from './reviewer.js'

export function policyKey(config) {
  return createHash('sha256').update(JSON.stringify({ version: VERSION, prompt: REVIEW_PROMPT,
    repository: config.repository, baseBranch: config.baseBranch, label: config.label,
    maxChangedLines: config.maxChangedLines, mergeMethod: config.mergeMethod, model: config.model,
    ciMode: config.ciMode ?? 'github', localCi: config.localCi })).digest('hex').slice(0, 16)
}
export class Automation {
  constructor({ config, github, store, review, available, signal, localCi, now = () => new Date().toISOString() }) {
    Object.assign(this, { config, github, store, review, available, signal, localCi, now })
    this.status = { phase: 'starting', lastPoll: null, lastError: null, pulls: {} }
  }
  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      if (!await this.available()) { this.status.phase = 'paused'; return }
      const pulls = await this.github.pulls()
      this.status.phase = 'ready'; this.status.lastPoll = this.now(); this.status.lastError = null
      const current = new Set(pulls.map(pr => String(pr.number)))
      for (const number of Object.keys(this.status.pulls)) if (!current.has(number)) delete this.status.pulls[number]
      for (const pr of pulls) {
        if (this.signal.aborted) return
        if (!eligible(pr, this.config)) {
          if (this.status.pulls[pr.number]) this.status.pulls[pr.number] = { state: 'out_of_scope', head: pr.head.sha }
          continue
        }
        try {
          if (!await this.available()) { this.status.phase = 'paused'; return }
          // REST's list response omits diff counts and mergeability; always fetch a full, fresh detail.
          const detail = await this.github.pull(pr.number)
          if (eligible(detail, this.config)) await this.process(detail)
        }
        catch (error) {
          this.status.pulls[pr.number] = { state: 'error', head: pr.head.sha, error: String(error), at: this.now() }
          this.status.lastError = String(error)
        }
      }
    } catch (error) { this.status.phase = 'error'; this.status.lastError = String(error) }
    finally { this.busy = false }
  }
  async process(pr) {
    const key = revisionKey(pr), storeKey = `${key}:${this.config.policyKey}`
    let record = this.store.data.records[storeKey]
    this.status.pulls[pr.number] = { state: 'reviewing', head: pr.head.sha, base: pr.base.sha }
    if (!record) {
      // Large changes are visible as manual rather than silently consuming unbounded model context.
      if (pr.additions + pr.deletions >= this.config.maxChangedLines) {
        this.status.pulls[pr.number] = { state: 'manual', head: pr.head.sha, reasons: ['改动行数达到自动审核上限'] }; return
      }
      let snapshot
      try { snapshot = await this.github.snapshot(pr) }
      catch (error) {
        this.status.pulls[pr.number] = { state: 'manual', head: pr.head.sha, reasons: [String(error)] }; return
      }
      if (this.signal.aborted || !await this.available()) { this.status.pulls[pr.number] = { state: 'paused', head: pr.head.sha }; return }
      const result = await this.review(snapshot.context)
      record = { key, policy: this.config.policyKey, ...result, reviewedAt: this.now(), files: snapshot.files.map(file => ({ filename: file.filename, previous_filename: file.previous_filename })) }
      this.store.data.records[storeKey] = record
      await this.store.save()
    }
    // Re-check consent before publishing a review, including after a long model call.
    let fresh = await this.github.pull(pr.number)
    if (!eligible(fresh, this.config) || revisionKey(fresh) !== key || !await this.available()) {
      this.status.pulls[pr.number] = { state: 'superseded', head: pr.head.sha }; return
    }
    if (!record.reviewId) {
      record.reviewId = await this.github.publish(fresh, record, this.config.login)
      await this.store.save()
    }
    if (record.verdict.decision !== 'pass') {
      this.status.pulls[pr.number] = { state: record.verdict.decision, head: pr.head.sha, reviewId: record.reviewId, summary: record.verdict.summary }; return
    }
    let localResult
    if (this.config.ciMode === 'local' || this.config.ciMode === 'both') {
      this.status.pulls[pr.number] = { state: 'testing', head: pr.head.sha, reviewId: record.reviewId }
      localResult = this.localCi ? await this.localCi.ensure(pr) : undefined
    }
    const [ci, reviews, discussion, files, baseIncluded, available] = await Promise.all([
      this.config.ciMode === 'local' ? { checks: [], statuses: [], suites: [] } : this.github.checks(pr.head.sha), this.github.reviews(pr.number), this.github.discussions(pr.number), this.github.files(pr.number),
      this.github.baseIncluded(pr), this.available(),
    ])
    // Keep the final PR read adjacent to the merge request, after slower availability/CI reads.
    fresh = await this.github.pull(pr.number)
    const gate = { pr: fresh, config: this.config, record, ...ci, reviews, ...discussion, files, baseIncluded, localResult }
    const reasons = mergeBlockers(gate)
    if (files.length !== fresh.changed_files) reasons.push('文件列表不完整')
    if (!this.config.autoMerge) reasons.push('自动合并开关已关闭')
    if (!available) reasons.push('Superagent 已暂停、来源已停用或仓库配置已变化')
    if (this.signal.aborted) reasons.push('插件正在停止')
    if (reasons.length) {
      this.status.pulls[pr.number] = { state: 'waiting', head: fresh.head.sha, reviewId: record.reviewId, reasons }; return
    }
    // PUT with sha is a compare-and-swap on the reviewed head. GitHub also enforces branch protection.
    // No --admin, no bypass, no optimistic auto-merge queue carrying stale consent.
    const result = await this.github.merge(fresh)
    if (!result.merged) throw new Error(`GitHub 拒绝合并：${result.message ?? 'unknown'}`)
    record.mergedAt = this.now(); record.mergeCommit = result.sha
    await this.store.save()
    this.status.pulls[pr.number] = { state: 'merged', head: fresh.head.sha, mergeCommit: result.sha }
  }
}
