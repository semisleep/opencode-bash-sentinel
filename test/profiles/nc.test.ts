import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("nc loopback probe profile", () => {
  it("allows loopback-literal connect and scan forms", () => {
    allow("nc -z -w 5 localhost 3000");
    allow("nc -w 5 localhost 3000");
    allow("nc -z localhost 3000");
    allow("nc -vz 127.0.0.1 22");
    allow("nc -w5 localhost 3000");
    allow("nc localhost 3000");
    allow("nc -w 5 -z localhost 3000");
    allow("nc -w 5 localhost 3000 < /dev/null | head -c 12 | od -c | head -2");
    allow('pgrep -fl "ssh -f -N" ; nc -z localhost 3000 && echo "busy" || echo "free"');
  });

  it("keeps egress, listen, exec, and dynamic shapes fail-closed", () => {
    ask("nc -z -w 5 120.24.193.240 6003");
    ask("nc -z example.com 80");
    ask("nc -z -w 5 10.0.0.1 22");
    ask("nc -l 3000");
    ask("nc -l localhost 3000");
    ask("nc -e /bin/sh localhost 3000");
    ask("nc -U /tmp/sock");
    ask("nc -p 8080 localhost 3000");
    ask("nc localhost ssh");
    ask("nc localhost");
    ask("nc -w x localhost 3000");
    ask("nc -w 5 -w 6 localhost 3000");
    ask("nc -zw 5 localhost 3000");
    ask("nc $HOST 3000");
    ask("nc -z localhost 3000 && rm -rf .git");
    ask("nc -z localhost 3000; git push");
  });
});
