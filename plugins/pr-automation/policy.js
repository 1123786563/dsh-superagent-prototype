// Pure, fail-closed merge gates shared by the runtime and tests.
import { localCiBlockers } from './ci-policy.js'
export const VERSION = 2
export const riskyPath = path => /(^|\/)(\.github|\.gitmodules|\.env[^/]*|migrations?|terraform|helm|k8s|secrets?|credentials?)(\/|$)|(^|\/)(Dockerfile[^/]*|docker-compose[^/]*|[^/]*lock[^/]*|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$|(^|\/)(auth|security|permissions?)(\/|\.)/i.test(path)
export const visualPath = path => /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html|swift|storyboard)$/i.test(path)
export const revisionKey = pr => `${pr.number}:${pr.head.sha}:${pr.base.sha}`
export function eligible(pr, config) {
  return pr.state === 'open' && !pr.draft && pr.base.ref === config.baseBranch
    && pr.head.repo?.full_name?.toLowerCase() === config.repository.toLowerCase()
    && pr.labels.some(label => label.name === config.label)
}
export function latestReviews(reviews) {
  const latest = new Map()
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login.toLowerCase(), review)
  }
  return [...latest.values()]
}
export function mergeBlockers({ pr, config, record, checks = [], suites = [], statuses = [], reviews, threads, files, reviewDecision, baseIncluded = false, localResult }) {
  const reasons = []
  if (!eligible(pr, config)) reasons.push('PR 已退出启用范围（标签、草稿、分支或仓库发生变化）')
  if (!record || record.key !== revisionKey(pr) || record.policy !== config.policyKey) reasons.push('当前 head/base 版本尚未审核')
  const verdict = record?.verdict
  if (!verdict?.complete || verdict.decision !== 'pass' || verdict.findings.length) reasons.push('自动审核未通过或信息不完整')
  if (verdict?.requiresHumanReview) reasons.push('审核要求人工确认')
  if (!record?.reviewId) reasons.push('审核结果尚未成功发布')
  if (pr.additions + pr.deletions >= config.maxChangedLines) reasons.push(`改动达到 ${config.maxChangedLines} 行上限`)
  if (files.some(file => [file.filename, file.previous_filename].filter(Boolean).some(riskyPath))) reasons.push('涉及依赖、权限、部署或迁移等高风险文件，需人工合并')
  // Preserve the deployment's standing requirement for explicit human UI approval.
  if (files.some(file => [file.filename, file.previous_filename].filter(Boolean).some(visualPath))) reasons.push('涉及界面文件，需人工确认视觉结果并合并')
  const mode = config.ciMode ?? 'github'
  const states = mode === 'local' ? ['clean', 'unstable'] : ['clean']
  if (!['github', 'local', 'both'].includes(mode)) reasons.push('未知的 CI 模式')
  if (pr.mergeable !== true || !states.includes(pr.mergeable_state)) reasons.push(`GitHub 尚未确认可合并：${pr.mergeable_state ?? 'unknown'}`)
  if (!baseIncluded) reasons.push('PR 分支尚未包含当前 base，需要作者更新分支并重新验证')
  if (mode === 'local' || mode === 'both') reasons.push(...localCiBlockers(config.localCi, localResult, revisionKey(pr)))
  if (pr.auto_merge) reasons.push('已有其他流程开启 GitHub auto-merge，需先取消以避免并行合并')
  if (reviewDecision === 'REVIEW_REQUIRED' || reviewDecision === 'CHANGES_REQUESTED') reasons.push(`GitHub 审核门禁：${reviewDecision}`)
  if (latestReviews(reviews).some(review => review.state === 'CHANGES_REQUESTED')) reasons.push('仍有审核者要求修改')
  if (threads.some(thread => !thread.isResolved)) reasons.push('仍有未解决的审核讨论')
  if (mode === 'github' || mode === 'both') {
    const externalStatuses = statuses.filter(status => status.context !== 'dsh/act')
    if (!checks.length && !externalStatuses.length) reasons.push('当前 commit 没有 GitHub CI 结果')
    if (suites.some(suite => suite.status !== 'completed' || suite.conclusion !== 'success')) reasons.push('CI suite 尚未全部成功（包括正在重新运行的检查）')
    if (checks.some(check => check.status !== 'completed' || check.conclusion !== 'success')) reasons.push('CI checks 尚未全部成功（失败、运行中或跳过均不放行）')
    if (externalStatuses.some(status => status.state !== 'success')) reasons.push('CI status 尚未全部成功')
  }
  return reasons
}
export function parseVerdict(text) {
  const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, ''))
  if (!value || !['pass', 'changes_requested', 'manual'].includes(value.decision)
      || typeof value.complete !== 'boolean' || typeof value.requiresHumanReview !== 'boolean'
      || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 5000
      || !Array.isArray(value.findings) || value.findings.length > 30) throw new Error('审核结果不符合结构要求')
  for (const item of value.findings) {
    if (!item || !['critical', 'high', 'medium'].includes(item.severity) || typeof item.path !== 'string'
        || !Number.isInteger(item.line) || item.line < 1 || typeof item.message !== 'string'
        || !item.message.trim() || item.message.length > 3000) throw new Error('审核 finding 不符合结构要求')
  }
  if (value.decision === 'pass' && (!value.complete || value.requiresHumanReview || value.findings.length)) throw new Error('不一致的审核通过结果')
  return { decision: value.decision, complete: value.complete, requiresHumanReview: value.requiresHumanReview,
    summary: value.summary, findings: value.findings.map(({ severity, path, line, message }) => ({ severity, path, line, message })) }
}
