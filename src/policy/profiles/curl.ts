import type { CommandProfile } from "../types";

const FLAG_OPTIONS = new Set([
  "-f",
  "-s",
  "-S",
  "-L",
  "-I",
  "--fail",
  "--silent",
  "--show-error",
  "--location",
  "--head",
  "--compressed",
]);

const VALUE_OPTIONS = new Set([
  "--connect-timeout",
  "--max-time",
  "--retry",
  "--retry-delay",
]);

/** Situation-3, stdout-only HTTP(S) GET/HEAD profile. */
export const recognizeCurl: CommandProfile = (node, invocation) => {
  let foundUrl = false;
  let allowed = true;
  for (let index = 0; index < invocation.args.length; index++) {
    const argument = invocation.args[index]!.literal;
    if (!argument) {
      allowed = false;
      break;
    }
    if (FLAG_OPTIONS.has(argument) || /^-[fsSLI]+$/.test(argument)) continue;
    const equals = argument.indexOf("=");
    const option = equals > 0 ? argument.slice(0, equals) : argument;
    if (VALUE_OPTIONS.has(option)) {
      const value =
        equals > 0
          ? argument.slice(equals + 1)
          : invocation.args[++index]?.literal;
      if (!value || !/^\d+(\.\d+)?$/.test(value)) allowed = false;
      continue;
    }
    if (argument.startsWith("-") || foundUrl || !safeUrl(argument)) {
      allowed = false;
      break;
    }
    foundUrl = true;
  }
  allowed &&= foundUrl;
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed,
    reason: allowed ? "curl GET/HEAD profile" : "unsupported curl",
  };
};

function safeUrl(value: string) {
  if (/[[\]{}\r\n]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hostname !== ""
    );
  } catch {
    return false;
  }
}
