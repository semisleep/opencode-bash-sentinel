import type { Invocation } from "../../types";

export type ParsedArguments = {
  operands: string[];
  optionValues: Map<string, string[]>;
};

export type OptionGrammar = {
  short?: string;
  shortWithValue?: string;
  long?: ReadonlySet<string>;
};

export function literalArguments(
  invocation: Invocation,
): string[] | undefined {
  const args = invocation.args.map((argument) => argument.literal);
  return args.every((argument) => argument !== undefined)
    ? (args as string[])
    : undefined;
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
      if (grammar.long?.has(name)) {
        if (equals >= 0) return;
        continue;
      }
      return;
    }
    if (options && argument.startsWith("-") && argument !== "-") {
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
