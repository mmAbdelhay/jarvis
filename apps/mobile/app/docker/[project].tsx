import { useLocalSearchParams } from "expo-router";
import { DockerScreen } from "@/screens/DockerScreen";

export default function DockerRoute() {
  const { project } = useLocalSearchParams<{ project: string }>();
  // expo-router already decodes a dynamic segment before handing it back
  // (sidecars/[project].tsx's own note) — used as-is, never re-decoded.
  const projectName = typeof project === "string" ? project : "";
  return <DockerScreen project={projectName} embedded={false} />;
}
