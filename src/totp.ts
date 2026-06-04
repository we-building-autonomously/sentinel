import crypto from "node:crypto";

/**
 * RFC 6238 TOTP — generate the current 2FA code from a base32 authenticator
 * secret, so a test of a 2FA-protected app can log in when the spec provides
 * `auth.totpSecret`. Pure (time is injectable) and dependency-free.
 */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode a base32 (RFC 4648) secret to bytes; ignores spaces and padding. */
export function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = "";
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue; // skip stray characters
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The TOTP code for a base32 secret at `time` (epoch seconds; defaults to now). */
export function totp(
  secret: string,
  opts: { time?: number; step?: number; digits?: number } = {}
): string {
  const step = opts.step ?? 30;
  const digits = opts.digits ?? 6;
  const time = opts.time ?? Math.floor(Date.now() / 1000);
  let counter = Math.floor(time / step);
  const key = base32Decode(secret);

  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}
