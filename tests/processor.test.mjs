import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { strFromU8, unzipSync } from 'fflate';
import {
  applyLiveColorQuantization,
  applyUvFlip,
  exportMultiColor3MF,
  extractGlbImages,
  planTextureWorkingSizes,
  quantizePaletteFromSamples,
  sampleModelSurfaceColors,
} from '../src/processor.js';

test('coverage-aware palette preserves a supported chromatic accent among neutral shades', () => {
  const neutralSamples = Array.from({ length: 9900 }, (_, index) => {
    const value = 48 + (index % 25) * 7;
    return [value, value, value];
  });
  const accent = [220, 25, 35];
  const samples = neutralSamples.concat(Array.from({ length: 100 }, () => accent));

  const palette = quantizePaletteFromSamples(samples, 2);

  assert.ok(palette.some(color => color[0] === color[1] && color[1] === color[2]));
  assert.ok(palette.some(color => color[0] > color[1] * 3 && color[0] > color[2] * 3));
  assert.deepEqual(quantizePaletteFromSamples(samples, 2), palette);
});

test('coverage-aware palette does not promote an isolated accent-colored sample', () => {
  const samples = Array.from({ length: 9999 }, (_, index) => {
    const value = 48 + (index % 25) * 7;
    return [value, value, value];
  });
  samples.push([220, 25, 35]);

  const palette = quantizePaletteFromSamples(samples, 2);

  assert.ok(palette.every(color => color[0] === color[1] && color[1] === color[2]));
});

test('manual palette assignment uses perceptual rather than raw RGB distance', () => {
  const source = new THREE.Color().setRGB(38 / 255, 216 / 255, 11 / 255, THREE.SRGBColorSpace);
  const material = new THREE.MeshBasicMaterial({ color: source });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));
  const palette = [[91, 137, 104], [198, 194, 188]];

  applyLiveColorQuantization(root, 2, true, palette);

  const expected = new THREE.Color().setRGB(
    palette[1][0] / 255, palette[1][1] / 255, palette[1][2] / 255, THREE.SRGBColorSpace
  );
  assert.equal(material.color.getHex(), expected.getHex());
});

test('live quantization supports models made only from solid material colors', () => {
  const sourceHexes = [0x731f1f, 0x777777, 0x000000, 0x96786b, 0x4e4e4e, 0xffffff];
  const root = new THREE.Group();
  for (const hex of sourceHexes) {
    root.add(new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: hex })
    ));
  }

  const palette = applyLiveColorQuantization(
    root, 5, true, [[0, 0, 0], [255, 255, 255]]
  );

  assert.equal(palette.length, 5);
  assert.ok(palette.some(([r, g, b]) => r !== g || g !== b));
  assert.ok(root.children.every(mesh => mesh.material._quantizationEnabled));

  applyLiveColorQuantization(root, 5, false, palette);
  assert.deepEqual(
    root.children.map(mesh => mesh.material.color.getHex()),
    sourceHexes
  );
});

test('surface color sampling composes texture tint and weights by model area', () => {
  const texture = new THREE.DataTexture(
    new Uint8Array([
      255, 0, 0, 255,
      0, 0, 255, 255,
    ]),
    2,
    1,
    THREE.RGBAFormat
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;

  const textured = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x808080, map: texture })
  );
  const solid = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x00ff00 })
  );
  solid.scale.set(2, 2, 2);
  const root = new THREE.Group();
  root.add(textured, solid);

  const samples = sampleModelSurfaceColors(root, {
    maxSamples: 1000,
    minSamplesPerMaterial: 0,
  });
  const greenSamples = samples.filter(([r, g, b]) => r === 0 && g === 255 && b === 0);
  const tintedTextureSamples = samples.filter(([r, g, b]) =>
    (r === 128 && g === 0 && b === 0) || (r === 0 && g === 0 && b === 128)
  );

  assert.equal(samples.length, 1000);
  assert.equal(greenSamples.length, 800);
  assert.equal(tintedTextureSamples.length, 200);

  const flooredSamples = sampleModelSurfaceColors(root, {
    maxSamples: 100,
    minSamplesPerMaterial: 40,
  });
  const greenWeight = flooredSamples
    .filter(([r, g, b]) => r === 0 && g === 255 && b === 0)
    .reduce((sum, sample) => sum + sample.surfaceWeight, 0);
  const tintedWeight = flooredSamples
    .filter(([r, g, b]) => (r === 128 && g === 0 && b === 0) || (r === 0 && g === 0 && b === 128))
    .reduce((sum, sample) => sum + sample.surfaceWeight, 0);
  assert.ok(Math.abs(greenWeight / tintedWeight - 4) < 1e-10);
});

