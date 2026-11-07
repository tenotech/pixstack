import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    meta: "src/meta.ts",
    "storage/index": "src/storage/index.ts",
    "storage/s3": "src/storage/s3.ts",
    server: "src/server.ts",
    react: "src/react.tsx",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  external: ["sharp", "react", "react-dom", "react/jsx-runtime", "@aws-sdk/client-s3"],
});
