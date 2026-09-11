import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import {
  analyzeFloatingDecals,
  bakeFloatingDecals,
  canonicalizeModel,
  cloneModelForProcessing,
  collectSurfaceComponents,
} from '../src/processor.js';

class TestCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = 'rgb(0,0,0)';
  }

  ensurePixels() {
    const length = this.canvas.width * this.canvas.height * 4;
    if (!this.canvas.pixels || this.canvas.pixels.length !== length) {
      this.canvas.pixels = new Uint8ClampedArray(length);
    }
  }

  drawImage(image, _x, _y, width = image.width, height = image.height) {
    this.ensurePixels();
    const source = image.data || image.pixels;
    if (!source) throw new Error('Test image has no pixels');
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sx = Math.min(image.width - 1, Math.floor(x * image.width / width));
        const sy = Math.min(image.height - 1, Math.floor(y * image.height / height));
        const sourceOffset = (sy * image.width + sx) * 4;
        const targetOffset = (y * this.canvas.width + x) * 4;
        this.canvas.pixels.set(source.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      }
    }
  }

  getImageData() {
    this.ensurePixels();
    return { data: new Uint8ClampedArray(this.canvas.pixels) };
  }

  putImageData(imageData) {
    this.canvas.pixels = new Uint8ClampedArray(imageData.data);
  }

  fillRect() {
    this.ensurePixels();
    const values = this.fillStyle.match(/\d+/g)?.map(Number) || [0, 0, 0];
    for (let i = 0; i < this.canvas.pixels.length; i += 4) {
      this.canvas.pixels[i] = values[0];
      this.canvas.pixels[i + 1] = values[1];
      this.canvas.pixels[i + 2] = values[2];
      this.canvas.pixels[i + 3] = 255;
    }
  }
}

class TestCanvas {
  constructor() {
    this.width = 1;
    this.height = 1;
    this.pixels = null;
    this.context = new TestCanvasContext(this);
  }

  getContext() {
    return this.context;
  }
}

function testTexture({ cutout = false } = {}) {
  const width = 8, height = 8;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = cutout ? 210 : 60;
      pixels[offset + 1] = cutout ? 40 : 110;
      pixels[offset + 2] = cutout ? 30 : 180;
      pixels[offset + 3] = !cutout || (x >= 2 && x <= 5 && y >= 2 && y <= 5) ? 255 : 0;
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  return texture;
}

function solidTexture([red, green, blue, alpha]) {
  const width = 8, height = 8;
  const pixels = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = alpha;
  }
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  return texture;
}

