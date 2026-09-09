import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';

/**
 * Converts any attribute to Float32BufferAttribute.
 */
function toFloat32Attribute(attr) {
  if (!attr || !attr.array) return attr;
  const count = attr.count;
  const itemSize = attr.itemSize;
  const out = new Float32Array(count * itemSize);

  for (let i = 0; i < count; i++) {
    if (itemSize >= 1) out[i * itemSize] = attr.getX(i);
    if (itemSize >= 2) out[i * itemSize + 1] = attr.getY(i);
    if (itemSize >= 3) out[i * itemSize + 2] = attr.getZ(i);
    if (itemSize >= 4) out[i * itemSize + 3] = attr.getW(i);
  }
  return new THREE.BufferAttribute(out, itemSize, false);
}

/**
 * Inverts vertical UV coordinates (V = 1.0 - V) losslessly across all meshes.
 */
export function applyUvFlip(rootObject, invert = false) {
  if (!rootObject) return;
  rootObject.traverse(child => {
    if (child.isMesh && child.geometry) {
      const geo = child.geometry;
      for (const name of Object.keys(geo.attributes)) {
        if (name === 'uv' || name.startsWith('uv')) {
          const attr = geo.attributes[name];
          if (!attr || !attr.array) continue;

          if (!attr._originalUvArray) {
            attr._originalUvArray = new Float32Array(attr.array);
          }

          const orig = attr._originalUvArray;
          const curr = attr.array;
          const itemSize = attr.itemSize || 2;

          for (let i = 1; i < curr.length; i += itemSize) {
            curr[i] = invert ? (1.0 - orig[i]) : orig[i];
          }

          attr.needsUpdate = true;
        }
      }
    }
  });
}

/**
 * Bakes material texture transforms into UV coordinates.
 */
function bakeUvTransforms(mesh) {
  if (!mesh.geometry || !mesh.material) return;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const uvAttr = mesh.geometry.attributes.uv;
  if (!uvAttr) return;

  const groups = mesh.geometry.groups;
  if (groups && groups.length > 0 && materials.length > 1) {
    const idx = mesh.geometry.index;
    for (const grp of groups) {
      const mat = materials[grp.materialIndex];
      const map = mat?.map;
      if (!map) continue;
      const offset = map.offset || new THREE.Vector2(0, 0);
      const repeat = map.repeat || new THREE.Vector2(1, 1);
      const rotation = map.rotation || 0;
      const center = map.center || new THREE.Vector2(0, 0);
      if (offset.x !== 0 || offset.y !== 0 || repeat.x !== 1 || repeat.y !== 1 || rotation !== 0) {
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        for (let i = grp.start; i < grp.start + grp.count; i++) {
          const vi = idx ? idx.getX(i) : i;
          let u = uvAttr.getX(vi) - center.x;
          let v = uvAttr.getY(vi) - center.y;
          const ru = u * cos - v * sin;
          const rv = u * sin + v * cos;
          uvAttr.setXY(vi, ru * repeat.x + center.x + offset.x, rv * repeat.y + center.y + offset.y);
        }
        uvAttr.needsUpdate = true;
        map.offset.set(0, 0);
        map.repeat.set(1, 1);
        map.rotation = 0;
      }
    }
  } else {
    const mat = materials[0];
    const map = mat?.map;
    if (!map) return;
    const offset = map.offset || new THREE.Vector2(0, 0);
    const repeat = map.repeat || new THREE.Vector2(1, 1);
    const rotation = map.rotation || 0;
    const center = map.center || new THREE.Vector2(0, 0);
    if (offset.x !== 0 || offset.y !== 0 || repeat.x !== 1 || repeat.y !== 1 || rotation !== 0) {
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      for (let i = 0; i < uvAttr.count; i++) {
        let u = uvAttr.getX(i) - center.x;
        let v = uvAttr.getY(i) - center.y;
        const ru = u * cos - v * sin;
        const rv = u * sin + v * cos;
        uvAttr.setXY(i, ru * repeat.x + center.x + offset.x, rv * repeat.y + center.y + offset.y);
      }
      uvAttr.needsUpdate = true;
      map.offset.set(0, 0);
      map.repeat.set(1, 1);
      map.rotation = 0;
    }
  }
}

export function normalizeGeometryForExport(rootObject) {
  if (!rootObject) return;
  rootObject.traverse(child => {
    if (child.isMesh && child.geometry) {
      for (const name of ['position', 'normal', 'uv', 'uv2']) {
        if (child.geometry.attributes[name]) {
          child.geometry.setAttribute(name, toFloat32Attribute(child.geometry.attributes[name]));
        }
      }
      bakeUvTransforms(child);
      const mat = Array.isArray(child.material) ? child.material[0] : child.material;
      if (mat && mat.map && child.geometry.attributes.color) {
        child.geometry.deleteAttribute('color');
      }
    }
  });
}

/**
 * Canonicalizes an imported 3D model into a fixed, unified internal representation:
 * - Bakes all UV texture transforms (offset, repeat, rotation) directly into UV coordinates.
 * - If multiple sub-meshes exist, bakes their world transforms and merges them into a single consolidated Mesh.
 * - Handles single materials or multi-material groups with preserved texture maps and colors.
 * - Ensures attributes are Float32 and vertex normals are computed.
 */
export function canonicalizeModel(rootObject) {
  if (!rootObject) return rootObject;
  rootObject.updateWorldMatrix(true, true);

  const meshes = [];
  rootObject.traverse(child => {
    if (child.isMesh && child.geometry) {
      meshes.push(child);
    }
  });

  if (meshes.length === 0) return rootObject;

  // 1. Bake UV transforms and normalize attributes for every mesh
  for (const m of meshes) {
    const geo = m.geometry;
    for (const name of ['position', 'normal', 'uv', 'uv2']) {
      if (geo.attributes[name]) {
        geo.setAttribute(name, toFloat32Attribute(geo.attributes[name]));
      }
    }
    bakeUvTransforms(m);
    if (!geo.attributes.normal) {
      geo.computeVertexNormals();
    }
  }

  // 2. If already a single mesh, cache original geometry and return
  if (meshes.length === 1) {
    const single = meshes[0];
    if (!single._originalGeometry) {
      single._originalGeometry = single.geometry.clone();
    }
    rootObject._isCanonical = true;
    return rootObject;
  }

  // 3. Multiple sub-meshes: merge into a single consolidated THREE.Mesh
  const rootInverse = rootObject.matrixWorld.clone().invert();

  let totalVerts = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const count = g.index ? g.index.count : g.attributes.position.count;
    totalVerts += count;
  }

  const mergedPos = new Float32Array(totalVerts * 3);
  const mergedNorm = new Float32Array(totalVerts * 3);
  const mergedUvs = new Float32Array(totalVerts * 2);

  const materials = [];
  const groups = [];

  let vertOffset = 0;
  let normOffset = 0;
  let uvOffset = 0;

  const tempV = new THREE.Vector3();
  const tempN = new THREE.Vector3();

  for (const m of meshes) {
    const g = m.geometry;
    const pos = g.attributes.position;
    const norm = g.attributes.normal;
    const uv = g.attributes.uv;
    const idx = g.index;
    const triCount = idx ? (idx.count / 3) : (pos.count / 3);

    const meshWorldMatrix = m.matrixWorld.clone().premultiply(rootInverse);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(meshWorldMatrix);

    const mMaterials = Array.isArray(m.material) ? m.material : [m.material];
    const mGroups = g.groups;

    for (let t = 0; t < triCount; t++) {
      let mat = mMaterials[0];
      if (mGroups && mGroups.length > 0) {
        const vStart = t * 3;
        for (const grp of mGroups) {
          if (vStart >= grp.start && vStart < grp.start + grp.count) {
            mat = mMaterials[grp.materialIndex] || mMaterials[0];
            break;
          }
        }
      }

      let matIdx = materials.indexOf(mat);
      if (matIdx === -1) {
        matIdx = materials.length;
        materials.push(mat);
      }

      const currentGroup = groups.length > 0 ? groups[groups.length - 1] : null;
      if (currentGroup && currentGroup.materialIndex === matIdx) {
        currentGroup.count += 3;
      } else {
        groups.push({ start: vertOffset / 3, count: 3, materialIndex: matIdx });
      }

      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(t * 3 + k) : (t * 3 + k);

        tempV.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(meshWorldMatrix);
        mergedPos[vertOffset++] = tempV.x;
        mergedPos[vertOffset++] = tempV.y;
        mergedPos[vertOffset++] = tempV.z;

        if (norm) {
          tempN.set(norm.getX(vi), norm.getY(vi), norm.getZ(vi)).applyMatrix3(normalMatrix).normalize();
          mergedNorm[normOffset++] = tempN.x;
          mergedNorm[normOffset++] = tempN.y;
          mergedNorm[normOffset++] = tempN.z;
        } else {
          mergedNorm[normOffset++] = 0;
          mergedNorm[normOffset++] = 1;
          mergedNorm[normOffset++] = 0;
        }

        if (uv) {
          mergedUvs[uvOffset++] = uv.getX(vi);
          mergedUvs[uvOffset++] = uv.getY(vi);
        } else {
          mergedUvs[uvOffset++] = 0;
          mergedUvs[uvOffset++] = 0;
        }
      }
    }
  }

  const combinedGeo = new THREE.BufferGeometry();
  combinedGeo.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
  combinedGeo.setAttribute('normal', new THREE.BufferAttribute(mergedNorm, 3));
  combinedGeo.setAttribute('uv', new THREE.BufferAttribute(mergedUvs, 2));

  let finalMaterial;
  if (materials.length <= 1) {
    finalMaterial = materials[0] || new THREE.MeshStandardMaterial({ color: 0xe7e9f2, roughness: 0.65 });
  } else {
    finalMaterial = materials;
    for (const grp of groups) {
      combinedGeo.addGroup(grp.start, grp.count, grp.materialIndex);
    }
  }

  // Configure alpha cutout and depth offset for materials with textures
  const allFinalMats = Array.isArray(finalMaterial) ? finalMaterial : [finalMaterial];
  for (const m of allFinalMats) {
    if (m && (m.map || m.alphaMap)) {
      m.alphaTest = 0.5;
      m.depthWrite = true;
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -1;
      m.side = THREE.DoubleSide;
    }
  }

  combinedGeo.computeBoundingBox();
  combinedGeo.computeBoundingSphere();

  const singleMesh = new THREE.Mesh(combinedGeo, finalMaterial);
  singleMesh.name = 'Unified_Mesh';
  singleMesh._originalGeometry = combinedGeo.clone();

  // Replace children in rootObject with the single canonical mesh
  while (rootObject.children.length > 0) {
    rootObject.remove(rootObject.children[0]);
  }
  rootObject.add(singleMesh);
  rootObject._isCanonical = true;

  return rootObject;
}

