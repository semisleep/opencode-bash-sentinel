import { describe, expect, it } from "vitest";
import { allow, ask, context } from "../policy/helpers";
import { analyzeWorkspacePolicy } from "../../src/workspace-policy";

describe("poppler profiles", () => {
  it("allows pdftotext stdout extraction and explicit outputs", () => {
    allow("pdftotext -raw /work/project/in.pdf -");
    allow("pdftotext /work/project/in.pdf -");
    allow("pdftotext -layout -f 2 -l 4 -q /work/project/in.pdf -");
    allow("pdftotext -table -clip -nopgbrk /work/project/in.pdf -");
    allow("pdftotext -layout /work/project/in.pdf /work/project/out.txt");
    allow('pdftotext -raw "/Users/guest/Downloads/a b.pdf" -');
    allow("pdftotext -h");
    allow("pdftotext --help");
  });

  it("asks for pdftotext implicit, unknown, or external shapes", () => {
    // A missing output would write beside the input under a derived name.
    ask("pdftotext /work/project/in.pdf");
    ask("pdftotext -layout /work/project/in.pdf a b");
    ask("pdftotext -enc UTF-8 /work/project/in.pdf -");
    ask("pdftotext -opw pw /work/project/in.pdf -");
    ask("pdftotext -f x /work/project/in.pdf -");
    ask("pdftotext -f /work/project/in.pdf -");
    ask("pdftotext -h /work/project/in.pdf");
    ask("pdftotext -layout /work/project/in.pdf /etc/out.txt");
    ask("pdftotext -layout /work/project/in.pdf - && rm -rf .git");
    ask("pdftotext $PDF -");
    ask('pdftotext -raw "$(pwd)/in.pdf" -');
  });

  it("allows read-only pdfinfo and pdffonts", () => {
    allow("pdfinfo /work/project/doc.pdf");
    allow("pdfinfo -f 1 -l 2 -isodates /work/project/doc.pdf");
    allow('pdfinfo "/Users/guest/Downloads/doc.pdf"');
    allow("pdffonts /work/project/doc.pdf");
    allow("pdffonts -subst -f 1 /work/project/doc.pdf");
    allow("pdfinfo -v");
    allow("pdffonts --version");
  });

  it("asks for pdfinfo/pdffonts shape violations and sensitive reads", () => {
    ask("pdfinfo");
    ask("pdfinfo a.pdf b.pdf");
    ask("pdfinfo -enc Latin1 /work/project/a.pdf");
    ask("pdffonts -opw pw /work/project/a.pdf");
    ask("pdfinfo /home/dev/.ssh/keys.pdf");
    ask("pdffonts /home/dev/.ssh/keys.pdf && rm -rf .git");
  });

  it("allows pdftoppm rasterization into workspace targets", () => {
    allow("pdftoppm -png -r 120 /work/project/in.pdf /work/project/out");
    allow("pdftoppm /work/project/in.pdf out");
    allow("pdftoppm -f 1 -l 3 -gray -cropbox /work/project/in.pdf /work/project/o");
    allow("pdftoppm -scale-to 1000 -png /work/project/in.pdf /work/project/o");
    allow("pdftoppm -png -r120 /work/project/in.pdf /work/project/o");
    allow("pdftoppm -v");
  });

  it("asks for pdftoppm dangerous cousins and external roots", () => {
    ask("pdftoppm -png /work/project/in.pdf");
    ask("pdftoppm -png /work/project/in.pdf /tmp/out");
    ask("pdftoppm -aa yes /work/project/in.pdf out");
    ask("pdftoppm -r fast /work/project/in.pdf out");
    ask("pdftoppm -mono /work/project/in.pdf out && rm -rf .git");
    ask("pdftoppm -mono /work/project/in.pdf /home/dev/.ssh/out");
  });

  it("allows pdfimages listing and extraction", () => {
    allow("pdfimages -list /work/project/in.pdf");
    allow("pdfimages -all /work/project/in.pdf /work/project/img");
    allow("pdfimages -png -f 1 -l 2 /work/project/in.pdf img");
  });

  it("asks for pdfimages shape violations", () => {
    ask("pdfimages /work/project/in.pdf");
    ask("pdfimages -list /work/project/in.pdf img");
    ask("pdfimages -j /work/project/in.pdf /etc/img");
  });

  it("allows scratch-root outputs (ADR-0006 strict-descendant rule)", () => {
    const ctx = { ...context(), scratchRoots: ["/work/scratch"] };
    const verdicts = [
      "pdftotext -layout /work/project/in.pdf /work/scratch/o.txt",
      "pdftoppm -png -r 120 /work/project/in.pdf /work/scratch/o",
      "pdfimages -png /work/project/in.pdf /work/scratch/img",
    ].map((source) => analyzeWorkspacePolicy(source, ctx).action);
    expect(verdicts, "scratch outputs allow").toEqual([
      "allow",
      "allow",
      "allow",
    ]);
    expect(
      analyzeWorkspacePolicy(
        "pdftoppm -png /work/project/in.pdf /work/scratch",
        ctx,
      ).action,
      "root at the scratch boundary writes artifacts outside it",
    ).toBe("ask");
    expect(
      analyzeWorkspacePolicy("pdftoppm -png /work/project/in.pdf /work/project", {
        ...context(),
      }).action,
      "root at the workspace boundary writes artifacts outside it",
    ).toBe("ask");
  });
});
