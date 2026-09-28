import { useLocalSearchParams } from "expo-router";
import { WidePanel } from "@/components/WidePanel";
import { WideShell } from "@/components/WideShell";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { DockerScreen } from "@/screens/DockerScreen";

export default function DockerRoute() {
  const language = useLanguage();
  const { project } = useLocalSearchParams<{ project: string }>();
  // expo-router already decodes a dynamic segment before handing it back
  // (sidecars/[project].tsx's own note) — used as-is, never re-decoded.
  const projectName = typeof project === "string" ? project : "";
  // Wide layout: inside the shell as a centred panel (the Workspace tab
  // shows the same screen inline).
  return (
    <WideShell>
      <WidePanel title={projectName || t(language, "docker.title")}>
        <DockerScreen project={projectName} embedded={false} />
      </WidePanel>
    </WideShell>
  );
}
