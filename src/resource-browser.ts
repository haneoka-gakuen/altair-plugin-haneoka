import type {
  ResourceBrowserDirectory,
  ResourceBrowserFile,
  ResourceBrowserInsert,
  ResourceBrowserPath,
  ResourceBrowserProvider,
  ResourceBrowserRequest,
} from "@haneoka/altair/resource-browser";
import {
  cloneStoryValue,
  type JsonObject,
  type StoryProject,
  type StoryProjectCommand,
} from "@haneoka/altair/model";
import {
  assertValidStoryProject,
  importAdvStoryJson,
  reconcileAdvEpisodeCommandWithCatalog,
  type StoryDiagnostic,
} from "@haneoka/altair-plugin-adv";

export type HaneokaVisualResourceKind =
  "background" | "still" | "frame" | "effect" | "post-effect" | "video";
export type HaneokaAudioUsage = "bgm" | "se" | "voice";
export type HaneokaPreferredResourceKind =
  HaneokaVisualResourceKind | "live2d" | "audio";

export interface HaneokaCatalogRequest {
  readonly release: string;
  readonly resource: string;
  readonly kind: "collection" | "document" | "view";
  readonly view?: string;
  readonly signal: AbortSignal;
}

export interface HaneokaAssetRequest {
  readonly release: string;
  readonly path: string;
  readonly signal: AbortSignal;
}

/**
 * Transport and localization stay application-owned. This plugin owns every
 * Haneoka path, catalog projection, preview, and insertion rule.
 */
export interface HaneokaResourceBrowserAdapter {
  readonly fetchCatalog: (request: HaneokaCatalogRequest) => Promise<unknown>;
  readonly fetchAsset?: (request: HaneokaAssetRequest) => Promise<unknown>;
  readonly localize?: (value: unknown) => string;
}

export type HaneokaResourceMediaKind =
  "image" | "audio" | "video" | "data" | "live2d" | "story" | "effect";

export interface HaneokaResourcePreview {
  readonly kind: "image" | "audio" | "video";
  readonly url: string;
}

interface HaneokaResourceNodeBase {
  readonly id: string;
  readonly path: readonly string[];
  readonly name: string;
  readonly description?: string;
  readonly meta?: string;
}

export interface HaneokaResourceDirectoryNode extends HaneokaResourceNodeBase {
  readonly kind: "directory";
}

export interface HaneokaResourceFileNode extends HaneokaResourceNodeBase {
  readonly kind: "file";
  readonly media: HaneokaResourceMediaKind;
  readonly preview?: HaneokaResourcePreview;
  readonly audioPreviewUrl?: string;
  readonly available: boolean;
  readonly insert: HaneokaResourceInsertDescriptor;
}

export type HaneokaResourceNode =
  HaneokaResourceDirectoryNode | HaneokaResourceFileNode;

export type HaneokaResourceInsertDescriptor =
  | { readonly kind: "live2d"; readonly key: string }
  | {
      readonly kind: "visual";
      readonly visualKind: HaneokaVisualResourceKind;
      readonly assetId: string;
    }
  | {
      readonly kind: "audio";
      readonly usage: HaneokaAudioUsage;
      readonly key: string;
      readonly value: Readonly<Record<string, unknown>>;
      readonly detailPath?: string;
    }
  | {
      readonly kind: "story";
      readonly storyId: string;
      readonly summary: Readonly<Record<string, unknown>>;
    };

export type HaneokaResourceInsert =
  | {
      readonly kind: "live2d";
      readonly key: string;
      readonly value: Record<string, unknown>;
    }
  | {
      readonly kind: HaneokaVisualResourceKind;
      readonly key: string;
      readonly value: Record<string, unknown>;
    }
  | {
      readonly kind: "audio";
      readonly usage: HaneokaAudioUsage;
      readonly key: string;
      readonly value: Record<string, unknown>;
    }
  | {
      readonly kind: "project";
      readonly key: string;
      readonly value: StoryProject;
      readonly diagnostics: readonly StoryDiagnostic[];
    };

export interface HaneokaResourceBrowseRequest {
  readonly release: string;
  readonly path?: readonly string[];
  readonly preferredKind?: HaneokaPreferredResourceKind;
  readonly preferredAudioUsage?: HaneokaAudioUsage;
  readonly signal?: AbortSignal;
}

export interface HaneokaResourceBrowseResult {
  readonly path: readonly string[];
  readonly nodes: readonly HaneokaResourceNode[];
}

export interface HaneokaResourceResolveRequest {
  readonly release: string;
  readonly descriptor: HaneokaResourceInsertDescriptor;
  readonly signal?: AbortSignal;
}

