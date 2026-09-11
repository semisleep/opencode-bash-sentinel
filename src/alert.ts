import { spawn } from "node:child_process"
import fs from "node:fs"

export type AlertConfig = {
  /** true plays the default sound; a string is used as a sound file path. */
  readonly sound: boolean | string
  /** Mark the iTerm2 tab chrome and request dock attention until replied. */
  readonly mark: boolean
}

const DEBOUNCE_MS = 2000
const DEFAULT_SOUND = "/System/Library/Sounds/Funk.aiff"
const LINUX_SOUNDS = [
  "/usr/share/sounds/freedesktop/stereo/complete.oga",
  "/usr/share/sounds/freedesktop/stereo/bell.oga",
  "/usr/share/sounds/alsa/Front_Center.wav",
]

let lastFiredAt = 0
let marked = false
let blinkTimers: Array<ReturnType<typeof setTimeout>> = []

export function parseAlertOption(raw: unknown): AlertConfig | undefined {
  if (raw === true) return { sound: true, mark: true }
  if (typeof raw !== "object" || raw === null) return undefined
  const options = raw as Record<string, unknown>
  const sound = options.sound
  if (
    sound !== undefined &&
    typeof sound !== "boolean" &&
    typeof sound !== "string"
  )
    return undefined
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
  if (config.mark) markTab()
}

/** Clear a previously set mark once the permission has been replied. */
export function clearAlert(config: AlertConfig | undefined): void {
  if (!config?.mark || !marked) return
  for (const timer of blinkTimers) clearTimeout(timer)
  blinkTimers = []
  const clear =
    "\x1b]6;1;bg;*;default\x07" +
    "\x1b]21337;indicator=\x07" +
    "\x1b]1337;RequestAttention=no\x07"
  writeToTTY(clear)
  marked = false
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

function markTab() {
  // iTerm2-only sequences: color the window/tab chrome red, show a red tab
  // dot that blinks a few times, and bounce the dock icon once. No subtitle
  // text (it wraps the tab to two lines); other terminals ignore unknown OSC
  // codes, and without a controlling TTY (opencode serve) the write fails
  // and the channel degrades to a no-op.
  writeToTTY(
    "\x1b]6;1;bg;red;brightness;255\x07" +
      "\x1b]6;1;bg;green;brightness;59\x07" +
      "\x1b]6;1;bg;blue;brightness;48\x07",
  )
  const indicator = (color: string) =>
    writeToTTY(`\x1b]21337;indicator=${color}\x07`)
  for (const timer of blinkTimers) clearTimeout(timer)
  blinkTimers = []
  indicator("#ff3b30")
  const blinks = ["", "#ff3b30", "", "#ff3b30", "", "#ff3b30"]
  blinks.forEach((color, index) => {
    const timer = setTimeout(() => {
      if (marked) indicator(color)
    }, (index + 1) * 400)
    timer.unref?.()
    blinkTimers.push(timer)
  })
  marked = true
  writeToTTY("\x1b]1337;RequestAttention=once\x07")
}

function writeToTTY(data: string) {
  try {
    const fd = fs.openSync("/dev/tty", "w")
    try {
      fs.writeSync(fd, data)
    } finally {
      fs.closeSync(fd)
    }
    return true
  } catch {
    return false
  }
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
