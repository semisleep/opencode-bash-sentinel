import type { SyntaxNode } from "../../../parser/node";
import type { Invocation, UnitSeed } from "../../types";
import { pathEffects, unsupported } from "../helpers";
import {
  literalArguments,
  parseArguments,
  type OptionGrammar,
} from "./options";

const GRAMMARS: Record<string, OptionGrammar> = {
  cat: {
    short: "AbEnstTuv",
    long: new Set([
      "--number",
      "--number-nonblank",
      "--show-all",
      "--show-ends",
      "--show-tabs",
      "--squeeze-blank",
    ]),
  },
  ls: {
    short: "1AaBCFghHiklLmnpqQrRsStUvwX",
    long: new Set([
      "--all",
      "--almost-all",
      "--classify",
      "--color",
      "--directory",
      "--human-readable",
      "--inode",
      "--long",
      "--recursive",
      "--reverse",
      "--size",
    ]),
  },
  head: { short: "qvz", shortWithValue: "cn", numeric: true },
  tail: { short: "fqsvz", shortWithValue: "cn", numeric: true },
  wc: { short: "clmwL" },
  stat: { short: "LfZ", shortWithValue: "c" },
  file: { short: "bEhiklLNnprsSvz" },
  readlink: { short: "efmnqsvz" },
  realpath: { short: "eLmqsz" },
  du: { short: "abchHkLmsSx" },
  df: { short: "ahHiPkPT" },
  diff: { short: "abBdiNqrsTtuwy", shortWithValue: "SW" },
  cmp: { short: "bls", shortWithValue: "in" },
  cut: { short: "Dnsz", shortWithValue: "bcdf" },
  strings: { short: "adlx", shortWithValue: "enstT" },
  // Read-only operand model; output (-o/--output), temp (-T), and
  // --compress-program forms are deliberately not in the grammar.
  sort: {
    short: "bcCdfghiMmnRrsuVz",
    shortWithValue: "kt",
    long: new Set([
      "--ignore-leading-blanks",
      "--dictionary-order",
      "--ignore-case",
      "--general-numeric-sort",
      "--human-numeric-sort",
      "--month-sort",
      "--numeric-sort",
      "--reverse",
      "--random-sort",
      "--stable",
      "--unique",
      "--version-sort",
      "--check",
      "--merge",
      "--zero-terminated",
    ]),
  },
};

export function recognizeFilesystemReader(
  node: SyntaxNode,
  invocation: Invocation,
  name: string,
): UnitSeed | undefined {
  const grammar = GRAMMARS[name];
  if (!grammar) return;
  const args = literalArguments(invocation);
  if (!args) return unsupported(node, `dynamic ${name}`);
  const parsed = parseArguments(args, grammar);
  if (!parsed) return unsupported(node, `unsupported ${name}`);
  if (["stat", "file", "readlink", "realpath"].includes(name)) {
    if (parsed.operands.length === 0)
      return unsupported(node, `missing ${name} operand`);
  } else if (name === "diff") {
    if (parsed.operands.length !== 2)
      return unsupported(node, "unsupported diff operands");
  } else if (name === "cmp") {
    if (
      parsed.operands.length < 2 ||
      parsed.operands.length > 4 ||
      parsed.operands.slice(2).some((value) => !/^\d+$/.test(value))
    )
      return unsupported(node, "unsupported cmp operands");
    return pathEffects(node, parsed.operands.slice(0, 2), "read", name);
  } else if (
    name === "cut" &&
    !["-b", "-c", "-f"].some((option) => parsed.optionValues.has(option))
  ) {
    return unsupported(node, "cut requires a field selector");
  }
  return pathEffects(node, parsed.operands, "read", name);
}
