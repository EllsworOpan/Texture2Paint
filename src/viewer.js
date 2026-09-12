import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { applyUvFlip, getModelTextures, sampleAuthoredSurfaceColor } from './processor.js';

const MATTE_MATERIAL_OVERRIDES = {
  metalness: 0,
  roughness: 1,
  metalnessMap: null,
  roughnessMap: null,
  normalMap: null,
  bumpMap: null,
  displacementMap: null,
  aoMap: null,
  clearcoat: 0,
  clearcoatMap: null,
  clearcoatNormalMap: null,
  clearcoatRoughnessMap: null,
  sheen: 0,
  sheenColorMap: null,
  sheenRoughnessMap: null,
  iridescence: 0,
  iridescenceMap: null,
  iridescenceThicknessMap: null,
  transmission: 0,
  transmissionMap: null,
  thickness: 0,
  thicknessMap: null,
  specularIntensity: 0,
  specularIntensityMap: null,
  specularColorMap: null,
  shininess: 0,
  emissiveIntensity: 0,
  emissiveMap: null,
};

function copyMaterialValue(value) {
  return value?.isColor ? value.clone() : value;
}

function restoreMaterialEffectState(material, state) {
  if (!state) return;
  for (const [property, value] of Object.entries(state.values)) {
    if (value?.isColor && material[property]?.isColor) material[property].copy(value);
    else material[property] = value;
  }
  if (state.specular && material.specular?.isColor) material.specular.copy(state.specular);
  if (state.emissive && material.emissive?.isColor) material.emissive.copy(state.emissive);
  material.needsUpdate = true;
}

const MODEL_TEXTURE_SLOTS = [
  'map', 'alphaMap', 'aoMap', 'bumpMap', 'normalMap', 'displacementMap',
  'emissiveMap', 'metalnessMap', 'roughnessMap', 'clearcoatMap',
  'clearcoatNormalMap', 'clearcoatRoughnessMap', 'iridescenceMap',
  'iridescenceThicknessMap', 'sheenColorMap', 'sheenRoughnessMap',
  'specularColorMap', 'specularIntensityMap', 'thicknessMap', 'transmissionMap',
];

