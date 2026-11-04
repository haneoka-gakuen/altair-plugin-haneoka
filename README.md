# Altair Haneoka

Altair Haneoka connects the [Altair](https://github.com/haneoka-gakuen/altair)
editor to the [haneoka.org](https://haneoka.org) catalogue of *BanG Dream! Our
Notes*. Its resource browser lists the game's backgrounds, stills, frames,
effects, post effects, story videos, Live2D characters, BGM, sound effects and
voices, with previews. Drag one into a scene and it becomes the matching
[ADV command](https://github.com/haneoka-gakuen/altair-plugin-adv). Pick an
official story and it opens as a complete, editable project — a fast way to
study how the original scenes are built, or to start a fan story from one.

The plugin knows Haneoka's layout and rules; your application supplies the
network access.

## Install

```sh
pnpm add @haneoka/altair @haneoka/altair-plugin-adv @haneoka/altair-plugin-haneoka
```

Requires Altair ADV (`haneoka.altair-adv ^0.1.0`). ESM only; Node 20 or a
current browser.

## Use it in Altair

```ts
import { AltairPluginHost } from "@haneoka/altair/plugins";
import { altairAdvPlugin } from "@haneoka/altair-plugin-adv";
import { createAltairHaneokaPlugin } from "@haneoka/altair-plugin-haneoka";

const api = "https://haneoka.org/api/v1/servers";

const host = new AltairPluginHost();
await host.install(altairAdvPlugin);
await host.install(
  createAltairHaneokaPlugin({
    defaultRelease: "intl",
    adapter: {
      async fetchCatalog({ release, resource, kind, view, signal }) {
        const path = kind === "view" ? `${resource}/views/${view}` : resource;
        const response = await fetch(`${api}/${release}/${path}`, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      },
    },
  }),
);
```

The plugin contributes a resource browser and provides it as the service
`ALTAIR_HANEOKA_RESOURCE_BROWSER`. The default export `altairHaneokaPlugin` has
no transport and fails every request; it exists so the plugin can be listed
and inspected without network access.

### The adapter

| Member | Called with | Returns |
| --- | --- | --- |
| `fetchCatalog` | `{ release, resource, kind, view?, signal }` | The JSON of one catalogue resource. `kind` is `collection`, `document` or `view`. |
| `fetchAsset` (optional) | `{ release, path, signal }` | An asset file's metadata when your host serves it separately. |
| `localize` (optional) | a localized catalogue value | The string to show. Without it the first available language is used. |

The browser reads these resources: `story-assets` (and its `stills`,
`frames`, `effects`, `post-effects` and `videos` views), `live2d` and
`live2d/<key>`, `audio/views/master-sounds`, `songs` and `stories`.

### Choosing a release

| Order | Source |
| --- | --- |
| 1 | An explicit release on the request or the user's saved choice. |
| 2 | The locale: Japanese → `jp`; English, Chinese and Korean → `intl`. |
| 3 | `defaultRelease` from the plugin options. |

`resolveHaneokaRelease({ release, locale, defaultRelease })` applies the same
order for your own code.

## The browser

Three roots are shown: `Assets` (the game's asset tree), `audio` and `scene`.
When the editor asks for a resource of a certain kind, the browser opens at
the right folder:

| Kind | Folder |
| --- | --- |
| Background | `Assets/AddressableResources/Adv/Stage` |
| Still | `…/Adv/Still` |
| Frame | `…/Adv/Frame` |
| Effect | `…/Adv/Effect` |
| Post effect | `…/Adv/Stage/_settings/posteffect` |
| Video | `…/Adv/Episode` |
| Live2D | `Assets/AddressableResources/Character/Live2D` |

Every file node says what it is (`image`, `audio`, `video`, `live2d`, `story`,
`effect`, `data`), whether it is available, and carries a preview URL where
one exists. Inserting resolves the node into one of:

- a Live2D model entry,
- a visual resource (background, still, frame, effect, post effect, video),
- an audio resource tagged as BGM, sound effect or voice,
- a whole project, when the node is a story — returned with its import
  diagnostics.

The same browser is available without Altair's plugin host through
`createHaneokaResourceBrowser(adapter)`, with `browse`, `list`,
`preferredPath` and `resolveInsert`.

## What is not included

No game assets, Live2D models or character runtimes are bundled. Media is
loaded from the catalogue your adapter reaches, under that service's terms.

## License

MPL-2.0. See [LICENSE](LICENSE).
