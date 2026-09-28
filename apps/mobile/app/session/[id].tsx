import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, Text } from "react-native";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { WIDE_REDIRECT_METHOD, wideRedirectFor } from "@/lib/session-nav";
import { sessionRouteId } from "@/lib/session-screen";
import { theme } from "@/lib/theme";
import { useLayoutClass } from "@/lib/use-layout-class";
import { SessionDetail } from "@/screens/SessionDetail";

// A phone shows the session full screen; a wide screen shows it in the
// sessions split instead (a deep link, or a phone rotated into a tablet
// layout), leaving this screen by `dismissTo` so Back never returns here.
export default function SessionScreen() {
  const id = sessionRouteId(useLocalSearchParams().id);
  const language = useLanguage();
  const router = useRouter();
  const { kind } = useLayoutClass();
  const focused = useIsFocused();
  const redirect = wideRedirectFor(kind, id);
  // Only while this screen is on top: a session route buried under Changes
  // or Transcript must not pop them when the window widens. It redirects
  // once the user comes back to it.
  useEffect(() => {
    if (focused && redirect !== undefined) router[WIDE_REDIRECT_METHOD](redirect);
  }, [focused, redirect, router]);
  // Never mount the detail here while redirecting: the split mounts its own.
  if (redirect !== undefined) return null;
  if (id === undefined) return <Text style={styles.status}>{t(language, "session.notFound")}</Text>;
  return <SessionDetail key={id} id={id} embedded={false} />;
}

const styles = StyleSheet.create({
  status: {
    color: theme.colors.warning,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontFamily: theme.font.body,
    fontSize: 12,
  },
});
