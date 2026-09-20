// The software keyboard's current height, straight from React Native's
// `Keyboard` events (`endCoordinates.height`, in dp — on Android that is the
// IME inset net of the system navigation bar, see keyboard-offset.ts). A
// screen feeds it to `keyboardBottomPadding` together with its bottom
// safe-area inset. Starts from `Keyboard.metrics()` so a screen mounted
// while the keyboard is already up (a push from a focused input) doesn't
// wait for the next show event. Not unit-tested directly — it imports the
// real `Keyboard` from `react-native`, which Vitest's Node environment can't
// load (keyboard-offset.test.ts pins the arithmetic instead).
import { useEffect, useState } from "react";
import { Keyboard } from "react-native";

export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(() => Keyboard.metrics()?.height ?? 0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      setHeight(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}
