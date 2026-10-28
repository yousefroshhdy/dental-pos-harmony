import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: [".next/**", "node_modules/**", "docs/**", "playwright-report/**", "test-results/**", "next-env.d.ts"] },
  {
    rules: {
      // Physical left/right utilities break RTL; use logical ones (ms-/me-/ps-/pe-/start-/end-).
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/(^|\\s)-?(ml|mr|pl|pr|left|right)-/]",
          message: "Use logical Tailwind utilities (ms-, me-, ps-, pe-, start-, end-) so layouts work in RTL.",
        },
      ],
    },
  },
];

export default config;
