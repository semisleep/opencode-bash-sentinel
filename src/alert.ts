import { spawn } from "node:child_process"
import fs from "node:fs"

export type AlertConfig = {
  /** true plays the default sound; a string is used as a sound file path. */
  readonly sound: boolean | string
  /** Blink the frontend tab title and tint its terminal until replied. */
  readonly mark: boolean
}

const DEBOUNCE_MS = 2000
const DEFAULT_SOUND = "/System/Library/Sounds/Funk.aiff"
const LINUX_SOUNDS = [
  "/usr/share/sounds/freedesktop/stereo/complete.oga",
  "/usr/share/sounds/freedesktop/stereo/bell.oga",
  "/usr/share/sounds/alsa/Front_Center.wav",
]

const ALERT_TITLE = "🔴 approval needed"
const IDLE_TITLE = "opencode"
const BLINK_INTERVAL_MS = 700
// Odd so the blink ends on the alert title; clear restores the idle title.
const BLINK_STEPS = 7

let lastFiredAt = 0
let marked = false
let blinkTimers: Array<ReturnType<typeof setTimeout>> = []

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
 */
export function fireAlert(config: AlertConfig | undefined): void {
  if (!config) return
  const now = Date.now()
  if (now - lastFiredAt < DEBOUNCE_MS) return
  lastFiredAt = now
  if (config.sound !== false) playSound(config.sound)
  if (config.mark) withFrontendTtys(paintMark)
}

/** Clear a previously set mark once the permission has been replied. */
export function clearAlert(config: AlertConfig | undefined): void {
  if (!config?.mark || !marked) return
  marked = false
  for (const timer of blinkTimers) clearTimeout(timer)
  blinkTimers = []
  withFrontendTtys(paintClear)
}

/** Synchronous mark painting on resolved targets; exported for tests. */
export function paintMark(ttys: string[]): void {
  marked = true
  const targets = devicePaths(ttys)
  writeAll(
    targets,
    "\x07" + // BEL: iTerm2's native tab-attention marker
      "\x1b]6;1;bg;red;brightness;255\x07" +
      "\x1b]6;1;bg;green;brightness;59\x07" +
      "\x1b]6;1;bg;blue;brightness;48\x07" +
      `\x1b]0;${ALERT_TITLE}\x07` +
      "\x1b]1337;RequestAttention=once\x07",
  )
  for (const timer of blinkTimers) clearTimeout(timer)
  blinkTimers = []
  for (let step = 1; step < BLINK_STEPS; step++) {
    const timer = setTimeout(() => {
      if (!marked) return
      writeAll(
        targets,
        `\x1b]0;${step % 2 === 1 ? IDLE_TITLE : ALERT_TITLE}\x07`,
      )
    }, step * BLINK_INTERVAL_MS)
    timer.unref?.()
    blinkTimers.push(timer)
  }
}

/** Synchronous clear painting; exported for tests. */
export function paintClear(ttys: string[]): void {
  writeAll(
    devicePaths(ttys),
    `\x1b]0;${IDLE_TITLE}\x07` +
      "\x1b]6;1;bg;*;default\x07" +
      "\x1b]1337;RequestAttention=no\x07",
  )
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
function withFrontendTtys(paint: (ttys: string[]) => void): void {
  try {
    const child = spawn("ps", ["ax", "-o", "tty=,command="], {
      stdio: ["ignore", "pipe", "ignore"],
    })
    let delivered = false
    let output = ""
    const deliver = (ttys: string[]) => {
      if (delivered) return
      delivered = true
      paint(ttys)
    }
    child.on("error", () => deliver([]))
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on("close", () => deliver(selectFrontendTtys(output)))
  } catch {
    paint([])
  }
}

/** Pick the TTYs of opencode frontends from `ps ax -o tty=,command=` output. */
export function selectFrontendTtys(psOutput: string): string[] {
  const ttys: string[] = []
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf(" ")
    const tty = separator === -1 ? trimmed : trimmed.slice(0, separator)
    const command = separator === -1 ? "" : trimmed.slice(separator + 1).trim()
    if (!command || tty === "??" || tty === "-") continue
    // The serve daemon has no TTY row of interest; exclude it explicitly so
    // only interactive frontends are marked.
    if (/\bserve\b/.test(command)) continue
    const executable = command.split(/\s+/)[0]!.split("/").pop()!
    if (!executable.startsWith("opencode")) continue
    ttys.push(tty)
  }
  return [...new Set(ttys)]
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
