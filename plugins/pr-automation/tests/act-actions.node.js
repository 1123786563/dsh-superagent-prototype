import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { stringify } from 'yaml'
import { validateLocalActions } from '../act-actions.js'

const pinned = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
const workflow = (...uses) => ({ jobs: { test: { steps: uses.map(uses => ({ uses })) } } })
const composite = steps => ({ name: 'Local composite', runs: { using: 'composite', steps } })
const node = (extra = {}) => ({ name: 'Local JavaScript', runs: { using: 'node24', main: 'main.js', ...extra } })

async function fixture(t) {
  const tempParent = await realpath(tmpdir())
  const root = await mkdtemp(join(tempParent, 'dsh-act-actions-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  t.after(async () => {
    // Never recursively remove an unchecked path, including on test failures.
    assert.equal(dirname(resolve(root)), tempParent)
    assert.match(basename(root), /^dsh-act-actions-/)
    assert.equal(await realpath(root), resolve(root))
    await rm(root, { recursive: true, force: true })
  })
  async function file(path, contents = '') {
    const target = join(workspace, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents)
    return target
  }
  async function action(path, metadata, filename = 'action.yml') {
    await file(`${path}/${filename}`, stringify(metadata))
    return join(workspace, path)
  }
  return { root, workspace, file, action }
}

test('accepts node20/node24 entry points and lifecycle files without running code', async t => {
  const f = await fixture(t)
  for (const using of ['node20', 'node24']) {
    await f.action(using, node({ using, pre: 'pre.js', post: 'post.js' }))
    for (const name of ['main', 'pre', 'post']) await f.file(`${using}/${name}.js`, 'throw new Error("This code must never execute")')
  }
  assert.equal(await validateLocalActions(workflow('./node20', './node24', pinned), f.workspace), undefined)
})

test('resolves nested composite local uses from workspace root, including action.yaml fallback', async t => {
  const f = await fixture(t)
  await f.action('outer', composite([{ uses: './inner' }, { uses: pinned }, { run: 'exit 1', shell: 'bash' }]))
  await f.action('inner', node(), 'action.yaml')
  await f.file('inner/main.js')
  await validateLocalActions(workflow('./outer'), f.workspace)
})

test('checks all retained jobs, not just the first job', async t => {
  const f = await fixture(t)
  const value = workflow(pinned)
  value.jobs.another = { steps: [{ uses: 'actions/checkout@main' }] }
  await assert.rejects(validateLocalActions(value, f.workspace), /commit-pinned/)
})

test('rejects Docker and unknown action runtimes, including nested Docker actions', async t => {
  const f = await fixture(t)
  for (const using of ['docker', 'node16', 'node12', 'bash', '${{ inputs.runtime }}', undefined]) {
    await f.action('bad', { runs: { using, main: 'main.js', image: 'Dockerfile' } })
    await assert.rejects(validateLocalActions(workflow('./bad'), f.workspace), /runs\.using/)
  }
  await f.action('bad', { runs: { using: 'docker', image: 'docker://alpine:3' } })
  await f.action('outer', composite([{ uses: './bad' }]))
  await assert.rejects(validateLocalActions(workflow('./outer'), f.workspace), /runs\.using docker/)
})

test('rejects external actions without a full commit pin, including nested uses', async t => {
  const f = await fixture(t)
  for (const uses of ['owner/repo@main', 'actions/checkout@v4', 'docker://alpine:3',
    'owner/repo@' + 'a'.repeat(39), 'owner/repo@' + 'a'.repeat(41), '${{ inputs.action }}']) {
    await assert.rejects(validateLocalActions(workflow(uses), f.workspace), /commit-pinned/)
    await f.action('outer', composite([{ uses }]))
    await assert.rejects(validateLocalActions(workflow('./outer'), f.workspace), /commit-pinned/)
  }
  await validateLocalActions(workflow('owner/repo/sub/action@' + 'a'.repeat(40)), f.workspace)
})

test('rejects missing action directories, metadata and JavaScript entry points', async t => {
  const f = await fixture(t)
  await assert.rejects(validateLocalActions(workflow('./missing'), f.workspace), /ENOENT/)
  await mkdir(join(f.workspace, 'empty'))
  await assert.rejects(validateLocalActions(workflow('./empty'), f.workspace), /missing action/)
  await f.action('missing-main', node())
  await assert.rejects(validateLocalActions(workflow('./missing-main'), f.workspace), /ENOENT/)
  await f.action('no-main', { runs: { using: 'node20' } })
  await assert.rejects(validateLocalActions(workflow('./no-main'), f.workspace), /node main/)
  await f.action('directory-main', node())
  await mkdir(join(f.workspace, 'directory-main', 'main.js'))
  await assert.rejects(validateLocalActions(workflow('./directory-main'), f.workspace), /file required/)
})

test('rejects local path traversal, absolute paths and direct .git access', async t => {
  const f = await fixture(t)
  await f.action('.git/private', node()); await f.file('.git/private/main.js')
  for (const uses of ['./.git/private', './inner/../../outside', '../outside', '/tmp/action', './a\\b']) {
    await assert.rejects(validateLocalActions(workflow(uses), f.workspace), /forbidden|commit-pinned/)
  }
})

