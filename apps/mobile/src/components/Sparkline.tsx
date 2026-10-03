// A stretched polyline over the last samples (0-100), as in the capacity cards.
import Svg, { Polyline } from "react-native-svg";
import { SPARKLINE_HEIGHT, SPARKLINE_WIDTH, sparklinePoints } from "@/lib/sparkline";

type Props = { points: readonly number[]; color: string; height?: number };

export function Sparkline({ points, color, height = SPARKLINE_HEIGHT }: Props) {
  return (
    <Svg
      width="100%"
      height={height}
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
      preserveAspectRatio="none"
      fill="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Polyline
        points={sparklinePoints(points)}
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </Svg>
  );
}
