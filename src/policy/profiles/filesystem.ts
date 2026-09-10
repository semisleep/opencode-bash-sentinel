import type { SyntaxNode } from "../../parser/node";
import type { Invocation, UnitSeed } from "../types";
import { recognizeFilesystemMetadata } from "./filesystem/metadata";
import { recognizeFilesystemReader } from "./filesystem/readers";
import { recognizeFilesystemRemoval } from "./filesystem/removals";
import { recognizeFilesystemTransfer } from "./filesystem/transfers";
import { recognizeFilesystemWriter } from "./filesystem/writers";

export function recognizeFilesystem(
  node: SyntaxNode,
  invocation: Invocation,
  name: string,
): UnitSeed | undefined {
  return (
    recognizeFilesystemReader(node, invocation, name) ??
    recognizeFilesystemRemoval(node, invocation, name) ??
    recognizeFilesystemWriter(node, invocation, name) ??
    recognizeFilesystemMetadata(node, invocation, name) ??
    recognizeFilesystemTransfer(node, invocation, name)
  );
}
