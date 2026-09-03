/**
 * The messaging driver a project's Chat tab uses. Adding a provider is one
 * row in CHAT_DRIVERS below and one more option in the Settings picker —
 * nothing dispatches on the driver name anywhere else.
 */
export type ChatDriver = "slack" | "teams";

/** One chat destination of one project.
 *
 *  `account` names *which* org, and is deliberately one field rather than a
 *  `workspace:` for Slack and a `tenant:` for Teams: two fields would each
 *  be dead for the other driver, and a dead key in a hand-edited config is
 *  an invitation to fill it in.
 *
 *  There is deliberately no token, key or `tokenEnv` here. A chat tab is a
 *  hosted page and it authenticates the way every other page in that
 *  project's browser does — through the project's own Chromium partition —
 *  so a secret-shaped key with nothing reading it would be a lie in a file
 *  Settings rewrites on every save. */
export type ChatEntry = {
  name: string;
  driver: ChatDriver;
  account?: string;
};

/** Keyed by project name, exactly as `databases:`, `editors:`, `clusters:`
 *  and `docker:` are. */
export type ChatConfig = Record<string, ChatEntry[]>;

/**
 * Where each driver opens, with and without an account.
 *
 * Both no-account URLs are the provider's own picker rather than an error:
 * a user with one Slack workspace or one Teams tenant lands in it anyway,
 * and having to look up a subdomain before the tab opens at all would make
 * the simplest case the fiddliest.
 *
 * `<account>.slack.com` rather than `app.slack.com/client/<id>`: the team
 * id that second form needs is not something anyone knows by heart, while
 * the subdomain is the one every Slack user can type. Slack redirects it
 * into the client itself.
 */
export const CHAT_DRIVERS: Record<ChatDriver, { label: string; url(account?: string): string }> = {
  slack: {
    label: "Slack",
    url: (account) =>
      account === undefined
        ? "https://app.slack.com/client"
        : `https://${encodeURIComponent(account)}.slack.com/`,
  },
  teams: {
    label: "Teams",
    url: (account) =>
      account === undefined
        ? "https://teams.microsoft.com/"
        : `https://teams.microsoft.com/?tenantId=${encodeURIComponent(account)}`,
  },
};

/** Whether `value` names a driver this build knows. The config parser and
 *  the Settings picker both ask, so the table stays the single source of
 *  which drivers exist. */
export function isChatDriver(value: unknown): value is ChatDriver {
  return typeof value === "string" && Object.hasOwn(CHAT_DRIVERS, value);
}

/** The URL an entry opens. Pure — the tab is an ordinary hosted page, so
 *  there is no server to start and nothing to inject. */
export function chatUrl(entry: ChatEntry): string {
  return CHAT_DRIVERS[entry.driver].url(entry.account);
}
