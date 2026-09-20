import { Tabs } from "expo-router";
import { Text } from "react-native";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { theme } from "@/lib/theme";

const icons = { dashboard: "▦", sessions: ">_", voice: "♩", workspace: "⊞" } as const;

export default function TabLayout() {
  const language = useLanguage();
  return (
    <Tabs
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