test('live texture quantization bakes the material tint exactly once', () => {
  const originalDocument = globalThis.document;
  const sourcePixels = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 0, 255, 255,
  ]);
  globalThis.document = {
    createElement() {
      const canvas = { width: 0, height: 0, pixels: null };
      canvas.getContext = () => ({
        drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray(sourcePixels) }),
        putImageData: imageData => { canvas.pixels = imageData.data; },
      });
      return canvas;
    },
  };

  try {
    const sourceImage = { width: 2, height: 1 };
    const texture = new THREE.Texture(sourceImage);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    const material = new THREE.MeshBasicMaterial({ color: 0x808080, map: texture });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material));
    const palette = [[128, 0, 0], [0, 0, 128]];

    applyLiveColorQuantization(root, 2, true, palette);

    assert.equal(material.color.getHex(), 0xffffff);
    assert.deepEqual(
      Array.from(material._quantizedCanvas.pixels),
      [128, 0, 0, 255, 0, 0, 128, 255]
    );

    applyLiveColorQuantization(root, 2, false, palette);
    assert.equal(material.color.getHex(), 0x808080);
    assert.equal(material.map, texture);
  } finally {
    globalThis.document = originalDocument;
  }
});

function createQuantizedMaterial(labels, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const value = labels[pixel] ? 255 : 0;
    rgba.set([value, value, value, 255], pixel * 4);
  }
  const canvas = {
    width,
    height,
    getContext() {
      return { getImageData: () => ({ data: rgba }) };
    },
  };
  const texture = new THREE.Texture({ width, height });
  texture.flipY = false;
  const material = new THREE.MeshBasicMaterial({ map: texture });
  material._originalMap = texture;
  material._quantizedCanvas = canvas;
  material._quantizedLabels = labels;
  material._quantizedLabelsWidth = width;
  material._quantizedLabelsHeight = height;
  material._quantizationEnabled = true;
  material._quantizedPalette = [[0, 0, 0], [255, 255, 255]];
  return material;
}

function createQuantizedSquareRoot(labels, width, height) {
  const material = createQuantizedMaterial(labels, width, height);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    1, 1, 0,
    0, 1, 0,
  ], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, material));
  root._quantizedPalette = material._quantizedPalette;
  return root;
}

function assertNoUnmatchedSquareInteriorEdges(modelXml) {
  const { vertices, edgeUses } = inspectPaintMesh(modelXml);
  for (const [key, uses] of edgeUses) {
    if (uses !== 1) continue;
    const [aIndex, bIndex] = key.split('|').map(Number);
    const midpoint = vertices[aIndex].map((value, axis) => (value + vertices[bIndex][axis]) * 0.5);
    const onOuterBoundary = Math.abs(midpoint[0]) < 1e-8 || Math.abs(midpoint[0] - 10) < 1e-8 ||
      Math.abs(midpoint[2]) < 1e-8 || Math.abs(midpoint[2] - 10) < 1e-8;
    assert.ok(onOuterBoundary, `unexpected unmatched interior edge ${key}`);
  }
}

