// Workspace path policy — our own rules, NOT part of the upstream port.
//
// Principle:
//   - recognized commands may read anywhere
//   - recognized writes may target only the workspace
//   - unknown commands/effects require confirmation
//
// Enforced over the bash syntax tree: write-command targets, write-redirect
// targets, inline-code interpreters, find/xargs escape hatches, and the
// cd-then-relative-write combo. `.git` is always a write-forbidden zone.
// Anything relevant to execution or writes that is unresolvable fails safe.

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
  readonly externalEffectsModeled: boolean
  /** The entire command line is covered by positive Bash trust rules. */
  readonly commandTrusted: boolean
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
  'ls',
  'printf',
  'pushd',
  'pwd',
  'readlink',
  'realpath',
  'rg',
  'ripgrep',
  'sed',
  'stat',
  'strings',
  'tail',
  'test',
  'touch',
  'uniq',
  'wc',
  'which',
])

// Commands in these sets are positively recognized by the Bash gate. This is
// deliberately an allowlist: a literal command name that is absent here stays
// with the human even when neither analyzer found a concrete dangerous effect.
const READ_ONLY_COMMANDS = new Set([
  'cat',
  'cmp',
  'cut',
  'df',
  'diff',
  'du',
  'echo',
  'egrep',
  'false',
  'fgrep',
  'file',
  'grep',
  'head',
  'ls',
  'printf',
  'pwd',
  'readlink',
  'realpath',
  'stat',
  'strings',
  'tail',
  'test',
  'true',
  'uniq',
  'wc',
  'which',
  ':',
  '[',
])

// Explicit trust boundary retained for developer workflows. These tools can
// execute workspace-controlled hooks/configuration; their internals are not
// inspected. Keep the list finite so a typo or custom CLI does not fail open.
const TRUSTED_DEVELOPMENT_COMMANDS = new Set([
  'biome',
  'bun',
  'cargo',
  'cmake',
  'deno',
  'eslint',
  'go',
  'jest',
  'make',
  'ninja',
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'prettier',
  'pytest',
  'rustc',
  'tsc',
  'vitest',
  'yarn',
])

const TRUSTED_SYSTEM_EXECUTABLE_DIRS = new Set(['/bin', '/sbin', '/usr/bin', '/usr/sbin'])

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

// xargs appends data-derived operands after the static command line. Most
// read-only commands remain read-only under extra operands, but `file` can
// reinterpret an appended `--compile` as a write/exec-capable option.
const XARGS_APPEND_SAFE_COMMANDS = new Set(
  Array.from(READ_ONLY_COMMANDS).filter((command) => command !== 'file'),
)

// These operations can destroy the workspace root or mutate its metadata.
// Content-producing commands such as cp/install/rsync may still target `.`:
// their effect is to create entries inside the workspace, not replace it.
const WORKSPACE_ROOT_FORBIDDEN_WRITES = new Set([
  'chmod',
  'chown',
  'install -d',
  'rmdir',
  'shred',
  'touch',
  'truncate',
])

const INLINE_CODE_INTERPRETERS: Readonly<Record<string, readonly (string | RegExp)[]>> = {
  python: ['-c', /^-c.+/],
  python3: ['-c', /^-c.+/],
  node: ['-e', '-p', '--eval', '--print', /^-[ep].+/, /^--(?:eval|print)=/],
  ruby: ['-e', /^-[a-zA-Z]*e(?:.+)?$/],
  perl: ['-e', /^-[a-zA-Z]*e(?:.+)?$/],
  php: ['-r', /^-[a-zA-Z]*r(?:.+)?$/],
}

