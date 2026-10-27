// Browser photo selection for the attach sheet, using a transient file input.
import type { PickedFile } from "./image-pick";
export type { PickedFile } from "./image-pick";

export async function pickImages(
  _source: "library" | "camera",
  maxCount: number,
): Promise<PickedFile[] | "cancelled" | "denied"> {
  if (maxCount < 1) return "cancelled";
  let input: HTMLInputElement | undefined;
  try {
    input = document.createElement("input");
    const fileInput = input;
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = maxCount > 1;
    fileInput.style.display = "none";
    const files = await new Promise<File[]>((resolve) => {
      fileInput.addEventListener("change", () => resolve(Array.from(fileInput.files ?? [])), {
        once: true,
      });
      fileInput.addEventListener("cancel", () => resolve([]), { once: true });
      document.body.appendChild(fileInput);
      fileInput.click();
    });
    if (files.length === 0) return "cancelled";
    return files.slice(0, maxCount).map((file) => ({
      uri: URL.createObjectURL(file),
      name: file.name,
      contentType: file.type || "image/jpeg",
      size: file.size,
    }));
  } catch {
    console.log("[image-pick] failed");
    return "cancelled";
  } finally {
    input?.remove();
  }
}
