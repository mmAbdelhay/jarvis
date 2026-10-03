import { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { t, type Language, type MessageKey } from "@/lib/i18n";
import { noticeText } from "@/lib/laptop-actions";
import {
  type LaptopSettings,
  readLaptopSettings,
  saveWorktreeMode,
  type WorktreeMode,
} from "@/lib/laptop-settings";
import { useRpcClient } from "@/lib/rpc-context";
import { theme } from "@/lib/theme";

const WORKTREE_KEYS: Record<WorktreeMode, MessageKey> = {
  off: "laptopSettings.worktreesOff",
  parallel: "laptopSettings.worktreesParallel",
  always: "laptopSettings.worktreesAlways",
};

const MODES: readonly WorktreeMode[] = ["off", "parallel", "always"];

/**
 * Settings' view of the paired laptop: its agents, projects and how it
 * isolates parallel sessions. The worktree mode can be changed from here
 * (saved to the laptop); agents and projects are read-only, which the
 * section says rather than leaving the reader to wonder.
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

  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<{ error: boolean; text: string } | undefined>(undefined);

  async function chooseMode(mode: WorktreeMode): Promise<void> {
    if (settings === undefined || saving || mode === settings.worktrees) return;
    setSaving(true);
    setSaveNote(undefined);
    const outcome = await saveWorktreeMode(client, mode);
    setSaving(false);
    if (outcome.ok) {
      setSettings({ ...settings, worktrees: mode });
      setSaveNote({ error: false, text: t(props.language, "laptopSettings.saved") });
    } else {
      setSaveNote({ error: true, text: noticeText(props.language, outcome.text) });
    }
  }

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
          <View style={styles.chips}>
            {MODES.map((mode) => (
              <TouchableOpacity
                key={mode}
                accessibilityRole="button"
                accessibilityState={{ selected: mode === settings.worktrees, disabled: saving }}
                disabled={saving}
                onPress={() => void chooseMode(mode)}
                style={[styles.modeChip, mode === settings.worktrees && styles.chipOn]}
              >
                <Text style={[styles.chipText, mode === settings.worktrees && styles.chipTextOn]}>
                  {t(language, WORKTREE_KEYS[mode])}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {saving && <Text style={styles.note}>{t(language, "laptopSettings.saving")}</Text>}
          {saveNote !== undefined && (
            <Text selectable style={saveNote.error ? styles.error : styles.note}>
              {saveNote.text}
            </Text>
          )}
        </>
      )}
      <Text style={styles.note}>{t(language, "laptopSettings.edit")}</Text>
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
  modeChip: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  chipText: { color: theme.colors.textSecondary, fontFamily: theme.font.semibold, fontSize: 12 },
  chipTextOn: { color: theme.colors.accentText },
  error: { color: theme.colors.danger, fontFamily: theme.font.body, fontSize: 12 },
  value: { color: theme.colors.text, fontFamily: theme.font.semibold, fontSize: 14 },
  note: { color: theme.colors.textMuted, fontFamily: theme.font.body, fontSize: 12 },
});
