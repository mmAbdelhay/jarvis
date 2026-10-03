// Wide layout (2026-09-28 spec §3): the frames a secondary page and a
// sign-in screen get on a wide screen. The widths live in wide-panel.ts.
//
// Both keep the same wrapper tree on a phone and on a wide screen (only
// styles and the panel header change), so crossing the breakpoint never
// remounts the page inside.

import { useRouter } from "expo-router";
import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";
import {
  ScrollView,
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
import { authCardContentTop, authCardFrame, panelTitle, widePanelFrame } from "@/lib/wide-panel";

/** Lets the page inside a WidePanel replace the header title (see
 *  `useWidePanelTitle`). */
const PanelTitleContext = createContext<(title: string | undefined) => void>(() => {});

/** A secondary page: full screen on a phone; on a wide screen a centred,
 *  bordered panel (max 1180) under the shell's top bar. The native stack
 *  header is hidden there, so `title` draws the panel's own header, with a
 *  Back button whenever there is somewhere to go back to. */
export function WidePanel(props: {
  title?: string;
  /** No frame, header or width limit on a wide screen (a page that lays out
   *  its own panes); the wrapper tree stays the same. */
  bare?: boolean;
  children: React.ReactNode;
}) {
  const layout = useLayoutClass();
  const frame = props.bare ? widePanelFrame("phone") : widePanelFrame(layout.kind);
  const [pageTitle, setPageTitle] = useState<string | undefined>(undefined);
  return (
    <View style={[styles.root, frame.framed && styles.rootFramed]}>
      <View
        style={[styles.panel, frame.framed && styles.panelFramed, { maxWidth: frame.maxWidth }]}
      >
        {frame.framed && props.title !== undefined && (
          <PanelHeader title={panelTitle(props.title, pageTitle)} />
        )}
        <PanelTitleContext.Provider value={setPageTitle}>
          {props.children}
        </PanelTitleContext.Provider>
      </View>
    </View>
  );
}

/** The page's own title for the panel header on a wide screen, as the
 *  native stack header shows it on a phone (a transcript's session
 *  summary). `undefined` keeps the route's title. */
export function useWidePanelTitle(title: string | undefined): void {
  const setTitle = useContext(PanelTitleContext);
  useEffect(() => {
    setTitle(title);
    return () => setTitle(undefined);
  }, [setTitle, title]);
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
 *  (max 480) as tall as its content, scrolling when the window is shorter
 *  (an iPad in landscape with the pair scanner). The page's root adds
 *  `useAuthCardRootStyle()`, since its phone `flex: 1` would collapse to
 *  nothing inside a card that sizes to its content.
 *
 *  The ScrollView is there on a phone too, not scrolling and holding its
 *  content to the screen's height, so crossing the breakpoint keeps the same tree
 *  (no remount mid-pairing). Taps always reach the page, as with a View. */
export function AuthCard(props: { children: React.ReactNode }) {
  const layout = useLayoutClass();
  const frame = authCardFrame(layout.kind);
  return (
    <View style={[styles.root, frame.framed && styles.cardRoot]}>
      <View style={[styles.panel, frame.framed && styles.card, { maxWidth: frame.maxWidth }]}>
        <ScrollView
          style={frame.scrolls ? styles.cardScroll : styles.root}
          contentContainerStyle={frame.scrolls ? undefined : styles.fillContent}
          scrollEnabled={frame.scrolls}
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={frame.scrolls}
        >
          {props.children}
        </ScrollView>
      </View>
    </View>
  );
}

/** An auth page's content top padding: `phoneTop` (safe area included) on
 *  a phone, one theme step inside a wide card. */
export function useAuthCardContentTop(phoneTop: number): number {
  return authCardContentTop(useLayoutClass().kind, phoneTop);
}

/** The auth page root's override on a wide screen: size to the content
 *  (the card's ScrollView scrolls it when the window is shorter). */
export function useAuthCardRootStyle(): StyleProp<ViewStyle> {
  const layout = useLayoutClass();
  return authCardFrame(layout.kind).framed ? styles.cardContent : undefined;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  rootFramed: {
    backgroundColor: theme.colors.ground,
    paddingHorizontal: theme.spacing.gutter,
    paddingVertical: theme.spacing.md,
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
    gap: theme.spacing.sm,
    // The back button's height plus its padding, with or without it.
    minHeight: theme.spacing.xl + 2 * theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.hairline,
  },
  back: {
    width: theme.spacing.xl,
    height: theme.spacing.xl,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.tiny,
    backgroundColor: theme.colors.surface,
  },
  backText: { color: theme.colors.textSecondary, fontSize: theme.font.size.lg },
  title: {
    flexShrink: 1,
    color: theme.colors.text,
    fontFamily: theme.font.semibold,
    fontSize: theme.font.size.md,
  },
  cardRoot: {
    backgroundColor: theme.colors.ground,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing.xl,
  },
  // The phone pages have no bottom padding of their own worth keeping in
  // a card (the screen edge was their end).
  cardContent: { flexGrow: 0, flexShrink: 1, flexBasis: "auto", paddingBottom: theme.spacing.lg },
  // The card's body: as tall as the content, shrinking to the card (and so
  // scrolling) when the window is shorter.
  cardScroll: { flexGrow: 0, flexShrink: 1 },
  // A phone: exactly the screen's height, so the page's own `flex: 1` root
  // fills it and (unlock's ScrollView) scrolls a taller page. `flexGrow`
  // alone would let react-native-web's content container (`flex-shrink:
  // 0`) grow to the content and clip it in a phone browser (final review I1).
  fillContent: { flex: 1 },
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
