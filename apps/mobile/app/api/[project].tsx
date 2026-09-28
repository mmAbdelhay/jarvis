import { useLocalSearchParams } from "expo-router";
import { WidePanel } from "@/components/WidePanel";
import { WideShell } from "@/components/WideShell";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { ApiScreen } from "@/screens/ApiScreen";

export default function ApiRoute() {
  const language = useLanguage();
  const { project } = useLocalSearchParams<{ project: string }>();
  const projectName = typeof project === "string" ? project : "";
  // Wide layout: inside the shell as a centred panel (the Workspace tab
  // shows the same screen inline).
  return (
    <WideShell>
      <WidePanel title={projectName || t(language, "api.title")}>
        <ApiScreen project={projectName} embedded={false} />
      </WidePanel>
    </WideShell>
  );
}
