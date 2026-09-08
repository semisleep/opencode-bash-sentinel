// Workspace path policy — our own rules, NOT part of the upstream port.
//
// Principle:
//   - inside the workspace: reads and writes are auto-approved
//   - outside the workspace: reads are auto-approved, writes require confirmation
//
// Enforced over the bash syntax tree: write-command targets, write-redirect
// targets, inline-code interpreters, find/xargs escape hatches, and the
// cd-then-relative-write combo. `.git` is always a write-forbidden zone.
// Anything unresolvable (variables, globs, substitutions) fails safe.

import os from 'node:os'
import path from 'node:path'

import { parse } from './parser/index'
import type { SyntaxNode } from './parser/node'
import {
  DD_SAFE_DEVICE_TARGETS,
  NESTED_SHELLS,
  PRIVILEGE_VALUE_OPTIONS,
  PRIVILEGE_WRAPPERS,
  WRAPPER_VALUE_OPTIONS,
  LAUNCH_WRAPPERS,
  collectCommands,
  dropLaunchWrapperOperands,
  literalText,
  normalizeCommandName,
} from './analyzer'
import type { DangerousVerdict } from './analyzer'

export interface WorkspaceContext {
  readonly workspace: string
  readonly homedir: string
}

export interface PolicyResult {
  readonly verdict: DangerousVerdict | undefined
  readonly rmHandled: boolean
}

const DEVICE_EXEMPT = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])

const WRITE_COMMANDS = new Set([
  'rm',
  'sed',
  'dd',
  'rsync',
  'install',
  'ln',
  'tee',
  'truncate',
  'shred',
  'cpio',
  'mv',
  'cp',
  'chmod',
  'chown',
  'touch',
  'mkdir',
])

const XARGS_BLOCKED_OPERANDS = new Set([
  ...WRITE_COMMANDS,
  'find',
  'xargs',
  'python',
  'python3',
  'node',
  'ruby',
  'perl',
  'php',
  'osascript',
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'ash',
])

const XARGS_VALUE_OPTIONS = new Set([
  '-I',
  '-n',
  '-P',
  '-s',
  '-E',
  '-j',
  '-L',
  '-o',
  '--arg-file',
  '--max-args',
  '--max-procs',
  '--max-chars',
  '--replace',
])

const INLINE_CODE_INTERPRETERS: Readonly<Record<string, readonly (string | RegExp)[]>> = {
  python: ['-c'],
  python3: ['-c'],
  node: ['-e', '-p', '--eval', '--print'],
  ruby: [/^-[a-zA-Z]*e$/, '--eval'],
  perl: [/^-[a-zA-Z]*e$/],
  php: ['-r', /^-[a-zA-Z]*r$/],
}

const ALWAYS_ESCALATE_INTERPRETERS = new Set(['osascript'])

// command wrappers that execute the following token as a command
const COMMAND_WRAPPERS: Readonly<Record<string, readonly string[]>> = {
  time: [],
  timeout: ['-k', '-s', '--signal', '--kill-after'],
  watch: ['-n', '-g'],
  stdbuf: [],
  ionice: ['-c', '-p', '-n'],
}

const COMMAND_WRAPPER_NAMES = new Set(Object.keys(COMMAND_WRAPPERS))

const FIND_DESTRUCTIVE_FLAGS = new Set(['-delete', '--delete', '-exec', '-execdir', '-ok', '-okdir'])

// git subcommands that only read; anything else on an external repo escalates
const GIT_READONLY_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'annotate',
  'ls-files',
  'rev-parse',
  'describe',
  'shortlog',
  'cat-file',
  'reflog',
  'whatchanged',
  'grep',
  'help',
  'version',
  'var',
  'check-ignore',
  'count-objects',
  'fsck',
])

// git global flags that consume the next argument as a value
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

const COPY_MOVE_VALUE_OPTIONS = new Set(['-t', '--target-directory', '-S', '--suffix'])
const INSTALL_VALUE_OPTIONS = new Set([
  '-t',
  '--target-directory',
  '-m',
  '--mode',
  '-o',
  '--owner',
  '-g',
  '--group',
])
const CHMOD_VALUE_OPTIONS = new Set(['--reference'])
const CHOWN_VALUE_OPTIONS = new Set(['--from', '--reference'])
const TOUCH_VALUE_OPTIONS = new Set(['-t', '-d', '-r', '--date', '--reference'])
const MKDIR_VALUE_OPTIONS = new Set(['-m', '--mode'])

type TargetClass = 'inside' | 'outside' | 'relative' | 'unresolvable'

