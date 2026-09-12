// jsdom implements no `matchMedia`, and xterm.js calls it.
//
// xterm's renderer asks `matchMedia(\`(resolution: ${dpr}dppx)\`)` and
// listens for the change, so it can redraw when a window moves between
// displays of different pixel densities. In a browser that is fine; under
// jsdom the property simply is not there, and the call throws — from inside
// xterm's constructor, asynchronously, where no test's own try/catch can
// reach it. Vitest reports it as an unhandled error and fails the run even
// though every assertion passed, which is precisely the "false positive"
// state its warning is about.
//
// The stub is deliberately inert: it reports "does not match" and never
// fires a change. No test asserts anything about device pixel ratio — that
// is one of the things testing.md lists as invisible here — so a stub that
// answered otherwise would be inventing behaviour rather than allowing the
// terminal to be constructed at all.
if (typeof window !== "undefined" && window.matchMedia === undefined) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}
