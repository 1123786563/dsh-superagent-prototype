import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
const execute = promisify(execFile)

export function isolatedEnvironment(home, dockerHost) {
  // Never forward Harness, GitHub, cloud, SSH-agent, npm, or database credentials.
  return { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home + '/.config',
    LANG: 'C.UTF-8', TERM: 'dumb', CI: 'true', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    ...(dockerHost ? { DOCKER_HOST: dockerHost } : {}) }
}

export async function command(file, args, options = {}) {
  const result = await execute(file, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60000, ...options })
  return result.stdout.trim()
}

export function actObserver(jobId, matrix, witnessStepId, expectedStepIds = []) {
  const jobs = [], steps = new Map(), errors = []
  let witness = false
  const identity = value => JSON.stringify(Object.entries(value ?? {}).sort())
  return {
    accept(line) {
      let event
      try { event = JSON.parse(line) } catch { return }
      // Workflow stdout is always wrapped in raw_output; it is never an act verdict.
      if (!event || typeof event !== 'object' || Array.isArray(event) || Object.hasOwn(event, 'raw_output') || !event.jobID) return
      if (event.jobID !== jobId || identity(event.matrix) !== identity(matrix)) { errors.push('act 执行了计划外的 job 或矩阵'); return }
      if (event.dryrun === true) errors.push('act 返回 dry-run 结果')
      if (Object.hasOwn(event, 'jobResult')) {
        if (!['success', 'failure', 'cancelled', 'skipped'].includes(event.jobResult) || jobs.length) errors.push('act job 结果无效或重复')
        else jobs.push(event.jobResult)
      }
      const ids = event.stepID ?? event.stepid
      // Act emits progress lines with stage/stepID too; only terminal results certify a step.
      // Nested composite-action step IDs are reported separately, while the parent step's
      // terminal result below captures their aggregate outcome.
      if (event.stage === 'Main' && Object.hasOwn(event, 'stepResult')) {
        if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')
            || !['success', 'failure', 'cancelled', 'skipped'].includes(event.stepResult)) {
          errors.push('act 步骤结果格式无效')
        } else if (ids.length === 1) {
          if (steps.has(ids[0])) errors.push('act 步骤结果重复')
          else {
            steps.set(ids[0], event.stepResult)
            if (ids[0] === witnessStepId && event.stepResult === 'success') witness = true
          }
        }
      }
    },
    result(exitCode) {
      if (exitCode !== 0) errors.push(`act 退出码 ${exitCode}`)
      if (jobs.length !== 1 || jobs[0] !== 'success') errors.push('必要 job 未完整执行成功（可能被跳过）')
      if (!witness) errors.push('缺少尾部执行见证；不把 exit 0 当作已执行')
      if (expectedStepIds.some(id => steps.get(id) !== 'success')) errors.push('必要步骤未全部实际成功')
      if ([...steps.values()].some(state => ['failure', 'cancelled', 'skipped'].includes(state))) errors.push('计划内步骤失败、取消或被跳过')
      return { passed: errors.length === 0, jobResults: jobs, steps: Object.fromEntries(steps), reasons: [...new Set(errors)] }
    },
  }
}

