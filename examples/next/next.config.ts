import type { NextConfig } from "next";

const config: NextConfig = {
  // Optional: send `next/image` through the stored variants too (see app/page.tsx).
  images: { loader: "custom", loaderFile: "./image-loader.ts" },
  experimental: {
    // Server Actions accept 1 MB by default. prepareUpload() keeps most photos
    // well under this, but a large PNG can still exceed it.
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default config;
