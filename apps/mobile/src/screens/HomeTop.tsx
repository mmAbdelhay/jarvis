// The top of Home, above the Dashboard's panels: how many agents are
// working, any question a session is waiting at (answerable right here),
// and each account's capacity. The data is home-store's; this only draws
// and answers.
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { CapacityCards } from "@/components/CapacityCards";
import { PromptCard } from "@/components/PromptCard";
import type { SessionSummary } from "@/lib/dashboard-store";
import { formatSessionElapsed } from "@/lib/format";
import type { HomeView } from "@/lib/home-store";
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

export function HomeTop(props: {
  language: Language;
  home: HomeView;
  sessions: SessionSummary[];
  liveCount: number;
  now: number;
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

  return (
    <View style={styles.top}>
      <View>
        <Text style={styles.title}>{headline.title}</Text>
        <Text style={styles.subtitle}>{headline.subtitle}</Text>
      </View>
      {props.home.waiting.slice(0, MAX_WAITING_CARDS).map((entry) => {
        const session = props.sessions.find((candidate) => candidate.id === entry.sessionId);
        const context = [
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
      <CapacityCards
        language={props.language}
        cards={props.home.capacity}
        trends={props.home.trends}
        now={props.now}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  top: { gap: 16 },
  title: {
    color: theme.colors.text,
    fontFamily: theme.font.bold,
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: -0.5,
  },
  subtitle: {
    marginTop: 4,
    color: theme.colors.textMuted,
    fontFamily: theme.font.body,
    fontSize: 14,
  },
});
