import { describe, it } from "vitest";
import { allow, ask } from "../policy/helpers";

describe("textutil profile", () => {
  it("allows stdout-only conversion", () => {
    allow("textutil -convert txt -stdout notes.docx");
    allow("textutil -convert html -stdout notes.rtf");
    allow("textutil -stdout -convert txt notes.docx");
    allow("textutil -convert txt -stdout a.docx b.docx");
    allow("textutil -convert docx -stdout /etc/hosts");
    allow("textutil -help");
  });

  it("asks for every writing shape", () => {
    ask("textutil -convert txt notes.docx");
    ask("textutil -convert txt -output out.txt notes.docx");
    ask("textutil -convert txt -o out.txt notes.docx");
    ask("textutil -cat rtf -output out.rtf a.rtf b.rtf");
    ask("textutil -stdout notes.docx");
    ask("textutil -convert txt -stdout");
    ask("textutil -convert pdf -stdout notes.docx");
    ask("textutil -convert txt -stdout $FILE");
    ask("textutil -convert txt -stdout notes.docx && rm -rf .git");
  });
});