/**
 * Extracts K dominant colors from pixel samples using K-Means clustering.
 */
export function quantizePaletteFromSamples(samples, k = 5) {
  if (!samples || samples.length === 0) return [[0, 0, 0], [255, 255, 255]];
  k = Math.max(2, Math.min(k, samples.length));

  const centroids = [samples[Math.floor(Math.random() * samples.length)]];
  while (centroids.length < k) {
    let maxDist = -1;
    let bestSample = samples[0];
    for (const s of samples) {
      let minDist = Infinity;
      for (const c of centroids) {
        const d = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2;
        if (d < minDist) minDist = d;
      }
      if (minDist > maxDist) {
        maxDist = minDist;
        bestSample = s;
      }
    }
    centroids.push(bestSample);
  }

  for (let iter = 0; iter < 6; iter++) {
    const clusters = Array.from({ length: k }, () => []);
    for (const s of samples) {
      let minDist = Infinity;
      let closest = 0;
      for (let j = 0; j < k; j++) {
        const c = centroids[j];
        const d = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2;
        if (d < minDist) {
          minDist = d;
          closest = j;
        }
      }
      clusters[closest].push(s);
    }

    for (let j = 0; j < k; j++) {
      if (clusters[j].length > 0) {
        let r = 0, g = 0, b = 0;
        for (const p of clusters[j]) {
          r += p[0]; g += p[1]; b += p[2];
        }
        centroids[j] = [
          Math.round(r / clusters[j].length),
          Math.round(g / clusters[j].length),
          Math.round(b / clusters[j].length)
        ];
      }
    }
  }

  return centroids;
}

/**
 * Extracts K dominant colors from an image using K-Means clustering.
 */
export function quantizePalette(image, k = 5) {
  const canvas = document.createElement('canvas');
  const maxDim = 256;
  const scale = Math.min(1, maxDim / Math.max(image.width || 256, image.height || 256));
  canvas.width = Math.max(1, Math.floor((image.width || 256) * scale));
  canvas.height = Math.max(1, Math.floor((image.height || 256) * scale));

  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  const samples = [];
  for (let i = 0; i < imgData.length; i += 16) {
    if (imgData[i + 3] > 128) {
      samples.push([imgData[i], imgData[i + 1], imgData[i + 2]]);
    }
  }

  return quantizePaletteFromSamples(samples, k);
}

/**
 * Fast 5-bit RGB Lookup Table that maps RGB -> palette index (0..k-1).
 */
function createIndexLUT(palette) {
  const lut = new Uint8Array(32768);
  for (let r = 0; r < 32; r++) {
    const rVal = (r << 3) | (r >> 2);
    for (let g = 0; g < 32; g++) {
      const gVal = (g << 3) | (g >> 2);
      for (let b = 0; b < 32; b++) {
        const bVal = (b << 3) | (b >> 2);
        let minDist = Infinity;
        let bestIdx = 0;
        for (let k = 0; k < palette.length; k++) {
          const pal = palette[k];
          const dist = (rVal - pal[0]) ** 2 + (gVal - pal[1]) ** 2 + (bVal - pal[2]) ** 2;
          if (dist < minDist) {
            minDist = dist;
            bestIdx = k;
          }
        }
        lut[(r << 10) | (g << 5) | b] = bestIdx;
      }
    }
  }
  return lut;
}

/**
 * BFS Island Filter: removes contiguous color patches smaller than minSize pixels.
 */
function despeckleLabels(labels, width, height, minSize, numColors) {
  if (minSize <= 1) return labels;
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const borderVotes = new Int32Array(numColors);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const startIdx = y * width + x;
      if (visited[startIdx]) continue;

      const color = labels[startIdx];
      visited[startIdx] = 1;
      queue[0] = startIdx;
      let head = 0;
      let tail = 1;
      borderVotes.fill(0);

      while (head < tail) {
        const curr = queue[head++];
        const cx = curr % width;
        const cy = (curr / width) | 0;

        const neighbors = [];
        if (cx > 0) neighbors.push(curr - 1);
        if (cx < width - 1) neighbors.push(curr + 1);
        if (cy > 0) neighbors.push(curr - width);
        if (cy < height - 1) neighbors.push(curr + width);

        for (let n = 0; n < neighbors.length; n++) {
          const nIdx = neighbors[n];
          const nColor = labels[nIdx];
          if (nColor === color) {
            if (!visited[nIdx]) {
              visited[nIdx] = 1;
              queue[tail++] = nIdx;
            }
          } else {
            borderVotes[nColor]++;
          }
        }
      }

      // If island is smaller than minSize, fill with best border neighbor color
      if (tail < minSize) {
        let maxVotes = -1;
        let bestColor = color;
        for (let c = 0; c < numColors; c++) {
          if (borderVotes[c] > maxVotes) {
            maxVotes = borderVotes[c];
            bestColor = c;
          }
        }

        for (let i = 0; i < tail; i++) {
          labels[queue[i]] = bestColor;
        }
      }
    }
  }
  return labels;
}

/**
 * Mode/Majority Filter: smooths jagged boundaries and rounds out features.
 */
function smoothBoundaries(labels, width, height, passes, numColors) {
  if (passes <= 0) return labels;
  let src = labels;
  let dst = new Uint8Array(width * height);
  const votes = new Int32Array(numColors);

  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < height; y++) {
      const yOffset = y * width;
      const yPrev = y > 0 ? (y - 1) * width : yOffset;
      const yNext = y < height - 1 ? (y + 1) * width : yOffset;

      for (let x = 0; x < width; x++) {
        const currIdx = yOffset + x;
        const selfColor = src[currIdx];
        votes.fill(0);

        const xPrev = x > 0 ? x - 1 : x;
        const xNext = x < width - 1 ? x + 1 : x;

        votes[src[yPrev + xPrev]]++;
        votes[src[yPrev + x]]++;
        votes[src[yPrev + xNext]]++;

        votes[src[yOffset + xPrev]]++;
        votes[src[currIdx]] += 2; // Center weight prevents erosion
        votes[src[yOffset + xNext]]++;

        votes[src[yNext + xPrev]]++;
        votes[src[yNext + x]]++;
        votes[src[yNext + xNext]]++;

        let maxVotes = 0;
        let bestColor = selfColor;
        for (let c = 0; c < numColors; c++) {
          if (votes[c] > maxVotes) {
            maxVotes = votes[c];
            bestColor = c;
          }
        }

        dst[currIdx] = bestColor;
      }
    }
    const tmp = src;
    src = dst;
    dst = (p + 1 < passes) ? tmp : dst;
  }
  return src;
}

/**
 * Smartly resizes a palette without resetting user edits:
 * - Trimming keeps existing colors intact.
 * - Expanding keeps existing colors and appends new distinct colors from the image.
 */
function adjustPaletteSize(existingPalette, origImage, targetCount) {
  if (!existingPalette || existingPalette.length === 0) {
    return quantizePalette(origImage, targetCount);
  }

  // Trimming (e.g. 5 -> 4): keep the first 4 intact
  if (existingPalette.length >= targetCount) {
    return existingPalette.slice(0, targetCount);
  }

  // Expanding (e.g. 4 -> 5): keep existing, add new distinct colors
  const fresh = quantizePalette(origImage, targetCount);
  const result = existingPalette.map(c => [...c]);

  for (const f of fresh) {
    if (result.length >= targetCount) break;
    const isDuplicate = result.some(c => {
      return (c[0] - f[0]) ** 2 + (c[1] - f[1]) ** 2 + (c[2] - f[2]) ** 2 < 250;
    });
    if (!isDuplicate) {
      result.push(f);
    }
  }

  for (const f of fresh) {
    if (result.length >= targetCount) break;
    result.push(f);
  }

  return result;
}

/**
 * Applies or removes quantized texture directly on the live model, with despeckle and smoothing.
 * Uses a single unified palette across all textured materials so color assignments are consistent.
 */
