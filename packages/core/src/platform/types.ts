export type SystemMetrics = {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  networkDownMbps: number;
  networkUpMbps: number;
  uptimeSeconds: number;
};

export interface Platform {
  metrics(): Promise<SystemMetrics>;
  speak(text: string, language: "ar" | "en"): Promise<void>;
  stopSpeaking(): void;
}
