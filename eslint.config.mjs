import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "test/fixtures/**",
      "dist/**",
      "node_modules/**",
      ".standalone/**",
      ".mcpb-bundle/**",
    ],
  },
  {
    files: ["{src,bin,test}/**/*.{ts,tsx,mts,cts}", "*.config.ts"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended, prettier],
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // Test doubles remain permissive; production overrides enforce safe values.
      "@typescript-eslint/no-explicit-any": "off",
      // Control-character matching is intentional in path/text sanitizers.
      "no-control-regex": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          ignoreRestSiblings: true,
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["{src,bin}/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
    },
  },
);
