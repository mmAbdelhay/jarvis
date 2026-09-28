// The browser build's confirm and notice dialogs: window.confirm and
// window.alert (react-native-web's Alert.alert does nothing). Logic in
// dialog-core.ts.
import { createBrowserDialogs } from "./dialog-core";

export const dialogs = createBrowserDialogs({
  confirm: (text) => window.confirm(text),
  alert: (text) => window.alert(text),
});
