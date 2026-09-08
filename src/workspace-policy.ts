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
  type BashParseResult,
  DD_SAFE_DEVICE_TARGETS,
  NESTED_SHELLS,
  PRIVILEGE_VALUE_OPTIONS,
  PRIVILEGE_WRAPPERS,
  WRAPPER_VALUE_OPTIONS,
  LAUNCH_WRAPPERS,
  collectCommands,
  dropLaunchWrapperOperands,
  literalText,
  nestedShellCommand,
  normalizeCommandName,
} from './analyzer'
import type { DangerousVerdict } from './analyzer'

export interface WorkspaceContext {
  readonly workspace: string
  readonly homedir: string
}

export interface PolicyResult {
  readonly verdict: DangerousVerdict | undefined
  /** Workspace target analysis may explicitly override upstream's path-blind rm -rf rule. */
  readonly suppressUpstreamRmRf: boolean
  /** Every command's external-path behavior is covered by an explicit rule. */
  readonly externalSafe: boolean
}

const DEVICE_EXEMPT = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])
const MAX_CWD_STATES = 32

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
  'mv',
  'cp',
  'chmod',
  'chown',
  'touch',
  'mkdir',
  'rmdir',
])

const EXTERNAL_MODELED_COMMANDS = new Set([
  ...WRITE_COMMANDS,
  'cat',
  'cd',
  'cmp',
  'cut',
  'df',
  'diff',
  'du',
  'echo',
  'egrep',
  'fgrep',
  'file',
  'find',
  'git',
  'grep',
  'head',
  'less',
  'ls',
  'printf',
  'pushd',
  'pwd',
  'readlink',
  'realpath',
  'rg',
  'ripgrep',
  'sed',
  'sort',
  'stat',
  'strings',
  'tail',
  'test',
  'touch',
  'uniq',
  'wc',
  'which',
])

const SENSITIVE_ENV_ASSIGNMENTS = new Set([
  'BASH_ENV',
  'CDPATH',
  'ENV',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'HOME',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'PATH',
  'PYTHONPATH',
  'RUBYLIB',
  'ZDOTDIR',
])

const XARGS_BLOCKED_OPERANDS = new Set([
  ...WRITE_COMMANDS,
  'cpio',
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
  python: ['-c', /^-c.+/],
  python3: ['-c', /^-c.+/],
  node: ['-e', '-p', '--eval', '--print', /^-[ep].+/, /^--(?:eval|print)=/],
  ruby: ['-e', /^-[a-zA-Z]*e(?:.+)?$/],
  perl: ['-e', /^-[a-zA-Z]*e(?:.+)?$/],
  php: ['-r', /^-[a-zA-Z]*r(?:.+)?$/],
}

// interpreters that execute a script file: the first positional operand is
// the script; running one from outside the workspace (or unresolvable, or
// stdin/heredoc) escalates
const SCRIPT_EXECUTORS: Readonly<Record<string, ReadonlySet<string>>> = {
  python: new Set(['-m']),
  python3: new Set(['-m']),
  node: new Set(),
  ruby: new Set(),
  perl: new Set(),
  php: new Set(),
  source: new Set(),
  '.': new Set(),
}

// remote-execution / remote-copy commands: any operand escalates
const REMOTE_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  ssh: new Set(['-p', '-i', '-l', '-o', '-b', '-e', '-w', '-W', '-L', '-R', '-D', '-J', '-S']),
  scp: new Set(['-P', '-i', '-o', '-F', '-l', '-d' ]),
  sftp: new Set(['-P', '-i', '-o', '-b']),
}

