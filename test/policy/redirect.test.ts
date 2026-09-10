import { describe, it } from "vitest";
import { allow, ask } from "./helpers";

describe("redirect profile", () => {
  it("classifies ordinary, fd, dynamic and special Bash redirects", () => {
    allow("cat < /etc/hosts");
    allow("echo x > /dev/null 2>&1");
    ask("echo x <> /tmp/file");
    ask("cat <<EOF\nx\nEOF");
    ask("echo x > $OUT");
    ask("cat < /dev/tcp/example.com/80");
    ask("cat < /dev/udp/example.com/53");
    ask("cat < /dev/fd/3");
    ask("cat < /proc/self/fd/3");
  });
});