async function exportedModelXml(root, toleranceMm, targetSizeMm = 10) {
  const archive = await exportMultiColor3MF(
    root, 2, true, targetSizeMm, false, root._quantizedPalette, 0, 0, toleranceMm
  );
  return strFromU8(unzipSync(new Uint8Array(archive))['3D/3dmodel.model']);
}

function inspectPaintMesh(modelXml) {
  const vertices = [...modelXml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)]
    .map(match => match.slice(1).map(Number));
  const triangles = [...modelXml.matchAll(
    /<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"[^>]*p1="(\d+)"/g
  )].map(match => {
    const values = match.slice(1).map(Number);
    values[3] += 1;
    return values;
  });
  const areaByColor = new Map();
  const edgeUses = new Map();
  for (const [aIndex, bIndex, cIndex, color] of triangles) {
    const a = vertices[aIndex];
    const b = vertices[bIndex];
    const c = vertices[cIndex];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const area = Math.hypot(...cross) * 0.5;
    areaByColor.set(color, (areaByColor.get(color) || 0) + area);
    for (const edge of [[aIndex, bIndex], [bIndex, cIndex], [cIndex, aIndex]]) {
      const key = edge.slice().sort((left, right) => left - right).join('|');
      edgeUses.set(key, (edgeUses.get(key) || 0) + 1);
    }
  }
  return { vertices, triangles, areaByColor, edgeUses };
}

test('texture working-size planner preserves full source resolution within budget', () => {
  const [size] = planTextureWorkingSizes(
    [{ width: 4096, height: 1024 }],
    { maxPixels: 4096 * 1024, maxDimension: 16384 }
  );
  assert.deepEqual(size, {
    sourceWidth: 4096,
    sourceHeight: 1024,
    width: 4096,
    height: 1024,
    scale: 1,
    downsampled: false,
  });
});

test('texture working-size planner reduces proportionally when over budget', () => {
  const [size] = planTextureWorkingSizes(
    [{ width: 4096, height: 1024 }],
    { maxPixels: 2048 * 512, maxDimension: 16384 }
  );
  assert.equal(size.width, 2048);
  assert.equal(size.height, 512);
  assert.equal(size.scale, 0.5);
  assert.equal(size.downsampled, true);
});

test('texture working-size planner shares its pixel budget across textures', () => {
  const sizes = planTextureWorkingSizes(
    [{ width: 2048, height: 2048 }, { width: 2048, height: 2048 }],
    { maxPixels: 2048 * 2048, maxDimension: 16384 }
  );
  assert.ok(sizes.every(size => size.width === size.height));
  assert.ok(sizes.every(size => size.width < 2048));
  assert.ok(sizes.reduce((sum, size) => sum + size.width * size.height, 0) <= 2048 * 2048 + 4096);
});

test('3MF paint export traces an enclosed texture feature without probe sampling', async () => {
  const width = 4;
  const height = 4;
  const labels = new Uint8Array([
    0, 0, 0, 0,
    0, 1, 1, 0,
    0, 1, 1, 0,
    0, 0, 0, 0,
  ]);
  const root = createQuantizedSquareRoot(labels, width, height);
  const modelXml = await exportedModelXml(root, 0);
  const triangles = [...modelXml.matchAll(/<triangle\b[^>]*p1="(\d+)"/g)];
  assert.ok(triangles.length > 2, 'the two source faces should be subdivided around the feature');
  assert.ok(triangles.some(match => match[1] === '0'));
  assert.ok(triangles.some(match => match[1] === '1'), 'the enclosed second color must survive tracing');

  for (const match of modelXml.matchAll(
    /slic3rpe:mmu_segmentation="([^"]+)" paint_color="([^"]+)"/g
  )) {
    assert.equal(match[2], match[1], 'Bambu/Orca and Prusa paint encodings must match');
    assert.ok(match[1] === '4' || match[1] === '8');
  }

  const { vertices, areaByColor, edgeUses } = inspectPaintMesh(modelXml);
  assert.ok(Math.abs((areaByColor.get(1) || 0) - 75) < 1e-6);
  assert.ok(Math.abs((areaByColor.get(2) || 0) - 25) < 1e-6);
  for (const [key, uses] of edgeUses) {
    if (uses !== 1) continue;
    const [aIndex, bIndex] = key.split('|').map(Number);
    const midpoint = vertices[aIndex].map((value, axis) => (value + vertices[bIndex][axis]) * 0.5);
    const onOuterBoundary = Math.abs(midpoint[0]) < 1e-8 || Math.abs(midpoint[0] - 10) < 1e-8 ||
      Math.abs(midpoint[2]) < 1e-8 || Math.abs(midpoint[2] - 10) < 1e-8;
    assert.ok(onOuterBoundary, `unexpected unmatched interior edge ${key}`);
  }
  assert.equal(root._lastPaintBake.boundaryToleranceMm, 0);
  assert.ok(root._lastPaintBake.tracedBoundarySegments > 0);
});

