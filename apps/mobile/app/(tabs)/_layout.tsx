import { Tabs } from "expo-router";
import { Text } from "react-native";
import { WideShell } from "@/components/WideShell";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { theme } from "@/lib/theme";
import { useLayoutClass } from "@/lib/use-layout-class";

const icons = { dashboard: "▦", sessions: ">_", voice: "♩", workspace: "⊞" } as const;

const noTabBar = () => null;

// Wide layout: the same Tabs navigator inside the WideShell, its bottom bar
// replaced by the shell's top bar. Keeping one navigator for both classes
// means crossing the breakpoint keeps the route and the mounted screens.
export default function TabLayout() {
  const layout = useLayoutClass();
  return (
    <WideShell>
      <TabsNavigator wide={layout.kind === "wide"} />
    </WideShell>
  );
}

function TabsNavigator(props: { wide: boolean }) {
  const language = useLanguage();
  return (
    <Tabs
      tabBar={props.wide ? noTabBar : undefined}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textDim,
        tabBarStyle: {
          backgroundColor: theme.colors.ground,
          borderTopColor: theme.colors.hairlineSoft,
          borderTopWidth: 1,
          height: 78,
          paddingTop: 8,
        },
        tabBarLabelStyle: { fontFamily: theme.font.semibold, fontSize: 11 },
      }}
    >
      {(["dashboard", "sessions", "voice", "workspace"] as const).map((name) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title: t(language, `nav.${name}`),
            tabBarIcon: ({ color }) => (
              <Text style={{ color, fontFamily: theme.font.monoSemibold, fontSize: 19 }}>
                {icons[name]}
              </Text>
            ),
          }}
        />
      ))}
    </Tabs>
  );
}