interface ScriptExecutorRule {
  /** Options that consume the following token while locating the main script. */
  readonly valueOptions: ReadonlySet<string>
  /** Leading options whose command-line effects are understood. */
  readonly safeOptions: readonly (string | RegExp)[]
  /** Options whose value names another file/module that may execute code. */
  readonly loadedPathOptions?: ReadonlySet<string>
  /** Preload options that accept either an explicit path or an opaque module name. */
  readonly moduleLoadOptions?: ReadonlySet<string>
  /** Options that add one or more directories to an interpreter's code search path. */
  readonly searchPathOptions?: ReadonlySet<string>
  /** Options whose value is the main script rather than a normal option value. */
  readonly scriptPathOptions?: ReadonlySet<string>
  /** Recognized value options whose effects are intentionally not auto-approved. */
  readonly unsafeOptions?: ReadonlySet<string>
  /** Options such as Python -m whose value is the execution target, not a file. */
  readonly nonFileTargetOptions?: ReadonlySet<string>
  /** Options that safely terminate or discover workspace inputs without a file. */
  readonly optionalScriptOptions?: ReadonlySet<string>
  /** Commands such as source simply fail when their required operand is absent. */
  readonly allowMissingScript?: boolean
}

// Unknown interpreter options fail closed. This prevents a value consumed by
// the interpreter from being mistaken for the main script and hiding a later
// external script operand.
const SCRIPT_EXECUTORS: Readonly<Record<string, ScriptExecutorRule>> = {
  python: {
    valueOptions: new Set(['-m', '-W', '-X', '--check-hash-based-pycs']),
    safeOptions: [
      /^-[bBdEhiIOPqRsSuvV]+$/,
      /^-O{1,2}$/,
      /^-W.+/,
      '--bytes-warning', '--help', '--ignore-environment', '--isolated', '--no-site', '--no-user-site',
      '--optimize', '--quiet', '--unbuffered', '--verbose', '--version',
    ],
    unsafeOptions: new Set(['-X']),
    nonFileTargetOptions: new Set(['-m']),
    optionalScriptOptions: new Set(['--help', '--version']),
  },
  python3: {
    valueOptions: new Set(['-m', '-W', '-X', '--check-hash-based-pycs']),
    safeOptions: [
      /^-[bBdEhiIOPqRsSuvV]+$/,
      /^-O{1,2}$/,
      /^-W.+/,
      '--bytes-warning', '--help', '--ignore-environment', '--isolated', '--no-site', '--no-user-site',
      '--optimize', '--quiet', '--unbuffered', '--verbose', '--version',
    ],
    unsafeOptions: new Set(['-X']),
    nonFileTargetOptions: new Set(['-m']),
    optionalScriptOptions: new Set(['--help', '--version']),
  },
  node: {
    valueOptions: new Set([
      '-r', '--require', '--import', '--loader', '--experimental-loader', '--input-type', '--conditions',
    ]),
    safeOptions: [
      /^-[hv]+$/,
      '--check', '--help', '--no-warnings', '--test', '--test-only', '--version', '--watch',
      /^--(?:conditions|input-type)=/,
      /^--(?:experimental-loader|import|loader|require)=/,
      /^-r.+/,
    ],
    moduleLoadOptions: new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']),
    optionalScriptOptions: new Set(['--help', '--test', '--version']),
  },
  ruby: {
    valueOptions: new Set(['-C', '-E', '-F', '-I', '-K', '-r', '--chdir', '--encoding', '--require']),
    safeOptions: [/^-[acdhlnpsvwy]+$/, /^-[EIFKIr].+/, '--copyright', '--disable', '--enable', '--version'],
    moduleLoadOptions: new Set(['-r', '--require']),
    searchPathOptions: new Set(['-I']),
    unsafeOptions: new Set(['-C', '--chdir']),
    optionalScriptOptions: new Set(['--copyright', '--version']),
  },
  perl: {
    valueOptions: new Set(['-0', '-F', '-I', '-x']),
    safeOptions: [/^-[acdhnpsTtuUvVwW]+$/, /^-[0FI].+/, '--help', '--version'],
    unsafeOptions: new Set(['-x']),
    searchPathOptions: new Set(['-I']),
    optionalScriptOptions: new Set(['--help', '--version']),
  },
  php: {
    valueOptions: new Set(['-c', '-d', '-f', '--file']),
    safeOptions: [/^-[ahnqsvw]+$/, /^-c.+/, /^-d.+/, '--file', '--help', '--info', '--no-php-ini', '--version'],
    loadedPathOptions: new Set(['-c']),
    scriptPathOptions: new Set(['-f', '--file']),
    unsafeOptions: new Set(['-d']),
    optionalScriptOptions: new Set(['--help', '--info', '--version']),
  },
  source: { valueOptions: new Set(), safeOptions: [], allowMissingScript: true },
  '.': { valueOptions: new Set(), safeOptions: [], allowMissingScript: true },
}