export function disposeModelResources(rootObject) {
  if (!rootObject) return;
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  rootObject.traverse(object => {
    if (!object.isMesh) return;
    if (object.geometry) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) {
      if (!material) continue;
      materials.add(material);
      for (const slot of MODEL_TEXTURE_SLOTS) {
        if (material[slot]) textures.add(material[slot]);
      }
      if (material._originalMap) textures.add(material._originalMap);
      if (material._texture2PaintTextureCache?.texture) {
        textures.add(material._texture2PaintTextureCache.texture);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose?.();
  for (const texture of textures) texture.dispose?.();
  for (const material of materials) material.dispose?.();
}

export class Viewer {
  constructor({ container = document.body, background = 0x1a1a2e } = {}) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this._envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this._envTexture;
    this._envIntensity = 1.0;

    this.camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 1000);
    this.camera.position.set(2, 1.5, 3);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 2.0;

    this._hemiLight = new THREE.HemisphereLight(0xffffff, 0x202030, 0.6);
    this.scene.add(this._hemiLight);
    this._dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    this._dirLight.position.set(3, 5, 2);
    this.scene.add(this._dirLight);

    this._wireframe = false;
    this._materialEffects = true;
    this._materialEffectStates = new WeakMap();
    this._isUvFlipped = false;
    this._alphaCutout = true;
    this._alphaTest = 0.5;
    this._raycaster = new THREE.Raycaster();
    this._pickPointer = new THREE.Vector2();

    addEventListener('resize', () => this._onResize());

    this.currentModel = null;
    this._previewObject = null;
    this.loader = new GLTFLoader();
    this._lastBlobUrl = null;

    this._tick();
  }

  _onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    if (this.currentModel) this._frame(this.currentModel);
  }

  _tick = () => {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._tick);
  };

  _frame(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    obj.position.sub(center);
    const dist = maxDim * (this.camera.aspect < 1 ? 2.6 : 1.8);
    this.camera.position.set(dist, dist * 0.7, dist);
    this.camera.near = maxDim / 100;
    this.camera.far = maxDim * 50;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  setExposure(v) {
    this.renderer.toneMappingExposure = v;
  }

  setEnvIntensity(v) {
    this._envIntensity = v;
    this.applyMaterialSettings();
  }

  setDirectLight(v) {
    this._dirLight.intensity = v;
  }

  setAmbientLight(v) {
    this._hemiLight.intensity = v;
  }

  setBackground(hex) {
    this.scene.background = new THREE.Color(hex);
  }

  setAutoRotate(on) {
    this.controls.autoRotate = on;
  }

  setControlsEnabled(enabled) {
    this.controls.enabled = Boolean(enabled);
  }

  /** Returns the unlit authored surface color beneath a viewport coordinate. */
  pickAuthoredColor(clientX, clientY) {
    if (!this.currentModel) return null;
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    this._pickPointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.currentModel.updateWorldMatrix(true, true);
    this._raycaster.setFromCamera(this._pickPointer, this.camera);
    for (const intersection of this._raycaster.intersectObject(this.currentModel, true)) {
      const color = sampleAuthoredSurfaceColor(intersection.object, intersection);
      if (color) return { color, intersection };
    }
    return null;
  }

  setWireframe(on) {
    this._wireframe = on;
    const displayedObject = this._previewObject || this.currentModel;
    if (displayedObject) {
      displayedObject.traverse(o => {
        if (o.isMesh && o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) m.wireframe = on;
        }
      });
    }
  }

  _setMaterialEffectsOnMaterial(material) {
    const saved = this._materialEffectStates.get(material);
    if (this._materialEffects) {
      if (saved) {
        restoreMaterialEffectState(material, saved);
        this._materialEffectStates.delete(material);
      }
      return;
    }

    if (!saved) {
      const values = {};
      for (const property of Object.keys(MATTE_MATERIAL_OVERRIDES)) {
        if (property in material) values[property] = copyMaterialValue(material[property]);
      }
      this._materialEffectStates.set(material, {
        values,
        specular: material.specular?.isColor ? material.specular.clone() : null,
        emissive: material.emissive?.isColor ? material.emissive.clone() : null,
      });
    }

    for (const [property, value] of Object.entries(MATTE_MATERIAL_OVERRIDES)) {
      if (property in material) material[property] = value;
    }
    if (material.specular?.isColor) material.specular.set(0x000000);
    if (material.emissive?.isColor) material.emissive.set(0x000000);
    material.needsUpdate = true;
  }

  setMaterialEffects(enabled) {
    this._materialEffects = Boolean(enabled);
    this.applyMaterialSettings();
  }

  areMaterialEffectsEnabled() {
    return this._materialEffects;
  }

  resetCamera() {
    if (this.currentModel) this._frame(this.currentModel);
  }

  setAlphaCutout(enabled) {
    this._alphaCutout = Boolean(enabled);
    this.applyMaterialSettings();
  }

  setAlphaTest(val) {
    this._alphaTest = Math.max(0, Math.min(1, Number(val)));
    this.applyMaterialSettings();
  }

  isAlphaCutout() {
    return this._alphaCutout;
  }

  getAlphaTest() {
    return this._alphaTest;
  }

  _applyMaterialSettings(obj) {
    obj.traverse(o => {
      if (o.isMesh && o.material) {
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        for (const material of materials) {
          this._setMaterialEffectsOnMaterial(material);
          material.envMapIntensity = this._materialEffects ? this._envIntensity : 0;
          material.wireframe = this._wireframe;

          // Configure alpha testing, depth write, and polygon offset for overlayed decals
          if (material.map || material.alphaMap) {
            material.alphaTest = this._alphaCutout ? (this._alphaTest ?? 0.5) : 0;
            material.depthWrite = true;
            material.polygonOffset = true;
            material.polygonOffsetFactor = -1;
            material.polygonOffsetUnits = -1;
            material.side = THREE.DoubleSide;
            material.needsUpdate = true;
          }
        }
      }
    });
  }

  applyMaterialSettings() {
    if (this.currentModel) this._applyMaterialSettings(this.currentModel);
    if (this._previewObject) this._applyMaterialSettings(this._previewObject);
  }

  countTriangles(scene) {
    let n = 0;
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const idx = o.geometry.index;
      n += (idx ? idx.count : o.geometry.attributes.position.count) / 3;
    });
    return n;
  }

  setUvFlipped(on) {
    this._isUvFlipped = Boolean(on);
    if (this.currentModel) {
      applyUvFlip(this.currentModel, this._isUvFlipped);
    }
  }

  isUvFlipped() {
    return this._isUvFlipped;
  }

  getTextures() {
    return getModelTextures(this.currentModel);
  }

  /** Creates an export copy without display-only matte overrides. */
  createExportObject({ restoreMaterialEffects = true } = {}) {
    if (!this.currentModel) return null;
    const clone = this.currentModel.clone(true);
    const sourceMeshes = [];
    const clonedMeshes = [];
    this.currentModel.traverse(object => { if (object.isMesh) sourceMeshes.push(object); });
    clone.traverse(object => { if (object.isMesh) clonedMeshes.push(object); });
    for (let index = 0; index < sourceMeshes.length; index++) {
      const source = sourceMeshes[index];
      const target = clonedMeshes[index];
        const cloneMaterial = material => {
          if (!material) return material;
          const copy = material.clone();
          if (restoreMaterialEffects) {
            restoreMaterialEffectState(copy, this._materialEffectStates.get(material));
            copy.envMapIntensity = this._envIntensity;
          }
          return copy;
      };
      target.material = Array.isArray(source.material)
        ? source.material.map(cloneMaterial)
        : cloneMaterial(source.material);
    }
    return clone;
  }

  /** Displays a derived representation without changing the export model. */
  setPreviewObject(object) {
    this.clearPreviewObject();
    if (!object || object === this.currentModel) return;
    this._previewObject = object;
    if (this.currentModel) this.scene.remove(this.currentModel);
    this._applyMaterialSettings(object);
    this.scene.add(object);
  }

  /** Restores the processed model after a format-specific preview. */
  clearPreviewObject() {
    if (!this._previewObject) return;
    this.scene.remove(this._previewObject);
    disposeModelResources(this._previewObject);
    this._previewObject = null;
    if (this.currentModel && !this.currentModel.parent) this.scene.add(this.currentModel);
  }

  loadObject(object) {
    this._isUvFlipped = false;
    applyUvFlip(object, false); // Initialize original UV cache
    return this.replaceObject(object, { frame: true, uvFlipped: false });
  }

  /** Replaces the visible model without resetting the processing controls. */
  replaceObject(object, {
    frame = false,
    uvFlipped = this._isUvFlipped,
    disposePrevious = true,
  } = {}) {
    this.clearPreviewObject();
    if (this.currentModel) {
      this.scene.remove(this.currentModel);
      if (disposePrevious && this.currentModel !== object) {
        disposeModelResources(this.currentModel);
      }
    }
    this.currentModel = object;
    this._isUvFlipped = Boolean(uvFlipped);
    this._applyMaterialSettings(this.currentModel);
    this.scene.add(this.currentModel);
    if (frame) this._frame(this.currentModel);

    return {
      triangles: this.countTriangles(this.currentModel),
      textures: getModelTextures(this.currentModel),
    };
  }

  async loadGLB(glbBuffer) {
    const blob = new Blob([glbBuffer], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    const gltf = await this.loader.loadAsync(url);
    const loaded = this.loadObject(gltf.scene);

    if (this._lastBlobUrl) URL.revokeObjectURL(this._lastBlobUrl);
    this._lastBlobUrl = url;

    return {
      blobUrl: url,
      triangles: loaded.triangles,
      textures: loaded.textures,
      sceneJson: gltf.parser?.json,
    };
  }
}
