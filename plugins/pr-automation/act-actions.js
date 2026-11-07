import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'

const own = (value, key) => Object.hasOwn(value, key)
const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const pinnedAction = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[a-fA-F0-9]{40}$/
const fail = message => { throw new Error(`Unsupported local action: ${message}`) }
const MAX_DEPTH = 16
const MAX_ACTIONS = 256
const MAX_METADATA_BYTES = 2_000_000

/**
 * Validate local action metadata without executing action code. Local `uses`
 * resolves from the checkout root, even inside a composite action; JavaScript
 * entry points resolve from their owning action directory. The runner still
 * must isolate all run/action code, including commit-pinned external actions.
 */
export async function validateLocalActions(workflowObject, workspace) {
  if (!mapping(workflowObject) || !mapping(workflowObject.jobs) || !Object.keys(workflowObject.jobs).length) fail('workflow requires jobs')
  if (typeof workspace !== 'string' || !workspace) fail('workspace must be a checkout directory')
  const root = await realpath(workspace)
  if (!(await stat(root)).isDirectory()) fail('workspace must be a directory')
  const active = new Set()
  let actionVisits = 0

  function withinWorkspace(path) {
    const pathFromRoot = relative(root, path)
    if (isAbsolute(pathFromRoot) || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) fail('path escapes workspace')
    if (pathFromRoot.split(sep).some(part => part.toLowerCase() === '.git')) fail('.git paths are forbidden')
    return path
  }

  async function checkedPath(path, kind) {
    withinWorkspace(path)
    const canonical = withinWorkspace(await realpath(path))
    const info = await stat(canonical)
    if (kind === 'file' ? !info.isFile() : !info.isDirectory()) fail(`${kind} required: ${relative(root, path)}`)
    return { path: canonical, info }
  }

  async function readMetadata(directory) {
    for (const name of ['action.yml', 'action.yaml']) {
      const candidate = resolve(directory, name)
      try { await lstat(candidate) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      const file = await checkedPath(candidate, 'file')
      if (file.info.size > MAX_METADATA_BYTES) fail('action metadata exceeds 2 MB')
      const document = parseDocument(await readFile(file.path, 'utf8'), { uniqueKeys: true, merge: false })
      if (document.errors.length) fail(`invalid action YAML: ${document.errors[0].message}`)
      let metadata
      try { metadata = document.toJS({ maxAliasCount: 0 }) }
      catch (error) { fail(`invalid action YAML: ${error.message}`) }
      if (!mapping(metadata) || !mapping(metadata.runs)) fail('action metadata requires runs')
      return metadata
    }
    fail(`missing action.yml or action.yaml: ${relative(root, directory) || '.'}`)
  }

  async function validateEntry(value, directory, field) {
    if (typeof value !== 'string' || !value || value.includes('${{') || value.includes('\0')
        || value.includes('\\') || isAbsolute(value)) fail(`node ${field} requires a static relative file path`)
    await checkedPath(resolve(directory, value), 'file')
  }

  async function validateUses(uses, depth) {
    if (typeof uses !== 'string' || !uses) fail('uses requires a string')
    if (pinnedAction.test(uses)) return
    if (!/^\.\/[A-Za-z0-9_./-]+$/.test(uses) || uses.split('/').includes('..')) fail('uses requires a local path or commit-pinned external action; Docker actions are forbidden')
    if (depth > MAX_DEPTH) fail(`local action nesting exceeds ${MAX_DEPTH}`)
    const { path: directory } = await checkedPath(resolve(root, uses), 'directory')
    if (active.has(directory)) fail(`local action cycle: ${uses}`)
    // Revalidate repeated references at their actual depth; a shallow cached
    // traversal must not conceal a later path exceeding the nesting limit.
    if (++actionVisits > MAX_ACTIONS) fail(`local action graph exceeds ${MAX_ACTIONS} references`)
    active.add(directory)
    try {
      const metadata = await readMetadata(directory)
      const runs = metadata.runs
      if (runs.using === 'composite') {
        if (!Array.isArray(runs.steps) || !runs.steps.length) fail('composite action requires nonempty steps')
        // Docker/JavaScript lifecycle fields on a composite are ambiguous and
        // could acquire different semantics in another runner version.
        if (['image', 'entrypoint', 'args', 'main', 'pre', 'post', 'pre-entrypoint', 'post-entrypoint'].some(key => own(runs, key))) fail('composite action contains incompatible lifecycle fields')
        await validateSteps(runs.steps, depth + 1)
      } else if (['node20', 'node24'].includes(runs.using)) {
        if (['image', 'entrypoint', 'args', 'steps', 'pre-entrypoint', 'post-entrypoint'].some(key => own(runs, key))) fail('node action contains incompatible Docker/composite fields')
        await validateEntry(runs.main, directory, 'main')
        for (const field of ['pre', 'post']) if (own(runs, field)) await validateEntry(runs[field], directory, field)
      } else fail(`runs.using ${String(runs.using)} is forbidden; only node20, node24 and composite are supported`)
    } finally { active.delete(directory) }
  }

  async function validateSteps(steps, depth) {
    if (!Array.isArray(steps) || !steps.length) fail('job requires nonempty steps')
    for (const step of steps) {
      if (!mapping(step) || (typeof step.run === 'string') === (typeof step.uses === 'string')
          || (!step.run && !step.uses)) fail('step requires exactly one run or uses string')
      if (own(step, 'continue-on-error')) fail('continue-on-error is forbidden')
      if (own(step, 'uses')) await validateUses(step.uses, depth)
    }
  }

  for (const job of Object.values(workflowObject.jobs)) {
    if (!mapping(job) || own(job, 'uses') || own(job, 'continue-on-error')) fail('job must contain direct steps without continue-on-error')
    await validateSteps(job.steps, 1)
  }
}