export function applyLiveColorQuantization(
  rootObject,
  numColors = 5,
  enabled = true,
  customPalette = null,
  despeckleSize = 0,
  smoothLevel = 0,
  forceResample = false
) {
  if (!rootObject) return [];
  let extractedPalette = [];

  // Collect all materials that have or could have texture maps
  const texturedMaterials = [];
  rootObject.traverse(child => {
    if (child.isMesh && child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of materials) {
        if (!mat) continue;
        if (!mat._originalMap && mat.map) {
          mat._originalMap = mat.map;
        }
        if (mat._originalMap?.image && !texturedMaterials.includes(mat)) {
          texturedMaterials.push(mat);
        }
      }
    }
  });

  if (forceResample) {
    rootObject._quantizedPalette = null;
    for (const mat of texturedMaterials) {
      mat._quantizedPalette = null;
    }
  }

  // 1. Determine a single unified palette across the entire model
  if (customPalette && customPalette.length > 0) {
    const firstImg = texturedMaterials[0]?._originalMap?.image;
    extractedPalette = adjustPaletteSize(customPalette, firstImg, numColors);
  } else if (rootObject._quantizedPalette && !forceResample) {
    const firstImg = texturedMaterials[0]?._originalMap?.image;
    extractedPalette = adjustPaletteSize(rootObject._quantizedPalette, firstImg, numColors);
  } else {
    // Collect pixel samples from all textured materials
    const allSamples = [];
    for (const mat of texturedMaterials) {
      const origImage = mat._originalMap.image;
      const cv = document.createElement('canvas');
      const maxDim = 256;
      const scale = Math.min(1, maxDim / Math.max(origImage.width || 256, origImage.height || 256));
      cv.width = Math.max(1, Math.floor((origImage.width || 256) * scale));
      cv.height = Math.max(1, Math.floor((origImage.height || 256) * scale));
      const cx = cv.getContext('2d');
      cx.drawImage(origImage, 0, 0, cv.width, cv.height);
      const dt = cx.getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 0; i < dt.length; i += 16) {
        if (dt[i + 3] > 128) {
          allSamples.push([dt[i], dt[i + 1], dt[i + 2]]);
        }
      }
    }
    extractedPalette = quantizePaletteFromSamples(allSamples, numColors);
  }

  rootObject._quantizedPalette = extractedPalette;

  // 2. Apply this unified palette to all textured materials
  const indexLut = createIndexLUT(extractedPalette);

  for (const mat of texturedMaterials) {
    mat._quantizedPalette = extractedPalette;

    if (!enabled) {
      mat.map = mat._originalMap;
      mat._quantizationEnabled = false;
      mat.needsUpdate = true;
      continue;
    }

    const origImage = mat._originalMap.image;
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(2048, origImage.width || 2048);
    canvas.height = Math.min(2048, origImage.height || 2048);
    const W = canvas.width;
    const H = canvas.height;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(origImage, 0, 0, W, H);
    const imgData = ctx.getImageData(0, 0, W, H);
    const data = imgData.data;

    let labels = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const lutIdx = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      labels[p] = indexLut[lutIdx];
    }

    if (despeckleSize > 0) {
      labels = despeckleLabels(labels, W, H, despeckleSize, extractedPalette.length);
    }

    if (smoothLevel > 0) {
      labels = smoothBoundaries(labels, W, H, smoothLevel, extractedPalette.length);
    }

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const c = extractedPalette[labels[p]];
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
    }
    ctx.putImageData(imgData, 0, 0);

    const newTexture = new THREE.CanvasTexture(canvas);
    newTexture.colorSpace = THREE.SRGBColorSpace;
    newTexture.flipY = mat._originalMap.flipY;
    newTexture.wrapS = mat._originalMap.wrapS;
    newTexture.wrapT = mat._originalMap.wrapT;
    newTexture.offset.copy(mat._originalMap.offset);
    newTexture.repeat.copy(mat._originalMap.repeat);
    newTexture.rotation = mat._originalMap.rotation;

    mat.map = newTexture;
    mat._quantizedCanvas = canvas;
    // Keep the discrete source of truth as well as the display canvas.  The
    // canvas is filtered by WebGL in the viewport, whereas 3MF paint needs a
    // single, unambiguous palette index for every sample it bakes into a face.
    mat._quantizedLabels = labels;
    mat._quantizedLabelsWidth = W;
    mat._quantizedLabelsHeight = H;
    mat._quantizationEnabled = true;
    mat.needsUpdate = true;
  }

  return extractedPalette;
}

function getPrusaMmuHex(extruderId) {
  if (extruderId === 1) return '4';
  if (extruderId === 2) return '8';
  return (extruderId - 3).toString(16).toUpperCase() + 'C';
}

/**
 * Exports a SINGLE WATERTIGHT SOLID 3MF file with native Prusa/Bambu multi-material paint data.
 * Merges all meshes and maps each triangle to its respective material texture/color.
 */