const SHELL_SCRIPT_OPTIONS: ScriptExecutorRule = {
  valueOptions: new Set(['-O', '+O', '-o', '--rcfile', '--init-file']),
  safeOptions: [/^[-+][a-zA-Z]+$/, '--noprofile', '--norc', '--posix', '--restricted', '--verbose', '--version'],
  loadedPathOptions: new Set(['--rcfile', '--init-file']),
  optionalScriptOptions: new Set(['--version']),
}

const MODELED_BASH_COMMANDS = new Set([
  ...READ_ONLY_COMMANDS,
  ...WRITE_COMMANDS,
  ...TRUSTED_DEVELOPMENT_COMMANDS,
  ...Object.keys(SCRIPT_EXECUTORS),
  'awk',
  'cd',
  'declare',
  'eval',
  'export',
  'find',
  'gawk',
  'git',
  'mawk',
  'pushd',
  'readonly',
  'rg',
  'ripgrep',
  'typeset',
  'xargs',
])

// remote-execution / remote-copy commands: any operand escalates
const REMOTE_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  ssh: new Set(['-p', '-i', '-l', '-o', '-b', '-e', '-w', '-W', '-L', '-R', '-D', '-J', '-S']),
  scp: new Set(['-P', '-i', '-o', '-F', '-l', '-d' ]),
  sftp: new Set(['-P', '-i', '-o', '-b']),
}

// awk programs can execute commands or write files from inside the program
const AWK_UNSAFE_PROGRAM = /system\s*\(|>{1,2}|\|\s*['"]/
const SED_SIDE_EFFECT_COMMAND =
  /(?:^|[;}\n])\s*(?:(?:[0-9]+|\$|\/(?:\\.|[^/])*\/)(?:,(?:[0-9]+|\$|\/(?:\\.|[^/])*\/))?)?\s*[eEwW](?:\s|$)|s(.).*?\1.*?\1[a-zA-Z]*[ewW]/

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
const FIND_OUTPUT_FLAGS = new Set(['-fls', '-fprint', '-fprint0', '-fprintf'])

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

const GIT_TRUSTED_LOCAL_SUBCOMMANDS = new Set([
  ...GIT_READONLY_SUBCOMMANDS,
  'add',
  'branch',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'init',
  'merge',
  'mv',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'switch',
  'tag',
])

const RSYNC_WRITE_PATH_OPTIONS = new Set([
  '--backup-dir',
  '--log-file',
  '--partial-dir',
  '--temp-dir',
  '--write-batch',
])

// git global flags that consume the next argument as a value
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const GIT_INIT_VALUE_OPTIONS = new Set([
  '-b',
  '--initial-branch',
  '--object-format',
  '--ref-format',
  '--separate-git-dir',
  '--template',
])

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
  '--partial-dir',
  '--port',
  '--rsync-path',
  '--suffix',
  '--temp-dir',
  '--timeout',
  '--usermap',
  '--write-batch',
])

type TargetClass = 'inside' | 'outside' | 'relative' | 'unresolvable'
type ExecutableTrust = 'named' | 'system' | 'workspace' | 'untrusted-path'

