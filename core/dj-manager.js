import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const DJManager = require('./dj-manager.cjs').default;

export default DJManager;
