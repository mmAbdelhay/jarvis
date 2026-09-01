import { createContext, runInContext } from "node:vm";

// Runs a request's pre-request and post-response scripts, and its `tests`
// block.
//
// **On trust.** These scripts come out of the user's own repository, and this
// application already runs that repository's code in ways nothing here makes
// worse: the Terminal tab is a login shell in the project directory, the
// Editor tab is a full VS Code, and the agents Jarvis exists to run execute
// whatever they are asked to. A .bru script is not a new trust boundary, and
// pretending otherwise by refusing to run it — while a terminal sits one tab
// away — would be theatre rather than safety.
//
// What this does provide is *containment against accident*: a curated global
// object rather than the main process's own, and a wall-clock timeout so an
// endless loop in a script cannot take the window with it. node:vm is not a
// security sandbox and is not treated as one.

export type ScriptResult = {
  /** Variables the script set, to be merged into the request's variables. */
  variables: Record<string, string>;
  /** console.log output, shown beside the response. */
  logs: string[];
  /** Assertions the `tests` block declared, with their outcomes. */
  tests: { name: string; passed: boolean; error?: string }[];
  /** A script that threw. The request still happened; this is reported, not
   *  raised, because a broken post-response script must not hide a response
   *  that arrived. */
  error?: string;
};

export type ScriptRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

export type ScriptResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  responseTime: number;
};

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * The `bru`, `req` and `res` objects a Bruno script expects, plus a console
 * that collects rather than prints. Deliberately narrow: a script reaching
 * for something absent gets a clear ReferenceError, which is a better failure
 * than silently doing nothing.
 */
function buildContext(
  variables: Record<string, string>,
  request: ScriptRequest,
  response: ScriptResponse | undefined,
  logs: string[],
  tests: ScriptResult["tests"],
): Record<string, unknown> {
  const setVariables: Record<string, string> = {};

  const bru = {
    getVar: (name: string) => setVariables[name] ?? variables[name],
    setVar: (name: string, value: unknown) => {
      setVariables[name] = String(value);
    },
    getEnvVar: (name: string) => variables[name],
    setEnvVar: (name: string, value: unknown) => {
      setVariables[name] = String(value);
    },
    // Bruno's own helpers that make sense without a runner around them.
    interpolate: (text: string) =>
      text.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (match, name: string) => setVariables[name] ?? variables[name] ?? match),
  };

  const console = {
    log: (...args: unknown[]) => logs.push(args.map(format).join(" ")),
    error: (...args: unknown[]) => logs.push(args.map(format).join(" ")),
    warn: (...args: unknown[]) => logs.push(args.map(format).join(" ")),
  };

  /**
   * A minimal expect(), enough for the assertions a .bru `tests` block
   * actually contains. Chai is not vendored for this.
   *
   * The no-argument assertions — `.to.exist`, `.to.be.true`, `.to.be.null` —
   * are **getters**, because that is how they are written in chai and
   * therefore how they are written in every .bru file. As plain functions
   * they would be read and never called, and an assertion that is never
   * called is an assertion that always passes: the worst possible bug in a
   * thing whose job is to tell you when something is wrong.
   */
  const expect = (actual: unknown) => {
    const check = (passed: boolean, message: string): void => {
      if (!passed) throw new Error(message);
    };

    const be = {
      a: (type: string) => check(typeof actual === type, `expected ${format(actual)} to be a ${type}`),
      an: (type: string) => check(typeof actual === type, `expected ${format(actual)} to be an ${type}`),
      above: (value: number) => check(Number(actual) > value, `expected ${format(actual)} to be above ${value}`),
      below: (value: number) => check(Number(actual) < value, `expected ${format(actual)} to be below ${value}`),
      get null() {
        check(actual === null, `expected ${format(actual)} to be null`);
        return undefined;
      },
      get undefined() {
        check(actual === undefined, `expected ${format(actual)} to be undefined`);
        return undefined;
      },
      get true() {
        check(actual === true, `expected ${format(actual)} to be true`);
        return undefined;
      },
      get false() {
        check(actual === false, `expected ${format(actual)} to be false`);
        return undefined;
      },
      get empty() {
        const length = (actual as { length?: number })?.length;
        check(
          actual === "" || length === 0 || (typeof actual === "object" && actual !== null && Object.keys(actual).length === 0),
          `expected ${format(actual)} to be empty`,
        );
        return undefined;
      },
    };

    return {
      to: {
        equal: (expected: unknown) =>
          check(actual === expected, `expected ${format(actual)} to equal ${format(expected)}`),
        eql: (expected: unknown) =>
          check(
            JSON.stringify(actual) === JSON.stringify(expected),
            `expected ${format(actual)} to deeply equal ${format(expected)}`,
          ),
        match: (pattern: RegExp) =>
          check(pattern.test(String(actual)), `expected ${format(actual)} to match ${String(pattern)}`),
        include: (value: unknown) =>
          check(String(actual).includes(String(value)), `expected ${format(actual)} to include ${format(value)}`),
        contain: (value: unknown) =>
          check(String(actual).includes(String(value)), `expected ${format(actual)} to contain ${format(value)}`),
        be,
        get exist() {
          check(actual !== undefined && actual !== null, `expected ${format(actual)} to exist`);
          return undefined;
        },
        have: {
          property: (name: string) =>
            check(
              typeof actual === "object" && actual !== null && name in actual,
              `expected ${format(actual)} to have property ${name}`,
            ),
          length: (value: number) =>
            check(
              (actual as { length?: number })?.length === value,
              `expected length ${(actual as { length?: number })?.length} to be ${value}`,
            ),
        },
      },
    };
  };

  const test = (name: string, body: () => void): void => {
    try {
      body();
      tests.push({ name, passed: true });
    } catch (error) {
      tests.push({ name, passed: false, error: messageOf(error) });
    }
  };

  return {
    bru,
    req: request,
    ...(response === undefined ? {} : { res: response }),
    console,
    expect,
    test,
    it: test,
    setVariables,
  };
}

/** An error thrown inside the vm belongs to that context's realm, so it is
 *  not an `instanceof` this one's Error — reading the message directly is
 *  what keeps "boom" from being reported as "Error: boom". */
function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Runs one script body. Everything it can go wrong with — a throw, a syntax
 *  error, an endless loop — is reported rather than raised. */
export function runScript(
  code: string,
  options: {
    variables: Record<string, string>;
    request: ScriptRequest;
    response?: ScriptResponse;
    timeoutMs?: number;
  },
): ScriptResult {
  const logs: string[] = [];
  const tests: ScriptResult["tests"] = [];
  if (code.trim() === "") return { variables: {}, logs, tests };

  const sandbox = buildContext(options.variables, options.request, options.response, logs, tests);
  const context = createContext(sandbox);

  try {
    runInContext(code, context, { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } catch (error) {
    return {
      variables: sandbox["setVariables"] as Record<string, string>,
      logs,
      tests,
      error: messageOf(error),
    };
  }

  return { variables: sandbox["setVariables"] as Record<string, string>, logs, tests };
}
