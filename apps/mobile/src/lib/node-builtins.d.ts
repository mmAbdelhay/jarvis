// Minimal ambient shapes for the handful of Node builtins a test file needs
// (rtl-lint.test.ts, which greps app/ and src/components/, and
// terminal-html.test.ts, which regenerates the terminal page from its real
// inputs to prove the committed generated file is current — both only ever
// run under Vitest's Node environment, never bundled by Metro), plus
// `app.config.ts` itself (M10 Task 5): also Node-only, evaluated only by
// the Expo CLI's config loader, never bundled by Metro either. Kept
// narrow and local rather than adding a real `@types/node` dependency,
// which would pull in ambient globals (`process`, `Buffer`, ...) this RN
// app has no business seeing.

declare module "node:fs" {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: string): string;
  export function statSync(path: string): { isDirectory(): boolean };
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string, encoding?: string): { digest(encoding: string): string };
  };
}

declare module "node:module" {
  export function stripTypeScriptTypes(
    source: string,
    options?: { mode?: "strip" | "transform" },
  ): string;
}