export interface AltairHaneokaResourceBrowser {
  readonly roots: readonly HaneokaResourceDirectoryNode[];
  preferredPath(request: {
    readonly preferredKind?: HaneokaPreferredResourceKind;
    readonly preferredAudioUsage?: HaneokaAudioUsage;
  }): readonly string[];
  browse(
    request: HaneokaResourceBrowseRequest,
  ): Promise<HaneokaResourceBrowseResult>;
  list(
    request: HaneokaResourceBrowseRequest,
  ): Promise<HaneokaResourceBrowseResult>;
  resolveInsert(
    request: HaneokaResourceResolveRequest,
  ): Promise<HaneokaResourceInsert | undefined>;
}

export interface HaneokaResourceBrowserProviderOptions {
  readonly id?: string;
  readonly name?: string;
  readonly defaultRelease?: string;
}

/**
 * Locale mappings only name Haneoka releases that actually exist. The current
 * archive has one Japanese release; other languages must use an explicit
 * release or the provider's configured default.
 */
export const HANEOKA_RELEASE_BY_LANGUAGE: Readonly<Record<string, string>> =
  Object.freeze({
    ja: "jp-cbt",
    jp: "jp-cbt",
  });

const nonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
};

export const haneokaReleaseForLocale = (
  locale: unknown,
): string | undefined => {
  const language = nonEmptyString(locale)
    ?.replaceAll("_", "-")
    .split("-", 1)[0]
    ?.toLowerCase();
  return language ? HANEOKA_RELEASE_BY_LANGUAGE[language] : undefined;
};

export interface ResolveHaneokaReleaseOptions {
  /** A persisted or user-selected release always wins when present. */
  readonly release?: unknown;
  /** UI/content locale used only when no release was selected explicitly. */
  readonly locale?: unknown;
  /** Final plugin-level fallback for unsupported or missing locales. */
  readonly defaultRelease?: unknown;
}

export const resolveHaneokaRelease = ({
  release,
  locale,
  defaultRelease,
}: ResolveHaneokaReleaseOptions = {}): string | undefined =>
  nonEmptyString(release) ??
  haneokaReleaseForLocale(locale) ??
  nonEmptyString(defaultRelease);

interface AudioItem {
  readonly key: string;
  readonly label: string;
  readonly meta: string;
  readonly playableUrl: string;
  readonly usage: HaneokaAudioUsage;
  readonly value: Record<string, unknown>;
  readonly detailPath?: string;
}

