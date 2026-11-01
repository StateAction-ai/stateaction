import { randomBytes, scrypt } from "node:crypto";

/**
 * Better Auth 1.7.15 credential hash format (`salt:key`, scrypt N=16384,
 * r=16, p=1, 64-byte key, NFKC password, hex salt string as the salt input).
 * Used only for local seed accounts; sign-in itself stays in Better Auth.
 */
const N = 16384;
const r = 16;
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password.normalize("NFKC"),
      salt,
      64,
      { N, r, p: 1, maxmem: 128 * N * r * 2 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
export async function hashCredentialPassword(
  password: string,
): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyCredentialPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  const [salt, key] = hash.split(":");
  if (!salt || !key) return false;
  return (await derive(password, salt)).toString("hex") === key;
}