export function analyzeWorkspacePolicy(source: string, ctx: WorkspaceContext): PolicyResult {
  try {
    return analyzeTree(source, ctx)
  } catch {
    return { verdict: { kind: 'unanalyzable' }, rmHandled: false }
  }
}

function analyzeTree(source: string, ctx: WorkspaceContext): PolicyResult {
  const parsed = parse(source, { timeoutMs: 500, maxNodes: 10_000 })
  if (!parsed.ok || parsed.hasError) return { verdict: { kind: 'unanalyzable' }, rmHandled: false }

  const state = {
    dangerous: undefined as DangerousVerdict | undefined,
    rmHandled: false,
    relativeWrite: false,
    externalCd: false,
  }

  const commands: SyntaxNode[] = []
  collectCommands(parsed.rootNode, commands)
  for (const command of commands) checkCommandNode(command, ctx, state)

  checkRedirects(parsed.rootNode, ctx, state)

  if (state.dangerous === undefined && state.relativeWrite && state.externalCd) {
    state.dangerous = { kind: 'dangerous', command: 'write after cd outside workspace' }
  }
  return { verdict: state.dangerous, rmHandled: state.rmHandled }
}

function checkCommandNode(node: SyntaxNode, ctx: WorkspaceContext, state: State): void {
  const invocation = commandInvocationLoose(node)
  if (invocation === undefined) {
    fail(state, 'unresolvable command')
    return
  }
  checkInvocation(invocation.name, invocation.args, ctx, state, invocation.dropped)
}

interface State {
  dangerous: DangerousVerdict | undefined
  rmHandled: boolean
  relativeWrite: boolean
  externalCd: boolean
}

function fail(state: State, command: string): void {
  if (state.dangerous === undefined) state.dangerous = { kind: 'dangerous', command }
}

function verdictCommand(verdict: DangerousVerdict): string {
  return verdict.kind === 'dangerous' ? verdict.command : verdict.kind
}

