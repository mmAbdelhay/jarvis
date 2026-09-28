import { Dimensions } from "react-native";
import { type OrientationPolicy, orientationPolicy } from "./orientation-policy";

/** This device's orientation policy, from its physical screen (not the
 *  window, which a tablet's Split View can make phone-sized). */
export function deviceOrientationPolicy(): OrientationPolicy {
  const { width, height } = Dimensions.get("screen");
  return orientationPolicy({ shortSide: Math.min(width, height) });
}
