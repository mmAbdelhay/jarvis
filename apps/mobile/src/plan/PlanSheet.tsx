import { useEffect, useMemo, useState } from "react";
import {
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { t, type Language } from "../lib/i18n";
import type { PlansStore } from "../lib/plans-store";
import { allowTerminalNavigation, TERMINAL_WEBVIEW_PROPS } from "../lib/terminal-webview-config";
import { theme } from "../lib/theme";
import { PlanBlockSheet } from "./PlanBlockSheet";
import { PlanCommentsScreen } from "./PlanCommentsScreen";
import { planErrorText } from "./plan-error";
import { buildPlanPage, parsePlanPageMessage } from "./plan-page";
import type { PlanBlock, PlanEntry } from "./types";

export function PlanSheet(props: {
  visible: boolean;
  store: PlansStore;
  language: Language;
  tabTitle: string;
  onClose(): void;
}) {
  const [, redraw] = useState(0);
  const { height } = useWindowDimensions();
  const [picker, setPicker] = useState(false);
  const [commentsScreen, setCommentsScreen] = useState(false);
  const [selectedBlock, setSelectedBlock] = useState<PlanBlock>();
  useEffect(() => props.store.subscribe(() => redraw((value) => value + 1)), [props.store]);
  useEffect(() => {
    if (!props.visible) return;
    void props.store.openDefault();
  }, [props.visible, props.store]);

  const state = props.store.state;
  const activeEntry = findEntry(state.list, state.doc?.path);
  const queued = state.comments.filter((comment) => comment.sentAt === undefined);
  const html = useMemo(
    () =>
      state.doc === undefined
        ? undefined
        : buildPlanPage(state.doc, state.comments, props.language, {
            surface: theme.colors.surface,
            ground: theme.colors.ground,
            text: theme.colors.text,
            textSecondary: theme.colors.textSecondary,
            accent: theme.colors.accent,
            warning: theme.colors.warning,
            selected: theme.colors.selected,
          }),
    [state.doc, state.comments, props.language],
  );

  function onMessage(event: WebViewMessageEvent) {
    // Final fix wave I5: the page never navigates itself — a link tap
    // arrives here, and only an http(s) URL (parsePlanPageMessage) is ever
    // handed to the OS. Malformed or other messages are ignored.
    const message = parsePlanPageMessage(event.nativeEvent.data);
    if (message?.kind === "link") {
      void Linking.openURL(message.url).catch(() => undefined);
    } else if (message?.kind === "block") {
      setSelectedBlock(state.doc?.blocks.find((block) => block.id === message.id));
    }
  }

  return (
    <Modal transparent animationType="slide" visible={props.visible} onRequestClose={props.onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { height: height * 0.82 }]}>
          <View style={styles.grabber} />
          <View style={styles.header}>
            <TouchableOpacity style={styles.planTitle} onPress={() => setPicker((value) => !value)}>
              <Text style={styles.fileName} numberOfLines={1}>
                {activeEntry?.name ?? t(props.language, "plans.title")}
              </Text>
              <Text style={styles.sourceLine}>
                {activeEntry === undefined ? "" : sourceLabel(activeEntry, props.language)} ▾
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.headerButton}
              onPress={() => setCommentsScreen((value) => !value)}
            >
              <Text style={styles.headerButtonText}>
                {commentsScreen
                  ? t(props.language, "plans.title")
                  : t(props.language, "plans.comments")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.close}
              onPress={props.onClose}
              accessibilityLabel={t(props.language, "common.cancel")}
            >
              <Text style={styles.closeText}>×</Text>
            </TouchableOpacity>
          </View>
          {picker && state.list !== undefined && (
            <PlanPicker
              list={state.list}
              language={props.language}
              onPick={(entry) => {
                setPicker(false);
                setCommentsScreen(false);
                void props.store.open(entry.path);
              }}
            />
          )}
          {state.error !== undefined && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>
                {planErrorText(props.language, state.error.code)}
              </Text>
              {state.error.detail !== undefined && (
                <Text style={styles.errorDetail}>{state.error.detail}</Text>
              )}
            </View>
          )}
          {commentsScreen ? (
            <PlanCommentsScreen
              comments={state.comments}
              language={props.language}
              tabTitle={props.tabTitle}
              onSend={(ids) => void props.store.send(ids)}
            />
          ) : html === undefined ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>{t(props.language, "plans.noPlans")}</Text>
            </View>
          ) : (
            <WebView
              {...TERMINAL_WEBVIEW_PROPS}
              source={{ html, baseUrl: "about:blank" }}
              onShouldStartLoadWithRequest={(request) => allowTerminalNavigation(request.url)}
              onMessage={onMessage}
              style={styles.webview}
            />
          )}
          {!commentsScreen && (
            <View style={styles.footer}>
              <Text style={styles.queued}>
                {t(props.language, "plans.queuedCount", { count: queued.length })}
              </Text>
              <TouchableOpacity
                disabled={queued.length === 0}
                onPress={() => void props.store.send()}
                style={[styles.send, queued.length === 0 && styles.disabled]}
              >
                <Text style={styles.sendText}>{t(props.language, "plans.sendToClaude")}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
      <PlanBlockSheet
        block={selectedBlock}
        language={props.language}
        store={props.store}
        onClose={() => setSelectedBlock(undefined)}
      />
    </Modal>
  );
}

