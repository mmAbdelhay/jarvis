import { useLocalSearchParams } from "expo-router";
import { ApiScreen } from "@/screens/ApiScreen";

export default function ApiRoute() {
  const { project } = useLocalSearchParams<{ project: string }>();
  const projectName = typeof project === "string" ? project : "";
  return <ApiScreen project={projectName} embedded={false} />;
}