// awk programs can execute commands or write files from inside the program
const AWK_UNSAFE_PROGRAM = /system\s*\(|>{1,2}\s*['"]|\|\s*['"]/

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
  'whatchanged',
  'grep',
  'help',
  'version',
  'var',
  'check-ignore',
  'count-objects',
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
const RSYNC_VALUE_OPTIONS = new Set([
  '-e',
  '-f',
  '--address',
  '--backup-dir',
  '--block-size',
  '--bwlimit',
  '--compare-dest',
  '--compress-level',
  '--copy-dest',
  '--exclude',
  '--exclude-from',
  '--files-from',
  '--filter',
  '--groupmap',
  '--include',
  '--include-from',
  '--link-dest',
  '--log-file',
  '--log-file-format',
  '--max-delete',
  '--max-size',
  '--min-size',
  '--modify-window',
  '--out-format',
  '--password-file',
  '--port',
  '--rsync-path',
  '--suffix',
  '--temp-dir',
  '--timeout',
  '--usermap',
])

type TargetClass = 'inside' | 'outside' | 'relative' | 'unresolvable'

export function analyzeWorkspacePolicy(source: string, ctx: WorkspaceContext): PolicyResult {
  try {
    return analyzeTree(source, ctx)
  } catch {
    return { verdict: { kind: 'unanalyzable' }, suppressUpstreamRmRf: false, externalSafe: false }
  }
}

function analyzeTree(source: string, ctx: WorkspaceContext, initialCwd = ctx.workspace): PolicyResult {
  return analyzeWorkspaceParsed(parseWorkspaceSource(source), ctx, initialCwd)
}

function parseWorkspaceSource(source: string): BashParseResult {
  const parsed = parse(source, { timeoutMs: 500, maxNodes: 10_000 })
  return parsed.ok
    ? { ok: true, hasError: parsed.hasError, root: parsed.rootNode }
    : { ok: false }
}

export function analyzeWorkspaceParsed(
  parsed: BashParseResult,
  ctx: WorkspaceContext,
  initialCwd = ctx.workspace,
): PolicyResult {
  if (!parsed.ok || parsed.hasError) {
    return { verdict: { kind: 'unanalyzable' }, suppressUpstreamRmRf: false, externalSafe: false }
  }

  const state = {
    dangerous: undefined as DangerousVerdict | undefined,
    suppressUpstreamRmRf: false,
    relativeWrite: false,
    externalCd: false,
    cwds: new Set([initialCwd]),
    externalSafe: true,
    checkedRedirects: new Set<SyntaxNode>(),
  }

  const commands: SyntaxNode[] = []
  checkSensitiveAssignments(parsed.root, state)
  collectCommands(parsed.root, commands)
  for (const command of commands) checkCommandNode(command, ctx, state)

  checkRedirects(parsed.root, ctx, state)

  if (state.dangerous === undefined && state.relativeWrite && state.externalCd) {
    state.dangerous = { kind: 'dangerous', command: 'write after cd outside workspace' }
  }
  return {
    verdict: state.dangerous,
    suppressUpstreamRmRf: state.suppressUpstreamRmRf,
    externalSafe: state.externalSafe,
  }
}

function checkCommandNode(node: SyntaxNode, ctx: WorkspaceContext, state: State): void {
  const invocation = commandInvocationLoose(node)
  if (invocation === undefined) {
    fail(state, 'unresolvable command')
    return
  }
  // heredocs attach as siblings of the command under redirected_statement
  const siblings = node.parent?.children ?? []
  if (siblings.some((child) => child.type === 'heredoc_redirect')) invocation.hasHeredoc = true
  // Shell opens a command's redirects before executing the command. Capture
  // them now, while state.cwds still represents the command's entry cwd.
  for (const child of [...node.children, ...siblings]) {
    if (child.type === 'file_redirect') checkRedirectNode(child, ctx, state)
  }
  invocation.branchScoped = hasBranchOrSubshellAncestor(node)
  invocation.precededByAnd = isPrecededByOperator(node, '&&')
  checkInvocation(invocation.name, invocation.args, ctx, state, invocation.dropped, invocation)
}

interface State {
  dangerous: DangerousVerdict | undefined
  suppressUpstreamRmRf: boolean
  relativeWrite: boolean
  externalCd: boolean
  cwds: Set<string>
  externalSafe: boolean
  checkedRedirects: Set<SyntaxNode>
}

function fail(state: State, command: string): void {
  if (state.dangerous === undefined) state.dangerous = { kind: 'dangerous', command }
}

function checkSensitiveAssignments(root: SyntaxNode, state: State): void {
  const stack: SyntaxNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === 'variable_assignment') {
      state.externalSafe = false
      const name = node.text.split(/\+=|=/, 1)[0]
      if (name !== undefined && SENSITIVE_ENV_ASSIGNMENTS.has(name)) {
        fail(state, `sensitive environment assignment: ${name}`)
      }
    }
    for (const child of node.children) stack.push(child)
  }
}

function checkSensitiveAssignmentArgs(args: readonly string[], state: State): void {
  for (const arg of args) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(arg)
    if (match?.[1] !== undefined && SENSITIVE_ENV_ASSIGNMENTS.has(match[1])) {
      fail(state, `sensitive environment assignment: ${match[1]}`)
    }
  }
}

