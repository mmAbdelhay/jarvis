import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { t, type Language, type MessageKey } from "@/lib/i18n";
import { type LaptopSettings, readLaptopSettings, type WorktreeMode } from "@/lib/laptop-settings";
import { useRpcClient } from "@/lib/rpc-context";
import { theme } from "@/lib/theme";

const WORKTREE_KEYS: Record<WorktreeMode, MessageKey> = {
  off: "laptopSettings.worktreesOff",
  parallel: "laptopSettings.worktreesParallel",
  always: "laptopSettings.worktreesAlways",
};

/**
 * Settings' view of the paired laptop: its agents, projects and how it
 * isolates parallel sessions. Read-only — changing them stays on the
 * laptop, which the section says rather than leaving the reader to wonder.
 */
export function LaptopSettingsSection(props: { language: Language }) {
  const client = useRpcClient();
  const [settings, setSettings] = useState<LaptopSettings | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void readLaptopSettings(client).then((next) => {
      if (cancelled) return;
      setSettings(next);
      setFailed(next === undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const { language } = props;
  return (
    <View style={styles.block}>
      {failed && <Text style={styles.note}>{t(language, "laptopSettings.unavailable")}</Text>}
      {settings !== undefined && (
        <>
          <Text style={styles.label}>{t(language, "laptopSettings.agents")}</Text>
          <View style={styles.list}>
            {settings.agents.length === 0 && (
              <Text style={styles.note}>{t(language, "laptopSettings.none")}</Text>
            )}
            {settings.agents.map((agent) => (
              <View key={agent.id} style={styles.item}>
                <Text style={styles.name}>{agent.id}</Text>
                {agent.vendor !== undefined && <Text style={styles.meta}>{agent.vendor}</Text>}
              </View>
            ))}
          </View>
          <Text style={styles.label}>{t(language, "laptopSettings.projects")}</Text>
          <View style={styles.chips}>
            {settings.projects.length === 0 && (
              <Text style={styles.note}>{t(language, "laptopSettings.none")}</Text>
            )}
            {settings.projects.map((project) => (
              <Text key={project} style={styles.chip}>
                {project}
              </Text>
            ))}
          </View>
          <Text style={styles.label}>{t(language, "laptopSettings.worktrees")}</Text>
          <Text style={styles.value}>{t(language, WORKTREE_KEYS[settings.worktrees])}</Text>
        </>
      )}
      <Text style={styles.note}>{t(language, "laptopSettings.readOnly")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  label: {
    marginTop: 4,
    color: theme.colors.textDim,
    fontFamily: theme.font.bold,
    fontSize: 12,
    letterSpacing: 0.6,
  },
  list: {
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    overflow: "hidden",
  },
  item: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.hairlineSoft,
  },
  name: { color: theme.colors.text, fontFamily: theme.font.semibold, fontSize: 14 },
  meta: { color: theme.colors.textMuted, fontFamily: theme.font.body, fontSize: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.textSecondary,
    fontFamily: theme.font.semibold,
    fontSize: 12,
  },
  value: { color: theme.colors.text, fontFamily: theme.font.semibold, fontSize: 14 },
  note: { color: theme.colors.textMuted, fontFamily: theme.font.body, fontSize: 12 },
});
