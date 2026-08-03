import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettierConfig from "eslint-config-prettier";

const NO_EM_DASH =
  "No em dashes in copy or prompts. Use a comma, colon, semicolon, parentheses, or a full stop. " +
  "Em dashes are the clearest tell that text was machine-written, and the agent imitates whatever the prompts do.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettierConfig,
  {
    // Scoped to source rather than applied globally: the selectors below have
    // to contain the character they ban, so this config would flag itself.
    files: ["src/**", "scripts/**", "e2e/**"],
    rules: {
      // Matches strings, template chunks and JSX text, so code comments are
      // exempt. A hyphen in a range (50-125) or a compound word is unaffected.
      "no-restricted-syntax": [
        "error",
        { selector: "Literal[value=/—/]", message: NO_EM_DASH },
        { selector: "TemplateElement[value.raw=/—/]", message: NO_EM_DASH },
        { selector: "JSXText[value=/—/]", message: NO_EM_DASH },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Nested git worktrees are whole other checkouts of this repo. Linting
    // them reports another branch's problems as if they were this branch's.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
