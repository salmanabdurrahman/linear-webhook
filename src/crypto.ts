const encoder = new TextEncoder();

export async function hmacSha256Hex(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));

  return bytesToHex(new Uint8Array(signature));
}

export function timingSafeEqualHex(actual: string, expected: string): boolean {
  if (!isHex(expected)) {
    return false;
  }

  const expectedBytes = hexToBytes(expected);
  const actualIsValid = isHex(actual) && actual.length === expected.length;
  const actualBytes = actualIsValid ? hexToBytes(actual) : new Uint8Array(expectedBytes.length);

  const subtleCrypto = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  };

  if (typeof subtleCrypto.timingSafeEqual === "function") {
    return subtleCrypto.timingSafeEqual(actualBytes, expectedBytes) && actualIsValid;
  }

  let diff = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    diff |= actualBytes[index] ^ expectedBytes[index];
  }

  return diff === 0 && actualIsValid;
}

export function normalizeSignature(signature: string | null): string | null {
  if (!signature) {
    return null;
  }

  const trimmed = signature.trim().toLowerCase();
  return trimmed.startsWith("sha256=") ? trimmed.slice("sha256=".length) : trimmed;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }

  return bytes;
}

function isHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}