export async function exportMultiColor3MF(
  rootObject,
  numColors = 5,
  isQuantizeEnabled = true,
  targetSizeMm = 150,
  isUvFlipped = false,
  customPalette = null,
  despeckleSize = 0,
  smoothLevel = 0,
  paintResolutionMm = 0.25
) {
  rootObject.updateWorldMatrix(true, true);

  const meshes = [];
  rootObject.traverse(child => {
    if (child.isMesh && child.geometry) {
      meshes.push(child);
    }
  });

  if (meshes.length === 0) throw new Error('No mesh found to export');

  // 1. Calculate bounding box of the whole model in world space
  const rootBox = new THREE.Box3().setFromObject(rootObject);
  const rootSize = rootBox.getSize(new THREE.Vector3());
  const maxDim = Math.max(rootSize.x, rootSize.y, rootSize.z) || 1.0;
  const scaleRatio = (targetSizeMm || 150.0) / maxDim;

  // In Three.js world space (Y-up), rotated to Z-up, newZ = worldY.
  // minZ is the lowest Y in world coordinates so model rests at Z=0.
  const minZ = rootBox.min.y;

  // 2. COLOR PALETTE: Collect all materials across meshes
  const allMats = [];
  for (const m of meshes) {
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      if (mat && !allMats.includes(mat)) allMats.push(mat);
    }
  }

  let palette = null;
  if (customPalette && customPalette.length > 0) {
    palette = customPalette;
  } else if (isQuantizeEnabled && rootObject._quantizedPalette) {
    palette = rootObject._quantizedPalette;
  } else {
    const matWithPal = allMats.find(m => m._quantizedPalette);
    if (isQuantizeEnabled && matWithPal) {
      palette = matWithPal._quantizedPalette;
    } else {
      const allSamples = [];
      for (const m of allMats) {
        const img = m._originalMap?.image || m.map?.image;
        if (img) {
          const cv = document.createElement('canvas');
          cv.width = Math.min(256, img.width || 256);
          cv.height = Math.min(256, img.height || 256);
          const cx = cv.getContext('2d');
          cx.drawImage(img, 0, 0, cv.width, cv.height);
          const dt = cx.getImageData(0, 0, cv.width, cv.height).data;
          for (let i = 0; i < dt.length; i += 32) {
            if (dt[i + 3] > 128) allSamples.push([dt[i], dt[i + 1], dt[i + 2]]);
          }
        } else if (m.color) {
          allSamples.push([Math.round(m.color.r * 255), Math.round(m.color.g * 255), Math.round(m.color.b * 255)]);
        }
      }
      palette = quantizePaletteFromSamples(allSamples, numColors);
    }
  }

  const indexLut = createIndexLUT(palette);

  const getClosestColor = (r, g, b) => {
    let minDist = Infinity;
    let best = 0;
    for (let c = 0; c < palette.length; c++) {
      const pal = palette[c];
      const d = (r - pal[0]) ** 2 + (g - pal[1]) ** 2 + (b - pal[2]) ** 2;
      if (d < minDist) {
        minDist = d;
        best = c;
      }
    }
    return best;
  };

  // Build a color sampler for each material
  const materialSamplers = new Map();
  for (const m of allMats) {
    const img = m._originalMap?.image || m.map?.image;
    if (img) {
      let canvas = m._quantizedCanvas;
      if (!canvas || !isQuantizeEnabled) {
        canvas = document.createElement('canvas');
        canvas.width = Math.min(2048, img.width || 2048);
        canvas.height = Math.min(2048, img.height || 2048);
        const W = canvas.width;
        const H = canvas.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, W, H);
        const imgData = ctx.getImageData(0, 0, W, H);
        const d = imgData.data;

        let labels = new Uint8Array(W * H);
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
          const idx = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
          labels[p] = indexLut[idx];
        }
        if (despeckleSize > 0) labels = despeckleLabels(labels, W, H, despeckleSize, palette.length);
        if (smoothLevel > 0) labels = smoothBoundaries(labels, W, H, smoothLevel, palette.length);

        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
          const c = palette[labels[p]];
          d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
        }
        ctx.putImageData(imgData, 0, 0);
      }

      const ctx = canvas.getContext('2d');
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const imgData = imageData.data;
      const map = m.map || m._originalMap;
      const offset = map?.offset || new THREE.Vector2(0, 0);
      const repeat = map?.repeat || new THREE.Vector2(1, 1);
      const W = canvas.width;
      const H = canvas.height;

      // Reuse the exact post-despeckle/post-smoothing labels that drive the
      // preview when possible. Falling back to label generation here keeps
      // exports deterministic even when no live preview was requested.
      let labels = null;
      if (isQuantizeEnabled && m._quantizationEnabled &&
        m._quantizedLabelsWidth === W && m._quantizedLabelsHeight === H &&
        m._quantizedLabels?.length === W * H) {
        labels = m._quantizedLabels;
      } else {
        labels = new Uint8Array(W * H);
        for (let i = 0, p = 0; i < imgData.length; i += 4, p++) {
          const lutIdx = ((imgData[i] >> 3) << 10) | ((imgData[i + 1] >> 3) << 5) | (imgData[i + 2] >> 3);
          labels[p] = indexLut[lutIdx];
        }
        if (despeckleSize > 0) labels = despeckleLabels(labels, W, H, despeckleSize, palette.length);
        if (smoothLevel > 0) labels = smoothBoundaries(labels, W, H, smoothLevel, palette.length);
      }

      materialSamplers.set(m, (rawU, rawV) => {
        let u = rawU * repeat.x + offset.x;
        let v = rawV * repeat.y + offset.y;
        const su = ((u % 1) + 1) % 1;
        const sv = ((v % 1) + 1) % 1;
        const px = Math.min(W - 1, Math.max(0, Math.floor(su * W)));
        // Match Three.js WebGL texture coordinate orientation:
        // In Three.js, textures default to flipY = true (v = 1.0 is canvas top row 0, v = 0.0 is bottom row H - 1).
        const finalV = (map?.flipY ?? true) ? (1.0 - sv) : sv;
        const py = Math.min(H - 1, Math.max(0, Math.floor(finalV * H)));
        const off = (py * W + px) * 4;
        const color = labels[py * W + px];
        const alpha = imgData[off + 3];
        return { color, alpha };
      });
    } else if (m.color) {
      const colIdx = getClosestColor(Math.round(m.color.r * 255), Math.round(m.color.g * 255), Math.round(m.color.b * 255));
      materialSamplers.set(m, () => ({ color: colIdx, alpha: 255 }));
    } else {
      materialSamplers.set(m, () => ({ color: 0, alpha: 255 }));
    }
  }

  // 3. COLLECT INITIAL TRIANGLES ACROSS ALL MESHES
  const initialTriangles = [];
  const tempV0 = new THREE.Vector3();
  const tempV1 = new THREE.Vector3();
  const tempV2 = new THREE.Vector3();

  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const uvAttr = geo.attributes.uv;
    const idx = geo.index;
    const triCount = idx ? (idx.count / 3) : (pos.count / 3);
    const wm = mesh.matrixWorld;
    const groups = geo.groups;
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

    for (let t = 0; t < triCount; t++) {
      let mat = meshMaterials[0];
      if (groups && groups.length > 0) {
        const vStart = t * 3;
        for (const g of groups) {
          if (vStart >= g.start && vStart < g.start + g.count) {
            mat = meshMaterials[g.materialIndex] || meshMaterials[0];
            break;
          }
        }
      }

      const sampler = materialSamplers.get(mat) || (() => ({ color: 0, alpha: 255 }));

      const i0 = idx ? idx.getX(t * 3) : (t * 3);
      const i1 = idx ? idx.getX(t * 3 + 1) : (t * 3 + 1);
      const i2 = idx ? idx.getX(t * 3 + 2) : (t * 3 + 2);

      tempV0.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0)).applyMatrix4(wm);
      tempV1.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1)).applyMatrix4(wm);
      tempV2.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2)).applyMatrix4(wm);

      // (x, y, z) -> (x, -z, y), subtract minZ, scale by scaleRatio
      const x0 = tempV0.x * scaleRatio;
      const y0 = -tempV0.z * scaleRatio;
      const z0 = (tempV0.y - minZ) * scaleRatio;

      const x1 = tempV1.x * scaleRatio;
      const y1 = -tempV1.z * scaleRatio;
      const z1 = (tempV1.y - minZ) * scaleRatio;

      const x2 = tempV2.x * scaleRatio;
      const y2 = -tempV2.z * scaleRatio;
      const z2 = (tempV2.y - minZ) * scaleRatio;

      const u0 = uvAttr ? uvAttr.getX(i0) : 0;
      const v0_uv = uvAttr ? uvAttr.getY(i0) : 0;
      const u1 = uvAttr ? uvAttr.getX(i1) : 0;
      const v1_uv = uvAttr ? uvAttr.getY(i1) : 0;
      const u2 = uvAttr ? uvAttr.getX(i2) : 0;
      const v2_uv = uvAttr ? uvAttr.getY(i2) : 0;

      initialTriangles.push({
        p0: [x0, y0, z0],
        p1: [x1, y1, z1],
        p2: [x2, y2, z2],
        u0, v0: v0_uv,
        u1, v1: v1_uv,
        u2, v2: v2_uv,
        sampler
      });
    }
  }

  // 4. ADAPTIVE CONFORMING COLOR-BOUNDARY REFINEMENT
  // Prevents "triangle-only" coloring by subdividing along texture color & decal boundaries
  // while guaranteeing ZERO T-junctions and 100% watertight connectivity.
  function distSq(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
  }

  function getPosKey(x, y, z) {
    return `${Math.round(x * 1000)}_${Math.round(y * 1000)}_${Math.round(z * 1000)}`;
  }

  function getEdgeKey(pA, pB) {
    const kA = getPosKey(pA[0], pA[1], pA[2]);
    const kB = getPosKey(pB[0], pB[1], pB[2]);
    return kA < kB ? `${kA}|${kB}` : `${kB}|${kA}`;
  }

  // A barycentric 4x4 coverage grid catches transitions which happen to miss
  // an edge midpoint. Unlike the old hand-picked probes it is symmetric and
  // is also used to select a representative paint color for the final face.
  const BARY_WEIGHTS = [];
  for (let row = 0; row <= 4; row++) {
    for (let col = 0; col <= 4 - row; col++) {
      BARY_WEIGHTS.push([row / 4, col / 4, (4 - row - col) / 4]);
    }
  }
  BARY_WEIGHTS.push([1 / 3, 1 / 3, 1 / 3]);

  function sampleCoverage(tri) {
    const { u0, v0, u1, v1, u2, v2, sampler } = tri;
    const colors = new Map();
    let opaqueCount = 0;
    let transparentCount = 0;

    for (const [w0, w1, w2] of BARY_WEIGHTS) {
      const s = sampler(w0 * u0 + w1 * u1 + w2 * u2, w0 * v0 + w1 * v1 + w2 * v2);
      if (s.alpha < 128) {
        transparentCount++;
      } else {
        opaqueCount++;
        colors.set(s.color, (colors.get(s.color) || 0) + 1);
      }
    }
    return { colors, opaqueCount, transparentCount };
  }

  function triangleHasVariation(tri) {
    const coverage = sampleCoverage(tri);
    return coverage.colors.size > 1 || (coverage.opaqueCount > 0 && coverage.transparentCount > 0);
  }

  let currentTriangles = initialTriangles;
  // 3MF paint is per-face, so this is the physical sampling resolution of the
  // baked paint mesh. A 0.25 mm default is below a typical 0.4 mm nozzle while
  // keeping the file much smaller than a triangle-per-texture-pixel export.
  const paintStepMm = Math.max(0.1, Math.min(2.0, Number(paintResolutionMm) || 0.25));
  const MIN_SPLIT_EDGE_LEN_SQ = paintStepMm * paintStepMm;
  let largestInitialEdge = paintStepMm;
  for (const tri of initialTriangles) {
    largestInitialEdge = Math.max(
      largestInitialEdge,
      Math.sqrt(distSq(tri.p0, tri.p1)),
      Math.sqrt(distSq(tri.p1, tri.p2)),
      Math.sqrt(distSq(tri.p2, tri.p0))
    );
  }
  // Derive the required depth from the requested print resolution instead of
  // silently capping every model at four midpoint splits.
  const MAX_REFINEMENT_PASSES = Math.min(11, Math.max(1, Math.ceil(Math.log2(largestInitialEdge / paintStepMm))));
  const MAX_OUTPUT_TRIANGLES = 750000;
  let refinementLimited = false;

  for (let pass = 0; pass < MAX_REFINEMENT_PASSES; pass++) {
    const splitEdges = new Set();

    for (let i = 0; i < currentTriangles.length; i++) {
      const tri = currentTriangles[i];
      const e0LenSq = distSq(tri.p0, tri.p1);
      const e1LenSq = distSq(tri.p1, tri.p2);
      const e2LenSq = distSq(tri.p2, tri.p0);
      const maxLenSq = Math.max(e0LenSq, e1LenSq, e2LenSq);

      if (maxLenSq > MIN_SPLIT_EDGE_LEN_SQ && triangleHasVariation(tri)) {
        splitEdges.add(getEdgeKey(tri.p0, tri.p1));
        splitEdges.add(getEdgeKey(tri.p1, tri.p2));
        splitEdges.add(getEdgeKey(tri.p2, tri.p0));
      }
    }

    if (splitEdges.size === 0) {
      break;
    }

    // A pathological UV layout can map a high-detail texture onto a very
    // large area. Keep exports loadable and record that the requested paint
    // resolution could not be reached instead of exhausting browser memory.
    if (currentTriangles.length * 4 > MAX_OUTPUT_TRIANGLES) {
      refinementLimited = true;
      break;
    }

    const midpointCache = new Map();
    function getMidpoint(pA, pB) {
      const ek = getEdgeKey(pA, pB);
      let m = midpointCache.get(ek);
      if (!m) {
        m = [(pA[0] + pB[0]) * 0.5, (pA[1] + pB[1]) * 0.5, (pA[2] + pB[2]) * 0.5];
        midpointCache.set(ek, m);
      }
      return m;
    }

    const nextTriangles = [];

    for (let i = 0; i < currentTriangles.length; i++) {
      const tri = currentTriangles[i];
      const { p0, p1, p2, u0, v0, u1, v1, u2, v2, sampler } = tri;

      const s01 = splitEdges.has(getEdgeKey(p0, p1));
      const s12 = splitEdges.has(getEdgeKey(p1, p2));
      const s20 = splitEdges.has(getEdgeKey(p2, p0));

      const splitCount = (s01 ? 1 : 0) + (s12 ? 1 : 0) + (s20 ? 1 : 0);

      if (splitCount === 0) {
        nextTriangles.push(tri);
      } else if (splitCount === 1) {
        if (s01) {
          const m01 = getMidpoint(p0, p1);
          const um01 = (u0 + u1) * 0.5, vm01 = (v0 + v1) * 0.5;
          nextTriangles.push(
            { p0, p1: m01, p2, u0, v0, u1: um01, v1: vm01, u2, v2, sampler },
            { p0: m01, p1, p2, u0: um01, v0: vm01, u1, v1, u2, v2, sampler }
          );
        } else if (s12) {
          const m12 = getMidpoint(p1, p2);
          const um12 = (u1 + u2) * 0.5, vm12 = (v1 + v2) * 0.5;
          nextTriangles.push(
            { p0, p1, p2: m12, u0, v0, u1, v1, u2: um12, v2: vm12, sampler },
            { p0, p1: m12, p2, u0, v0, u1: um12, v1: vm12, u2, v2, sampler }
          );
        } else {
          const m20 = getMidpoint(p2, p0);
          const um20 = (u2 + u0) * 0.5, vm20 = (v2 + v0) * 0.5;
          nextTriangles.push(
            { p0, p1, p2: m20, u0, v0, u1, v1, u2: um20, v2: vm20, sampler },
            { p0: m20, p1, p2, u0: um20, v0: vm20, u1, v1, u2, v2, sampler }
          );
        }
      } else if (splitCount === 2) {
        if (s01 && s12) {
          const m01 = getMidpoint(p0, p1);
          const um01 = (u0 + u1) * 0.5, vm01 = (v0 + v1) * 0.5;
          const m12 = getMidpoint(p1, p2);
          const um12 = (u1 + u2) * 0.5, vm12 = (v1 + v2) * 0.5;
          nextTriangles.push(
            { p0: m01, p1, p2: m12, u0: um01, v0: vm01, u1, v1, u2: um12, v2: vm12, sampler },
            { p0, p1: m01, p2, u0, v0, u1: um01, v1: vm01, u2, v2, sampler },
            { p0: m01, p1: m12, p2, u0: um01, v0: vm01, u1: um12, v1: vm12, u2, v2, sampler }
          );
        } else if (s12 && s20) {
          const m12 = getMidpoint(p1, p2);
          const um12 = (u1 + u2) * 0.5, vm12 = (v1 + v2) * 0.5;
          const m20 = getMidpoint(p2, p0);
          const um20 = (u2 + u0) * 0.5, vm20 = (v2 + v0) * 0.5;
          nextTriangles.push(
            { p0: m12, p1: p2, p2: m20, u0: um12, v0: vm12, u1, v1, u2: um20, v2: vm20, sampler },
            { p0: p1, p1: m12, p2: p0, u0: u1, v0: v1, u1: um12, v1: vm12, u2: u0, v2: v0, sampler },
            { p0: m12, p1: m20, p2: p0, u0: um12, v0: vm12, u1: um20, v1: vm20, u2: u0, v2: v0, sampler }
          );
        } else {
          const m20 = getMidpoint(p2, p0);
          const um20 = (u2 + u0) * 0.5, vm20 = (v2 + v0) * 0.5;
          const m01 = getMidpoint(p0, p1);
          const um01 = (u0 + u1) * 0.5, vm01 = (v0 + v1) * 0.5;
          nextTriangles.push(
            { p0: m20, p1: p0, p2: m01, u0: um20, v0: vm20, u1: u0, v1: v0, u2: um01, v2: vm01, sampler },
            { p0: p2, p1: m20, p2: p1, u0: u2, v0: v2, u1: um20, v1: vm20, u2: u1, v2: v1, sampler },
            { p0: m20, p1: m01, p2: p1, u0: um20, v0: vm20, u1: um01, v1: vm01, u2: u1, v2: v1, sampler }
          );
        }
      } else {
        // splitCount === 3: Quad-split
        const m01 = getMidpoint(p0, p1);
        const um01 = (u0 + u1) * 0.5, vm01 = (v0 + v1) * 0.5;
        const m12 = getMidpoint(p1, p2);
        const um12 = (u1 + u2) * 0.5, vm12 = (v1 + v2) * 0.5;
        const m20 = getMidpoint(p2, p0);
        const um20 = (u2 + u0) * 0.5, vm20 = (v2 + v0) * 0.5;

        nextTriangles.push(
          { p0, p1: m01, p2: m20, u0, v0, u1: um01, v1: vm01, u2: um20, v2: vm20, sampler },
          { p0: m01, p1, p2: m12, u0: um01, v0: vm01, u1, v1, u2: um12, v2: vm12, sampler },
          { p0: m20, p1: m12, p2, u0: um20, v0: vm20, u1: um12, v1: vm12, u2, v2, sampler },
          { p0: m01, p1: m12, p2: m20, u0: um01, v0: vm01, u1: um12, v1: vm12, u2: um20, v2: vm20, sampler }
        );
      }
    }

    currentTriangles = nextTriangles;
  }

  // 5. WELD VERTICES AND EMIT WATERTIGHT MULTI-MATERIAL 3MF MESH
  const coordMap = new Map();
  const weldedVertices = [];
  const factor = 1000;

  function getOrAddWeldedVertex(x, y, z) {
    const ix = Math.round(x * factor);
    const iy = Math.round(y * factor);
    const iz = Math.round(z * factor);
    const key = `${ix}_${iy}_${iz}`;
    if (coordMap.has(key)) {
      return coordMap.get(key);
    }
    const idx = weldedVertices.length;
    coordMap.set(key, idx);
    weldedVertices.push([x, y, z]);
    return idx;
  }

  let allTrianglesXml = '';
  let emittedTriangleCount = 0;

  function emitTriangle(v0, v1, v2, chosenColor) {
    const colorIdx = Math.max(0, Math.min(palette.length - 1, chosenColor));
    const colorIdx1Based = colorIdx + 1;
    const mmuHex = getPrusaMmuHex(colorIdx1Based);
    allTrianglesXml += `<triangle v1="${v0}" v2="${v1}" v3="${v2}" slic3rpe:mmu_segmentation="${mmuHex}" paint_color="${colorIdx1Based}" pid="1" p1="${colorIdx}" />\n`;
    emittedTriangleCount++;
  }

  for (let i = 0; i < currentTriangles.length; i++) {
    const tri = currentTriangles[i];
    const { p0, p1, p2, u0, v0, u1, v1, u2, v2, sampler } = tri;

    const coverage = sampleCoverage(tri);

    // A fully transparent decal triangle contributes no paint. This only
    // removes the transparent overlay face; the underlying model remains in
    // the export and is never carved by this step.
    if (coverage.opaqueCount === 0) {
      continue;
    }

    let chosenColor = 0;
    let bestCount = -1;
    for (const [color, count] of coverage.colors) {
      if (count > bestCount) {
        chosenColor = color;
        bestCount = count;
      }
    }

    const v0_idx = getOrAddWeldedVertex(p0[0], p0[1], p0[2]);
    const v1_idx = getOrAddWeldedVertex(p1[0], p1[1], p1[2]);
    const v2_idx = getOrAddWeldedVertex(p2[0], p2[1], p2[2]);

    if (v0_idx !== v1_idx && v1_idx !== v2_idx && v0_idx !== v2_idx) {
      emitTriangle(v0_idx, v1_idx, v2_idx, chosenColor);
    }
  }

  rootObject._lastPaintBake = {
    requestedResolutionMm: paintStepMm,
    refinementPasses: MAX_REFINEMENT_PASSES,
    refinementLimited,
    triangleCount: emittedTriangleCount
  };

  let verticesXml = '';
  for (let i = 0; i < weldedVertices.length; i++) {
    const v = weldedVertices[i];
    verticesXml += `<vertex x="${v[0].toFixed(3)}" y="${v[1].toFixed(3)}" z="${v[2].toFixed(3)}" />\n`;
  }

  const toHex = c => c.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  const colorgroupXml = palette.map(p => `<m:color color="#${toHex(p)}FF" />`).join('\n      ');

  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"
  xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
  <resources>
    <m:colorgroup id="1">
      ${colorgroupXml}
    </m:colorgroup>
    <object id="2" type="model" name="Watertight_Multicolor_Model">
      <mesh>
        <vertices>
          ${verticesXml}
        </vertices>
        <triangles>
          ${allTrianglesXml}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="2" />
  </build>
