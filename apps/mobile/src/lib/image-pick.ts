// Photo selection for the native attach sheet; results contain no UI text.
import * as ImagePicker from "expo-image-picker";

export type PickedFile = { uri: string; name: string; contentType: string; size?: number };

export async function pickImages(
  source: "library" | "camera",
  maxCount: number,
): Promise<PickedFile[] | "cancelled" | "denied"> {
  if (maxCount < 1) return "cancelled";
  try {
    const permission =
      source === "library"
        ? await ImagePicker.requestMediaLibraryPermissionsAsync()
        : await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return "denied";
    const result =
      source === "library"
        ? await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images"],
            allowsMultipleSelection: maxCount > 1,
            selectionLimit: maxCount,
            quality: 0.85,
          })
        : await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.85 });
    if (result.canceled) return "cancelled";
    return result.assets.slice(0, maxCount).map((asset, index) => ({
      uri: asset.uri,
      name: asset.fileName ?? `photo-${index + 1}.jpg`,
      contentType: asset.mimeType ?? "image/jpeg",
      ...(asset.fileSize === undefined ? {} : { size: asset.fileSize }),
    }));
  } catch {
    console.log("[image-pick] failed");
    return "cancelled";
  }
}
