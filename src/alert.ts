import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export type AlertConfig = {
  /** true plays the default sound; a string is used as a sound file path. */
  readonly sound: boolean | string
  /** Tint the owning frontend's tab chrome until replied. */
  readonly mark: boolean
}

const DEBOUNCE_MS = 2000
const DEFAULT_SOUND = "/System/Library/Sounds/Funk.aiff"
const LINUX_SOUNDS = [
  "/usr/share/sounds/freedesktop/stereo/complete.oga",
  "/usr/share/sounds/freedesktop/stereo/bell.oga",
  "/usr/share/sounds/alsa/Front_Center.wav",
]

// iTerm2 tab-chrome tint (OSC 6;1;bg). The mark is color-only: no title
// writes means nothing to save or restore (and no stale-title damage), and
// no blink timers means nothing can outlive the plugin instance that
// painted. The clear is the matching default-color reset.
const TINT_MARK =
  "\x1b]6;1;bg;red;brightness;255\x07" +
  "\x1b]6;1;bg;green;brightness;59\x07" +
  "\x1b]6;1;bg;blue;brightness;48\x07"
const TINT_CLEAR = "\x1b]6;1;bg;*;default\x07"

/**
 * Mark state shared across plugin module copies. The engine instantiates
 * the plugin repeatedly (per location boot, per watcher-triggered reload)
 * and every instantiation re-evaluates this module, so plain module-level
 * state would be per copy: the copy whose evaluate hook fired the mark is
 * routinely unloaded before permission.replied arrives, and the fresh copy
 * seeing the event finds no mark to clear — the tint would stay forever.
 * A Symbol.for key on globalThis gives every copy one shared view of the
 * mark, so whichever copy sees the reply clears it.
 */
type AlertState = {
  lastFiredAt: number
  marked: boolean
  // TTYs the mark actually landed on; undefined until delivery and after
  // clear.
  markedTtys: string[] | undefined
  // Monotonic state-change counter: a delivery landing after a newer
  // change (e.g. a mark landing after the reply already cleared it) is
  // dropped.
  paintGeneration: number
}

const state: AlertState = ((globalThis as Record<symbol, AlertState>)[
  Symbol.for("opencode-bash-sentinel/alert-state")
] ??= {
  lastFiredAt: 0,
  marked: false,
  markedTtys: undefined,
  paintGeneration: 0,
})

export function parseAlertOption(raw: unknown): AlertConfig | undefined {
  if (raw === true) return { sound: true, mark: true }
  if (typeof raw !== "object" || raw === null) return undefined
  const options = raw as Record<string, unknown>
  const sound = options.sound
  // Malformed field values disable that channel only, never the other.
  return {
    sound:
      sound === true || (typeof sound === "string" && sound.length > 0)
        ? (sound as boolean | string)
        : false,
    mark: options.mark === true,
  }
}

/**
 * Fire-and-forget attention signal for escalations; must never block or
 * fail the approval flow. Rapid escalations are debounced into one signal.
 * The optional owner directory targets the mark: only frontends launched
 * in that directory are tinted, so with one window per project only the
 * asking window is marked.
 */
export function fireAlert(config: AlertConfig | undefined, ownerDir?: string): void {
  if (!config) return
  const now = Date.now()
  if (now - state.lastFiredAt < DEBOUNCE_MS) return
  state.lastFiredAt = now
  if (config.sound !== false) playSound(config.sound)
  if (config.mark) {
    // Marked from request time: a reply racing the in-flight delivery must
    // still clear (and cancel) the mark instead of leaving it painted.
    state.marked = true
    withFrontendTtys(paintMark, ownerDir === undefined ? undefined : path.normalize(ownerDir))
  }
}

/** Clear a previously set mark once the permission has been replied. */
export function clearAlert(config: AlertConfig | undefined): void {
  if (!config?.mark || !state.marked) return
  state.marked = false
  state.paintGeneration++ // cancel any mark delivery still in flight
  const ttys = state.markedTtys
  state.markedTtys = undefined
  // Repaint exactly the targets the mark landed on — synchronously, so a
  // concurrent re-mark cannot interleave and a frontend started after the
  // mark is not touched. A cancelled in-flight mark painted nothing, so
  // there is nothing to clear.
  if (ttys !== undefined) paintClear(ttys)
}

/** Synchronous mark painting on resolved targets; exported for tests. */
export function paintMark(ttys: string[]): void {
  state.marked = true
  // First delivery of a mark cycle owns the target set; a re-mark unions
  // its targets into the cycle so every painted TTY is cleared.
  const previous = state.markedTtys
  state.markedTtys = previous === undefined ? [...ttys] : [...new Set([...previous, ...ttys])]
  writeAll(devicePaths(state.markedTtys), TINT_MARK)
}

/** Synchronous clear painting; exported for tests. */
export function paintClear(ttys: string[]): void {
  writeAll(devicePaths(ttys), TINT_CLEAR)
}

function devicePaths(ttys: string[]): string[] {
  return ttys.length ? ttys.map((tty) => `/dev/${tty}`) : ["/dev/tty"]
}

function writeAll(targets: string[], data: string): void {
  for (const target of targets) writeTo(target, data)
}

