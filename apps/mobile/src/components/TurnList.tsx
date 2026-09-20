// The Voice screen's conversation view (Task 8, rule 6): the controller's
// `turns` are already ordered oldest-to-newest and de-duplicated
// (turns.ts's `mergeTurns`), so this component only renders them — newest
// naturally lands at the bottom. Turn text is server-originated and shown
// verbatim, each bubble's `writingDirection` following its own turn's
// language rather than the app's current language (a mixed-language
// conversation renders each line in its own direction).
//
// Fix round (2026-09-19 redesign), item 4: the redesign dropped the
// visible "You"/"Jarvis" role label the pre-redesign bubbles had — the
// board itself never shows one (role reads from bubble side/colour alone),
// but that leaves screen-reader users and RTL layouts (which can't rely on
// left/right position) with no cue at all. `accessibilityLabel` restores
// the cue without adding back the visible text: the whole bubble becomes
// one accessible element announcing "You: <message>"/"Jarvis: <message>",
// via the same `voice.you`/`voice.jarvis` strings the old visible label
// used. A spoken reply also gets the board's "Spoken · HH:MM" meta line
// (with a speaker glyph), and a `thinking` prop renders the board's
// three-dot "Thinking" indicator while a reply is awaited.
import { useRef } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { formatClockTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { theme } from "@/lib/theme";
import type { TurnView } from "@/lib/turns";
import { textDirection } from "@/lib/voice-screen";

export function TurnList({
  turns,
  thinking = false,
  spokenReplyIds = [],
}: {
  turns: readonly TurnView[];
  thinking?: boolean;
  spokenReplyIds?: readonly string[];
}) {
  const language = useLanguage();
  const scrollRef = useRef<ScrollView>(null);

  if (turns.length === 0 && !thinking) {
    return <Text style={styles.empty}>{t(language, "voice.empty")}</Text>;
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.container}
      contentContainerStyle={styles.content}
      onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
    >
      {turns.map((turn) => {
        const roleKey = turn.role === "user" ? "voice.you" : "voice.jarvis";
        const spoken =
          turn.role === "assistant" &&
          turn.replyTo !== undefined &&
          spokenReplyIds.includes(turn.replyTo);
        return (
          <View
            key={`${turn.role}-${turn.at}-${turn.replyTo ?? ""}-${turn.text}`}
            style={[styles.bubble, turn.role === "user" ? styles.userBubble : styles.replyBubble]}
          >
            <View accessible accessibilityLabel={`${t(language, roleKey)}: ${turn.text}`}>
              <Text style={[styles.text, { writingDirection: textDirection(turn.language) }]}>
                {turn.text}
              </Text>
            </View>
            {spoken && (
              <View style={styles.meta}>
                <Text style={styles.metaIcon}>♪</Text>
                <Text style={styles.metaText}>
                  {t(language, "voice.spoken")} · {formatClockTime(turn.at)}
                </Text>
              </View>
            )}
          </View>
        );
      })}

      {thinking && (
        <View
          style={styles.thinkingBubble}
          accessible
          accessibilityLabel={t(language, "voice.thinking")}
        >
          <View style={styles.dot} />
          <View style={[styles.dot, styles.dotMid]} />
          <View style={[styles.dot, styles.dotLow]} />
          <Text style={styles.thinkingText}>{t(language, "voice.thinking")}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingVertical: 6, paddingHorizontal: 20, gap: 12 },
  bubble: {
    maxWidth: 300,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: theme.spacing.xs,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: theme.colors.userBubble,
    borderBottomEndRadius: 4,
  },
  replyBubble: {
    alignSelf: "flex-start",
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    borderBottomStartRadius: 4,
  },
  text: { color: theme.colors.text, fontFamily: theme.font.body, fontSize: 15, lineHeight: 21 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6, paddingStart: 4 },
  metaIcon: { color: theme.colors.textDim, fontSize: 11 },
  metaText: { color: theme.colors.textDim, fontFamily: theme.font.body, fontSize: 11 },
  thinkingBubble: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 16,
    borderBottomStartRadius: 4,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
  },
  dot: { width: 6, height: 6, borderRadius: 999, backgroundColor: theme.colors.accent },
  dotMid: { opacity: 0.6 },
  dotLow: { opacity: 0.3 },
  thinkingText: { color: theme.colors.textDim, fontFamily: theme.font.body, fontSize: 13 },
  empty: {
    flex: 1,
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
    padding: theme.spacing.md,
  },
});
