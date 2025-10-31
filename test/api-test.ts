// api-final-test.ts

const axios = require('axios');

// --- Interfaces for Kick Public API v1 ---
interface KickPublicStream {
  is_live: boolean;
  viewer_count: number;
  // Add other stream properties if known/needed
}

interface KickPublicChannel {
  slug: string;
  stream: KickPublicStream | null; // Stream might be null if not live
  // Add other channel properties if known/needed
}

interface KickPublicChannelData {
  data: KickPublicChannel[];
}

// --- ⬇️ FILL THIS IN ⬇️ ---

// Paste the App Access Token you received
const ACCESS_TOKEN: string = "***REMOVED***";

// The username (slug) of the channel you want to look up
const CHANNEL_SLUG: string = "mindlesschaos";

// --- ⬆️ NO MORE EDITING ⬆️ ---

// === THIS IS THE NEW, DOCUMENTATION-CONFIRMED API URL ===
// Note the /public/v1/ path and the ?slug= parameter at the end
const apiUrl: string = `https://api.kick.com/public/v1/channels?slug=${CHANNEL_SLUG}`;

const options = {
  method: 'GET',
  url: apiUrl,
  headers: {
    'Authorization': `Bearer ${ACCESS_TOKEN}`,
    'Accept': 'application/json',
  },
};

console.log(`🚀 Attempting to fetch info from the OFFICIAL V1 API for channel: ${CHANNEL_SLUG}...`);

axios(options)
  .then((response: { data: KickPublicChannelData }) => {
    console.log("✅✅✅ SUCCESS! WE ARE THROUGH! ✅✅✅");
    console.log("Here is the channel data:");
    console.log(JSON.stringify(response.data, null, 2));

    // Example of accessing typed data
    if (response.data.data.length > 0) {
      const channel = response.data.data[0];
      console.log(`Channel Slug: ${channel.slug}`);
      if (channel.stream) {
        console.log(`Is Live: ${channel.stream.is_live ? 'Yes' : 'No'}`);
        console.log(`Viewers: ${channel.stream.viewer_count}`);
      }
    }

  })
  .catch((error: any) => {
    console.error("❌ FAILED: The API returned an error.");
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    } else {
      console.error('Error Message:', error.message);
    }
  });