test('3MF boundary accuracy simplifies stair-stepped contours', async () => {
  const width = 8;
  const height = 8;
  const labels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) labels[y * width + x] = x + y >= width ? 1 : 0;
  }
  const root = createQuantizedSquareRoot(labels, width, height);
  const exactXml = await exportedModelXml(root, 0);
  const exactCount = [...exactXml.matchAll(/<triangle\b/g)].length;
  const simplifiedXml = await exportedModelXml(root, 1);
  const simplifiedCount = [...simplifiedXml.matchAll(/<triangle\b/g)].length;
  assert.ok(simplifiedCount < exactCount, `${simplifiedCount} should be less than ${exactCount}`);
  assert.match(simplifiedXml, /paint_color="4"/);
  assert.match(simplifiedXml, /paint_color="8"/);
  assert.equal(root._lastPaintBake.boundaryToleranceMm, 1);
});

test('3MF boundary simplification falls back when it changes face paint coverage', async () => {
  const width = 64;
  const height = 64;
  const labels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const mortar = y % 8 === 0 || (x + (Math.floor(y / 8) % 2) * 4) % 16 === 0;
      const chipped = ((x * 17 + y * 31) % 29) < 2;
      labels[y * width + x] = mortar !== chipped ? 1 : 0;
    }
  }
  const root = createQuantizedSquareRoot(labels, width, height);
  const exactXml = await exportedModelXml(root, 0);
  const exactAreas = inspectPaintMesh(exactXml).areaByColor;
  const simplifiedXml = await exportedModelXml(root, 0.1);
  const simplifiedAreas = inspectPaintMesh(simplifiedXml).areaByColor;

  assert.ok(root._lastPaintBake.exactFallbackFaces > 0);
  assert.ok(Math.abs((exactAreas.get(1) || 0) - (simplifiedAreas.get(1) || 0)) < 0.5);
  assert.ok(Math.abs((exactAreas.get(2) || 0) - (simplifiedAreas.get(2) || 0)) < 0.5);
});

test('3MF exact tracing handles checkerboard contour junctions without overlaps', async () => {
  const labels = new Uint8Array([
    0, 1, 0, 1,
    1, 0, 1, 0,
    0, 1, 0, 1,
    1, 0, 1, 0,
  ]);
  const root = createQuantizedSquareRoot(labels, 4, 4);
  const modelXml = await exportedModelXml(root, 0);
  const { areaByColor } = inspectPaintMesh(modelXml);
  assert.ok(Math.abs((areaByColor.get(1) || 0) - 50) < 1e-6);
  assert.ok(Math.abs((areaByColor.get(2) || 0) - 50) < 1e-6);
});

