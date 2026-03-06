import * as kickApi from '../utils/platforms/kick.js';
import logger from '../utils/logger.js';

console.log('\n🔍 Checking if x2fdx is live on Kick...\n');

try {
    const isLive = await kickApi.isStreamerLive('x2fdx');
    console.log(`📡 Kick API Result: ${isLive ? '✅ LIVE' : '❌ OFFLINE'}`);

    if (isLive) {
        console.log('\n📺 Fetching stream details...\n');
        const streamData = await kickApi.getStreamDetails('x2fdx');
        console.log('Stream Data:');
        console.log(JSON.stringify(streamData, null, 2));
    } else {
        console.log('\n❌ x2fdx is NOT currently live on Kick');
        console.log('\nThis explains why there is no announcement:');
        console.log('  - Streamer must be LIVE to create an announcement');
        console.log('  - If they were live before, the announcement was deleted when they went offline');
    }
} catch (error) {
    console.error('❌ Error checking Kick status:', error.message);
}

process.exit(0);
