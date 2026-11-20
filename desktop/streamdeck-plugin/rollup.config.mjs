// Bundles src/plugin.js and its dependencies (@elgato/streamdeck, ws) into the .sdPlugin folder, as Elgato's own
// template does (minus TypeScript and minifying, so the shipped code stays readable).
import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';

const sdPlugin = 'com.certifried.studio.sdPlugin';

export default {
    input: 'src/plugin.js',
    output: { file: `${sdPlugin}/bin/plugin.js`, format: 'es', sourcemap: false },
    plugins: [
        nodeResolve({ browser: false, exportConditions: ['node'], preferBuiltins: true }),
        commonjs(),
        {
            name: 'emit-module-package-file',
            generateBundle() { this.emitFile({ fileName: 'package.json', source: '{ "type": "module" }', type: 'asset' }); },
        },
    ],
};
