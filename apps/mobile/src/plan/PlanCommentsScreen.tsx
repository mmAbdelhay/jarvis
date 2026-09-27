import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { t, type Language } from "../lib/i18n";
import { theme } from "../lib/theme";
import type { AnchoredComment } from "./types";

export function PlanCommentsScreen(props: {
  comments: AnchoredComment[];
  language: Language;
  tabTitle: string;
  onSend(ids: string[]): void;
}) {
  const queued = props.comments.filter((comment) => comment.sentAt === undefined);
  const sent = props.comments.filter((comment) => comment.sentAt !== undefined);
  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <CommentSection title={t(props.language, "plans.queued")} comments={queued} />
        <CommentSection title={t(props.language, "plans.sent")} comments={sent} />
      </ScrollView>
      <View style={styles.footer}>
        <Text style={styles.note}>
          {t(props.language, "plans.pastesInto", { title: props.tabTitle })}
        </Text>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={queued.length === 0}
          onPress={() => props.onSend(queued.map((comment) => comment.id))}
          style={[styles.send, queued.length === 0 && styles.disabled]}
        >
          <Text style={styles.sendText}>
            {t(props.language, "plans.sendCountToClaude", { count: queued.length })}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function CommentSection(props: { title: string; comments: AnchoredComment[] }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{props.title}</Text>
      {props.comments.map((comment) => (
        <View key={comment.id} style={styles.card}>
          <Text style={styles.number}>#{comment.number}</Text>
          <Text style={styles.quote} numberOfLines={2}>
            {comment.quote}
          </Text>
          <Text style={styles.body}>{comment.body}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: theme.spacing.md, gap: theme.spacing.lg },
  section: { gap: theme.spacing.sm },
  sectionTitle: { color: theme.colors.textMuted, fontFamily: theme.font.semibold, fontSize: 13 },
  card: {
    backgroundColor: theme.colors.surfaceAlt,
    borderColor: theme.colors.hairline,
    borderWidth: 1,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  number: { color: theme.colors.warning, fontFamily: theme.font.bold },
  quote: { color: theme.colors.textMuted, fontFamily: theme.font.medium },
  body: { color: theme.colors.text, fontFamily: theme.font.body },
  footer: { borderTopColor: theme.colors.hairline, borderTopWidth: 1, padding: theme.spacing.md },
  note: { color: theme.colors.textMuted, textAlign: "center", marginBottom: theme.spacing.sm },
  send: {
    minHeight: 48,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.4 },
  sendText: { color: theme.colors.primaryText, fontFamily: theme.font.bold },
});
