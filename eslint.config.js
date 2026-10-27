import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["test-results/", "playwright-report/"] },
  js.configs.recommended,
  { rules: { "no-unused-vars": ["error", { ignoreRestSiblings: true }] } }, // ({ dropped, ...kept }) => kept
  { files: ["app.js", "lib.js"], languageOptions: { globals: globals.browser } },
  { files: ["sw.js", "worker/**"], languageOptions: { globals: globals.serviceworker } },
  { files: ["**/*.test.js", "e2e/**", "scripts/**", "*.config.js"], languageOptions: { globals: globals.node } },
];