</model>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypesXml),
    '_rels/.rels': strToU8(relsXml),
    '3D/3dmodel.model': strToU8(modelXml)
  }).buffer;
}

/**
 * Exports GLB, respecting active color quantization toggle and custom palette.
 */
export function exportProcessedGlb(model, {
  GLTFExporter = globalThis.GLTFExporter,
} = {}) {
  return new Promise((resolve, reject) => {
    if (!model) return reject(new Error('No model to export'));
    if (!GLTFExporter) return reject(new Error('GLTFExporter is required'));

    const exportScene = model.clone(true);
    exportScene.traverse(child => {
      if (child.isMesh) {
        child.geometry = child.geometry.clone();
        if (child.material) {
          if (Array.isArray(child.material)) {
            // Handle multi-material arrays from game rips
            child.material = child.material.map(mat => {
              const m = mat.clone();
              if (m.map) m.map = m.map.clone();
              return m;
            });
          } else {
            child.material = child.material.clone();
            if (child.material.map) {
              child.material.map = child.material.map.clone();
            }
          }
        }
      }
    });

    normalizeGeometryForExport(exportScene);

    const exporter = new GLTFExporter();
    exporter.parse(
      exportScene,
      result => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error('Export failed'));
      },
      error => reject(error),
      { binary: true, onlyVisible: true, maxTextureSize: 4096 }
    );
  });
}