test('3MF tracing preserves cleaned regions that touch clamp-to-edge texture boundaries', async () => {
  // This pattern mirrors the kind of thin, edge-connected regions produced
  // by despeckling and smoothing. Treating the clamped UV edge as a repeating
  // seam used to recolor the three light texels in the final row.
  const labels = new Uint8Array([
    1, 0, 0, 1, 0, 0,
    1, 1, 0, 0, 0, 0,
    0, 0, 0, 1, 1, 0,
    1, 0, 0, 1, 0, 0,
    0, 0, 0, 1, 1, 0,
    1, 1, 1, 0, 0, 0,
  ]);
  const root = createQuantizedSquareRoot(labels, 6, 6);
  const modelXml = await exportedModelXml(root, 0);
  const { areaByColor } = inspectPaintMesh(modelXml);
  assert.ok(Math.abs((areaByColor.get(1) || 0) - 575 / 9) < 1e-5);
  assert.ok(Math.abs((areaByColor.get(2) || 0) - 325 / 9) < 1e-5);
  assertNoUnmatchedSquareInteriorEdges(modelXml);
});

test('3MF tracing matches clamp and repeat texture wrap modes outside the unit UV range', async () => {
  const labels = new Uint8Array([1, 0]);
  const makeRoot = wrapS => {
    const root = createQuantizedSquareRoot(labels.slice(), 2, 1);
    root.children[0].geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
      0, 0,
      2, 0,
      2, 1,
      0, 1,
    ], 2));
    root.children[0].material.map.wrapS = wrapS;
    return root;
  };

  const clampedXml = await exportedModelXml(makeRoot(THREE.ClampToEdgeWrapping), 0);
  const repeatedXml = await exportedModelXml(makeRoot(THREE.RepeatWrapping), 0);
  const clampedAreas = inspectPaintMesh(clampedXml).areaByColor;
  const repeatedAreas = inspectPaintMesh(repeatedXml).areaByColor;
  assert.ok(Math.abs((clampedAreas.get(2) || 0) - 25) < 1e-6);
  assert.ok(Math.abs((clampedAreas.get(1) || 0) - 75) < 1e-6);
  assert.ok(Math.abs((repeatedAreas.get(2) || 0) - 50) < 1e-6);
  assert.ok(Math.abs((repeatedAreas.get(1) || 0) - 50) < 1e-6);
});

test('3MF tracing subdivides geometric faces with line-degenerate UVs', async () => {
  const material = createQuantizedMaterial(new Uint8Array([0, 1]), 2, 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0,
    1, 0,
    0, 0,
  ], 2));
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, material));
  root._quantizedPalette = material._quantizedPalette;

  const modelXml = await exportedModelXml(root, 0);
  const { areaByColor } = inspectPaintMesh(modelXml);
  assert.ok(Math.abs((areaByColor.get(1) || 0) - 37.5) < 1e-6);
  assert.ok(Math.abs((areaByColor.get(2) || 0) - 12.5) < 1e-6);
  assert.equal(root._lastPaintBake.degenerateUvTriangles, 1);
});

test('3MF writes the slicer TriangleSelector encoding to both paint attributes', async () => {
  const root = createQuantizedSquareRoot(new Uint8Array([
    0, 1,
    2, 2,
  ]), 2, 2);
  const palette = [[0, 0, 0], [127, 127, 127], [255, 255, 255]];
  root._quantizedPalette = palette;
  root.children[0].material._quantizedPalette = palette;
  const modelXml = await exportedModelXml(root, 0);
  const pairs = [...modelXml.matchAll(
    /slic3rpe:mmu_segmentation="([^"]+)" paint_color="([^"]+)"/g
  )].map(match => match.slice(1));
  assert.ok(pairs.length > 0);
  assert.ok(pairs.every(([prusa, bambu]) => prusa === bambu));
  assert.deepEqual(new Set(pairs.map(([encoding]) => encoding)), new Set(['4', '8', '0C']));
});

