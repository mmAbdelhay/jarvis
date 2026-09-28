// Wide layout (2026-09-28 spec §3): the frames a secondary page and a
// sign-in screen get on a wide screen. The widths live in wide-panel.ts.
//
// Both keep the same wrapper tree on a phone and on a wide screen (only
// styles and the panel header change), so crossing the breakpoint never
// remounts the page inside.

import { useRouter } from "expo-router";
import type React from "react";
import {
  type StyleProp,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ViewStyle,
} from "react-native";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { theme } from "@/lib/theme";
import { useLayoutClass } from "@/lib/use-layout-class";
import { textDirection } from "@/lib/voice-screen";
import { authCardFrame, widePanelFrame } from "@/lib/wide-panel";

/** A secondary page: full screen on a phone; on a wide screen a centred,
 *  bordered panel (max 1180) under the shell's top bar. The native stack
 *  header is hidden there, so `title` draws the panel's own header, with a
 *  Back button whenever there is somewhere to go back to. */
export function WidePanel(props: { title?: string; children: React.ReactNode }) {
  const layout = useLayoutClass();
  const frame = widePanelFrame(layout.kind);
  return (
    <View style={[styles.root, frame.framed && styles.rootFramed]}>
      <View
        style={[styles.panel, frame.framed && styles.panelFramed, { maxWidth: frame.maxWidth }]}
      >
        {frame.framed && props.title !== undefined && <PanelHeader title={props.title} />}
        {props.children}
      </View>
    </View>
  );
}

function PanelHeader(props: { title: string }) {
  const language = useLanguage();
  const router = useRouter();
  return (
    <View style={[styles.header, { direction: textDirection(language) }]}>
      {router.canGoBack() && (
        <TouchableOpacity
          style={styles.back}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t(language, "common.back")}
        >
          <Text style={styles.backText}>{language === "ar" ? "›" : "‹"}</Text>
        </TouchableOpacity>
      )}
      <Text style={styles.title} numberOfLines={1}>
        {props.title}
      </Text>
    </View>
  );
}

/** Unlock and pair: full screen on a phone; on a wide screen a centred card
 *  (max 480) as tall as its content. The page's root adds
 *  `useAuthCardRootStyle()`, since its phone `flex: 1` would collapse to
 *  nothing inside a card that sizes to its content. */
export function AuthCard(props: { children: React.ReactNode }) {
  const layout = useLayoutClass();
  const frame = authCardFrame(layout.kind);
  return (
    <View style={[styles.root, frame.framed && styles.cardRoot]}>
      <View style={[styles.panel, frame.framed && styles.card, { maxWidth: frame.maxWidth }]}>
        {props.children}
      </View>
    </View>
  );
}

/** The auth page root's override on a wide screen: size to the content
 *  (shrinking, and so scrolling, when the window is shorter). */
export function useAuthCardRootStyle(): StyleProp<ViewStyle> {
  const layout = useLayoutClass();
  return authCardFrame(layout.kind).framed ? styles.cardContent : undefined;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  rootFramed: {
    backgroundColor: theme.colors.ground,
    paddingHorizontal: theme.spacing.gutter,
    paddingVertical: 16,
  },
  panel: { flex: 1, width: "100%" },
  panelFramed: {
    alignSelf: "center",
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.card,
    backgroundColor: theme.colors.background,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.hairline,
  },
  back: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.tiny,
    backgroundColor: theme.colors.surface,
  },
  backText: { color: theme.colors.textSecondary, fontSize: 18 },
  title: {
    flexShrink: 1,
    color: theme.colors.text,
    fontFamily: theme.font.semibold,
    fontSize: 15,
  },
  cardRoot: {
    backgroundColor: theme.colors.ground,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing.xl,
  },
  // The phone pages have no bottom padding of their own worth keeping in
  // a card (the screen edge was their end).
  cardContent: { flexGrow: 0, flexShrink: 1, flexBasis: "auto", paddingBottom: 24 },
  card: {
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: "auto",
    maxHeight: "100%",
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.card,
    backgroundColor: theme.colors.background,
    overflow: "hidden",
  },
});
