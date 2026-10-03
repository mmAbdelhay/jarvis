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
import { IconButton } from "../components/IconButton";
import { SegmentTabs } from "../components/SegmentTabs";
import { planErrorText } from "./plan-error";
import { planProgressOf } from "./plan-progress";
import { buildPlanPage, parsePlanPageMessage } from "./plan-page";
import type { PlanBlock, PlanEntry } from "./types";

/** The plan's content, hosted by the phone's modal sheet (`PlanSheet`) or the
 *  wide Workspace's dock (`PlanDock`). One WebView page, one message handler:
 *  only the frame around it differs. */
function PlanPanelBody(props: {
  /** Whether the host is showing it: the default plan opens when it is. */
  active: boolean;
  store: PlansStore;
  language: Language;
  tabTitle: string;
  /** The sheet's close button; the dock has none. */
  onClose?: () => void;
  dock?: boolean;
}) {
  const [, redraw] = useState(0);
  const [picker, setPicker] = useState(false);
  const [commentsScreen, setCommentsScreen] = useState(false);
  const [selectedBlock, setSelectedBlock] = useState<PlanBlock>();
  const dock = props.dock === true;
  useEffect(() => props.store.subscribe(() => redraw((value) => value + 1)), [props.store]);
  useEffect(() => {
    if (!props.active) return;
    void props.store.openDefault();
  }, [props.active, props.store]);

  const state = props.store.state;
  const activeEntry = findEntry(state.list, state.doc?.path);
  const queued = state.comments.filter((comment) => comment.sentAt === undefined);
  const progress = planProgressOf(state.doc);
  const html = useMemo(
    () =>
      state.doc === undefined
        ? undefined
        : buildPlanPage(state.doc, state.comments, props.language, {
            surface: theme.colors.surface,
            surfaceAlt: theme.colors.surfaceAlt,
            ground: theme.colors.ground,
            text: theme.colors.text,
            textSecondary: theme.colors.textSecondary,
            accent: theme.colors.accent,
            warning: theme.colors.warning,
            selected: theme.colors.selected,
            accentBorder: theme.colors.accentBorder,
            success: theme.colors.success,
            onSuccess: theme.colors.onSuccess,
            checkboxOff: theme.colors.checkboxOff,
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

  const progressBar =
    progress === undefined ? null : (
      <View style={[styles.track, dock && styles.dockTrack]}>
        <View
          style={[styles.fill, { width: `${Math.round((progress.done / progress.total) * 100)}%` }]}
        />
      </View>
    );

  return (
    <>
      <View style={dock ? styles.dockHeader : styles.header}>
        <TouchableOpacity style={styles.planTitle} onPress={() => setPicker((value) => !value)}>
          <Text style={dock ? styles.dockFileName : styles.fileName} numberOfLines={1}>
            {activeEntry?.name ?? t(props.language, "plans.title")} ▾
          </Text>
          <Text style={styles.sourceLine}>
            {activeEntry === undefined
              ? ""
              : dock && activeEntry.source === "session"
                ? t(props.language, "plans.sessionPlan")
                : sourceLabel(activeEntry, props.language)}
          </Text>
        </TouchableOpacity>
        {dock && progress !== undefined && (
          <Text style={styles.dockProgress}>
            {progress.done}/{progress.total}
          </Text>
        )}
        {props.onClose !== undefined && (
          <IconButton
            icon="chevronDown"
            label={t(props.language, "plans.close")}
            onPress={props.onClose}
          />
        )}
      </View>
      <View style={dock ? styles.dockSubheader : styles.subheader}>
        {progress !== undefined &&
          (dock ? (
            progressBar
          ) : (
            <View style={styles.progressRow}>
              {progressBar}
              <Text style={styles.progressText}>
                {t(props.language, "plans.doneOf", {
                  done: progress.done,
                  total: progress.total,
                })}
              </Text>
            </View>
          ))}
        <SegmentTabs
          compact
          label={t(props.language, "plans.title")}
          tabs={[
            {
              key: "plan",
              label: t(props.language, "plans.title"),
              selected: !commentsScreen,
              onPress: () => setCommentsScreen(false),
            },
            {
              key: "notes",
              label: t(props.language, "plans.comments"),
              ...(state.comments.length === 0 ? {} : { badge: String(state.comments.length) }),
              selected: commentsScreen,
              onPress: () => setCommentsScreen(true),
            },
          ]}
        />
      </View>
      {picker && state.list !== undefined && (
        <PlanPicker
          list={state.list}
          language={props.language}
          dock={dock}
          onPick={(entry) => {
            setPicker(false);
            setCommentsScreen(false);
            void props.store.open(entry.path);
          }}
        />
      )}
      {state.error !== undefined && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{planErrorText(props.language, state.error.code)}</Text>
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
      {!commentsScreen &&
        (dock ? (
          <View style={styles.dockFooter}>
            <TouchableOpacity
              accessibilityRole="button"
              disabled={queued.length === 0}
              onPress={() => void props.store.send()}
              style={[styles.dockSend, queued.length === 0 && styles.disabled]}
            >
              <Text style={styles.sendText}>
                {t(props.language, "plans.sendNotes", { count: queued.length })}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.footer}>
            <View style={styles.queuedBlock}>
              <Text style={styles.queued}>
                {t(props.language, "plans.queuedCount", { count: queued.length })}
              </Text>
              {queued.length > 1 && (
                <Text style={styles.queuedHint}>{t(props.language, "plans.sentTogether")}</Text>
              )}
            </View>
            <TouchableOpacity
              disabled={queued.length === 0}
              onPress={() => void props.store.send()}
              style={[styles.send, queued.length === 0 && styles.disabled]}
            >
              <Text style={styles.sendText}>{t(props.language, "plans.sendToClaude")}</Text>
            </TouchableOpacity>
          </View>
        ))}
      <PlanBlockSheet
        block={selectedBlock}
        language={props.language}
        store={props.store}
        onClose={() => setSelectedBlock(undefined)}
      />
    </>
  );
}

/** The phone's plan: a modal bottom sheet. */
export function PlanSheet(props: {
  visible: boolean;
  store: PlansStore;
  language: Language;
  tabTitle: string;
  onClose(): void;
}) {
  const { height } = useWindowDimensions();
  return (
    <Modal transparent animationType="slide" visible={props.visible} onRequestClose={props.onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { height: height * 0.82 }]}>
          <View style={styles.grabber} />
          <PlanPanelBody
            active={props.visible}
            store={props.store}
            language={props.language}
            tabTitle={props.tabTitle}
            onClose={props.onClose}
          />
        </View>
      </View>
    </Modal>
  );
}

/** The wide Workspace's plan: docked beside the terminal, the same page. */
export function PlanDock(props: { store: PlansStore; language: Language; tabTitle: string }) {
  return (
    <View style={styles.dock} accessibilityLabel={t(props.language, "plans.title")}>
      <PlanPanelBody
        active
        store={props.store}
        language={props.language}
        tabTitle={props.tabTitle}
        dock
      />
    </View>
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
  dock?: boolean;
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
    <ScrollView
      style={[styles.picker, props.dock === true && styles.dockPicker]}
      contentContainerStyle={styles.pickerContent}
    >
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
    backgroundColor: theme.colors.ground,
    borderTopStartRadius: theme.radius.sheet,
    borderTopEndRadius: theme.radius.sheet,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  grabber: {
    width: 40,
    height: 5,
    alignSelf: "center",
    marginTop: 8,
    marginBottom: 2,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.handle,
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
  fileName: { color: theme.colors.text, fontFamily: theme.font.extrabold, fontSize: 17 },
  sourceLine: { ...theme.type.meta, color: theme.colors.textMuted },
  dock: {
    flex: 1,
    flexBasis: 300,
    maxWidth: 360,
    minHeight: 0,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
    gap: 10,
    borderStartWidth: 1,
    borderStartColor: theme.colors.hairlineSoft,
    backgroundColor: theme.colors.ground,
  },
  dockHeader: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm },
  dockFileName: { color: theme.colors.text, fontFamily: theme.font.extrabold, fontSize: 15 },
  dockProgress: { color: theme.colors.textSecondary, fontFamily: theme.font.bold, fontSize: 12 },
  dockSubheader: { gap: 10 },
  dockTrack: { flex: 0, alignSelf: "stretch" },
  dockPicker: { top: 52, insetInlineStart: 0, insetInlineEnd: 0 },
  dockFooter: { paddingTop: 4 },
  dockSend: {
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.accent,
  },
  subheader: {
    gap: 10,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 10,
    borderBottomColor: theme.colors.hairline,
    borderBottomWidth: 1,
  },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  track: { flex: 1, height: 6, borderRadius: 999, backgroundColor: theme.colors.selected },
  fill: { height: 6, borderRadius: 999, backgroundColor: theme.colors.success },
  progressText: { color: theme.colors.textSecondary, fontFamily: theme.font.bold, fontSize: 12 },
  webview: { flex: 1, backgroundColor: theme.colors.ground },
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
    top: 62,
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
    backgroundColor: theme.colors.surfaceDim,
    paddingTop: 10,
    paddingBottom: 26,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  queuedBlock: { flex: 1, gap: 2 },
  queued: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 14 },
  queuedHint: { color: theme.colors.textMuted, fontFamily: theme.font.body, fontSize: 12 },
  send: {
    minHeight: 46,
    justifyContent: "center",
    paddingHorizontal: 16,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.accent,
  },
  disabled: { opacity: 0.4 },
  sendText: { ...theme.type.buttonStrong, color: theme.colors.primaryText },
});