function hasBranchOrSubshellAncestor(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (
      parent.type === 'subshell' ||
      parent.type === 'command_substitution' ||
      parent.type === 'if_statement' ||
      parent.type === 'case_statement' ||
      parent.type === 'while_statement' ||
      parent.type === 'until_statement' ||
      parent.type === 'for_statement' ||
      parent.type === 'function_definition'
    ) {
      return true
    }
    if (parent.type === 'list' && parent.children.some((child) => child.text === '&&' || child.text === '||')) return true
    if (parent.type === 'program') return false
  }
  return false
}

function isPrecededByOperator(node: SyntaxNode, operator: string): boolean {
  const siblings = node.parent?.children ?? []
  const index = siblings.indexOf(node)
  return index > 0 && siblings[index - 1]?.text === operator
}

function verdictCommand(verdict: DangerousVerdict): string {
  return verdict.kind === 'dangerous' ? verdict.command : verdict.kind
}

function mergeNestedResult(nested: PolicyResult, state: State): void {
  if (nested.verdict !== undefined) fail(state, verdictCommand(nested.verdict))
  state.suppressUpstreamRmRf ||= nested.suppressUpstreamRmRf
  state.externalSafe &&= nested.externalSafe
}

function analyzeNestedSource(source: string, ctx: WorkspaceContext, state: State): void {
  const parsed = parseWorkspaceSource(source)
  for (const cwd of state.cwds) mergeNestedResult(analyzeWorkspaceParsed(parsed, ctx, cwd), state)
}

function replaceCwds(state: State, next: Set<string>): void {
  if (next.size <= MAX_CWD_STATES) {
    state.cwds = next
    return
  }
  fail(state, 'cwd state limit exceeded')
  state.cwds = new Set(Array.from(next).slice(0, MAX_CWD_STATES))
}

