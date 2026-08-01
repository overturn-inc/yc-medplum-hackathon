import { dirname } from "path";
import { fileURLToPath } from "url";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
void __dirname;

const eslintConfig = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [
      "medplum-link/**",
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "var/**",
      ".playwright-data-*/**",
    ],
  },
];

export default eslintConfig;
