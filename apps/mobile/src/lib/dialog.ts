// Native confirm and notice dialogs over React Native's Alert (see
// dialog-core.ts; the browser build uses dialog.web.ts).
import { Alert } from "react-native";
import type { Dialogs } from "./dialog-core";

export type { ConfirmInput, Dialogs } from "./dialog-core";

export const dialogs: Dialogs = {
  confirm(input) {
    Alert.alert(input.title, input.message, [
      { text: input.cancelText ?? "Cancel", style: "cancel" },
      {
        text: input.confirmText ?? "OK",
        style: input.destructive === true ? "destructive" : "default",
        onPress: input.onConfirm,
      },
    ]);
  },
  notice(title, message) {
    Alert.alert(title, message);
  },
};
