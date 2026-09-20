// The one tap surface that can ever start a recording (ruling 13: tap to
// start, tap to stop, no hold-to-talk) — used both large on `app/voice.tsx`
// and `compact` beside the session screen's compose bar (Task 8, rule 7).
// A single `Pressable` calling the shared `VoiceController.toggle()`: no
// screen builds its own start/stop wiring, so "the mic cannot transmit
// without a tap" (Task 8's security review) holds in exactly one place.
import { Pressable, StyleSheet, View } from "react-native";
import type { MessageKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useVoiceController } from "@/lib/voice-context";
import { theme } from "@/lib/theme";

export function MicButton(props: {
  enabled: boolean;
  active: boolean;
  labelKey: MessageKey;
  compact?: boolean;
}) {
  const language = useLanguage();
  const controller = useVoiceController();
  const label = t(language, props.labelKey);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !props.enabled, selected: props.active }}
      disabled={!props.enabled}
      onPress={() => {
        void controller.toggle();
      }}
      style={[
        styles.button,
        props.compact ? styles.compact : styles.large,
        props.active && styles.active,
        !props.enabled && styles.disabled,
      ]}
    >
      <View style={[styles.dot, props.compact && styles.dotCompact]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.primary,
  },
  large: {
    width: 84,
    height: 84,
    alignSelf: "center",
    shadowColor: theme.colors.accent,
    shadowOpacity: 0.28,
    shadowRadius: 10,
  },
  compact: { width: 44, height: 44 },
  active: { backgroundColor: theme.colors.danger },
  disabled: { opacity: 0.4 },
  dot: {
    width: 22,
    height: 22,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.primaryText,
  },
  dotCompact: { width: 12, height: 12 },
});
