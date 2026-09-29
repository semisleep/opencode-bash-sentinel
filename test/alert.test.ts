import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import fs from "node:fs"

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}))

vi.mock("node:fs", () => ({
  default: {
    openSync: vi.fn(() => 3),
    writeSync: vi.fn(),
    closeSync: vi.fn(),
    existsSync: vi.fn(() => false),
  },
}))

import { clearAlert, fireAlert, paintClear, paintMark, parseAlertOption, selectFrontendTtys } from "../src/alert"

let now = 1_000_000
let nowSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
})

afterEach(() => {
  nowSpy.mockRestore()
  vi.clearAllMocks()
  now += 10_000
})

describe("parseAlertOption", () => {
  it("accepts true as all channels", () => {
    expect(parseAlertOption(true)).toEqual({ sound: true, mark: true })
  })

  it("accepts per-channel booleans and a custom sound path", () => {
    expect(parseAlertOption({})).toEqual({ sound: false, mark: false })
    expect(parseAlertOption({ mark: true })).toEqual({ sound: false, mark: true })
    expect(parseAlertOption({ sound: "/sounds/ding.aiff" })).toEqual({
      sound: "/sounds/ding.aiff",
      mark: false,
    })
  })

  it("rejects malformed values without disabling the other channel", () => {
    expect(parseAlertOption("yes")).toBeUndefined()
    expect(parseAlertOption(undefined)).toBeUndefined()
    expect(parseAlertOption({ sound: 42 })).toEqual({ sound: false, mark: false })
    expect(parseAlertOption({ sound: 42, mark: true })).toEqual({
      sound: false,
      mark: true,
    })
  })
})

describe("fireAlert", () => {
  it("plays the default sound on macOS", () => {
    fireAlert({ sound: true, mark: false })
    expect(spawn).toHaveBeenCalledTimes(1)
    if (process.platform === "darwin") {
      expect(spawn).toHaveBeenCalledWith(
        "afplay",
        ["/System/Library/Sounds/Funk.aiff"],
        expect.objectContaining({ detached: true }),
      )
    }
  })

  it("debounces rapid escalations into one signal", () => {
    fireAlert({ sound: true, mark: false })
    now += 100
    fireAlert({ sound: true, mark: false })
    expect(spawn).toHaveBeenCalledTimes(1)
    now += 10_000
    fireAlert({ sound: true, mark: false })
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("marks via frontend-TTY discovery and clears on reply", () => {
    fireAlert({ sound: false, mark: true })
    // The mark channel resolves delivery targets asynchronously through ps;
    // the spawn mock has no stdout, so no paint happens synchronously.
    expect(spawn).toHaveBeenCalledWith(
      "ps",
      ["ax", "-o", "tty=,command="],
      expect.objectContaining({ stdio: expect.anything() }),
    )
    expect(fs.writeSync).not.toHaveBeenCalled()
  })

  it("does nothing without config or after clearing", () => {
    fireAlert(undefined)
    expect(spawn).not.toHaveBeenCalled()
    expect(fs.writeSync).not.toHaveBeenCalled()
    clearAlert({ sound: false, mark: true }) // nothing marked
    expect(fs.writeSync).not.toHaveBeenCalled()
  })
})

describe("frontend mark painting", () => {
  it("paints the mark on the discovered TTYs", () => {
    paintMark(["ttys008"])
    expect(fs.openSync).toHaveBeenCalledWith("/dev/ttys008", "w")
    const first = vi.mocked(fs.writeSync).mock.calls[0]![1] as string
    expect(first).toContain("\x07")
    expect(first).toContain("6;1;bg;red;brightness;255")
    expect(first).toContain("]0;🔴 approval needed\x07")
    expect(first).toContain("RequestAttention=once")
  })

  it("falls back to /dev/tty when no frontend was found", () => {
    paintMark([])
    expect(fs.openSync).toHaveBeenCalledWith("/dev/tty", "w")
  })

  it("restores the title and background on clear", () => {
    paintMark(["ttys008"])
    paintClear(["ttys008"])
    const cleared = vi.mocked(fs.writeSync).mock.calls.at(-1)![1] as string
    expect(cleared).toContain("]0;opencode\x07")
    expect(cleared).toContain("6;1;bg;*;default")
    expect(cleared).toContain("RequestAttention=no")
  })
})

describe("selectFrontendTtys", () => {
  const psOutput = [
    "  ttys008 opencode -c",
    "  ttys009 opencode",
    "  ttys008 opencode -c", // duplicate TTY deduplicates
    "      ?? /opt/homebrew/Cellar/opencode-v2/2.0.18/bin/opencode serve --service",
    "  ttys010 /usr/local/bin/opencode run --standalone",
    "  ttys011 rg pattern src",
    "  ttys012 node server.js",
    "  -      launchd",
    "",
  ].join("\n")

  it("selects opencode frontends with a TTY, excluding the daemon", () => {
    expect(selectFrontendTtys(psOutput)).toEqual(["ttys008", "ttys009", "ttys010"])
  })

  it("returns nothing for output without frontends", () => {
    expect(selectFrontendTtys("  ?? launchd\n")).toEqual([])
    expect(selectFrontendTtys("")).toEqual([])
  })
})