test('3MF TriangleSelector encoding uses continuation nibbles above extruder 17', async () => {
  const labels = new Uint8Array([
    0, 16,
    17, 31,
  ]);
  const root = createQuantizedSquareRoot(labels, 2, 2);
  const palette = Array.from({ length: 32 }, (_, index) => [index * 8, index * 8, index * 8]);
  root._quantizedPalette = palette;
  root.children[0].material._quantizedPalette = palette;

  const modelXml = await exportedModelXml(root, 0);
  const encodings = new Set([...modelXml.matchAll(
    /slic3rpe:mmu_segmentation="([^"]+)"/g
  )].map(match => match[1]));
  assert.deepEqual(encodings, new Set(['4', 'EC', '0FC', 'EFC']));
});

test('3MF tracing preserves the shared split sequence across UV seams', async () => {
  const width = 48;
  const height = 48;
  const firstLabels = new Uint8Array(width * height);
  const secondLabels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      firstLabels[y * width + x] = (x + y) % 3 === 0 ? 1 : 0;
      secondLabels[y * width + x] = (x * 2 + y * 3) % 5 < 2 ? 1 : 0;
    }
  }
  const materials = [
    createQuantizedMaterial(firstLabels, width, height),
    createQuantizedMaterial(secondLabels, width, height),
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 1, 1, 0,
    0, 0, 0, 1, 1, 0, 0, 1, 0,
  ], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 1, 1,
    0, 0, 1, 0, 0, 1,
  ], 2));
  geometry.addGroup(0, 3, 0);
  geometry.addGroup(3, 3, 1);
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, materials));
  root._quantizedPalette = materials[0]._quantizedPalette;

  const modelXml = await exportedModelXml(root, 0.1);
  assertNoUnmatchedSquareInteriorEdges(modelXml);
});

test('3MF tracing keeps a closed UV-seamed mesh two-manifold', async () => {
  const labels = new Uint8Array([
    0, 0, 0, 0,
    0, 1, 1, 0,
    0, 1, 1, 0,
    0, 0, 0, 0,
  ]);
  const root = createQuantizedSquareRoot(labels, 4, 4);
  root.children[0].geometry = new THREE.BoxGeometry(1, 1, 1);
  const modelXml = await exportedModelXml(root, 0);
  const { edgeUses } = inspectPaintMesh(modelXml);
  for (const [edge, uses] of edgeUses) {
    assert.equal(uses, 2, `closed-mesh edge ${edge} should have exactly two incident faces`);
  }
});

test('3MF tracing does not collapse sub-millimeter contour triangles during welding', async () => {
  const labels = new Uint8Array([
    0, 0, 0, 0,
    0, 1, 1, 0,
    0, 1, 1, 0,
    0, 0, 0, 0,
  ]);
  const root = createQuantizedSquareRoot(labels, 4, 4);
  const modelXml = await exportedModelXml(root, 0, 0.002);
  const { vertices, areaByColor, edgeUses } = inspectPaintMesh(modelXml);
  assert.ok(Math.abs((areaByColor.get(1) || 0) - 0.000003) < 1e-12);
  assert.ok(Math.abs((areaByColor.get(2) || 0) - 0.000001) < 1e-12);
  for (const [key, uses] of edgeUses) {
    if (uses !== 1) continue;
    const [aIndex, bIndex] = key.split('|').map(Number);
    const midpoint = vertices[aIndex].map((value, axis) => (value + vertices[bIndex][axis]) * 0.5);
    const onOuterBoundary = Math.abs(midpoint[0]) < 1e-10 || Math.abs(midpoint[0] - 0.002) < 1e-10 ||
      Math.abs(midpoint[2]) < 1e-10 || Math.abs(midpoint[2] - 0.002) < 1e-10;
    assert.ok(onOuterBoundary, `unexpected unmatched precision-sensitive edge ${key}`);
  }
});

