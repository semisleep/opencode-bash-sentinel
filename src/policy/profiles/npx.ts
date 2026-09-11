import path from "node:path";
import type { CommandProfile } from "../types";
import { withinWorkspace } from "../paths";
import { dependencies, unsafeVisibleArgument, unsupported } from "./helpers";

/**
 * npx falls back to fetching and executing an arbitrary registry package
 * whenever the name is not locally installed, so an allow requires the bare
 * name to be declared in the committed, unchanged package.json — the same
 * control file and baseline trust as the npm workflow. Binaries whose name
 * differs from the declaring package (tsc <- typescript) stay unrecognized.
 */
export const recognizeNpx: CommandProfile = (node, invocation, ctx, cwd) => {
  const args = invocation.args.map((argument) => argument.literal);
  if (args.some((argument) => argument === undefined))
    return unsupported(node, "dynamic npx");
  const values = args as string[];
  const name = values[0];
  // Bare unscoped dependency names only: no npx flags, no @version pinning,
  // no scoped packages. Anything else leaves the positively identified form.
  if (
    !name ||
    !withinWorkspace(cwd, ctx.workspace) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  )
    return unsupported(node, "unsupported npx form");
  const tail = values.slice(1);
  if (tail.some((argument) => unsafeVisibleArgument(argument, ctx, cwd)))
    return unsupported(node, "unsupported npx arguments");
  if (!declaredDependency(name, ctx, cwd))
    return unsupported(node, "npx dependency not declared");
  return dependencies(node, ctx, cwd, ["package.json"], true, "npx workflow");
};

function declaredDependency(
  name: string,
  ctx: Parameters<CommandProfile>[2],
  cwd: string,
): boolean {
  const text = ctx.baseline.committedText?.(path.join(cwd, "package.json"));
  if (text === undefined) return false;
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    return [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ].some((section) => {
      const group = pkg[section];
      // Own keys only: `in` walks the prototype chain, so "constructor" or
      // "toString" would pass as declared names. Arrays are excluded because
      // hasOwn("length") is true for them.
      return (
        typeof group === "object" &&
        group !== null &&
        !Array.isArray(group) &&
        Object.hasOwn(group, name)
      );
    });
  } catch {
    return false;
  }
}