export function getModelTextures(rootObject) {
  if (!rootObject) return [];
  const textures = new Map();
  rootObject.traverse(child => {
    if (child.isMesh && child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        if (mat && mat.map && !textures.has(mat.map)) {
          textures.set(mat.map, {
            slot: 'BaseColor',
            width: mat.map.image?.width || 0,
            height: mat.map.image?.height || 0,
            mimeType: 'image/png'
          });
        }
      }
    }
  });
  return Array.from(textures.values());
}
export function linkGlbOriginalTextures() { }

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * MESH REPAIR & SEALING ENGINE
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Computes 2D point-in-triangle test using barycentric coordinates.
 */
function pointInTriangle2D(px, py, ax, ay, bx, by, cx, cy) {
  const v0x = cx - ax, v0y = cy - ay;
  const v1x = bx - ax, v1y = by - ay;
  const v2x = px - ax, v2y = py - ay;

  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;

  const denom = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denom) < 1e-14) return false;
  const invDenom = 1.0 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

  return u > 1e-5 && v > 1e-5 && (u + v) < 1.0 - 1e-5;
}

/**
 * Triangulates a closed 3D boundary loop to seal a hole.
 * Uses Newell normal projection & 2D Ear Clipping, with Centroid Fan fallback.
 */
function triangulateBoundaryLoop(loopVertexIndices, weldedPositions, weldedUvs) {
  const len = loopVertexIndices.length;
  if (len < 3) return [];

  // Triangle
  if (len === 3) {
    return [[loopVertexIndices[0], loopVertexIndices[1], loopVertexIndices[2]]];
  }

  // Quad: choose shorter diagonal for better triangle quality
  if (len === 4) {
    const i0 = loopVertexIndices[0];
    const i1 = loopVertexIndices[1];
    const i2 = loopVertexIndices[2];
    const i3 = loopVertexIndices[3];
    const p0 = weldedPositions[i0];
    const p1 = weldedPositions[i1];
    const p2 = weldedPositions[i2];
    const p3 = weldedPositions[i3];

    const diag02 = (p0[0] - p2[0]) ** 2 + (p0[1] - p2[1]) ** 2 + (p0[2] - p2[2]) ** 2;
    const diag13 = (p1[0] - p3[0]) ** 2 + (p1[1] - p3[1]) ** 2 + (p1[2] - p3[2]) ** 2;

    if (diag02 <= diag13) {
      return [[i0, i1, i2], [i0, i2, i3]];
    } else {
      return [[i1, i2, i3], [i1, i3, i0]];
    }
  }

  // General N-gon: Ear clipping with 2D projection
  // Compute Newell's best-fit normal
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < len; i++) {
    const p1 = weldedPositions[loopVertexIndices[i]];
    const p2 = weldedPositions[loopVertexIndices[(i + 1) % len]];
    nx += (p1[1] - p2[1]) * (p1[2] + p2[2]);
    ny += (p1[2] - p2[2]) * (p1[0] + p2[0]);
    nz += (p1[0] - p2[0]) * (p1[1] + p2[1]);
  }

  const normLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const triangles = [];

  if (normLen > 1e-10) {
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);

    // Project to 2D by dropping coordinate of largest normal component
    const pts2D = [];
    for (let i = 0; i < len; i++) {
      const p = weldedPositions[loopVertexIndices[i]];
      if (ax >= ay && ax >= az) {
        pts2D.push({ x: p[1], y: p[2], id: loopVertexIndices[i] });
      } else if (ay >= ax && ay >= az) {
        pts2D.push({ x: p[2], y: p[0], id: loopVertexIndices[i] });
      } else {
        pts2D.push({ x: p[0], y: p[1], id: loopVertexIndices[i] });
      }
    }

    // Signed area in 2D
    let area2 = 0;
    for (let i = 0; i < len; i++) {
      const p1 = pts2D[i];
      const p2 = pts2D[(i + 1) % len];
      area2 += (p1.x * p2.y - p2.x * p1.y);
    }
    const signArea = area2 >= 0 ? 1 : -1;

    // Polygon vertex list for clipping
    const poly = pts2D.map((pt, idx) => ({ ...pt, origIdx: idx }));
    let iterations = 0;
    const maxIterations = len * len;

    while (poly.length > 3 && iterations++ < maxIterations) {
      let earFound = false;
      const n = poly.length;

      for (let i = 0; i < n; i++) {
        const prev = poly[(i - 1 + n) % n];
        const curr = poly[i];
        const next = poly[(i + 1) % n];

        // Check if vertex is convex
        const cp = (curr.x - prev.x) * (next.y - prev.y) - (curr.y - prev.y) * (next.x - prev.x);
        if (cp * signArea <= 1e-10) continue;

        // Check if any other polygon vertex is inside this triangle
        let hasPointInside = false;
        for (let j = 0; j < n; j++) {
          if (j === (i - 1 + n) % n || j === i || j === (i + 1) % n) continue;
          const pt = poly[j];
          if (pointInTriangle2D(pt.x, pt.y, prev.x, prev.y, curr.x, curr.y, next.x, next.y)) {
            hasPointInside = true;
            break;
          }
        }

        if (!hasPointInside) {
          // Ear clipped!
          triangles.push([prev.id, curr.id, next.id]);
          poly.splice(i, 1);
          earFound = true;
          break;
        }
      }

      if (!earFound) {
        // Ear clipping stalled due to non-simple/self-intersecting geometry: break to centroid fan
        break;
      }
    }

    if (poly.length === 3) {
      triangles.push([poly[0].id, poly[1].id, poly[2].id]);
      return triangles;
    }
  }

  // Fallback: Centroid fan triangulation
  let cx = 0, cy = 0, cz = 0;
  let cu = 0, cv = 0;
  let uvCount = 0;

  for (let i = 0; i < len; i++) {
    const p = weldedPositions[loopVertexIndices[i]];
    cx += p[0]; cy += p[1]; cz += p[2];
    if (weldedUvs && weldedUvs[loopVertexIndices[i]]) {
      cu += weldedUvs[loopVertexIndices[i]][0];
      cv += weldedUvs[loopVertexIndices[i]][1];
      uvCount++;
    }
  }
  cx /= len; cy /= len; cz /= len;

  const centroidIdx = weldedPositions.length;
  weldedPositions.push([cx, cy, cz]);
  if (weldedUvs) {
    weldedUvs.push(uvCount > 0 ? [cu / uvCount, cv / uvCount] : [0.5, 0.5]);
  }

  for (let i = 0; i < len; i++) {
    triangles.push([loopVertexIndices[i], loopVertexIndices[(i + 1) % len], centroidIdx]);
  }

  return triangles;
}

/**
 * Repairs, welds, and seals an individual THREE.BufferGeometry.
 */