export async function runActProcess({ executable, args, cwd, env, logPath, signal, observer, maxLogBytes = 64 * 1024 * 1024 }) {
  if (signal?.aborted) return { exitCode: null, aborted: true, reasons: ['执行前已取消'] }
  const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 })
  let bytes = 0, ioError, killTimer
  const channels = [childChannel(), childChannel()]
  function childChannel() { return { decoder: new StringDecoder('utf8'), pending: '' } }
  const child = spawn(executable, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const stop = () => {
    if (!child.pid) return
    const kill = signal => {
      try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal) }
      catch (error) { if (error.code !== 'ESRCH') ioError ??= error }
    }
    kill('SIGTERM')
    killTimer ??= setTimeout(() => kill('SIGKILL'), 2000)
    killTimer.unref?.()
  }
  const consume = (channel, chunk) => {
    bytes += chunk.length
    if (bytes > maxLogBytes) { ioError ??= new Error('CI 日志超过大小上限'); stop(); return }
    log.write(chunk)
    channel.pending += channel.decoder.write(chunk)
    if (channel.pending.length > 2 * 1024 * 1024) { ioError ??= new Error('CI 日志单行超过上限'); stop(); return }
    const lines = channel.pending.split(/\r?\n/); channel.pending = lines.pop()
    for (const line of lines) observer.accept(line)
  }
  log.on('error', error => { ioError ??= error; stop() })
  child.stdout.on('data', chunk => consume(channels[0], chunk)); child.stderr.on('data', chunk => consume(channels[1], chunk))
  const result = await new Promise(resolve => {
    child.once('error', error => { ioError ??= error })
    child.once('close', (exitCode, exitSignal) => resolve({ exitCode, exitSignal }))
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
  })
  signal?.removeEventListener('abort', stop); clearTimeout(killTimer)
  for (const channel of channels) { const tail = channel.pending + channel.decoder.end(); if (tail) observer.accept(tail) }
  log.end()
  try { await finished(log) } catch (error) { ioError ??= error }
  const observation = observer.result(result.exitCode)
  return { ...result, ...observation, passed: observation.passed && !ioError && !signal?.aborted,
    bytes, aborted: !!signal?.aborted, reasons: [...observation.reasons, ...(ioError ? [String(ioError)] : []), ...(signal?.aborted ? ['任务已取消或超时'] : [])] }
}

export async function cleanupActResources({ docker, env, nonce }) {
  if (!/^[a-f0-9]{24}$/.test(nonce)) throw new Error('无效的 CI 资源归属标识')
  const removed = { containers: [], volumes: [], networks: [] }
  const ids = (await command(docker, ['ps', '-aq', '--filter', `label=dsh.pr-ci=${nonce}`], { env })).split(/\s+/).filter(Boolean)
  for (const id of ids) {
    let gone = false, lastError
    for (let attempt = 0; attempt < 8 && !gone; attempt++) {
      let value
      try { value = JSON.parse(await command(docker, ['inspect', id], { env }))[0] }
      catch (error) {
        if (/no such (?:object|container)|not found/i.test(String(error))) { gone = true; break }
        throw error
      }
      if (value.Config?.Labels?.['dsh.pr-ci'] !== nonce) throw new Error('拒绝清理归属不明的容器')
      try { await command(docker, ['rm', '-f', '-v', id], { env }); gone = true }
      catch (error) {
        if (!/removal of container .* already in progress/i.test(String(error))) throw error
        lastError = error
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    if (!gone) throw lastError ?? new Error('CI 容器清理超时')
    removed.containers.push(id)
  }
  // act names its private caches/networks after the generated workflow name, which contains
  // this nonce; the patched runner keeps the toolcache volume under the same nonce.
  for (const [kind, plural] of [['volume', 'volumes'], ['network', 'networks']]) {
    const names = (await command(docker, [kind, 'ls', '--format', '{{.Name}}', '--filter', `name=${nonce}`], { env })).split(/\s+/).filter(Boolean)
    for (const name of names) {
      if (!name.startsWith('act-') && !name.startsWith('dsh-ci-') || !name.includes(nonce) || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`拒绝清理归属不明的 ${kind}`)
      const inspected = JSON.parse(await command(docker, [kind, 'inspect', name], { env }))[0]
      if (inspected.Name !== name) throw new Error('Docker 资源身份不匹配')
      await command(docker, [kind, 'rm', name], { env }); removed[plural].push(name)
    }
  }
  const remaining = await command(docker, ['ps', '-aq', '--filter', `label=dsh.pr-ci=${nonce}`], { env })
  if (remaining) throw new Error('CI 容器清理后仍然存在')
  return { success: true, ...removed }
}
