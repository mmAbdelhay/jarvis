import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Linking, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MicButton } from "@/components/MicButton";
import { TurnList } from "@/components/TurnList";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { theme } from "@/lib/theme";
import type { VoiceView } from "@/lib/voice-controller";
import { useVoiceController } from "@/lib/voice-context";
import {
  formatElapsed,
  micButtonState,
  noticeKey,
  phaseStatusKey,
  textDirection,
} from "@/lib/voice-screen";

// Ruling 6: the Voice screen sends no target, so the brain answers — its
// header always reads `voice.targetBrain`, never derived from `view.target`.
export default function VoiceScreen() {
  const language = useLanguage();
  const controller = useVoiceController();
  const [view, setView] = useState<VoiceView>(controller.get());
  const insets = useSafeAreaInsets();

  useFocusEffect(
    useCallback(() => {
      const unsubscribe = controller.subscribe(setView);
      const release = controller.focus({ kind: "brain" });
      setView(controller.get());
      return () => {
        unsubscribe();
        release();
      };
    }, [controller]),
  );

  const mic = micButtonState(view, {});
  const statusKey = phaseStatusKey(view.phase);
  const notice = view.notice;
  const key = notice && notice.code !== "server" ? noticeKey(notice.code) : undefined;
  const showRetryDiscard = view.canRetry || view.phase === "notSent" || view.phase === "uncertain";

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <Text style={styles.title}>{t(language, "voice.title")}</Text>
        <TouchableOpacity
          style={styles.readPill}
          onPress={() => controller.setSpeakReplies(!view.speakReplies)}
        >
          <Text style={styles.readLabel}>{t(language, "voice.readAloud")}</Text>
          <View style={[styles.toggle, view.speakReplies && styles.toggleOn]}>
            <View style={[styles.knob, view.speakReplies && styles.knobOn]} />
          </View>
        </TouchableOpacity>
      </View>

      <TurnList
        turns={view.turns}
        thinking={view.phase === "waitingReply"}
        spokenReplyIds={view.spokenReplyIds}
      />

      {statusKey && (
        <Text style={styles.status}>
          {t(language, statusKey)}
          {view.phase === "recording" ? ` ${formatElapsed(view.elapsedMs)}` : ""}
        </Text>
      )}

      {notice && (
        <View style={styles.notice}>
          {notice.code === "server" && notice.server && (
            <Text
              style={[
                styles.noticeText,
                { writingDirection: textDirection(notice.server.language) },
              ]}
            >
              {notice.server.text}
            </Text>
          )}
          {notice.code !== "server" && key && (
            <Text style={styles.noticeText}>{t(language, key)}</Text>
          )}
          {notice.code === "sentToSession" && notice.server && (
            <Text
              style={[
                styles.noticeText,
                { writingDirection: textDirection(notice.server.language) },
              ]}
            >
              {notice.server.text}
            </Text>
          )}
          {notice.code === "micBlocked" && (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => {
                void Linking.openSettings();
              }}
            >
              <Text style={styles.link}>{t(language, "voice.openSettings")}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {showRetryDiscard && (
        <View style={styles.row}>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => {
              void controller.retry();
            }}
          >
            <Text style={styles.link}>{t(language, "voice.retry")}</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" onPress={() => controller.discard()}>
            <Text style={styles.link}>{t(language, "voice.discard")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {view.phase === "speaking" && (
        <TouchableOpacity accessibilityRole="button" onPress={() => controller.stopSpeaking()}>
          <Text style={styles.link}>{t(language, "voice.stopSpeaking")}</Text>
        </TouchableOpacity>
      )}

      <View style={styles.micStage}>
        <Text style={styles.target}>{t(language, "voice.targetBrain")}</Text>
        <MicButton enabled={mic.enabled} active={mic.active} labelKey={mic.labelKey} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
    gap: 8,
  },
  header: { height: 50, flexDirection: "row", alignItems: "center", paddingHorizontal: 20 },
  title: { flex: 1, color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 26 },
  readPill: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 999,
    backgroundColor: theme.colors.surface,
  },
  readLabel: { color: theme.colors.textSecondary, fontFamily: theme.font.semibold, fontSize: 12 },
  toggle: {
    width: 34,
    height: 20,
    borderRadius: 999,
    backgroundColor: theme.colors.disabledDot,
    padding: 2,
  },
  toggleOn: { backgroundColor: theme.colors.accent },
  knob: { width: 16, height: 16, borderRadius: 999, backgroundColor: theme.colors.ground },
  knobOn: { marginStart: 14 },
  micStage: {
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 24,
    borderTopWidth: 1,
    borderTopColor: theme.colors.hairlineSoft,
  },
  target: {
    color: theme.colors.textDim,
    fontFamily: theme.font.body,
    fontSize: theme.font.size.sm,
    textAlign: "center",
  },
  status: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
    textAlign: "center",
  },
  notice: { gap: theme.spacing.xs, alignItems: "center" },
  noticeText: {
    color: theme.colors.warning,
    fontSize: theme.font.size.sm,
    textAlign: "center",
  },
  row: {
    flexDirection: "row",
    justifyContent: "center",
    gap: theme.spacing.lg,
  },
  link: {
    color: theme.colors.primary,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.medium,
  },
});
