// The sheet that lists this phone's machines and switches between them, and the
// triggers that open it: Home's connection pill, WideShell's brand row or rail
// mark, and /unlock's link. Probing runs only while the sheet is up and the app
// is active. Decisions
// live in machine-switcher.ts and machine-probe.ts; this file is layout and
// wiring.
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Icon } from "@/components/Icon";
import { clientPlatformFor } from "@/lib/client-platform";
import { realClock } from "@/lib/clock";
import { machinePillModel } from "@/lib/connection-pill";
import { dialogs } from "@/lib/dialog";
import { type MessageKey, t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useMachineSessions } from "@/lib/machine-context";
import type { MachineId } from "@/lib/machine-index";
import { type MachineOnline, createOnlineStore, probeMachine } from "@/lib/machine-probe";
import type { MachineEntry } from "@/lib/machine-store";
import { loadScreenMachine, machineStore, openMachineStore } from "@/lib/machine-store-instance";
import {
  otherMachinesLinkVisible,
  shouldProbe,
  switcherRows,
  tapSwitcherRow,
} from "@/lib/machine-switcher";
import { nativeTransport } from "@/lib/native-transport";
import { useConnectionStore, useMachineId } from "@/lib/rpc-context";
import { systemTransportFor } from "@/lib/system-transport";
import { theme } from "@/lib/theme";
import { createAppTransport } from "@/lib/trust-routing-transport";

const PLATFORM = clientPlatformFor(Platform.OS);
// As in _layout.tsx and pair.tsx: a named pairing goes through the OS trust
// store, a pinned one through the native socket.
const transport = createAppTransport(PLATFORM, {
  pin: nativeTransport,
  system: systemTransportFor(PLATFORM),
});

const ONLINE_KEY: Record<MachineOnline, MessageKey> = {
  checking: "machines.checking",
  online: "machines.online",
  offline: "machines.offline",
};

const ONLINE_COLOR: Record<MachineOnline, string> = {
  checking: theme.colors.textMuted,
  online: theme.colors.success,
  offline: theme.colors.danger,
};

async function readMachines(): Promise<MachineEntry[]> {
  await openMachineStore();
  return machineStore.listReadable();
}

