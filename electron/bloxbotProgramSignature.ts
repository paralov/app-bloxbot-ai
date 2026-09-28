import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

// Published BloxBot programs run inside BloxBot, so BloxBot only accepts a
// manifest signed with the key held by the publishing workflow. The public half
// is pinned here; rotating it takes an app release.
export const BLOXBOT_PROGRAMS_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAzgjoKwaXYI1Dv0/bY/97uo0ixk3V21dNL7i4y9EFtQU=
-----END PUBLIC KEY-----
`;

/** Ed25519 signature of the exact manifest bytes, base64-encoded. */
export function signBloxBotProgramManifest(manifest: string, privateKeyPem: string): string {
  return sign(null, Buffer.from(manifest, "utf8"), createPrivateKey(privateKeyPem)).toString(
    "base64",
  );
}

export function verifyBloxBotProgramManifest(
  manifest: string,
  signature: string,
  publicKeyPem: string = BLOXBOT_PROGRAMS_PUBLIC_KEY,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(manifest, "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(signature.trim(), "base64"),
    );
  } catch {
    return false;
  }
}
