import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, Text } from "react-native";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { WIDE_REDIRECT_METHOD } from "@/lib/session-nav";
import { sessionRouteId } from "@/lib/session-screen";
import { theme } from "@/lib/theme";
import { useLayoutClass } from "@/lib/use-layout-class";
import { workspaceRedirectFor } from "@/lib/workspace-tabs";
import { TerminalPane } from "@/screens/TerminalPane";

// A phone shows the pane full screen; a wide screen shows it inline in the
// Workspace instead (a deep link, or a phone rotated into a tablet layout),
// leaving this screen by `dismissTo` so Back never returns here. Route ids
// are opaque strings, validated here and against the pane inventory by
// the pane itself before it subscribes to anything.
export default function TerminalPaneScreen() {
  const params = useLocalSearchParams<{ paneKey: string; tabId: string }>();
  const paneKey = sessionRouteId(params.paneKey);
  const tabId = sessionRouteId(params.tabId);
  const language = useLanguage();
  const router = useRouter();
  const { kind } = useLayoutClass();
  const focused = useIsFocused();
  const redirect = workspaceRedirectFor(kind, tabId, paneKey);
  // Only while this screen is on top, as the session route does.
  useEffect(() => {
    if (focused && redirect !== undefined) router[WIDE_REDIRECT_METHOD](redirect);
  }, [focused, redirect, router]);
  // Never attach here while redirecting: the Workspace mounts its own pane.
  if (redirect !== undefined) return null;
  if (paneKey === undefined || tabId === undefined) {
    return <Text style={styles.status}>{t(language, "terminal.notFound")}</Text>;
  }
  return <TerminalPane paneKey={paneKey} tabId={tabId} embedded={false} />;
}

const styles = StyleSheet.create({
  status: { color: theme.colors.warning, padding: theme.spacing.sm },
});
