import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { createSigner } from "../src/signer.ts";

// Binance spot API docs, rest-api.md, "SIGNED Endpoint Examples" (HMAC).
const BINANCE_SECRET =
	"NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
const BINANCE_PAYLOAD =
	"symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
const BINANCE_SIGNATURE =
	"c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71";

// RFC 8032 §7.1, TEST 2: seed 4ccd089b…a6fb as PKCS#8, message "r".
const RFC8032_PEM = [
	"-----BEGIN PRIVATE KEY-----",
	"MC4CAQAwBQYDK2VwBCIEIEzNCJso/5banbbDRuwRTg9bijGfNaumJNqM9u1PuKb7",
	"-----END PRIVATE KEY-----",
].join("\n");
const RFC8032_SIGNATURE =
	"kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA==";

const NOT_ED25519 = "credential: privateKeyPem is not an Ed25519 private key";

describe("createSigner — hmac", () => {
	test("matches the Binance documentation vector", () => {
		const signer = createSigner({
			kind: "hmac",
			apiKey: "k",
			secret: BINANCE_SECRET,
		});
		expect(signer.sign(BINANCE_PAYLOAD)).toBe(BINANCE_SIGNATURE);
		expect(signer.apiKey).toBe("k");
	});
});

describe("createSigner — ed25519", () => {
	test("matches the RFC 8032 TEST 2 vector", () => {
		const signer = createSigner({
			kind: "ed25519",
			apiKey: "k",
			privateKeyPem: RFC8032_PEM,
		});
		expect(signer.sign("r")).toBe(RFC8032_SIGNATURE);
	});

	test("the signature verifies against the generated public key", () => {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const signer = createSigner({
			kind: "ed25519",
			apiKey: "k",
			privateKeyPem: privateKey
				.export({ type: "pkcs8", format: "pem" })
				.toString(),
		});
		const payload = "symbol=BTCUSDT&recvWindow=5000&timestamp=1";
		const signature = signer.sign(payload);
		expect(
			verify(
				null,
				Buffer.from(payload),
				publicKey,
				Buffer.from(signature, "base64"),
			),
		).toBe(true);
		expect(
			verify(
				null,
				Buffer.from(`${payload}0`),
				publicKey,
				Buffer.from(signature, "base64"),
			),
		).toBe(false);
	});

	test.each([
		[
			"an RSA PKCS#8 key",
			generateKeyPairSync("rsa", {
				modulusLength: 2048,
				privateKeyEncoding: { type: "pkcs8", format: "pem" },
				publicKeyEncoding: { type: "spki", format: "pem" },
			}).privateKey,
		],
		["text that is not PEM", "not a pem"],
	])("refuses %s with a message that echoes no key material", (_, pem) => {
		expect(() =>
			createSigner({ kind: "ed25519", apiKey: "k", privateKeyPem: pem }),
		).toThrow(new Error(NOT_ED25519));
	});
});

describe("createSigner — the secret stays out of the signer object", () => {
	test.each([
		["hmac", { kind: "hmac", apiKey: "k", secret: BINANCE_SECRET }, "NhqPtmdS"],
		[
			"ed25519",
			{ kind: "ed25519", apiKey: "k", privateKeyPem: RFC8032_PEM },
			"MC4CAQAwBQYDK2Vw",
		],
	] as const)(
		"%s: JSON and inspect output carry no secret",
		(_, credential, fragment) => {
			const signer = createSigner(credential);
			expect(JSON.stringify(signer)).not.toContain(fragment);
			expect(Bun.inspect(signer)).not.toContain(fragment);
		},
	);
});
