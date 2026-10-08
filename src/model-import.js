import { LoadingManager } from 'three';

/** Resolves uploaded sidecar files and waits for all asynchronous loader work. */
export function createResourceManager(files) {
  const manager = new LoadingManager();
  const urls = [];
  const byName = new Map();
  const byNameLower = new Map();
  const resourceNames = new Map();
  const failures = new Set();
  let pending = null;
  let finish = null;

  for (const file of files) {
    const url = URL.createObjectURL(file);
    urls.push(url);
    resourceNames.set(url, file.relativePath || file.name);
    const cleanName = (file.name || '').replace(/\\/g, '/');
    const relativePath = (file.relativePath || cleanName).replace(/\\/g, '/');
    for (const name of [cleanName, relativePath]) {
      const base = name.split('/').pop();
      for (const alias of [name, `./${name}`, base, `./${base}`, `textures/${base}`, `./textures/${base}`]) {
        if (alias) {
          byName.set(alias, url);
          byNameLower.set(alias.toLowerCase(), url);
        }
      }
    }
  }

  manager.setURLModifier(url => {
    // Embedded resources already have their own URL and must remain intact.
    if (/^(data|blob):/i.test(url)) return url;
    let clean = url.split(/[?#]/)[0];
    try { clean = decodeURIComponent(clean); } catch { /* Keep literal percent signs. */ }
    clean = clean.replace(/\\/g, '/');
    const aliases = [clean, clean.replace(/^\.\//u, ''), clean.split('/').pop()];
    for (const alias of aliases) {
      if (byName.has(alias)) return byName.get(alias);
    }
    for (const alias of aliases) {
      if (byNameLower.has(alias.toLowerCase())) return byNameLower.get(alias.toLowerCase());
    }
    return url;
  });

  manager.onStart = () => {
    pending = new Promise(resolve => { finish = resolve; });
  };
  manager.onLoad = () => {
    finish?.();
    pending = null;
    finish = null;
  };
  manager.onError = url => { failures.add(resourceNames.get(url) || url); };

  return {
    manager,
    urls,
    async waitForLoad() {
      // TextureLoader returns a Texture with image=null until the image loads.
      // Looking at texture.image cannot tell whether the loader is still busy.
      while (pending) await pending;
      if (failures.size) {
        throw new Error(`Could not load model resource: ${[...failures].join(', ')}. Include the referenced textures and other files alongside the model, or import a ZIP containing them.`);
      }
    },
  };
}

/** Repairs specific malformed Assimp exports before Three.js parses Collada. */
export function prepareColladaText(text) {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.getElementsByTagName('parsererror').length || document.documentElement?.localName !== 'COLLADA') {
    throw new Error('Invalid Collada (.dae) XML file.');
  }

  const elementsById = new Map();
  const usedIds = new Set();
  for (const element of document.getElementsByTagName('*')) {
    const id = element.getAttribute('id');
    if (!id) continue;
    usedIds.add(id);
    if (!elementsById.has(id)) elementsById.set(id, element);
  }

  let changed = false;
  const nodeIds = new Set();
  for (const node of document.getElementsByTagName('node')) {
    const id = node.getAttribute('id');
    if (!id) continue; // ColladaLoader generates IDs for unnamed nodes.
    if (nodeIds.has(id)) {
      // Keep the first ID for existing references; only rename duplicates.
      // Names and joint SIDs are independent of IDs and remain authored.
      let suffix = 1;
      while (usedIds.has(`${id}__t2p_${suffix}`)) suffix++;
      const uniqueId = `${id}__t2p_${suffix}`;
      node.setAttribute('id', uniqueId);
      usedIds.add(uniqueId);
      changed = true;
    } else {
      nodeIds.add(id);
    }
  }

  const repairedSources = new Set();
  for (const input of document.getElementsByTagName('input')) {
    if (input.getAttribute('semantic') !== 'INV_BIND_MATRIX') continue;
    const reference = input.getAttribute('source') || '';
    if (!reference.startsWith('#') || repairedSources.has(reference)) continue;
    repairedSources.add(reference);
    const source = elementsById.get(reference.slice(1));
    if (source?.localName !== 'source') continue;
    const accessor = source.getElementsByTagName('accessor')[0];
    if (!accessor || Number(accessor.getAttribute('stride')) !== 16) continue;
    const array = elementsById.get((accessor.getAttribute('source') || '').slice(1));
    if (array?.localName !== 'float_array') continue;
    const values = array.textContent.trim().split(/\s+/).map(Number);
    const offset = Number(accessor.getAttribute('offset') || 0);
    const count = Number(accessor.getAttribute('count'));
    let repaired = false;
    for (let index = offset; index + 16 <= values.length && index < offset + count * 16; index += 16) {
      const matrix = values.slice(index, index + 16);
      // Some Assimp game rips omit the homogeneous 1 from affine inverse
      // bind matrices. A zero last row makes skinning divide by zero.
      const determinant = matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9]) -
        matrix[1] * (matrix[4] * matrix[10] - matrix[6] * matrix[8]) +
        matrix[2] * (matrix[4] * matrix[9] - matrix[5] * matrix[8]);
      if (matrix.every(Number.isFinite) && determinant !== 0 && matrix.slice(12).every(value => value === 0)) {
        values[index + 15] = 1;
        repaired = true;
      }
    }
    if (repaired) {
      array.textContent = values.join(' ');
      changed = true;
    }
  }

  return changed ? new XMLSerializer().serializeToString(document) : text;
}
