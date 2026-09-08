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
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const map = mat.map;
  if (!map) return;

  const uvAttr = mesh.geometry.attributes.uv;
  if (!uvAttr) return;

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
 * Extracts K dominant colors from an image using K-Means clustering.
 */
export function quantizePalette(image, k = 5) {
  const canvas = document.createElement('canvas');
  const maxDim = 256;
  const scale = Math.min(1, maxDim / Math.max(image.width, image.height));
  canvas.width = Math.max(1, Math.floor(image.width * scale));
  canvas.height = Math.max(1, Math.floor(image.height * scale));

  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  const samples = [];
  for (let i = 0; i < imgData.length; i += 16) {
    if (imgData[i + 3] > 128) {
      samples.push([imgData[i], imgData[i + 1], imgData[i + 2]]);
    }
  }

  if (samples.length === 0) return [[0, 0, 0], [255, 255, 255]];

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

  rootObject.traverse(child => {
    if (child.isMesh && child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of materials) {
        if (!mat.map) continue;

        if (!mat._originalMap) {
          mat._originalMap = mat.map;
        }

        const origImage = mat._originalMap.image;
        if (!origImage) continue;

        // Force resample wipes cached palette on material
        if (forceResample) {
          mat._quantizedPalette = null;
        }

        // Smart palette resolution
        if (customPalette && customPalette.length > 0) {
          extractedPalette = adjustPaletteSize(customPalette, origImage, numColors);
        } else if (mat._quantizedPalette && !forceResample) {
          extractedPalette = adjustPaletteSize(mat._quantizedPalette, origImage, numColors);
        } else {
          extractedPalette = quantizePalette(origImage, numColors);
        }
        mat._quantizedPalette = extractedPalette;

        if (!enabled) {
          mat.map = mat._originalMap;
          mat._quantizationEnabled = false;
          mat.needsUpdate = true;
          continue;
        }

        const indexLut = createIndexLUT(extractedPalette);

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
        mat._quantizationEnabled = true;
        mat.needsUpdate = true;
      }
    }
  });

  return extractedPalette;
}

function getPrusaMmuHex(extruderId) {
  if (extruderId === 1) return '4';
  if (extruderId === 2) return '8';
  return (extruderId - 3).toString(16).toUpperCase() + 'C';
}

/**
 * Exports a SINGLE WATERTIGHT SOLID 3MF file with native Prusa/Bambu multi-material paint data.
 */