function findEntry(list: PlansStore["state"]["list"], path?: string): PlanEntry | undefined {
  if (list === undefined || path === undefined) return undefined;
  return [list.session, ...list.planMode, ...list.repo].find((entry) => entry?.path === path);
}

function sourceLabel(entry: PlanEntry, language: Language): string {
  const key =
    entry.source === "session"
      ? "plans.session"
      : entry.source === "planMode"
        ? "plans.planMode"
        : "plans.repo";
  const suffix = entry.project ?? entry.repoKind;
  return suffix === undefined ? t(language, key) : `${t(language, key)} · ${suffix}`;
}

function PlanPicker(props: {
  list: NonNullable<PlansStore["state"]["list"]>;
  language: Language;
  onPick(entry: PlanEntry): void;
}) {
  const groups: { title: string; entries: PlanEntry[] }[] = [
    {
      title: t(props.language, "plans.session"),
      entries: props.list.session ? [props.list.session] : [],
    },
    { title: t(props.language, "plans.planMode"), entries: props.list.planMode },
    { title: t(props.language, "plans.repo"), entries: props.list.repo },
  ];
  return (
    <ScrollView style={styles.picker} contentContainerStyle={styles.pickerContent}>
      {groups.map((group) =>
        group.entries.length === 0 ? null : (
          <View key={group.title}>
            <Text style={styles.groupTitle}>{group.title}</Text>
            {group.entries.map((entry) => (
              <TouchableOpacity
                key={entry.path}
                style={styles.pickerRow}
                onPress={() => props.onPick(entry)}
              >
                <Text style={styles.pickerName}>{entry.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ),
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopStartRadius: theme.radius.lg,
    borderTopEndRadius: theme.radius.lg,
    overflow: "hidden",
  },
  grabber: {
    width: 42,
    height: 4,
    alignSelf: "center",
    marginTop: 7,
    borderRadius: 2,
    backgroundColor: theme.colors.textFaint,
  },
  header: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing.md,
    borderBottomColor: theme.colors.hairline,
    borderBottomWidth: 1,
    gap: theme.spacing.sm,
  },
  planTitle: { flex: 1, minHeight: 48, justifyContent: "center" },
  fileName: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 16 },
  sourceLine: { color: theme.colors.textMuted, fontFamily: theme.font.body, fontSize: 12 },
  headerButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: theme.spacing.sm },
  headerButtonText: { color: theme.colors.accent, fontFamily: theme.font.semibold },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  closeText: { color: theme.colors.textMuted, fontSize: 30, lineHeight: 32 },
  webview: { flex: 1, backgroundColor: theme.colors.surface },
  errorBanner: {
    backgroundColor: theme.colors.surfaceAlt,
    borderBottomColor: theme.colors.warning,
    borderBottomWidth: 1,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  errorText: { color: theme.colors.warning, fontFamily: theme.font.semibold },
  errorDetail: { color: theme.colors.textMuted, fontFamily: theme.font.body, fontSize: 12 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing.lg },
  emptyText: { color: theme.colors.textMuted, textAlign: "center" },
  picker: {
    position: "absolute",
    zIndex: 4,
    top: 73,
    insetInlineStart: theme.spacing.md,
    insetInlineEnd: theme.spacing.md,
    maxHeight: 300,
    backgroundColor: theme.colors.surfaceAlt,
    borderColor: theme.colors.hairline,
    borderWidth: 1,
    borderRadius: theme.radius.md,
  },
  pickerContent: { padding: theme.spacing.sm },
  groupTitle: {
    color: theme.colors.textMuted,
    fontFamily: theme.font.semibold,
    fontSize: 12,
    padding: theme.spacing.sm,
  },
  pickerRow: { minHeight: 44, justifyContent: "center", paddingHorizontal: theme.spacing.sm },
  pickerName: { color: theme.colors.text, fontFamily: theme.font.medium },
  footer: {
    minHeight: 66,
    borderTopColor: theme.colors.hairline,
    borderTopWidth: 1,
    paddingHorizontal: theme.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  queued: { flex: 1, color: theme.colors.textMuted, fontFamily: theme.font.medium },
  send: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.accent,
  },
  disabled: { opacity: 0.4 },
  sendText: { color: theme.colors.primaryText, fontFamily: theme.font.bold },
});
