export const DEFAULT_MAX_BODY_BYTES = 65536;
export const MAX_RESTORE_BODY_BYTES = 1048576;
export const MAX_REQUEST_BODY_BYTES = 1048576;
export const MAX_UPSTREAM_BYTES = 262144;

export type BoundedText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "too_large" | "unreadable" };

const readStream = async (
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedText> => {
  if (body === null) {
    return { ok: true, text: "" };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) {
      break;
    }
    total += step.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, reason: "too_large" };
    }
    chunks.push(step.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
};

export const readBoundedText = (response: Response, maxBytes: number): Promise<BoundedText> =>
  readStream(response.body, maxBytes);

export const requestByteLength = (request: Request): number | undefined => {
  const header = request.headers.get("content-length");
  if (header === null) {
    return undefined;
  }
  const parsed = Number.parseInt(header, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export const readBoundedRequestBody = async (
  request: Request,
  maxBytes: number,
): Promise<BoundedText> => {
  const declared = requestByteLength(request);
  if (declared !== undefined && declared > maxBytes) {
    return { ok: false, reason: "too_large" };
  }
  return readStream(request.body, maxBytes);
};

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
};
