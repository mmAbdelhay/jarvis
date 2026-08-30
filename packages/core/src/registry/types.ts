export type AgentConfig = {
  id: string;
  command: string;
  args?: string[];
  model?: string;
  default?: boolean;
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
