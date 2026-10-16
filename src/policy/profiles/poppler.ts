import type { SyntaxNode } from "../../parser/node";
import type { Effect, Invocation, UnitSeed } from "../types";
import { unsupported } from "./helpers";
import { literalArguments } from "./filesystem/options";

// Poppler's read/convert CLI family. Every modeled option is display-only;
// the output operand carries the write, so it is emitted as an effect and
// classified by the normal write situation: `-` (stdout) and the usage
// forms stay pure reads, workspace/scratch file targets allow, and every
// other target asks. String-valued options (-enc, -opw, -upw, -aa) and
// the sibling converters with output-option or multi-file surfaces
// (pdftocairo's `-o`, pdftohtml) are deliberately absent and stay
// fail-closed until a concrete need pins their grammar.

const USAGE = new Set(["-h", "-help", "--help", "-v", "-version", "--version"]);

type PopplerSpec = {
  flags: ReadonlySet<string>;
  /** Single-letter page/size selectors (`-f 3`, `-f3`). */
  numeric?: ReadonlySet<string>;
  /** Word-length numeric options (`-scale-to 1000`), separate value only. */
  numericWords?: ReadonlySet<string>;
};

const SPECS: Record<string, PopplerSpec> = {
  pdftotext: {
    flags: new Set([
      "-layout",
      "-simple",
      "-raw",
      "-table",
      "-clip",
      "-nodiag",
      "-nopgbrk",
      "-q",
    ]),
    numeric: new Set(["f", "l"]),
  },
  pdfinfo: { flags: new Set(["-u", "-isodates"]), numeric: new Set(["f", "l"]) },
  pdffonts: { flags: new Set(["-subst"]), numeric: new Set(["f", "l"]) },
  pdftoppm: {
    flags: new Set([
      "-png",
      "-jpeg",
      "-tiff",
      "-jpx",
      "-gray",
      "-mono",
      "-cropbox",
      "-q",
    ]),
    numeric: new Set(["f", "l", "r", "x", "y", "W", "H"]),
    numericWords: new Set(["-scale-to"]),
  },
  pdfimages: {
    flags: new Set(["-list", "-all", "-png", "-j", "-tiff", "-ccitt", "-p", "-q"]),
    numeric: new Set(["f", "l"]),
  },
};

export const POPPLER_NAMES = new Set(Object.keys(SPECS));

type Parsed = { operands: string[]; usage: boolean; flags: Set<string> };

function parsePoppler(args: string[], spec: PopplerSpec): Parsed | undefined {
  const operands: string[] = [];
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "-" || !argument.startsWith("-")) {
      operands.push(argument);
      continue;
    }
    if (USAGE.has(argument)) {
      // -h/-v print usage and exit; the form must stand alone.
      if (args.length !== 1) return;
      return { operands: [], usage: true, flags };
    }
    if (spec.flags.has(argument)) {
      flags.add(argument);
      continue;
    }
    const attached = /^-([A-Za-z])(\d+)$/.exec(argument);
    if (attached && spec.numeric?.has(attached[1]!)) continue;
    if (argument.length === 2 && spec.numeric?.has(argument[1]!)) {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value)) return;
      continue;
    }
    if (spec.numericWords?.has(argument)) {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value)) return;
      continue;
    }
    return;
  }
  return { operands, usage: false, flags };
}

export function recognizePoppler(
  node: SyntaxNode,
  invocation: Invocation,
  name: string,
): UnitSeed {
  const args = literalArguments(invocation);
  if (!args) return unsupported(node, `dynamic ${name}`);
  const parsed = parsePoppler(args, SPECS[name]!);
  if (!parsed) return unsupported(node, `unsupported ${name}`);
  if (parsed.usage) {
    return {
      kind: "command",
      text: node.text,
      situation: "workspace-neutral-or-indeterminate",
      allowed: true,
      reason: `${name} usage form`,
    };
  }
  const operands = parsed.operands;
  switch (name) {
    case "pdftotext": {
      // A missing output operand would write beside the input under a
      // derived name — fail closed instead of synthesizing the target.
      if (operands.length === 1)
        return unsupported(node, "pdftotext requires an explicit output");
      if (operands.length !== 2)
        return unsupported(node, "unsupported pdftotext operands");
      const [input, output] = operands as [string, string];
      return output === "-"
        ? command(node, name, [{ kind: "read", path: input }])
        : command(node, name, [
            { kind: "read", path: input },
            { kind: "write", path: output },
          ]);
    }
    case "pdfinfo":
    case "pdffonts": {
      if (operands.length !== 1 || !operands[0])
        return unsupported(node, `unsupported ${name} operands`);
      return command(node, name, [{ kind: "read", path: operands[0]! }]);
    }
    case "pdftoppm": {
      if (operands.length !== 2)
        return unsupported(node, "unsupported pdftoppm operands");
      const [input, root] = operands as [string, string];
      return rasterize(node, name, input, root);
    }
    case "pdfimages": {
      if (parsed.flags.has("-list")) {
        if (operands.length !== 1 || !operands[0])
          return unsupported(node, "unsupported pdfimages operands");
        return command(node, name, [{ kind: "read", path: operands[0]! }]);
      }
      if (operands.length !== 2)
        return unsupported(node, "unsupported pdfimages operands");
      const [input, root] = operands as [string, string];
      return rasterize(node, name, input, root);
    }
  }
  return unsupported(node, `unsupported ${name}`);
}

// pdftoppm/pdfimages write ROOT-N.EXT siblings of the root path, never the
// root itself, so the mutation is represented by the deterministic first
// artifact: same directory and same prefix class as every real output. A
// root sitting exactly on the workspace or scratch boundary writes its
// artifacts outside that boundary and correctly classifies as external.
function firstArtifact(root: string): string {
  return `${root}-1`;
}

function rasterize(
  node: SyntaxNode,
  name: string,
  input: string,
  root: string,
): UnitSeed {
  return command(node, name, [
    { kind: "read", path: input },
    { kind: "write", path: firstArtifact(root) },
  ]);
}

function command(
  node: SyntaxNode,
  reason: string,
  effects: Effect[],
): UnitSeed {
  return {
    kind: "command",
    text: node.text,
    effects: [effects[0]!, ...effects.slice(1)],
    reason,
  };
}
