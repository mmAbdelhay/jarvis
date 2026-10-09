#!/usr/bin/env node
// polkit-eval.mjs RULES ACTION GROUPS — evaluates a polkit JavaScript rules
// file the way polkitd does (addRule callbacks in order, first non-null
// result wins) for one action and a subject in GROUPS (comma-separated) that
// is outside any session, like jarvisd's tools. Prints the result or
// "not_handled".
import { readFileSync } from "node:fs";
import vm from "node:vm";

const [rulesPath, actionId, groups = ""] = process.argv.slice(2);
const rules = [];
const polkit = {
  Result: {
    NO: "no",
    YES: "yes",
    AUTH_SELF: "auth_self",
    AUTH_SELF_KEEP: "auth_self_keep",
    AUTH_ADMIN: "auth_admin",
    AUTH_ADMIN_KEEP: "auth_admin_keep",
    NOT_HANDLED: null,
  },
  addRule(fn) {
    rules.push(fn);
  },
  addAdminRule() {},
  log() {},
  spawn() {
    throw new Error("rules must not spawn processes");
  },
};
vm.runInNewContext(readFileSync(rulesPath, "utf8"), { polkit });
const member = new Set(groups.split(",").filter(Boolean));
const subject = {
  user: "tester",
  local: false,
  active: false,
  session: "",
  isInGroup: (g) => member.has(g),
  isInNetGroup: () => false,
};
const action = { id: actionId, lookup: () => undefined };
for (const rule of rules) {
  const result = rule(action, subject);
  if (result !== null && result !== undefined) {
    console.log(result);
    process.exit(0);
  }
}
console.log("not_handled");
