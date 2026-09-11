import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Viewer, disposeModelResources } from '../src/viewer.js';

function testViewer(root) {
  const viewer = Object.create(Viewer.prototype);
  viewer.currentModel = root;
  viewer._envIntensity = 1.4;
  viewer._wireframe = false;
  viewer._materialEffects = true;
  viewer._materialEffectStates = new WeakMap();
  viewer._alphaCutout = true;
  viewer._alphaTest = 0.5;
  return viewer;
}

test('matte print preview preserves printable color inputs and restores PBR properties', () => {
  const baseMap = new THREE.Texture({ width: 1, height: 1 });
  const normalMap = new THREE.Texture({ width: 1, height: 1 });
  const roughnessMap = new THREE.Texture({ width: 1, height: 1 });
  const metalnessMap = new THREE.Texture({ width: 1, height: 1 });
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x8a341f,
    map: baseMap,
    normalMap,
    roughness: 0.23,
    roughnessMap,
    metalness: 0.82,
    metalnessMap,
    clearcoat: 0.7,
    sheen: 0.4,
    transmission: 0.35,
    emissive: 0x221100,
    emissiveIntensity: 1.8,
    opacity: 0.75,
    transparent: true,
  });
  const originalColor = material.color.getHex();
  const originalEmissive = material.emissive.getHex();
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));
  const viewer = testViewer(root);

  viewer.setMaterialEffects(false);

  assert.equal(material.color.getHex(), originalColor);
  assert.equal(material.map, baseMap);
  assert.equal(material.opacity, 0.75);
  assert.equal(material.transparent, true);
  assert.equal(material.metalness, 0);
  assert.equal(material.roughness, 1);
  assert.equal(material.normalMap, null);
  assert.equal(material.roughnessMap, null);
  assert.equal(material.metalnessMap, null);
  assert.equal(material.clearcoat, 0);
  assert.equal(material.sheen, 0);
  assert.equal(material.transmission, 0);
  assert.equal(material.emissive.getHex(), 0x000000);
  assert.equal(material.envMapIntensity, 0);

  // Reapplying the disabled state must not overwrite the original snapshot.
  viewer.applyMaterialSettings();
  viewer.setMaterialEffects(true);

  assert.equal(material.color.getHex(), originalColor);
  assert.equal(material.map, baseMap);
  assert.equal(material.normalMap, normalMap);
  assert.equal(material.roughness, 0.23);
  assert.equal(material.roughnessMap, roughnessMap);
  assert.equal(material.metalness, 0.82);
  assert.equal(material.metalnessMap, metalnessMap);
  assert.equal(material.clearcoat, 0.7);
  assert.equal(material.sheen, 0.4);
  assert.equal(material.transmission, 0.35);
  assert.equal(material.emissive.getHex(), originalEmissive);
  assert.equal(material.emissiveIntensity, 1.8);
  assert.equal(material.envMapIntensity, 1.4);
});

test('export copies restore display-only material effects without changing the preview', () => {
  const material = new THREE.MeshStandardMaterial({
    color: 0x336699,
    roughness: 0.2,
    metalness: 0.9,
  });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));
  const viewer = testViewer(root);
  viewer.setMaterialEffects(false);

  const exportObject = viewer.createExportObject();
  const exportMaterial = exportObject.children[0].material;

  assert.equal(material.roughness, 1);
  assert.equal(material.metalness, 0);
  assert.equal(exportMaterial.roughness, 0.2);
  assert.equal(exportMaterial.metalness, 0.9);
});

test('print-color export copies keep the compact matte preview state', () => {
  const normalMap = new THREE.Texture({ width: 1024, height: 1024 });
  const roughnessMap = new THREE.Texture({ width: 1024, height: 1024 });
  const material = new THREE.MeshStandardMaterial({
    color: 0x336699,
    normalMap,
    roughnessMap,
    metalness: 0.8,
  });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
  const viewer = testViewer(root);
  viewer.setMaterialEffects(false);

  const exportMaterial = viewer.createExportObject({
    restoreMaterialEffects: false,
  }).children[0].material;

  assert.equal(exportMaterial.normalMap, null);
  assert.equal(exportMaterial.roughnessMap, null);
  assert.equal(exportMaterial.metalness, 0);
  assert.equal(material.normalMap, null);
  assert.equal(viewer._materialEffectStates.get(material).values.normalMap, normalMap);
});

test('superseded model resources are disposed exactly once', () => {
  const texture = new THREE.Texture({ width: 1, height: 1 });
  const originalTexture = new THREE.Texture({ width: 1, height: 1 });
  const material = new THREE.MeshBasicMaterial({ map: texture });
  material._originalMap = originalTexture;
  const geometry = new THREE.BoxGeometry();
  const root = new THREE.Group();
  root.add(
    new THREE.Mesh(geometry, material),
    new THREE.Mesh(geometry, material)
  );
  let geometryDisposals = 0;
  let materialDisposals = 0;
  let textureDisposals = 0;
  let originalTextureDisposals = 0;
  geometry.dispose = () => geometryDisposals++;
  material.dispose = () => materialDisposals++;
  texture.dispose = () => textureDisposals++;
  originalTexture.dispose = () => originalTextureDisposals++;

  disposeModelResources(root);
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 1);
  assert.equal(textureDisposals, 1);
  assert.equal(originalTextureDisposals, 1);
});

test('viewport picking raycasts to an unlit authored surface color', () => {
  const material = new THREE.MeshStandardMaterial({ color: 0x336699 });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  const viewer = testViewer(root);
  viewer.renderer = {
    domElement: {
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
    },
  };
  viewer.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  viewer.camera.position.set(0, 0, 2);
  viewer.camera.lookAt(0, 0, 0);
  viewer.camera.updateMatrixWorld();
  viewer._raycaster = new THREE.Raycaster();
  viewer._pickPointer = new THREE.Vector2();

  const picked = viewer.pickAuthoredColor(50, 50);

  assert.deepEqual(picked.color, [51, 102, 153]);
});
