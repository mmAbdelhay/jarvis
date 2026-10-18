import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type ChipTone, ReviewChip, StatusDot } from "@/components/ReviewsSection";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useWidePanelTitle, WidePanel } from "@/components/WidePanel";
import { WideShell } from "@/components/WideShell";
import { formatClockTime } from "@/lib/format";
import { type Language, type MessageKey, t } from "@/lib/i18n";
import { keyboardAvoidingBehavior, keyboardBottomPadding } from "@/lib/keyboard-offset";
import { useLanguage } from "@/lib/language-context";
import {
  createReviewsStore,
  isPrKey,
  type ReviewCardModel,
  type ReviewThread,
  type ReviewThreadComment,
  type ReviewThreadEntry,
  type ReviewWaitReason,
  type ReviewsState,
  reviewThreadEntries,
} from "@/lib/reviews-store";
import { useRpcClient } from "@/lib/rpc-context";
import { theme } from "@/lib/theme";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { useLayoutClass } from "@/lib/use-layout-class";

const WAIT_KEY: Record<ReviewWaitReason, MessageKey> = {
  "no-link": "reviews.wait.noLink",
  ambiguous: "reviews.wait.ambiguous",
  "no-agent": "reviews.wait.noAgent",
  "approval-prompt": "reviews.wait.approvalPrompt",
  busy: "reviews.wait.busy",
  typing: "reviews.wait.typing",
  batching: "reviews.wait.batching",
  paused: "reviews.wait.paused",
  nothing: "reviews.wait.nothing",
};

const STATE_CHIP: Record<ReviewThreadComment["state"], { key: MessageKey; tone: ChipTone }> = {
  queued: { key: "reviews.state.queued", tone: "warning" },
  delivered: { key: "reviews.state.delivered", tone: "success" },
  own: { key: "reviews.state.own", tone: "accent" },
  history: { key: "reviews.state.history", tone: "muted" },
};

type ReplyTarget = { id: string; author: string };

