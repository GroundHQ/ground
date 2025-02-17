import {sveltekit} from '@sveltejs/kit/vite';
import type {PluginOption} from 'vite';
import {nodePolyfills} from 'vite-plugin-node-polyfills';
import {defineConfig} from 'vitest/config';

export default defineConfig({
	plugins: [
		sveltekit() as PluginOption,
		nodePolyfills({
			include: ['buffer'],
		}) as PluginOption,
	],

	test: {
		include: ['src/**/*.{test,spec}.{js,ts}'],
	},
});
