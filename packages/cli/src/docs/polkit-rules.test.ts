// The polkit rules Rafiq ships (threat model M33): evaluated the way polkitd
// does (addRule callbacks in order, first non-null result wins) for a subject
// outside any logind session, like jarvisd's tools. The packaging suite
// (os/packaging/tests/test-settings-polkit.sh) checks the same files in the
// built packages; this runs in every CI job.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const SETTINGS_RULES = "os/packaging/jarvis-settings/51-jarvis-settings.rules";
const HELPER_RULES = "os/packaging/jarvis-helper/50-jarvis.rules";

type Rule = (action: unknown, subject: unknown) => unknown;

function evaluate(path: string, actionId: string, groups: readonly string[]): string {
  const rules: Rule[] = [];
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
    addRule: (rule: Rule) => rules.push(rule),
    addAdminRule: () => {},
    log: () => {},
    spawn: () => {
      throw new Error("rules must not spawn processes");
    },
  };
  vm.runInNewContext(readFileSync(join(REPO, path), "utf8"), { polkit });
  const member = new Set(groups);
  const subject = {
    user: "tester",
    local: false,
    active: false,
    session: "",
    isInGroup: (group: string) => member.has(group),
    isInNetGroup: () => false,
  };
  const action = { id: actionId, lookup: () => undefined };
  for (const rule of rules) {
    const result = rule(action, subject);
    if (result !== null && result !== undefined) return String(result);
  }
  return "not_handled";
}

const SETTINGS_GRANTS = [
  "org.freedesktop.NetworkManager.enable-disable-wifi",
  "org.freedesktop.UPower.PowerProfiles.switch-profile",
  "net.hadess.PowerProfiles.switch-profile",
  "org.freedesktop.udisks2.filesystem-mount",
  "org.freedesktop.udisks2.eject-media",
  "org.freedesktop.udisks2.power-off-drive",
];

describe("polkit rules (Rafiq M3 contracts §5.5, §5.16)", () => {
  it("51-jarvis-settings.rules grants jarvis-admins exactly the six settings actions", () => {
    for (const action of SETTINGS_GRANTS) {
      expect(evaluate(SETTINGS_RULES, action, ["jarvis-admins"]), action).toBe("yes");
      expect(evaluate(SETTINGS_RULES, action, ["users", "sudo"]), action).toBe("not_handled");
    }
  });

  it("51-jarvis-settings.rules never grants formatting, system disks or the helper admin action", () => {
    for (const action of [
      "os.jarvis.helper.admin",
      "os.jarvis.helper.packages",
      "org.freedesktop.udisks2.modify-device",
      "org.freedesktop.udisks2.modify-device-system",
      "org.freedesktop.udisks2.filesystem-mount-system",
      "org.freedesktop.udisks2.open-device",
      "org.freedesktop.udisks2.loop-setup",
      "org.freedesktop.NetworkManager.settings.modify.system",
      "org.freedesktop.login1.power-off",
      "org.freedesktop.policykit.exec",
    ]) {
      expect(evaluate(SETTINGS_RULES, action, ["jarvis-admins"]), action).toBe("not_handled");
    }
  });

  it("50-jarvis.rules grants the helper's actions to jarvis-admins only", () => {
    for (const action of [
      "os.jarvis.helper.packages",
      "os.jarvis.helper.services",
      "os.jarvis.helper.admin",
    ]) {
      expect(evaluate(HELPER_RULES, action, ["jarvis-admins"]), action).toBe("yes");
      expect(evaluate(HELPER_RULES, action, ["users", "sudo"]), action).toBe("not_handled");
    }
    expect(evaluate(HELPER_RULES, "org.freedesktop.policykit.exec", ["jarvis-admins"])).toBe(
      "not_handled",
    );
  });
});
