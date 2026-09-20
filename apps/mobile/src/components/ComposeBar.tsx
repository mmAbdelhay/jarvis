import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { isRtl, t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import type { SendResult } from "@/lib/session-input";
import { sendResultText } from "@/lib/session-screen";
import { theme } from "@/lib/theme";

export function ComposeBar(props: {
  disabled: boolean;
  onSend(text: string): Promise<SendResult>;
  onSent(): void;
}) {
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
        setNotice(sendResultText(result, language));
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setNotice(""), 4000);
      }
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  }

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
          placeholder={t(language, "session.composePlaceholder")}
          placeholderTextColor={theme.colors.textMuted}
          accessibilityLabel={t(language, "session.composePlaceholder")}
          onSubmitEditing={() => {
            void send();
          }}
          style={[styles.input, { writingDirection: isRtl(language) ? "rtl" : "ltr" }]}
        />
        <TouchableOpacity
          disabled={props.disabled || sending}
          accessibilityRole="button"
          accessibilityLabel={t(language, "session.sendText")}
          onPress={() => {
            void send();
          }}
          style={styles.button}
        >
          <Text style={styles.buttonText}>↑</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 8,
    gap: theme.spacing.sm,
    backgroundColor: theme.colors.ground,
  },
  row: { flexDirection: "row", gap: theme.spacing.sm },
  input: {
    flex: 1,
    color: theme.colors.text,
    height: 44,
    paddingHorizontal: 14,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontFamily: theme.font.body,
  },
  button: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.control,
  },
  buttonText: { color: theme.colors.primaryText, fontSize: 22, fontFamily: theme.font.bold },
  notice: { color: theme.colors.warning, fontSize: theme.font.size.sm },
});
