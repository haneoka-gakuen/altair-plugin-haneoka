import { VEGA_SYSTEM_OPCODE } from "@haneoka/vega-protocol";
import {
  cloneStoryValue,
  type JsonObject,
  type JsonValue,
  type StoryProject,
  type StoryProjectCommand,
} from "@haneoka/altair/model";
import { ADV_COMMAND, createStoryCommand, importAdvStoryJson, type AdvCommandName } from "@haneoka/altair-plugin-adv";
import { HANEOKA_STAGE_GEOMETRY, planHaneokaStageBlocking } from "@haneoka/vega-plugin-haneoka/scene-profile";

export const OPENOTES_SOURCE = "haneoka.openotes";
const channels = new Set([
  "motion",
  "expression",
  "head",
  "body",
  "gaze",
  "position",
  "opacity",
  "costume",
  "camera",
  "bgm",
  "se",
  "fade",
  "fx",
  "background",
]);
const kinds = new Set(["dialogue", "narration", "action", "pause", "establishing", "silent", "empty"]);
const object = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
const rows = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.map(object) : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const number = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const id = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value) throw new TypeError(`${label} is missing`);
  return value;
};
export interface OpenotesReferences {
  models: string[];
  backgrounds: string[];
  audio: string[];
}
export interface OpenotesResources {
  models: ReadonlyMap<string, JsonObject>;
  backgrounds: ReadonlyMap<string, JsonObject>;
  audio: ReadonlyMap<string, JsonObject>;
}
export function isOpenotesProject(value: unknown): boolean {
  const raw = object(value),
    project = object(raw.project ?? raw);
  return (
    raw.format === "openotes-project" ||
    raw.format === "ournotes-project" ||
    (project.schemaVersion === 1 &&
      Array.isArray(project.cast) &&
      Array.isArray(project.scenes) &&
      typeof project.source === "object")
  );
}
/** Reads the public exchange format without depending on the source application's runtime. */
export function parseOpenotesProject(input: unknown): JsonObject {
  const value = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  const envelope = object(value);
  if (
    envelope.format !== undefined &&
    (!["openotes-project", "ournotes-project"].includes(text(envelope.format)) || envelope.formatVersion !== 1)
  )
    throw new TypeError("Unsupported OpeNotes exchange format");
  const project = object(envelope.project ?? envelope);
  if (
    project.schemaVersion !== 1 ||
    !Array.isArray(project.cast) ||
    !Array.isArray(project.scenes) ||
    !project.scenes.length
  )
    throw new TypeError("Invalid OpeNotes project");
  id(project.id, "Project ID");
  const cast = new Set<string>();
  for (const actor of rows(project.cast)) {
    const key = id(actor.id, "Cast ID");
    if (cast.has(key)) throw new TypeError(`Duplicate cast: ${key}`);
    cast.add(key);
  }
  const scenes = new Set<string>();
  for (const scene of rows(project.scenes)) {
    const key = id(scene.id, "Scene ID");
    if (scenes.has(key)) throw new TypeError(`Duplicate scene: ${key}`);
    scenes.add(key);
    const beats = new Set<string>();
    for (const beat of rows(scene.beats)) {
      const key = id(beat.id, "Beat ID");
      if (beats.has(key) || !kinds.has(text(beat.kind))) throw new TypeError(`Invalid beat: ${key}`);
      beats.add(key);
      for (const speaker of [beat.speakerId, ...(Array.isArray(beat.coSpeakers) ? beat.coSpeakers : [])])
        if (speaker && !cast.has(String(speaker))) throw new TypeError(`Missing cast: ${speaker}`);
    }
    for (const track of rows(scene.tracks)) {
      if (!channels.has(text(track.channel))) throw new TypeError(`Unsupported OpeNotes channel: ${track.channel}`);
      const target = object(track.target);
      if (target.kind === "actor" && !cast.has(text(target.castId)))
        throw new TypeError(`Missing cast: ${target.castId}`);
      for (const key of rows(track.keys)) {
        if (!beats.has(text(object(key.at).beatId))) throw new TypeError(`Missing beat: ${object(key.at).beatId}`);
        if (
          key.duration !== undefined &&
          (typeof key.duration !== "number" || !Number.isFinite(key.duration) || key.duration < 0)
        )
          throw new TypeError("Invalid key duration");
      }
    }
  }
  return cloneStoryValue(project);
}
export function openotesReferences(input: unknown): OpenotesReferences {
  const project = parseOpenotesProject(input),
    models = new Set<string>(),
    backgrounds = new Set<string>(),
    audio = new Set<string>();
  const add = (set: Set<string>, value: unknown) => {
    if (typeof value === "string" && value) set.add(value);
  };
  for (const scene of rows(project.scenes)) {
    add(backgrounds, object(scene.background).assetId);
    Object.values(object(scene.wardrobe)).forEach((value) => add(models, object(value).modelId));
    for (const value of Object.values(object(scene.audio))) add(audio, object(value).assetId);
    for (const track of rows(scene.tracks))
      for (const key of rows(track.keys)) {
        const value = object(key.value);
        if (track.channel === "costume") add(models, value.modelId);
        if (track.channel === "background") add(backgrounds, value.assetId);
        if (track.channel === "bgm" || track.channel === "se") add(audio, value.assetId);
      }
  }
  return { models: [...models].sort(), backgrounds: [...backgrounds].sort(), audio: [...audio].sort() };
}
function locks(meta: JsonObject): JsonObject {
  const fields: Record<string, string> = {
    speakerId: "cast",
    coSpeakers: "cast",
    kind: "text",
    text: "text",
    duration: "timing",
    motion: "motion",
    expression: "face",
    shot: "camera",
    background: "stage",
  };
  return Object.fromEntries(
    (meta.locked
      ? ["text", "cast", "motion", "face", "camera", "audio", "stage", "timing"]
      : Array.isArray(meta.lockedFields)
        ? meta.lockedFields.map((key) => fields[String(key)] ?? String(key))
        : []
    ).map((key) => [key, true]),
  );
}
const distances: Record<string, number> = {
  establishing: 0,
  group: 1,
  two_shot: 2,
  ms: 3,
  mcu: 4,
  cu: 5,
  ecu: 6,
  insert: 6,
  wide: 1,
  medium: 3,
  bust: 4,
  closeup: 5,
};

