import { globReadTarget } from "../helpers";
import type { Invocation } from "../../types";

export type ParsedArguments = {
  operands: string[];
  optionValues: Map<string, string[]>;
};

export type OptionGrammar = {
  short?: string;
  shortWithValue?: string;
  long?: ReadonlySet<string>;
  /**
   * Attached long values (`--flag=VALUE`) accepted only for whitelisted
   * flags whose value is display-only data. The bare separate-value form
   * (`--flag VALUE`) stays unsupported so a path operand can never be
   * silently consumed as an option value.
   */
  longWithValue?: ReadonlyMap<string, RegExp>;
  /** Accept a bare count like `-8` where the tool means `-n 8`. */
  numeric?: boolean;
};

export function literalArguments(
  invocation: Invocation,
): string[] | undefined {
  const args = invocation.args.map((argument) => argument.literal);
  return args.every((argument) => argument !== undefined)
    ? (args as string[])
    : undefined;
}

// A grammar without value-taking short options can never consume the
// argument after an option as a value, so a non-literal argument can only
// occupy operand position: a bounded glob cover may stand in for it. Every
// other grammar keeps requiring literals, because a cover silently eaten
// as an option value would under-report reads.
export function literalOrGlobArguments(
  invocation: Invocation,
  grammar: OptionGrammar,
): string[] | undefined {
  if (grammar.shortWithValue) return literalArguments(invocation);
  const args: string[] = [];
  for (const argument of invocation.args) {
    if (argument.literal !== undefined) args.push(argument.literal);
    else {
      const glob = globReadTarget(argument.raw);
      if (glob === undefined) return undefined;
      args.push(glob);
    }
  }
  return args;
}

export function parseArguments(
  args: string[],
  grammar: OptionGrammar,
): ParsedArguments | undefined {
  const operands: string[] = [];
  const optionValues = new Map<string, string[]>();
  let options = true;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (options && argument === "--") {
      options = false;
      continue;
    }
    if (options && argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      const name = equals < 0 ? argument : argument.slice(0, equals);
      const valuePattern = grammar.longWithValue?.get(name);
      if (valuePattern) {
        if (equals < 0 || !valuePattern.test(argument.slice(equals + 1)))
          return;
        continue;
      }
      if (grammar.long?.has(name)) {
        if (equals >= 0) return;
        continue;
      }
      return;
    }
    if (options && argument.startsWith("-") && argument !== "-") {
      if (grammar.numeric && /^-\d+$/.test(argument)) continue;
      const letters = argument.slice(1);
      for (let offset = 0; offset < letters.length; offset++) {
        const name = letters[offset]!;
        if (grammar.short?.includes(name)) continue;
        if (!grammar.shortWithValue?.includes(name)) return;
        const attached = letters.slice(offset + 1);
        const value = attached || args[++index];
        if (!value) return;
        addOptionValue(optionValues, `-${name}`, value);
        break;
      }
      continue;
    }
    operands.push(argument);
  }

  return { operands, optionValues };
}

function addOptionValue(
  values: Map<string, string[]>,
  name: string,
  value: string,
) {
  const existing = values.get(name);
  if (existing) existing.push(value);
  else values.set(name, [value]);
}
