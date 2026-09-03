import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      ".next-public/**",
      "node_modules/**",
      "coverage/**",
      "dist/**",
      "build/**",
      // Electron 桌面壳（desktop/）是独立 CommonJS 包，有自己的构建链
      // （electron-builder，见 .github/workflows/desktop-win.yml），不属 Web lint 范围。
      "desktop/**",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
