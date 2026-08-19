// crypto.ts — password-based authenticated encryption over Web Crypto.
//
// PBKDF2-SHA-256 (250k iterations) derives an AES-GCM 256-bit key from the
// password. The public blob layout is:  salt(16) ‖ iv(12) ‖ ciphertext(+tag).
// GCM authentication means a wrong password (or any tampering) makes decrypt()
// reject rather than return garbage. DOM-free: uses only globalThis.crypto.

const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt UTF-8 `plaintext` under `password`. Returns salt ‖ iv ‖ ciphertext. */
export async function encrypt(plaintext: string, password: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext)),
  );

  const out = new Uint8Array(SALT_BYTES + IV_BYTES + ciphertext.length);
  out.set(salt, 0);
  out.set(iv, SALT_BYTES);
  out.set(ciphertext, SALT_BYTES + IV_BYTES);
  return out;
}

/**
 * Decrypt a blob produced by {@link encrypt}. Throws on a wrong password or any
 * tampering (GCM auth failure) — callers should surface that as a clear error.
 */
export async function decrypt(blob: Uint8Array, password: string): Promise<string> {
  if (blob.length < SALT_BYTES + IV_BYTES) {
    throw new Error("ciphertext too short");
  }
  const salt = blob.subarray(0, SALT_BYTES);
  const iv = blob.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const ciphertext = blob.subarray(SALT_BYTES + IV_BYTES);
  const key = await deriveKey(password, salt);

  // GCM auth failure throws a DOMException (OperationError) whose message can
  // render empty in the UI — translate it into a clear, deterministic error.
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  } catch {
    throw new Error("wrong password, or the image was altered/recompressed");
  }
  return dec.decode(plaintext);
}