function checkInvocation(
  rawName: string,
  rawArgs: readonly string[],
  ctx: WorkspaceContext,
  state: State,
  invocationDropped: boolean,
): void {
  let name = rawName
  let args = rawArgs
  let dropped = invocationDropped

  for (let hops = 0; hops < 8; hops += 1) {
    if (PRIVILEGE_WRAPPERS.has(name)) {
      const rest = dropValueOptions(args, PRIVILEGE_VALUE_OPTIONS)
      if (rest.length === 0) return
      name = normalizeCommandName(rest[0]!)
      args = rest.slice(1)
      continue
    }
    if (LAUNCH_WRAPPERS.has(name)) {
      const rest = dropLaunchWrapperOperands(name, args)
      if (rest.length === 0) return
      name = normalizeCommandName(rest[0]!)
      args = rest.slice(1)
      continue
    }
    if (name === 'busybox') {
      if (args.length === 0 || args[0]!.startsWith('-')) return
      name = normalizeCommandName(args[0]!)
      args = args.slice(1)
      continue
    }
    if (COMMAND_WRAPPER_NAMES.has(name)) {
      const rest = commandWrapperOperands(name, args)
      if (rest.length === 0) return
      name = normalizeCommandName(rest[0]!)
      args = rest.slice(1)
      continue
    }
    break
  }

  if (NESTED_SHELLS.has(name)) {
    const payload = nestedShellPayload(args)
    if (payload !== undefined) {
      const nested = analyzeWorkspacePolicy(payload, ctx)
      if (nested.verdict !== undefined) fail(state, verdictCommand(nested.verdict))
      state.rmHandled ||= nested.rmHandled
      return
    }
    // `curl ... | sh`, `bash < script.sh`: a shell with no -c payload and no
    // script operand executes whatever arrives on stdin — not analyzable
    if (positionalArgs(args, new Set()).length === 0) {
      fail(state, 'shell executes script from stdin (pipe)')
    }
    return
  }
  if (name === 'eval') {
    if (args.length > 0) {
      const nested = analyzeWorkspacePolicy(args.join(' '), ctx)
      if (nested.verdict !== undefined) fail(state, verdictCommand(nested.verdict))
      state.rmHandled ||= nested.rmHandled
    }
    return
  }

  if (dropped && WRITE_COMMANDS.has(name)) {
    fail(state, `${name}: unresolvable operand on write command`)
    return
  }

  if (name === 'rm') {
    checkRm(args, ctx, state)
    return
  }
  if (name === 'cp' || name === 'mv' || name === 'install') {
    // destination is the last positional; `-t DIR` / `--target-directory DIR`
    // (and `install`'s mode/owner value flags) are consumed as values
    const valueOptions = name === 'install' ? INSTALL_VALUE_OPTIONS : COPY_MOVE_VALUE_OPTIONS
    checkCopyMove(args, valueOptions, ctx, state, name)
    return
  }
  if (name === 'chmod') {
    // first positional is the mode spec, the rest are files
    for (const target of positionalArgs(args, CHMOD_VALUE_OPTIONS).slice(1)) {
      checkWriteTarget(target, ctx, state, name)
    }
    return
  }
  if (name === 'chown') {
    // first positional is the owner spec, the rest are files
    for (const target of positionalArgs(args, CHOWN_VALUE_OPTIONS).slice(1)) {
      checkWriteTarget(target, ctx, state, name)
    }
    return
  }
  if (name === 'touch') {
    for (const target of positionalArgs(args, TOUCH_VALUE_OPTIONS)) checkWriteTarget(target, ctx, state, name)
    return
  }
  if (name === 'mkdir' || name === 'rmdir') {
    for (const target of positionalArgs(args, MKDIR_VALUE_OPTIONS)) checkWriteTarget(target, ctx, state, name)
    return
  }
  if (name === 'git') {
    checkGit(args, ctx, state)
    return
  }
  if (name === 'dd') {
    checkDd(args, ctx, state)
    return
  }
  if (name === 'sed') {
    checkSed(args, ctx, state)
    return
  }
  if (name === 'rsync' || name === 'ln') {
    const positionals = positionalArgs(args, new Set())
    const target = positionals.at(-1)
    if (target !== undefined) checkWriteTarget(target, ctx, state, name)
    return
  }
  if (name === 'tee' || name === 'truncate' || name === 'shred') {
    for (const target of positionalArgs(args, new Set())) checkWriteTarget(target, ctx, state, name)
    return
  }
  if (name === 'find') {
    if (args.some((arg) => FIND_DESTRUCTIVE_FLAGS.has(arg))) fail(state, 'find -delete/-exec')
    return
  }
  if (name === 'xargs') {
    for (const operand of positionalArgs(args, XARGS_VALUE_OPTIONS)) {
      if (XARGS_BLOCKED_OPERANDS.has(normalizeCommandName(operand))) {
        fail(state, 'xargs invokes a write-capable command')
        return
      }
    }
    return
  }
  if (name === 'cd' || name === 'pushd') {
    const target = positionalArgs(args, new Set())[0]
    if (target === undefined) {
      state.externalCd = true
      return
    }
    const cls = classifyTarget(target, ctx)
    if (cls === 'outside' || cls === 'unresolvable') state.externalCd = true
    return
  }
  const inline = INLINE_CODE_INTERPRETERS[name]
  if (inline !== undefined) {
    for (const arg of args) {
      if (arg === '--') break
      if (inline.some((pattern) => (typeof pattern === 'string' ? arg === pattern : pattern.test(arg)))) {
        fail(state, `${name} inline code`)
        return
      }
    }
    return
  }
  if (ALWAYS_ESCALATE_INTERPRETERS.has(name)) {
    fail(state, name)
  }
}

function checkCopyMove(
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
  ctx: WorkspaceContext,
  state: State,
  command: string,
): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--') break
    if (arg === '-t' || arg === '--target-directory') {
      const target = args[i + 1]
      if (target !== undefined && !target.startsWith('-')) {
        checkWriteTarget(target, ctx, state, command)
        return
      }
    }
    if (/^-[a-zA-Z]*t[a-zA-Z]*$/.test(arg) && arg !== '-t') {
      const target = args[i + 1]
      if (target !== undefined && !target.startsWith('-')) {
        checkWriteTarget(target, ctx, state, command)
        return
      }
    }
    if (arg.startsWith('--target-directory=')) {
      checkWriteTarget(arg.slice(arg.indexOf('=') + 1), ctx, state, command)
      return
    }
  }
  const rest = dropValueOptions(args, valueOptions)
  const destination = rest.filter((arg) => arg !== '-' && !arg.startsWith('-')).at(-1)
  if (destination !== undefined) checkWriteTarget(destination, ctx, state, command)
}

