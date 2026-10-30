import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

export const newToken = () => randomBytes(32).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest();

// argon2id, OWASP minimum parameters
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (pw: string) => hash(pw, OPTS);
export const verifyPassword = (digest: string, pw: string) => verify(digest, pw).catch(() => false);

// Verified against when the email is unknown, so a miss costs the same time as a wrong password.
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashPassword("not-a-real-password"));
