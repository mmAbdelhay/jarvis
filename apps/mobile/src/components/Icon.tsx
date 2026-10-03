// One SVG icon from lib/icon-paths. Decorative: the parent button carries the
// accessibility label.
import Svg, { Circle, Ellipse, Path, Rect } from "react-native-svg";
import { ICONS, type IconName, type IconShape, type IconSpec } from "@/lib/icon-paths";
import { isRtl } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { theme } from "@/lib/theme";

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  /** Flips the icon in a right-to-left layout; defaults to the icon's own setting. */
  mirrorInRtl?: boolean;
};

function shapeElement(shape: IconShape, index: number) {
  switch (shape.kind) {
    case "path":
      return <Path key={index} {...shape.attrs} />;
    case "circle":
      return <Circle key={index} {...shape.attrs} />;
    case "rect":
      return <Rect key={index} {...shape.attrs} />;
    case "ellipse":
      return <Ellipse key={index} {...shape.attrs} />;
  }
}

export function Icon({
  name,
  size = 22,
  color = theme.colors.textSecondary,
  strokeWidth,
  mirrorInRtl,
}: Props) {
  const spec: IconSpec = ICONS[name];
  const language = useLanguage();
  const mirrored = (mirrorInRtl ?? spec.mirror ?? false) && isRtl(language);
  return (
    <Svg
      width={size}
      height={size}
      viewBox={spec.viewBox ?? "0 0 24 24"}
      fill={spec.fill ? color : "none"}
      stroke={spec.fill ? "none" : color}
      strokeWidth={strokeWidth ?? spec.strokeWidth ?? 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={mirrored ? { transform: [{ scaleX: -1 }] } : undefined}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {spec.shapes.map(shapeElement)}
    </Svg>
  );
}
