import { defineConfig, type Options } from "tsup";

const external = ["sharp", "react", "react-dom", "react/jsx-runtime", "@aws-sdk/client-s3"];

const shared: Options = {
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: false, // the build script empties dist/ once; two configs run in parallel
  target: "node22",
};

export default defineConfig([
  {
    ...shared,
    entry: {
      index: "src/index.ts",
      meta: "src/meta.ts",
      "storage/index": "src/storage/index.ts",
      "storage/s3": "src/storage/s3.ts",
      server: "src/server.ts",
      react: "src/react.tsx",
      node: "src/node.ts",
      next: "src/next.ts",
      client: "src/client.ts",
      cli: "src/bin.ts",
    },
    external,
    esbuildPlugins: [
      {
        // Keep the Client Component in its own file (built below) so "use client" survives.
        name: "external-react-preload",
        setup(build) {
          build.onResolve({ filter: /^\.\/react-preload\.js$/ }, () => ({ path: "./react-preload.js", external: true }));
        },
      },
    ],
  },
  {
    ...shared,
    entry: { "react-preload": "src/react-preload.tsx" },
    external,
  },
]);
