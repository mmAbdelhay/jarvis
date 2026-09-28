import { useLocalSearchParams } from "expo-router";
import { WidePanel } from "@/components/WidePanel";
import { WideShell } from "@/components/WideShell";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { sessionRouteId } from "@/lib/session-screen";
import { ChangesScreen } from "@/screens/ChangesScreen";

export default function ChangesRoute() {
  const language = useLanguage();
  const sessionId = sessionRouteId(useLocalSearchParams().id);
  // Wide layout: inside the shell as a centred panel (the Workspace tab
  // shows the same screen inline).
  return (
    <WideShell>
      <WidePanel title={t(language, "changes.title")}>
        <ChangesScreen sessionId={sessionId} embedded={false} />
      </WidePanel>
    </WideShell>
  );
}
