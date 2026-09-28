// The browser build's sidecar screen (Task 13). A browser cannot host the
// Editor/Database/Cluster in an embedded WebView with the native screen's
// navigation lock, so the proxied URL opens in its own tab instead — only
// after the same `isAllowedSidecarUrl` check the native screen runs
// (https, this pairing's name and port, a `/s/<handle>/` path), against
// the endpoint re-derived from the pairing record, never the route param.
// `noopener,noreferrer`: the sidecar tab gets no handle back to this app
// and no Referer. A browser may block the automatic open (it is not a
// direct click), so the screen always offers a re-open button.
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { loadPairing } from "@/lib/pairing-record";
import { expoSecureStore } from "@/lib/secure-store";
import { isAllowedSidecarUrl } from "@/lib/sidecar-url";
import { theme } from "@/lib/theme";

type Status = "loading" | "opened" | "refused";

export default function SidecarViewWebScreen() {
  const language = useLanguage();
  const router = useRouter();
  const { url } = useLocalSearchParams<{ url: string }>();
  const uri = typeof url === "string" ? url : "";
  const [allowedUrl, setAllowedUrl] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<Status>("loading");

  const openTab = useCallback((target: string) => {
    window.open(target, "_blank", "noopener,noreferrer");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let record: { name?: string; port: number } | undefined;
      try {
        record = (await loadPairing(expoSecureStore))?.record;
      } catch {
        record = undefined;
      }
      if (cancelled) return;
      const name = record?.name;
      if (
        name === undefined ||
        record === undefined ||
        !isAllowedSidecarUrl(uri, name, record.port)
      ) {
        setStatus("refused");
        return;
      }
      setAllowedUrl(uri);
      setStatus("opened");
      openTab(uri);
    })();
    return () => {
      cancelled = true;
    };
  }, [uri, openTab]);

  return (
    <View style={styles.screen}>
      {status === "refused" && (
        <Text style={styles.errorText}>{t(language, "sidecars.unexpectedAddress")}</Text>
      )}
      {status === "opened" && allowedUrl !== undefined && (
        <>
          <Text style={styles.label}>{t(language, "sidecars.openedInTab")}</Text>
          <TouchableOpacity style={styles.button} onPress={() => openTab(allowedUrl)}>
            <Text style={styles.buttonText}>{t(language, "sidecars.openAgain")}</Text>
          </TouchableOpacity>
        </>
      )}
      <TouchableOpacity style={styles.secondaryButton} onPress={() => router.back()}>
        <Text style={styles.secondaryText}>{t(language, "common.back")}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.background,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  label: {
    color: theme.colors.textDim,
    fontSize: theme.font.size.md,
    textAlign: "center",
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: theme.font.size.md,
    textAlign: "center",
  },
  button: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  buttonText: {
    color: theme.colors.primaryText,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.medium,
  },
  secondaryButton: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  secondaryText: {
    color: theme.colors.text,
    fontSize: theme.font.size.md,
  },
});
