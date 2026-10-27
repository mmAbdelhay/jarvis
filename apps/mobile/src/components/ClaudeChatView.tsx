import { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { ChatToolRow } from "@/components/ChatToolRow";
import { ClaudePromptCard } from "@/components/ClaudePromptCard";
import { ClaudeStatusStrip } from "@/components/ClaudeStatusStrip";
import { type FeedItem, chatFeed, linkParts } from "@/lib/claude-chat";
import { type ChatBlock, type ChatInline, parseChatText } from "@/lib/chat-text";
import { type Language, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";
import type { ClaudeView } from "@jarvis/wire";

type Claude = Extract<ClaudeView, { kind: "claude" }>;

/**
 * The Chat tab of a terminal pane running Claude Code: the status strip,
 * the transcript newest at the bottom (an inverted list), and Claude's
 * pending question. Everything Claude wrote is shown as written, left to
 * right whatever the app's language; links open only over https.
 */
export function ClaudeChatView(props: {
  language: Language;
  view: Claude;
  sessionUsed?: number;
  weekUsed?: number;
  answering: boolean;
  disabled: boolean;
  onMode(): void;
  onAnswer(index: number, label: string): void;
  onOpenLink(url: string): void;
}) {
  const feed = useMemo(() => chatFeed(props.view), [props.view]);
  return (
    <View style={styles.container}>
      <ClaudeStatusStrip
        language={props.language}
        mode={props.view.mode}
        model={props.view.model}
        sessionUsed={props.sessionUsed}
        weekUsed={props.weekUsed}
        disabled={props.disabled}
        onMode={props.onMode}
      />
      {feed.length === 0 ? (
        <View style={styles.feed}>
          <Text style={styles.empty}>{t(props.language, "claude.empty")}</Text>
        </View>
      ) : (
        <FlatList
          inverted
          style={styles.feed}
          contentContainerStyle={styles.feedContent}
          data={feed}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => <FeedRow item={item} onOpenLink={props.onOpenLink} />}
          keyboardShouldPersistTaps="handled"
        />
      )}
      {props.view.prompt !== undefined && (
        <ClaudePromptCard
          language={props.language}
          prompt={props.view.prompt}
          answering={props.answering || props.disabled}
          onAnswer={props.onAnswer}
        />
      )}
    </View>
  );
}

/** The header's Chat | Term switch, shown while Claude runs in the pane. */
export function ClaudeTabToggle(props: {
  language: Language;
  tab: "chat" | "term";
  onChange(tab: "chat" | "term"): void;
}) {
  return (
    <View
      style={styles.toggle}
      accessibilityRole="tablist"
      accessibilityLabel={t(props.language, "claude.viewToggle")}
    >
      {(["chat", "term"] as const).map((tab) => {
        const on = props.tab === tab;
        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => props.onChange(tab)}
            // 36-high segments: the slop makes each a 44-dp target.
            hitSlop={{ top: 4, bottom: 4 }}
            style={[styles.toggleItem, on && styles.toggleOn]}
          >
            <Text style={[styles.toggleText, on && styles.toggleTextOn]}>
              {t(props.language, tab === "chat" ? "claude.chat" : "claude.term")}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function FeedRow(props: { item: FeedItem; onOpenLink(url: string): void }) {
  const { item } = props;
  switch (item.kind) {
    case "user":
      return (
        <View style={styles.row}>
          <View style={styles.you}>
            <Text style={styles.youText} selectable>
              {item.text}
            </Text>
          </View>
        </View>
      );
    case "tool":
      return (
        <View style={styles.row}>
          <ChatToolRow tool={item.tool} />
        </View>
      );
    case "working":
      return (
        <View style={styles.row}>
          <Text style={styles.working} numberOfLines={2}>
            {item.text}
          </Text>
        </View>
      );
    case "text":
      return (
        <View style={[styles.row, styles.text]}>
          {parseChatText(item.text).map((block, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional within one reply.
            <Block key={index} block={block} onOpenLink={props.onOpenLink} />
          ))}
        </View>
      );
  }
}

function Block(props: { block: ChatBlock; onOpenLink(url: string): void }) {
  const { block } = props;
  if (block.kind === "codeBlock") {
    return (
      <Text style={styles.codeBlock} selectable>
        {block.text}
      </Text>
    );
  }
  if (block.kind === "list") {
    return (
      <View style={styles.list}>
        {block.items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional.
          <View key={index} style={styles.listItem}>
            <Text style={styles.marker}>{item.marker}</Text>
            <Inlines inlines={item.inlines} onOpenLink={props.onOpenLink} />
          </View>
        ))}
      </View>
    );
  }
  return <Inlines inlines={block.inlines} onOpenLink={props.onOpenLink} />;
}

function Inlines(props: { inlines: ChatInline[]; onOpenLink(url: string): void }) {
  return (
    <Text style={styles.para} selectable>
      {props.inlines.map((inline, index) => {
        const key = String(index);
        switch (inline.kind) {
          case "text":
            return <Text key={key}>{inline.text}</Text>;
          case "bold":
            return (
              <Text key={key} style={styles.bold}>
                {inline.text}
              </Text>
            );
          case "code":
            return (
              <Text key={key} style={styles.code}>
                {inline.text}
              </Text>
            );
          case "link": {
            const parts = linkParts(inline.text, inline.url);
            return (
              <Text
                key={key}
                accessibilityRole="link"
                style={styles.link}
                onPress={() => props.onOpenLink(inline.url)}
              >
                {parts.text}
                {parts.host !== undefined && <Text style={styles.host}> ({parts.host})</Text>}
              </Text>
            );
          }
          default:
            return null;
        }
      })}
    </Text>
  );
}

const styles = StyleSheet.create({
  toggle: {
    height: 36,
    flexDirection: "row",
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.sm,
    overflow: "hidden",
  },
  toggleItem: { minWidth: 44, paddingHorizontal: 10, justifyContent: "center" },
  toggleOn: { backgroundColor: theme.colors.claudeBubble },
  toggleText: { fontFamily: theme.font.semibold, fontSize: 12, color: theme.colors.textMuted },
  toggleTextOn: { color: theme.colors.text },
  container: { flex: 1, backgroundColor: theme.colors.ground },
  feed: { flex: 1, direction: "ltr" },
  feedContent: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 14 },
  row: { paddingVertical: 6 },
  you: {
    alignSelf: "flex-end",
    maxWidth: "82%",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: theme.colors.claudeBubbleBorder,
    backgroundColor: theme.colors.claudeBubble,
    borderTopStartRadius: 16,
    borderTopEndRadius: 16,
    borderBottomStartRadius: 16,
    borderBottomEndRadius: 4,
  },
  youText: { fontFamily: theme.font.body, fontSize: 15, lineHeight: 21, color: theme.colors.text },
  text: { gap: 8 },
  para: {
    fontFamily: theme.font.body,
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.transcriptText,
  },
  bold: { fontFamily: theme.font.bold, color: theme.colors.text },
  code: {
    fontFamily: theme.font.mono,
    fontSize: 13,
    color: theme.colors.textSecondary,
    backgroundColor: theme.colors.surfaceAlt,
  },
  codeBlock: {
    fontFamily: theme.font.mono,
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.transcriptText,
    backgroundColor: theme.colors.terminalGround,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.small,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  link: { color: theme.colors.accent, textDecorationLine: "underline" },
  host: { color: theme.colors.textMuted, textDecorationLine: "none" },
  list: { gap: 4 },
  listItem: { flexDirection: "row", gap: 8 },
  marker: {
    minWidth: 18,
    fontFamily: theme.font.semibold,
    fontSize: 15,
    lineHeight: 22,
    color: theme.colors.textMuted,
  },
  working: { fontFamily: theme.font.mono, fontSize: 13, color: theme.colors.claudeWorking },
  empty: {
    ...theme.type.meta,
    color: theme.colors.textDim,
    textAlign: "center",
    paddingVertical: 24,
    marginTop: "auto",
  },
});
