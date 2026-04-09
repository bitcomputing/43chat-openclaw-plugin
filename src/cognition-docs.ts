import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_COGNITION_DOCS_DIR = join(
  homedir(),
  "Documents/43x/code/chatbot43/app/docs/claude-skill4"
);

export type CognitionDocs = {
  cognition?: string;
  groups?: string;
  friends?: string;
};

export function loadCognitionDocs(docsDir: string): CognitionDocs {
  const docs: CognitionDocs = {};

  if (!existsSync(docsDir)) {
    return docs;
  }

  const files: Array<[string, keyof CognitionDocs]> = [
    ["cognition.md", "cognition"],
    ["groups.md", "groups"],
    ["friends.md", "friends"],
  ];

  for (const [filename, key] of files) {
    const path = join(docsDir, filename);
    if (existsSync(path)) {
      try {
        docs[key] = readFileSync(path, "utf-8");
      } catch {
        // Skip if read fails
      }
    }
  }

  return docs;
}
