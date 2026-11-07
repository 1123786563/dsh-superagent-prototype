import { createHash } from 'node:crypto'
export const LOCAL_CI_VERSION = 1
export const taskIdentity = (workflow, job, matrix) => `${workflow}:${job}:${JSON.stringify(Object.entries(matrix).sort())}`
export function localCiKey(config) {
  return createHash('sha256').update(JSON.stringify({ version: LOCAL_CI_VERSION, ...config })).digest('hex').slice(0, 24)
}
export function localCiBlockers(config, result, expectedKey) {
  const reasons = []
  if (!result || result.key !== expectedKey || result.configKey !== localCiKey(config)) reasons.push('当前 head/base 的本地 CI 尚未验证')
  if (result?.status !== 'success') reasons.push(`本地 CI 未通过：${result?.status ?? '未运行'}`)
  const expected = result?.expectedTasks
  const actual = result?.tasks
  const expectedSet = new Set(Array.isArray(expected) ? expected : [])
  const actualSet = new Set(Array.isArray(actual) ? actual.map(task => task?.identity) : [])
  if (!Array.isArray(expected) || !expected.length || expected.some(identity => typeof identity !== 'string')
      || expectedSet.size !== expected.length || !Array.isArray(actual) || actual.length !== expected.length
      || actual.some(task => !task || typeof task.identity !== 'string') || actualSet.size !== actual.length
      || actualSet.size !== expectedSet.size || [...expectedSet].some(identity => !actualSet.has(identity))
      || actual.some(task => !task.passed || task.cleanup?.success !== true)) {
    reasons.push('本地 CI 的必要 job / 矩阵覆盖或资源清理不完整')
  }
  if (result?.workspaceRemoved !== true) reasons.push('CI 临时工作区清理尚未验证')
  return reasons
}
