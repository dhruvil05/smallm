// Minimal flat config. Note: typescript-eslint isn't wired in here because
// its current peer range (typescript <6.1.0) doesn't yet support the
// TypeScript version installed in this project — an ecosystem timing issue,
// not a project issue. Add typescript-eslint once compatible versions align.
export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      "no-unused-vars": "off", // TS handles this better; enable via typescript-eslint later
      "no-undef": "off", // TS handles this
    },
  },
];
