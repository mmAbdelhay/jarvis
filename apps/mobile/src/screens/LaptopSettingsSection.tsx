import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ActionSheet } from "@/components/ActionSheet";
import { Icon } from "@/components/Icon";
import { SettingsCard } from "@/components/SettingsCard";
import { clientPlatformFor } from "@/lib/client-platform";
import { platformKey, t, type Language, type MessageKey } from "@/lib/i18n";
import { noticeText } from "@/lib/laptop-actions";
import {
  type LaptopSettings,
  readLaptopSettings,
  saveWorktreeMode,
  type WorktreeMode,
  worktreeDraft,
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
export function LaptopSettingsSection(props: {
  language: Language;
  /** "cards" is the wide layout: separate cards, the worktree mode a draft. */
  variant?: "list" | "cards";
}) {
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
  if (props.variant === "cards") return <LaptopCards {...props} />;
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

function LaptopCards(props: { language: Language }) {
  const { language } = props;
  const client = useRpcClient();
  const [settings, setSettings] = useState<LaptopSettings | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState<WorktreeMode>("off");
  useEffect(() => {
    let cancelled = false;
    void readLaptopSettings(client).then((next) => {
      if (cancelled) return;
      setSettings(next);
      setFailed(next === undefined);
      if (next !== undefined) setChosen(next.worktrees);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const [saving, setSaving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveNote, setSaveNote] = useState<{ error: boolean; text: string } | undefined>(undefined);
  const dirty = settings !== undefined && worktreeDraft(settings.worktrees, chosen).dirty;

  async function save(): Promise<void> {
    if (settings === undefined || saving || !dirty) return;
    setSaving(true);
    setSaveNote(undefined);
    const outcome = await saveWorktreeMode(client, chosen);
    setSaving(false);
    if (outcome.ok) {
      setSettings({ ...settings, worktrees: chosen });
      setSaveNote({ error: false, text: t(language, "laptopSettings.saved") });
    } else {
      setSaveNote({ error: true, text: noticeText(language, outcome.text) });
    }
  }

  function discard(): void {
    if (settings === undefined) return;
    setChosen(settings.worktrees);
    setSaveNote(undefined);
  }

  return (
    <>
      {failed && (
        <SettingsCard title={t(language, "laptopSettings.title")}>
          <Text style={styles.note}>{t(language, "laptopSettings.unavailable")}</Text>
        </SettingsCard>
      )}
      {settings !== undefined && (
        <>
          <SettingsCard title={t(language, "laptopSettings.agents")}>
            {settings.agents.length === 0 && (
              <Text style={styles.note}>{t(language, "laptopSettings.none")}</Text>
            )}
            {settings.agents.map((agent) => (
              <View key={agent.id} style={styles.agentRow}>
                <Text style={styles.agentName}>{agent.id}</Text>
                {agent.vendor !== undefined && <Text style={styles.meta}>{agent.vendor}</Text>}
              </View>
            ))}
          </SettingsCard>
          <SettingsCard title={t(language, "laptopSettings.projects")}>
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
          </SettingsCard>
          <SettingsCard title={t(language, "laptopSettings.worktreesLabel")}>
            <Text style={styles.meta}>{t(language, "settings.worktreeHint")}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(language, "laptopSettings.worktreesLabel")}
              disabled={saving}
              onPress={() => setMenuOpen(true)}
              style={styles.select}
            >
              <Text style={styles.selectText}>{t(language, WORKTREE_KEYS[chosen])}</Text>
              <Icon name="chevronDown" size={14} color={theme.colors.textMuted} />
            </Pressable>
            <ActionSheet
              visible={menuOpen}
              title={t(language, "laptopSettings.worktreesLabel")}
              actions={MODES.map((mode) => ({
                key: mode,
                label: t(language, WORKTREE_KEYS[mode]),
                onPress: () => setChosen(mode),
              }))}
              onClose={() => setMenuOpen(false)}
            />
            {saving && <Text style={styles.note}>{t(language, "laptopSettings.saving")}</Text>}
            {saveNote !== undefined && (
              <Text selectable style={saveNote.error ? styles.error : styles.note}>
                {saveNote.text}
              </Text>
            )}
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !dirty || saving }}
                disabled={!dirty || saving}
                onPress={discard}
                style={[styles.discard, (!dirty || saving) && styles.disabled]}
              >
                <Text style={styles.discardText}>{t(language, "settings.discard")}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !dirty || saving }}
                disabled={!dirty || saving}
                onPress={() => void save()}
                style={[styles.save, (!dirty || saving) && styles.disabled]}
              >
                <Text style={styles.saveText}>{t(language, "settings.saveToLaptop")}</Text>
              </Pressable>
            </View>
          </SettingsCard>
        </>
      )}
      <SettingsCard title={t(language, "settings.pairedDevices")}>
        <View style={styles.agentRow}>
          <Text style={styles.agentName}>
            {t(language, platformKey("settings.thisDevice", clientPlatformFor(Platform.OS)))}
          </Text>
          <Text style={styles.currentChip}>{t(language, "settings.current")}</Text>
        </View>
        <Text style={styles.deviceNote}>{t(language, "settings.devicesNote")}</Text>
      </SettingsCard>
    </>
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
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.hairlineSoft,
    backgroundColor: theme.colors.ground,
  },
  agentName: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 14 },
  currentChip: {
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: theme.radius.pill,
    overflow: "hidden",
    backgroundColor: theme.colors.successSurface,
    color: theme.colors.successText,
    fontFamily: theme.font.bold,
    fontSize: 12,
  },
  select: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: theme.radius.chip,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.ground,
  },
  selectText: { color: theme.colors.text, fontFamily: theme.font.semibold, fontSize: 13 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 4 },
  discard: {
    height: 42,
    justifyContent: "center",
    paddingHorizontal: 18,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  discardText: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 14 },
  save: {
    height: 42,
    justifyContent: "center",
    paddingHorizontal: 18,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.accent,
  },
  saveText: { color: theme.colors.primaryText, fontFamily: theme.font.extrabold, fontSize: 14 },
  disabled: { opacity: 0.4 },
  deviceNote: {
    color: theme.colors.textMuted,
    fontFamily: theme.font.body,
    fontSize: 12,
    lineHeight: 18,
  },
  note: { color: theme.colors.textMuted, fontFamily: theme.font.body, fontSize: 12 },
});
