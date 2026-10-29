/** @type {import('lint-staged').Configuration} */
export default {
  '*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}': ['oxlint --fix', 'oxfmt'],
  '*.{json,jsonc,css,md,yml,yaml}': 'oxfmt',
  // Knip checks the whole project and takes no file arguments, so it runs once without the staged files.
  '*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,json,jsonc,css}': () => 'knip',
}