function curvedGridGeometry({ offset = 0, segmentsX = 8, segmentsY = 2 } = {}) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let row = 0; row <= segmentsY; row++) {
    const v = row / segmentsY;
    const y = v - 0.5;
    for (let column = 0; column <= segmentsX; column++) {
      const u = column / segmentsX;
      const x = u * 2 - 1;
      const z = 0.32 * x * x;
      const normal = new THREE.Vector3(-0.64 * x, 0, 1).normalize();
      positions.push(
        x + normal.x * offset,
        y + normal.y * offset,
        z + normal.z * offset
      );
      uvs.push(u, v);
    }
  }
  const rowSize = segmentsX + 1;
  for (let row = 0; row < segmentsY; row++) {
    for (let column = 0; column < segmentsX; column++) {
      const a = row * rowSize + column;
      const b = a + 1;
      const c = a + rowSize;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

const linkFixtureUrl = new URL('../examples/Link_Trophy.zip', import.meta.url);

function loadLinkFixture() {
  const archive = unzipSync(readFileSync(linkFixtureUrl));
  const obj = new TextDecoder().decode(archive['DolLinkwindwaker.obj']);
  const root = new OBJLoader().parse(obj);
  root.traverse(child => {
    if (!child.isMesh) return;
    // Detection only needs to know that this authored surface is textured.
    child.material.map = new THREE.Texture({ width: 1, height: 1 });
  });
  return root;
}

test('canonicalization preserves authored surface boundaries by default', () => {
  const root = new THREE.Group();
  const first = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  const second = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  first.name = 'first';
  second.name = 'second';
  root.add(first, second);
  canonicalizeModel(root);
  const names = root.children.filter(child => child.isMesh).map(child => child.name);
  assert.deepEqual(names, ['first', 'second']);
});

test('generic geometry analysis identifies Link eye and brow sheets without hard-coded names', {
  skip: !existsSync(linkFixtureUrl),
}, () => {
  const root = loadLinkFixture();
  canonicalizeModel(root);
  const analysis = analyzeFloatingDecals(root);
  const automaticallySelected = analysis.candidates
    .filter(candidate => candidate.autoSelected)
    .map(candidate => candidate.label);

  assert.deepEqual(automaticallySelected, ['polygon4', 'polygon9']);
  assert.equal(analysis.candidates.find(candidate => candidate.label === 'polygon2')?.autoSelected, false);
  assert.equal(analysis.candidates.find(candidate => candidate.label.startsWith('polygon5'))?.autoSelected, false);
  assert.equal(analysis.candidates.find(candidate => candidate.label.startsWith('polygon7'))?.autoSelected, false);
});

test('processing clones isolate geometry and materials from the source document', () => {
  const source = new THREE.Group();
  source.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial()));
  canonicalizeModel(source);
  const clone = cloneModelForProcessing(source);
  const sourceMesh = source.children.find(child => child.isMesh);
  const clonedMesh = clone.children.find(child => child.isMesh);

  assert.notEqual(clonedMesh.geometry, sourceMesh.geometry);
  assert.notEqual(clonedMesh.material, sourceMesh.material);
  clonedMesh.geometry.attributes.position.setX(0, 999);
  clonedMesh.material.color.setHex(0xff00ff);
  assert.notEqual(sourceMesh.geometry.attributes.position.getX(0), 999);
  assert.notEqual(sourceMesh.material.color.getHex(), 0xff00ff);
});