const neverAborted = new AbortController().signal;
const ADV_ROOT = ["Assets", "AddressableResources", "Adv"] as const;
const STAGE_ROOT = [...ADV_ROOT, "Stage"] as const;
const POST_EFFECT_ROOT = [...STAGE_ROOT, "_settings", "posteffect"] as const;
const LIVE2D_ROOT = [
  "Assets",
  "AddressableResources",
  "Character",
  "Live2D",
] as const;
const STATIC_PATHS: readonly (readonly string[])[] = Object.freeze([
  ["Assets"],
  ["audio"],
  ["scene"],
  ["Assets", "AddressableResources"],
  ["Assets", "AddressableResources", "Adv"],
  ["Assets", "AddressableResources", "Character"],
  [...ADV_ROOT, "Effect"],
  [...ADV_ROOT, "Episode"],
  [...ADV_ROOT, "Frame"],
  [...ADV_ROOT, "PostEffect"],
  [...ADV_ROOT, "Stage"],
  [...ADV_ROOT, "Still"],
  [...ADV_ROOT, "Stage", "_settings"],
  [...POST_EFFECT_ROOT],
  [...LIVE2D_ROOT],
  ["audio", "bgm"],
  ["audio", "se"],
  ["audio", "vocal"],
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const record = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const pathKey = (path: readonly string[]): string => path.join("/");

const normalizePath = (value: unknown): string[] =>
  String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/gu, "")
    .split("/")
    .map((part) => part.normalize("NFKC").trim())
    .filter(Boolean);

const safeFilePart = (value: unknown, fallback: string): string =>
  String(value ?? fallback)
    .trim()
    .replaceAll(/[\\/:*?"<>|]/gu, "_") || fallback;

const mediaExtension = (url: unknown, fallback: string): string =>
  String(url ?? "")
    .split(/[?#]/u, 1)[0]
    ?.match(/\.[a-z0-9]{2,5}$/iu)?.[0]
    ?.toLocaleLowerCase() || fallback;

const withFallbackFile = (
  segments: readonly string[],
  fallback: string,
): string[] => {
  if (!segments.length) return [fallback];
  return segments.at(-1)?.includes(".")
    ? [...segments]
    : [...segments, fallback];
};

const pathStartsWith = (
  path: readonly string[],
  prefix: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((part, index) => path[index] === part);

const immediateChildren = (
  current: readonly string[],
  nodes: readonly HaneokaResourceNode[],
  directoryLabels: ReadonlyMap<string, string> = new Map(),
): readonly HaneokaResourceNode[] => {
  const children = new Map<string, HaneokaResourceNode>();
  for (const path of STATIC_PATHS) {
    if (
      path.length !== current.length + 1 ||
      !current.every((part, index) => path[index] === part)
    )
      continue;
    const id = `haneoka:directory:${pathKey(path)}`;
    const description = directoryLabels.get(pathKey(path));
    children.set(id, {
      kind: "directory",
      id,
      path: Object.freeze([...path]),
      name: path.at(-1) || "/",
      ...(description ? { description } : {}),
    });
  }
  for (const node of nodes) {
    if (
      !current.every((part, index) => node.path[index] === part) ||
      node.path.length <= current.length
    )
      continue;
    const remaining = node.path.slice(current.length);
    if (remaining.length === 1) {
      children.set(node.id, node);
      continue;
    }
    const path = [...current, remaining[0]!];
    const id = `haneoka:directory:${pathKey(path)}`;
    const description = directoryLabels.get(pathKey(path));
    children.set(id, {
      kind: "directory",
      id,
      path: Object.freeze(path),
      name: remaining[0]!,
      ...(description ? { description } : {}),
    });
  }
  return Object.freeze([...children.values()]);
};

const assertActive = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw (
      signal.reason ??
      new DOMException("Haneoka resource operation aborted", "AbortError")
    );
  }
};

const visualAvailable = (item: Record<string, unknown>): boolean => {
  const resolution = record(item.resolution);
  const status = String(resolution.status ?? "");
  return (
    item.runtimeAvailable !== false &&
    !["missing", "unavailable"].includes(status)
  );
};

const visualFile = (
  item: Record<string, unknown>,
  visualKind: HaneokaVisualResourceKind,
): HaneokaResourceFileNode => {
  const fallbackRoots: Record<HaneokaVisualResourceKind, readonly string[]> = {
    background: STAGE_ROOT,
    still: [...ADV_ROOT, "Still"],
    frame: [...ADV_ROOT, "Frame"],
    effect: [...ADV_ROOT, "Effect"],
    "post-effect": POST_EFFECT_ROOT,
    video: [...ADV_ROOT, "Episode"],
  };
  const assetId = String(
    item.assetId ?? item.videoId ?? item.assetName ?? visualKind,
  );
  let source = normalizePath(item.sourcePath);
  let fallback = safeFilePart(
    item.assetName ?? item.videoId ?? item.assetId,
    assetId,
  );
  if (!source.length) source = [...fallbackRoots[visualKind]];
  if (visualKind === "video") {
    if (source.at(-1)?.endsWith("-Video.txt")) source = source.slice(0, -1);
    fallback += mediaExtension(item.playableUrl ?? item.url, ".mp4");
    source = [...source, fallback];
  } else {
    const extension =
      visualKind === "post-effect"
        ? ".asset"
        : ["effect", "frame"].includes(visualKind)
          ? ".prefab"
          : ".png";
    source = withFallbackFile(source, `${fallback}${extension}`);
  }
  const path = source.length
    ? source
    : [...fallbackRoots[visualKind], fallback];
  const previewUrl = visualKind === "video" ? "" : String(item.url ?? "");
  return Object.freeze({
    kind: "file",
    id: `haneoka:visual:${visualKind}:${encodeURIComponent(assetId)}`,
    path: Object.freeze(path),
    name: path.at(-1) || fallback,
    description: String(item.assetName ?? item.videoId ?? ""),
    meta: String(item.sourcePath ?? item.assetName ?? item.assetId ?? ""),
    media:
      visualKind === "video"
        ? "video"
        : ["effect", "post-effect"].includes(visualKind)
          ? "effect"
          : "image",
    ...(previewUrl
      ? { preview: Object.freeze({ kind: "image" as const, url: previewUrl }) }
      : {}),
    available: visualAvailable(item),
    insert: Object.freeze({ kind: "visual", visualKind, assetId }),
  });
};

const resolvedSound = (value: Record<string, unknown>): boolean => {
  const status = String(record(value.resolution).status ?? "");
  return (
    Boolean(value.playableUrl) &&
    value.missing !== true &&
    (!status || status === "resolved")
  );
};

const audioFile = (item: AudioItem): HaneokaResourceFileNode => {
  const value = item.value;
  const sourcePath = value.sourcePath ?? value.outputPath ?? value.runtimePath;
  let relative = normalizePath(sourcePath);
  const prefix = normalizePath("Assets/AddressableResources/Adv");
  if (prefix.every((part, index) => relative[index] === part))
    relative = relative.slice(prefix.length);
  if (relative.at(-1)?.includes(".")) relative = relative.slice(0, -1);
  if (String(value.source ?? "") === "songs") relative = ["songs"];
  const name = `${safeFilePart(item.label, String(value.soundId ?? item.key))} [${safeFilePart(
    value.soundId ?? value.musicId ?? item.key,
    item.key,
  )}]${mediaExtension(item.playableUrl, ".audio")}`;
  const path = [
    "audio",
    item.usage === "bgm" ? "bgm" : item.usage === "se" ? "se" : "vocal",
    ...relative,
    name,
  ];
  const previewUrl = String(value.jacketThumbUrl ?? value.jacketUrl ?? "");
  return Object.freeze({
    kind: "file",
    id: `haneoka:audio:${encodeURIComponent(item.key)}`,
    path: Object.freeze(path),
    name,
    description: item.label,
    meta: item.meta,
    media: "audio",
    audioPreviewUrl: item.playableUrl,
    preview: Object.freeze({ kind: "audio", url: item.playableUrl }),
    available: Boolean(item.playableUrl),
    insert: Object.freeze({
      kind: "audio",
      usage: item.usage,
      key: item.key,
      value: Object.freeze({ ...item.value }),
      ...(item.detailPath ? { detailPath: item.detailPath } : {}),
    }),
    ...(previewUrl
      ? {
          // Image artwork is preferred by the grid; audio remains available in
          // the insertion descriptor for the host play control.
          preview: Object.freeze({ kind: "image" as const, url: previewUrl }),
        }
      : {}),
  });
};

const mergeRecords = (
  defaults: Record<string, unknown>,
  authored: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = structuredClone(defaults);
  for (const [key, value] of Object.entries(authored)) {
    if (value === undefined) continue;
    result[key] =
      isRecord(result[key]) && isRecord(value)
        ? mergeRecords(record(result[key]), value)
        : structuredClone(value);
  }
  return result;
};

const sourceIndexKey = (command: StoryProjectCommand): string => {
  const value = command.extensions.advIndex;
  return value === undefined ? "" : `${typeof value}:${String(value)}`;
};

const reconcileEpisodeCommands = (
  sourceCommands: StoryProjectCommand[],
  catalogCommands: readonly StoryProjectCommand[],
): void => {
  const catalogByIndex = new Map<string, StoryProjectCommand>();
  for (const command of catalogCommands) {
    const key = sourceIndexKey(command);
    if (key && !catalogByIndex.has(key)) catalogByIndex.set(key, command);
  }
  for (const [sourceIndex, command] of sourceCommands.entries()) {
    const key = sourceIndexKey(command);
    const indexedCandidate = key ? catalogByIndex.get(key) : undefined;
    const indexed =
      indexedCandidate?.command === command.command
        ? indexedCandidate
        : undefined;
    const positional = catalogCommands[sourceIndex];
    const catalogCommand =
      indexed ||
      (positional?.command === command.command ? positional : undefined);
    if (!catalogCommand) continue;
    const reconciled = reconcileAdvEpisodeCommandWithCatalog(
      command,
      catalogCommand,
    );
    command.fields = reconciled.fields;
    command.extensions = reconciled.extensions;
  }
};

const canonicalStoryProject = (request: {
  readonly release: string;
  readonly storyId: string;
  readonly title: string;
  readonly summary: Record<string, unknown>;
  readonly catalog: Record<string, unknown>;
  readonly sourceCatalog: Record<string, unknown>;
  readonly sourceRuntime: Record<string, unknown>;
  readonly sourceContent: unknown;
}): { readonly project: StoryProject; readonly diagnostics: readonly StoryDiagnostic[] } => {
  const importOptions = {
    title: request.title,
    releaseServer: request.release,
    provenance: {
      resource: "stories",
      id: request.storyId,
    },
  } as const;
  const catalogResult = importAdvStoryJson(request.catalog, importOptions);
  const hasEpisodeSource =
    (typeof request.sourceContent === "string" &&
      Boolean(request.sourceContent.trim())) ||
    (request.sourceContent !== null &&
      typeof request.sourceContent === "object");
  const sourceResult = hasEpisodeSource
    ? importAdvStoryJson(request.sourceContent, importOptions)
    : catalogResult;
  const project = sourceResult.project;

  if (sourceResult !== catalogResult) {
    reconcileEpisodeCommands(
      project.scenes[0]?.commands ?? [],
      catalogResult.project.scenes[0]?.commands ?? [],
    );
    project.assets = cloneStoryValue(catalogResult.project.assets);
    project.runtime = mergeRecords(
      catalogResult.project.runtime,
      project.runtime,
    ) as JsonObject;
    project.storyFields = cloneStoryValue(catalogResult.project.storyFields);
  }

  const sourceSnapshot: JsonObject = {
    catalog: cloneStoryValue(request.sourceCatalog) as JsonObject,
    episode: {
      path: String(request.summary.scriptAsset ?? ""),
      content: cloneStoryValue(
        (request.sourceContent ?? null) as JsonObject[string],
      ),
    },
    runtime: cloneStoryValue(request.sourceRuntime) as JsonObject,
    summary: cloneStoryValue(request.summary) as JsonObject,
  };
  project.extensions = {
    ...project.extensions,
    archiveSource: {
      resource: "stories",
      id: request.storyId,
      snapshot: sourceSnapshot,
    },
  };
  assertValidStoryProject(project);
  return Object.freeze({
    project,
    diagnostics: Object.freeze([...sourceResult.diagnostics]),
  });
};

const directory = (
  path: readonly string[],
  description?: string,
): HaneokaResourceDirectoryNode =>
  Object.freeze({
    kind: "directory",
    id: `haneoka:directory:${pathKey(path)}`,
    path: Object.freeze([...path]),
    name: path.at(-1) || "/",
    ...(description ? { description } : {}),
  });

export const createHaneokaResourceBrowser = (
  adapter: HaneokaResourceBrowserAdapter,
): AltairHaneokaResourceBrowser => {
  const localize = (value: unknown): string =>
    adapter.localize?.(value) || String(value ?? "");

  const fetchCatalog = async (
    release: string,
    resource: string,
    kind: HaneokaCatalogRequest["kind"],
    signal: AbortSignal,
    view?: string,
  ): Promise<unknown> => {
    assertActive(signal);
    const value = await adapter.fetchCatalog({
      release,
      resource,
      kind,
      ...(view ? { view } : {}),
      signal,
    });
    assertActive(signal);
    return value;
  };

  const browse = async (
    request: HaneokaResourceBrowseRequest,
  ): Promise<HaneokaResourceBrowseResult> => {
    const release = request.release.trim();
    if (!release)
      throw new TypeError("Haneoka resource browsing requires a release");
    const path = normalizePath(request.path?.join("/"));
    const signal = request.signal ?? neverAborted;
    assertActive(signal);
    const files: HaneokaResourceNode[] = [];
    const labels = new Map<string, string>();

    if (pathStartsWith(path, LIVE2D_ROOT)) {
      const models = record(
        await fetchCatalog(release, "live2d", "collection", signal),
      );
      for (const item of Object.values(models).map(record)) {
        const key = String(item.live2dKey ?? "");
        if (!key) continue;
        const relative = withFallbackFile(
          normalizePath(item.sourcePath ?? item.mocSourcePath),
          `${safeFilePart(key, "model")}.live2d`,
        );
        const resourcePath = relative.length
          ? relative
          : [...LIVE2D_ROOT, `${key}.live2d`];
        const previewUrl = String(item.thumbnailImage ?? item.faceImage ?? "");
        files.push(
          Object.freeze({
            kind: "file",
            id: `haneoka:live2d:${encodeURIComponent(key)}`,
            path: Object.freeze(resourcePath),
            name: resourcePath.at(-1) || key,
            description:
              localize(item.characterName) ||
              localize(item.title) ||
              String(item.live2dName ?? key),
            meta: String(item.sourcePath ?? key),
            media: "live2d",
            ...(previewUrl
              ? {
                  preview: Object.freeze({
                    kind: "image" as const,
                    url: previewUrl,
                  }),
                }
              : {}),
            available: true,
            insert: Object.freeze({ kind: "live2d", key }),
          }),
        );
      }
    }

    const visualSources: readonly [
      readonly string[],
      HaneokaVisualResourceKind,
      string,
      "document" | "view",
      string?,
    ][] = [
      [STAGE_ROOT, "background", "story-assets", "document"],
      [[...ADV_ROOT, "Still"], "still", "story-assets", "view", "stills"],
      [[...ADV_ROOT, "Frame"], "frame", "story-assets", "view", "frames"],
      [[...ADV_ROOT, "Effect"], "effect", "story-assets", "view", "effects"],
      [
        [...ADV_ROOT, "PostEffect"],
        "post-effect",
        "story-assets",
        "view",
        "post-effects",
      ],
      [POST_EFFECT_ROOT, "post-effect", "story-assets", "view", "post-effects"],
      [[...ADV_ROOT, "Episode"], "video", "story-assets", "view", "videos"],
    ];
    for (const [root, visualKind, resource, kind, view] of visualSources) {
      if (!pathStartsWith(path, root)) continue;
      const response = await fetchCatalog(
        release,
        resource,
        kind,
        signal,
        view,
      );
      const values =
        visualKind === "background" &&
        isRecord(response) &&
        isRecord(response.backgrounds)
          ? Object.values(response.backgrounds)
          : Object.values(record(response));
      for (const item of values.map(record))
        files.push(visualFile(item, visualKind));
      break;
    }

    const audioUsage = pathStartsWith(path, ["audio", "bgm"])
      ? "bgm"
      : pathStartsWith(path, ["audio", "se"])
        ? "se"
        : pathStartsWith(path, ["audio", "vocal"])
          ? "voice"
          : undefined;
    if (audioUsage) {
      const category =
        audioUsage === "bgm" ? "Bgm" : audioUsage === "se" ? "Se" : "Voice";
      const view =
        audioUsage === "bgm"
          ? "bgms"
          : audioUsage === "se"
            ? "sound-effects"
            : "voices";
      const [masterValue, storyValue, songsValue] = await Promise.all([
        fetchCatalog(release, "audio/views/master-sounds", "document", signal),
        fetchCatalog(release, "story-assets", "view", signal, view),
        audioUsage === "bgm"
          ? fetchCatalog(release, "songs", "collection", signal)
          : Promise.resolve({}),
      ]);
      const items: AudioItem[] = [];
      for (const [key, source] of Object.entries(record(masterValue))) {
        const value = record(source);
        if (
          String(value.categoryName ?? "") !== category ||
          !resolvedSound(value)
        )
          continue;
        const label = String(value.cueName ?? value.soundId ?? key);
        items.push({
          key: `master:${key}`,
          label,
          meta: `${category} · ${String(value.cueSheetName ?? value.soundId ?? key)}`,
          playableUrl: String(value.playableUrl),
          usage: audioUsage,
          value,
        });
      }
      for (const [key, source] of Object.entries(record(storyValue))) {
        const value = record(source);
        if (!value.playableUrl) continue;
        const label = String(
          value.cueName ?? value.assetName ?? value.soundId ?? key,
        );
        items.push({
          key: `story:${key}`,
          label,
          meta: String(value.cueSheetName ?? category),
          playableUrl: String(value.playableUrl),
          usage: audioUsage,
          value,
          detailPath: `story-assets/views/${view}/${encodeURIComponent(String(value.assetId ?? key))}`,
        });
      }
      if (audioUsage === "bgm") {
        for (const source of Object.values(record(songsValue))) {
          const song = record(source);
          if (!song.musicUrl) continue;
          const musicId = String(song.musicId ?? "");
          const label = localize(song.musicTitle) || `#${musicId}`;
          items.push({
            key: `song:${musicId}`,
            label,
            meta: "Bgm",
            playableUrl: String(song.musicUrl),
            usage: "bgm",
            value: {
              resourceRef: `song:${musicId}`,
              soundId: `song:${musicId}`,
              cueName: label,
              category: 0,
              categoryName: "Bgm",
              playableUrl: song.musicUrl,
              jacketUrl: song.jacketUrl ?? song.jacketThumbUrl ?? "",
              source: "songs",
              musicId: song.musicId,
            },
          });
        }
      }
      const seenUrls = new Set<string>();
      for (const item of items) {
        if (seenUrls.has(item.playableUrl)) continue;
        seenUrls.add(item.playableUrl);
        files.push(audioFile(item));
      }
    }

    if (pathStartsWith(path, ["scene"])) {
      const stories = record(
        await fetchCatalog(release, "stories", "document", signal),
      );
      for (const source of Object.values(record(stories.episodes))) {
        const item = record(source);
        const storyId = String(item.storyId ?? "");
        if (!storyId) continue;
        const chapter = safeFilePart(
          item.chapterKey ?? item.chapterId,
          "chapter",
        );
        labels.set(
          pathKey(["scene", chapter]),
          localize(item.chapterName) || String(item.chapterKey ?? chapter),
        );
        const relativeSource = normalizePath(item.scriptAsset);
        const prefix = normalizePath("Assets/AddressableResources/Adv/Episode");
        const relative = withFallbackFile(
          prefix.every((part, index) => relativeSource[index] === part)
            ? relativeSource.slice(prefix.length)
            : relativeSource,
          `${safeFilePart(item.storyKey ?? storyId, storyId)}.txt`,
        );
        const resourcePath = ["scene", chapter, ...relative];
        const previewUrl = String(item.image ?? item.banner ?? "");
        files.push(
          Object.freeze({
            kind: "file",
            id: `haneoka:story:${encodeURIComponent(storyId)}`,
            path: Object.freeze(resourcePath),
            name: resourcePath.at(-1) || `${storyId}.txt`,
            description: localize(item.title) || String(item.storyKey ?? ""),
            meta: String(item.scriptAsset ?? storyId),
            media: "story",
            ...(previewUrl
              ? {
                  preview: Object.freeze({
                    kind: "image" as const,
                    url: previewUrl,
                  }),
                }
              : {}),
            available: true,
            insert: Object.freeze({
              kind: "story",
              storyId,
              summary: Object.freeze({ ...item }),
            }),
          }),
        );
      }
    }

    return Object.freeze({
      path: Object.freeze(path),
      nodes: immediateChildren(path, files, labels),
    });
  };

  const resolveInsert = async (
    request: HaneokaResourceResolveRequest,
  ): Promise<HaneokaResourceInsert | undefined> => {
    const release = request.release.trim();
    const signal = request.signal ?? neverAborted;
    assertActive(signal);
    const descriptor = request.descriptor;
    if (descriptor.kind === "live2d") {
      const value = record(
        await fetchCatalog(
          release,
          `live2d/${encodeURIComponent(descriptor.key)}`,
          "document",
          signal,
        ),
      );
      return { kind: "live2d", key: descriptor.key, value };
    }
    if (descriptor.kind === "visual") {
      const views: Record<HaneokaVisualResourceKind, string> = {
        background: "",
        still: "stills",
        frame: "frames",
        effect: "effects",
        "post-effect": "post-effects",
        video: "videos",
      };
      const view = views[descriptor.visualKind];
      const resource = view
        ? `story-assets/views/${view}/${encodeURIComponent(descriptor.assetId)}`
        : `story-assets/${encodeURIComponent(descriptor.assetId)}`;
      const value = record(
        await fetchCatalog(release, resource, "document", signal),
      );
      const key = String(
        value.resourceRef ??
          value.assetName ??
          value.videoId ??
          value.soundId ??
          descriptor.assetId,
      );
      return { kind: descriptor.visualKind, key, value };
    }
    if (descriptor.kind === "audio") {
      const value = descriptor.detailPath
        ? record(
            await fetchCatalog(
              release,
              descriptor.detailPath,
              "document",
              signal,
            ),
          )
        : { ...descriptor.value };
      const cueSheet = String(value.cueSheetName ?? "").trim();
      const cue = String(value.cueName ?? "").trim();
      const key = String(
        value.resourceRef ??
          (cueSheet && cue ? `${cueSheet}/${cue}` : cue) ??
          value.soundId ??
          descriptor.key,
      );
      return {
        kind: "audio",
        usage: descriptor.usage,
        key,
        value: { ...value, resourceRef: key },
      };
    }

    const detail = record(
      await fetchCatalog(
        release,
        `stories/${encodeURIComponent(descriptor.storyId)}`,
        "document",
        signal,
      ),
    );
    const assets = record(detail.assets);
    const live2dKeys = Array.isArray(assets.live2d)
      ? assets.live2d
          .map((entry) => String(record(entry).live2dKey ?? ""))
          .filter(Boolean)
      : [];
    const scriptAsset = String(descriptor.summary.scriptAsset ?? "");
    const [runtimeValue, live2d, sourceContent] = await Promise.all([
      fetchCatalog(release, "story-runtime", "document", signal),
      Promise.all(
        [...new Set(live2dKeys)].map((key) =>
          fetchCatalog(
            release,
            `live2d/${encodeURIComponent(key)}`,
            "document",
            signal,
          ),
        ),
      ),
      scriptAsset && adapter.fetchAsset
        ? adapter.fetchAsset({ release, path: scriptAsset, signal })
        : Promise.resolve(undefined),
    ]);
    const runtime = mergeRecords(record(runtimeValue), record(detail.runtime));
    const value = {
      ...detail,
      title: descriptor.summary.title,
      storyId: descriptor.storyId,
      assets: { ...assets, live2d },
      runtime,
    };
    const canonical = canonicalStoryProject({
      release,
      storyId: descriptor.storyId,
      title:
        localize(descriptor.summary.title) ||
        String(descriptor.summary.storyKey ?? descriptor.storyId),
      summary: { ...descriptor.summary },
      catalog: value,
      sourceCatalog: detail,
      sourceRuntime: runtime,
      sourceContent: sourceContent ?? null,
    });
    return {
      kind: "project",
      key: descriptor.storyId,
      value: canonical.project,
      diagnostics: canonical.diagnostics,
    };
  };

  return Object.freeze({
    roots: Object.freeze([
      directory(["Assets"]),
      directory(["audio"]),
      directory(["scene"]),
    ]),
    preferredPath({
      preferredKind,
      preferredAudioUsage,
    }: {
      readonly preferredKind?: HaneokaPreferredResourceKind;
      readonly preferredAudioUsage?: HaneokaAudioUsage;
    }) {
      if (preferredKind === "live2d") return LIVE2D_ROOT;
      if (preferredKind === "background") return STAGE_ROOT;
      if (preferredKind === "still") return [...ADV_ROOT, "Still"];
      if (preferredKind === "frame") return [...ADV_ROOT, "Frame"];
      if (preferredKind === "effect") return [...ADV_ROOT, "Effect"];
      if (preferredKind === "post-effect") return ADV_ROOT;
      if (preferredKind === "video") return [...ADV_ROOT, "Episode"];
      if (preferredKind === "audio") {
        return [
          "audio",
          preferredAudioUsage === "voice"
            ? "vocal"
            : preferredAudioUsage === "se"
              ? "se"
              : "bgm",
        ];
      }
      return [];
    },
    browse,
    list: browse,
    resolveInsert,
  });
};

type HaneokaResourceReference = HaneokaResourceInsertDescriptor;

const providerContext = (
  request: ResourceBrowserRequest,
  options: HaneokaResourceBrowserProviderOptions,
): {
  readonly release: string;
  readonly preferredAudioUsage?: HaneokaAudioUsage;
} => {
  const context = request.context ?? {};
  const release = resolveHaneokaRelease({
    release:
      nonEmptyString(context.release) ??
      nonEmptyString(context.releaseServer),
    locale: context.locale,
    defaultRelease: options.defaultRelease,
  });
  if (!release)
    throw new TypeError(
      "Haneoka resource provider requires an explicit release, a supported locale, or defaultRelease",
    );
  const usage = context.audioUsage ?? context.preferredAudioUsage;
  const preferredAudioUsage =
    usage === "bgm" || usage === "se" || usage === "voice" ? usage : undefined;
  return { release, ...(preferredAudioUsage ? { preferredAudioUsage } : {}) };
};

const providerDirectory = (
  node: HaneokaResourceDirectoryNode,
): ResourceBrowserDirectory =>
  Object.freeze({
    type: "directory",
    id: node.id,
    name: node.name,
    path: node.path,
    ...(node.description ? { description: node.description } : {}),
  });

const providerFile = (
  node: HaneokaResourceFileNode,
): ResourceBrowserFile<HaneokaResourceReference> => {
  const acceptedKinds =
    node.insert.kind === "visual"
      ? [node.insert.visualKind]
      : node.insert.kind === "audio"
        ? ["audio"]
        : node.insert.kind === "story"
          ? ["project"]
          : [node.insert.kind];
  const displayKind =
    node.media === "live2d"
      ? "model"
      : node.media === "story"
        ? "scene"
        : node.media === "effect"
          ? "other"
          : node.media;
  return Object.freeze({
    type: "file",
    id: node.id,
    name: node.name,
    path: node.path,
    ...(node.description ? { description: node.description } : {}),
    ...(node.meta ? { detail: node.meta } : {}),
    displayKind,
    ...(node.preview?.kind === "image" ? { previewUrl: node.preview.url } : {}),
    ...(node.audioPreviewUrl ? { audioPreviewUrl: node.audioPreviewUrl } : {}),
    acceptedKinds: Object.freeze(acceptedKinds),
    available: node.available,
    reference: node.insert,
  });
};

/**
 * Neutral Altair provider facade. The host never sees Haneoka catalog paths or
 * descriptors; it only renders nodes and forwards the opaque reference.
 */
export const createHaneokaResourceBrowserProvider = (
  adapter: HaneokaResourceBrowserAdapter,
  options: HaneokaResourceBrowserProviderOptions = {},
): ResourceBrowserProvider<
  HaneokaResourceReference,
  unknown
> => {
  const browser = createHaneokaResourceBrowser(adapter);
  const roots = browser.roots.map(providerDirectory);
  return Object.freeze({
    id: options.id?.trim() || "haneoka.resources",
    name: options.name?.trim() || "Haneoka",
    roots: Object.freeze(roots),
    preferredPath(request: ResourceBrowserRequest) {
      const context = providerContext(request, options);
      return browser.preferredPath({
        ...(request.preferredKind
          ? {
              preferredKind:
                request.preferredKind as HaneokaPreferredResourceKind,
            }
          : {}),
        ...(context.preferredAudioUsage
          ? { preferredAudioUsage: context.preferredAudioUsage }
          : {}),
      });
    },
    async list(path: ResourceBrowserPath, request: ResourceBrowserRequest) {
      const context = providerContext(request, options);
      const result = await browser.browse({
        release: context.release,
        path,
        ...(request.preferredKind
          ? {
              preferredKind:
                request.preferredKind as HaneokaPreferredResourceKind,
            }
          : {}),
        ...(context.preferredAudioUsage
          ? { preferredAudioUsage: context.preferredAudioUsage }
          : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return Object.freeze(
        result.nodes.map((node) =>
          node.kind === "directory"
            ? providerDirectory(node)
            : providerFile(node),
        ),
      );
    },
    async open(
      file: ResourceBrowserFile<HaneokaResourceReference>,
      request: ResourceBrowserRequest,
    ) {
      const context = providerContext(request, options);
      const result = await browser.resolveInsert({
        release: context.release,
        descriptor: file.reference,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (!result) return undefined;
      const extensions =
        result.kind === "project" && result.diagnostics.length
          ? Object.freeze({ diagnostics: result.diagnostics })
          : undefined;
      return Object.freeze({
        kind: result.kind,
        key: result.key,
        value: result.value,
        ...(result.kind === "audio" ? { usage: result.usage } : {}),
        ...(extensions ? { extensions } : {}),
      }) as ResourceBrowserInsert<Record<string, unknown>>;
    },
  });
};
