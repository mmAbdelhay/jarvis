import { useEffect, useState } from "react";
import { Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { dialogs } from "../lib/dialog";
import { t, type Language } from "../lib/i18n";
import type { PlansStore } from "../lib/plans-store";
import { theme } from "../lib/theme";
import { planErrorText } from "./plan-error";
import { planBlockPlainText } from "./plain-text";
import type { PlanBlock } from "./types";

export function PlanBlockSheet(props: {
  block?: PlanBlock;
  language: Language;
  store: PlansStore;
  onClose(): void;
}) {
  const [mode, setMode] = useState<"comment" | "edit">("comment");
  const [body, setBody] = useState("");
  const [source, setSource] = useState("");
  const [activeBlock, setActiveBlock] = useState<PlanBlock>();
  const [notice, setNotice] = useState<"changedOnDisk" | "blockGone">();
  const { store } = props;
  useEffect(() => {
    setMode("comment");
    setBody("");
    setSource(props.block?.source ?? "");
    setActiveBlock(props.block);
    setNotice(undefined);
    // Final fix wave M4: an error left over from an earlier action is not
    // about this block — never show it as this sheet opens.
    if (props.block !== undefined) store.clearError();
  }, [props.block, store]);
  const block = activeBlock ?? props.block;
  if (block === undefined) return null;
  const blockId = block.id;
  const quote = planBlockPlainText(block.source);

  async function queue(sendNow: boolean) {
    if (body.trim() === "") return;
    const added = await props.store.addComment(blockId, quote, body.trim());
    if (!added.ok) return;
    if (sendNow && !(await props.store.send([added.value.id])).ok) return;
    props.onClose();
  }

  // Final fix wave I4: a refused save never replaces what the user typed.
  // On a conflict only the target (and so the base mtime) moves to the
  // fresh doc — Save again applies the same text; a block that is gone
  // keeps the sheet open with the text and a notice instead of closing.
  async function save() {
    if (notice === "blockGone" || block === undefined) return;
    const outcome = await props.store.saveBlock(block, source);
    if (outcome.kind === "saved") {
      props.onClose();
      return;
    }
    if (outcome.kind === "kept") {
      if (outcome.block !== undefined) setActiveBlock(outcome.block);
      setNotice(outcome.notice);
      return;
    }
    dialogs.notice(planErrorText(props.language, props.store.state.error?.code ?? "saveFailed"));
  }

  return (
    <Modal transparent animationType="slide" visible onRequestClose={props.onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <View style={styles.segmented}>
            {(["comment", "edit"] as const).map((item) => (
              <TouchableOpacity
                key={item}
                onPress={() => setMode(item)}
                style={[styles.segment, mode === item && styles.segmentActive]}
              >
                <Text style={[styles.segmentText, mode === item && styles.segmentTextActive]}>
                  {t(props.language, item === "comment" ? "plans.comment" : "plans.editBlock")}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {props.store.state.error !== undefined && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>
                {planErrorText(props.language, props.store.state.error.code)}
              </Text>
              {props.store.state.error.detail !== undefined && (
                <Text style={styles.errorDetail}>{props.store.state.error.detail}</Text>
              )}
            </View>
          )}
          {mode === "comment" ? (
            <>
              <Text style={styles.label}>{t(props.language, "plans.quotedText")}</Text>
              <Text style={styles.quote}>{quote}</Text>
              <TextInput
                multiline
                autoFocus
                value={body}
                onChangeText={setBody}
                placeholder={t(props.language, "plans.commentPlaceholder")}
                placeholderTextColor={theme.colors.textFaint}
                style={styles.input}
              />
              <View style={styles.actions}>
                <Action label={t(props.language, "common.cancel")} onPress={props.onClose} />
                <Action
                  label={t(props.language, "plans.queue")}
                  onPress={() => void queue(false)}
                />
                <Action
                  primary
                  label={t(props.language, "plans.sendNow")}
                  onPress={() => void queue(true)}
                />
              </View>
            </>
          ) : (
            <>
              {notice !== undefined && (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>
                    {t(
                      props.language,
                      notice === "blockGone" ? "plans.blockGoneKept" : "plans.changedOnDiskKept",
                    )}
                  </Text>
                </View>
              )}
              <TextInput
                multiline
                value={source}
                onChangeText={setSource}
                style={styles.editInput}
              />
              <View style={styles.actions}>
                <Action label={t(props.language, "common.cancel")} onPress={props.onClose} />
                {notice !== "blockGone" && (
                  <Action
                    primary
                    label={t(props.language, "plans.save")}
                    onPress={() => void save()}
                  />
                )}
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

function Action(props: { label: string; onPress(): void; primary?: boolean }) {
  return (
    <TouchableOpacity
      onPress={props.onPress}
      style={[styles.action, props.primary && styles.primary]}
    >
      <Text style={[styles.actionText, props.primary && styles.primaryText]}>{props.label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopStartRadius: theme.radius.lg,
    borderTopEndRadius: theme.radius.lg,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  grabber: {
    width: 42,
    height: 4,
    alignSelf: "center",
    borderRadius: 2,
    backgroundColor: theme.colors.textFaint,
  },
  segmented: {
    flexDirection: "row",
    backgroundColor: theme.colors.ground,
    borderRadius: theme.radius.control,
    padding: 3,
  },
  segment: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
  },
  segmentActive: { backgroundColor: theme.colors.selected },
  segmentText: { color: theme.colors.textMuted, fontFamily: theme.font.semibold },
  segmentTextActive: { color: theme.colors.text },
  errorBanner: {
    backgroundColor: theme.colors.surfaceAlt,
    borderColor: theme.colors.warning,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
  },
  errorText: { color: theme.colors.warning, fontFamily: theme.font.semibold },
  errorDetail: { color: theme.colors.textMuted, fontFamily: theme.font.body, fontSize: 12 },
  label: { color: theme.colors.textMuted, fontFamily: theme.font.semibold },
  quote: {
    color: theme.colors.textSecondary,
    backgroundColor: theme.colors.ground,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.sm,
  },
  input: {
    minHeight: 110,
    color: theme.colors.text,
    backgroundColor: theme.colors.ground,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    textAlignVertical: "top",
  },
  editInput: {
    minHeight: 220,
    color: theme.colors.text,
    backgroundColor: theme.colors.ground,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    textAlignVertical: "top",
    fontFamily: theme.font.mono,
  },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing.sm },
  action: {
    minHeight: 44,
    paddingHorizontal: theme.spacing.md,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.control,
    borderColor: theme.colors.hairline,
    borderWidth: 1,
  },
  actionText: { color: theme.colors.text, fontFamily: theme.font.semibold },
  primary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  primaryText: { color: theme.colors.primaryText },
});