test('Link eye and brow sheets bake into the receiver and are physically removed', {
  skip: !existsSync(linkFixtureUrl),
}, async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: name => {
    assert.equal(name, 'canvas');
    return new TestCanvas();
  } };

  try {
    const archive = unzipSync(readFileSync(linkFixtureUrl));
    const root = new OBJLoader().parse(new TextDecoder().decode(archive['DolLinkwindwaker.obj']));
    for (const mesh of root.children.filter(child => child.isMesh)) {
      mesh.material.map = testTexture({ cutout: mesh.material.name === 'mat2' || mesh.material.name === 'mat3' });
    }
    canonicalizeModel(root);
    const analysis = analyzeFloatingDecals(root);
    const selections = analysis.candidates
      .filter(candidate => candidate.autoSelected)
      .map(candidate => ({ sourceId: candidate.id, receiverId: candidate.receiverId, mode: 'auto' }));
    const receiverId = selections[0].receiverId;
    const receiverComponent = collectSurfaceComponents(root)
      .find(component => component.id === receiverId);
    const receiverName = receiverComponent.mesh.name;
    const receiverUvsBefore = Array.from(receiverComponent.mesh.geometry.attributes.uv.array);
    const result = await bakeFloatingDecals(root, selections, { alphaThreshold: 0.5 });
    const remainingNames = root.children.filter(child => child.isMesh).map(child => child.name);
    const receiverAfter = root.children.find(child => child.isMesh && child.name === receiverName);

    assert.equal(result.baked, 2);
    assert.equal(result.removedComponents, 2);
    assert.ok(result.details.every(detail => detail.pixels > 0));
    assert.equal(remainingNames.includes('polygon4'), false);
    assert.equal(remainingNames.includes('polygon9'), false);
    assert.equal(remainingNames.includes('polygon2'), true);
    assert.equal(remainingNames.includes('polygon5'), true);
    assert.equal(remainingNames.includes('polygon7'), true);
    const receiverUvsAfter = Array.from(receiverAfter.geometry.attributes.uv.array);
    assert.notDeepEqual(receiverUvsAfter, receiverUvsBefore);
    assert.equal(receiverAfter.geometry.index, null);
    const materials = Array.isArray(receiverAfter.material)
      ? receiverAfter.material
      : [receiverAfter.material];
    const localizedTextures = materials
      .map(material => material.map)
      .filter(texture => texture?.image instanceof TestCanvas);
    assert.ok(localizedTextures.length > 0);
    assert.ok(localizedTextures.every(texture =>
      Math.max(texture.image.width, texture.image.height) >= 512
    ));
    const paintedWidths = localizedTextures.map(texture => {
      const image = texture.image;
      let minX = image.width, maxX = -1;
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          const offset = (y * image.width + x) * 4;
          if (image.pixels[offset] > 150 && image.pixels[offset + 2] < 100) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
          }
        }
      }
      return maxX >= minX ? maxX - minX + 1 : 0;
    });
    assert.ok(Math.max(...paintedWidths) >= 80,
      `localized decal footprint remained too small: ${paintedWidths.join(', ')}`);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('surface-conforming projection follows each triangle of a curved decal without lateral smearing', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => new TestCanvas() };
  try {
    const receiverMaterial = new THREE.MeshBasicMaterial({ map: testTexture() });
    const decalMaterial = new THREE.MeshBasicMaterial({
      map: testTexture({ cutout: true }),
      transparent: true,
    });
    const receiver = new THREE.Mesh(curvedGridGeometry(), receiverMaterial);
    receiver.name = 'curved receiver';
    const decal = new THREE.Mesh(curvedGridGeometry({ offset: 0.08 }), decalMaterial);
    decal.name = 'curved decal';
    const root = new THREE.Group();
    root.add(receiver, decal);
    canonicalizeModel(root);

    const components = collectSurfaceComponents(root);
    const receiverComponent = components.find(component => component.mesh.name === receiver.name);
    const decalComponent = components.find(component => component.mesh.name === decal.name);
    const result = await bakeFloatingDecals(root, [{
      sourceId: decalComponent.id,
      receiverId: receiverComponent.id,
      mode: 'auto',
    }]);

    assert.equal(result.baked, 1);
    assert.equal(root.children.some(child => child.name === decal.name), false);
    const bakedMaterial = Array.isArray(receiver.material)
      ? receiver.material.find(material => material.map?.image instanceof TestCanvas)
      : receiver.material;
    const image = bakedMaterial.map.image;
    let minX = image.width, maxX = -1, minY = image.height, maxY = -1, painted = 0;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const offset = (y * image.width + x) * 4;
        if (image.pixels[offset] > 150 && image.pixels[offset + 2] < 100) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          painted++;
        }
      }
    }
    assert.ok(painted > 1000);
    assert.ok(minX >= image.width * 0.18, `paint extended too far left: ${minX}`);
    assert.ok(maxX <= image.width * 0.82, `paint extended too far right: ${maxX}`);
    assert.ok(minY >= image.height * 0.18, `paint extended too far up: ${minY}`);
    assert.ok(maxY <= image.height * 0.82, `paint extended too far down: ${maxY}`);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('internal triangle seams remain filled in local and closest projection', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => new TestCanvas() };
  try {
    for (const mode of ['auto', 'closest']) {
      const receiver = new THREE.Mesh(
        curvedGridGeometry(),
        new THREE.MeshBasicMaterial({ map: solidTexture([40, 80, 180, 255]) })
      );
      receiver.name = 'receiver';
      const decal = new THREE.Mesh(
        curvedGridGeometry({ offset: 0.08 }),
        new THREE.MeshBasicMaterial({
          map: solidTexture([220, 40, 20, 128]),
          transparent: true,
        })
      );
      decal.name = 'decal';
      const root = new THREE.Group();
      root.add(receiver, decal);
      canonicalizeModel(root);

      const components = collectSurfaceComponents(root);
      const result = await bakeFloatingDecals(root, [{
        sourceId: components.find(component => component.mesh === decal).id,
        receiverId: components.find(component => component.mesh === receiver).id,
        mode,
      }], { alphaCutout: false });

      assert.equal(result.baked, 1, mode);
      const material = Array.isArray(receiver.material)
        ? receiver.material.find(item => item.map?.image instanceof TestCanvas)
        : receiver.material;
      const image = material.map.image;
      const colors = new Set();
      for (let y = Math.floor(image.height * 0.2); y < Math.ceil(image.height * 0.8); y++) {
        for (let x = Math.floor(image.width * 0.2); x < Math.ceil(image.width * 0.8); x++) {
          const offset = (y * image.width + x) * 4;
          colors.add(`${image.pixels[offset]},${image.pixels[offset + 1]},${image.pixels[offset + 2]}`);
        }
      }
      assert.equal(colors.size, 1,
        `${mode} projection produced seam colors: ${[...colors].join('; ')}`);
    }
  } finally {
    globalThis.document = previousDocument;
  }
});

