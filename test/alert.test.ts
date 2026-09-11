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

import { clearAlert, fireAlert, parseAlertOption } from "../src/alert"

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

  it("marks the iTerm2 tab and clears it on reply", () => {
    fireAlert({ sound: false, mark: true })
    expect(fs.openSync).toHaveBeenCalledWith("/dev/tty", "w")
    const writes = vi.mocked(fs.writeSync).mock.calls.map((call) => call[1] as string)
    expect(writes[0]).toContain("6;1;bg;red;brightness;255")
    expect(writes[1]).toContain("indicator=#ff3b30")
    expect(writes.some((write) => write.includes("status="))).toBe(false)
    expect(writes.some((write) => write.includes("RequestAttention=once"))).toBe(true)

    clearAlert({ sound: false, mark: true })
    const cleared = vi.mocked(fs.writeSync).mock.calls.at(-1)![1] as string
    expect(cleared).toContain("6;1;bg;*;default")
    expect(cleared).toContain("indicator=")
    expect(cleared).toContain("RequestAttention=no")
  })

  it("does nothing without config or after clearing", () => {
    fireAlert(undefined)
    expect(spawn).not.toHaveBeenCalled()
    expect(fs.writeSync).not.toHaveBeenCalled()
    clearAlert({ sound: false, mark: true }) // nothing marked
    expect(fs.writeSync).not.toHaveBeenCalled()
  })
})
