export type SystemMetrics = {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  networkDownMbps: number;
  networkUpMbps: number;
  uptimeSeconds: number;
  /** CPU package temperature in °C, when the machine will say.
   *
   *  Undefined is ordinary, not an error. Apple Silicon reports nothing
   *  without a privileged helper, a VM usually has no sensor at all, and a
   *  desktop Linux box answers from /sys/class/thermal with no privileges
   *  whatsoever — so this is a reading that exists on some machines and not
   *  others, and the tile says which. */
  cpuTemperatureC?: number;
};

export interface Platform {
  metrics(): Promise<SystemMetrics>;
  speak(text: string, language: "ar" | "en"): Promise<void>;
  stopSpeaking(): void;
}
