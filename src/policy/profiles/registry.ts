import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed, WorkspaceContext } from "../types";
import { recognizeCargoWorkflow } from "./cargo";
import { recognizeCurl } from "./curl";
import { recognizeDd } from "./dd";
import { isRiskyEnvironmentName } from "./environment";
import { recognizeFilesystem } from "./filesystem";
import { recognizeFind } from "./find";
import { recognizeGit } from "./git";
import { recognizeGoWorkflow } from "./go";
import { recognizeJq } from "./jq";
import { unsupported } from "./helpers";
import { informationNames, recognizeInformation } from "./information";
import { recognizeMakeWorkflow } from "./make";
import { NODE_WORKFLOW_NAMES, recognizeNodeWorkflow } from "./node";
import { recognizeNpx } from "./npx";
import { recognizePip } from "./pip";
import { recognizeEcho, recognizePrintf } from "./printf";
import { recognizeSed } from "./sed";
import { recognizeSearch, SEARCH_NAMES } from "./search";
import { recognizeUniq } from "./uniq";
import {
  INTERPRETER_NAMES,
  recognizeInterpreter,
  recognizeScript,
} from "./script";

/** Dispatch only. Profile-specific grammar belongs in the target module. */
export function recognizeCommand(
  node: SyntaxNode,
  invocation: Invocation | undefined,
  ctx: WorkspaceContext,
  cwd: string,
): UnitSeed {
  if (!invocation?.executable.literal)
    return unsupported(node, "dynamic command name");
  if (invocation.assignments.some(isRiskyEnvironmentName))
    return unsupported(node, "high-risk environment assignment");

  const executable = invocation.executable.literal;
  const name = executable.toLowerCase();
  if (name === "cd") return recognizeCd(node, invocation);
  if (executable.includes("/") || executable.includes("\\"))
    return recognizeScript(
      node,
      invocation,
      ctx,
      cwd,
      invocation.executable,
      0,
    );
  if (
    name === "python" &&
    invocation.args[0]?.literal === "-m" &&
    invocation.args[1]?.literal === "pip"
  )
    return recognizePip(node, invocation, ctx, cwd, 2);
  if (INTERPRETER_NAMES.has(name) || name === "source" || name === ".")
    return recognizeInterpreter(node, invocation, ctx, cwd, name);
  if (name === "echo") return recognizeEcho(node, invocation, ctx, cwd, name);
  if (name === "printf")
    return recognizePrintf(node, invocation, ctx, cwd, name);
  if (name === "curl") return recognizeCurl(node, invocation, ctx, cwd, name);
  if (name === "git") return recognizeGit(node, invocation, ctx, cwd, name);
  if (NODE_WORKFLOW_NAMES.has(name))
    return recognizeNodeWorkflow(node, invocation, ctx, cwd, name);
  if (name === "npx") return recognizeNpx(node, invocation, ctx, cwd, name);
  if (name === "go")
    return recognizeGoWorkflow(node, invocation, ctx, cwd, name);
  if (name === "cargo")
    return recognizeCargoWorkflow(node, invocation, ctx, cwd, name);
  if (name === "make")
    return recognizeMakeWorkflow(node, invocation, ctx, cwd, name);
  if (name === "pip" || name === "pip3")
    return recognizePip(node, invocation, ctx, cwd);
  if (informationNames.has(name))
    return recognizeInformation(node, invocation, ctx, cwd, name);
  if (name === "sed") return recognizeSed(node, invocation);
  if (name === "jq") return recognizeJq(node, invocation);
  if (name === "uniq") return recognizeUniq(node, invocation);
  if (name === "find") return recognizeFind(node, invocation);
  if (name === "dd") return recognizeDd(node, invocation);
  if (SEARCH_NAMES.has(name)) return recognizeSearch(node, invocation, name);
  return (
    recognizeFilesystem(node, invocation, name) ??
    unsupported(node, `unsupported command: ${name}`)
  );
}

function recognizeCd(node: SyntaxNode, invocation: Invocation): UnitSeed {
  return invocation.args.length === 1 && invocation.args[0]!.literal
    ? {
        kind: "command",
        text: node.text,
        effects: [{ kind: "read", path: invocation.args[0]!.literal! }],
        reason: "literal cd",
      }
    : unsupported(node, "unsupported cd");
}
