import assert from "node:assert/strict";
import test from "node:test";
import { decryptSecret, encryptSecret } from "../src/services/secret-box.js";
test("encrypts saved connection passwords and detects tampering", () => {
    const original = "simple:remote@password/with?symbols";
    const encrypted = encryptSecret(original);
    assert.notEqual(encrypted, original);
    assert.equal(decryptSecret(encrypted), original);
    const parts = encrypted.split(".");
    const tag = parts[2];
    parts[2] = `${tag[0] === "A" ? "B" : "A"}${tag.slice(1)}`;
    assert.throws(() => decryptSecret(parts.join(".")), /authenticate data|unsupported format/i);
});
//# sourceMappingURL=secret-box.test.js.map