import type { TestCase } from "./contract.ts";
import {
  generateGoRunner,
  generatePythonRunner,
  generateTypeScriptRunner,
  type GenInput,
} from "./runner-gen.ts";

export type SupportedLanguage = "python" | "typescript" | "go";

export interface LanguageBackend {
  readonly language: SupportedLanguage;
  readonly extension: string;
  readonly runnerFile: string;
  readonly pistonLanguage: string;
  readonly ociImage: string;
  moduleFile(importName: string): string;
  generateRunner(input: GenInput): string;
  localCommand(files: string[]): { command: string; args: string[] };
  validateCases(cases: TestCase[]): void;
}

const ensureCalls = (language: string, cases: TestCase[]): void => {
  for (const testCase of cases) {
    if (!testCase.call || testCase.harness) {
      throw new Error(
        `${language} backend requires call/expect cases; invalid case '${testCase.name}'`,
      );
    }
  }
};

const BACKENDS: Record<SupportedLanguage, LanguageBackend> = {
  python: {
    language: "python",
    extension: ".py",
    runnerFile: "__runner.py",
    pistonLanguage: "python",
    ociImage:
      "docker.io/library/python@sha256:05b2b8b732ecd268fee8727a369f936f022d1321b59befd13c30ede22769dcdc",
    moduleFile: (name) => `${name}.py`,
    generateRunner: generatePythonRunner,
    localCommand: () => ({ command: "python3", args: ["__runner.py"] }),
    validateCases: (cases) => ensureCalls("python", cases),
  },
  typescript: {
    language: "typescript",
    extension: ".ts",
    runnerFile: "__runner.ts",
    pistonLanguage: "typescript",
    ociImage:
      "docker.io/library/node@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019",
    moduleFile: (name) => `${name}.ts`,
    generateRunner: generateTypeScriptRunner,
    localCommand: () => ({ command: process.execPath, args: ["__runner.ts"] }),
    validateCases: (cases) => ensureCalls("typescript", cases),
  },
  go: {
    language: "go",
    extension: ".go",
    runnerFile: "foundry_runner.go",
    pistonLanguage: "go",
    ociImage:
      "docker.io/library/golang@sha256:3eb6c2b3db8d55e38537302edb510b4417f8a115efbd5906d131ceba9468e29a",
    moduleFile: (name) => `${name}.go`,
    generateRunner: generateGoRunner,
    localCommand: (files) => ({ command: "go", args: ["run", ...files] }),
    validateCases: (cases) => ensureCalls("go", cases),
  },
};

export function languageBackend(language: string): LanguageBackend {
  if (!(language in BACKENDS)) {
    throw new Error(
      `unsupported language '${language}'; expected python, typescript, or go`,
    );
  }
  return BACKENDS[language as SupportedLanguage];
}

export function supportedLanguages(): SupportedLanguage[] {
  return Object.keys(BACKENDS) as SupportedLanguage[];
}