export function analyzeWorkspacePolicy(source: string, ctx: WorkspaceContext): PolicyResult {
  try {
    return analyzeTree(source, ctx)
  } catch {
    return {
      verdict: { kind: 'unanalyzable' },
      suppressUpstreamRmRf: false,
      externalEffectsModeled: false,
      commandTrusted: false,
    }
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
    return {
      verdict: { kind: 'unanalyzable' },
      suppressUpstreamRmRf: false,
      externalEffectsModeled: false,
      commandTrusted: false,
    }
  }

  const state = {
    dangerous: undefined as DangerousVerdict | undefined,
    suppressUpstreamRmRf: false,
    relativeWrite: false,
    externalCd: false,
    cwds: new Set([initialCwd]),
    externalEffectsModeled: true,
    commandTrusted: true,
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
    externalEffectsModeled: state.externalEffectsModeled,
    commandTrusted: state.commandTrusted,
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
  checkInvocation(invocation.executable, invocation.args, ctx, state, invocation.dropped, invocation)
}

interface State {
  dangerous: DangerousVerdict | undefined
  suppressUpstreamRmRf: boolean
  relativeWrite: boolean
  externalCd: boolean
  cwds: Set<string>
  externalEffectsModeled: boolean
  commandTrusted: boolean
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
      state.externalEffectsModeled = false
      state.commandTrusted = false
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
    if (match?.[1] !== undefined) {
      state.externalEffectsModeled = false
      state.commandTrusted = false
      if (SENSITIVE_ENV_ASSIGNMENTS.has(match[1])) {
        fail(state, `sensitive environment assignment: ${match[1]}`)
      }
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
  state.externalEffectsModeled &&= nested.externalEffectsModeled
  state.commandTrusted &&= nested.commandTrusted
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
  rawExecutable: string,
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
  let executable = rawExecutable
  let name = normalizeCommandName(executable)
  let args = rawArgs
  let dropped = invocationDropped

  let hops = 0
  for (; hops < 8; hops += 1) {
    const executableTrust = classifyExecutable(executable, ctx, state.cwds)
    if (executableTrust === 'workspace') {
      // Deliberate trust boundary: the command line is known to invoke a
      // workspace-local executable, but its contents are not inspected.
      state.externalEffectsModeled = false
      return
    }
    if (executableTrust === 'untrusted-path') state.commandTrusted = false

    if (PRIVILEGE_WRAPPERS.has(name)) {
      if (name === 'sudo') markSudoCwd(args, ctx, state)
      const rest = dropValueOptions(args, PRIVILEGE_VALUE_OPTIONS)
      if (rest.length === 0) {
        state.commandTrusted = false
        return
      }
      executable = rest[0]!
      name = normalizeCommandName(executable)
      args = rest.slice(1)
      continue
    }
    if (LAUNCH_WRAPPERS.has(name)) {
      if (name === 'command' && isCommandQuery(args)) return
      if (name === 'env') {
        markWrapperCwd(args, ctx, state)
        checkSensitiveAssignmentArgs(args, state)
      }
      const rest = dropLaunchWrapperOperands(name, args)
      if (rest.length === 0) {
        state.commandTrusted = false
        return
      }
      executable = rest[0]!
      name = normalizeCommandName(executable)
      args = rest.slice(1)
      continue
    }
    if (name === 'busybox') {
      if (args.length === 0 || args[0]!.startsWith('-')) {
        state.commandTrusted = false
        return
      }
      executable = args[0]!
      name = normalizeCommandName(args[0]!)
      args = args.slice(1)
      continue
    }
    if (COMMAND_WRAPPER_NAMES.has(name)) {
      const rest = commandWrapperOperands(name, args)
      if (rest.length === 0) {
        state.commandTrusted = false
        return
      }
      executable = rest[0]!
      name = normalizeCommandName(executable)
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
    state.externalEffectsModeled = false
    checkScriptOperand(args, SHELL_SCRIPT_OPTIONS, dropped, ctx, state, name)
    return
  }
  if (name === 'eval') {
    if (args.length > 0) {
      analyzeNestedSource(args.join(' '), ctx, state)
    }
    return
  }

  if (!MODELED_BASH_COMMANDS.has(name)) state.commandTrusted = false
  if (!EXTERNAL_MODELED_COMMANDS.has(name)) state.externalEffectsModeled = false

  if (name === 'export' || name === 'declare' || name === 'typeset' || name === 'readonly') {
    checkSensitiveAssignmentArgs(args, state)
  }

  if (name === 'printf' && args.some((arg) => arg === '-v' || /^-v.+/.test(arg))) {
    fail(state, 'printf -v mutates a shell variable')
    return
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
    if (
      name === 'install' &&
      args.some(
        (arg) =>
          arg === '-s' ||
          arg === '--strip' ||
          arg === '--strip-program' ||
          arg.startsWith('--strip-program='),
      )
    ) {
      fail(state, 'install --strip-program executes an external command')
      return
    }
    if (name === 'install' && args.some((arg) => arg === '--directory' || /^-[^-]*d/.test(arg))) {
      for (const target of positionalArgsAnywhere(args, INSTALL_VALUE_OPTIONS)) {
        checkWriteTarget(target, ctx, state, 'install -d')
      }
      return
    }
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
    if (dropped) state.commandTrusted = false
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
  if (name === 'ln') {
    checkCopyMove(args, COPY_MOVE_VALUE_OPTIONS, ctx, state, name)
    return
  }
  if (name === 'rsync') {
    checkRsyncOptions(args, ctx, state)
    const positionals = positionalArgsAnywhere(args, RSYNC_VALUE_OPTIONS)
    const target = positionals.at(-1)
    if (target !== undefined) {
      if (positionals.some((operand) => /^[^/]+:/.test(operand) || operand.startsWith('rsync://'))) {
        fail(state, 'rsync: remote source or destination')
      } else {
        checkWriteTarget(target, ctx, state, name)
      }
    }
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
    for (let i = 0; i < args.length; i += 1) {
      const flag = args[i]!
      if (!FIND_OUTPUT_FLAGS.has(flag)) continue
      const target = args[i + 1]
      if (target === undefined) fail(state, `find ${flag}: missing output target`)
      else checkWriteTarget(target, ctx, state, `find ${flag}`)
    }
    return
  }
  if (name === 'xargs') {
    if (dropped) {
      fail(state, 'xargs: unresolvable command')
      return
    }
    const operands = positionalArgs(args, XARGS_VALUE_OPTIONS)
    for (const operand of operands) {
      if (XARGS_BLOCKED_OPERANDS.has(normalizeCommandName(operand))) {
        fail(state, 'xargs invokes a write-capable command')
        return
      }
    }
    const executable = operands[0]
    if (executable !== undefined) {
      const executableTrust = classifyExecutable(executable, ctx, state.cwds)
      if (executableTrust === 'workspace') {
        state.externalEffectsModeled = false
      } else if (
        executableTrust === 'untrusted-path' ||
        !XARGS_APPEND_SAFE_COMMANDS.has(normalizeCommandName(executable))
      ) {
        state.commandTrusted = false
      }
    }
    return
  }
  if (name === 'cd' || name === 'pushd') {
    const target = positionalArgs(args, new Set())[0]
    if (target === undefined) {
      if (dropped) {
        fail(state, `${name}: unresolvable target`)
        return
      }
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
    checkScriptOperand(
      args,
      SCRIPT_EXECUTORS[name] ?? { valueOptions: new Set(), safeOptions: [] },
      dropped,
      ctx,
      state,
      name,
    )
    return
  }
  const scriptRule = SCRIPT_EXECUTORS[name]
  if (scriptRule !== undefined) {
    if (invocation.hasHeredoc) {
      fail(state, `${name} executes script from heredoc`)
      return
    }
    checkScriptOperand(args, scriptRule, dropped, ctx, state, name)
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
    if (invocation.rawArgTexts.some((text) => /^\s*\$[{A-Za-z_]/.test(text) || text.includes('`'))) {
      state.commandTrusted = false
    }
    return
  }
  if (name === 'rg' || name === 'ripgrep') {
    if (
      args.some(
        (arg) =>
          arg === '--pre' ||
          arg.startsWith('--pre=') ||
          arg === '--hostname-bin' ||
          arg.startsWith('--hostname-bin='),
      )
    ) {
      fail(state, `${name}: option executes an external command`)
    }
    return
  }
  if (name === 'file') {
    if (args.some((arg) => /^-[^-]*C/.test(arg) || arg === '--compile')) fail(state, 'file --compile writes output')
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
    const attachedTarget = /^-[a-zA-Z]*t(.+)$/.exec(arg)?.[1]
    if (attachedTarget !== undefined) {
      checkWriteTarget(attachedTarget, ctx, state, command)
      return
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

function checkRsyncOptions(args: readonly string[], ctx: WorkspaceContext, state: State): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (
      arg === '-e' ||
      /^-e.+/.test(arg) ||
      arg === '--rsh' ||
      arg.startsWith('--rsh=') ||
      arg === '--rsync-path' ||
      arg.startsWith('--rsync-path=')
    ) {
      fail(state, 'rsync: remote shell')
      return
    }
    if (arg === '--remove-source-files') {
      fail(state, 'rsync: removes source files')
      return
    }
    const equals = arg.indexOf('=')
    const option = equals >= 0 ? arg.slice(0, equals) : arg
    if (!RSYNC_WRITE_PATH_OPTIONS.has(option)) continue
    const target = equals >= 0 ? arg.slice(equals + 1) : args[i + 1]
    if (target === undefined || target.length === 0) fail(state, `rsync ${option}: missing write target`)
    else checkWriteTarget(target, ctx, state, `rsync ${option}`)
  }
}

// `git -C <dir>` (and --git-dir/--work-tree) makes git operate on another
// repository: read-only subcommands are fine there, everything else escalates.
// In-workspace git commands are always allowed — git's own .git bookkeeping is
// the recoverable path; the `.git` path rule only gates direct file access.
function checkGit(args: readonly string[], ctx: WorkspaceContext, state: State): void {
  let externalRepo = false
  let subcommand: string | undefined
  let subcommandIndex = -1
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
    } else if (arg === '--separate-git-dir') {
      const target = args[i + 1]
      if (target === undefined) fail(state, 'git: missing --separate-git-dir target')
      else checkWriteTarget(target, ctx, state, 'git --separate-git-dir')
    } else if (arg.startsWith('--separate-git-dir=')) {
      checkWriteTarget(arg.slice('--separate-git-dir='.length), ctx, state, 'git --separate-git-dir')
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
        if (arg === '-c') state.commandTrusted = false
        else externalRepo ||= isExternalTargetFromAnyCwd(value, ctx, state.cwds)
        i += 1
      }
      continue
    }
    subcommand = arg
    subcommandIndex = i
    break
  }
  if (subcommand === 'config' && globalOrSystemConfig) fail(state, 'git config outside workspace')
  if (subcommand === 'credential' || subcommand === 'credential-store') fail(state, `git ${subcommand}`)
  if (subcommand === 'init') {
    const target = positionalArgs(args.slice(subcommandIndex + 1), GIT_INIT_VALUE_OPTIONS)[0]
    if (target !== undefined) checkWriteTarget(target, ctx, state, 'git init')
  }
  if (subcommand !== undefined && !GIT_TRUSTED_LOCAL_SUBCOMMANDS.has(subcommand)) state.commandTrusted = false
  if (subcommand === undefined || !GIT_READONLY_SUBCOMMANDS.has(subcommand)) state.externalEffectsModeled = false
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
  const programOptions = new Set(['-e', '--expression', '-f', '--file'])
  const programs: string[] = []
  let hasProgramFile = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '-f' || arg === '--file' || arg.startsWith('--file=') || /^-f.+/.test(arg)) {
      hasProgramFile = true
    }
    if (arg === '-e' || arg === '--expression') {
      const program = args[i + 1]
      if (program !== undefined) programs.push(program)
    } else if (arg.startsWith('--expression=')) {
      programs.push(arg.slice('--expression='.length))
    } else if (/^-e.+/.test(arg)) {
      programs.push(arg.slice(2))
    }
  }
  const positionals = positionalArgsAnywhere(args, programOptions)
  if (programs.length === 0 && !hasProgramFile && positionals[0] !== undefined) programs.push(positionals[0])
  if (hasProgramFile) state.commandTrusted = false
  if (programs.some((program) => SED_SIDE_EFFECT_COMMAND.test(program))) {
    fail(state, 'sed program has an unmodeled exec/write command')
    return
  }

  const inPlace = args.some(
    (arg) => arg === '--in-place' || arg.startsWith('--in-place=') || /^-[a-zA-Z]*i/.test(arg),
  )
  if (!inPlace) return
  const hasExplicitProgram = args.some(
    (arg) =>
      programOptions.has(arg) ||
      arg.startsWith('--expression=') ||
      arg.startsWith('--file=') ||
      /^-[ef].+/.test(arg),
  )
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
    if (absolute === path.normalize(ctx.workspace) && WORKSPACE_ROOT_FORBIDDEN_WRITES.has(command)) {
      fail(state, `${command}: workspace root target`)
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

function isCommandQuery(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--' || arg === '-' || !arg.startsWith('-')) return false
    if (/[vV]/.test(arg)) return true
  }
  return false
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
  executable: string
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
    executable: rawName,
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
  rule: ScriptExecutorRule,
  dropped: boolean,
  ctx: WorkspaceContext,
  state: State,
  name: string,
): void {
  if (args.includes('-')) {
    fail(state, `${name}: script from stdin`)
    return
  }
  const optionResult = checkInterpreterOptions(args, rule, ctx, state, name)
  const script =
    optionResult.explicitScript ??
    (optionResult.hasNonFileTarget ? undefined : positionalArgs(args, rule.valueOptions)[0])
  if (
    script === undefined &&
    !optionResult.hasNonFileTarget &&
    !optionResult.mayOmitScript &&
    rule.allowMissingScript !== true
  ) {
    fail(state, dropped ? `${name}: unresolvable script operand` : `${name}: script from stdin`)
    return
  }
  checkScriptPath(script, ctx, state, name)
}

function checkInterpreterOptions(
  args: readonly string[],
  rule: ScriptExecutorRule,
  ctx: WorkspaceContext,
  state: State,
  command: string,
): { explicitScript: string | undefined; hasNonFileTarget: boolean; mayOmitScript: boolean } {
  let explicitScript: string | undefined
  let hasNonFileTarget = false
  let mayOmitScript = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--' || arg === '-' || !arg.startsWith('-')) break

    let option = arg
    let value: string | undefined
    const equals = arg.indexOf('=')
    if (equals > 0) {
      option = arg.slice(0, equals)
      value = arg.slice(equals + 1)
    } else {
      const attached = Array.from(rule.valueOptions).find(
        (candidate) =>
          candidate.startsWith('-') &&
          !candidate.startsWith('--') &&
          arg.startsWith(candidate) &&
          arg !== candidate,
      )
      if (attached !== undefined) {
        option = attached
        value = arg.slice(attached.length)
      } else if (rule.valueOptions.has(arg)) {
        value = args[i + 1]
        i += 1
      }
    }

    if (rule.unsafeOptions?.has(option) === true) state.commandTrusted = false
    if (rule.loadedPathOptions?.has(option) === true) checkScriptPath(value, ctx, state, `${command} ${option}`)
    if (rule.moduleLoadOptions?.has(option) === true) {
      checkScriptPath(value, ctx, state, `${command} ${option}`)
      if (value !== undefined && !isExplicitScriptPath(value)) state.commandTrusted = false
    }
    if (rule.searchPathOptions?.has(option) === true && value !== undefined) {
      for (const entry of value.split(path.delimiter)) {
        if (entry.length > 0) checkScriptPath(entry, ctx, state, `${command} ${option}`)
      }
    }
    if (rule.scriptPathOptions?.has(option) === true) explicitScript = value
    if (rule.nonFileTargetOptions?.has(option) === true) hasNonFileTarget = true
    if (rule.optionalScriptOptions?.has(option) === true) mayOmitScript = true

    const recognized =
      rule.valueOptions.has(option) ||
      rule.safeOptions.some((pattern) => (typeof pattern === 'string' ? arg === pattern : pattern.test(arg)))
    if (!recognized) state.commandTrusted = false
  }
  return { explicitScript, hasNonFileTarget, mayOmitScript }
}

function isExplicitScriptPath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('~/')
  )
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

function classifyExecutable(
  raw: string,
  ctx: WorkspaceContext,
  cwds: ReadonlySet<string>,
): ExecutableTrust {
  if (!raw.includes('/') && !raw.includes('\\')) return 'named'
  const portable = raw.replaceAll('\\', '/')
  if (path.isAbsolute(portable) && TRUSTED_SYSTEM_EXECUTABLE_DIRS.has(path.dirname(path.normalize(portable)))) {
    return 'system'
  }
  const resolved = resolveTarget(portable, ctx)
  if (resolved === undefined) return 'untrusted-path'
  for (const cwd of cwds) {
    const absolute = path.isAbsolute(resolved) ? resolved : path.resolve(cwd, resolved)
    if (!withinWorkspace(absolute, ctx.workspace)) return 'untrusted-path'
  }
  return 'workspace'
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
