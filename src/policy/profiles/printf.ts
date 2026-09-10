import type { CommandProfile, Word } from "../types";

export const recognizeEcho: CommandProfile = (node, _invocation) => ({
  kind: "command",
  text: node.text,
  situation: "workspace-neutral-or-indeterminate",
  allowed: true,
  reason: "stdout profile",
});

export const recognizePrintf: CommandProfile = (node, invocation) => {
  const allowed = safePrintf(invocation.args);
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed,
    reason: allowed ? "stdout profile" : "shell-state mutation",
  };
};

function safePrintf(args: Word[]) {
  let index = 0;
  if (args[0]?.literal === "--") index = 1;
  const word = args[index];
  const format = word?.literal;
  if (word?.raw.startsWith("$'")) return false;
  if (format === undefined || format.startsWith("-v")) return false;
  return !writesVariable(format);
}

function writesVariable(format: string) {
  for (let index = 0; index < format.length; index++) {
    if (format[index] !== "%") continue;
    if (format[index + 1] === "%") {
      index++;
      continue;
    }
    let conversion = index + 1;
    while (
      conversion < format.length &&
      /[-+ #0'0-9.*]/.test(format[conversion]!)
    )
      conversion++;
    if (format[conversion] === "n") return true;
    index = conversion;
  }
  return false;
}