// `git -C <dir>` (and --git-dir/--work-tree) makes git operate on another
// repository: read-only subcommands are fine there, everything else escalates.
// In-workspace git commands are always allowed — git's own .git bookkeeping is
// the recoverable path; the `.git` path rule only gates direct file access.
function checkGit(args: readonly string[], ctx: WorkspaceContext, state: State): void {
  let externalRepo = false
  let subcommand: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--') break
    if (arg.startsWith('-')) {
      if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
        const value = arg.slice(arg.indexOf('=') + 1)
        externalRepo ||= isExternalTarget(value, ctx)
        continue
      }
      if (/^-C.+/.test(arg)) {
        externalRepo ||= isExternalTarget(arg.slice(2), ctx)
        continue
      }
      if (arg.includes('=')) continue
      if (GIT_VALUE_FLAGS.has(arg)) {
        const value = args[i + 1]
        if (value === undefined) break
        if (arg !== '-c') externalRepo ||= isExternalTarget(value, ctx)
        i += 1
      }
      continue
    }
    subcommand = arg
    break
  }
  if (externalRepo && subcommand !== undefined && !GIT_READONLY_SUBCOMMANDS.has(subcommand)) {
    fail(state, `git ${subcommand} on external repository`)
  }
}

function checkRm(args: readonly string[], ctx: WorkspaceContext, state: State): void {
  state.rmHandled = true
  const targets = positionalArgs(args, new Set())
  if (targets.length === 0) return
  for (const raw of targets) {
    const resolved = resolveTarget(raw, ctx)
    if (resolved === undefined) {
      fail(state, 'rm: unresolvable target')
      continue
    }
    if (hasGitSegment(resolved) || hasGitSegment(raw)) {
      fail(state, 'rm: .git path')
      continue
    }
    if (path.isAbsolute(resolved)) {
      if (resolved === '/' || resolved === ctx.homedir || resolved === ctx.workspace) {
        fail(state, 'rm: workspace/home root target')
        continue
      }
      if (!withinWorkspace(resolved, ctx.workspace)) {
        fail(state, 'rm: outside workspace')
        continue
      }
    } else {
      state.relativeWrite = true
    }
  }
}

function checkDd(args: readonly string[], ctx: WorkspaceContext, state: State): void {
  for (const arg of args) {
    if (!arg.startsWith('of=')) continue
    const target = arg.slice('of='.length)
    if (DD_SAFE_DEVICE_TARGETS.has(target)) continue
    if (target.startsWith('/dev/')) continue
    checkWriteTarget(target, ctx, state, 'dd')
  }
}

function checkSed(args: readonly string[], ctx: WorkspaceContext, state: State): void {
  const inPlace = args.some((arg) => arg === '--in-place' || arg.startsWith('--in-place=') || /^-[a-zA-Z]*i/.test(arg))
  if (!inPlace) return
  const targets = positionalArgs(args, new Set())
  for (const target of targets.slice(1)) checkWriteTarget(target, ctx, state, 'sed')
}

function checkWriteTarget(raw: string, ctx: WorkspaceContext, state: State, command: string): void {
  const resolved = resolveTarget(raw, ctx)
  if (resolved === undefined) {
    fail(state, `${command}: unresolvable write target`)
    return
  }
  if (hasGitSegment(resolved) || hasGitSegment(raw)) {
    fail(state, `${command}: .git write`)
    return
  }
  if (path.isAbsolute(resolved)) {
    if (!withinWorkspace(resolved, ctx.workspace)) {
      fail(state, `${command}: write outside workspace`)
    }
  } else {
    state.relativeWrite = true
  }
}

function checkRedirects(root: SyntaxNode, ctx: WorkspaceContext, state: State): void {
  const stack: SyntaxNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === 'file_redirect') {
      const operator = node.children.find((child) => !child.isNamed)?.text ?? ''
      const targetNode = node.children.find((child) => child.isNamed && child.type !== 'file_descriptor')
      if (operator.includes('>') && targetNode !== undefined) {
        const raw = redirectTargetText(targetNode)
        if (raw !== undefined) {
          if (!DEVICE_EXEMPT.has(raw)) checkWriteTarget(raw, ctx, state, 'redirect')
        } else {
          fail(state, 'redirect: unresolvable write target')
        }
      }
    }
    for (const child of node.children) stack.push(child)
  }
}

function redirectTargetText(node: SyntaxNode): string | undefined {
  if (node.type === 'number') return node.text
  return argText(node)
}

// `time rm x`, `timeout 10 rm x`, `watch [-n 2] rm x`, ... — strip the
// wrapper's own flags/value-options; `timeout` additionally consumes one
// DURATION token before the command.
function commandWrapperOperands(name: string, args: readonly string[]): string[] {
  const valueOptions = new Set(COMMAND_WRAPPERS[name] ?? [])
  let rest = dropValueOptions(args, valueOptions)
  if (name === 'timeout') rest = rest.slice(1)
  return rest
}