export async function exportMultiColor3MF(
  rootObject,
  numColors = 5,
  isQuantizeEnabled = true,
  targetSizeMm = 150,
  isUvFlipped = false,
  customPalette = null,
  despeckleSize = 0,
  smoothLevel = 0
) {
  rootObject.updateWorldMatrix(true, true);

  let targetMesh = null;
  let mat = null;

  // Search for the mesh and material that actually contains the texture map
  rootObject.traverse(child => {
    if (child.isMesh && child.geometry && !targetMesh) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      const mWithMap = mats.find(m => m && (m._originalMap?.image || m.map?.image));
      if (mWithMap) {
        targetMesh = child;
        mat = mWithMap;
      }
    }
  });

  // Fallback if no textured material was found
  if (!targetMesh) {
    rootObject.traverse(child => {
      if (child.isMesh && child.geometry && !targetMesh) {
        targetMesh = child;
        mat = Array.isArray(child.material) ? child.material[0] : child.material;
      }
    });
  }

  if (!targetMesh) throw new Error('No mesh found to export');
  const image = mat?._originalMap?.image || mat?.map?.image;
  if (!image) throw new Error('Mesh must have a texture map');

  const geo = targetMesh.geometry.clone();
  for (const name of ['position', 'normal', 'uv']) {
    if (geo.attributes[name]) {
      geo.setAttribute(name, toFloat32Attribute(geo.attributes[name]));
    }
  }

  const worldMatrix = targetMesh.matrixWorld.clone();
  geo.applyMatrix4(worldMatrix);

  // 1. ROTATE Y-UP to Z-UP (3D Printer coordinates)
  const pos = geo.attributes.position;
  let minZ = Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const newX = x;
    const newY = -z;
    const newZ = y;
    pos.setXYZ(i, newX, newY, newZ);
    if (newZ < minZ) minZ = newZ;
  }

  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, pos.getZ(i) - minZ);
  }

  // 2. SCALE: Normalize to targetSizeMm
  geo.computeBoundingBox();
  const size = geo.boundingBox.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const scaleRatio = (targetSizeMm || 150.0) / (maxDim || 1);
  geo.scale(scaleRatio, scaleRatio, scaleRatio);
  pos.needsUpdate = true;

  // 3. COLOR PALETTE & CANVAS
  let palette;
  if (customPalette && customPalette.length > 0) {
    palette = customPalette;
  } else if (isQuantizeEnabled && mat._quantizedPalette) {
    palette = mat._quantizedPalette;
  } else {
    palette = quantizePalette(image, numColors);
  }

  // Reuse active canvas if available (already smoothed and despeckled)
  let canvas = mat._quantizedCanvas;
  if (!canvas || !isQuantizeEnabled) {
    const indexLut = createIndexLUT(palette);
    canvas = document.createElement('canvas');
    canvas.width = Math.min(2048, image.width || 2048);
    canvas.height = Math.min(2048, image.height || 2048);
    const W = canvas.width;
    const H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, W, H);
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
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const uvAttr = geo.attributes.uv;
  const index = geo.index;
  const triCount = index ? index.count / 3 : pos.count / 3;

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

  const map = mat.map || mat._originalMap;
  const offset = map?.offset || new THREE.Vector2(0, 0);
  const repeat = map?.repeat || new THREE.Vector2(1, 1);

  const sampleColorAtUv = (rawU, rawV) => {
    let u = rawU * repeat.x + offset.x;
    let v = rawV * repeat.y + offset.y;

    const su = ((u % 1) + 1) % 1;
    const sv = ((v % 1) + 1) % 1;

    const px = Math.min(canvas.width - 1, Math.max(0, Math.floor(su * canvas.width)));
    const py = Math.min(canvas.height - 1, Math.max(0, Math.floor(sv * canvas.height)));
    const off = (py * canvas.width + px) * 4;
    return getClosestColor(imgData[off], imgData[off + 1], imgData[off + 2]);
  };

  // STEP A: SAMPLE COLORS PER TRIANGLE
  const triColors = new Uint8Array(triCount);
  for (let i = 0; i < triCount; i++) {
    const i0 = index ? index.getX(i * 3) : i * 3;
    const i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
    const i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;

    const c0 = sampleColorAtUv(uvAttr.getX(i0), uvAttr.getY(i0));
    const c1 = sampleColorAtUv(uvAttr.getX(i1), uvAttr.getY(i1));
    const c2 = sampleColorAtUv(uvAttr.getX(i2), uvAttr.getY(i2));

    let chosenColor = c0;
    if (c1 === c2) chosenColor = c1;
    else if (c0 === c2) chosenColor = c0;

    triColors[i] = chosenColor;
  }

  // STEP B: WELD DUPLICATE 3D VERTICES ACROSS UV SEAMS (1 micron grid)
  const coordMap = new Map();
  const weldedVertices = [];
  const remap = new Int32Array(pos.count);
  const factor = 1000;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    const ix = Math.round(x * factor);
    const iy = Math.round(y * factor);
    const iz = Math.round(z * factor);
    const key = `${ix}_${iy}_${iz}`;

    if (coordMap.has(key)) {
      remap[i] = coordMap.get(key);
    } else {
      const newIdx = weldedVertices.length;
      coordMap.set(key, newIdx);
      weldedVertices.push([x, y, z]);
      remap[i] = newIdx;
    }
  }

  // STEP C: BUILD 3MF (Sealed, watertight topology)
  let verticesXml = '';
  for (let i = 0; i < weldedVertices.length; i++) {
    const v = weldedVertices[i];
    verticesXml += `<vertex x="${v[0].toFixed(3)}" y="${v[1].toFixed(3)}" z="${v[2].toFixed(3)}" />\n`;
  }

  let trianglesXml = '';
  for (let i = 0; i < triCount; i++) {
    const i0 = index ? index.getX(i * 3) : i * 3;
    const i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
    const i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;

    const v0 = remap[i0];
    const v1 = remap[i1];
    const v2 = remap[i2];

    if (v0 === v1 || v1 === v2 || v0 === v2) continue;

    const colorIdx1Based = triColors[i] + 1;
    const mmuHex = getPrusaMmuHex(colorIdx1Based);

    trianglesXml += `<triangle v1="${v0}" v2="${v1}" v3="${v2}" slic3rpe:mmu_segmentation="${mmuHex}" paint_color="${colorIdx1Based}" pid="1" p1="${triColors[i]}" />\n`;
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
          ${trianglesXml}
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
      const mat = Array.isArray(child.material) ? child.material : [child.material];
      if (mat.map && !textures.has(mat.map)) {
        textures.set(mat.map, {
          slot: 'BaseColor',
          width: mat.map.image?.width || 0,
          height: mat.map.image?.height || 0,
          mimeType: 'image/png'
        });
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
    const scaleFactor = activeTriangles.length / Math.max(1, rawTriCount);
    for (const g of geometry.groups) {
      repairedGeo.addGroup(Math.round(g.start * scaleFactor), Math.round(g.count * scaleFactor), g.materialIndex);
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
  const meshes = [];
  rootObject.traverse(child => {
    if (child.isMesh && child.geometry) meshes.push(child);
  });

  if (meshes.length <= 1) return null;

  rootObject.updateMatrixWorld(true);
  const rootInverse = rootObject.matrixWorld.clone().invert();

  let totalVerts = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const count = g.index ? g.index.count : g.attributes.position.count;
    totalVerts += count;
  }

  const mergedPos = new Float32Array(totalVerts * 3);
  const mergedUvs = new Float32Array(totalVerts * 2);
  const materials = [];
  const groups = [];

  let vertOffset = 0;
  let uvOffset = 0;

  for (const m of meshes) {
    const g = m.geometry;
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    const idx = g.index;
    const triCount = idx ? (idx.count / 3) : (pos.count / 3);

    const worldMatrix = m.matrixWorld.clone().premultiply(rootInverse);

    let matIndex = materials.indexOf(m.material);
    if (matIndex === -1) {
      matIndex = materials.length;
      materials.push(m.material);
    }

    const groupStart = vertOffset / 3;
    const groupCount = triCount * 3;

    const tempV = new THREE.Vector3();
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(t * 3 + k) : (t * 3 + k);
        tempV.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(worldMatrix);

        mergedPos[vertOffset++] = tempV.x;
        mergedPos[vertOffset++] = tempV.y;
        mergedPos[vertOffset++] = tempV.z;

        if (uv) {
          mergedUvs[uvOffset++] = uv.getX(vi);
          mergedUvs[uvOffset++] = uv.getY(vi);
        } else {
          mergedUvs[uvOffset++] = 0;
          mergedUvs[uvOffset++] = 0;
        }
      }
    }

    groups.push({ start: groupStart, count: groupCount, materialIndex: matIndex });
  }

  const combinedGeo = new THREE.BufferGeometry();
  combinedGeo.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
  combinedGeo.setAttribute('uv', new THREE.BufferAttribute(mergedUvs, 2));
  for (const grp of groups) {
    combinedGeo.addGroup(grp.start, grp.count, grp.materialIndex);
  }

  return {
    combinedGeo,
    materials: materials.length === 1 ? materials[0] : materials,
    originalChildren: [...rootObject.children]
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