// One PR's comments: which terminal they go to and why they are waiting,
// each comment with its state (Deliver now on queued ones), and a reply
// box that posts on GitHub.
export default function ReviewThreadRoute() {
  const params = useLocalSearchParams<{ pr: string }>();
  const key = typeof params.pr === "string" && isPrKey(params.pr) ? params.pr : undefined;
  const language = useLanguage();
  const router = useRouter();
  const client = useRpcClient();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const wide = useLayoutClass().kind === "wide";
  const store = useMemo(() => createReviewsStore({ client }), [client]);
  const [state, setState] = useState<ReviewsState>({ ...store.state });
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState<ReplyTarget | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useFocusEffect(
    useCallback(() => {
      const unsubscribe = store.subscribe(() => setState({ ...store.state }));
      if (key !== undefined) void store.openThread(key);
      return unsubscribe;
    }, [store, key]),
  );
  const thread = state.thread;
  const title = thread === undefined ? t(language, "reviews.title") : threadTitle(thread);
  useWidePanelTitle(thread === undefined ? undefined : title);
  const send = async () => {
    if (busy || draft.trim().length === 0) return;
    setBusy(true);
    const ok = await store.reply(draft, target?.id);
    setBusy(false);
    if (ok) {
      setDraft("");
      setTarget(undefined);
    }
  };
  const deliver = async () => {
    if (busy) return;
    setBusy(true);
    await store.deliverNow();
    setBusy(false);
  };
  const missing = key === undefined || (thread === undefined && state.error?.code === "loadFailed");
  return (
    <WideShell>
      <WidePanel title={t(language, "reviews.title")}>
        <KeyboardAvoidingView
          style={[
            styles.root,
            { paddingBottom: keyboardBottomPadding(Platform.OS, keyboardHeight, insets.bottom) },
          ]}
          behavior={keyboardAvoidingBehavior(Platform.OS)}
        >
          {!wide && (
            <ScreenHeader
              title={title}
              subtitle={thread?.pr.headRef}
              subtitleMono
              bordered={false}
              onBack={router.canGoBack() ? router.back : () => router.replace("/reviews")}
            />
          )}
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {missing && <Text style={styles.empty}>{t(language, "reviews.notFound")}</Text>}
            {thread !== undefined && (
              <>
                <LinkCard language={language} thread={thread} />
                {thread.comments.length === 0 && (
                  <Text style={styles.empty}>{t(language, "reviews.noComments")}</Text>
                )}
                {reviewThreadEntries(thread).map((entry) => (
                  <CommentCard
                    key={entry.comment.id}
                    language={language}
                    entry={entry}
                    busy={busy}
                    onDeliver={() => void deliver()}
                    onReply={() =>
                      setTarget({ id: entry.comment.id, author: entry.comment.author })
                    }
                  />
                ))}
              </>
            )}
            {state.error !== undefined && state.error.code !== "loadFailed" && (
              <Text style={styles.error}>
                {t(
                  language,
                  state.error.code === "replyFailed"
                    ? "reviews.error.replyFailed"
                    : "reviews.error.deliverFailed",
                )}
              </Text>
            )}
          </ScrollView>
          {thread !== undefined && (
            <View style={styles.composer}>
              {target !== undefined && (
                <View style={styles.replying}>
                  <Text style={styles.replyingText} numberOfLines={1}>
                    {t(language, "reviews.replyingTo", { author: target.author })}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setTarget(undefined)}
                    hitSlop={8}
                  >
                    <Text style={styles.replyingCancel}>{t(language, "reviews.cancelReply")}</Text>
                  </Pressable>
                </View>
              )}
              <View style={styles.composerRow}>
                <TextInput
                  value={draft}
                  onChangeText={setDraft}
                  placeholder={t(language, "reviews.replyPlaceholder")}
                  placeholderTextColor={theme.colors.textDim}
                  accessibilityLabel={t(language, "reviews.replyLabel")}
                  style={styles.input}
                  multiline
                  editable={!busy}
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={busy || draft.trim().length === 0}
                  onPress={() => void send()}
                  style={[styles.send, (busy || draft.trim().length === 0) && styles.sendDisabled]}
                >
                  <Text style={styles.sendText}>{t(language, "reviews.send")}</Text>
                </Pressable>
              </View>
            </View>
          )}
        </KeyboardAvoidingView>
      </WidePanel>
    </WideShell>
  );
}

function threadTitle(thread: ReviewThread): string {
  return `#${thread.pr.number} ${thread.pr.title}`;
}

function blocked(reason: ReviewWaitReason | undefined): boolean {
  return reason === "no-link" || reason === "ambiguous" || reason === "no-agent";
}

function LinkCard(props: { language: Language; thread: ReviewThread }) {
  const { language, thread } = props;
  const reason = thread.waitReason;
  const linked = thread.link.kind === "linked";
  const tone: ReviewCardModel["tone"] =
    !linked || blocked(reason)
      ? "danger"
      : reason === undefined || reason === "nothing"
        ? "success"
        : "warning";
  const name =
    thread.link.kind === "linked"
      ? thread.link.paneKey
      : thread.link.kind === "ambiguous"
        ? t(language, "reviews.linkAmbiguous")
        : t(language, "reviews.linkNone");
  const waitKey = WAIT_KEY[reason ?? (linked ? "nothing" : "no-link")];
  return (
    <View style={styles.card}>
      <View style={styles.linkRow}>
        <StatusDot tone={tone} />
        <View style={styles.linkText}>
          <Text style={styles.linkName} numberOfLines={1}>
            {name}
          </Text>
          <Text style={[styles.linkWait, { color: WAIT_COLOR[tone] }]} numberOfLines={2}>
            {t(language, waitKey, { branch: thread.pr.headRef })}
          </Text>
        </View>
        {linked && <ReviewChip label={t(language, "reviews.linked")} tone="accent" outlined />}
      </View>
    </View>
  );
}