test('rejects action-directory, metadata and node-entry symlink escapes', async t => {
  const f = await fixture(t)
  const outside = join(f.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'action.yml'), stringify(node()))
  await writeFile(join(outside, 'main.js'), '')
  await symlink(outside, join(f.workspace, 'linked-directory'))
  await assert.rejects(validateLocalActions(workflow('./linked-directory'), f.workspace), /escapes workspace/)
  await mkdir(join(f.workspace, 'linked-metadata'))
  await symlink(join(outside, 'action.yml'), join(f.workspace, 'linked-metadata', 'action.yml'))
  await assert.rejects(validateLocalActions(workflow('./linked-metadata'), f.workspace), /escapes workspace/)
  await f.action('linked-entry', node())
  await symlink(join(outside, 'main.js'), join(f.workspace, 'linked-entry', 'main.js'))
  await assert.rejects(validateLocalActions(workflow('./linked-entry'), f.workspace), /escapes workspace/)
})

test('rejects symlink paths into .git while allowing safe internal aliases', async t => {
  const f = await fixture(t)
  await f.action('safe', node()); await f.file('safe/main.js')
  await symlink(join(f.workspace, 'safe'), join(f.workspace, 'safe-alias'))
  await validateLocalActions(workflow('./safe-alias'), f.workspace)
  await f.action('.git/private', node()); await f.file('.git/private/main.js')
  await symlink(join(f.workspace, '.git', 'private'), join(f.workspace, 'hidden'))
  await assert.rejects(validateLocalActions(workflow('./hidden'), f.workspace), /\.git/)
  await f.action('entry', node())
  await symlink(join(f.workspace, '.git', 'private', 'main.js'), join(f.workspace, 'entry', 'main.js'))
  await assert.rejects(validateLocalActions(workflow('./entry'), f.workspace), /\.git/)
})

test('validates main, pre and post paths against workspace boundaries', async t => {
  const f = await fixture(t)
  const outside = join(f.root, 'outside.js'); await writeFile(outside, '')
  await f.file('shared.js')
  await f.action('valid', node({ main: '../shared.js' }))
  await validateLocalActions(workflow('./valid'), f.workspace)
  for (const field of ['main', 'pre', 'post']) {
    for (const path of [outside, '../../outside.js', '${{ inputs.path }}', 'C:\\outside.js']) {
      await f.action('bad', node({ [field]: path })); await f.file('bad/main.js')
      await assert.rejects(validateLocalActions(workflow('./bad'), f.workspace), /relative file path|escapes workspace/)
    }
  }
})

test('detects direct and indirect cycles by realpath, including directory aliases', async t => {
  const f = await fixture(t)
  await f.action('one', composite([{ uses: './one' }]))
  await assert.rejects(validateLocalActions(workflow('./one'), f.workspace), /cycle/)
  await f.action('one', composite([{ uses: './two' }]))
  await f.action('two', composite([{ uses: './one-alias' }]))
  await symlink(join(f.workspace, 'one'), join(f.workspace, 'one-alias'))
  await assert.rejects(validateLocalActions(workflow('./one'), f.workspace), /cycle/)
})

test('bounds recursion depth even after a prior shallow traversal', async t => {
  const f = await fixture(t)
  for (let index = 1; index <= 16; index++) {
    await f.action(`level${index}`, index === 16 ? node() : composite([{ uses: `./level${index + 1}` }]))
  }
  await f.file('level16/main.js')
  await validateLocalActions(workflow('./level1'), f.workspace)
  await f.action('outer', composite([{ uses: './level1' }]))
  await assert.rejects(validateLocalActions(workflow('./level1', './outer'), f.workspace), /nesting exceeds 16/)
})

test('bounds repeated references and permits ordinary reuse without treating it as a cycle', async t => {
  const f = await fixture(t)
  await f.action('shared', node()); await f.file('shared/main.js')
  await validateLocalActions(workflow('./shared', './shared'), f.workspace)
  await assert.rejects(validateLocalActions(workflow(...Array(257).fill('./shared')), f.workspace), /256 references/)
})

test('rejects malformed metadata, YAML aliases, duplicate keys and mixed lifecycle forms', async t => {
  const f = await fixture(t)
  for (const text of ['runs: [', 'runs: {}\nruns: {}', 'runs: null', '[]',
    'runs: {using: composite, steps: [&step {run: true}, *step]}']) {
    await f.file('bad/action.yml', text)
    await assert.rejects(validateLocalActions(workflow('./bad'), f.workspace), /YAML|metadata/)
  }
  for (const metadata of [composite([]), composite([{ name: 'empty' }]), composite([{ run: 'true', uses: pinned }]),
    { runs: { using: 'composite', steps: [{ run: 'true' }], image: 'Dockerfile' } },
    node({ args: ['$(touch /tmp/unsafe)'] })]) {
    await f.action('bad', metadata)
    await assert.rejects(validateLocalActions(workflow('./bad'), f.workspace), /steps|step|incompatible/)
  }
})

test('rejects all continue-on-error declarations at job and composite step levels', async t => {
  const f = await fixture(t)
  for (const value of [true, false, '${{ inputs.ignore }}']) {
    const job = workflow(pinned); job.jobs.test['continue-on-error'] = value
    await assert.rejects(validateLocalActions(job, f.workspace), /continue-on-error/)
    await f.action('bad', composite([{ run: 'false', 'continue-on-error': value }]))
    await assert.rejects(validateLocalActions(workflow('./bad'), f.workspace), /continue-on-error/)
  }
})

test('treats inputs and step arguments as data and never executes shell commands', async t => {
  const f = await fixture(t)
  await f.action('data', { inputs: { value: { default: '$(exit 42)' } },
    runs: { using: 'composite', steps: [{ uses: pinned, with: { args: '$(exit 43)' } },
      { run: 'exit 44', shell: 'bash', env: { ARG: '$(exit 45)' } }] } })
  await validateLocalActions(workflow('./data'), f.workspace)
})
