/** Build-time only: the desktop package is the release version's source of truth. */
export function appVersion(desktopPackageJsonText: string): {
  version: string;
  versionCode: number;
} {
  const metadata: unknown = JSON.parse(desktopPackageJsonText);
  const version =
    typeof metadata === "object" && metadata !== null && "version" in metadata
      ? metadata.version
      : undefined;
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Desktop package version must be major.minor.patch");
  }
  const [major, minor, patch] = version.split(".").map(Number);
  const versionCode = major * 10000 + minor * 100 + patch;
  // Each lower component has two decimal places. Reject collisions and
  // codes outside Android's positive, 2100000000 maximum range at build time.
  if (
    minor > 99 ||
    patch > 99 ||
    !Number.isSafeInteger(versionCode) ||
    versionCode < 1 ||
    versionCode > 2100000000
  ) {
    throw new Error("Desktop package version cannot be encoded as an Android versionCode");
  }
  return { version, versionCode };
}
