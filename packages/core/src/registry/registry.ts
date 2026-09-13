import type { AgentConfig, RegistryConfig, ResolveRequest, RoutingRule } from "./types.js";

export class UnknownAgentError extends Error {}

export class AgentRegistry {
  readonly #agents: Map<string, AgentConfig>;
  readonly #routing: RoutingRule[];

  constructor(config: RegistryConfig) {
    this.#agents = new Map(
      Object.entries(config.agents).map(([id, agent]) => [id, { ...agent, id }]),
    );
    this.#routing = config.routing ?? [];
  }

  list(): AgentConfig[] {
    return [...this.#agents.values()];
  }

  get(id: string): AgentConfig | undefined {
    return this.#agents.get(id);
  }

  resolve(request: ResolveRequest): AgentConfig {
    if (request.explicitAgent !== undefined) {
      const explicit = this.#agents.get(request.explicitAgent);
      if (explicit === undefined) {
        throw new UnknownAgentError(`No agent named "${request.explicitAgent}"`);
      }
      return explicit;
    }

    for (const rule of this.#routing) {
      if (this.#matches(rule, request)) {
        const routed = this.#agents.get(rule.agent);
        if (routed === undefined) {
          throw new UnknownAgentError(`Routing rule points at unknown agent "${rule.agent}"`);
        }
        return routed;
      }
    }

    const fallback = this.list().find((agent) => agent.default === true);
    if (fallback === undefined) {
      throw new UnknownAgentError("No agent matched and no default is configured");
    }
    return fallback;
  }

  #matches(rule: RoutingRule, request: ResolveRequest): boolean {
    const { project, intent } = rule.match;
    if (project !== undefined && project !== request.project) return false;
    if (intent !== undefined && intent !== request.intent) return false;
    return project !== undefined || intent !== undefined;
  }
}
