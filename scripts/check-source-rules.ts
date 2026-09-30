import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { checkSourceText, checkStrictJson, isSourceFile } from "../src/quality/source-rules.ts";

const sourceRoots = ["src", "scripts", "tests"];
const rootSourceFiles = ["vitest.config.ts", "vite.config.ts"];
const strictJsonFiles = [
  "tsconfig.json",
  "tsconfig.worker.json",
  "tsconfig.web.json",
  "package.json",
  "wrangler.json",
];
const ignoredDirectories = new Set(["node_modules", ".git", "generated", "graphify-out", "dist"]);

const collectTypeScriptFiles = (directory: string): readonly string[] => {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name)
        ? []
        : collectTypeScriptFiles(path.join(directory, entry.name));
    }
    return isSourceFile(entry.name) ? [path.join(directory, entry.name)] : [];
  });
};

const main = async (): Promise<number> => {
  const sourceFiles = sourceRoots
    .flatMap(collectTypeScriptFiles)
    .concat(rootSourceFiles.filter((file) => existsSync(file)))
    .sort();
  const violations: string[] = [];

  for (const file of sourceFiles) {
    const text = readFileSync(file, "utf8");
    for (const violation of checkSourceText(file, text)) {
      violations.push(
        `${file}:${violation.line}:${violation.column}: ${violation.rule}: ${violation.detail}`,
      );
    }
  }

  const checkedJson = strictJsonFiles.filter((file) => existsSync(file));
  for (const file of checkedJson) {
    const text = readFileSync(file, "utf8");
    for (const violation of checkStrictJson(text)) {
      violations.push(
        `${file}:${violation.line}:${violation.column}: ${violation.rule}: ${violation.detail}`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(violations.join("\n"));
    return 1;
  }

  console.log(
    `Source rules passed for ${sourceFiles.length} source files and ${checkedJson.length} configuration files.`,
  );
  return 0;
};

process.exitCode = await main();
