export function decidePermission(permission: string, isJarvisWindow: boolean): boolean {
  return permission === "geolocation" ? isJarvisWindow : true;
}
