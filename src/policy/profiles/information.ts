import type { CommandProfile } from "../types";

const INFORMATION_FORMS: Record<string, RegExp> = {
  date: /^$/,
  uname: /^(?: -(?:[asnrvmpio]+))*$/,
  uptime: /^$/,
  whoami: /^$/,
  id: /^(?: -(?:[ugGnr]+))*$/,
  free: /^(?: -(?:[bkmghwtsc]+))*$/,
  vm_stat: /^$/,
  nproc: /^(?: --all| --ignore \d+)?$/,
  lscpu: /^(?: -[abcepJ])*$/,
  ps: /^(?: (?:aux|[aux]|-[aefx]))*$/,
  pwd: /^(?: -[LP])?$/,
  which: /^(?: -a)?(?: [^-\s][^\s]*)*$/,
  true: /^$/,
  false: /^$/,
  ":": /^$/,
};

export const informationNames = new Set(Object.keys(INFORMATION_FORMS));

export const recognizeInformation: CommandProfile = (
  node,
  invocation,
  _ctx,
  _cwd,
  name,
) => {
  const values = invocation.args.map((argument) => argument.literal);
  const allowed =
    values.every(Boolean) &&
    INFORMATION_FORMS[name]!.test(values.length ? ` ${values.join(" ")}` : "");
  return {
    kind: "command",
    text: node.text,
    situation: "workspace-neutral-or-indeterminate",
    allowed,
    reason: allowed ? "information profile" : "unsupported information form",
  };
};