function writeTo(target: string, data: string): void {
  try {
    const fd = fs.openSync(target, "w")
    try {
      fs.writeSync(fd, data)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // Without a writable target the channel degrades to a no-op.
  }
}

/**
 * Deliver the mark to the TTYs of running opencode frontends. Since the
 * v2 host (ADR-0006) runs the plugin inside the serve daemon, which has no
 * controlling terminal, a plain /dev/tty write is a silent no-op there;
 * discovery is what restores the v1 in-terminal visuals. Fire-and-forget:
 * any failure simply paints nothing (or, with no frontends found, falls
 * back to /dev/tty for non-daemon hosts).
 */
function withFrontendTtys(paint: (ttys: string[]) => void, ownerDir?: string): void {
  // Delivery ordering: mark targets are resolved asynchronously, so a reply
  // can win the race. Each requested state change takes a generation, and a
  // delivery whose generation is no longer current is dropped instead of
  // painted — clearing must be the last word on the tab.
  const generation = ++state.paintGeneration
  try {
    const child = spawn("ps", ["ax", "-o", "pid=,tty=,command="], {
      stdio: ["ignore", "pipe", "ignore"],
    })
    let delivered = false
    let output = ""
    const deliver = (ttys: string[]) => {
      if (delivered) return
      delivered = true
      if (generation !== state.paintGeneration) return
      paint(ttys)
    }
    child.on("error", () => deliver([]))
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on("close", () => {
      const frontends = frontendsFromPs(output)
      if (ownerDir === undefined || frontends.length === 0) {
        deliver(ttysOf(frontends, undefined, ownerDir))
        return
      }
      resolveWorkingDirectories(frontends, (cwds) =>
        deliver(ttysOf(frontends, cwds, ownerDir)),
      )
    })
  } catch {
    if (generation === state.paintGeneration) paint([])
  }
}

/** A candidate frontend from `ps ax -o pid=,tty=,command=`. */
type Frontend = { readonly pid: string; readonly tty: string }

function frontendsFromPs(psOutput: string): Frontend[] {
  const frontends: Frontend[] = []
  for (const line of psOutput.split("\n")) {
    const row = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/)
    if (!row) continue
    const pid = row[1]!
    const tty = row[2]!
    const command = row[3]!
    if (tty === "??" || tty === "-") continue
    // The serve daemon has no TTY row of interest; exclude it explicitly so
    // only interactive frontends are marked.
    if (/\bserve\b/.test(command)) continue
    const executable = command.split(/\s+/)[0]!.split("/").pop()!
    if (!executable.startsWith("opencode")) continue
    frontends.push({ pid, tty })
  }
  return frontends
}

/**
 * Pick the TTYs to paint: the frontends whose working directory is the
 * asking plugin's location, or every frontend when no owner directory is
 * known or none matches (the engine exposes no session-owner identity, and
 * an unattributed alert must not be lost).
 */
export function selectFrontendTtys(
  psOutput: string,
  lsofOutput?: string,
  ownerDir?: string,
): string[] {
  return ttysOf(frontendsFromPs(psOutput), lsofOutput === undefined ? undefined : parseLsof(lsofOutput), ownerDir)
}

function ttysOf(
  frontends: Frontend[],
  cwds: Map<string, string> | undefined,
  ownerDir: string | undefined,
): string[] {
  const owned =
    ownerDir === undefined || cwds === undefined
      ? []
      : frontends.filter((frontend) => cwds.get(frontend.pid) === ownerDir)
  return [...new Set((owned.length ? owned : frontends).map((frontend) => frontend.tty))]
}

/** Parse `lsof -a -d cwd -Fn -p …` blocks of `p<pid>` / `n<cwd>` lines. */
function parseLsof(lsofOutput: string): Map<string, string> {
  const cwds = new Map<string, string>()
  let pid: string | undefined
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1)
    else if (line.startsWith("n") && pid !== undefined) {
      cwds.set(pid, path.normalize(line.slice(1)))
      pid = undefined
    }
  }
  return cwds
}

/** Batch-resolve the working directories of the candidate frontends. */
function resolveWorkingDirectories(
  frontends: Frontend[],
  then: (cwds: Map<string, string>) => void,
): void {
  try {
    const child = spawn(
      "lsof",
      ["-a", "-d", "cwd", "-Fn", "-p", frontends.map((f) => f.pid).join(",")],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    let output = ""
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      then(parseLsof(output))
    }
    child.on("error", settle)
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on("close", settle)
  } catch {
    then(new Map())
  }
}

function playSound(custom: true | string) {
  if (process.platform === "darwin") {
    runDetached(
      "afplay",
      [custom === true ? DEFAULT_SOUND : custom],
      undefined,
    )
    return
  }
  const file =
    typeof custom === "string"
      ? custom
      : LINUX_SOUNDS.find((candidate) => fs.existsSync(candidate))
  if (!file) return
  const players: Array<[string, string[]]> = [
    ["paplay", [file]],
    ["ffplay", ["-nodisplay", "-autoexit", "-loglevel", "quiet", file]],
    ["mpv", ["--no-video", "--really-quiet", file]],
    ["aplay", [file]],
  ]
  const tryNext = (index: number) => {
    const entry = players[index]
    if (!entry) return
    runDetached(entry[0], entry[1], () => tryNext(index + 1))
  }
  tryNext(0)
}

function runDetached(
  command: string,
  args: string[],
  onError: (() => void) | undefined,
) {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" })
    child.on("error", () => onError?.())
    child.unref()
  } catch {
    onError?.()
  }
}
