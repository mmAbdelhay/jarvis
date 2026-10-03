import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { canResume, noticeText, resumeSession } from "@/lib/laptop-actions";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import { theme } from "@/lib/theme";
import { openWorkspaceTab, terminalTargetFromElsewhere } from "@/lib/workspace-tabs";

/**
 * Resume a finished session: the laptop opens a terminal tab running the
 * agent's resume command, and this opens that tab the way any laptop
 * terminal opens from outside the Workspace (the terminal route, which a
 * wide screen redirects to the Workspace tab). Renders
 * nothing for a session that has not ended.
 */
export function ResumeButton(props: {
  sessionId: string;
  project: string | null | undefined;
  state: string | undefined;
}) {
  const language = useLanguage();
  const client = useRpcClient();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  if (!canResume(props.state)) return null;

  async function resume(): Promise<void> {
    setBusy(true);
    setError(undefined);
    const outcome = await resumeSession(client, props.sessionId, props.project);
    setBusy(false);
    if (!outcome.ok) {
      setError(noticeText(language, outcome.text));
      return;
    }
    openWorkspaceTab(router, terminalTargetFromElsewhere(outcome.tabId));
  }

  return (
    <View style={styles.box}>
      <TouchableOpacity
        accessibilityRole="button"
        disabled={busy}
        onPress={() => void resume()}
        style={[styles.button, busy && styles.dim]}
      >
        <Text style={styles.text}>{t(language, busy ? "resume.busy" : "resume.action")}</Text>
      </TouchableOpacity>
      {error !== undefined && (
        <Text selectable style={styles.error}>
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 6, alignItems: "flex-start" },
  button: {
    minHeight: 40,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: theme.colors.accentSoft,
  },
  text: { color: theme.colors.accentText, fontFamily: theme.font.bold, fontSize: 13 },
  dim: { opacity: 0.5 },
  error: { color: theme.colors.danger, fontFamily: theme.font.body, fontSize: 12 },
});
