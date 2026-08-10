import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "backups/**"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: globals.node },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-constant-condition": "error",
    },
  },
];
