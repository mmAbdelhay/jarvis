import { type ReactNode, useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { IconButton } from "@/components/IconButton";
import { clientPlatformFor } from "@/lib/client-platform";
import { isRtl, t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import type { SendResult } from "@/lib/session-input";
import { isSendChord, sendResultText } from "@/lib/session-screen";
import { theme } from "@/lib/theme";

export function ComposeBar(props: {
  disabled: boolean;
  onSend(text: string): Promise<SendResult>;
  onSent(): void;
  /** The hint in the empty field; defaults to the generic one. */
  placeholder?: string;
  /** Type the field in the monospace face (a terminal command line). */
  mono?: boolean;
  /** Sits between the field and Send (the dictate button). */
  beforeSend?: ReactNode;
  /** "inline" (wide Session card): a 42-high field and a text Send button. */
  variant?: "inline";
}) {
  const inline = props.variant === "inline";
  const language = useLanguage();
  const [value, setValue] = useState("");
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  async function send() {
    if (props.disabled || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    const sentValue = value;
    try {
      const result = await props.onSend(sentValue);
      if (!mounted.current) return;
      props.onSent();
      if (result.kind === "sent") {
        setValue((current) => (current === sentValue ? "" : current));
        setNotice("");
      } else {
        setNotice(sendResultText(result, language, clientPlatformFor(Platform.OS)));
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setNotice(""), 4000);
      }
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  }

  const placeholder = props.placeholder ?? t(language, "session.composePlaceholder");
  return (
    <View style={styles.container}>
      {notice !== "" && (
        <Text accessibilityLiveRegion="polite" style={styles.notice}>
          {notice}
        </Text>
      )}
      <View style={styles.row}>
        <TextInput
          value={value}
          onChangeText={setValue}
          editable={!props.disabled && !sending}
          multiline={false}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textMuted}
          accessibilityLabel={placeholder}
          onSubmitEditing={() => {
            void send();
          }}
          // Web: ⌘/Ctrl+Enter sends too. The other platforms' key events
          // carry no modifier fields, so this reads nothing there.
          onKeyPress={(event) => {
            if (Platform.OS !== "web") return;
            const native: unknown = event.nativeEvent;
            if (typeof native !== "object" || native === null) return;
            const { key, metaKey, ctrlKey } = native as Record<string, unknown>;
            if (typeof key !== "string") return;
            if (isSendChord({ key, metaKey: metaKey === true, ctrlKey: ctrlKey === true })) {
              void send();
            }
          }}
          style={[
            styles.input,
            inline && styles.inputInline,
            props.mono && styles.mono,
            { writingDirection: isRtl(language) ? "rtl" : "ltr" },
          ]}
        />
        {props.beforeSend}
        {inline ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(language, "session.sendText")}
            accessibilityState={{ disabled: props.disabled || sending }}
            disabled={props.disabled || sending}
            onPress={() => {
              void send();
            }}
            style={[styles.sendInline, (props.disabled || sending) && styles.sendDisabled]}
          >
            <Text style={styles.sendText}>{t(language, "session.send")}</Text>
          </Pressable>
        ) : (
          <IconButton
            icon="send"
            size={46}
            filled
            label={t(language, "session.sendText")}
            disabled={props.disabled || sending}
            onPress={() => {
              void send();
            }}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: theme.spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm },
  input: {
    flex: 1,
    color: theme.colors.text,
    minHeight: 46,
    paddingHorizontal: 14,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontFamily: theme.font.body,
    fontSize: 15,
  },
  inputInline: { minHeight: 42, borderRadius: theme.radius.small, fontSize: 14 },
  sendInline: {
    minHeight: 42,
    justifyContent: "center",
    paddingHorizontal: 16,
    borderRadius: theme.radius.small,
    backgroundColor: theme.colors.accent,
  },
  sendDisabled: { opacity: 0.5 },
  sendText: { color: theme.colors.primaryText, fontFamily: theme.font.bold, fontSize: 14 },
  mono: { fontFamily: theme.font.mono, fontSize: 13 },
  notice: { color: theme.colors.warning, fontSize: theme.font.size.sm },
});
