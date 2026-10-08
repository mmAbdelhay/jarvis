// The one tap surface that can ever start a recording (ruling 13: tap to
// start, tap to stop, no hold-to-talk) — used both large on `app/voice.tsx`
// and `variant="square"` beside the session screen's compose bar (Task 8, rule 7).
// A single `Pressable` calling the shared `VoiceController.toggle()`: no
// screen builds its own start/stop wiring, so "the mic cannot transmit
// without a tap" (Task 8's security review) holds in exactly one place.
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "@/components/Icon";
import type { MessageKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useVoiceController } from "@/lib/voice-context";
import { theme } from "@/lib/theme";

export function MicButton(props: {
  enabled: boolean;
  active: boolean;
  labelKey: MessageKey;
  /** "square": the 46 bordered dictate button beside the compose field. */
  variant?: "square";
}) {
  const language = useLanguage();
  const controller = useVoiceController();
  const label = t(language, props.labelKey);
  const square = props.variant === "square";

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
        square ? styles.square : styles.large,
        props.active && (square ? styles.squareActive : styles.active),
        !props.enabled && styles.disabled,
      ]}
    >
      {square ? (
        <Icon
          name="mic"
          size={20}
          strokeWidth={2}
          color={props.active ? theme.colors.danger : theme.colors.textSecondary}
        />
      ) : (
        <View style={styles.dot} />
      )}
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
  square: {
    width: 46,
    height: 46,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  squareActive: { borderColor: theme.colors.danger, backgroundColor: theme.colors.dangerSurface },
  active: { backgroundColor: theme.colors.danger },
  disabled: { opacity: 0.4 },
  dot: {
    width: 22,
    height: 22,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.primaryText,
  },
});