function checkInvocation(
  rawName: string,
  rawArgs: readonly string[],
  ctx: WorkspaceContext,
  state: State,
  invocationDropped: boolean,
  invocation: {
    rawArgTexts: readonly string[]
    hasHeredoc: boolean
    branchScoped: boolean
    precededByAnd: boolean
  },
): void {
  let name = rawName
  let args = rawArgs
  let dropped = invocationDropped

  let hops = 0
  for (; hops < 8; hops += 1) {
    if (PRIVILEGE_WRAPPERS.has(name)) {
      if (name === 'sudo') markSudoCwd(args, ctx, state)
      const rest = dropValueOptions(args, PRIVILEGE_VALUE_OPTIONS)
      if (rest.length === 0) return
      name = normalizeCommandName(rest[0]!)
      args = rest.slice(1)
      continue
    }
    if (LAUNCH_WRAPPERS.has(name)) {
      if (name === 'env') {
        markWrapperCwd(args, ctx, state)
        checkSensitiveAssignmentArgs(args, state)
      }
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

  if (
    hops >= 8 &&
    (PRIVILEGE_WRAPPERS.has(name) ||
      LAUNCH_WRAPPERS.has(name) ||
      name === 'busybox' ||
      COMMAND_WRAPPER_NAMES.has(name))
  ) {
    fail(state, 'wrapper nesting limit exceeded')
    return
  }

  if (NESTED_SHELLS.has(name)) {
    const nested = nestedShellCommand(args)
    if (nested.found) {
      if (nested.payload === undefined) {
        fail(state, 'shell: missing -c payload')
        return
      }
      analyzeNestedSource(nested.payload, ctx, state)
      return
    }
    if (shellReadsStdin(args)) {
      fail(state, 'shell executes script from stdin (-s)')
      return
    }
    const operands = positionalArgs(args, new Set())
    // `curl ... | sh`, `bash < script.sh`, `bash <<EOF`: a shell with no -c
    // payload and no script operand executes whatever arrives on stdin
    if (operands.length === 0) {
      fail(state, 'shell executes script from stdin (pipe/heredoc)')
      return
    }
    state.externalSafe = false
    checkScriptOperand(args, new Set(), dropped, ctx, state, name)
    return
  }
  if (name === 'eval') {
    if (args.length > 0) {
      analyzeNestedSource(args.join(' '), ctx, state)
    }
    return
  }

  if (!EXTERNAL_MODELED_COMMANDS.has(name)) state.externalSafe = false

  if (name === 'export' || name === 'declare' || name === 'typeset' || name === 'readonly') {
    checkSensitiveAssignmentArgs(args, state)
  }

  if (dropped && WRITE_COMMANDS.has(name)) {
    fail(state, `${name}: unresolvable operand on write command`)
    return
  }

  if (name === 'rm') {
    checkRm(args, ctx, state, invocation.precededByAnd)
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
    const positionals =
      name === 'rsync' ? positionalArgsAnywhere(args, RSYNC_VALUE_OPTIONS) : positionalArgs(args, new Set())
    const target = positionals.at(-1)
    if (target !== undefined) checkWriteTarget(target, ctx, state, name)
    return
  }
  if (name === 'tee' || name === 'truncate' || name === 'shred') {
    for (const target of positionalArgs(args, new Set())) checkWriteTarget(target, ctx, state, name)
    return
  }
  if (name === 'find') {
    if (dropped && invocation.rawArgTexts.some((text) => /[$`]/.test(text))) {
      fail(state, 'find: unresolvable action')
      return
    }
    if (args.some((arg) => FIND_DESTRUCTIVE_FLAGS.has(arg))) fail(state, 'find -delete/-exec')
    return
  }
  if (name === 'xargs') {
    if (dropped) {
      fail(state, 'xargs: unresolvable command')
      return
    }
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
      const next = new Set([ctx.homedir])
      if (invocation.branchScoped) for (const cwd of state.cwds) next.add(cwd)
      replaceCwds(state, next)
      if (!withinWorkspace(ctx.homedir, ctx.workspace)) state.externalCd = true
      return
    }
    const resolved = resolveTarget(target, ctx)
    if (resolved === undefined) {
      state.externalCd = true
      return
    }
    const next = new Set<string>()
    for (const cwd of state.cwds) {
      const destination = path.isAbsolute(resolved) ? resolved : path.resolve(cwd, resolved)
      next.add(destination)
      if (!withinWorkspace(destination, ctx.workspace)) state.externalCd = true
    }
    if (invocation.branchScoped) for (const cwd of state.cwds) next.add(cwd)
    replaceCwds(state, next)
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
    if (invocation.hasHeredoc) {
      fail(state, `${name} executes script from heredoc`)
      return
    }
    checkScriptOperand(args, SCRIPT_EXECUTORS[name] ?? new Set(), dropped, ctx, state, name)
    return
  }
  const scriptValueOptions = SCRIPT_EXECUTORS[name]
  if (scriptValueOptions !== undefined) {
    if (invocation.hasHeredoc) {
      fail(state, `${name} executes script from heredoc`)
      return
    }
    checkScriptOperand(args, scriptValueOptions, dropped, ctx, state, name)
    return
  }
  const remoteValueOptions = REMOTE_COMMANDS[name]
  if (remoteValueOptions !== undefined) {
    if (positionalArgs(args, remoteValueOptions).length > 0) {
      fail(state, `${name} remote execution/copy`)
    }
    return
  }
  if (name === 'awk' || name === 'gawk' || name === 'mawk') {
    // the program text usually contains $-expansions, so scan raw argument
    // text (which survives literal dropping) for unsafe program constructs
    if (invocation.rawArgTexts.some((text) => AWK_UNSAFE_PROGRAM.test(text))) {
      fail(state, 'awk program executes commands or writes files')
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
  let globalOrSystemConfig = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--global' || arg === '--system') globalOrSystemConfig = true
    if (arg === '--output') {
      const target = args[i + 1]
      if (target === undefined) fail(state, 'git: missing --output target')
      else checkWriteTarget(target, ctx, state, 'git --output')
    } else if (arg.startsWith('--output=')) {
      checkWriteTarget(arg.slice('--output='.length), ctx, state, 'git --output')
    }
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--') break
    if (arg.startsWith('-')) {
      if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
        const value = arg.slice(arg.indexOf('=') + 1)
        externalRepo ||= isExternalTargetFromAnyCwd(value, ctx, state.cwds)
        continue
      }
      if (/^-C.+/.test(arg)) {
        externalRepo ||= isExternalTargetFromAnyCwd(arg.slice(2), ctx, state.cwds)
        continue
      }
      if (arg.includes('=')) continue
      if (GIT_VALUE_FLAGS.has(arg)) {
        const value = args[i + 1]
        if (value === undefined) break
        if (arg !== '-c') externalRepo ||= isExternalTargetFromAnyCwd(value, ctx, state.cwds)
        i += 1
      }
      continue
    }
    subcommand = arg
    break
  }
  if (subcommand === 'config' && globalOrSystemConfig) fail(state, 'git config outside workspace')
  if (subcommand === 'credential' || subcommand === 'credential-store') fail(state, `git ${subcommand}`)
  if (subcommand === undefined || !GIT_READONLY_SUBCOMMANDS.has(subcommand)) state.externalSafe = false
  if (externalRepo && subcommand !== undefined && !GIT_READONLY_SUBCOMMANDS.has(subcommand)) {
    fail(state, `git ${subcommand} on external repository`)
  }
}

function checkRm(
  args: readonly string[],
  ctx: WorkspaceContext,
  state: State,
  precededByAnd: boolean,
): void {
  state.suppressUpstreamRmRf = true
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
    let rootCandidate = false
    let safeSubpathCandidate = false
    for (const cwd of state.cwds) {
      const absolute = path.isAbsolute(resolved) ? resolved : path.resolve(cwd, resolved)
      if (absolute === '/' || absolute === ctx.homedir || absolute === ctx.workspace) {
        rootCandidate = true
        continue
      }
      if (!withinWorkspace(absolute, ctx.workspace)) {
        fail(state, 'rm: outside workspace')
        break
      }
      safeSubpathCandidate = true
    }
    // For `cd sub && rm .`, the fallback workspace cwd only exists when the
    // cd failed, in which case rm is not executed. Keep root protection when
    // no successful in-workspace destination is possible or for `||` branches.
    if (rootCandidate && !(precededByAnd && safeSubpathCandidate)) {
      fail(state, 'rm: workspace/home root target')
    }
    if (!path.isAbsolute(resolved)) state.relativeWrite = true
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
  const inPlace = args.some(
    (arg) => arg === '--in-place' || arg.startsWith('--in-place=') || /^-[a-zA-Z]*i/.test(arg),
  )
  if (!inPlace) return
  const programOptions = new Set(['-e', '--expression', '-f', '--file'])
  const hasExplicitProgram = args.some(
    (arg) =>
      programOptions.has(arg) ||
      arg.startsWith('--expression=') ||
      arg.startsWith('--file=') ||
      /^-[ef].+/.test(arg),
  )
  const positionals = positionalArgsAnywhere(args, programOptions)
  const targets = hasExplicitProgram ? positionals : positionals.slice(1)
  for (const target of targets) checkWriteTarget(target, ctx, state, 'sed')
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
  for (const cwd of state.cwds) {
    const absolute = path.isAbsolute(resolved) ? resolved : path.resolve(cwd, resolved)
    if (!withinWorkspace(absolute, ctx.workspace)) {
      fail(state, `${command}: write outside workspace`)
      return
    }
  }
  if (!path.isAbsolute(resolved)) state.relativeWrite = true
}

function checkRedirects(root: SyntaxNode, ctx: WorkspaceContext, state: State): void {
  const stack: SyntaxNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === 'file_redirect') {
      checkRedirectNode(node, ctx, state)
    }
    for (const child of node.children) stack.push(child)
  }
}

function checkRedirectNode(node: SyntaxNode, ctx: WorkspaceContext, state: State): void {
  if (state.checkedRedirects.has(node)) return
  state.checkedRedirects.add(node)
  const operator = node.children.find((child) => !child.isNamed)?.text ?? ''
  const targetNode = node.children.find((child) => child.isNamed && child.type !== 'file_descriptor')
  if (!operator.includes('>') || targetNode === undefined) return
  const raw = redirectTargetText(targetNode)
  if (raw !== undefined) {
    if (!DEVICE_EXEMPT.has(raw)) checkWriteTarget(raw, ctx, state, 'redirect')
  } else {
    fail(state, 'redirect: unresolvable write target')
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

// Running a script that lives outside the workspace (or whose path cannot be
// resolved) is arbitrary code execution — escalate. '-' means stdin.
function checkScriptPath(
  raw: string | undefined,
  ctx: WorkspaceContext,
  state: State,
  command: string,
): void {
  if (raw === undefined) return
  if (raw === '-') {
    fail(state, `${command}: script from stdin`)
    return
  }
  for (const cwd of state.cwds) {
    const cls = classifyTarget(raw, ctx, cwd)
    if (cls === 'outside' || cls === 'unresolvable') {
      fail(state, `${command}: script outside workspace`)
      return
    }
  }
}

function shellReadsStdin(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--') return false
    if (!arg.startsWith('-') || arg === '-') return false
    if (/^-[a-zA-Z]+$/.test(arg) && arg.includes('s')) return true
  }
  return false
}

function commandInvocationLoose(
  node: SyntaxNode,
): {
  name: string
  args: string[]
  dropped: boolean
  rawArgTexts: string[]
  hasHeredoc: boolean
  branchScoped: boolean
  precededByAnd: boolean
} | undefined {
  const nameIndex = node.children.findIndex((child) => child.type === 'command_name')
  const nameNode = nameIndex >= 0 ? node.children[nameIndex] : undefined
  const nameWord = nameNode?.children.find((child) => child.isNamed)
  const rawName = nameWord === undefined ? undefined : nameWord.text
  if (rawName === undefined || rawName.length === 0) return undefined
  if (/[$`*?[\](){}]/.test(rawName)) return undefined
  const args: string[] = []
  const rawArgTexts: string[] = []
  let dropped = false
  let hasHeredoc = false
  for (const child of node.children.slice(nameIndex + 1)) {
    if (child.type === 'variable_assignment') continue
    if (child.type === 'heredoc_redirect') {
      hasHeredoc = true
      continue
    }
    rawArgTexts.push(child.text)
    const value = argText(child)
    if (value === undefined) {
      dropped = true
    } else if (value.length > 0) {
      args.push(value)
    }
  }
  return {
    name: normalizeCommandName(rawName),
    args,
    dropped,
    rawArgTexts,
    hasHeredoc,
    branchScoped: false,
    precededByAnd: false,
  }
}

function checkScriptOperand(
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
  dropped: boolean,
  ctx: WorkspaceContext,
  state: State,
  name: string,
): void {
  if (args.includes('-')) {
    fail(state, `${name}: script from stdin`)
    return
  }
  if (args.length === 0 && dropped) {
    fail(state, `${name}: unresolvable script operand`)
    return
  }
  checkScriptPath(positionalArgs(args, valueOptions)[0], ctx, state, name)
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

function positionalArgsAnywhere(args: readonly string[], valueOptions: ReadonlySet<string>): string[] {
  const out: string[] = []
  let options = true
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (options && arg === '--') {
      options = false
      continue
    }
    if (options && arg.startsWith('-') && arg !== '-') {
      if (!arg.includes('=') && valueOptions.has(arg)) i += 1
      continue
    }
    out.push(arg)
  }
  return out
}

function markWrapperCwd(args: readonly string[], ctx: WorkspaceContext, state: State): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    let target: string | undefined
    if (arg === '-C' || arg === '--chdir') {
      target = args[i + 1]
    } else if (arg.startsWith('--chdir=')) {
      target = arg.slice('--chdir='.length)
    } else if (/^-C.+/.test(arg)) {
      target = arg.slice(2)
    }
    if (target !== undefined) {
      const cls = classifyTarget(target, ctx)
      // The wrapper-local cwd would otherwise have to be threaded through all
      // nested command handlers. Until the command IR models that explicitly,
      // fail closed instead of treating relative inner paths as workspace paths.
      if (cls === 'outside' || cls === 'unresolvable') fail(state, 'env: chdir outside workspace')
      return
    }
  }
}

function markSudoCwd(args: readonly string[], ctx: WorkspaceContext, state: State): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    let target: string | undefined
    if (arg === '-D' || arg === '--chdir') {
      target = args[i + 1]
    } else if (arg.startsWith('--chdir=')) {
      target = arg.slice('--chdir='.length)
    } else if (/^-D.+/.test(arg)) {
      target = arg.slice(2)
    }
    if (target !== undefined) {
      const cls = classifyTarget(target, ctx)
      if (cls === 'outside' || cls === 'unresolvable') fail(state, 'sudo: chdir outside workspace')
      return
    }
  }
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

function classifyTarget(raw: string, ctx: WorkspaceContext, cwd = ctx.workspace): TargetClass {
  const resolved = resolveTarget(raw, ctx)
  if (resolved === undefined) return 'unresolvable'
  if (path.isAbsolute(resolved)) return withinWorkspace(resolved, ctx.workspace) ? 'inside' : 'outside'
  if (!withinWorkspace(path.resolve(cwd, resolved), ctx.workspace)) return 'outside'
  return 'relative'
}

// Relative targets resolve against the current abstract cwd.
function isExternalTarget(raw: string, ctx: WorkspaceContext, cwd = ctx.workspace): boolean {
  const cls = classifyTarget(raw, ctx, cwd)
  return cls === 'outside' || cls === 'unresolvable'
}

function isExternalTargetFromAnyCwd(
  raw: string,
  ctx: WorkspaceContext,
  cwds: ReadonlySet<string>,
): boolean {
  for (const cwd of cwds) {
    if (isExternalTarget(raw, ctx, cwd)) return true
  }
  return false
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
