// The plan's progress ring: a track circle with a success arc from 12 o'clock.
import Svg, { Circle } from "react-native-svg";
import { RING_RADIUS, ringDash } from "@/lib/sparkline";
import { theme } from "@/lib/theme";

type Props = { fraction: number; size?: number };

export function ProgressRing({ fraction, size = 34 }: Props) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Circle
        cx={18}
        cy={18}
        r={RING_RADIUS}
        fill="none"
        stroke={theme.colors.ringTrack}
        strokeWidth={4}
      />
      <Circle
        cx={18}
        cy={18}
        r={RING_RADIUS}
        fill="none"
        stroke={theme.colors.success}
        strokeWidth={4}
        strokeLinecap="round"
        strokeDasharray={ringDash(fraction)}
        transform="rotate(-90 18 18)"
      />
    </Svg>
  );
}
