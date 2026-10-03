import { Pressable, StyleSheet } from "react-native";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/lib/icon-paths";
import { theme } from "@/lib/theme";

/**
 * A square icon button. Size 44 is the bordered header button (r12); size 40
 * is the borderless row action (r10); 46 is the compose row's (r14); 28 is the wide status bar's borderless button (r7). The label is the accessibility name,
 * since the icon itself is hidden from it.
 */
export function IconButton(props: {
  icon: IconName;
  label: string;
  onPress(): void;
  size?: 46 | 44 | 40 | 28;
  color?: string;
  iconSize?: number;
  strokeWidth?: number;
  /** An accent-filled button (Send). */
  filled?: boolean;
  disabled?: boolean;
  mirrorInRtl?: boolean;
}) {
  const size = props.size ?? 44;
  const bordered = size !== 40 && size !== 28 && !props.filled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={size === 40 || size === 28 ? 4 : 0}
      style={[
        styles.base,
        size === 28
          ? styles.tiny
          : size === 40
            ? styles.small
            : size === 46
              ? styles.large
              : styles.regular,
        bordered && styles.bordered,
        props.filled && styles.filled,
        props.disabled && styles.disabled,
      ]}
    >
      <Icon
        name={props.icon}
        size={props.iconSize ?? (size === 40 ? 18 : 20)}
        color={
          props.color ?? (props.filled ? theme.colors.primaryText : theme.colors.textSecondary)
        }
        {...(props.strokeWidth === undefined ? {} : { strokeWidth: props.strokeWidth })}
        {...(props.mirrorInRtl === undefined ? {} : { mirrorInRtl: props.mirrorInRtl })}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: "center", justifyContent: "center" },
  regular: { width: 44, height: 44, borderRadius: theme.radius.control },
  large: { width: 46, height: 46, borderRadius: theme.radius.lg },
  tiny: { width: 28, height: 28, borderRadius: 7 },
  small: { width: 40, height: 40, borderRadius: theme.radius.small },
  bordered: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  filled: { backgroundColor: theme.colors.accent },
  disabled: { opacity: 0.45 },
});