export function repairBufferGeometry(geometry, options = {}) {
  if (!geometry || !geometry.attributes.position) {
    return { geometry, stats: null };
  }

  const posAttr = geometry.attributes.position;
  const uvAttr = geometry.attributes.uv;
  const indexAttr = geometry.index;
  const numVertices = posAttr.count;

  // Bounding box to compute auto-tolerance if needed
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < numVertices; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1.0;

  const tolerance = options.tolerance > 0 ? options.tolerance : (maxDim * 0.001);
  const closeHoles = options.closeHoles !== false;
  const maxHoleEdges = options.maxHoleEdges || 500;

  // 1. SPATIAL HASHING / BUCKET CLUSTERING FOR VERTEX WELDING
  const cellSize = Math.max(tolerance, 1e-6);
  const invCell = 1.0 / cellSize;
  const grid = new Map();
  const weldedPositions = []; // [ [x, y, z], ... ]
  const weldedUvs = [];       // [ [u, v], ... ]
  const vertexToWelded = new Int32Array(numVertices);

  for (let i = 0; i < numVertices; i++) {
    const px = posAttr.getX(i);
    const py = posAttr.getY(i);
    const pz = posAttr.getZ(i);

    const cx = Math.floor(px * invCell);
    const cy = Math.floor(py * invCell);
    const cz = Math.floor(pz * invCell);

    let matchIdx = -1;
    let minDistSq = tolerance * tolerance;

    // Check 27 neighboring cells
    neighborLoop:
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = `${cx + dx}_${cy + dy}_${cz + dz}`;
          const bucket = grid.get(key);
          if (bucket) {
            for (let b = 0; b < bucket.length; b++) {
              const wIdx = bucket[b];
              const wp = weldedPositions[wIdx];
              const dSq = (px - wp[0]) ** 2 + (py - wp[1]) ** 2 + (pz - wp[2]) ** 2;
              if (dSq <= minDistSq) {
                minDistSq = dSq;
                matchIdx = wIdx;
                break neighborLoop;
              }
            }
          }
        }
      }
    }

    if (matchIdx >= 0) {
      vertexToWelded[i] = matchIdx;
    } else {
      const newIdx = weldedPositions.length;
      weldedPositions.push([px, py, pz]);
      if (uvAttr) {
        weldedUvs.push([uvAttr.getX(i), uvAttr.getY(i)]);
      }
      vertexToWelded[i] = newIdx;

      const key = `${cx}_${cy}_${cz}`;
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(newIdx);
    }
  }

  // Smooth welded vertex coordinates by running centroid
  const vertexSums = new Float64Array(weldedPositions.length * 4);
  for (let i = 0; i < numVertices; i++) {
    const w = vertexToWelded[i];
    const off = w * 4;
    vertexSums[off] += posAttr.getX(i);
    vertexSums[off + 1] += posAttr.getY(i);
    vertexSums[off + 2] += posAttr.getZ(i);
    vertexSums[off + 3] += 1;
  }
  for (let w = 0; w < weldedPositions.length; w++) {
    const off = w * 4;
    const count = vertexSums[off + 3];
    if (count > 0) {
      weldedPositions[w][0] = vertexSums[off] / count;
      weldedPositions[w][1] = vertexSums[off + 1] / count;
      weldedPositions[w][2] = vertexSums[off + 2] / count;
    }
  }

  const weldedVerticesCount = numVertices - weldedPositions.length;

  // 2. EXTRACT TRIANGLES & REMOVE DEGENERATE FACES
  const rawTriCount = indexAttr ? (indexAttr.count / 3) : (numVertices / 3);
  const activeTriangles = []; // Array of [w0, w1, w2, origV0, origV1, origV2]

  for (let t = 0; t < rawTriCount; t++) {
    const i0 = indexAttr ? indexAttr.getX(t * 3) : (t * 3);
    const i1 = indexAttr ? indexAttr.getX(t * 3 + 1) : (t * 3 + 1);
    const i2 = indexAttr ? indexAttr.getX(t * 3 + 2) : (t * 3 + 2);

    const w0 = vertexToWelded[i0];
    const w1 = vertexToWelded[i1];
    const w2 = vertexToWelded[i2];

    // Skip degenerate triangles (collapsed edges)
    if (w0 === w1 || w1 === w2 || w0 === w2) continue;

    // Check triangle area
    const p0 = weldedPositions[w0];
    const p1 = weldedPositions[w1];
    const p2 = weldedPositions[w2];
    const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
    const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const areaSq = cx * cx + cy * cy + cz * cz;
    if (areaSq < 1e-14 * (maxDim * maxDim)) continue; // Sliver / zero-area triangle

    activeTriangles.push([w0, w1, w2, i0, i1, i2]);
  }

  // 3. BUILD TOPOLOGICAL EDGE ADJACENCY & DETECT BOUNDARY EDGES
  // undirected edge -> array of directed half-edges: { from, to, triIdx }
  const undirectedEdgeMap = new Map();

  for (let t = 0; t < activeTriangles.length; t++) {
    const [w0, w1, w2] = activeTriangles[t];
    const edges = [
      [w0, w1],
      [w1, w2],
      [w2, w0]
    ];

    for (const [u, v] of edges) {
      const minU = Math.min(u, v);
      const maxU = Math.max(u, v);
      const edgeKey = `${minU}_${maxU}`;

      let edgeList = undirectedEdgeMap.get(edgeKey);
      if (!edgeList) {
        edgeList = [];
        undirectedEdgeMap.set(edgeKey, edgeList);
      }
      edgeList.push({ from: u, to: v, triIdx: t });
    }
  }

  // An open boundary edge belongs to only 1 triangle face
  // If original triangle traversed u -> v, the hole boundary goes v -> u
  const holeBoundaryMap = new Map(); // fromNode -> array of toNodes
  let openEdgesBefore = 0;

  for (const edgeList of undirectedEdgeMap.values()) {
    if (edgeList.length === 1) {
      openEdgesBefore++;
      const { from, to } = edgeList[0];
      // Hole boundary half-edge is in opposite direction to close the cycle
      const holeFrom = to;
      const holeTo = from;

      let list = holeBoundaryMap.get(holeFrom);
      if (!list) {
        list = [];
        holeBoundaryMap.set(holeFrom, list);
      }
      list.push(holeTo);
    }
  }

  // 4. TRACE HOLE BOUNDARY LOOPS
  const boundaryLoops = [];
  const visitedEdges = new Set();

  for (const [startNode, targets] of holeBoundaryMap.entries()) {
    for (const targetNode of targets) {
      const edgeKey = `${startNode}_${targetNode}`;
      if (visitedEdges.has(edgeKey)) continue;

      const loop = [startNode];
      let curr = targetNode;
      visitedEdges.add(edgeKey);
      let isClosed = false;

      while (curr !== undefined) {
        loop.push(curr);
        if (curr === startNode) {
          isClosed = true;
          loop.pop(); // remove duplicate tail
          break;
        }
        if (loop.length > maxHoleEdges) break;

        const nextTargets = holeBoundaryMap.get(curr);
        if (!nextTargets || nextTargets.length === 0) break;

        let nextNode = undefined;
        for (const cand of nextTargets) {
          const candEdgeKey = `${curr}_${cand}`;
          if (!visitedEdges.has(candEdgeKey)) {
            nextNode = cand;
            visitedEdges.add(candEdgeKey);
            break;
          }
        }
        curr = nextNode;
      }

      if (isClosed && loop.length >= 3) {
        boundaryLoops.push(loop);
      }
    }
  }

  // 5. TRIANGULATE & CLOSE HOLES
  let holesClosed = 0;
  let addedTrianglesCount = 0;
  const holeTriangles = []; // Array of [w0, w1, w2]

  if (closeHoles && boundaryLoops.length > 0) {
    for (const loop of boundaryLoops) {
      const tris = triangulateBoundaryLoop(loop, weldedPositions, weldedUvs);
      if (tris.length > 0) {
        holesClosed++;
        addedTrianglesCount += tris.length;
        for (const t of tris) {
          holeTriangles.push(t);
        }
      }
    }
  }

  // 6. ASSEMBLE NEW BUFFER GEOMETRY WITH SMOOTH ANGLE-WEIGHTED NORMALS
  const totalTriangles = activeTriangles.length + holeTriangles.length;
  const newPositions = new Float32Array(totalTriangles * 9);
  const newNormals = new Float32Array(totalTriangles * 9);
  const newUvs = uvAttr ? new Float32Array(totalTriangles * 6) : null;

  // Build vertex normal accumulators (angle-weighted normals across all welded vertices)
  const normalAccum = new Float64Array(weldedPositions.length * 3);

  const accumulateNormal = (w0, w1, w2) => {
    const p0 = weldedPositions[w0];
    const p1 = weldedPositions[w1];
    const p2 = weldedPositions[w2];

    const v10x = p1[0] - p0[0], v10y = p1[1] - p0[1], v10z = p1[2] - p0[2];
    const v20x = p2[0] - p0[0], v20y = p2[1] - p0[1], v20z = p2[2] - p0[2];
    const v21x = p2[0] - p1[0], v21y = p2[1] - p1[1], v21z = p2[2] - p1[2];

    const fnX = v10y * v20z - v10z * v20y;
    const fnY = v10z * v20x - v10x * v20z;
    const fnZ = v10x * v20y - v10y * v20x;
    const fnLen = Math.sqrt(fnX * fnX + fnY * fnY + fnZ * fnZ);
    if (fnLen < 1e-12) return;

    const unX = fnX / fnLen, unY = fnY / fnLen, unZ = fnZ / fnLen;

    const l10 = Math.sqrt(v10x * v10x + v10y * v10y + v10z * v10z);
    const l20 = Math.sqrt(v20x * v20x + v20y * v20y + v20z * v20z);
    const l21 = Math.sqrt(v21x * v21x + v21y * v21y + v21z * v21z);

    if (l10 > 1e-9 && l20 > 1e-9 && l21 > 1e-9) {
      const dot0 = (v10x * v20x + v10y * v20y + v10z * v20z) / (l10 * l20);
      const dot1 = (-v10x * v21x - v10y * v21y - v10z * v21z) / (l10 * l21);
      const dot2 = (v20x * v21x + v20y * v21y + v20z * v21z) / (l20 * l21);

      const a0 = Math.acos(Math.max(-1, Math.min(1, dot0)));
      const a1 = Math.acos(Math.max(-1, Math.min(1, dot1)));
      const a2 = Math.acos(Math.max(-1, Math.min(1, dot2)));

      normalAccum[w0 * 3] += unX * a0; normalAccum[w0 * 3 + 1] += unY * a0; normalAccum[w0 * 3 + 2] += unZ * a0;
      normalAccum[w1 * 3] += unX * a1; normalAccum[w1 * 3 + 1] += unY * a1; normalAccum[w1 * 3 + 2] += unZ * a1;
      normalAccum[w2 * 3] += unX * a2; normalAccum[w2 * 3 + 1] += unY * a2; normalAccum[w2 * 3 + 2] += unZ * a2;
    }
  };

  for (let t = 0; t < activeTriangles.length; t++) {
    const [w0, w1, w2] = activeTriangles[t];
    accumulateNormal(w0, w1, w2);
  }
  for (let t = 0; t < holeTriangles.length; t++) {
    const [w0, w1, w2] = holeTriangles[t];
    accumulateNormal(w0, w1, w2);
  }

  // Normalize accumulated normal table
  const normalTable = new Float32Array(weldedPositions.length * 3);
  for (let w = 0; w < weldedPositions.length; w++) {
    const nx = normalAccum[w * 3];
    const ny = normalAccum[w * 3 + 1];
    const nz = normalAccum[w * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-12) {
      normalTable[w * 3] = nx / len;
      normalTable[w * 3 + 1] = ny / len;
      normalTable[w * 3 + 2] = nz / len;
    } else {
      normalTable[w * 3 + 1] = 1.0;
    }
  }

  // Populate output buffer arrays
  let vPtr = 0;
  let uvPtr = 0;

  // 6A. Original active triangles (with welded positions, intact original UVs per face)
  for (let t = 0; t < activeTriangles.length; t++) {
    const [w0, w1, w2, orig0, orig1, orig2] = activeTriangles[t];
    const ws = [w0, w1, w2];
    const origs = [orig0, orig1, orig2];

    for (let k = 0; k < 3; k++) {
      const w = ws[k];
      const p = weldedPositions[w];
      newPositions[vPtr] = p[0];
      newPositions[vPtr + 1] = p[1];
      newPositions[vPtr + 2] = p[2];

      newNormals[vPtr] = normalTable[w * 3];
      newNormals[vPtr + 1] = normalTable[w * 3 + 1];
      newNormals[vPtr + 2] = normalTable[w * 3 + 2];
      vPtr += 3;

      if (newUvs) {
        const origIdx = origs[k];
        newUvs[uvPtr++] = uvAttr.getX(origIdx);
        newUvs[uvPtr++] = uvAttr.getY(origIdx);
      }
    }
  }

  // 6B. Hole-capping triangles
  for (let t = 0; t < holeTriangles.length; t++) {
    const [w0, w1, w2] = holeTriangles[t];
    const ws = [w0, w1, w2];

    for (let k = 0; k < 3; k++) {
      const w = ws[k];
      const p = weldedPositions[w];
      newPositions[vPtr] = p[0];
      newPositions[vPtr + 1] = p[1];
      newPositions[vPtr + 2] = p[2];

      newNormals[vPtr] = normalTable[w * 3];
      newNormals[vPtr + 1] = normalTable[w * 3 + 1];
      newNormals[vPtr + 2] = normalTable[w * 3 + 2];
      vPtr += 3;

      if (newUvs) {
        const uv = weldedUvs[w] || [0.5, 0.5];
        newUvs[uvPtr++] = uv[0];
        newUvs[uvPtr++] = uv[1];
      }
    }
  }

  const repairedGeo = new THREE.BufferGeometry();
  repairedGeo.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
  repairedGeo.setAttribute('normal', new THREE.BufferAttribute(newNormals, 3));
  if (newUvs) {
    repairedGeo.setAttribute('uv', new THREE.BufferAttribute(newUvs, 2));
  }

  // Preserve groups if multi-material
  if (geometry.groups && geometry.groups.length > 0) {
    const rawGroups = geometry.groups;
    // Map each active triangle to its material index based on the original vertex index
    const triMatIndices = new Int32Array(activeTriangles.length);
    for (let t = 0; t < activeTriangles.length; t++) {
      const origVertIdx = activeTriangles[t][3]; // orig0
      let mIdx = 0;
      for (const g of rawGroups) {
        if (origVertIdx >= g.start && origVertIdx < g.start + g.count) {
          mIdx = g.materialIndex;
          break;
        }
      }
      triMatIndices[t] = mIdx;
    }

    let curStart = 0;
    let curCount = 0;
    let curMat = -1;

    for (let t = 0; t < activeTriangles.length; t++) {
      const mIdx = triMatIndices[t];
      if (curMat === -1) {
        curMat = mIdx;
        curStart = 0;
        curCount = 3;
      } else if (mIdx === curMat) {
        curCount += 3;
      } else {
        repairedGeo.addGroup(curStart, curCount, curMat);
        curStart = t * 3;
        curCount = 3;
        curMat = mIdx;
      }
    }
    if (curCount > 0) {
      repairedGeo.addGroup(curStart, curCount, curMat);
    }

    if (holeTriangles.length > 0) {
      // Assign hole caps to material 0
      repairedGeo.addGroup(activeTriangles.length * 3, holeTriangles.length * 3, 0);
    }
  }

  repairedGeo.computeBoundingBox();
  repairedGeo.computeBoundingSphere();

  const openEdgesAfter = Math.max(0, openEdgesBefore - (holesClosed * 3));
  const isWatertight = openEdgesAfter === 0 && openEdgesBefore > 0 ? true : (openEdgesBefore === 0);

  return {
    geometry: repairedGeo,
    stats: {
      weldedVertices: weldedVerticesCount,
      holesClosed,
      addedTriangles: addedTrianglesCount,
      openEdgesBefore,
      openEdgesAfter,
      isWatertight,
      totalTriangles
    }
  };
}

