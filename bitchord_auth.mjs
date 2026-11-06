import { createHash } from "node:crypto";

export const BITCHORD_AUTH_ISSUER = "https://bitchord-auth.kushagrasingh.in";
export const BITCHORD_AUTH_AUDIENCE = "bitchord-addons";
const PROOF_CONTEXT = "bitchord-addon-proof/v1";
const textEncoder = new TextEncoder();
const subtle = globalThis.crypto?.subtle;

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url");
}

function decodeJson(value) {
  return JSON.parse(decodeBase64Url(value).toString("utf8"));
}

function normalizeHost(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function rejection(status, error, message) {
  return { ok: false, status, error, message };
}

export function createBitChordAuth({
  hosts,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (!subtle) throw new Error("BitChord authentication requires WebCrypto.");
  if (typeof fetchImpl !== "function") {
    throw new TypeError("BitChord authentication requires fetch.");
  }
  const allowedHosts = [...new Set((hosts ?? []).map(normalizeHost).filter(Boolean))];
  if (!allowedHosts.length) {
    throw new TypeError("At least one BitChord source hostname is required.");
  }

  let signingKeys = new Map();
  let keysLoadedAt = 0;
  let lastForcedRefresh = 0;
  let keyLoad;
  const deviceKeys = new Map();

  async function loadSigningKeys() {
    const response = await fetchImpl(`${BITCHORD_AUTH_ISSUER}/.well-known/jwks.json`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`BitChord JWKS request failed: HTTP ${response.status}`);
    const body = await response.json();
    const next = new Map();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.kid || !jwk.x) continue;
      next.set(
        jwk.kid,
        await subtle.importKey(
          "jwk",
          { kty: "OKP", crv: "Ed25519", x: jwk.x },
          { name: "Ed25519" },
          false,
          ["verify"],
        ),
      );
    }
    signingKeys = next;
    keysLoadedAt = now();
  }

  async function signingKeyFor(kid) {
    const stale = now() - keysLoadedAt > 60 * 60 * 1000;
    const unknown = !signingKeys.has(kid) && now() - lastForcedRefresh > 5 * 60 * 1000;
    if (stale || unknown) {
      if (unknown) lastForcedRefresh = now();
      keyLoad ??= loadSigningKeys().finally(() => {
        keyLoad = undefined;
      });
      try {
        await keyLoad;
      } catch {
        if (!signingKeys.size) throw new Error("BitChord signing keys are unavailable.");
      }
    }
    return signingKeys.get(kid);
  }

  async function verify({ token, proof } = {}) {
    if (!token || !proof) {
      return rejection(401, "missing", "This addon only works in the official BitChord app");
    }
    try {
      const parts = String(token).split(".");
      if (parts.length !== 3 || parts.some((part) => part.length > 8192)) {
        return rejection(401, "invalid_token", "Malformed token");
      }
      const header = decodeJson(parts[0]);
      const claims = decodeJson(parts[1]);
      if (header.alg !== "EdDSA" || typeof header.kid !== "string") {
        return rejection(401, "invalid_token", "Unsupported token");
      }

      let signingKey;
      try {
        signingKey = await signingKeyFor(header.kid);
      } catch {
        return rejection(503, "unavailable", "Could not load BitChord signing keys; try again shortly");
      }
      if (!signingKey) {
        return rejection(401, "invalid_token", "Token signed by an unknown key");
      }
      const signatureValid = await subtle.verify(
        { name: "Ed25519" },
        signingKey,
        decodeBase64Url(parts[2]),
        textEncoder.encode(`${parts[0]}.${parts[1]}`),
      );
      if (!signatureValid) {
        return rejection(401, "invalid_token", "Token signature is invalid");
      }

      const timestamp = Math.floor(now() / 1000);
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (
        claims.iss !== BITCHORD_AUTH_ISSUER ||
        !audiences.includes(BITCHORD_AUTH_AUDIENCE)
      ) {
        return rejection(401, "invalid_token", "Token is not for BitChord addons");
      }
      if (typeof claims.exp !== "number" || claims.exp + 60 < timestamp) {
        return rejection(401, "expired", "Token expired");
      }
      if (typeof claims.iat !== "number" || claims.iat - 60 > timestamp) {
        return rejection(401, "invalid_token", "Token issued in the future");
      }
      const deviceJwk = claims.cnf?.jwk;
      if (
        deviceJwk?.kty !== "EC" ||
        deviceJwk.crv !== "P-256" ||
        !deviceJwk.x ||
        !deviceJwk.y
      ) {
        return rejection(401, "invalid_token", "Token is not bound to a device key");
      }

      const match = /^v1\.(\d{10,16})\.([A-Za-z0-9_-]{86})$/.exec(String(proof));
      if (!match) return rejection(401, "invalid_proof", "Malformed proof");
      const proofTimestamp = Number(match[1]);
      if (Math.abs(now() - proofTimestamp) > 120_000) {
        return rejection(401, "stale_proof", "Proof is too old; check the device clock");
      }

      const keyId = `${deviceJwk.x}.${deviceJwk.y}`;
      let deviceKey = deviceKeys.get(keyId);
      if (!deviceKey) {
        deviceKey = await subtle.importKey(
          "jwk",
          {
            kty: "EC",
            crv: "P-256",
            x: deviceJwk.x,
            y: deviceJwk.y,
          },
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        );
        if (deviceKeys.size > 10_000) deviceKeys.clear();
        deviceKeys.set(keyId, deviceKey);
      }
      const tokenHash = createHash("sha256")
        .update(token)
        .digest("base64url");
      const proofSignature = decodeBase64Url(match[2]);
      for (const host of allowedHosts) {
        const message = textEncoder.encode(
          `${PROOF_CONTEXT}\n${host}\n${match[1]}\n${tokenHash}`,
        );
        if (
          await subtle.verify(
            { name: "ECDSA", hash: "SHA-256" },
            deviceKey,
            proofSignature,
            message,
          )
        ) {
          return {
            ok: true,
            claims: {
              sub: claims.sub,
              ver: claims.ver,
              exp: claims.exp,
              sl: claims.sl,
            },
          };
        }
      }
      return rejection(401, "invalid_proof", "Proof signature is invalid for this addon");
    } catch {
      return rejection(401, "invalid_token", "Malformed credentials");
    }
  }

  function rejectionResponse(result) {
    const description = String(result.message).replace(/["\\]/g, "");
    return {
      status: result.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate":
          `BitChord realm="${BITCHORD_AUTH_AUDIENCE}", error="${result.error}", ` +
          `error_description="${description}"`,
      },
      body: JSON.stringify({
        error: "bitchord_auth",
        code: result.error,
        message: result.message,
      }),
    };
  }

  return {
    verify,
    verifyRequest(request) {
      return verify({
        token: request.headers["x-bitchord-token"],
        proof: request.headers["x-bitchord-proof"],
      });
    },
    rejection: rejectionResponse,
  };
}
