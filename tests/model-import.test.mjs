import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResourceManager } from '../src/model-import.js';
import * as THREE from 'three';
import { cloneModelForProcessing, exportProcessedGlb } from '../src/processor.js';
import { Viewer } from '../src/viewer.js';

function cleanup(resources) {
  for (const url of resources.urls) URL.revokeObjectURL(url);
}

test('external texture loads finish before imported colors are inspected', async () => {
  const resources = createResourceManager([]);
  try {
    resources.manager.itemStart('diffuse.png');
    let settled = false;
    const waiting = resources.waitForLoad().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    resources.manager.itemStart('alpha.png');
    resources.manager.itemEnd('diffuse.png');
    await Promise.resolve();
    assert.equal(settled, false);
    resources.manager.itemEnd('alpha.png');
    await waiting;
    assert.equal(settled, true);
  } finally { cleanup(resources); }
});

test('resource loading waits across successive loader batches', async () => {
  const resources = createResourceManager([]);
  resources.manager.itemStart('buffer.bin');
  const waiting = resources.waitForLoad();
  resources.manager.itemEnd('buffer.bin');
  resources.manager.itemStart('diffuse.png');
  let settled = false;
  const complete = waiting.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  resources.manager.itemEnd('diffuse.png');
  await complete;
});

test('already completed or resource-free imports do not wait for another load event', async () => {
  const resources = createResourceManager([]);
  await resources.waitForLoad();
  resources.manager.itemStart('diffuse.png');
  resources.manager.itemEnd('diffuse.png');
  await resources.waitForLoad();
});

test('missing textures report how to supply model sidecar files', async () => {
  const resources = createResourceManager([]);
  resources.manager.itemStart('textures/seraph_diffuse.png');
  const waiting = resources.waitForLoad();
  resources.manager.itemError('textures/seraph_diffuse.png');
  resources.manager.itemEnd('textures/seraph_diffuse.png');
  await assert.rejects(waiting, /seraph_diffuse\.png.*Include the referenced textures.*ZIP/);
});

test('failed uploaded resources report their file names instead of blob URLs', async () => {
  const file = new File(['broken'], 'diffuse.png');
  file.relativePath = 'Seraph/textures/diffuse.png';
  const resources = createResourceManager([file]);
  try {
    const url = resources.manager.resolveURL('diffuse.png');
    resources.manager.itemStart(url);
    resources.manager.itemError(url);
    resources.manager.itemEnd(url);
    await assert.rejects(resources.waitForLoad(), error =>
      error.message.includes(file.relativePath) && !error.message.includes('blob:'));
  } finally { cleanup(resources); }
});

test('ZIP and directly selected textures resolve encoded paths and case differences', () => {
  const file = new File(['texture'], 'Seraph Diffuse.PNG');
  file.relativePath = 'Seraph/Textures/Seraph Diffuse.PNG';
  const resources = createResourceManager([file]);
  try {
    const expected = resources.urls[0];
    for (const request of [
      'Seraph/Textures/Seraph Diffuse.PNG',
      './seraph/textures/seraph%20diffuse.png',
      'textures/Seraph%20Diffuse.png',
      'C:\\old-export\\Seraph Diffuse.png',
      'Seraph Diffuse.PNG?cache=123',
    ]) assert.equal(resources.manager.resolveURL(request), expected, request);
    assert.equal(resources.manager.resolveURL('missing.png'), 'missing.png');
    assert.doesNotThrow(() => resources.manager.resolveURL('100%missing.png'));
    const dataUrl = 'data:image/svg+xml,<svg id="a#b"/>';
    assert.equal(resources.manager.resolveURL(dataUrl), dataUrl);
    assert.equal(resources.manager.resolveURL(expected), expected);
  } finally { cleanup(resources); }
});

function riggedScene() {
  const root = new THREE.Group();
  root.scale.setScalar(0.0254);
  root.rotation.x = -Math.PI / 2;
  root.position.set(5, 3, 2);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 10, 0], 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Array(12).fill(0), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const bone = new THREE.Bone();
  bone.name = 'Joint';
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ color: 0x8866bb }));
  root.add(bone, mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([bone], [new THREE.Matrix4()]), new THREE.Matrix4());
  bone.position.x = 2;
  root.updateMatrixWorld(true);
  return { root, mesh, bone };
}

for (const [name, makeClone] of [
  ['processing', root => cloneModelForProcessing(root)],
  ['export', root => {
    const viewer = Object.create(Viewer.prototype);
    viewer.currentModel = root;
    viewer._materialEffectStates = new WeakMap();
    viewer._envIntensity = 1;
    return viewer.createExportObject();
  }],
]) {
  test(`${name} copies preserve a rigged pose with skeletons bound to their own bones`, () => {
    const { root, mesh, bone } = riggedScene();
    const before = mesh.getVertexPosition(1, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
    const clone = makeClone(root);
    const clonedMesh = clone.children.find(child => child.isSkinnedMesh);
    const clonedBone = clone.getObjectByName('Joint');
    assert.notEqual(clonedMesh.skeleton, mesh.skeleton);
    assert.equal(clonedMesh.skeleton.bones[0], clonedBone);
    assert.notEqual(clonedBone, bone);
    const after = clonedMesh.getVertexPosition(1, new THREE.Vector3()).applyMatrix4(clonedMesh.matrixWorld);
    assert(before.distanceTo(after) < 1e-6);
    bone.position.x += 10;
    root.updateMatrixWorld(true);
    clone.updateMatrixWorld(true);
    const isolated = clonedMesh.getVertexPosition(1, new THREE.Vector3()).applyMatrix4(clonedMesh.matrixWorld);
    assert(after.distanceTo(isolated) < 1e-6);
  });
}

test('camera framing initializes unit-scaled skinning before bounds and source copies', () => {
  const { root, mesh } = riggedScene();
  // Mimic an importer that applies root units after binding a mesh.
  root.scale.setScalar(0.1);
  const viewer = Object.create(Viewer.prototype);
  viewer.camera = new THREE.PerspectiveCamera(45, 1.5, 0.1, 1000);
  viewer.controls = { target: new THREE.Vector3(), update() {} };
  viewer._frame(root);
  const box = new THREE.Box3().setFromObject(root);
  assert(box.getCenter(new THREE.Vector3()).length() < 1e-6);
  assert(Math.abs(Math.max(...box.getSize(new THREE.Vector3()).toArray()) - 1) < 1e-6);
  const expectedInverse = mesh.matrixWorld.clone().invert();
  assert.deepEqual(mesh.bindMatrixInverse.elements, expectedInverse.elements);
});

test('GLB encoding receives a scene whose skin joints are part of that same scene', async () => {
  const { root, mesh } = riggedScene();
  const originalVertex = mesh.getVertexPosition(1, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
  class InspectingExporter {
    parse(scene, onSuccess) {
      const nodes = new Set();
      scene.traverse(node => nodes.add(node));
      scene.traverse(node => {
        if (!node.isSkinnedMesh) return;
        assert.notEqual(node.skeleton, mesh.skeleton);
        assert(node.skeleton.bones.every(bone => nodes.has(bone)));
        const vertex = node.getVertexPosition(1, new THREE.Vector3()).applyMatrix4(node.matrixWorld);
        assert(originalVertex.distanceTo(vertex) < 1e-6);
      });
      onSuccess(new ArrayBuffer(16));
    }
  }
  const result = await exportProcessedGlb(root, { GLTFExporter: InspectingExporter });
  assert.equal(result.byteLength, 16);
});
