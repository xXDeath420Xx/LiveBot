import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { getPlayerErrorReason } = require('./music-error-reasons.cjs');
export { getPlayerErrorReason };
