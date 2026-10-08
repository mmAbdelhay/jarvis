/** A PCM WAV of `samples` silent frames (16 kHz mono 16-bit unless overridden). */
export function makeWav(
  samples: number,
  o: { rate?: number; channels?: number; bits?: number; format?: number } = {},
): Uint8Array {
  const rate = o.rate ?? 16_000;
  const channels = o.channels ?? 1;
  const bits = o.bits ?? 16;
  const format = o.format ?? 1;
  const data = samples * channels * (bits / 8);
  const buffer = new ArrayBuffer(44 + data);
  const view = new DataView(buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, (rate * channels * bits) / 8, true);
  view.setUint16(32, (channels * bits) / 8, true);
  view.setUint16(34, bits, true);
  tag(36, "data");
  view.setUint32(40, data, true);
  return new Uint8Array(buffer);
}
