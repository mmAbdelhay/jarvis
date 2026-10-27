export type AttachUploadResult = { ok: true; path: string } | { ok: false; error: string };

export const ATTACH_UPLOAD_CHANNEL = "terminal:attachUpload";
