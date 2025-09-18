// get-channel-info.ts

import axios from 'axios';

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

// Paste the access_token you received
const ACCESS_TOKEN: string = "***REMOVED***";

// The username of the channel you want to look up
const CHANNEL_NAME: string = "mindlesschaos";

// --- ⬆️ NO MORE EDITING ⬆️ ---

// Using the official public v1 API endpoint
const apiUrl: string = `https://api.kick.com/public/v1/channels?slug=${CHANNEL_NAME}`;

const options = {
  method: 'GET',
  url: apiUrl,
  headers: {
    'Authorization': `Bearer ${ACCESS_TOKEN}`,
    'Accept': 'application/json',
  },
};

console.log(`🚀 Attempting to fetch info for channel: ${CHANNEL_NAME} using public v1 API...`);

axios(options)
  .then((response: { data: KickPublicChannelData }) => {
    console.log("✅ SUCCESS! We received channel data from the Kick API.");
    console.log("Here is the response:");
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
