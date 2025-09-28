import crypto from "crypto";

function baseUrlEncode(str: Buffer) {
    return str.toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
}

const verifier = baseUrlEncode(crypto.randomBytes(32));
console.log("✅ Your Code Verifier is (SAVE THIS SECRET!):");
console.log(verifier);
console.log("\n-----------------------------------\n");

const challenge = baseUrlEncode(crypto.createHash("sha256").update(verifier).digest());
console.log("✅ Your Code Challenge is (this goes in the URL):");
console.log(challenge);
