import { describe, expect, it } from "vitest"
import { BUILD_ID } from "../src/version"

describe("build identity", () => {
  it("resolves to a git short hash (optionally +dirty), a package version, or unknown", () => {
    expect(BUILD_ID).toMatch(
      /^(?:[0-9a-f]{7,40}(?:\+dirty)?|\d+\.\d+\.\d+|unknown)$/,
    )
  })

  it("stays constant for the process lifetime", () => {
    expect(BUILD_ID).toBe(BUILD_ID)
  })
})
