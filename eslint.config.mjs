import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: [".next/**", "node_modules/**", "docs/**", ".claude/**", "mobile/**", "playwright-report/**", "test-results/**", "next-env.d.ts"] },
  {
    rules: {
      // Physical left/right utilities break RTL; use logical ones (ms-/me-/ps-/pe-/start-/end-).
      // Only class contexts: className="…", className={`…`}, cn(…), cva(…).
      "no-restricted-syntax": [
        "error",
        ...[
          "JSXAttribute[name.name='className'] Literal",
          "JSXAttribute[name.name='className'] TemplateElement",
          "CallExpression[callee.name=/^(cn|cva|clsx)$/] Literal",
        ].map((ctx) => ({
          selector: `${ctx}[value=/(^|\\s|:)-?(ml|mr|pl|pr|left|right)-/]`.replace("TemplateElement[value=", "TemplateElement[value.raw="),
          message: "Use logical Tailwind utilities (ms-, me-, ps-, pe-, start-, end-) so layouts work in RTL.",
        })),
      ],
    },
  },
];

export default config;
