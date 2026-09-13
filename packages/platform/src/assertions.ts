// Evaluates the `assert` block of a Bruno request against a response.
//
// This is deliberately not a script engine. Bruno's assertions are a small
// declarative language — a path, an operator, an operand — and running them
// needs no sandbox, no `eval` and no network. Scripts (`script:pre-request`
// and friends) are the thing that would, and they stay unexecuted; see the
// spec. Assertions being cheap and safe is exactly why they are worth
// running when scripts are not.

export type AssertionInput = { name?: string; value?: string; enabled?: boolean };

export type AssertionResult = {
  /** The left-hand side as written, e.g. `res.status`. */
  target: string;
  /** The operator and operand as written, e.g. `eq 200`. */
  expression: string;
  passed: boolean;
  /** What the target actually resolved to, for a failure to be readable. */
  actual: string;
};

export type AssertionSubject = {
  status: number;
  headers: Record<string, string>;
  body: string;
  timeMs: number;
};

/** Resolves `res.status`, `res.body.a.b`, `res.headers.content-type`,
 *  `res.responseTime`. An unknown path resolves to undefined, which fails
 *  every operator except isUndefined — which is the honest outcome. */
function resolveTarget(target: string, subject: AssertionSubject): unknown {
  const path = target.trim();
  if (path === "res.status") return subject.status;
  if (path === "res.responseTime") return subject.timeMs;

  if (path.startsWith("res.headers.")) {
    const name = path.slice("res.headers.".length).toLowerCase();
    const found = Object.entries(subject.headers).find(([key]) => key.toLowerCase() === name);
    return found?.[1];
  }

  if (path === "res.body" || path.startsWith("res.body.")) {
    let value: unknown;
    try {
      value = JSON.parse(subject.body);
    } catch {
      // A non-JSON body is still assertable as a whole.
      return path === "res.body" ? subject.body : undefined;
    }
    if (path === "res.body") return value;
    for (const segment of path.slice("res.body.".length).split(".")) {
      if (typeof value !== "object" || value === null) return undefined;
      value = (value as Record<string, unknown>)[segment];
    }
    return value;
  }

  return undefined;
}

const NUMERIC = new Set(["gt", "gte", "lt", "lte"]);

function compare(operator: string, actual: unknown, operand: string): boolean {
  const text = actual === undefined || actual === null ? "" : String(actual);

  if (NUMERIC.has(operator)) {
    const left = Number(actual);
    const right = Number(operand);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (operator === "gt") return left > right;
    if (operator === "gte") return left >= right;
    if (operator === "lt") return left < right;
    return left <= right;
  }

  switch (operator) {
    case "eq":
      // Loose on purpose: an assertion is written as text, so `eq 200`
      // must match the number 200 that came back on the wire.
      return text === operand;
    case "neq":
      return text !== operand;
    case "contains":
      return text.includes(operand);
    case "notContains":
      return !text.includes(operand);
    case "matches":
      try {
        return new RegExp(operand).test(text);
      } catch {
        return false;
      }
    case "startsWith":
      return text.startsWith(operand);
    case "endsWith":
      return text.endsWith(operand);
    case "isDefined":
      return actual !== undefined;
    case "isUndefined":
      return actual === undefined;
    case "isNull":
      return actual === null;
    case "isEmpty":
      return text === "";
    case "isNotEmpty":
      return text !== "";
    case "isTruthy":
      return Boolean(actual);
    case "isFalsy":
      return !actual;
    default:
      return false;
  }
}

/** Runs a request's assert block. A disabled assertion is skipped entirely
 *  rather than reported as passing, which would be a claim nobody checked. */
export function evaluateAssertions(
  assertions: readonly AssertionInput[],
  subject: AssertionSubject,
): AssertionResult[] {
  const results: AssertionResult[] = [];

  for (const assertion of assertions) {
    if (assertion.enabled === false || assertion.name === undefined) continue;
    const expression = (assertion.value ?? "").trim();
    const [operator = "", ...rest] = expression.split(/\s+/);
    const operand = rest.join(" ");
    const actual = resolveTarget(assertion.name, subject);

    results.push({
      target: assertion.name,
      expression,
      passed: compare(operator, actual, operand),
      actual:
        actual === undefined
          ? "undefined"
          : String(typeof actual === "object" ? JSON.stringify(actual) : actual),
    });
  }

  return results;
}
