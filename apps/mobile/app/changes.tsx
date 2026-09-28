import { useLocalSearchParams } from "expo-router";
import { sessionRouteId } from "@/lib/session-screen";
import { ChangesScreen } from "@/screens/ChangesScreen";

export default function ChangesRoute() {
  const sessionId = sessionRouteId(useLocalSearchParams().id);
  return <ChangesScreen sessionId={sessionId} embedded={false} />;
}
