// Pulled out of main.ts so the will-navigate guard's decision logic is
// testable without an Electron harness. The main process wires this to
// `event.preventDefault()` in the webContents "will-navigate" listener.
export function isAllowedNavigation(url: string, allowedUrl: string): boolean {
  return url === allowedUrl;
}
