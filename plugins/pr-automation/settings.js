import s from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { validateExecutionConfig } from './execution-window.js'

export const name = 'dsh-pr-automation-settings'
export const inject = ['configEditor', 'webServer']
export const Config = s.object({ entryId: s.string().default('dsh-pr-automation').description('要配置的 PR 自动审核条目 ID。') })
const keys = ['enabled', 'autoMerge', 'pollSeconds', 'executionWindow']
class HttpError extends Error { constructor(status, message) { super(message); this.status = status } }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const revisionOf = raw => createHash('sha256').update(JSON.stringify(raw)).digest('hex')

export function settingsValue(raw) {
  const normalized = validateExecutionConfig({ enabled: raw.enabled ?? true, executionWindow: raw.executionWindow ?? {} })
  return validateSettings({ enabled: normalized.enabled, autoMerge: raw.autoMerge ?? false, pollSeconds: raw.pollSeconds ?? 60,
    executionWindow: normalized.executionWindow })
}
export function validateSettings(value) {
  if (!object(value) || keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new HttpError(400, '请提交完整的 PR 自动审核设置，不能修改其他配置字段。')
  }
  if (typeof value.enabled !== 'boolean' || typeof value.autoMerge !== 'boolean') throw new HttpError(400, '开关必须为布尔值。')
  if (!Number.isInteger(value.pollSeconds) || value.pollSeconds < 60 || value.pollSeconds > 3600) throw new HttpError(400, '轮询间隔必须是 60–3600 秒的整数。')
  const window = value.executionWindow, fields = ['enabled', 'timeZone', 'start', 'end']
  if (!object(window) || fields.some(key => !Object.hasOwn(window, key)) || Object.keys(window).some(key => !fields.includes(key))) throw new HttpError(400, '请提交完整的每日执行时段。')
  try { validateExecutionConfig(value) } catch (error) { throw new HttpError(400, `执行时段无效：${error.message}`) }
  return structuredClone(value)
}

/** Profile configuration is edited through Cordis, retaining all unrelated fields and its lifecycle rules. */
export class PrSettings {
  constructor({ editor, entryId, status }) { Object.assign(this, { editor, entryId, status }) }
  entry() {
    const entry = this.editor.entries().find(entry => entry.options.id === this.entryId && entry.options.name === '@local/dsh-pr-automation')
    if (!entry) throw new HttpError(404, '未找到可配置的 PR 自动审核插件。')
    return entry
  }
  async read() {
    const raw = structuredClone(this.entry().options.config ?? {})
    return { revision: revisionOf(raw), value: settingsValue(raw), repository: raw.repository, label: raw.label ?? 'auto-review', status: await this.status() }
  }
  async save(request) {
    if (!object(request) || Object.keys(request).some(key => !['revision', 'value'].includes(key)) || typeof request.revision !== 'string') throw new HttpError(400, '缺少有效的配置版本。')
    const value = validateSettings(request.value)
    await this.editor.edit(this.entry(), current => {
      if (revisionOf(current) !== request.revision) throw new HttpError(409, '配置已在其他页面修改，请重新加载当前设置后再保存。')
      const next = { ...current, ...value }
      validateExecutionConfig(next)
      // ConfigEditor validates the complete raw candidate with Loader expression support.
      return next
    })
    return this.read()
  }
}

async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(415, '请使用 JSON 提交配置。')
  const chunks = []; let size = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += part.length
    if (size > 16384) throw new HttpError(413, '配置请求过大。')
    chunks.push(part)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, '配置不是有效的 JSON。') }
}
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}
export function settingsHandler({ settings, origin, logger }) {
  const port = new URL(origin).port
  return async (req, res) => {
    const host = req.headers.host
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) || req.headers['x-pr-automation-request'] !== '1'
      || req.headers.origin && req.headers.origin !== `http://${host}`
      || req.method === 'PUT' && req.headers.origin !== `http://${host}`) { json(res, 403, { error: '只允许本机同源的设置请求。' }); return }
    if (!['GET', 'PUT'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, PUT' }); res.end(); return }
    try { json(res, 200, req.method === 'GET' ? await settings.read() : await settings.save(await readBody(req))) }
    catch (error) {
      if (error instanceof HttpError) json(res, error.status, { error: error.message })
      else { logger.error('PR settings: %s', String(error)); json(res, 503, { error: '无法保存或读取 PR 设置，请确认插件正在运行后重试。' }) }
    }
  }
}

/** Independent lifetime: editing the automation entry never tears down the request saving it. */
export function apply(ctx, config) {
  const origin = ctx.webServer.getOrigin()
  const settings = new PrSettings({ editor: ctx.configEditor, entryId: config.entryId, status: async () => {
    try {
      const response = await fetch(new URL('/pr-automation/api/status', origin), { headers: { 'x-pr-automation-request': '1' }, signal: AbortSignal.timeout(2500) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const { phase, lastError, lastPoll, nextPollAt, execution } = await response.json()
      return { phase, lastError, lastPoll, nextPollAt, execution }
    } catch { return { phase: 'unavailable', lastError: '自动审核运行状态暂不可用。', lastPoll: null, nextPollAt: null } }
  } })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/pr-automation/api/settings',
    handler: settingsHandler({ settings, origin, logger: ctx.logger }) }))
}
