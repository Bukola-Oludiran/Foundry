export interface ChecksumResponse { digest: string }

export function encodeRequest(bytes: Uint8Array): { contentType: string; body: string } {
  return { contentType: "application/octet-stream", body: btoa(String.fromCharCode(...bytes)) };
}

export function decodeResponse(value: unknown): ChecksumResponse {
  if (!value || typeof value !== "object" || typeof (value as { digest?: unknown }).digest !== "string") throw new Error("INVALID_RESPONSE");
  return { digest: (value as { digest: string }).digest };
}
