// The top of Home, above the Dashboard's panels: how many agents are
// working, any question a session is waiting at (answerable right here),
// and each account's capacity. The data is home-store's; this only draws
// and answers.
import { useState } from "react";
import type { SystemMetrics } from "@jarvis/core";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CapacityCards } from "@/components/CapacityCards";
import { HomeTiles } from "@/components/HomeTiles";
import { PromptCard } from "@/components/PromptCard";
import type { SessionSummary } from "@/lib/dashboard-store";
import { formatSessionElapsed } from "@/lib/format";
import { bannerFits, homeSubtitle } from "@/lib/home-wide";
import type { HomeView } from "@/lib/home-store";
import { promptLayout } from "@/lib/session-prompt";
import { t, type Language } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/** At most this many question cards: more than that and Home is all cards. */
const MAX_WAITING_CARDS = 3;

export function homeHeadline(
  language: Language,
  live: number,
  waiting: number,
): { title: string; subtitle: string } {
  const title =
    live === 0
      ? t(language, "home.idle")
      : live === 1
        ? t(language, "home.workingOne")
        : t(language, "home.working", { count: live });
  const subtitle =
    waiting === 0
      ? t(language, "home.allClear")
      : t(language, "home.waitingCount", { count: waiting });
  return { title, subtitle };
}

/** What only the wide Home draws: the header's actions and the tiles row. */
export type HomeTopWide = {
  /** "MacBook connected", or the connection's own state text. */
  connection: string;
  metrics: SystemMetrics | undefined;
  content: number;
  inner: number;
  onNewTerminal(): void;
  onNewSession(): void;
};

export function HomeTop(props: {
  language: Language;
  home: HomeView;
  sessions: SessionSummary[];
  liveCount: number;
  now: number;
  /** Wide: header row with actions, banner prompts and the tiles row. */
  wide: HomeTopWide | undefined;
  onAnswer(
    sessionId: string,
    index: number,
    label: string,
  ): Promise<"answered" | "changed" | "offline">;
  onOpen(sessionId: string): void;
}) {
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const headline = homeHeadline(props.language, props.liveCount, props.home.waiting.length);

  async function answer(sessionId: string, index: number, label: string): Promise<void> {
    setBusy(sessionId);
    const outcome = await props.onAnswer(sessionId, index, label);
    setBusy(undefined);
    setNotes((current) => {
      const next = { ...current };
      if (outcome === "answered") delete next[sessionId];
      else
        next[sessionId] = t(
          props.language,
          outcome === "changed" ? "session.promptChanged" : "session.promptOffline",
        );
      return next;
    });
  }

  const wide = props.wide;
  return (
    <View style={wide === undefined ? styles.top : styles.topWide}>
      {wide === undefined ? (
        <View>
          <Text style={styles.title}>{headline.title}</Text>
          <Text style={styles.subtitle}>{headline.subtitle}</Text>
        </View>
      ) : (
        <View style={styles.headerWide}>
          <View style={styles.headerText}>
            <Text style={styles.titleWide}>{headline.title}</Text>
            <Text style={styles.subtitleWide}>
              {homeSubtitle(props.language, props.home.waiting.length, wide.connection)}
            </Text>
          </View>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              onPress={wide.onNewTerminal}
              style={styles.action}
            >
              <Text style={styles.actionText}>{t(props.language, "home.newTerminal")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={wide.onNewSession}
              style={[styles.action, styles.actionPrimary]}
            >
              <Text style={[styles.actionText, styles.actionPrimaryText]}>
                {t(props.language, "home.newSession")}
              </Text>
            </Pressable>
          </View>
        </View>
      )}
      {props.home.waiting.slice(0, MAX_WAITING_CARDS).map((entry) => {
        const session = props.sessions.find((candidate) => candidate.id === entry.sessionId);
        const context = [
          session?.agentId,
          session?.project ?? undefined,
          session === undefined ? undefined : formatSessionElapsed(props.now - session.startedAt),
        ]
          .filter((part): part is string => part !== undefined && part !== "")
          .join(" · ");
        return (
          <PromptCard
            key={entry.sessionId}
            prompt={entry.prompt}
            busy={busy === entry.sessionId}
            note={notes[entry.sessionId]}
            layout={
              wide !== undefined && bannerFits(entry.prompt.options.length)
                ? "banner"
                : promptLayout(entry.prompt.options.length)
            }
            heading={t(props.language, "home.needsYou")}
            context={context === "" ? undefined : context}
            onAnswer={(index, label) => void answer(entry.sessionId, index, label)}
            open={{
              label: t(props.language, "home.open"),
              onPress: () => props.onOpen(entry.sessionId),
            }}
          />
        );
      })}
      {wide === undefined ? (
        <CapacityCards
          language={props.language}
          cards={props.home.capacity}
          trends={props.home.trends}
          now={props.now}
        />
      ) : (
        <HomeTiles
          language={props.language}
          content={wide.content}
          inner={wide.inner}
          cards={props.home.capacity}
          trends={props.home.trends}
          metrics={wide.metrics}
          sessionsPerDay={props.home.sessionsPerDay}
          now={props.now}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  top: { gap: 16 },
  topWide: { gap: 22 },
  headerWide: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 16,
  },
  headerText: { flexShrink: 1 },
  titleWide: {
    color: theme.colors.text,
    fontFamily: theme.font.extrabold,
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -0.5,
  },
  subtitleWide: {
    marginTop: 6,
    color: theme.colors.textMuted,
    fontFamily: theme.font.body,
    fontSize: 15,
  },
  actions: { flexDirection: "row", gap: 8 },
  action: {
    minHeight: 42,
    justifyContent: "center",
    paddingHorizontal: 16,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  actionText: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 14 },
  actionPrimary: { borderWidth: 0, backgroundColor: theme.colors.accent },
  actionPrimaryText: { color: theme.colors.primaryText },
  title: { ...theme.type.display, color: theme.colors.text },
  subtitle: {
    marginTop: 4,
    color: theme.colors.textMuted,
    fontFamily: theme.font.body,
    fontSize: 14,
  },
});
