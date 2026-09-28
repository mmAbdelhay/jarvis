import { useMemo } from "react";
import { useWindowDimensions } from "react-native";
import { type LayoutInfo, layoutClassFor } from "./layout-class";

/** The live layout class: re-evaluates on resize and rotation. */
export function useLayoutClass(): LayoutInfo {
  const { width, height } = useWindowDimensions();
  const { kind, compact } = layoutClassFor({ width, height });
  // Stable identity while the class is unchanged, so consumers can depend
  // on it without re-running on every pixel of a resize.
  return useMemo(() => ({ kind, compact }), [kind, compact]);
}
