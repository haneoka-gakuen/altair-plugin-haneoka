import {
  defineAltairPlugin,
  defineAltairService,
} from "@haneoka/altair/plugins";
import type { ResourceBrowserProvider } from "@haneoka/altair/resource-browser";
import {
  createHaneokaResourceBrowserProvider,
  type HaneokaResourceBrowserAdapter,
} from "./resource-browser.js";

export const ALTAIR_HANEOKA_PLUGIN_ID = "haneoka.altair-haneoka" as const;
export const ALTAIR_HANEOKA_RESOURCE_BROWSER =
  defineAltairService<ResourceBrowserProvider>(
    "haneoka.altair.haneoka.resources",
  );

export interface AltairHaneokaPluginOptions {
  readonly adapter: HaneokaResourceBrowserAdapter;
  readonly defaultRelease?: string;
}

export const createAltairHaneokaPlugin = (
  options: AltairHaneokaPluginOptions,
) => {
  const browser = createHaneokaResourceBrowserProvider(options.adapter, {
    ...(options.defaultRelease
      ? { defaultRelease: options.defaultRelease }
      : {}),
  });
  return defineAltairPlugin({
    manifest: {
      id: ALTAIR_HANEOKA_PLUGIN_ID,
      name: "Altair Haneoka",
      version: "0.1.0",
      apiVersion: 2,
      description:
        "Haneoka catalogs, resources, and canonical ADV project import for Altair",
      dependencies: {
        "haneoka.altair-adv": "^0.1.0",
      },
      capabilities: ["assets", "services"],
    },
    setup(context) {
      context.provide(ALTAIR_HANEOKA_RESOURCE_BROWSER, browser);
      context.contribute("resource-browser", browser);
    },
  });
};

const unavailableAdapter: HaneokaResourceBrowserAdapter = Object.freeze({
  async fetchCatalog() {
    throw new ReferenceError(
      "Haneoka catalog transport has not been configured by the Altair host",
    );
  },
});

/**
 * Metadata-safe default activation for catalogs and package inspection.
 * Applications that enable browsing should install a factory result with
 * their own transport adapter.
 */
export const altairHaneokaPlugin = createAltairHaneokaPlugin({
  adapter: unavailableAdapter,
});

export * from "./resource-browser.js";
export default altairHaneokaPlugin;
