import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("sips profile", () => {
  it("allows property queries over file operands", () => {
    allow("sips -g pixelWidth /work/project/photo.png");
    allow("sips -g pixelWidth -g pixelHeight /work/project/photo.png");
    allow("sips -g all photo.png");
    allow("sips --getProperty format /work/project/photo.png");
    allow("sips -g format -1 /work/project/photo.png");
    allow("sips -1 --oneLine -g format /work/project/photo.png");
    allow("sips -g format /work/project/a.png /work/project/b.png");
    allow('sips -g space "/Users/guest/Downloads/照片 封面.jpg"');
    allow("sips -g all /work/project/photo.png -g space");
  });

  it("asks for mutating functions, unknown options, and malformed queries", () => {
    // Mutating synopsis functions (rewrite input in place or write --out).
    ask("sips -s format jpeg photo.png --out out.jpg");
    ask("sips -s format jpeg /work/project/photo.png");
    ask("sips -d format /work/project/photo.png");
    ask("sips -r 90 /work/project/photo.png");
    ask("sips -z 100 200 /work/project/photo.png");
    ask("sips -Z 1200 /work/project/photo.png");
    ask("sips -c 100 200 /work/project/photo.png");
    ask("sips -x /work/project/profile.icc /work/project/photo.png");
    ask("sips -X tag /work/project/tag.bin /work/project/profile.icc");
    ask("sips --matchTo /System/Library/sRGB.icc /work/project/photo.png");
    // No query key, or no file operand: not a complete query form.
    ask("sips /work/project/photo.png");
    ask("sips -g all");
    ask("sips -g");
    ask("sips --getProperty");
    // Missing -g value would swallow the operand as the key.
    ask("sips -g photo.png");
    // Attached spellings are undocumented in the man synopsis.
    ask("sips -gpixelWidth /work/project/photo.png");
    ask("sips --getProperty=format /work/project/photo.png");
    ask("sips -g all -- /work/project/photo.png");
  });

  it("routes read effects through situations and red lines", () => {
    ask("sips -g all /home/dev/.ssh/key.png");
    ask("sips -g all /work/project/photo.png && rm -rf .git");
    ask("sips -g all $PHOTO");
    ask('sips -g all "$(pwd)/photo.png"');
  });
});
