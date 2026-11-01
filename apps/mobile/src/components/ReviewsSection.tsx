import { Pressable, StyleSheet, Text, View } from "react-native";
import { type Language, t } from "@/lib/i18n";
import {
  type ReviewCardChip,
  type ReviewCardModel,
  type ReviewListItem,
  reviewAge,
  reviewCardModel,
  sortReviewItems,
} from "@/lib/reviews-store";
import { theme } from "@/lib/theme";

/** At most this many cards on Home; the rest are one tap away. */
const SECTION_LIMIT = 3;

export type ChipTone = "accent" | "warning" | "danger" | "success" | "muted";

/** A small rounded label: outlined for "linked", filled for a state. */
export function ReviewChip(props: { label: string; tone: ChipTone; outlined?: boolean }) {
  const palette = CHIP_PALETTE[props.tone];
  return (
    <View
      style={[
        styles.chip,
        props.outlined
          ? { borderColor: theme.colors.accent, borderWidth: 1 }
          : { backgroundColor: palette.ground },
      ]}
    >
      <Text style={[styles.chipText, { color: palette.text }]} numberOfLines={1}>
        {props.label}
      </Text>
    </View>
  );
}

export function StatusDot(props: { tone: ReviewCardModel["tone"] }) {
  return <View style={[styles.dot, { backgroundColor: DOT_COLOR[props.tone] }]} />;
}

function chipFor(language: Language, chip: ReviewCardChip): { label: string; tone: ChipTone } {
  if (chip.kind === "queued") {
    return { label: t(language, "reviews.queued", { count: chip.count }), tone: "warning" };
  }
  if (chip.kind === "waiting") {
    return { label: t(language, "reviews.waiting", { count: chip.count }), tone: "danger" };
  }
  if (chip.kind === "delivered")
    return { label: t(language, "reviews.delivered"), tone: "success" };
  return { label: "", tone: "muted" };
}

function cardSubtitle(language: Language, item: ReviewListItem, model: ReviewCardModel): string {
  const parts = [model.repoName];
  if (item.pr.role === "review-requested") {
    parts.push(t(language, "reviews.by", { author: item.pr.author }));
  }
  if (item.pr.isDraft) parts.push(t(language, "reviews.draft"));
  if (model.needsTerminal) {
    parts.push(t(language, "reviews.openTerminalOn", { branch: item.pr.headRef }));
  }
  return parts.join(" · ");
}

export function formatReviewAge(language: Language, now: number, at: number): string {
  const age = reviewAge(now, at);
  return age === "now" ? t(language, "reviews.now") : age;
}

/**
 * One PR: status dot, `#N title`, the repo (and where to open a terminal
 * when nothing will take its comments), the link chip and the state chip.
 * `compact` is Home's tile: one chip, a little less padding.
 */
export function ReviewCard(props: {
  language: Language;
  item: ReviewListItem;
  now: number;
  compact?: boolean;
  onPress(): void;
}) {
  const { language, item } = props;
  const model = reviewCardModel(item);
  const chip = chipFor(language, model.chip);
  const title = `#${item.pr.number} ${item.pr.title}`;
  const showLinked = model.linked && !props.compact;
  const showAge = !model.linked && item.lastActivity !== undefined && !props.compact;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={props.onPress}
      style={[styles.card, props.compact && styles.cardCompact]}
    >
      <StatusDot tone={model.tone} />
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {cardSubtitle(language, item, model)}
        </Text>
      </View>
      <View style={styles.chips}>
        {showLinked && <ReviewChip label={t(language, "reviews.linked")} tone="accent" outlined />}
        {model.chip.kind !== "none" && <ReviewChip label={chip.label} tone={chip.tone} />}
        {showAge && item.lastActivity !== undefined && (
          <Text style={styles.age}>{formatReviewAge(language, props.now, item.lastActivity)}</Text>
        )}
      </View>
    </Pressable>
  );
}

/**
 * Home's REVIEWS section, above SESSIONS on both layouts: the count, "All
 * reviews", and the PRs that most need the user. Hidden entirely when the
 * laptop reports none (or doesn't serve reviews at all).
 */
export function ReviewsSection(props: {
  language: Language;
  items: readonly ReviewListItem[] | undefined;
  now: number;
  onOpen(key: string): void;
  onAll(): void;
}) {
  const items = props.items ?? [];
  if (items.length === 0) return null;
  const shown = sortReviewItems(items).slice(0, SECTION_LIMIT);
  return (
    <View style={styles.section} accessibilityLabel={t(props.language, "reviews.title")}>
      <View style={styles.header}>
        <Text style={styles.sectionTitle}>{t(props.language, "reviews.section")}</Text>
        <Text style={styles.count}>{items.length}</Text>
        <View style={styles.spacer} />
        <Pressable accessibilityRole="link" onPress={props.onAll}>
          <Text style={styles.link}>{t(props.language, "reviews.all")}</Text>
        </Pressable>
      </View>
      {shown.map((item) => (
        <ReviewCard
          key={item.key}
          language={props.language}
          item={item}
          now={props.now}
          compact
          onPress={() => props.onOpen(item.key)}
        />
      ))}
    </View>
  );
}

const CHIP_PALETTE: Record<ChipTone, { ground: string; text: string }> = {
  accent: { ground: theme.colors.accentSoft, text: theme.colors.accentText },
  warning: { ground: theme.colors.warningSurface, text: theme.colors.warning },
  danger: { ground: theme.colors.dangerSurface, text: theme.colors.dangerText },
  success: { ground: theme.colors.successSurface, text: theme.colors.success },
  muted: { ground: theme.colors.surfaceAlt, text: theme.colors.textMuted },
};

const DOT_COLOR: Record<ReviewCardModel["tone"], string> = {
  warning: theme.colors.warning,
  danger: theme.colors.danger,
  success: theme.colors.success,
  muted: theme.colors.disabledDot,
};

const styles = StyleSheet.create({
  section: { gap: 8 },
  header: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  sectionTitle: { ...theme.type.sectionLabelLarge, color: theme.colors.textMuted },
  count: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.colors.accentText },
  spacer: { flex: 1 },
  link: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.colors.link },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: theme.radius.card16,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  cardCompact: { paddingVertical: 12, paddingHorizontal: 12, gap: 12 },
  dot: { width: 10, height: 10, borderRadius: theme.radius.full },
  text: { flex: 1, minWidth: 0, gap: 3 },
  title: { ...theme.type.rowTitle, color: theme.colors.text },
  sub: { ...theme.type.meta, color: theme.colors.textMuted },
  chips: { alignItems: "flex-end", gap: 6 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: theme.radius.pill,
  },
  chipText: { ...theme.type.meta, fontFamily: theme.font.semibold },
  age: { ...theme.type.mono, color: theme.colors.textMuted },
});
