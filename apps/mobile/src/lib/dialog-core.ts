// The app's confirm and notice dialogs, pure part (Task 13b fix round 1).
// Native (dialog.ts) shows React Native's Alert; the browser build
// (dialog.web.ts) cannot, because react-native-web's Alert.alert is a
// no-op, so it uses the browser's own confirm()/alert() — the app has no
// in-app modal component to reuse. Both sides take the same input.

export type ConfirmInput = {
  title: string;
  message?: string;
  /** Runs only when the owner accepts. */
  onConfirm(): void;
  /** Native only: the accept button's label and style (browser dialogs
   *  have fixed OK/Cancel buttons). */
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
};

export type Dialogs = {
  confirm(input: ConfirmInput): void;
  notice(title: string, message?: string): void;
};

export function dialogText(title: string, message: string | undefined): string {
  return message === undefined || message === "" ? title : `${title}\n\n${message}`;
}

export type BrowserDialogApi = {
  confirm(text: string): boolean;
  alert(text: string): void;
};

export function createBrowserDialogs(api: BrowserDialogApi): Dialogs {
  return {
    confirm(input) {
      let accepted = false;
      try {
        accepted = api.confirm(dialogText(input.title, input.message));
      } catch {
        accepted = false; // dialogs blocked: never act without an answer
      }
      if (accepted) input.onConfirm();
    },
    notice(title, message) {
      try {
        api.alert(dialogText(title, message));
      } catch {
        // dialogs blocked: nothing more to do
      }
    },
  };
}