test('a decal component can be removed from inside a shared mesh without leaving its material behind', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => new TestCanvas() };
  try {
    const receiver = new THREE.PlaneGeometry(2, 2).toNonIndexed();
    // Deliberately make both receiver triangles reuse exactly the same UVs.
    // Painting the original atlas would therefore duplicate the decal.
    for (let corner = 0; corner < 3; corner++) {
      receiver.attributes.uv.setXY(
        3 + corner,
        receiver.attributes.uv.getX(corner),
        receiver.attributes.uv.getY(corner)
      );
    }
    const decal = new THREE.PlaneGeometry(1, 1).toNonIndexed();
    decal.translate(0, 0, 0.1);
    const geometry = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      const a = receiver.attributes[name];
      const b = decal.attributes[name];
      const values = new a.array.constructor(a.array.length + b.array.length);
      values.set(a.array);
      values.set(b.array, a.array.length);
      geometry.setAttribute(name, new THREE.BufferAttribute(values, a.itemSize, a.normalized));
    }
    geometry.addGroup(0, receiver.attributes.position.count, 0);
    geometry.addGroup(receiver.attributes.position.count, decal.attributes.position.count, 1);
    const baseMaterial = new THREE.MeshBasicMaterial({ map: testTexture() });
    const decalMaterial = new THREE.MeshBasicMaterial({ map: testTexture({ cutout: true }) });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, [baseMaterial, decalMaterial]));
    canonicalizeModel(root);

    const analysis = analyzeFloatingDecals(root);
    const candidate = analysis.candidates.find(item => item.autoSelected);
    assert.ok(candidate);
    const result = await bakeFloatingDecals(root, [{
      sourceId: candidate.id,
      receiverId: candidate.receiverId,
      mode: 'sheet-normal',
    }]);
    const mesh = root.children[0];

    assert.equal(result.baked, 1);
    assert.equal(mesh.geometry.attributes.position.count / 3, 2);
    assert.equal(Array.isArray(mesh.material), true);
    assert.equal(mesh.material.length, 2);
    assert.ok(mesh.material.every(material => material !== decalMaterial));
    assert.notEqual(mesh.material[0].map, mesh.material[1].map);
    const bakedUvs = mesh.geometry.attributes.uv;
    const firstTriangleUvs = Array.from({ length: 3 }, (_, corner) => [
      bakedUvs.getX(corner), bakedUvs.getY(corner),
    ]);
    const secondTriangleUvs = Array.from({ length: 3 }, (_, corner) => [
      bakedUvs.getX(3 + corner), bakedUvs.getY(3 + corner),
    ]);
    assert.deepEqual(firstTriangleUvs, secondTriangleUvs);
  } finally {
    globalThis.document = previousDocument;
  }
});
