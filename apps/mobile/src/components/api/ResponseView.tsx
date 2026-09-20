// The response pane (Behaviour rules 1 and 5): status/time/size/headers/
// body, and the assertion results below them. HTTP content is always
// native selectable text, never WebView HTML — every string here comes
// straight from the parsed `ApiHttpResponse`/`ApiHttpFailure` and is
// rendered as-is. A large body is split into fixed-size segments and
// handed to a `FlatList`, so only the segments actually on screen are ever
// mounted — "bounded virtualized text segments" (Behaviour rule 5).
import { FlatList, StyleSheet, Text, View } from "react-native";
import type { ApiAssertionResult, ApiHttpFailure, ApiHttpResponse } from "@/lib/api-store";
import { formatBytes } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Language } from "@/lib/i18n";
import { theme } from "@/lib/theme";

const SEGMENT_CHARS = 4_000;

function bodySegments(body: string): string[] {
  if (body.length === 0) return [""];
  const segments: string[] = [];
  for (let i = 0; i < body.length; i += SEGMENT_CHARS) {
    segments.push(body.slice(i, i + SEGMENT_CHARS));
  }
  return segments;
}

function isFailure(response: ApiHttpResponse | ApiHttpFailure): response is ApiHttpFailure {
  return "failed" in response && response.failed === true;
}

export function ResponseView(props: {
  response: ApiHttpResponse | ApiHttpFailure | undefined;
  assertions: ApiAssertionResult[];
  language: Language;
}) {
  const { response, language } = props;
  if (response === undefined) {
    return <Text style={styles.empty}>{t(language, "api.response.none")}</Text>;
  }

  if (isFailure(response)) {
    return (
      <View style={styles.container}>
        <Text selectable style={styles.failureText}>
          {response.detail}
        </Text>
        {/* "ms" is an ASCII technical unit, not routed through STRINGS —
         *  format.ts's formatMbps/formatUptime follow the same rule: an
         *  i18n entry must differ between ar and en, which a bare unit
         *  label never would. */}
        <Text style={styles.meta}>{response.timeMs} ms</Text>
      </View>
    );
  }

  const statusStyle =
    response.status >= 200 && response.status < 400 ? styles.statusOk : styles.statusError;

  return (
    <View style={styles.container}>
      <View style={styles.statusRow}>
        <Text style={[styles.status, statusStyle]}>
          {response.status} {response.statusText}
        </Text>
        <Text style={styles.meta}>{response.timeMs} ms</Text>
        <Text style={styles.meta}>{formatBytes(response.bytes, language)}</Text>
      </View>

      {Object.keys(response.headers).length > 0 && (
        <View style={styles.headers}>
          {Object.entries(response.headers).map(([name, value]) => (
            <Text key={name} selectable style={[styles.headerLine, { writingDirection: "ltr" }]}>
              {name}: {value}
            </Text>
          ))}
        </View>
      )}

      <View style={styles.bodyBox}>
        <FlatList
          data={bodySegments(response.body)}
          keyExtractor={(_, index) => String(index)}
          renderItem={({ item }) => (
            <Text selectable style={[styles.bodyText, { writingDirection: "ltr" }]}>
              {item}
            </Text>
          )}
          nestedScrollEnabled
        />
      </View>

      {props.assertions.length > 0 && (
        <View style={styles.assertions}>
          {props.assertions.map((assertion) => (
            <Text
              key={`${assertion.target}:${assertion.expression}`}
              style={assertion.passed ? styles.assertPassed : styles.assertFailed}
            >
              {assertion.passed ? "✓" : "✕"} {assertion.target} {assertion.expression}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: theme.spacing.sm },
  statusRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.md,
    alignItems: "center",
  },
  status: { fontSize: theme.font.size.md, fontWeight: theme.font.weight.bold },
  statusOk: { color: theme.colors.success },
  statusError: { color: theme.colors.danger },
  meta: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  headers: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
    gap: 2,
  },
  headerLine: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
    fontFamily: "monospace",
  },
  bodyBox: {
    maxHeight: 360,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
  },
  bodyText: { color: theme.colors.text, fontFamily: "monospace", fontSize: theme.font.size.sm },
  failureText: { color: theme.colors.danger },
  assertions: { gap: 2 },
  assertPassed: { color: theme.colors.success, fontSize: theme.font.size.sm },
  assertFailed: { color: theme.colors.danger, fontSize: theme.font.size.sm },
  empty: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
});