export function MachineSwitcher(props: { visible: boolean; onClose(): void }) {
  const { visible, onClose } = props;
  const language = useLanguage();
  const sessions = useMachineSessions();
  const machineId = useMachineId();
  const connectionStore = useConnectionStore();
  const [entries, setEntries] = useState<MachineEntry[]>([]);
  const [connection, setConnection] = useState(connectionStore.get());
  const onlineStore = useMemo(
    () =>
      createOnlineStore({
        list: readMachines,
        activeId: () => sessions.current().id ?? undefined,
        probe: (record) => probeMachine({ transport, clock: realClock }, record),
        clock: realClock,
      }),
    [sessions],
  );
  const [online, setOnline] = useState<ReadonlyMap<MachineId, MachineOnline>>(onlineStore.get());
  const [appActive, setAppActive] = useState(sessions.isAppActive());
  // Its caller's function may be new on each render: no reason to read again.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void readMachines().then(
      (read) => {
        if (!cancelled) setEntries(read);
      },
      () => {
        console.warn("machines: reading the machines for the switcher failed");
        // A store that could not open: an empty sheet would say nothing.
        if (cancelled) return;
        onCloseRef.current();
        dialogs.notice(t(language, "machines.openFailed"));
      },
    );
    setConnection(connectionStore.get());
    const unsubscribeConnection = connectionStore.subscribe(setConnection);
    return () => {
      cancelled = true;
      unsubscribeConnection();
    };
  }, [visible, connectionStore, language]);

  useEffect(() => {
    setAppActive(sessions.isAppActive());
    return sessions.subscribeAppActive(setAppActive);
  }, [sessions]);

  const probing = shouldProbe({ visible, appActive });
  useEffect(() => {
    if (!probing) return;
    setOnline(onlineStore.get());
    return onlineStore.subscribe(() => setOnline(onlineStore.get()));
  }, [probing, onlineStore]);

  const rows = switcherRows({
    entries,
    activeId: machineId ?? undefined,
    activeConnection: connection,
    online,
  });

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        accessibilityLabel={t(language, "common.cancel")}
        onPress={onClose}
      >
        <Pressable style={styles.sheet} accessible={false}>
          <View style={styles.grabber} />
          <Text style={styles.title} numberOfLines={1}>
            {t(language, "machines.title")}
          </Text>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.list}>
            {rows.map((row) => (
              <Pressable
                key={row.id}
                accessibilityRole="button"
                accessibilityState={{ selected: row.active }}
                onPress={() =>
                  tapSwitcherRow(row, {
                    switchTo: sessions.switchTo,
                    close: onClose,
                    notice: () => dialogs.notice(t(language, "machines.openFailed")),
                    log: (line) => console.warn(line),
                  })
                }
                style={[styles.row, row.active && styles.rowActive]}
              >
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={1}>
                    {row.label}
                  </Text>
                  <Text style={styles.subtitle} numberOfLines={1}>
                    {row.subtitle}
                  </Text>
                </View>
                <View style={styles.rowEnd}>
                  {row.active && (
                    <Text style={styles.current}>{t(language, "machines.current")}</Text>
                  )}
                  <View style={styles.onlineGroup}>
                    <View style={[styles.dot, { backgroundColor: ONLINE_COLOR[row.online] }]} />
                    <Text style={styles.onlineText}>{t(language, ONLINE_KEY[row.online])}</Text>
                  </View>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// The pill's ground and text per tone: success, warning and danger palettes.
const PILL_PALETTE = {
  success: { ground: theme.colors.successSurface, text: theme.colors.successText },
  warning: { ground: theme.colors.warningSurface, text: theme.colors.warningText },
  danger: { ground: theme.colors.dangerSurface, text: theme.colors.dangerText },
} as const;

/** Home's connection pill on a phone: same text and tone as ever, now pressable. */
function PillButton(props: { onPress(): void; label: string }) {
  const language = useLanguage();
  const machineId = useMachineId();
  const connectionStore = useConnectionStore();
  const [connection, setConnection] = useState(connectionStore.get());
  const [laptopName, setLaptopName] = useState<string | undefined>(undefined);

  useEffect(() => {
    setConnection(connectionStore.get());
    return connectionStore.subscribe(setConnection);
  }, [connectionStore]);

  useEffect(() => {
    let cancelled = false;
    void loadScreenMachine(machineId).then(
      (loaded) => {
        if (!cancelled) setLaptopName(loaded?.record.laptopName);
      },
      // A failed read has its own route, _layout.tsx's connect to /pair: the
      // pill just stays without a name.
      () => console.warn("machines: reading this machine for the pill failed"),
    );
    return () => {
      cancelled = true;
    };
  }, [machineId]);

  const pill = machinePillModel(connection, laptopName);
  const palette = PILL_PALETTE[pill.tone];
  const pillText = pill.label.kind === "name" ? pill.label.name : t(language, pill.label.key);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: ${pillText}`}
      hitSlop={8}
      onPress={props.onPress}
      style={[styles.pill, { backgroundColor: palette.ground }]}
    >
      <View style={[styles.liveDot, { backgroundColor: theme.colors[pill.tone] }]} />
      <Text style={[styles.pillText, { color: palette.text }]} numberOfLines={1}>
        {pillText}
      </Text>
    </Pressable>
  );
}

function BrandMark() {
  return (
    <View style={styles.brandMark}>
      <Icon name="brand" size={16} strokeWidth={2.4} color={theme.colors.primaryText} />
    </View>
  );
}

/** /unlock's way out, shown only with another machine to go to. */
function OtherMachinesLink(props: { onPress(): void }) {
  const language = useLanguage();
  const machineId = useMachineId();
  const [entries, setEntries] = useState<MachineEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    void readMachines().then(
      (read) => {
        if (!cancelled) setEntries(read);
      },
      () => console.warn("machines: reading the machines for the link failed"),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!otherMachinesLinkVisible(entries, machineId ?? undefined)) return null;
  return (
    <Pressable accessibilityRole="button" onPress={props.onPress} style={styles.link}>
      <Text style={styles.linkText}>{t(language, "machines.other")}</Text>
    </Pressable>
  );
}

export function MachineSwitcherButton(props: { variant: "pill" | "brand" | "rail" | "link" }) {
  const { variant } = props;
  const language = useLanguage();
  const [open, setOpen] = useState(false);
  const label = t(language, "machines.title");
  const show = () => setOpen(true);

  return (
    <>
      {variant === "pill" && <PillButton onPress={show} label={label} />}
      {variant === "link" && <OtherMachinesLink onPress={show} />}
      {variant === "brand" && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={show}
          style={styles.brandRow}
        >
          <BrandMark />
          <Text style={styles.brand}>Jarvis</Text>
        </Pressable>
      )}
      {variant === "rail" && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={show}
          style={[styles.brandRow, styles.brandRowRail]}
        >
          <BrandMark />
        </Pressable>
      )}
      <MachineSwitcher visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: {
    maxHeight: "80%",
    backgroundColor: theme.colors.ground,
    borderTopStartRadius: theme.radius.sheet,
    borderTopEndRadius: theme.radius.sheet,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    paddingBottom: theme.spacing.lg,
  },
  grabber: {
    width: 40,
    height: 5,
    alignSelf: "center",
    marginTop: 8,
    borderRadius: 3,
    backgroundColor: theme.colors.handle,
  },
  title: {
    ...theme.type.headerTitle,
    color: theme.colors.text,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  scroll: { flexGrow: 0 },
  list: { padding: 16, gap: 8 },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  rowActive: { backgroundColor: theme.colors.selected },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  name: { ...theme.type.rowTitle, color: theme.colors.text },
  subtitle: { color: theme.colors.textMuted, fontFamily: theme.font.body, fontSize: 12 },
  rowEnd: { alignItems: "flex-end", gap: 2 },
  current: { color: theme.colors.accentText, fontFamily: theme.font.semibold, fontSize: 12 },
  onlineGroup: { flexDirection: "row", alignItems: "center", gap: 6 },
  onlineText: { color: theme.colors.textSecondary, fontFamily: theme.font.body, fontSize: 12 },
  dot: { width: 7, height: 7, borderRadius: 999 },
  // Home's connection pill.
  pill: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
  },
  liveDot: { width: 7, height: 7, borderRadius: 999 },
  pillText: { flexShrink: 1, fontFamily: theme.font.semibold, fontSize: 12 },
  // WideShell's brand row.
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 8,
    paddingBottom: 18,
  },
  brandRowRail: { paddingHorizontal: 0, paddingBottom: 14 },
  brandMark: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  brand: { color: theme.colors.text, fontFamily: theme.font.extrabold, fontSize: 18 },
  // /unlock's link, as its other secondary actions.
  link: { minHeight: 44, justifyContent: "center", alignItems: "center" },
  linkText: { color: theme.colors.accentText, fontSize: theme.font.size.md },
});
