import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    sourcemap: true,
    rollupOptions: {
      external: [
        "@haneoka/altair",
        "@haneoka/altair/model",
        "@haneoka/altair/plugins",
        "@haneoka/altair/resource-browser",
        "@haneoka/altair-plugin-adv",
      ],
    },
  },
});
