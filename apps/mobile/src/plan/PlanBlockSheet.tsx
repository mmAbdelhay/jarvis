import { useEffect, useState } from "react";
import { Alert, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { t, type Language } from "../lib/i18n";
import type { PlansStore } from "../lib/plans-store";
import { theme } from "../lib/theme";
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
  useEffect(() => {
    setMode("comment");
    setBody("");
    setSource(props.block?.source ?? "");
  }, [props.block]);
  const block = props.block;
  if (block === undefined) return null;
  const blockId = block.id;
  const quote = block.source.slice(0, 120);

  async function queue(sendNow: boolean) {
    if (body.trim() === "") return;
    const oldIds = new Set(props.store.state.comments.map((comment) => comment.id));
    await props.store.addComment(blockId, quote, body.trim());
    if (sendNow) {
      const added = props.store.state.comments.find(
        (comment) => !oldIds.has(comment.id) && comment.sentAt === undefined,
      );
      if (added !== undefined) await props.store.send([added.id]);
    }
    props.onClose();
  }

  async function save() {
    const result = await props.store.writeBlock(blockId, source);
    if (result === "conflict") {
      Alert.alert(t(props.language, "plans.changedOnDisk"));
      await props.store.open(props.store.state.doc?.path ?? blockId);
      return;
    }
    if (result === "ok") props.onClose();
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
              <TextInput
                multiline
                value={source}
                onChangeText={setSource}
                style={styles.editInput}
              />
              <View style={styles.actions}>
                <Action label={t(props.language, "common.cancel")} onPress={props.onClose} />
                <Action
                  primary
                  label={t(props.language, "plans.save")}
                  onPress={() => void save()}
                />
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
