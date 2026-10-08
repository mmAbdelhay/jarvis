import type { ReactNode } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconButton } from "@/components/IconButton";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { screenHeaderModel } from "@/lib/screen-header";
import { theme } from "@/lib/theme";

/**
 * The phone's own screen header, in place of the native stack header: back
 * chevron, a title with an optional subtitle, and trailing actions. Wide
 * layouts draw their own panel titles and never render this.
 */
export function ScreenHeader(props: {
  title: string;
  subtitle?: string;
  subtitleTone?: "muted" | "warning";
  subtitleMono?: boolean;
  onBack?: () => void;
  trailing?: ReactNode;
  onSubtitlePress?: () => void;
  size?: "detail" | "page";
  bordered?: boolean;
}) {
  const language = useLanguage();
  const insets = useSafeAreaInsets();
  const model = screenHeaderModel({
    language,
    subtitle: props.subtitle,
    hasBack: props.onBack !== undefined,
  });
  const titleStyle = props.size === "page" ? theme.type.screenTitle : theme.type.headerTitle;
  const subtitle =
    model.subtitle === undefined ? null : (
      <Text
        style={[
          styles.subtitle,
          props.subtitleMono && styles.mono,
          props.subtitleTone === "warning" && styles.warning,
        ]}
        numberOfLines={1}
      >
        {model.subtitle}
      </Text>
    );
  return (
    <View
      style={[
        styles.row,
        { paddingTop: insets.top + 14 },
        props.bordered !== false && styles.bordered,
      ]}
    >
      {model.showBack && props.onBack !== undefined && (
        <IconButton
          icon="back"
          label={t(language, "common.back")}
          onPress={props.onBack}
          mirrorInRtl={model.backMirrored}
        />
      )}
      <View style={styles.text}>
        <Text style={[titleStyle, styles.title]} numberOfLines={1}>
          {props.title}
        </Text>
        {subtitle !== null &&
          (props.onSubtitlePress === undefined ? (
            subtitle
          ) : (
            <TouchableOpacity accessibilityRole="button" onPress={props.onSubtitlePress}>
              {subtitle}
            </TouchableOpacity>
          ))}
      </View>
      {props.trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingBottom: 10,
    paddingHorizontal: 16,
    backgroundColor: theme.colors.ground,
  },
  bordered: { borderBottomWidth: 1, borderBottomColor: theme.colors.hairlineSoft },
  text: { flex: 1, minWidth: 0 },
  title: { color: theme.colors.text },
  subtitle: { color: theme.colors.textMuted, fontFamily: theme.font.body, fontSize: 12 },
  mono: { fontFamily: theme.font.mono },
  warning: { color: theme.colors.warning },
});
