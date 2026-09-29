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

/**
 * The alert module keeps mark-cycle state (marked, painted targets); tests
 * that paint directly must first settle it to idle (no mark, no targets).
 * Every reachable state reaches idle through one clearAlert: painting sets
 * marked, and a clear resets both.
 */
function settleMarkState() {
  clearAlert({ sound: false, mark: true })
  vi.mocked(fs.writeSync).mockClear()
  vi.mocked(fs.openSync).mockClear()
  vi.mocked(spawn).mockClear()
}

// A fake child process whose async delivery the test drives by hand.
function fakeChild() {
  let close: (() => void) | undefined
  let data: ((chunk: Buffer) => void) | undefined
  const child = {
    on: (event: string, cb: unknown) => {
      if (event === "close") close = cb as () => void
    },
    stdout: {
      on: (_event: string, cb: unknown) => {
        data = cb as (chunk: Buffer) => void
      },
    },
  }
  return {
    child: child as unknown as ReturnType<typeof spawn>,
    emitStdout: (text: string) => data?.(Buffer.from(text)),
    close: () => close?.(),
  }
}

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
      ["ax", "-o", "pid=,tty=,command="],
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
  it("tints the discovered TTYs without touching the title", () => {
    settleMarkState()
    paintMark(["ttys008"])
    expect(fs.openSync).toHaveBeenCalledWith("/dev/ttys008", "w")
    const painted = vi.mocked(fs.writeSync).mock.calls[0]![1] as string
    expect(painted).toContain("6;1;bg;red;brightness;255")
    expect(painted).toContain("6;1;bg;green;brightness;59")
    expect(painted).toContain("6;1;bg;blue;brightness;48")
    // Color-only mark: no title, blink, or attention sequences.
    expect(painted).not.toContain("]0;")
    expect(painted).not.toContain("[22t")
    expect(painted).not.toContain("[23t")
    expect(painted).not.toContain("RequestAttention")
  })

  it("falls back to /dev/tty when no frontend was found", () => {
    settleMarkState()
    paintMark([])
    expect(fs.openSync).toHaveBeenCalledWith("/dev/tty", "w")
  })

  it("resets the tint on clear", () => {
    settleMarkState()
    paintMark(["ttys008"])
    paintClear(["ttys008"])
    const cleared = vi.mocked(fs.writeSync).mock.calls.at(-1)![1] as string
    expect(cleared).toContain("6;1;bg;*;default")
    expect(cleared).not.toContain("]0;")
  })

  it("unions targets when a re-mark lands mid-cycle", () => {
    settleMarkState()
    paintMark(["ttys008"])
    paintMark(["ttys009"]) // second escalation, new frontend appeared
    expect(vi.mocked(fs.writeSync).mock.calls).toHaveLength(3) // repainted both
    paintClear(["ttys008"])
    const cleared = vi.mocked(fs.writeSync).mock.calls.at(-1)![1] as string
    expect(cleared).toContain("6;1;bg;*;default")
  })
})

describe("mark/clear delivery ordering", () => {
  it("drops a mark whose delivery lands after the reply cleared it", () => {
    settleMarkState()
    const ps = fakeChild()
    vi.mocked(spawn).mockImplementationOnce(() => ps.child)
    fireAlert({ sound: false, mark: true })
    clearAlert({ sound: false, mark: true }) // reply races the ps delivery
    ps.close() // stale mark delivery arrives late
    expect(fs.writeSync).not.toHaveBeenCalled()
  })

  it("clears synchronously on the exact TTYs the mark landed on", () => {
    settleMarkState()
    const ps = fakeChild()
    vi.mocked(spawn).mockImplementationOnce(() => ps.child)
    fireAlert({ sound: false, mark: true })
    ps.emitStdout("  123 ttys008 opencode -c\n")
    ps.close()
    vi.mocked(fs.writeSync).mockClear()
    vi.mocked(fs.openSync).mockClear()
    vi.mocked(spawn).mockClear()
    clearAlert({ sound: false, mark: true })
    expect(spawn).not.toHaveBeenCalled() // no second discovery pass
    expect(fs.openSync).toHaveBeenCalledWith("/dev/ttys008", "w")
    const cleared = vi.mocked(fs.writeSync).mock.calls[0]![1] as string
    expect(cleared).toContain("6;1;bg;*;default")
  })
})

describe("selectFrontendTtys", () => {
  const psOutput = [
    "  101 ttys008 opencode -c",
    "  102 ttys009 opencode",
    "  101 ttys008 opencode -c", // duplicate TTY deduplicates
    "  103 ?? /opt/homebrew/Cellar/opencode-v2/2.0.18/bin/opencode serve --service",
    "  104 ttys010 /usr/local/bin/opencode run --standalone",
    "  105 ttys011 rg pattern src",
    "  106 ttys012 node server.js",
    "  107 -      launchd",
    "",
  ].join("\n")

  const lsofOutput = ["p101", "n/Users/dev/project", "p102", "n/Users/dev/Documents/Default Project", "p104", "n/Users/dev/project"].join("\n")

  it("selects every opencode frontend with a TTY, excluding the daemon", () => {
    expect(selectFrontendTtys(psOutput)).toEqual(["ttys008", "ttys009", "ttys010"])
  })

  it("targets only frontends working in the asking directory", () => {
    expect(selectFrontendTtys(psOutput, lsofOutput, "/Users/dev/project")).toEqual([
      "ttys008",
      "ttys010",
    ])
    expect(
      selectFrontendTtys(psOutput, lsofOutput, "/Users/dev/Documents/Default Project"),
    ).toEqual(["ttys009"])
  })

  it("falls back to every frontend when no owner matches or cwd is unknown", () => {
    expect(selectFrontendTtys(psOutput, lsofOutput, "/elsewhere")).toEqual([
      "ttys008",
      "ttys009",
      "ttys010",
    ])
    expect(selectFrontendTtys(psOutput, "", "/Users/dev/project")).toEqual([
      "ttys008",
      "ttys009",
      "ttys010",
    ])
  })

  it("returns nothing for output without frontends", () => {
    expect(selectFrontendTtys("  108 ?? launchd\n")).toEqual([])
    expect(selectFrontendTtys("")).toEqual([])
  })
})