/** Lowers each beat and all fourteen authoring channels into native commands and property curves. */
export function importOpenotesProject(
  input: unknown,
  resources: OpenotesResources,
  options: { locale?: string; releaseServer?: string } = {},
): StoryProject {
  const source = parseOpenotesProject(input),
    references = openotesReferences(source),
    locale = options.locale ?? "zh-CN";
  for (const [kind, keys] of Object.entries(references))
    for (const key of keys)
      if (!resources[kind as keyof OpenotesResources].has(key))
        throw new Error(`Missing OpeNotes resource: ${kind}/${key}`);
  const project = importAdvStoryJson(
    { commands: [] },
    { title: text(source.title), ...(options.releaseServer ? { releaseServer: options.releaseServer } : {}) },
  ).project;
  project.meta.locale = locale;
  project.meta.provenance = { format: "openotes-project", projectId: source.id! };
  project.runtime.stage = cloneStoryValue(HANEOKA_STAGE_GEOMETRY as unknown as JsonObject);
  project.runtime.presentation = { mode: "our-notes" };
  const projectSettings = object(source.settings);
  project.runtime.waitTalkTextUnitTime = 1 / Math.max(1, number(projectSettings.textSpeedCps, 24));
  project.runtime.targetFrameRate = Math.max(1, number(projectSettings.fps, 30));
  project.assets = {
    live2d: [...resources.models].map(([id, value]) => ({ ...cloneStoryValue(value), id, live2dKey: id })),
    backgrounds: Object.fromEntries(
      [...resources.backgrounds].map(([id, value]) => [id, { ...cloneStoryValue(value), id, resourceRef: id }]),
    ),
    sounds: [...resources.audio].map(([id, value]) => ({ ...cloneStoryValue(value), id, resourceRef: id })),
  };
  project.extensions[OPENOTES_SOURCE] = { version: 1, project: cloneStoryValue(source) };
  const cast = new Map(rows(source.cast).map((actor) => [text(actor.id), actor]));
  project.scenes = rows(source.scenes).map((scene, sceneIndex, sourceScenes) => {
    const sceneId = text(scene.id),
      beats = rows(scene.beats),
      wardrobe = object(scene.wardrobe),
      blocking = object(scene.blocking),
      initialAudio = object(scene.audio),
      settings = object(source.settings);
    let serial = 0;
    const make = (name: AdvCommandName, fields: JsonObject = {}, stable = ""): StoryProjectCommand => ({
      ...createStoryCommand(name, { ...(name === "Focus" ? { cameraAnchor: "character" } : {}), ...fields }),
      id: `${sceneId}/${stable || `${name}/${serial++}`}`,
      extensions: {},
    });
    const asset = (kind: keyof OpenotesResources, ref: unknown): JsonObject =>
      cloneStoryValue(resources[kind].get(text(ref))!);
    const commands: StoryProjectCommand[] = [
      {
        id: `${sceneId}/reset`,
        command: "haneoka.vega-core:propertyClip@1",
        fields: { target: "*", reset: true, clip: { durationSeconds: 0, tracks: [] } },
        extensions: {},
      },
    ];
    for (const target of cast.keys()) commands.push(make("Out", { targetName: target, duration: 0 }));
    const transition = object(scene.transitionIn),
      transitionKind = text(transition.kind),
      transitionSeconds = number(transition.duration);
    const dipped = ["fade_black", "fade_white", "dip_black", "scene_black"].includes(transitionKind);
    const transitionColor = transitionKind === "fade_white" ? "#ffffff" : "#000000";
    if (dipped && sceneIndex)
      commands.push(make("FadeOut", { params: [transitionColor, "6"], duration: transitionSeconds / 2 }));
    commands.push(
      make("Stage", {
        backgroundRef: object(scene.background).assetId!,
        background: asset("backgrounds", object(scene.background).assetId),
        duration: transitionKind === "crossfade" ? transitionSeconds : 0,
      }),
    );
    if (dipped) commands.push(make("FadeIn", { params: [transitionColor, "6"], duration: transitionSeconds / 2 }));
    const location = object(scene.location);
    if (location.show !== false && text(location.text))
      commands.push(make("Location", { text: { [locale]: text(location.text) } }));
    const previousAmbience = object(object(sourceScenes[sceneIndex - 1]?.audio).ambience);
    if (previousAmbience.assetId)
      commands.push(make("Se", { se: asset("audio", previousAmbience.assetId), params: ["Stop", "0", "0"] }));
    for (const [castId, value] of Object.entries(wardrobe)) {
      const model = text(object(value).modelId);
      commands.push(
        make("Character", { targetName: castId, live2dKey: model, characterModel: asset("models", model) }),
      );
      commands.push(make("Angle", { targetName: castId, params: ["0", "0"], duration: 0 }));
      commands.push(make("Look", { targetName: castId, params: ["0", "0", "stop"], duration: 0 }));
    }
    const positions = new Map(
      Object.entries(blocking).map(([castId, value]) => [
        castId,
        { slot: number(object(value).slot), depth: number(object(value).depth) },
      ]),
    );
    const nativePositions = planHaneokaStageBlocking(
      [...positions].map(([target, position]) => ({ target, order: position.slot })),
    );
    const sourceSlots = [...positions.values()].map((position) => position.slot);
    for (const track of rows(scene.tracks))
      if (track.channel === "position")
        for (const key of rows(track.keys)) sourceSlots.push(number(object(key.value).slot));
    const minSlot = sourceSlots.length ? Math.min(...sourceSlots) : 0,
      maxSlot = sourceSlots.length ? Math.max(...sourceSlots) : 0;
    const nativeXs = [...nativePositions.values()].map((point) => point.x);
    const minX = nativeXs.length ? Math.min(...nativeXs) : 0,
      maxX = nativeXs.length ? Math.max(...nativeXs) : 0;
    const stage = HANEOKA_STAGE_GEOMETRY;
    const world = (castId: string, slot?: number, depth?: number) => ({
      x:
        positions.size > 1 && maxSlot > minSlot
          ? minX + (((slot ?? positions.get(castId)?.slot ?? 0) - minSlot) / (maxSlot - minSlot)) * (maxX - minX)
          : positions.size > 1
            ? (nativePositions.get(castId)?.x ?? 0)
            : ((slot ?? positions.get(castId)?.slot ?? 0) * stage.width) / 2,
      y: stage.characterFieldPosition.y + stage.characterBasePosition.y * stage.characterFieldScale,
      z:
        stage.characterFieldPosition.z +
        stage.characterBasePosition.z * stage.characterFieldScale +
        (depth ?? positions.get(castId)?.depth ?? 0) * 1.2,
    });
    const durationOf = (beat: JsonObject): number =>
      object(beat.duration).mode === "fixed"
        ? Math.max(0, number(object(beat.duration).seconds))
        : Math.max(
            0.6,
            Array.from(text(beat.text)).length / Math.max(1, number(settings.textSpeedCps, 24)) +
              number(settings.defaultLineGap),
          );
    const times = new Map<string, number>();
    let cursor = 0;
    beats.forEach((beat) => {
      times.set(text(beat.id), cursor);
      cursor += durationOf(beat);
    });
    for (const [kind, value] of Object.entries(initialAudio)) {
      const audio = object(value);
      if (!audio.assetId) continue;
      commands.push(
        make(kind === "bgm" ? "Bgm" : "Se", {
          [kind === "bgm" ? "bgmRef" : "seRef"]: audio.assetId,
          [kind === "bgm" ? "bgm" : "se"]: {
            ...asset("audio", audio.assetId),
            volume: number(audio.volume, 0.6),
            ...(kind === "ambience" ? { isLoop: true } : {}),
          },
        }),
      );
    }
    const keys = rows(scene.tracks)
      .flatMap((track) =>
        rows(track.keys).map((key) => ({
          track,
          key,
          time: (times.get(text(object(key.at).beatId)) ?? 0) + number(object(key.at).offset),
        })),
      )
      .sort((a, b) => a.time - b.time);
    const last = new Map<string, Record<string, number>>();
    const property = (
      target: string,
      values: Record<string, number>,
      key: JsonObject,
      stable: string,
    ): StoryProjectCommand => {
      const start = last.get(target) ?? {},
        duration = number(key.duration);
      const clip: JsonObject = {
        durationSeconds: duration,
        tracks: Object.entries(values).map(([channel, value]) => ({
          channel,
          points: [
            { timeSeconds: 0, value: start[channel] ?? (channel === "alpha" || channel === "zoomRatio" ? 1 : 0) },
            { timeSeconds: duration, value, ease: text(key.ease) || "inOutQuad" },
          ],
        })),
      };
      last.set(target, { ...start, ...values });
      return {
        id: `${sceneId}/${stable}`,
        command: "haneoka.vega-core:propertyClip@1",
        fields: { target, clip, parallel: true, keep: true },
        extensions: {},
      };
    };
    for (const [beatIndex, beat] of beats.entries()) {
      const beatId = text(beat.id),
        start = times.get(beatId)!,
        end = start + durationOf(beat),
        actions: JsonObject[] = [];
      const add = (command: StoryProjectCommand, atSeconds = 0, role = "event") =>
        actions.push({
          atSeconds,
          role,
          command: { command: command.command, commandId: command.id, ...command.fields },
        });
      for (const [castId, value] of Object.entries(blocking)) {
        const block = object(value),
          enter = object(block.enter),
          exit = object(block.exit);
        if (
          ((!enter.beatId && beatIndex === 0) || enter.beatId === beatId) &&
          beat.kind !== "establishing" &&
          beat.kind !== "empty"
        )
          add(
            make("In", {
              targetName: castId,
              positionType: Math.max(1, Math.min(9, Math.round((positions.get(castId)?.slot ?? 0) * 4 + 5))),
              characterWorldPosition: world(castId),
              duration: enter.side === "none" ? 0 : 0.25,
            }),
          );
        if (exit.beatId === beatId || beat.kind === "empty") add(make("Out", { targetName: castId, duration: 0.25 }));
      }
      const shot = object(beat.shot),
        focus = Array.isArray(shot.focus) ? shot.focus.map(String) : [];
      if (!beat.splitFrom && Object.hasOwn(distances, text(shot.type)))
        add(
          make("Focus", {
            targetName: focus.length === 1 ? focus[0]! : "",
            positionType: 5,
            cameraDistance: distances[text(shot.type)]!,
            duration: shot.transition === "cut" ? 0 : 0.35,
          }),
        );
      if (typeof shot.dof === "number") add(make("DoF", { params: [String(shot.dof), "6"], duration: 0.25 }));
      for (const { track, key, time } of keys.filter(
        (item) =>
          (item.time >= (beatIndex === 0 ? -Infinity : start) && item.time < end) ||
          (beatIndex === beats.length - 1 && item.time === end),
      )) {
        const value = object(key.value),
          target = text(object(track.target).castId),
          at = Math.max(0, time - start),
          keyId = text(key.id),
          duration = number(key.duration),
          stable = `track/${text(track.id)}/${keyId}`;
        let command: StoryProjectCommand;
        switch (track.channel) {
          case "motion":
            command = make(
              "Motion",
              { targetName: target, motionName: text(value.name), motionFadeIn: duration },
              stable,
            );
            break;
          case "expression":
            command = make("Expression", { targetName: target, expressionName: text(value.name), duration }, stable);
            break;
          case "costume":
            command = make(
              "Character",
              { targetName: target, live2dKey: text(value.modelId), characterModel: asset("models", value.modelId) },
              stable,
            );
            break;
          case "head":
          case "body": {
            const delta = (positions.get(text(value.target))?.slot ?? 0) - (positions.get(target)?.slot ?? 0);
            const yaw =
              value.mode === "angle"
                ? number(value.yaw)
                : value.target === "camera" || value.target === "auto"
                  ? 0
                  : value.target === "away"
                    ? -Math.sign(delta || 1)
                    : Math.max(-1, Math.min(1, delta));
            command = property(
              target,
              track.channel === "head"
                ? { headAngle: yaw * 30, ...(value.pitch !== undefined ? { headPitch: number(value.pitch) * 30 } : {}) }
                : { bodyAngle: yaw * 10 },
              key,
              stable,
            );
            break;
          }
          case "gaze": {
            const delta = (positions.get(text(value.target))?.slot ?? 0) - (positions.get(target)?.slot ?? 0);
            command = property(
              target,
              value.target
                ? {
                    lookX:
                      value.target === "camera" || value.target === "down"
                        ? 0
                        : value.target === "away"
                          ? -Math.sign(delta || 1)
                          : Math.max(-1, Math.min(1, delta)),
                    lookY: value.target === "down" ? -1 : 0,
                  }
                : { lookX: number(value.x), lookY: number(value.y) },
              key,
              stable,
            );
            break;
          }
          case "position": {
            const point = world(target, number(value.slot), number(value.depth));
            positions.set(target, { slot: number(value.slot), depth: number(value.depth) });
            command = property(target, { worldX: point.x, worldY: point.y, worldZ: point.z }, key, stable);
            break;
          }
          case "opacity":
            command = property(target, { alpha: number(key.value, 1) }, key, stable);
            break;
          case "camera": {
            if (value.manual) {
              const manual = object(value.manual);
              command = property(
                "scene-camera",
                {
                  baseX: number(manual.x),
                  baseY: number(manual.y),
                  zoomRatio: number(manual.zoom, 1),
                  angle: number(manual.roll),
                },
                key,
                stable,
              );
            } else {
              const names = Array.isArray(value.focus) ? value.focus.map(String) : [];
              command = make(
                "Focus",
                {
                  targetName: names.length === 1 ? names[0]! : "",
                  cameraDistance: distances[text(value.shot)] ?? 2,
                  duration,
                },
                stable,
              );
            }
            break;
          }
          case "bgm":
          case "se": {
            const bgm = track.channel === "bgm",
              ref = text(value.assetId),
              audio = ref ? { ...asset("audio", ref), volume: number(value.volume, bgm ? 0.6 : 0.8) } : {};
            command = make(
              bgm ? "Bgm" : "Se",
              {
                [bgm ? "bgmRef" : "seRef"]: ref,
                ...(ref ? { [bgm ? "bgm" : "se"]: audio } : {}),
                params: bgm ? [String(duration), "0", String(duration)] : ["", String(duration), "0"],
              },
              stable,
            );
            break;
          }
          case "background":
            command = make(
              "Stage",
              {
                backgroundRef: value.assetId!,
                background: asset("backgrounds", value.assetId),
                duration: value.transition === "cut" ? 0 : number(value.transitionSeconds, 0.5),
              },
              stable,
            );
            break;
          case "fade": {
            const alpha = number(value.alpha),
              color = value.color === "white" ? "ffffff" : "000000";
            command = make(
              alpha === 0 ? "FadeIn" : "FadeOut",
              {
                params: [
                  `#${color}${Math.round(alpha * 255)
                    .toString(16)
                    .padStart(2, "0")}`,
                  text(key.ease) || "inOutQuad",
                ],
                duration,
              },
              stable,
            );
            break;
          }
          case "fx": {
            const strength = number(value.strength, 1),
              fx = text(value.fx);
            if (fx === "dutch")
              command = property("scene-camera", { angle: number(value.roll) * strength }, key, stable);
            else if (fx === "vignette_anxiety")
              command = property(
                `volume:${sceneId}/${track.id}`,
                { "Vignette.intensity": 0.5 * strength, "Vignette.smoothness": 0.65 },
                key,
                stable,
              );
            else if (fx === "memory_glow")
              command = property(
                `volume:${sceneId}/${track.id}`,
                { "Bloom.intensity": 0.6 * strength, "Bloom.threshold": 0.8 },
                key,
                stable,
              );
            else if (fx === "dim")
              command = property(
                `volume:${sceneId}/${track.id}`,
                { "ColorAdjustments.postExposure": -strength },
                key,
                stable,
              );
            else if (fx === "flash") command = make("Flash", { duration }, stable);
            else if (fx === "shake") command = make("Shake", { params: [String(strength)], duration }, stable);
            else throw new TypeError(`Unsupported OpeNotes effect: ${fx}`);
            break;
          }
          default:
            throw new TypeError(`Unsupported OpeNotes channel: ${track.channel}`);
        }
        add(command, at);
      }
      const hasText = ["dialogue", "narration", "action"].includes(text(beat.kind)) && Boolean(text(beat.text));
      add({
        id: `${sceneId}/beat/${beatId}/visibility`,
        command: VEGA_SYSTEM_OPCODE.SetDialogueVisibility,
        fields: { enabled: hasText },
        extensions: {},
      });
      if (hasText) {
        const speakers = [beat.speakerId, ...(Array.isArray(beat.coSpeakers) ? beat.coSpeakers : [])].filter(
          (value): value is string => typeof value === "string" && Boolean(value),
        );
        const voiceName = (name: string) =>
          locale === "ja"
            ? `${name}の声`
            : locale === "ko"
              ? `${name}의 목소리`
              : locale === "en"
                ? `${name}'s voice`
                : locale === "zh-TW"
                  ? `${name}的聲音`
                  : `${name}的声音`;
        const content = beat.variant === "monologue" ? `（${text(beat.text)}）` : text(beat.text);
        const dialogue = make(
          "Talk",
          {
            text: { [locale]: content },
            targetName: speakers.join("・"),
            targetTextNames: speakers.map((key) => ({
              [locale]:
                beat.variant === "offscreen"
                  ? voiceName(text(cast.get(key)?.displayName))
                  : text(cast.get(key)?.displayName),
            })),
            targets: speakers.map((target) => ({ target })),
            lipSyncTargets: speakers,
          },
          `beat/${beatId}/dialogue`,
        );
        add(dialogue, 0, "lifetime");
      } else add(make("Delay", { duration: durationOf(beat) }, `beat/${beatId}/hold`), 0, "lifetime");
      commands.push({
        id: `${sceneId}/beat/${beatId}`,
        command: ADV_COMMAND.CommandGroup,
        fields: {
          commandGroup: {
            version: 1,
            durationSeconds: durationOf(beat),
            waitForPrevious: true,
            cancelOnManualAdvance: true,
            actions,
          },
        },
        extensions: {
          [OPENOTES_SOURCE]: { sceneId, beatId, beat: cloneStoryValue(beat) },
          "haneoka.authoring.locks": locks(object(beat.meta)),
        },
      });
    }
    commands.push({
      id: `${sceneId}/settle`,
      command: ADV_COMMAND.CommandGroup,
      fields: {
        commandGroup: { waitForPrevious: true, cancelOnManualAdvance: false, durationSeconds: 0, actions: [] },
      },
      extensions: {},
    });
    if (sourceScenes[sceneIndex + 1])
      commands.push({
        id: `${sceneId}/next`,
        command: VEGA_SYSTEM_OPCODE.JumpScene,
        fields: { sceneId: text(sourceScenes[sceneIndex + 1]!.id) },
        extensions: {},
      });
    return {
      id: sceneId,
      name: text(scene.title),
      commands,
      extensions: { [OPENOTES_SOURCE]: { scene: cloneStoryValue(scene) } },
    };
  });
  project.entrySceneId = project.scenes[0]!.id;
  return project;
}
