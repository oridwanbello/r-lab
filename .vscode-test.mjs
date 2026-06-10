import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	skipExtensionDependencies: true,
	mocha: {
		timeout: 20000,
	},
});
