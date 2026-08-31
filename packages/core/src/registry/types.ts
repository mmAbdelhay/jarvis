/**
 * Which public status page speaks for this account's provider. Used only to
 * pick a Statuspage URL — it says nothing about whether capacity is readable
 * (that is `configDir`).
 */
export type ProviderVendor = "anthropic" | "github" | "openai";

export type AgentConfig = {
  id: string;
  command: string;
  args?: string[];
  model?: string;
  default?: boolean;
  /**
   * The `CLAUDE_CONFIG_DIR` this account's wrapper sets (e.g.
   * `~/.claude-acme`). Its presence is what makes this account's
   * remaining capacity readable at all: the Agent SDK is pointed at this
   * directory to read the rate-limit windows for *that* account. Absent for
   * agents with no such directory (GitHub Copilot), whose capacity is then
   * honestly reported as unknown rather than guessed.
   */
  configDir?: string;
  vendor?: ProviderVendor;
};

export type RoutingRule = {
  match: { project?: string; intent?: string };
  agent: string;
};

export type RegistryConfig = {
  agents: Record<string, Omit<AgentConfig, "id">>;
  routing?: RoutingRule[];
};

export type ResolveRequest = {
  explicitAgent?: string;
  project?: string;
  intent?: string;
};
