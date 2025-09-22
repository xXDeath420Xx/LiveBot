const crypto = require('crypto');

function base64URLEncode(str) {
    return str.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

const verifier = base64URLEncode(crypto.randomBytes(32));
console.log("✅ Your Code Verifier is (SAVE THIS SECRET!):");
console.log(verifier);
console.log("\n-----------------------------------\n");

const challenge = base64URLEncode(crypto.createHash('sha256').update(verifier).digest());
console.log("✅ Your Code Challenge is (this goes in the URL):");
console.log(challenge);