function CommentCard(props: {
  language: Language;
  entry: ReviewThreadEntry;
  busy: boolean;
  onDeliver(): void;
  onReply(): void;
}) {
  const { language, entry } = props;
  const { comment } = entry;
  const chip = entry.replied
    ? { key: "reviews.state.replied" as MessageKey, tone: "success" as ChipTone }
    : STATE_CHIP[entry.state];
  const where =
    comment.path === undefined
      ? undefined
      : comment.line === undefined
        ? comment.path
        : `${comment.path}:${comment.line}`;
  return (
    <View style={styles.card}>
      <View style={styles.metaRow}>
        <Text style={styles.author} numberOfLines={1}>
          @{comment.author}
        </Text>
        <Text style={[styles.meta, where !== undefined && styles.metaPath]} numberOfLines={1}>
          {where ?? formatClockTime(comment.createdAt)}
        </Text>
        <View style={styles.spacer} />
        <ReviewChip label={t(language, chip.key)} tone={chip.tone} />
      </View>
      <Text style={styles.body}>{comment.body}</Text>
      {entry.replies.map((reply) => (
        <View key={reply.comment.id} style={styles.reply}>
          <Text style={styles.replyText}>
            <Text style={styles.replyAuthor}>
              {reply.state === "own"
                ? t(language, "reviews.state.own")
                : `@${reply.comment.author}`}
            </Text>
            {" — "}
            {reply.comment.body}
          </Text>
        </View>
      ))}
      <View style={styles.actions}>
        {entry.state === "queued" && (
          <Pressable
            accessibilityRole="button"
            disabled={props.busy}
            onPress={props.onDeliver}
            style={[styles.action, props.busy && styles.sendDisabled]}
          >
            <Text style={styles.actionText}>{t(language, "reviews.deliverNow")}</Text>
          </Pressable>
        )}
        {comment.kind === "review-inline" && entry.state !== "own" && (
          <Pressable accessibilityRole="button" onPress={props.onReply} style={styles.action}>
            <Text style={styles.actionText}>{t(language, "reviews.reply")}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const WAIT_COLOR: Record<ReviewCardModel["tone"], string> = {
  success: theme.colors.textMuted,
  warning: theme.colors.warning,
  danger: theme.colors.dangerText,
  muted: theme.colors.textMuted,
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.ground },
  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24, gap: 12 },
  empty: { ...theme.type.body, color: theme.colors.textMuted },
  error: { ...theme.type.body, color: theme.colors.danger },
  card: {
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: theme.radius.card16,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  linkText: { flex: 1, minWidth: 0, gap: 2 },
  linkName: { ...theme.type.rowTitle, color: theme.colors.text },
  linkWait: { ...theme.type.meta },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  author: { ...theme.type.rowTitle, color: theme.colors.text, flexShrink: 1 },
  meta: { ...theme.type.mono, color: theme.colors.textMuted, flexShrink: 1 },
  metaPath: { color: theme.colors.accentText },
  spacer: { flex: 1 },
  body: { ...theme.type.body, color: theme.colors.text, lineHeight: 21 },
  reply: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  replyText: { ...theme.type.body, color: theme.colors.textSecondary, lineHeight: 20 },
  replyAuthor: { color: theme.colors.accentText },
  actions: { flexDirection: "row", gap: 8 },
  action: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 16,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  actionText: { ...theme.type.button, color: theme.colors.accentText },
  composer: {
    gap: 6,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.hairline,
    backgroundColor: theme.colors.ground,
  },
  replying: { flexDirection: "row", alignItems: "center", gap: 8 },
  replyingText: { ...theme.type.meta, color: theme.colors.textMuted, flex: 1 },
  replyingCancel: { ...theme.type.meta, color: theme.colors.link },
  composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  input: {
    flex: 1,
    minHeight: 46,
    maxHeight: 140,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    ...theme.type.body,
    fontSize: 15,
  },
  send: {
    minHeight: 46,
    justifyContent: "center",
    paddingHorizontal: 18,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.accent,
  },
  sendDisabled: { opacity: 0.5 },
  sendText: { ...theme.type.button, color: theme.colors.primaryText },
});
