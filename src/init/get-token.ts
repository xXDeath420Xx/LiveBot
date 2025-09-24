// get-tokens.js
const axios = require("axios");
const qs = require("querystring");

// --- ⬇️ FILL THIS IN ⬇️ ---
const config = {
  client_id: "01K3M7M6ZYJHNCS2J7A9PTHC2N",
  client_secret: "08d4e2025016d508d661a501e210373b8b33cb568fa8d5083d37c454f99529d8",
  redirect_uri: "https://www.certifriedannouncer.online/api/kick/callback", // e.g. http://localhost/callback
  code: "MTC1YZU2YWQTY2U1ZI0ZMTA5LWI3OTUTMZLMZDZJYTQ0YMIW",
  code_verifier: "LeBapijB98pSv6xCx6TSk-eb9x5T7yDVQUnFYzmCbpk"
};
// --- ⬆️ NO MORE EDITING ⬆️ ---

const requestBody = {
  grant_type: "authorization_code",
  code: config.code,
  client_id: config.client_id,
  client_secret: config.client_secret,
  redirect_uri: config.redirect_uri,
  code_verifier: config.code_verifier
};

axios.post("https://id.kick.com/oauth/token", qs.stringify(requestBody), {
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
  },
})
  .then(response => {
    console.log("✅ SUCCESS! Here are your tokens:");
    console.log(JSON.stringify(response.data, null, 2));
    console.log("\nSAVE 'access_token' and 'refresh_token' in a secure place (like your .env file)!");
  })
  .catch(error => {
    console.error("❌ ERROR! Something went wrong:");
    console.error(error.response ? error.response.data : error.message);
  });