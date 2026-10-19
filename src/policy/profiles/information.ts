import type { CommandProfile } from "../types";

const INFORMATION_FORMS: Record<string, RegExp> = {
  date: /^(?: -(?:u|R)| --(?:utc|universal)| -I\w*| --iso-8601(?:=\w+)?)*(?: \+[^\s]+)?$/,
  uname: /^(?: -(?:[asnrvmpio]+)| --(?:all|kernel-name|nodename|kernel-release|kernel-version|machine|processor|hardware-platform|operating-system))*$/,
  uptime: /^(?: -[ps]| --(?:pretty|since))?$/,
  whoami: /^$/,
  id: /^(?: -(?:[ugGnr]+)| --(?:user|group|groups|name))*$/,
  free: /^(?: -(?:[bkmghwtsc]+))*$/,
  vm_stat: /^$/,
  nproc: /^(?: --all| --ignore \d+)?$/,
  lscpu: /^(?: -[abcepJ])*$/,
  ps: /^(?: (?:auxw*|[aux]|-[aefx]+|-o [a-zA-Z%][a-zA-Z0-9%,:]*|-p\d+(?:,\d+)*|-p \d+(?:,\d+)*))*$/,
  pwd: /^(?: -[LP]| --(?:logical|physical))?$/,
  which: /^(?: -a)?(?: [^-\s][^\s]*)*$/,
  true: /^$/,
  false: /^$/,
  ":": /^$/,
  sleep: /^ \d+(?:\.\d+)?$/,
  // sw_vers prints macOS product/build identity; every spelling is
  // display-only and composable. No long forms exist.
  sw_vers: /^(?: -(?:productName|productVersion|buildVersion))*$/,
  // system_profiler reports hardware/software configuration and has no
  // mutating mode: bare (full dump), literal SP-prefixed datatypes, and
  // one -detailLevel selector with a closed value set. Other flags
  // (-json, -timeout, -usage) stay unrecognized until pinned.
  system_profiler: /^(?: -detailLevel (?:mini|basic|full))?(?: SP[A-Za-z0-9]+)*$/,
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
