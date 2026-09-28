// The browser build's keyboard height: always 0. react-native-web's
// `Keyboard` has no `metrics()` and never fires keyboardDidShow, and a
// browser already shrinks (or pans) the page for its own on-screen
// keyboard, so there is nothing to pad (D2: calling `Keyboard.metrics()`
// here blanked the whole Terminal and Session screens).
export function useKeyboardHeight(): number {
  return 0;
}