test('applyUvFlip correctly inverts Y coordinates and restores original on unflip', () => {
  // Simulate Three.js mesh geometry structure
  const uvArray = new Float32Array([
    0.1, 0.2,   // vertex 0: u=0.1, v=0.2
    0.4, 0.7,   // vertex 1: u=0.4, v=0.7
    0.9, 0.0,   // vertex 2: u=0.9, v=0.0
    0.5, 1.0,   // vertex 3: u=0.5, v=1.0
  ]);

  const mockMesh = {
    isMesh: true,
    geometry: {
      attributes: {
        uv: {
          array: uvArray,
          itemSize: 2,
          needsUpdate: false,
        }
      }
    }
  };

  const mockScene = {
    traverse(callback) {
      callback(mockMesh);
    }
  };

  // Flip UVs
  applyUvFlip(mockScene, true);
  assert.equal(mockMesh.geometry.attributes.uv.needsUpdate, true);

  // U values should remain unchanged
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[0] - 0.1) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[2] - 0.4) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[4] - 0.9) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[6] - 0.5) < 1e-5);

  // V values should be 1.0 - V
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[1] - 0.8) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[3] - 0.3) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[5] - 1.0) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[7] - 0.0) < 1e-5);

  // Unflip UVs - should restore exact original values without float drift
  applyUvFlip(mockScene, false);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[1] - 0.2) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[3] - 0.7) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[5] - 0.0) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[7] - 1.0) < 1e-5);
});

test('extractGlbImages returns empty array on invalid or non-GLB buffers', () => {
  assert.deepEqual(extractGlbImages(null), []);
  assert.deepEqual(extractGlbImages(new ArrayBuffer(10)), []);
  assert.deepEqual(extractGlbImages(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).buffer), []);
});

test('extractGlbImages extracts embedded images from valid GLB mock buffer', () => {
  const jsonContent = JSON.stringify({
    asset: { version: '2.0' },
    images: [
      { bufferView: 0, mimeType: 'image/webp' },
      { bufferView: 1, mimeType: 'image/png' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 4 },
      { buffer: 0, byteOffset: 4, byteLength: 4 }
    ],
    buffers: [{ byteLength: 8 }]
  });

  const jsonBytes = new TextEncoder().encode(jsonContent);
  const jsonPadded = (jsonBytes.length + 3) & ~3;
  const binLength = 8;
  const totalLength = 12 + 8 + jsonPadded + 8 + binLength;

  const buffer = new ArrayBuffer(totalLength);
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  // GLB header
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);          // version 2
  dv.setUint32(8, totalLength, true);

  // JSON chunk header
  dv.setUint32(12, jsonPadded, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  u8.set(jsonBytes, 20);
  for (let i = jsonBytes.length; i < jsonPadded; i++) u8[20 + i] = 0x20;

  // BIN chunk header
  const binHeaderOffset = 20 + jsonPadded;
  dv.setUint32(binHeaderOffset, binLength, true);
  dv.setUint32(binHeaderOffset + 4, 0x004e4942, true); // 'BIN\0'

  // BIN data (mock image bytes)
  const binDataOffset = binHeaderOffset + 8;
  u8.set([0x52, 0x49, 0x46, 0x46], binDataOffset);     // RIFF (WebP)
  u8.set([0x89, 0x50, 0x4e, 0x47], binDataOffset + 4); // PNG

  const extracted = extractGlbImages(buffer);
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0].mimeType, 'image/webp');
  assert.equal(extracted[0].byteLength, 4);
  assert.equal(extracted[1].mimeType, 'image/png');
  assert.equal(extracted[1].byteLength, 4);
});

test('extractGlbImages extracts texture from sample_textured.glb fixture', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample_textured.glb');
  if (!existsSync(fixturePath)) return;

  const buf = readFileSync(fixturePath);
  const images = extractGlbImages(buf);
  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, 'image/png');
  assert.ok(images[0].byteLength > 0);
});
