// The interface `native-recording-files.ts` implements over `expo-file-system`
// (M8 Task 6, behaviour rule 7). No logic of its own — every recording
// file operation reaches native code, so there is nothing pure to test
// here; the native adapter's contract (uri validation, no-throw `remove`)
// is documented on `nativeRecordingFiles` instead.
export type RecordingFiles = {
  readBase64(uri: string): Promise<string>;
  size(uri: string): number | undefined;
  remove(uri: string): void;
};
