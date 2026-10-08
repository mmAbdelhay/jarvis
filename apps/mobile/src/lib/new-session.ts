// "New" on the Sessions screen. The laptop has no channel that starts an
// agent, so New opens a terminal in a project (the same call the Home
// project tiles use) or hands over to Jarvis by voice. This loads the
// project choices for the sheet.
import { type ProjectSummary, parseProjects } from "./dashboard-store";
import type { RpcClient } from "./rpc-client";

export type ProjectChoices = { ok: true; projects: ProjectSummary[] } | { ok: false };

export async function loadProjectChoices(client: Pick<RpcClient, "call">): Promise<ProjectChoices> {
  const result = await client.call("projects:list", [], { whenNotOpen: "reject" });
  if (!result.ok) return { ok: false };
  return { ok: true, projects: parseProjects(result.value) };
}
