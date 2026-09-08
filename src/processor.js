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
  rootObject.traverse(child => {
    if (child.isMesh && child.geometry && !targetMesh) targetMesh = child;
  });

  if (!targetMesh) throw new Error('No mesh found to export');

  const mat = Array.isArray(targetMesh.material) ? targetMesh.material[0] : targetMesh.material;
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
          child.material = child.material.clone();
          if (child.material.map) {
            child.material.map = child.material.map.clone();
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