/**
 * Merges all mesh children in rootObject into a single unified mesh with combined geometry.
 */
export function mergeDisjointMeshes(rootObject) {
  if (!rootObject) return null;
  const originalChildren = [...rootObject.children];
  canonicalizeModel(rootObject);
  const singleMesh = rootObject.children.find(c => c.isMesh);
  if (!singleMesh) return null;

  return {
    combinedGeo: singleMesh.geometry,
    materials: singleMesh.material,
    originalChildren
  };
}

/**
 * Analyzes health, watertightness, boundary edges, and disjoint parts of a model.
 */
export function analyzeMeshHealth(rootObject, tolerance = 0) {
  if (!rootObject) {
    return {
      isWatertight: false,
      openEdgesCount: 0,
      holesCount: 0,
      submeshCount: 0,
      triangles: 0,
      vertices: 0,
      weldableVertices: 0
    };
  }

  let totalTriangles = 0;
  let totalVertices = 0;
  let submeshCount = 0;
  let openEdgesTotal = 0;
  let holesTotal = 0;
  let weldableTotal = 0;

  rootObject.traverse(child => {
    if (child.isMesh && child.geometry) {
      submeshCount++;
      const geo = child.geometry;
      const pos = geo.attributes.position;
      if (!pos) return;

      const vCount = pos.count;
      totalVertices += vCount;
      const tCount = geo.index ? (geo.index.count / 3) : (vCount / 3);
      totalTriangles += tCount;

      // Quick diagnostic run using repairBufferGeometry in dry-run mode
      const diag = repairBufferGeometry(geo, { tolerance, closeHoles: false });
      if (diag && diag.stats) {
        openEdgesTotal += diag.stats.openEdgesBefore;
        weldableTotal += diag.stats.weldedVertices;
      }
    }
  });

  return {
    isWatertight: openEdgesTotal === 0 && totalTriangles > 0,
    openEdgesCount: openEdgesTotal,
    holesCount: holesTotal,
    submeshCount,
    triangles: totalTriangles,
    vertices: totalVertices,
    weldableVertices: weldableTotal
  };
}

/**
 * Applies live mesh repair across the root model, welding disjoint seams and closing holes.
 */
export function applyLiveMeshRepair(rootObject, {
  enabled = true,
  tolerance = 0,
  closeHoles = true,
  joinSubmeshes = false
} = {}) {
  if (!rootObject) return null;

  if (!enabled) {
    return restoreOriginalMesh(rootObject);
  }

  // If joinSubmeshes is requested and there are multiple meshes, merge them into a single mesh
  const meshCount = [];
  rootObject.traverse(c => { if (c.isMesh && c.geometry) meshCount.push(c); });

  if (joinSubmeshes && meshCount.length > 1 && !rootObject._isMerged) {
    const merged = mergeDisjointMeshes(rootObject);
    if (merged) {
      rootObject._originalChildren = merged.originalChildren;
      while (rootObject.children.length > 0) {
        rootObject.remove(rootObject.children[0]);
      }
      const singleMesh = new THREE.Mesh(merged.combinedGeo, merged.materials);
      singleMesh.name = 'Unified_Repaired_Mesh';
      rootObject.add(singleMesh);
      rootObject._isMerged = true;
    }
  }

  let totalWelded = 0;
  let totalHolesClosed = 0;
  let totalAddedTris = 0;
  let totalOpenBefore = 0;
  let totalOpenAfter = 0;
  let totalTris = 0;

  rootObject.traverse(child => {
    if (child.isMesh && child.geometry) {
      if (!child._originalGeometry) {
        child._originalGeometry = child.geometry.clone();
      }

      const res = repairBufferGeometry(child._originalGeometry, {
        tolerance,
        closeHoles
      });

      if (res && res.geometry) {
        child.geometry = res.geometry;
        if (res.stats) {
          totalWelded += res.stats.weldedVertices;
          totalHolesClosed += res.stats.holesClosed;
          totalAddedTris += res.stats.addedTriangles;
          totalOpenBefore += res.stats.openEdgesBefore;
          totalOpenAfter += res.stats.openEdgesAfter;
          totalTris += res.stats.totalTriangles;
        }
      }
    }
  });

  const isWatertight = totalOpenAfter === 0 && totalTris > 0;

  return {
    weldedVertices: totalWelded,
    holesClosed: totalHolesClosed,
    addedTriangles: totalAddedTris,
    openEdgesBefore: totalOpenBefore,
    openEdgesAfter: totalOpenAfter,
    isWatertight,
    totalTriangles: totalTris,
    isMerged: Boolean(rootObject._isMerged)
  };
}

/**
 * Restores the original unmodified geometry and hierarchy.
 */
export function restoreOriginalMesh(rootObject) {
  if (!rootObject) return null;

  // Restore hierarchy if meshes were joined
  if (rootObject._isMerged && rootObject._originalChildren) {
    while (rootObject.children.length > 0) {
      rootObject.remove(rootObject.children[0]);
    }
    for (const child of rootObject._originalChildren) {
      rootObject.add(child);
    }
    rootObject._isMerged = false;
    rootObject._originalChildren = null;
  }

  let totalTris = 0;
  rootObject.traverse(child => {
    if (child.isMesh && child._originalGeometry) {
      child.geometry = child._originalGeometry.clone();
      child.geometry.computeBoundingBox();
      child.geometry.computeBoundingSphere();
      const count = child.geometry.index ? (child.geometry.index.count / 3) : (child.geometry.attributes.position.count / 3);
      totalTris += count;
    }
  });

  return {
    restored: true,
    totalTriangles: totalTris
  };
}
