import { Tabs, useRouter } from "expo-router";
import { PhoneTabBar, type TabBarInput } from "@/components/PhoneTabBar";
import { WideShell } from "@/components/WideShell";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useLayoutClass } from "@/lib/use-layout-class";

const noTabBar = () => null;

// Wide layout: the same Tabs navigator inside the WideShell, its bottom bar
// replaced by the shell's own navigation. Keeping one navigator for both
// classes means crossing the breakpoint keeps the route and the mounted
// screens.
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
  const router = useRouter();
  const phoneBar = (input: TabBarInput) => (
    <PhoneTabBar {...input} language={language} onChanges={() => router.push("/changes")} />
  );
  return (
    <Tabs tabBar={props.wide ? noTabBar : phoneBar} screenOptions={{ headerShown: false }}>
      {(["dashboard", "sessions", "voice", "workspace"] as const).map((name) => (
        <Tabs.Screen key={name} name={name} options={{ title: t(language, `nav.${name}`) }} />
      ))}
    </Tabs>
  );
}