function nestedShellPayload(args: readonly string[]): string | undefined {  let payloadIndex = -1
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--') break
    if (/^-[a-zA-Z]+$/.test(arg)) {
      if (arg.includes('c')) payloadIndex = i + 1
    } else {
      break
    }
  }
  if (payloadIndex < 0) return undefined
  return args[payloadIndex]
}

function commandInvocationLoose(node: SyntaxNode): { name: string; args: string[]; dropped: boolean } | undefined {
  const nameIndex = node.children.findIndex((child) => child.type === 'command_name')
  const nameNode = nameIndex >= 0 ? node.children[nameIndex] : undefined
  const nameWord = nameNode?.children.find((child) => child.isNamed)
  const rawName = nameWord === undefined ? undefined : nameWord.text
  if (rawName === undefined || rawName.length === 0) return undefined
  if (/[$`*?[\](){}]/.test(rawName)) return undefined
  const args: string[] = []
  let dropped = false
  for (const child of node.children.slice(nameIndex + 1)) {
    if (child.type === 'variable_assignment' || child.type === 'heredoc_redirect') continue
    const value = argText(child)
    if (value === undefined) {
      dropped = true
    } else if (value.length > 0) {
      args.push(value)
    }
  }
  return { name: normalizeCommandName(rawName), args, dropped }
}

// Like the analyzer's literalText, but keeps `~` (expanded later via homedir)
// so that `~/x` targets classify as home-absolute instead of unresolvable,
// and keeps the bare `{}` xargs placeholder.
function argText(node: SyntaxNode): string | undefined {
  const unsafe = (value: string) => /[$`*?[\](){}]/.test(value) && value !== '{}'
  switch (node.type) {
    case 'word': {
      const raw = node.text
      if (unsafe(raw)) return undefined
      return raw.replaceAll(/\\(.)/gs, '$1')
    }
    case 'raw_string': {
      if (node.text.length < 2) return undefined
      const value = node.text.slice(1, -1)
      return unsafe(value) ? undefined : value
    }
    case 'string': {
      let value = ''
      for (const child of node.children) {
        if (child.type === 'string_content') {
          value += child.text
        } else if (child.isNamed) {
          return undefined
        }
      }
      return unsafe(value) ? undefined : value
    }
    case 'concatenation': {
      const raw = node.text
      return unsafe(raw) ? undefined : raw
    }
    default:
      return literalText(node)
  }
}

function dropValueOptions(args: readonly string[], valueOptions: ReadonlySet<string>): string[] {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--') return args.slice(i + 1)
    if (arg === '-' || !arg.startsWith('-')) return args.slice(i)
    if (!arg.includes('=') && valueOptions.has(arg)) i += 1
  }
  return []
}

function positionalArgs(args: readonly string[], valueOptions: ReadonlySet<string>): string[] {
  const rest = dropValueOptions(args, valueOptions)
  return rest.filter((arg) => arg !== '-' && !arg.startsWith('-'))
}

function resolveTarget(raw: string, ctx: WorkspaceContext): string | undefined {
  let p = raw
  if (p === '~') p = ctx.homedir
  else if (p.startsWith('~/')) p = ctx.homedir + p.slice(1)
  else if (p.startsWith('~')) return undefined
  if (/[$`*?[\](){}]/.test(p) && p !== '{}') return undefined
  if (p === '') return undefined
  const normalized = path.normalize(p)
  if (normalized.length > 1 && normalized.endsWith('/')) return normalized.slice(0, -1)
  return normalized
}

function classifyTarget(raw: string, ctx: WorkspaceContext): TargetClass {
  const resolved = resolveTarget(raw, ctx)
  if (resolved === undefined) return 'unresolvable'
  if (path.isAbsolute(resolved)) return withinWorkspace(resolved, ctx.workspace) ? 'inside' : 'outside'
  return 'relative'
}

// Relative targets resolve against the workspace cwd, so they count as inside.
function isExternalTarget(raw: string, ctx: WorkspaceContext): boolean {
  const cls = classifyTarget(raw, ctx)
  return cls === 'outside' || cls === 'unresolvable'
}

export function hasGitSegment(p: string): boolean {
  return p.split('/').some((segment) => segment.toLowerCase() === '.git')
}

export function withinWorkspace(resolved: string, workspace: string): boolean {
  const base = path.normalize(workspace)
  if (resolved === base) return true
  return resolved.startsWith(base + '/')
}

export function defaultWorkspaceContext(workspace: string): WorkspaceContext {
  return { workspace: path.normalize(workspace), homedir: os.homedir() }
}
