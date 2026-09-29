// src/prusa-paint.js
var PROJECT = "Metadata/PrusaSlicer3_project.json";
var PAINT = "Metadata/Slic3r_facets_annotation.json";
var roles = /* @__PURE__ */ new Set([
  "ModelPart",
  "NegativeVolume",
  "ParameterModifier",
  "SupportEnforcer",
  "SupportBlocker"
]);
var fail = (message) => {
  throw new Error(
    `Unsupported PrusaSlicer 3.0 project: invalid paint project: ${message}`
  );
};
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("expected an object.");
  return value;
}
function list(value) {
  if (!Array.isArray(value)) fail("expected a list.");
  return value;
}
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum)
    fail("invalid resource or triangle index.");
  return value;
}
function json(text, path) {
  if (text === null) fail(`missing ${path}.`);
  try {
    return JSON.parse(text);
  } catch {
    fail(`unreadable ${path}.`);
  }
}
function readPrusaPaint(read) {
  const text = read(PROJECT), annotations = read(PAINT);
  if (text === null && annotations === null) return null;
  const data = record(json(text, PROJECT));
  const objects = /* @__PURE__ */ new Map(), volumes = /* @__PURE__ */ new Set(), instances = /* @__PURE__ */ new Map();
  for (const value of list(data.objects)) {
    const object = record(value), id = String(integer(object.id, 1));
    if (objects.has(id)) fail("duplicate object.");
    const localIds = /* @__PURE__ */ new Set();
    const parts = list(object.volumes).map((value2) => {
      const volume = record(value2), id2 = String(integer(volume.id, 1));
      if (localIds.has(id2) || !roles.has(volume.type))
        fail("duplicate volume or unknown volume role.");
      localIds.add(id2);
      volumes.add(id2);
      return {
        id: id2,
        metadata: { extruder: record(volume.volume_settings ?? {}).extruder },
        role: volume.type
      };
    });
    if (!parts.length) fail("object has no volumes.");
    objects.set(id, {
      metadata: { extruder: record(object.object_settings ?? {}).extruder },
      volumes: [],
      parts
    });
    for (const value2 of list(object.instances ?? [])) {
      const instance = record(value2), index = integer(instance.ord);
      if (instances.has(index) || typeof instance.printable !== "boolean")
        fail("invalid instance metadata.");
      instances.set(index, { id, printable: instance.printable });
    }
  }
  const painting = /* @__PURE__ */ new Map();
  for (const value of annotations === null ? [] : list(json(annotations, PAINT))) {
    const entry = record(value), id = String(integer(entry.id, 1));
    if (!volumes.has(id) || painting.has(id))
      fail("missing or duplicate painted volume.");
    const faces = /* @__PURE__ */ new Map();
    if (entry.mmSegmentationFacets !== void 0) {
      if (![1, 2].includes(entry.mmSegmentationFacetsVersion))
        fail("unsupported newer paint format.");
      for (const value2 of list(entry.mmSegmentationFacets)) {
        const face = record(value2), index = integer(face.triangle);
        if (faces.has(index) || typeof face.dividing !== "string" || !face.dividing.length)
          fail("invalid or duplicate triangle paint.");
        faces.set(index, face.dividing);
      }
    }
    painting.set(id, faces);
  }
  for (const object of objects.values())
    for (const part of object.parts)
      part.paint = painting.get(part.id) ?? /* @__PURE__ */ new Map();
  const palettes = [];
  let flattenedRecipes = false;
  for (const container of Array.isArray(data.config_containers) ? data.config_containers : []) {
    if (!container || typeof container !== "object") continue;
    if (Array.isArray(container.virtual_extruders) && container.virtual_extruders.length)
      flattenedRecipes = true;
    const projectColors = container.configuration?.project_settings?.extruder_colour;
    const filamentColors = container.configuration?.filament_settings?.filament_colour;
    const colors = Array.isArray(projectColors) && projectColors.length ? projectColors : filamentColors;
    if (Array.isArray(colors) && colors.length) palettes.push(colors);
  }
  return { objects, instances, palettes, flattenedRecipes };
}

export {
  readPrusaPaint
};
