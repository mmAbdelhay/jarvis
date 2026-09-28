// Types for web-export-paths.cjs (plain CommonJS so metro.config.js can
// require it with no build step).
export declare const WEB_EXPORT_PATH_LIMIT: number;
export declare function overlongPaths(relativePaths: readonly string[], limit?: number): string[];
export declare function vendoredWebAsset(
  filePaths: readonly string[],
  vendorDir: string,
  exists: (path: string) => boolean,
): string[];
