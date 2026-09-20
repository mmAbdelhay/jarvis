// One row of the Dashboard's `dashboard.projects` list (Task 6, rule 5):
// name and, when the server sends one, a path — server text shown verbatim
// (never re-localised). Today's server only sends names (see
// dashboard-store.ts's `parseProjects`/`ProjectSummary` comment and
// task-6-report.md); `path` is optional and simply omitted when absent,
// forward-compatible with a future richer payload without a phone-side
// change (Minor 7, fix round 1).
//
// M11 (task-6-brief.md rule 6): tappable — the Dashboard passes `onPress`
// to route to `/sidecars/<project>`; the row's own content is unchanged.
import { Pressable, StyleSheet, Text } from "react-native";
import type { ProjectSummary } from "@/lib/dashboard-store";
import { theme } from "@/lib/theme";

export function ProjectRow({ project, onPress }: { project: ProjectSummary; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Text style={styles.name}>{project.name}</Text>
      {project.path !== undefined && <Text style={styles.path}>{project.path}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  name: {
    color: theme.colors.text,
    fontSize: theme.font.size.md,
    fontFamily: theme.font.semibold,
  },
  path: {
    color: theme.colors.textDim,
    fontFamily: theme.font.mono,
    fontSize: 11,
  },
});
