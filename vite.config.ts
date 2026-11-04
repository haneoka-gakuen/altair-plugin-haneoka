import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        openotes: "src/openotes.ts",
        "public-resource-url": "src/public-resource-url.ts",
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    sourcemap: true,
    rollupOptions: {
      external: [
        "@haneoka/vega-protocol",
        "@haneoka/altair",
        "@haneoka/altair/model",
        "@haneoka/altair/plugins",
        "@haneoka/altair/resource-browser",
        "@haneoka/altair-plugin-adv",
        "@haneoka/vega-plugin-haneoka/scene-profile",
      ],
    },
  },
});
