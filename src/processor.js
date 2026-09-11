import * as THREE from 'three';
import { zip, zipSync, strToU8 } from 'fflate';
import { MeshoptSimplifier } from 'meshoptimizer';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

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
 * - Preserves authored mesh/component boundaries unless an explicit merge is requested.
 * - Handles single materials or multi-material groups with preserved texture maps and colors.
 * - Ensures attributes are Float32 and vertex normals are computed.
 */
export function canonicalizeModel(rootObject, { mergeMeshes = false } = {}) {
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

  // 2. Cache originals and keep semantic mesh/component boundaries by default.
  // Importers commonly use separate meshes for decals, clothing shells, and
  // other authored parts. Flattening those parts on import made it impossible
  // for later processing operations to reason about them. A caller which
  // explicitly needs a single mesh (the repair "Join sub-meshes" operation)
  // can still request the legacy merge behavior.
  for (const mesh of meshes) {
    if (!mesh._originalGeometry) mesh._originalGeometry = mesh.geometry.clone();
  }

  if (meshes.length === 1 || !mergeMeshes) {
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
 * Creates an isolated working copy. Geometry, materials, and texture objects
 * are cloned so processing the visible model never mutates the import source.
 */
export function cloneModelForProcessing(rootObject) {
  if (!rootObject) return null;
  const clone = rootObject.clone(true);
  const textureClones = new Map();
  const cloneTexture = texture => {
    if (!texture) return texture;
    if (!textureClones.has(texture)) textureClones.set(texture, texture.clone());
    return textureClones.get(texture);
  };
  clone.traverse(child => {
    if (!child.isMesh) return;
    if (child.geometry) child.geometry = child.geometry.clone();
    const cloneMaterial = mat => {
      if (!mat) return mat;
      const next = mat.clone();
      for (const slot of [
        'map', 'alphaMap', 'aoMap', 'bumpMap', 'normalMap', 'displacementMap',
        'emissiveMap', 'metalnessMap', 'roughnessMap', 'clearcoatMap',
        'clearcoatNormalMap', 'clearcoatRoughnessMap', 'iridescenceMap',
        'iridescenceThicknessMap', 'sheenColorMap', 'sheenRoughnessMap',
        'specularColorMap', 'specularIntensityMap', 'thicknessMap', 'transmissionMap',
      ]) {
        if (next[slot]) next[slot] = cloneTexture(next[slot]);
      }
      return next;
    };
    child.material = Array.isArray(child.material)
      ? child.material.map(cloneMaterial)
      : cloneMaterial(child.material);
    child._originalGeometry = child.geometry?.clone();
  });
  return clone;
}

const MIN_SIMPLIFICATION_ERROR = 0.00001;
const MAX_SIMPLIFICATION_ERROR = 0.005;

/**
 * Maps the user-facing 0-100 detail slider to meshoptimizer's relative
 * geometric error. The exponential curve keeps most of the slider's travel
 * in the subtle range while still making a deliberately coarse setting
 * available for exceptionally dense assets.
 */
export function meshSimplificationErrorForLod(lod = 65) {
  const normalizedDetail = Math.max(0, Math.min(100, Number(lod) || 0)) / 100;
  return MAX_SIMPLIFICATION_ERROR *
    Math.pow(MIN_SIMPLIFICATION_ERROR / MAX_SIMPLIFICATION_ERROR, normalizedDetail);
}

function simplificationAttributeData(geometry) {
  const attributes = [];
  let stride = 0;
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (name === 'position' || !attribute || attribute.count !== geometry.attributes.position.count) continue;
    if (!/^(normal|tangent|uv\d*|color)$/u.test(name)) continue;
    for (let component = 0; component < attribute.itemSize && stride < 32; component++) {
      let weight = 0.05;
      if (name.startsWith('uv')) weight = 0.5;
      else if (name === 'color') weight = 0.2;
      else if (name === 'normal') weight = 0.1;
      attributes.push({ attribute, component, weight });
      stride++;
    }
    if (stride >= 32) break;
  }
  if (stride === 0) return null;

  const vertexCount = geometry.attributes.position.count;
  const packed = new Float32Array(vertexCount * stride);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    for (let component = 0; component < stride; component++) {
      const source = attributes[component];
      packed[vertex * stride + component] = source.attribute.getComponent(vertex, source.component);
    }
  }
  return { packed, stride, weights: attributes.map(attribute => attribute.weight) };
}

function compactGeometryToIndices(source, sourceIndices, groups) {
  const remap = new Map();
  const originalVertices = [];
  const compactIndices = new Uint32Array(sourceIndices.length);
  for (let offset = 0; offset < sourceIndices.length; offset++) {
    const sourceIndex = sourceIndices[offset];
    let compactIndex = remap.get(sourceIndex);
    if (compactIndex === undefined) {
      compactIndex = originalVertices.length;
      remap.set(sourceIndex, compactIndex);
      originalVertices.push(sourceIndex);
    }
    compactIndices[offset] = compactIndex;
  }

  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    let next;
    if (!attribute.isInterleavedBufferAttribute && attribute.array) {
      const values = new attribute.array.constructor(originalVertices.length * attribute.itemSize);
      for (let vertex = 0; vertex < originalVertices.length; vertex++) {
        const sourceOffset = originalVertices[vertex] * attribute.itemSize;
        const targetOffset = vertex * attribute.itemSize;
        for (let component = 0; component < attribute.itemSize; component++) {
          values[targetOffset + component] = attribute.array[sourceOffset + component];
        }
      }
      next = new THREE.BufferAttribute(values, attribute.itemSize, attribute.normalized);
    } else {
      const values = new Float32Array(originalVertices.length * attribute.itemSize);
      for (let vertex = 0; vertex < originalVertices.length; vertex++) {
        for (let component = 0; component < attribute.itemSize; component++) {
          values[vertex * attribute.itemSize + component] =
            attribute.getComponent(originalVertices[vertex], component);
        }
      }
      next = new THREE.BufferAttribute(values, attribute.itemSize, false);
    }
    next.name = attribute.name;
    next.usage = attribute.usage;
    geometry.setAttribute(name, next);
  }

  const indexValues = originalVertices.length <= 65535
    ? new Uint16Array(compactIndices)
    : compactIndices;
  geometry.setIndex(new THREE.BufferAttribute(indexValues, 1));
  for (const group of groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.name = source.name;
  geometry.userData = { ...source.userData };
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function fullGeometryGroups(geometry, indexCount) {
  if (!geometry.groups?.length) return [{ start: 0, count: indexCount, materialIndex: 0 }];
  const groups = [];
  const sourceGroups = geometry.groups
    .map(group => ({
      start: Math.max(0, group.start),
      end: Math.min(indexCount, group.start + group.count),
      materialIndex: group.materialIndex || 0,
    }))
    .filter(group => group.end > group.start)
    .sort((left, right) => left.start - right.start);
  const triangleCount = Math.floor(indexCount / 3);
  let sourceGroupIndex = 0;
  const materialAtTriangle = triangle => {
    const elementOffset = triangle * 3;
    while (sourceGroupIndex < sourceGroups.length &&
      sourceGroups[sourceGroupIndex].end <= elementOffset) sourceGroupIndex++;
    const group = sourceGroups[sourceGroupIndex];
    return group && elementOffset >= group.start && elementOffset < group.end
      ? group.materialIndex
      : 0;
  };
  let activeMaterial = materialAtTriangle(0);
  let activeStart = 0;
  for (let triangle = 1; triangle < triangleCount; triangle++) {
    const materialIndex = materialAtTriangle(triangle);
    if (materialIndex === activeMaterial) continue;
    groups.push({ start: activeStart * 3, count: (triangle - activeStart) * 3, materialIndex: activeMaterial });
    activeStart = triangle;
    activeMaterial = materialIndex;
  }
  if (triangleCount > activeStart) {
    groups.push({
      start: activeStart * 3,
      count: (triangleCount - activeStart) * 3,
      materialIndex: activeMaterial,
    });
  }
  return groups;
}

function hasUnsupportedSimplificationAnimation(mesh, geometry) {
  if (mesh.isSkinnedMesh) return true;
  return Object.values(geometry.morphAttributes || {}).some(attributes => attributes?.length);
}

/**
 * Simplifies ordinary triangle meshes while retaining their original vertex
 * attributes. Material subsets and open borders are simplified independently
 * with locked edges, so this operation does not join components, repair holes,
 * cross UV seams, or discard vertex alpha. Animated geometry is left intact.
 */
export async function applyLiveMeshSimplification(rootObject, {
  enabled = true,
  lod = 65,
  simplifier = MeshoptSimplifier,
} = {}) {
  if (!rootObject || !enabled) {
    return { enabled: false, originalTriangles: 0, triangles: 0, removedTriangles: 0, skippedMeshes: 0 };
  }
  if (!simplifier?.supported) throw new Error('Mesh simplification is not supported by this browser.');
  await simplifier.ready;

  const targetError = meshSimplificationErrorForLod(lod);
  let originalTriangles = 0;
  let triangles = 0;
  let skippedMeshes = 0;
  let simplifiedMeshes = 0;
  let maximumRelativeError = 0;

  const meshes = [];
  rootObject.traverse(mesh => {
    if (mesh.isMesh && mesh.geometry?.attributes?.position) meshes.push(mesh);
  });

  for (const mesh of meshes) {
    let geometry = mesh.geometry;
    const position = geometry.attributes.position;
    const elementCount = geometry.index ? geometry.index.count : position.count;
    const sourceTriangleCount = Math.floor(elementCount / 3);
    originalTriangles += sourceTriangleCount;

    const drawStart = Math.max(0, geometry.drawRange?.start || 0);
    const drawCount = geometry.drawRange?.count;
    const hasPartialDrawRange = drawStart !== 0 ||
      (Number.isFinite(drawCount) && drawCount < elementCount);
    if (sourceTriangleCount < 2 || hasPartialDrawRange ||
      mesh.isBatchedMesh || hasUnsupportedSimplificationAnimation(mesh, geometry)) {
      triangles += sourceTriangleCount;
      skippedMeshes++;
      continue;
    }

    if (!geometry.index) geometry = mergeVertices(geometry.clone(), 1e-6);
    const floatPosition = toFloat32Attribute(geometry.attributes.position);
    if (floatPosition !== geometry.attributes.position) {
      geometry = geometry.clone();
      geometry.setAttribute('position', floatPosition);
    }
    const indexCount = geometry.index.count;
    const sourceIndices = new Uint32Array(indexCount);
    for (let index = 0; index < indexCount; index++) sourceIndices[index] = geometry.index.getX(index);
    const attributes = simplificationAttributeData(geometry);
    const sourceGroups = fullGeometryGroups(geometry, indexCount);
    const simplifiedIndexChunks = [];
    const simplifiedGroups = [];
    let outputOffset = 0;

    for (const group of sourceGroups) {
      const groupIndices = sourceIndices.slice(group.start, group.start + group.count);
      const targetIndexCount = groupIndices.length >= 3 ? 3 : 0;
      let result;
      if (attributes) {
        result = simplifier.simplifyWithAttributes(
          groupIndices,
          floatPosition.array,
          floatPosition.itemSize,
          attributes.packed,
          attributes.stride,
          attributes.weights,
          null,
          targetIndexCount,
          targetError,
          ['LockBorder']
        );
      } else {
        result = simplifier.simplify(
          groupIndices,
          floatPosition.array,
          floatPosition.itemSize,
          targetIndexCount,
          targetError,
          ['LockBorder']
        );
      }
      const [indices, error] = result;
      maximumRelativeError = Math.max(maximumRelativeError, error || 0);
      simplifiedIndexChunks.push(indices);
      simplifiedGroups.push({
        start: outputOffset,
        count: indices.length,
        materialIndex: group.materialIndex,
      });
      outputOffset += indices.length;
    }

    const outputTriangleCount = Math.floor(outputOffset / 3);
    if (outputTriangleCount > 0 && outputTriangleCount < sourceTriangleCount) {
      const simplifiedIndices = new Uint32Array(outputOffset);
      let chunkOffset = 0;
      for (const chunk of simplifiedIndexChunks) {
        simplifiedIndices.set(chunk, chunkOffset);
        chunkOffset += chunk.length;
      }
      mesh.geometry = compactGeometryToIndices(
        geometry,
        simplifiedIndices,
        simplifiedGroups
      );
      triangles += outputTriangleCount;
      simplifiedMeshes++;
    } else {
      triangles += sourceTriangleCount;
    }
  }

  return {
    enabled: true,
    lod: Math.max(0, Math.min(100, Number(lod) || 0)),
    targetError,
    maximumRelativeError,
    originalTriangles,
    triangles,
    removedTriangles: Math.max(0, originalTriangles - triangles),
    simplifiedMeshes,
    skippedMeshes,
  };
}

function triangleVertexIndex(geometry, triangleIndex, corner) {
  const index = geometry.index;
  return index ? index.getX(triangleIndex * 3 + corner) : triangleIndex * 3 + corner;
}

function triangleMaterialIndex(geometry, triangleIndex) {
  const elementOffset = triangleIndex * 3;
  for (const group of geometry.groups || []) {
    if (elementOffset >= group.start && elementOffset < group.start + group.count) {
      return group.materialIndex || 0;
    }
  }
  return 0;
}

function materialAt(mesh, materialIndex) {
  return Array.isArray(mesh.material)
    ? (mesh.material[materialIndex] || mesh.material[0])
    : mesh.material;
}

function surfacePositionKey(position, vertexIndex, inverseTolerance) {
  return `${Math.round(position.getX(vertexIndex) * inverseTolerance)}_` +
    `${Math.round(position.getY(vertexIndex) * inverseTolerance)}_` +
    `${Math.round(position.getZ(vertexIndex) * inverseTolerance)}`;
}

function collectConnectedTriangleSets(geometry) {
  const position = geometry.attributes.position;
  const triangleCount = geometry.index ? geometry.index.count / 3 : position.count / 3;
  if (triangleCount === 0) return [];

  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  const tolerance = Math.max(size.length() * 1e-7, 1e-8);
  const inverseTolerance = 1 / tolerance;
  const parent = new Int32Array(triangleCount);
  for (let i = 0; i < triangleCount; i++) parent[i] = i;
  const find = i => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== i) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const unite = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  // Geometric edge keys reconnect UV seams while keeping components which
  // merely touch at one vertex separate.
  const firstTriangleForEdge = new Map();
  for (let t = 0; t < triangleCount; t++) {
    const ids = [0, 1, 2].map(c => triangleVertexIndex(geometry, t, c));
    const keys = ids.map(i => surfacePositionKey(position, i, inverseTolerance));
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const edge = keys[a] < keys[b] ? `${keys[a]}|${keys[b]}` : `${keys[b]}|${keys[a]}`;
      const previous = firstTriangleForEdge.get(edge);
      if (previous === undefined) firstTriangleForEdge.set(edge, t);
      else unite(t, previous);
    }
  }

  const sets = new Map();
  for (let t = 0; t < triangleCount; t++) {
    const root = find(t);
    if (!sets.has(root)) sets.set(root, []);
    sets.get(root).push(t);
  }
  return [...sets.values()].sort((a, b) => a[0] - b[0]);
}

function makeTriangleRecord(component, triangleIndex) {
  const { mesh } = component;
  const geometry = mesh.geometry;
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const matrix = mesh.matrixWorld;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const points = [];
  const normals = [];
  const uvs = [];

  for (let corner = 0; corner < 3; corner++) {
    const vertexIndex = triangleVertexIndex(geometry, triangleIndex, corner);
    const localPoint = new THREE.Vector3();
    if (typeof mesh.getVertexPosition === 'function') mesh.getVertexPosition(vertexIndex, localPoint);
    else localPoint.set(position.getX(vertexIndex), position.getY(vertexIndex), position.getZ(vertexIndex));
    points.push(localPoint.applyMatrix4(matrix));
    if (normal && !mesh.isSkinnedMesh && !mesh.morphTargetInfluences) {
      normals.push(new THREE.Vector3(
        normal.getX(vertexIndex), normal.getY(vertexIndex), normal.getZ(vertexIndex)
      ).applyMatrix3(normalMatrix).normalize());
    }
    uvs.push(uv
      ? new THREE.Vector2(uv.getX(vertexIndex), uv.getY(vertexIndex))
      : new THREE.Vector2());
  }

  const triangle = new THREE.Triangle(points[0], points[1], points[2]);
  const faceNormal = triangle.getNormal(new THREE.Vector3());
  const averagedNormal = normals.length
    ? normals.reduce((sum, n) => sum.add(n), new THREE.Vector3()).normalize()
    : faceNormal.clone();
  const materialIndex = triangleMaterialIndex(geometry, triangleIndex);
  return {
    triangleIndex,
    triangle,
    points,
    normals: normals.length ? normals : [faceNormal, faceNormal, faceNormal],
    uvs,
    faceNormal,
    normal: averagedNormal.lengthSq() > 0 ? averagedNormal : faceNormal,
    materialIndex,
    material: materialAt(mesh, materialIndex),
    box: new THREE.Box3().setFromPoints(points),
    centroid: triangle.getMidpoint(new THREE.Vector3()),
  };
}

/**
 * Segments the normalized model into connected surface components. The IDs are
 * deterministic for a given model and survive isolated processing clones.
 */
export function collectSurfaceComponents(rootObject) {
  if (!rootObject) return [];
  rootObject.updateWorldMatrix(true, true);
  const components = [];
  let meshIndex = 0;

  rootObject.traverse(mesh => {
    if (!mesh.isMesh || !mesh.geometry?.attributes?.position) return;
    const connectedSets = collectConnectedTriangleSets(mesh.geometry);
    connectedSets.forEach((triangleIndices, componentIndex) => {
      const descriptor = {
        id: `mesh-${meshIndex}-component-${componentIndex}`,
        mesh,
        meshIndex,
        componentIndex,
        triangleIndices,
        triangleCount: triangleIndices.length,
        name: mesh.name || `Mesh ${meshIndex + 1}`,
        label: connectedSets.length > 1
          ? `${mesh.name || `Mesh ${meshIndex + 1}`} · part ${componentIndex + 1}`
          : (mesh.name || `Mesh ${meshIndex + 1}`),
        box: new THREE.Box3(),
        area: 0,
        boundaryEdges: 0,
        materials: new Set(),
        records: [],
      };

      // Track distinct geometric faces per edge. Some authored sheets contain
      // coincident front/back triangles; counting raw incidences would mistake
      // their doubled outer rim for an internal edge.
      const edgeTriangles = new Map();
      const position = mesh.geometry.attributes.position;
      mesh.geometry.computeBoundingBox();
      const localSize = mesh.geometry.boundingBox.getSize(new THREE.Vector3());
      const inverseTolerance = 1 / Math.max(localSize.length() * 1e-7, 1e-8);

      for (const triangleIndex of triangleIndices) {
        const record = makeTriangleRecord(descriptor, triangleIndex);
        descriptor.records.push(record);
        descriptor.box.union(record.box);
        descriptor.area += record.triangle.getArea();
        if (record.material) descriptor.materials.add(record.material);

        const ids = [0, 1, 2].map(c => triangleVertexIndex(mesh.geometry, triangleIndex, c));
        const keys = ids.map(i => surfacePositionKey(position, i, inverseTolerance));
        const triangleKey = [...keys].sort().join('|');
        record.edgeKeys = [];
        for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
          const edge = keys[a] < keys[b] ? `${keys[a]}|${keys[b]}` : `${keys[b]}|${keys[a]}`;
          record.edgeKeys.push(edge);
          if (!edgeTriangles.has(edge)) edgeTriangles.set(edge, new Set());
          edgeTriangles.get(edge).add(triangleKey);
        }
      }
      for (const record of descriptor.records) {
        record.boundaryEdgeFlags = record.edgeKeys.map(edge => edgeTriangles.get(edge)?.size === 1);
      }
      descriptor.boundaryEdges = [...edgeTriangles.values()].filter(triangles => triangles.size === 1).length;
      descriptor.hasTexture = [...descriptor.materials].some(mat => Boolean(mat?.map || mat?.alphaMap));
      components.push(descriptor);
    });
    meshIndex++;
  });
  return components;
}

function buildTriangleBvh(records, depth = 0) {
  if (!records.length) return null;
  const box = new THREE.Box3();
  for (const record of records) box.union(record.box);
  if (records.length <= 12 || depth >= 24) return { box, records, left: null, right: null };
  const size = box.getSize(new THREE.Vector3());
  const axis = size.x >= size.y && size.x >= size.z ? 'x' : (size.y >= size.z ? 'y' : 'z');
  records.sort((a, b) => a.centroid[axis] - b.centroid[axis]);
  const middle = Math.floor(records.length / 2);
  return {
    box,
    records: null,
    left: buildTriangleBvh(records.slice(0, middle), depth + 1),
    right: buildTriangleBvh(records.slice(middle), depth + 1),
  };
}

function nearestTriangleInBvh(node, point, best = { distanceSq: Infinity, record: null, point: null }) {
  if (!node || node.box.distanceToPoint(point) ** 2 > best.distanceSq) return best;
  if (node.records) {
    const closest = new THREE.Vector3();
    for (const record of node.records) {
      record.triangle.closestPointToPoint(point, closest);
      const distanceSq = closest.distanceToSquared(point);
      if (distanceSq < best.distanceSq) {
        best = { distanceSq, record, point: closest.clone() };
      }
    }
    return best;
  }
  best = nearestTriangleInBvh(node.left, point, best);
  return nearestTriangleInBvh(node.right, point, best);
}

function raycastTriangleBvh(node, ray, best = { distance: Infinity, record: null, point: null }) {
  if (!node || !ray.intersectsBox(node.box)) return best;
  if (node.records) {
    const hit = new THREE.Vector3();
    for (const record of node.records) {
      const point = ray.intersectTriangle(
        record.points[0], record.points[1], record.points[2], false, hit
      );
      if (!point) continue;
      const distance = point.distanceTo(ray.origin);
      if (distance > 1e-7 && distance < best.distance) {
        best = { distance, record, point: point.clone() };
      }
    }
    return best;
  }
  best = raycastTriangleBvh(node.left, ray, best);
  return raycastTriangleBvh(node.right, ray, best);
}

function collectBvhRecordsNear(node, point, maxDistance, output) {
  if (!node || node.box.distanceToPoint(point) > maxDistance) return;
  if (node.records) {
    output.push(...node.records);
    return;
  }
  collectBvhRecordsNear(node.left, point, maxDistance, output);
  collectBvhRecordsNear(node.right, point, maxDistance, output);
}

function textureHasUsefulAlpha(materials) {
  if (typeof document === 'undefined') return false;
  for (const material of materials) {
    const image = material?.alphaMap?.image || material?.map?.image;
    if (!image?.width || !image?.height) continue;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(64, image.width);
      canvas.height = Math.min(64, image.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let transparent = 0, opaque = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 245) transparent++;
        if (data[i] > 10) opaque++;
      }
      if (transparent > data.length / 40 && opaque > data.length / 40) return true;
    } catch {
      // A texture which cannot be sampled is still available for manual use;
      // it simply does not receive the alpha confidence boost.
    }
  }
  return false;
}

/**
 * Permissively discovers textured open sheets and ranks likely receivers.
 * Distance affects confidence only; it never prevents manual selection.
 */
export function analyzeFloatingDecals(rootObject) {
  const components = collectSurfaceComponents(rootObject);
  if (!components.length) return { components: [], candidates: [] };
  const modelBox = new THREE.Box3().setFromObject(rootObject);
  const modelDiagonal = Math.max(modelBox.getSize(new THREE.Vector3()).length(), 1e-8);
  const largestArea = Math.max(...components.map(component => component.area), 1e-8);
  const bvhById = new Map();
  const getBvh = component => {
    if (!bvhById.has(component.id)) {
      bvhById.set(component.id, buildTriangleBvh(component.records.slice()));
    }
    return bvhById.get(component.id);
  };

  const candidates = [];
  for (const source of components) {
    if (!source.hasTexture || source.boundaryEdges === 0 || source.area >= largestArea * 0.9) continue;
    let bestReceiver = null;
    let bestMetrics = null;
    const receivers = components.filter(candidate => candidate !== source && candidate.area > source.area * 1.25);

    for (const receiver of receivers) {
      const bvh = getBvh(receiver);
      const distances = [];
      const alignments = [];
      const stride = Math.max(1, Math.ceil(source.records.length / 64));
      for (let i = 0; i < source.records.length; i += stride) {
        const sample = source.records[i];
        const nearest = nearestTriangleInBvh(bvh, sample.centroid);
        if (!nearest.record) continue;
        distances.push(Math.sqrt(nearest.distanceSq));
        alignments.push(Math.abs(sample.normal.dot(nearest.record.normal)));
      }
      if (!distances.length) continue;
      distances.sort((a, b) => a - b);
      alignments.sort((a, b) => a - b);
      const medianDistance = distances[Math.floor(distances.length / 2)];
      const medianAlignment = alignments[Math.floor(alignments.length / 2)];
      const areaRatio = receiver.area / Math.max(source.area, 1e-8);
      const distanceScore = Math.exp(-medianDistance / (modelDiagonal * 0.02));
      const areaScore = Math.min(1, Math.log2(Math.max(1, areaRatio)) / 4);
      const receiverScore = 0.5 * medianAlignment + 0.3 * distanceScore + 0.2 * areaScore;
      if (!bestMetrics || receiverScore > bestMetrics.receiverScore) {
        bestReceiver = receiver;
        bestMetrics = { medianDistance, medianAlignment, areaRatio, receiverScore };
      }
    }

    if (!bestReceiver || !bestMetrics) continue;
    const alphaCue = textureHasUsefulAlpha(source.materials);
    const distanceScore = Math.exp(-bestMetrics.medianDistance / (modelDiagonal * 0.02));
    const areaScore = Math.min(1, Math.log2(Math.max(1, bestMetrics.areaRatio)) / 4);
    const score = 0.2 +
      0.25 * bestMetrics.medianAlignment +
      0.2 * distanceScore +
      0.15 * areaScore +
      (alphaCue ? 0.2 : 0);
    const confidence = score >= 0.75 ? 'high' : (score >= 0.52 ? 'medium' : 'low');
    candidates.push({
      id: source.id,
      label: source.label,
      triangleCount: source.triangleCount,
      receiverId: bestReceiver.id,
      receiverLabel: bestReceiver.label,
      confidence,
      score,
      autoSelected: confidence === 'high',
      alphaCue,
      medianDistance: bestMetrics.medianDistance,
      normalAlignment: bestMetrics.medianAlignment,
    });
  }

  const summaries = components.map(component => ({
    id: component.id,
    label: component.label,
    triangleCount: component.triangleCount,
    area: component.area,
    boundaryEdges: component.boundaryEdges,
    hasTexture: component.hasTexture,
  }));
  return { components: summaries, candidates };
}

function createImageSampler(material) {
  if (typeof document === 'undefined') return null;
  const texture = material?.map;
  const image = texture?.image;
  if (!image?.width || !image?.height) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(2048, image.width);
    canvas.height = Math.min(2048, image.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const wrap = (value, mode) => {
      if (mode === THREE.RepeatWrapping) return ((value % 1) + 1) % 1;
      if (mode === THREE.MirroredRepeatWrapping) {
        const n = Math.floor(value);
        const f = value - n;
        return Math.abs(n) % 2 ? 1 - f : f;
      }
      return Math.max(0, Math.min(1, value));
    };
    return uv => {
      let u = uv.x, v = uv.y;
      if (texture.matrixAutoUpdate) texture.updateMatrix();
      const transformed = new THREE.Vector2(u, v).applyMatrix3(texture.matrix);
      u = wrap(transformed.x, texture.wrapS);
      v = wrap(transformed.y, texture.wrapT);
      const displayV = texture.flipY ? 1 - v : v;
      const fx = Math.min(canvas.width - 1, Math.max(0, u * (canvas.width - 1)));
      const fy = Math.min(canvas.height - 1, Math.max(0, displayV * (canvas.height - 1)));
      if (texture.magFilter === THREE.NearestFilter || texture.minFilter === THREE.NearestFilter) {
        const offset = (Math.round(fy) * canvas.width + Math.round(fx)) * 4;
        return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
      }

      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(canvas.width - 1, x0 + 1);
      const y1 = Math.min(canvas.height - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      const result = [0, 0, 0, 0];
      for (let channel = 0; channel < 4; channel++) {
        const top = pixels[(y0 * canvas.width + x0) * 4 + channel] * (1 - tx) +
          pixels[(y0 * canvas.width + x1) * 4 + channel] * tx;
        const bottom = pixels[(y1 * canvas.width + x0) * 4 + channel] * (1 - tx) +
          pixels[(y1 * canvas.width + x1) * 4 + channel] * tx;
        result[channel] = top * (1 - ty) + bottom * ty;
      }
      return result;
    };
  } catch {
    return null;
  }
}

function imageSpaceUv(texture, uv) {
  let u = uv.x, v = uv.y;
  if (texture) {
    if (texture.matrixAutoUpdate) texture.updateMatrix();
    const transformed = new THREE.Vector2(u, v).applyMatrix3(texture.matrix);
    const wrap = (value, mode) => {
      if (mode === THREE.RepeatWrapping) return ((value % 1) + 1) % 1;
      if (mode === THREE.MirroredRepeatWrapping) {
        const whole = Math.floor(value);
        const fraction = value - whole;
        return Math.abs(whole) % 2 ? 1 - fraction : fraction;
      }
      return Math.max(0, Math.min(1, value));
    };
    u = wrap(transformed.x, texture.wrapS);
    v = wrap(transformed.y, texture.wrapT);
    if (texture.flipY) v = 1 - v;
  } else {
    u = Math.max(0, Math.min(1, u));
    v = 1 - Math.max(0, Math.min(1, v));
  }
  return new THREE.Vector2(u, v);
}

function averageComponentNormal(component) {
  if (!component.records.length) return { normal: new THREE.Vector3(0, 0, 1), planarity: 0 };
  const reference = component.records[0].faceNormal || component.records[0].normal;
  const sum = new THREE.Vector3();
  for (const record of component.records) {
    const normal = record.faceNormal || record.normal;
    sum.addScaledVector(normal, normal.dot(reference) < 0 ? -1 : 1);
  }
  const normal = sum.normalize();
  const planarity = component.records.reduce(
    (total, record) => total + Math.abs((record.faceNormal || record.normal).dot(normal)), 0
  ) / component.records.length;
  return { normal, planarity };
}

function componentProjectionFootprint(component, normal) {
  const helper = Math.abs(normal.x) < 0.9
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3().crossVectors(normal, helper).normalize();
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const record of component.records) {
    for (const point of record.points) {
      const u = point.dot(tangent);
      const v = point.dot(bitangent);
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
  }
  const margin = Math.max(maxU - minU, maxV - minV) * 0.03 + 1e-6;
  return { tangent, bitangent, minU, maxU, minV, maxV, margin };
}

function triangleOverlapsProjectionFootprint(record, footprint) {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const point of record.points) {
    const u = point.dot(footprint.tangent);
    const v = point.dot(footprint.bitangent);
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  return maxU >= footprint.minU - footprint.margin &&
    minU <= footprint.maxU + footprint.margin &&
    maxV >= footprint.minV - footprint.margin &&
    minV <= footprint.maxV + footprint.margin;
}

function interpolateRecordUv(record, barycentric) {
  return new THREE.Vector2(
    record.uvs[0].x * barycentric.x + record.uvs[1].x * barycentric.y + record.uvs[2].x * barycentric.z,
    record.uvs[0].y * barycentric.x + record.uvs[1].y * barycentric.y + record.uvs[2].y * barycentric.z
  );
}

function barycentricTouchesOuterBoundary(record, barycentric, epsilon = 1e-5) {
  const boundary = record.boundaryEdgeFlags;
  if (!boundary) {
    return Math.min(barycentric.x, barycentric.y, barycentric.z) <= epsilon;
  }
  // Barycentric component 0 is opposite edge 1-2, component 1 is
  // opposite edge 2-0, and component 2 is opposite edge 0-1.
  return (barycentric.x <= epsilon && boundary[1]) ||
    (barycentric.y <= epsilon && boundary[2]) ||
    (barycentric.z <= epsilon && boundary[0]);
}

function nearestInteriorProjectionHit(sourceBvh, point, maxDistance = Infinity) {
  const nearest = nearestTriangleInBvh(sourceBvh, point);
  if (!nearest.record || Math.sqrt(nearest.distanceSq) > maxDistance) return null;
  const barycentric = nearest.record.triangle.getBarycoord(nearest.point, new THREE.Vector3());
  // A closest point on the decal's true outer rim is outside its footprint.
  // A closest point on a shared triangle edge is still inside the sheet and
  // must remain eligible, otherwise mesh tessellation appears as pinholes.
  if (barycentricTouchesOuterBoundary(nearest.record, barycentric)) return null;
  return { distance: Math.sqrt(nearest.distanceSq), record: nearest.record, point: nearest.point };
}

function prepareLocalProjection(source, receiverBvh) {
  const bindings = new Map();
  const gaps = [];
  let positive = 0;
  let negative = 0;
  for (const record of source.records) {
    const normal = record.faceNormal || record.normal;
    if (!normal || normal.lengthSq() < 1e-12) continue;
    let best = null;
    for (const sign of [1, -1]) {
      const ray = new THREE.Ray(
        record.centroid,
        normal.clone().normalize().multiplyScalar(sign)
      );
      const hit = raycastTriangleBvh(receiverBvh, ray);
      if (!hit.record) continue;
      const receiverNormal = hit.record.faceNormal || hit.record.normal;
      if (Math.abs(normal.dot(receiverNormal)) < 0.15) continue;
      if (!best || hit.distance < best.distance) best = { ...hit, sign };
    }
    if (!best) continue;
    bindings.set(record, { sign: best.sign, distance: best.distance });
    gaps.push(best.distance);
    if (best.sign > 0) positive++;
    else negative++;
  }

  gaps.sort((a, b) => a - b);
  const percentile = fraction => gaps.length
    ? gaps[Math.min(gaps.length - 1, Math.floor((gaps.length - 1) * fraction))]
    : 0;
  const medianGap = percentile(0.5);
  const highGap = percentile(0.95);
  return {
    bindings,
    defaultSign: positive === negative ? 0 : (positive > negative ? 1 : -1),
    // This range is learned from the selected sheet/receiver pair, so a user
    // can intentionally project a distant sheet without a fixed gap limit.
    maxDistance: gaps.length
      ? Math.max(highGap * 2, medianGap * 4, 1e-5)
      : Infinity,
  };
}

function localNormalProjectionHit(point, receiverNormal, sourceBvh, projection) {
  const candidates = [];
  collectBvhRecordsNear(sourceBvh, point, projection.maxDistance, candidates);
  const projectedPoint = new THREE.Vector3();
  const barycentric = new THREE.Vector3();
  let best = null;

  for (const record of candidates) {
    const localNormal = record.faceNormal || record.normal;
    if (!localNormal || localNormal.lengthSq() < 1e-12) continue;
    if (receiverNormal && Math.abs(localNormal.dot(receiverNormal)) < 0.15) continue;
    const planePoint = record.points[0];
    const signedDistance =
      (planePoint.x - point.x) * localNormal.x +
      (planePoint.y - point.y) * localNormal.y +
      (planePoint.z - point.z) * localNormal.z;
    const distance = Math.abs(signedDistance);
    if (distance > projection.maxDistance) continue;

    const binding = projection.bindings.get(record);
    const sourceToReceiverSign = binding?.sign || projection.defaultSign;
    // If the source triangle was bound to one side of the receiver, only
    // project back toward that same side.
    if (sourceToReceiverSign && signedDistance * sourceToReceiverSign >= 0) continue;

    projectedPoint.copy(point).addScaledVector(localNormal, signedDistance);
    record.triangle.getBarycoord(projectedPoint, barycentric);
    if (Math.min(barycentric.x, barycentric.y, barycentric.z) < -1e-5) continue;
    if (barycentricTouchesOuterBoundary(record, barycentric, 0)) continue;
    if (!best || distance < best.distance) {
      best = { distance, record, point: projectedPoint.clone() };
    }
  }
  // Faceted normals on a curved sheet can leave sub-pixel wedges between two
  // adjacent triangle projections. Nearest-point fallback fills only internal
  // seams; the real outer boundary remains excluded by its topology flags.
  return best || nearestInteriorProjectionHit(sourceBvh, point, projection.maxDistance);
}

function projectionHit(point, receiverNormal, source, sourceBvh, mode, localProjection) {
  if (mode === 'auto' && localProjection) {
    // Automatic mode follows the curved sheet triangle-by-triangle. It does
    // not mix global sheet and receiver directions, which can fan or smear.
    return localNormalProjectionHit(point, receiverNormal, sourceBvh, localProjection);
  }
  const directions = [];
  if (mode === 'closest') {
    directions.length = 0;
  } else if (mode === 'sheet-normal') {
    directions.push(source.averageNormal);
  } else if (mode === 'receiver-normal') {
    directions.push(receiverNormal);
  } else {
    if (source.planarity >= 0.92) directions.push(source.averageNormal);
    directions.push(receiverNormal);
    if (source.planarity < 0.92) directions.push(source.averageNormal);
  }

  let best = null;
  for (const direction of directions) {
    if (!direction || direction.lengthSq() < 1e-12) continue;
    for (const sign of [1, -1]) {
      const ray = new THREE.Ray(point, direction.clone().normalize().multiplyScalar(sign));
      const hit = raycastTriangleBvh(sourceBvh, ray);
      if (hit.record && (!best || hit.distance < best.distance)) best = hit;
    }
  }
  if (best) return best;
  return nearestInteriorProjectionHit(sourceBvh, point);
}

function configureLocalizedBakedTexture(source, target) {
  if (!target) return;
  target.name = `${source?.name || 'Texture'}_DecalPatch`;
  target.colorSpace = source?.colorSpace || THREE.SRGBColorSpace;
  target.flipY = true;
  target.wrapS = THREE.ClampToEdgeWrapping;
  target.wrapT = THREE.ClampToEdgeWrapping;
  target.magFilter = source?.magFilter || THREE.LinearFilter;
  target.minFilter = source?.minFilter || THREE.LinearMipmapLinearFilter;
  target.generateMipmaps = source?.generateMipmaps ?? true;
  target.anisotropy = source?.anisotropy || 1;
}

function uvTriangleBounds(record) {
  const uvs = record.imageUvs || record.uvs;
  return {
    record,
    minX: Math.min(...uvs.map(uv => uv.x)),
    maxX: Math.max(...uvs.map(uv => uv.x)),
    minY: Math.min(...uvs.map(uv => uv.y)),
    maxY: Math.max(...uvs.map(uv => uv.y)),
    layerIndex: 0,
  };
}

function uvTrianglesOverlap(a, b, epsilon = 1e-7) {
  const aUvs = a.imageUvs || a.uvs;
  const bUvs = b.imageUvs || b.uvs;
  for (const triangle of [aUvs, bUvs]) {
    for (let edge = 0; edge < 3; edge++) {
      const start = triangle[edge];
      const end = triangle[(edge + 1) % 3];
      const axisX = -(end.y - start.y);
      const axisY = end.x - start.x;
      const axisLength = Math.hypot(axisX, axisY);
      if (axisLength <= epsilon) continue;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const point of aUvs) {
        const projection = (point.x * axisX + point.y * axisY) / axisLength;
        aMin = Math.min(aMin, projection); aMax = Math.max(aMax, projection);
      }
      for (const point of bUvs) {
        const projection = (point.x * axisX + point.y * axisY) / axisLength;
        bMin = Math.min(bMin, projection); bMax = Math.max(bMax, projection);
      }
      // Sharing an edge or vertex is safe. Only positive-area overlap means
      // these triangles cannot use the same editable texture instance.
      if (Math.min(aMax, bMax) - Math.max(aMin, bMin) <= epsilon) return false;
    }
  }
  return true;
}

function splitIntoNonOverlappingUvLayers(records, epsilon = 1e-7) {
  const sorted = records.map(uvTriangleBounds).sort((a, b) => a.minX - b.minX);
  const active = [];
  const layers = [];
  for (const item of sorted) {
    for (let index = active.length - 1; index >= 0; index--) {
      if (active[index].maxX - item.minX <= epsilon) active.splice(index, 1);
    }
    const unavailableLayers = new Set();
    for (const other of active) {
      if (Math.min(item.maxY, other.maxY) - Math.max(item.minY, other.minY) <= epsilon) continue;
      if (uvTrianglesOverlap(item.record, other.record, epsilon)) {
        unavailableLayers.add(other.layerIndex);
      }
    }
    let layerIndex = 0;
    while (unavailableLayers.has(layerIndex)) layerIndex++;
    item.layerIndex = layerIndex;
    if (!layers[layerIndex]) layers[layerIndex] = [];
    layers[layerIndex].push(item.record);
    active.push(item);
  }
  return layers.filter(Boolean);
}

function splitIntoUvCharts(records) {
  if (records.length <= 1) return records.length ? [records] : [];
  const parent = records.map((_, index) => index);
  const find = index => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const unite = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  };
  const bounds = new THREE.Box3();
  for (const record of records) for (const point of record.points) bounds.expandByPoint(point);
  const positionScale = 1 / Math.max(bounds.getSize(new THREE.Vector3()).length() * 1e-7, 1e-8);
  const uvScale = 1e6;
  const vertexKey = (point, uv) => [
    Math.round(point.x * positionScale),
    Math.round(point.y * positionScale),
    Math.round(point.z * positionScale),
    Math.round(uv.x * uvScale),
    Math.round(uv.y * uvScale),
  ].join(',');
  const edgeOwners = new Map();
  records.forEach((record, recordIndex) => {
    const uvs = record.imageUvs || record.uvs;
    const keys = record.points.map((point, corner) => vertexKey(point, uvs[corner]));
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const edge = keys[a] < keys[b] ? `${keys[a]}|${keys[b]}` : `${keys[b]}|${keys[a]}`;
      const previous = edgeOwners.get(edge);
      if (previous === undefined) edgeOwners.set(edge, recordIndex);
      else unite(recordIndex, previous);
    }
  });
  const charts = new Map();
  records.forEach((record, index) => {
    const root = find(index);
    if (!charts.has(root)) charts.set(root, []);
    charts.get(root).push(record);
  });
  return [...charts.values()];
}

function chartImageBounds(records) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const record of records) {
    for (const uv of record.imageUvs || record.uvs) {
      minX = Math.min(minX, uv.x); maxX = Math.max(maxX, uv.x);
      minY = Math.min(minY, uv.y); maxY = Math.max(maxY, uv.y);
    }
  }
  const width = Math.max(maxX - minX, 1e-6);
  const height = Math.max(maxY - minY, 1e-6);
  const padX = Math.max(width * 0.025, 1e-5);
  const padY = Math.max(height * 0.025, 1e-5);
  return {
    minX: Math.max(0, minX - padX),
    maxX: Math.min(1, maxX + padX),
    minY: Math.max(0, minY - padY),
    maxY: Math.min(1, maxY + padY),
  };
}

function localizeChartUvs(records, bounds) {
  const width = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const height = Math.max(bounds.maxY - bounds.minY, 1e-6);
  for (const record of records) {
    record.localImageUvs = record.imageUvs.map(uv => new THREE.Vector2(
      (uv.x - bounds.minX) / width,
      (uv.y - bounds.minY) / height
    ));
  }
}

function writeLocalizedChartUvs(geometry, records) {
  const uv = geometry.attributes.uv;
  if (!uv) return;
  for (const record of records) {
    for (let corner = 0; corner < 3; corner++) {
      const local = record.localImageUvs[corner];
      uv.setXY(record.triangleIndex * 3 + corner, local.x, 1 - local.y);
    }
  }
  uv.needsUpdate = true;
}

function dilateTexturePadding(state, iterations = 4) {
  const { width, height } = state.canvas;
  let mask = state.coverageMask;
  let pixels = state.imageData.data;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const nextMask = mask.slice();
    const nextPixels = new Uint8ClampedArray(pixels);
    let changed = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (mask[index]) continue;
        let source = -1;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (mask[neighbor]) { source = neighbor; break; }
        }
        if (source < 0) continue;
        nextPixels.set(pixels.subarray(source * 4, source * 4 + 4), index * 4);
        nextMask[index] = 1;
        changed = true;
      }
    }
    mask = nextMask;
    pixels = nextPixels;
    if (!changed) break;
  }
  state.coverageMask = mask;
  state.imageData.data.set(pixels);
}

function rebuildTriangleGroups(geometry, materialIndices) {
  geometry.clearGroups();
  let start = 0;
  let active = materialIndices[0] ?? 0;
  let count = 0;
  const flush = () => {
    if (count > 0) geometry.addGroup(start, count, active);
    start += count;
    count = 0;
  };
  for (const materialIndex of materialIndices) {
    if (materialIndex !== active) {
      flush();
      active = materialIndex;
    }
    count += 3;
  }
  flush();
}

function removeSurfaceComponents(rootObject, components, removedIds) {
  const byMesh = new Map();
  for (const component of components) {
    if (!removedIds.has(component.id)) continue;
    if (!byMesh.has(component.mesh)) byMesh.set(component.mesh, new Set());
    for (const triangleIndex of component.triangleIndices) byMesh.get(component.mesh).add(triangleIndex);
  }

  for (const [mesh, removedTriangles] of byMesh) {
    const geometry = mesh.geometry;
    const triangleCount = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
    if (removedTriangles.size >= triangleCount) {
      mesh.parent?.remove(mesh);
      continue;
    }

    const source = geometry.index ? geometry.toNonIndexed() : geometry;
    const next = new THREE.BufferGeometry();
    const copySelectedAttribute = attribute => {
      const values = [];
      const attributeArray = attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array;
      const ArrayType = attributeArray.constructor;
      const readComponent = (vertexIndex, componentIndex) => attribute.isInterleavedBufferAttribute
        ? attribute.data.array[vertexIndex * attribute.data.stride + attribute.offset + componentIndex]
        : attribute.array[vertexIndex * attribute.itemSize + componentIndex];
      for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
        if (removedTriangles.has(triangleIndex)) continue;
        for (let corner = 0; corner < 3; corner++) {
          const vertexIndex = triangleIndex * 3 + corner;
          for (let componentIndex = 0; componentIndex < attribute.itemSize; componentIndex++) {
            values.push(readComponent(vertexIndex, componentIndex));
          }
        }
      }
      return new THREE.BufferAttribute(
        new ArrayType(values), attribute.itemSize, attribute.normalized
      );
    };
    for (const [name, attribute] of Object.entries(source.attributes)) {
      next.setAttribute(name, copySelectedAttribute(attribute));
    }
    for (const [name, morphAttributes] of Object.entries(source.morphAttributes || {})) {
      next.morphAttributes[name] = morphAttributes.map(copySelectedAttribute);
    }
    next.morphTargetsRelative = source.morphTargetsRelative;

    let groupStart = 0;
    let activeMaterial = null;
    let activeCount = 0;
    const flushGroup = () => {
      if (activeMaterial === null || activeCount === 0) return;
      next.addGroup(groupStart, activeCount, activeMaterial);
      groupStart += activeCount;
      activeCount = 0;
    };
    for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
      if (removedTriangles.has(triangleIndex)) continue;
      const materialIndex = triangleMaterialIndex(geometry, triangleIndex);
      if (activeMaterial !== materialIndex) {
        flushGroup();
        activeMaterial = materialIndex;
      }
      activeCount += 3;
    }
    flushGroup();
    if (Array.isArray(mesh.material)) {
      const usedMaterialIndices = [...new Set(next.groups.map(group => group.materialIndex))];
      const remap = new Map(usedMaterialIndices.map((oldIndex, newIndex) => [oldIndex, newIndex]));
      const usedMaterials = usedMaterialIndices.map(index => mesh.material[index] || mesh.material[0]);
      for (const group of next.groups) group.materialIndex = remap.get(group.materialIndex) || 0;
      mesh.material = usedMaterials.length === 1 ? usedMaterials[0] : usedMaterials;
    }
    next.computeBoundingBox();
    next.computeBoundingSphere();
    mesh.geometry = next;
    mesh._originalGeometry = next.clone();
  }
}

/**
 * Projects selected textured sheets into receiver textures and physically
 * removes successfully baked source geometry from the processed model.
 */
export async function bakeFloatingDecals(rootObject, selections, {
  alphaThreshold = 0.5,
  alphaCutout = true,
  projectionMode = 'auto',
} = {}) {
  if (!rootObject || !Array.isArray(selections) || selections.length === 0) {
    return { baked: 0, removedComponents: 0, details: [] };
  }
  rootObject.updateWorldMatrix(true, true);
  const components = collectSurfaceComponents(rootObject);
  const byId = new Map(components.map(component => [component.id, component]));
  const removedIds = new Set();
  const details = [];
  const selectionsByReceiver = new Map();
  for (const selection of selections) {
    const receiverId = selection.receiverId;
    if (!receiverId) continue;
    if (!selectionsByReceiver.has(receiverId)) selectionsByReceiver.set(receiverId, []);
    selectionsByReceiver.get(receiverId).push(selection);
  }
  const srgbToLinear = value => {
    value /= 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const linearToSrgbByte = value => {
    value = Math.max(0, Math.min(1, value));
    const encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  };

  for (const [receiverId, receiverSelections] of selectionsByReceiver) {
    const receiver = byId.get(receiverId);
    if (!receiver) continue;
    const receiverBvh = buildTriangleBvh(receiver.records.slice());
    if (!receiverBvh) continue;

    const projectionEntries = [];
    let largestSourceTexture = 0;
    for (const selection of receiverSelections) {
      const source = byId.get(selection.sourceId || selection.id);
      if (!source || source === receiver) continue;
      const sourceRecords = source.records.filter(record => record.material?.map);
      const sourceBvh = buildTriangleBvh(sourceRecords.slice());
      const samplers = new Map();
      for (const record of sourceRecords) {
        if (!samplers.has(record.material)) samplers.set(record.material, createImageSampler(record.material));
        const image = record.material?.map?.image;
        largestSourceTexture = Math.max(largestSourceTexture, image?.width || 0, image?.height || 0);
      }
      const orientation = averageComponentNormal(source);
      const entry = {
        selection,
        source,
        sourceBvh,
        samplers,
        projectionSource: {
          ...source,
          averageNormal: orientation.normal,
          planarity: orientation.planarity,
        },
        footprint: componentProjectionFootprint(source, orientation.normal),
        localProjection: prepareLocalProjection(source, receiverBvh),
        pixels: 0,
        error: !sourceBvh || ![...samplers.values()].some(Boolean) ? 'Texture is not ready' : null,
      };
      projectionEntries.push(entry);
    }
    const usableEntries = projectionEntries.filter(entry => !entry.error);
    if (usableEntries.length === 0) {
      for (const entry of projectionEntries) {
        details.push({
          sourceId: entry.source.id,
          receiverId,
          pixels: 0,
          planarity: entry.projectionSource.planarity,
          error: entry.error,
        });
      }
      continue;
    }

    const receiverMesh = receiver.mesh;
    const sourceGeometry = receiverMesh.geometry;
    // Localized chart textures need independent UVs per triangle. Keep the
    // authored triangle order, but detach indexed vertices so changing one UV
    // chart cannot move a shared vertex in another chart.
    const pendingGeometry = sourceGeometry.index
      ? sourceGeometry.toNonIndexed()
      : sourceGeometry.clone();
    const triangleCount = sourceGeometry.index
      ? sourceGeometry.index.count / 3
      : sourceGeometry.attributes.position.count / 3;
    const triangleMaterials = Array.from(
      { length: triangleCount },
      (_, triangleIndex) => triangleMaterialIndex(sourceGeometry, triangleIndex)
    );
    const receiverMaterials = Array.isArray(receiverMesh.material)
      ? [...receiverMesh.material]
      : [receiverMesh.material];
    const recordsByMaterial = new Map();
    for (const record of receiver.records) {
      if (!recordsByMaterial.has(record.materialIndex)) recordsByMaterial.set(record.materialIndex, []);
      recordsByMaterial.get(record.materialIndex).push(record);
    }

    const textureStates = [];
    for (const [materialIndex, records] of recordsByMaterial) {
      const originalMaterial = receiverMaterials[materialIndex] || receiverMaterials[0];
      if (!originalMaterial) continue;
      const baseTexture = originalMaterial._originalMap || originalMaterial.map;
      const imageRecords = records.map(record => ({
        ...record,
        imageUvs: record.uvs.map(uv => imageSpaceUv(baseTexture, uv)),
      }));
      const baseImage = baseTexture?.image;
      const baseWidth = baseImage?.width || 512;
      const baseHeight = baseImage?.height || 512;

      // Isolate continuous UV charts before resolving overlapping islands.
      // This lets a small facial chart use a dedicated high-resolution texture
      // instead of occupying only a few pixels in the full-body atlas.
      for (const chartRecords of splitIntoUvCharts(imageRecords)) {
        for (const layerRecords of splitIntoNonOverlappingUvLayers(chartRecords)) {
          const chartEntries = usableEntries.filter(entry =>
            layerRecords.some(record => triangleOverlapsProjectionFootprint(record, entry.footprint))
          );
          if (chartEntries.length === 0) continue;

          const chartBounds = chartImageBounds(layerRecords);
          localizeChartUvs(layerRecords, chartBounds);
          const cropWidth = Math.max(1, (chartBounds.maxX - chartBounds.minX) * baseWidth);
          const cropHeight = Math.max(1, (chartBounds.maxY - chartBounds.minY) * baseHeight);
          const aspect = cropWidth / cropHeight;
          const desiredMax = Math.min(2048, Math.max(512, largestSourceTexture * 8));
          const width = aspect >= 1
            ? desiredMax
            : Math.max(128, Math.round(desiredMax * aspect));
          const height = aspect >= 1
            ? Math.max(128, Math.round(desiredMax / aspect))
            : desiredMax;
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          context.fillStyle = 'rgb(255,255,255)';
          context.fillRect(0, 0, width, height);
          textureStates.push({
            materialIndex,
            records: layerRecords,
            material: originalMaterial.clone(),
            baseTexture,
            baseSampler: createImageSampler(originalMaterial),
            canvas,
            context,
            imageData: context.getImageData(0, 0, width, height),
            coverageMask: new Uint8Array(width * height),
            paintedMasks: new Map(chartEntries.map(entry => [
              entry,
              new Uint8Array(width * height),
            ])),
            entries: chartEntries,
            chartBounds,
            pixels: 0,
          });
        }
      }
    }

    const projectedBarycentric = new THREE.Vector3();
    const point = new THREE.Vector3();
    const receiverNormal = new THREE.Vector3();
    const originalUv = new THREE.Vector2();
    for (const state of textureStates) {
      const targetIsSrgb = state.baseTexture?.colorSpace === THREE.SRGBColorSpace;
      const targetColor = state.material.color || new THREE.Color(1, 1, 1);
      const targetTint = [targetColor.r, targetColor.g, targetColor.b];
      const uvToPixel = uv => new THREE.Vector2(
        uv.x * (state.canvas.width - 1),
        uv.y * (state.canvas.height - 1)
      );

      for (const record of state.records) {
        const eligibleEntries = state.entries.filter(entry =>
          triangleOverlapsProjectionFootprint(record, entry.footprint)
        );
        const localReceiverNormal = record.faceNormal || record.normal;
        const a = uvToPixel(record.localImageUvs[0]);
        const b = uvToPixel(record.localImageUvs[1]);
        const c = uvToPixel(record.localImageUvs[2]);
        const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
        const maxX = Math.min(state.canvas.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
        const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
        const maxY = Math.min(state.canvas.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
        const denominator = (b.y - c.y) * (a.x - c.x) +
          (c.x - b.x) * (a.y - c.y);
        if (Math.abs(denominator) < 1e-12) continue;

        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5, py = y + 0.5;
            const w0 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) /
              denominator;
            const w1 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) /
              denominator;
            const w2 = 1 - w0 - w1;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;

            originalUv.set(
              record.uvs[0].x * w0 + record.uvs[1].x * w1 + record.uvs[2].x * w2,
              record.uvs[0].y * w0 + record.uvs[1].y * w1 + record.uvs[2].y * w2
            );
            const pixelIndex = y * state.canvas.width + x;
            const offset = (y * state.canvas.width + x) * 4;
            // Neighboring UV triangles share edge texels. Initialize each
            // texel once so a later triangle whose projection narrowly misses
            // cannot erase a decal already painted by its neighbor.
            if (!state.coverageMask[pixelIndex]) {
              const baseSample = state.baseSampler?.(originalUv) || [255, 255, 255, 255];
              state.imageData.data[offset] = baseSample[0];
              state.imageData.data[offset + 1] = baseSample[1];
              state.imageData.data[offset + 2] = baseSample[2];
              state.imageData.data[offset + 3] = baseSample[3] ?? 255;
              state.coverageMask[pixelIndex] = 1;
            }

            if (eligibleEntries.length === 0) continue;
            point.set(0, 0, 0)
              .addScaledVector(record.points[0], w0)
              .addScaledVector(record.points[1], w1)
              .addScaledVector(record.points[2], w2);
            receiverNormal.copy(localReceiverNormal);

            for (const entry of eligibleEntries) {
              const paintedMask = state.paintedMasks.get(entry);
              if (paintedMask?.[pixelIndex]) continue;
              const hit = projectionHit(
                point,
                receiverNormal,
                entry.projectionSource,
                entry.sourceBvh,
                entry.selection.mode || projectionMode,
                entry.localProjection
              );
              if (!hit?.record) continue;
              hit.record.triangle.getBarycoord(hit.point, projectedBarycentric);
              const sourceUv = interpolateRecordUv(hit.record, projectedBarycentric);
              const sample = entry.samplers.get(hit.record.material)?.(sourceUv);
              const rawAlpha = sample
                ? (sample[3] / 255) * (hit.record.material?.opacity ?? 1)
                : 0;
              if (!sample || (alphaCutout && rawAlpha < alphaThreshold)) continue;
              const alpha = hit.record.material?.transparent ? rawAlpha : 1;
              if (alpha <= 0) continue;

              const sourceColor = hit.record.material?.color || new THREE.Color(1, 1, 1);
              const sourceTint = [sourceColor.r, sourceColor.g, sourceColor.b];
              const sourceIsSrgb = hit.record.material?.map?.colorSpace === THREE.SRGBColorSpace;
              for (let channel = 0; channel < 3; channel++) {
                const sourceTexel = sourceIsSrgb
                  ? srgbToLinear(sample[channel])
                  : sample[channel] / 255;
                const targetTexel = targetIsSrgb
                  ? srgbToLinear(state.imageData.data[offset + channel])
                  : state.imageData.data[offset + channel] / 255;
                const bakedTexel = sourceTexel * sourceTint[channel] /
                  Math.max(targetTint[channel], 1e-5);
                const blended = bakedTexel * alpha + targetTexel * (1 - alpha);
                state.imageData.data[offset + channel] = targetIsSrgb
                  ? linearToSrgbByte(blended)
                  : Math.round(Math.max(0, Math.min(1, blended)) * 255);
              }
              state.imageData.data[offset + 3] = 255;
              if (paintedMask) paintedMask[pixelIndex] = 1;
              entry.pixels++;
              state.pixels++;
            }
          }
        }
      }
    }

    const successfulEntries = usableEntries.filter(entry => entry.pixels > 0);
    if (successfulEntries.length > 0) {
      for (const state of textureStates) {
        if (state.pixels === 0) continue;
        dilateTexturePadding(state);
        state.context.putImageData(state.imageData, 0, 0);
        const texture = new THREE.CanvasTexture(state.canvas);
        configureLocalizedBakedTexture(state.baseTexture, texture);
        state.material.map = texture;
        state.material._originalMap = texture;
        state.material.needsUpdate = true;
        const newMaterialIndex = receiverMaterials.length;
        receiverMaterials.push(state.material);
        for (const record of state.records) triangleMaterials[record.triangleIndex] = newMaterialIndex;
        writeLocalizedChartUvs(pendingGeometry, state.records);
      }
      rebuildTriangleGroups(pendingGeometry, triangleMaterials);
      pendingGeometry.computeBoundingBox();
      pendingGeometry.computeBoundingSphere();
      receiverMesh.geometry = pendingGeometry;
      receiverMesh.material = receiverMaterials.length === 1 ? receiverMaterials[0] : receiverMaterials;
      receiverMesh._originalGeometry = pendingGeometry.clone();
      for (const entry of successfulEntries) removedIds.add(entry.source.id);
    }

    for (const entry of projectionEntries) {
      details.push({
        sourceId: entry.source.id,
        receiverId,
        pixels: entry.pixels,
        planarity: entry.projectionSource.planarity,
        ...(entry.error ? { error: entry.error } : {}),
      });
    }

    // Let the UI paint between large receiver components instead of appearing
    // frozen during a multi-decal bake.
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  removeSurfaceComponents(rootObject, components, removedIds);
  return { baked: details.filter(detail => detail.pixels > 0).length, removedComponents: removedIds.size, details };
}

const PALETTE_COVERAGE_BLEND = 0.15;
const PALETTE_CHROMA_COVERAGE_BOOST = 2;
const PALETTE_SELECTION_CHROMA_WEIGHT = 1.5;
const PALETTE_MIN_CANDIDATE_SHARE = 0.0005;
const PALETTE_ACCENT_MIN_SHARE = 0.001;
const PALETTE_CHROMATIC_THRESHOLD = 0.04;
const PALETTE_CANDIDATE_LIMIT = 64;

function srgbByteToLinear(value) {
  const channel = Math.max(0, Math.min(255, value)) / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Converts an sRGB byte triplet to the perceptually uniform OKLab space. */
function srgbSampleToOklab(sample) {
  const red = srgbByteToLinear(sample[0]);
  const green = srgbByteToLinear(sample[1]);
  const blue = srgbByteToLinear(sample[2]);
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabDistanceSquared(left, right) {
  return (left[0] - right[0]) ** 2 +
    (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2;
}

function paletteSelectionDistanceSquared(left, right) {
  return (left[0] - right[0]) ** 2 + PALETTE_SELECTION_CHROMA_WEIGHT * (
    (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2
  );
}

function paletteSampleWeight(sample) {
  const weight = Number(sample?.surfaceWeight);
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function paletteColorBins(samples) {
  const binsByKey = new Map();
  for (const sample of samples || []) {
    if (!sample || sample.length < 3) continue;
    const red = Math.max(0, Math.min(255, Math.round(Number(sample[0]) || 0)));
    const green = Math.max(0, Math.min(255, Math.round(Number(sample[1]) || 0)));
    const blue = Math.max(0, Math.min(255, Math.round(Number(sample[2]) || 0)));
    const key = ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
    let bin = binsByKey.get(key);
    if (!bin) {
      bin = { key, weight: 0, count: 0, red: 0, green: 0, blue: 0 };
      binsByKey.set(key, bin);
    }
    const weight = paletteSampleWeight(sample);
    bin.weight += weight;
    bin.count++;
    bin.red += red * weight;
    bin.green += green * weight;
    bin.blue += blue * weight;
  }
  return [...binsByKey.values()].map(bin => {
    const rgb = [
      Math.round(bin.red / bin.weight),
      Math.round(bin.green / bin.weight),
      Math.round(bin.blue / bin.weight),
    ];
    return { ...bin, rgb, oklab: srgbSampleToOklab(rgb) };
  });
}

function addDistinctPaletteCandidate(result, seen, candidate) {
  if (!candidate || seen.has(candidate.key)) return false;
  seen.add(candidate.key);
  result.push(candidate);
  return true;
}

function paletteCandidates(bins, requestedCount, totalWeight) {
  const adaptiveShare = Math.min(
    PALETTE_MIN_CANDIDATE_SHARE,
    bins.length ? 0.25 / bins.length : PALETTE_MIN_CANDIDATE_SHARE
  );
  let eligible = bins.filter(bin => bin.weight >= totalWeight * adaptiveShare);
  if (eligible.length < requestedCount) eligible = bins.slice();
  const limit = Math.min(eligible.length, Math.max(requestedCount, PALETTE_CANDIDATE_LIMIT));
  if (eligible.length <= limit) return eligible;

  const result = [];
  const seen = new Set();
  const commonLimit = Math.min(Math.ceil(limit * 0.6), eligible.length);
  const byWeight = eligible.slice().sort((left, right) => right.weight - left.weight);
  for (let index = 0; index < commonLimit; index++) {
    addDistinctPaletteCandidate(result, seen, byWeight[index]);
  }

  // Fill the rest of the shortlist with colors that cover perceptual space.
  // Eligibility filtering above keeps isolated low-support noise out.
  while (result.length < limit) {
    let best = null;
    let bestDistance = -1;
    for (const candidate of eligible) {
      if (seen.has(candidate.key)) continue;
      let nearest = Infinity;
      for (const selected of result) {
        nearest = Math.min(nearest, paletteSelectionDistanceSquared(candidate.oklab, selected.oklab));
      }
      if (nearest > bestDistance) {
        bestDistance = nearest;
        best = candidate;
      }
    }
    if (!addDistinctPaletteCandidate(result, seen, best)) break;
  }
  return result;
}

function assignPaletteObjectiveWeights(bins) {
  const totalWeight = bins.reduce((sum, bin) => sum + bin.weight, 0);
  const coverageWeights = bins.map(bin => {
    const chroma = Math.hypot(bin.oklab[1], bin.oklab[2]);
    return 1 + PALETTE_CHROMA_COVERAGE_BOOST * (1 - Math.exp(-chroma / 0.08));
  });
  const totalCoverageWeight = coverageWeights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < bins.length; index++) {
    const frequencyWeight = bins[index].weight / totalWeight;
    const coverageWeight = coverageWeights[index] / totalCoverageWeight;
    bins[index].objectiveWeight = (1 - PALETTE_COVERAGE_BLEND) * frequencyWeight +
      PALETTE_COVERAGE_BLEND * coverageWeight;
  }
  return totalWeight;
}

/**
 * Ranks representative source colors that would add the most coverage to an
 * existing palette. This is the seeded counterpart to palette generation and
 * is used by the UI to expose useful "next color" choices without replacing
 * any colors the user has already edited.
 */
export function suggestPaletteColorsFromSamples(samples, currentPalette = [], count = 6) {
  const bins = paletteColorBins(samples);
  const requestedCount = Math.max(0, Math.floor(Number(count) || 0));
  if (!bins.length || requestedCount === 0) return [];

  const totalWeight = assignPaletteObjectiveWeights(bins);
  const candidates = paletteCandidates(
    bins,
    Math.min(bins.length, currentPalette.length + requestedCount),
    totalWeight
  );
  const currentLabs = (currentPalette || [])
    .filter(color => color?.length >= 3)
    .map(srgbSampleToOklab);
  const nearestDistances = new Float64Array(bins.length);
  for (let index = 0; index < bins.length; index++) {
    nearestDistances[index] = currentLabs.length
      ? currentLabs.reduce((nearest, color) => Math.min(
        nearest,
        paletteSelectionDistanceSquared(bins[index].oklab, color)
      ), Infinity)
      : Infinity;
  }

  const suggestions = [];
  const usedKeys = new Set();
  while (suggestions.length < Math.min(requestedCount, candidates.length)) {
    let best = null;
    let bestScore = currentLabs.length || suggestions.length ? -1 : Infinity;
    for (const candidate of candidates) {
      if (usedKeys.has(candidate.key)) continue;
      // Avoid offering an imperceptible duplicate of an existing custom color.
      if (currentLabs.some(color => paletteSelectionDistanceSquared(candidate.oklab, color) < 0.0001)) {
        usedKeys.add(candidate.key);
        continue;
      }
      let score = 0;
      for (let index = 0; index < bins.length; index++) {
        const distance = paletteSelectionDistanceSquared(bins[index].oklab, candidate.oklab);
        score += bins[index].objectiveWeight * (currentLabs.length || suggestions.length
          ? Math.max(0, nearestDistances[index] - distance)
          : distance);
      }
      if ((currentLabs.length || suggestions.length) ? score > bestScore : score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (!best) break;
    suggestions.push([...best.rgb]);
    usedKeys.add(best.key);
    for (let index = 0; index < bins.length; index++) {
      nearestDistances[index] = Math.min(
        nearestDistances[index],
        paletteSelectionDistanceSquared(bins[index].oklab, best.oklab)
      );
    }
  }
  return suggestions;
}

/**
 * Selects a surface-aware palette in OKLab. The facility-location objective
 * retains real area as the main signal while a smaller coverage term gives
 * supported accent colors a chance to represent their part of color space.
 * Entries stay on representative sampled colors instead of muddy cluster means.
 */
export function quantizePaletteFromSamples(samples, k = 5) {
  if (!samples || samples.length === 0) return [[0, 0, 0], [255, 255, 255]];
  k = Math.max(2, Math.min(Math.floor(Number(k) || 2), samples.length));
  const bins = paletteColorBins(samples);
  if (!bins.length) return [[0, 0, 0], [255, 255, 255]];

  const totalWeight = assignPaletteObjectiveWeights(bins);

  const candidates = paletteCandidates(bins, k, totalWeight);
  const selected = [];
  const selectedKeys = new Set();
  const nearestDistances = new Float64Array(bins.length);
  nearestDistances.fill(Infinity);

  while (selected.length < Math.min(k, candidates.length)) {
    let best = null;
    let bestScore = selected.length ? -1 : Infinity;
    for (const candidate of candidates) {
      if (selectedKeys.has(candidate.key)) continue;
      let score = 0;
      for (let index = 0; index < bins.length; index++) {
        const distance = paletteSelectionDistanceSquared(bins[index].oklab, candidate.oklab);
        score += bins[index].objectiveWeight * (selected.length
          ? Math.max(0, nearestDistances[index] - distance)
          : distance);
      }
      if ((selected.length && score > bestScore) || (!selected.length && score < bestScore)) {
        bestScore = score;
        best = candidate;
      }
    }
    if (!best) break;
    selected.push(best);
    selectedKeys.add(best.key);
    for (let index = 0; index < bins.length; index++) {
      nearestDistances[index] = Math.min(
        nearestDistances[index],
        paletteSelectionDistanceSquared(bins[index].oklab, best.oklab)
      );
    }
  }

  // A long neutral ramp can otherwise spend every slot on lightness levels.
  // Reserve one slot for a supported chromatic region when the greedy result
  // contains only neutrals. The support threshold prevents isolated pixels
  // from being promoted merely because they are saturated.
  const selectedHasChroma = selected.some(bin => Math.hypot(bin.oklab[1], bin.oklab[2]) >= PALETTE_CHROMATIC_THRESHOLD);
  const accentCandidates = candidates.filter(bin =>
    bin.weight >= totalWeight * PALETTE_ACCENT_MIN_SHARE &&
    Math.hypot(bin.oklab[1], bin.oklab[2]) >= PALETTE_CHROMATIC_THRESHOLD
  );
  if (k > 1 && selected.length > 1 && !selectedHasChroma && accentCandidates.length) {
    const retained = selected.slice(0, -1);
    let bestAccent = null;
    let bestCost = Infinity;
    for (const candidate of accentCandidates) {
      let cost = 0;
      for (const bin of bins) {
        let nearest = paletteSelectionDistanceSquared(bin.oklab, candidate.oklab);
        for (const center of retained) {
          nearest = Math.min(nearest, paletteSelectionDistanceSquared(bin.oklab, center.oklab));
        }
        cost += bin.objectiveWeight * nearest;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestAccent = candidate;
      }
    }
    if (bestAccent) selected[selected.length - 1] = bestAccent;
  }

  // Preserve the requested palette length when the source contains fewer
  // distinct color buckets, matching the previous API contract.
  while (selected.length < k) selected.push(selected[selected.length % Math.max(1, selected.length)] || bins[0]);
  return selected.map(bin => [...bin.rgb]);
}

/**
 * Extracts a coverage-aware perceptual palette from an image.
 */
export function quantizePalette(image, k = 5) {
  const canvas = document.createElement('canvas');
  const maxDim = PALETTE_TEXTURE_SAMPLE_DIMENSION;
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

function colorToSrgbSample(color) {
  if (!color) return null;
  const srgb = { r: 0, g: 0, b: 0 };
  color.getRGB(srgb, THREE.SRGBColorSpace);
  return [
    Math.round(srgb.r * 255),
    Math.round(srgb.g * 255),
    Math.round(srgb.b * 255),
  ];
}

function materialColorSample(material) {
  return colorToSrgbSample(material?.color);
}

function setMaterialColorFromSample(material, sample) {
  material.color.setRGB(
    sample[0] / 255,
    sample[1] / 255,
    sample[2] / 255,
    THREE.SRGBColorSpace
  );
}

function srgbChannelToLinear(value) {
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(value) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function effectiveTexturePixelSample(data, offset, texture, baseColor) {
  const isSrgb = texture?.colorSpace === THREE.SRGBColorSpace;
  const red = data[offset] / 255;
  const green = data[offset + 1] / 255;
  const blue = data[offset + 2] / 255;
  return [
    Math.round(linearChannelToSrgb((isSrgb ? srgbChannelToLinear(red) : red) * baseColor.r) * 255),
    Math.round(linearChannelToSrgb((isSrgb ? srgbChannelToLinear(green) : green) * baseColor.g) * 255),
    Math.round(linearChannelToSrgb((isSrgb ? srgbChannelToLinear(blue) : blue) * baseColor.b) * 255),
  ];
}

const MAX_SURFACE_COLOR_SAMPLES = 32768;
const MIN_SURFACE_SAMPLES_PER_MATERIAL = 64;
const PALETTE_TEXTURE_SAMPLE_DIMENSION = 512;

function isObjectVisible(object) {
  for (let current = object; current; current = current.parent) {
    if (current.visible === false) return false;
  }
  return true;
}

function textureRaster(texture, maxDimension = PALETTE_TEXTURE_SAMPLE_DIMENSION) {
  const image = texture?.image;
  const sourceWidth = Math.floor(Number(image?.width) || 0);
  const sourceHeight = Math.floor(Number(image?.height) || 0);
  if (!image || sourceWidth < 1 || sourceHeight < 1) return null;
  if (texture.matrixAutoUpdate !== false) texture.updateMatrix();

  if (image.data && image.data.length >= sourceWidth * sourceHeight) {
    return {
      data: image.data,
      width: sourceWidth,
      height: sourceHeight,
      channels: Math.max(1, Math.floor(image.data.length / (sourceWidth * sourceHeight))),
      texture,
    };
  }

  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.floor(sourceWidth * scale));
  const height = Math.max(1, Math.floor(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, width, height);
  return {
    data: context.getImageData(0, 0, width, height).data,
    width,
    height,
    channels: 4,
    texture,
  };
}

function interpolatedTexturePixel(raster, geometry, i0, i1, i2, weights) {
  if (!raster) return null;
  const texture = raster.texture;
  const channel = Math.max(0, Math.floor(Number(texture.channel) || 0));
  const uv = geometry.getAttribute(channel === 0 ? 'uv' : `uv${channel}`);
  let u = 0;
  let v = 0;
  if (uv) {
    u = uv.getX(i0) * weights[0] + uv.getX(i1) * weights[1] + uv.getX(i2) * weights[2];
    v = uv.getY(i0) * weights[0] + uv.getY(i1) * weights[1] + uv.getY(i2) * weights[2];
  }

  const matrix = texture.matrix?.elements;
  if (matrix) {
    const transformedU = matrix[0] * u + matrix[3] * v + matrix[6];
    v = matrix[1] * u + matrix[4] * v + matrix[7];
    u = transformedU;
  }
  u = wrappedTextureCoordinate(u, texture.wrapS ?? THREE.ClampToEdgeWrapping);
  v = wrappedTextureCoordinate(v, texture.wrapT ?? THREE.ClampToEdgeWrapping);
  const x = Math.min(raster.width - 1, Math.max(0, Math.floor(u * raster.width)));
  const finalV = (texture.flipY ?? true) ? 1 - v : v;
  const y = Math.min(raster.height - 1, Math.max(0, Math.floor(finalV * raster.height)));
  const offset = (y * raster.width + x) * raster.channels;
  const red = raster.data[offset] ?? 0;
  const green = raster.channels > 1 ? raster.data[offset + 1] : red;
  const blue = raster.channels > 2 ? raster.data[offset + 2] : red;
  const alpha = raster.channels > 3 ? raster.data[offset + 3] : 255;
  return [red, green, blue, alpha];
}

function effectiveSurfaceColor(
  material,
  geometry,
  indices,
  weights,
  mapRaster,
  alphaRaster,
  instanceColor = null
) {
  const baseColor = material._originalColor || material.color || new THREE.Color(1, 1, 1);
  const linearColor = baseColor.clone();
  let alpha = material.opacity ?? 1;
  const texturePixel = interpolatedTexturePixel(
    mapRaster, geometry, indices[0], indices[1], indices[2], weights
  );
  if (texturePixel) {
    const textureColor = new THREE.Color();
    textureColor.setRGB(
      texturePixel[0] / 255,
      texturePixel[1] / 255,
      texturePixel[2] / 255,
      mapRaster.texture.colorSpace === THREE.SRGBColorSpace
        ? THREE.SRGBColorSpace
        : THREE.LinearSRGBColorSpace
    );
    linearColor.multiply(textureColor);
    alpha *= texturePixel[3] / 255;
  }

  const vertexColor = material.vertexColors ? geometry.getAttribute('color') : null;
  if (vertexColor) {
    linearColor.r *= vertexColor.getX(indices[0]) * weights[0] +
      vertexColor.getX(indices[1]) * weights[1] + vertexColor.getX(indices[2]) * weights[2];
    linearColor.g *= vertexColor.getY(indices[0]) * weights[0] +
      vertexColor.getY(indices[1]) * weights[1] + vertexColor.getY(indices[2]) * weights[2];
    linearColor.b *= vertexColor.getZ(indices[0]) * weights[0] +
      vertexColor.getZ(indices[1]) * weights[1] + vertexColor.getZ(indices[2]) * weights[2];
    if (vertexColor.itemSize > 3) {
      alpha *= vertexColor.getW(indices[0]) * weights[0] +
        vertexColor.getW(indices[1]) * weights[1] + vertexColor.getW(indices[2]) * weights[2];
    }
  }

  if (instanceColor) linearColor.multiply(instanceColor);

  const alphaPixel = interpolatedTexturePixel(
    alphaRaster, geometry, indices[0], indices[1], indices[2], weights
  );
  if (alphaPixel) alpha *= alphaPixel[1] / 255;
  const alphaCutoff = Math.max(0, material.alphaTest || 0);
  if (alpha <= 0.001 || (alphaCutoff > 0 && alpha < alphaCutoff)) return null;
  return colorToSrgbSample(linearColor);
}

/**
 * Samples the authored base color at a Three.js raycast intersection. Unlike a
 * screen eyedropper, this composes the original base-color texture, material
 * factor, vertex color, and instance color without lights or tone mapping.
 */
export function sampleAuthoredSurfaceColor(mesh, intersection, {
  maxTextureDimension = PALETTE_TEXTURE_SAMPLE_DIMENSION,
} = {}) {
  if (!mesh?.isMesh || !intersection?.face || !mesh.geometry || !isObjectVisible(mesh)) return null;
  const material = materialAt(mesh, intersection.face.materialIndex || 0);
  if (!material || material.visible === false) return null;
  const weights = intersection.barycoord
    ? [intersection.barycoord.x, intersection.barycoord.y, intersection.barycoord.z]
    : [1 / 3, 1 / 3, 1 / 3];
  let instanceColor = null;
  if (mesh.isInstancedMesh && mesh.instanceColor && Number.isInteger(intersection.instanceId)) {
    instanceColor = new THREE.Color();
    mesh.getColorAt(intersection.instanceId, instanceColor);
  }
  return effectiveSurfaceColor(
    material,
    mesh.geometry,
    [intersection.face.a, intersection.face.b, intersection.face.c],
    weights,
    textureRaster(material._originalMap || material.map, maxTextureDimension),
    textureRaster(material.alphaMap, maxTextureDimension),
    instanceColor
  );
}

function forEachRenderableTriangle(rootObject, callback) {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const instanceMatrix = new THREE.Matrix4();
  const worldMatrix = new THREE.Matrix4();
  const instanceColor = new THREE.Color();
  rootObject.traverse(mesh => {
    if (!mesh.isMesh || !mesh.geometry || !isObjectVisible(mesh)) return;
    if (mesh.isBatchedMesh) {
      throw new Error('Batched meshes are not supported. Convert the model to ordinary mesh geometry before importing.');
    }
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    if (!position) return;
    const index = geometry.index;
    const triangleCount = Math.floor((index ? index.count : position.count) / 3);
    const drawStart = Math.max(0, Math.floor((geometry.drawRange?.start || 0) / 3));
    const drawCount = Number.isFinite(geometry.drawRange?.count)
      ? Math.max(0, Math.floor(geometry.drawRange.count / 3))
      : triangleCount;
    const drawEnd = Math.min(triangleCount, drawStart + drawCount);
    const instanceCount = mesh.isInstancedMesh ? mesh.count : 1;
    mesh.skeleton?.update?.();

    for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex++) {
      if (mesh.isInstancedMesh) {
        mesh.getMatrixAt(instanceIndex, instanceMatrix);
        worldMatrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
      } else {
        worldMatrix.copy(mesh.matrixWorld);
      }
      const reversesWinding = worldMatrix.determinant() < 0;
      const tint = mesh.isInstancedMesh && mesh.instanceColor
        ? (mesh.getColorAt(instanceIndex, instanceColor), instanceColor.clone())
        : null;

      for (let triangleIndex = drawStart; triangleIndex < drawEnd; triangleIndex++) {
        const material = materialAt(mesh, triangleMaterialIndex(geometry, triangleIndex));
        if (!material || material.visible === false) continue;
        const indices = [
          index ? index.getX(triangleIndex * 3) : triangleIndex * 3,
          index ? index.getX(triangleIndex * 3 + 1) : triangleIndex * 3 + 1,
          index ? index.getX(triangleIndex * 3 + 2) : triangleIndex * 3 + 2,
        ];
        if (reversesWinding) [indices[1], indices[2]] = [indices[2], indices[1]];
        mesh.getVertexPosition(indices[0], a).applyMatrix4(worldMatrix);
        mesh.getVertexPosition(indices[1], b).applyMatrix4(worldMatrix);
        mesh.getVertexPosition(indices[2], c).applyMatrix4(worldMatrix);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        const area = ab.cross(ac).length() * 0.5;
        if (area > 0 && Number.isFinite(area)) callback({
          mesh,
          geometry,
          material,
          indices,
          area,
          positions: [a.clone(), b.clone(), c.clone()],
          instanceColor: tint,
          instanceIndex,
        });
      }
    }
  });
}

/**
 * Samples authored surface colors in proportion to their world-space area.
 * A small per-material floor keeps tiny accents eligible for palette clustering.
 */
export function sampleModelSurfaceColors(rootObject, {
  maxSamples = MAX_SURFACE_COLOR_SAMPLES,
  minSamplesPerMaterial = MIN_SURFACE_SAMPLES_PER_MATERIAL,
  maxTextureDimension = PALETTE_TEXTURE_SAMPLE_DIMENSION,
} = {}) {
  if (!rootObject) return [];
  rootObject.updateWorldMatrix(true, true);
  const states = new Map();
  forEachRenderableTriangle(rootObject, ({ material, area, instanceColor }) => {
    let state = states.get(material);
    if (!state) {
      state = { material, area: 0, target: 0, generated: 0, traversedArea: 0, nextArea: 0 };
      states.set(material, state);
    }
    state.area += area;
  });

  const activeStates = [...states.values()].filter(state => state.area > 0);
  if (!activeStates.length) return [];
  const budget = Math.max(activeStates.length, Math.floor(Number(maxSamples) || 1));
  const minimum = Math.max(0, Math.min(
    Math.floor(Number(minSamplesPerMaterial) || 0),
    Math.floor(budget / activeStates.length)
  ));
  const totalArea = activeStates.reduce((sum, state) => sum + state.area, 0);
  const remaining = budget - minimum * activeStates.length;
  for (const state of activeStates) {
    const exactShare = remaining * state.area / totalArea;
    state.target = minimum + Math.floor(exactShare);
    state.remainder = exactShare - Math.floor(exactShare);
  }
  let assigned = activeStates.reduce((sum, state) => sum + state.target, 0);
  const remainderOrder = activeStates.slice().sort((left, right) => right.remainder - left.remainder);
  for (let index = 0; assigned < budget; index++, assigned++) {
    remainderOrder[index % remainderOrder.length].target++;
  }
  for (const state of activeStates) {
    state.spacing = state.area / state.target;
    state.nextArea = state.spacing * 0.5;
  }

  const textureRasters = new Map();
  const rasterFor = texture => {
    if (!texture?.image) return null;
    if (!textureRasters.has(texture)) {
      textureRasters.set(texture, textureRaster(texture, maxTextureDimension));
    }
    return textureRasters.get(texture);
  };
  const samples = [];
  forEachRenderableTriangle(rootObject, ({ geometry, material, indices, area, instanceColor }) => {
    const state = states.get(material);
    const endArea = state.traversedArea + area;
    while (state.generated < state.target && state.nextArea <= endArea + Number.EPSILON) {
      const sequence = state.generated + 1;
      const first = (sequence * 0.7548776662466927) % 1;
      const second = (sequence * 0.5698402909980532) % 1;
      const root = Math.sqrt(first);
      const weights = [1 - root, root * (1 - second), root * second];
      const sample = effectiveSurfaceColor(
        material,
        geometry,
        indices,
        weights,
        rasterFor(material._originalMap || material.map),
        rasterFor(material.alphaMap),
        instanceColor
      );
      if (sample) {
        // A material's minimum sample count is for color discovery only. Keep
        // its real world-space area as a separate weight so the floor does not
        // pretend that every tiny material covers the same amount of surface.
        Object.defineProperty(sample, 'surfaceWeight', {
          value: state.spacing,
          enumerable: false,
        });
        samples.push(sample);
      }
      state.generated++;
      state.nextArea = state.spacing * (state.generated + 0.5);
    }
    state.traversedArea = endArea;
  });
  return samples;
}

// Texture processing keeps several byte-per-pixel buffers alive at once: the
// canvas, ImageData, palette labels, and (when enabled) cleanup workspaces.
// Use a coarse device-memory budget instead of silently imposing a fixed
// dimension. The returned sizes always preserve the source aspect ratio.
const TEXTURE_PROCESSING_BYTES_PER_PIXEL = 16;
const MAX_SAFE_CANVAS_DIMENSION = 16384;

function defaultTextureProcessingPixelBudget() {
  const deviceMemoryGb = typeof navigator !== 'undefined' && Number.isFinite(navigator.deviceMemory)
    ? navigator.deviceMemory
    : 4;
  let budgetMb = 256;
  if (deviceMemoryGb <= 2) budgetMb = 128;
  else if (deviceMemoryGb >= 16) budgetMb = 768;
  else if (deviceMemoryGb >= 8) budgetMb = 512;
  return Math.floor((budgetMb * 1024 * 1024) / TEXTURE_PROCESSING_BYTES_PER_PIXEL);
}

/**
 * Plans proportional working sizes for a set of textures under one shared
 * memory budget. Full source resolution is retained whenever it fits.
 */
export function planTextureWorkingSizes(
  sources,
  { maxPixels = defaultTextureProcessingPixelBudget(), maxDimension = MAX_SAFE_CANVAS_DIMENSION } = {}
) {
  const normalized = (sources || []).map(source => ({
    width: Math.max(1, Math.floor(Number(source?.width) || 1)),
    height: Math.max(1, Math.floor(Number(source?.height) || 1)),
  }));
  if (normalized.length === 0) return [];

  const safeMaxPixels = Math.max(1, Number(maxPixels) || 1);
  const safeMaxDimension = Math.max(1, Number(maxDimension) || 1);
  const totalPixels = normalized.reduce((sum, size) => sum + size.width * size.height, 0);
  const sharedScale = Math.min(1, Math.sqrt(safeMaxPixels / Math.max(1, totalPixels)));

  return normalized.map(source => {
    const dimensionScale = Math.min(
      1,
      safeMaxDimension / source.width,
      safeMaxDimension / source.height
    );
    const scale = Math.min(sharedScale, dimensionScale);
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    return {
      sourceWidth: source.width,
      sourceHeight: source.height,
      width,
      height,
      scale,
      downsampled: width !== source.width || height !== source.height,
    };
  });
}

function closestPaletteIndex(sample, palette, paletteOklab = null) {
  const source = srgbSampleToOklab(sample);
  const perceptualPalette = paletteOklab || palette.map(srgbSampleToOklab);
  let minDistance = Infinity;
  let bestIndex = 0;
  for (let index = 0; index < perceptualPalette.length; index++) {
    const distance = oklabDistanceSquared(source, perceptualPalette[index]);
    if (distance < minDistance) {
      minDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

/**
 * Fast 5-bit RGB Lookup Table that maps RGB -> palette index (0..k-1),
 * using the same perceptual metric as palette generation.
 */
function createIndexLUT(palette) {
  const key = palette.map(color => color.join(',')).join(';');
  const cached = paletteLutCache.get(key);
  if (cached) {
    paletteLutCache.delete(key);
    paletteLutCache.set(key, cached);
    return cached;
  }
  const lut = new Uint8Array(32768);
  const perceptualPalette = palette.map(srgbSampleToOklab);
  for (let r = 0; r < 32; r++) {
    const rVal = (r << 3) | (r >> 2);
    for (let g = 0; g < 32; g++) {
      const gVal = (g << 3) | (g >> 2);
      for (let b = 0; b < 32; b++) {
        const bVal = (b << 3) | (b >> 2);
        lut[(r << 10) | (g << 5) | b] = closestPaletteIndex(
          [rVal, gVal, bVal], palette, perceptualPalette
        );
      }
    }
  }
  paletteLutCache.set(key, lut);
  if (paletteLutCache.size > 32) {
    paletteLutCache.delete(paletteLutCache.keys().next().value);
  }
  return lut;
}

const paletteLutCache = new Map();

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

        if (cx > 0) {
          const nIdx = curr - 1;
          const nColor = labels[nIdx];
          if (nColor === color) {
            if (!visited[nIdx]) {
              visited[nIdx] = 1;
              queue[tail++] = nIdx;
            }
          } else borderVotes[nColor]++;
        }
        if (cx < width - 1) {
          const nIdx = curr + 1;
          const nColor = labels[nIdx];
          if (nColor === color) {
            if (!visited[nIdx]) {
              visited[nIdx] = 1;
              queue[tail++] = nIdx;
            }
          } else borderVotes[nColor]++;
        }
        if (cy > 0) {
          const nIdx = curr - width;
          const nColor = labels[nIdx];
          if (nColor === color) {
            if (!visited[nIdx]) {
              visited[nIdx] = 1;
              queue[tail++] = nIdx;
            }
          } else borderVotes[nColor]++;
        }
        if (cy < height - 1) {
          const nIdx = curr + width;
          const nColor = labels[nIdx];
          if (nColor === color) {
            if (!visited[nIdx]) {
              visited[nIdx] = 1;
              queue[tail++] = nIdx;
            }
          } else borderVotes[nColor]++;
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
function recordSmoothingVote(votes, touchedColors, touchedCount, color, amount = 1) {
  if (votes[color] === 0) touchedColors[touchedCount++] = color;
  votes[color] += amount;
  return touchedCount;
}

function smoothBoundaries(labels, width, height, passes, numColors) {
  if (passes <= 0) return labels;
  let src = labels;
  let dst = new Uint8Array(width * height);
  const votes = new Int32Array(numColors);
  const touchedColors = new Int32Array(10);

  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < height; y++) {
      const yOffset = y * width;
      const yPrev = y > 0 ? (y - 1) * width : yOffset;
      const yNext = y < height - 1 ? (y + 1) * width : yOffset;

      for (let x = 0; x < width; x++) {
        const currIdx = yOffset + x;
        const selfColor = src[currIdx];
        let touchedCount = 0;

        const xPrev = x > 0 ? x - 1 : x;
        const xNext = x < width - 1 ? x + 1 : x;

        touchedCount = recordSmoothingVote(votes, touchedColors, touchedCount, src[yPrev + xPrev]);
        touchedCount = recordSmoothingVote(votes, touchedColors, touchedCount, src[yPrev + x]);
        touchedCount = recordSmoothingVote(votes, touchedColors, touchedCount, src[yPrev + xNext]);
        touchedCount = recordSmoothingVote(votes, touchedColors, touchedCount, src[yOffset + xPrev]);
        touchedCount = recordSmoothingVote(votes, touchedColors, touchedCount, selfColor, 2);
        touchedCount = recordSmoothingVote(votes, touchedColors, touchedCount, src[yOffset + xNext]);
        touchedCount = recordSmoothingVote(votes, touchedColors, touchedCount, src[yNext + xPrev]);
        touchedCount = recordSmoothingVote(votes, touchedColors, touchedCount, src[yNext + x]);
        touchedCount = recordSmoothingVote(votes, touchedColors, touchedCount, src[yNext + xNext]);

        let maxVotes = -1;
        let bestColor = selfColor;
        for (let i = 0; i < touchedCount; i++) {
          const color = touchedColors[i];
          if (votes[color] > maxVotes ||
            (votes[color] === maxVotes && color < bestColor)) {
            maxVotes = votes[color];
            bestColor = color;
          }
        }
        for (let i = 0; i < touchedCount; i++) {
          votes[touchedColors[i]] = 0;
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

export function processTextureLabels(
  labels,
  width,
  height,
  numColors,
  despeckleSize = 0,
  smoothLevel = 0
) {
  let processed = labels;
  if (despeckleSize > 0) {
    processed = despeckleLabels(processed, width, height, despeckleSize, numColors);
  }
  if (smoothLevel > 0) {
    processed = smoothBoundaries(processed, width, height, smoothLevel, numColors);
  }
  return processed;
}

/**
 * Smartly resizes a palette without resetting user edits:
 * - Trimming keeps existing colors intact.
 * - Expanding keeps existing colors and appends new distinct model colors.
 */
function adjustPaletteSize(existingPalette, samples, targetCount) {
  if (!existingPalette || existingPalette.length === 0) {
    return quantizePaletteFromSamples(samples, targetCount);
  }

  // Trimming (e.g. 5 -> 4): keep the first 4 intact
  if (existingPalette.length >= targetCount) {
    return existingPalette.slice(0, targetCount);
  }

  // Expanding (e.g. 4 -> 5): keep existing, add new distinct colors
  const fresh = quantizePaletteFromSamples(samples, targetCount);
  const result = existingPalette.map(c => [...c]);

  for (const f of fresh) {
    if (result.length >= targetCount) break;
    const isDuplicate = result.some(c => {
      return oklabDistanceSquared(srgbSampleToOklab(c), srgbSampleToOklab(f)) < 0.0004;
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

function setVertexColorPaletteShader(material, palette, enabled) {
  if (!material.vertexColors && !material._texture2PaintHasInstanceColor) return;
  if (!material._texture2PaintShaderOriginal) {
    material._texture2PaintShaderOriginal = {
      onBeforeCompile: material.onBeforeCompile,
      customProgramCacheKey: material.customProgramCacheKey,
      shader: null,
      colors: [],
    };
  }
  const original = material._texture2PaintShaderOriginal;
  if (!enabled) {
    if (!material._vertexQuantizationEnabled) return;
    material.onBeforeCompile = original.onBeforeCompile;
    material.customProgramCacheKey = original.customProgramCacheKey;
    original.shader = null;
    material._vertexQuantizationEnabled = false;
    material.needsUpdate = true;
    return;
  }
  const colors = palette.slice(0, 32).map(sample => {
    const color = new THREE.Color();
    color.setRGB(sample[0] / 255, sample[1] / 255, sample[2] / 255, THREE.SRGBColorSpace);
    return color;
  });
  original.colors = colors;
  if (original.shader) {
    original.shader.uniforms.texture2PaintPalette.value = colors;
    original.shader.uniforms.texture2PaintPaletteCount.value = colors.length;
  }
  if (material._vertexQuantizationEnabled) return;
  material.onBeforeCompile = shader => {
    original.onBeforeCompile?.call(material, shader);
    original.shader = shader;
    shader.uniforms.texture2PaintPalette = { value: original.colors };
    shader.uniforms.texture2PaintPaletteCount = { value: original.colors.length };
    shader.fragmentShader = `
uniform vec3 texture2PaintPalette[32];
uniform int texture2PaintPaletteCount;
${shader.fragmentShader}`.replace('#include <color_fragment>', `
#include <color_fragment>
float texture2PaintBestDistance = 1e20;
vec3 texture2PaintBestColor = diffuseColor.rgb;
for (int texture2PaintIndex = 0; texture2PaintIndex < 32; texture2PaintIndex++) {
  if (texture2PaintIndex >= texture2PaintPaletteCount) break;
  vec3 texture2PaintDelta = diffuseColor.rgb - texture2PaintPalette[texture2PaintIndex];
  float texture2PaintDistance = dot(texture2PaintDelta, texture2PaintDelta);
  if (texture2PaintDistance < texture2PaintBestDistance) {
    texture2PaintBestDistance = texture2PaintDistance;
    texture2PaintBestColor = texture2PaintPalette[texture2PaintIndex];
  }
}
diffuseColor.rgb = texture2PaintBestColor;
`);
  };
  material.customProgramCacheKey = () => `${original.customProgramCacheKey?.call(material) || ''}|texture2paint:vertex-palette-v1`;
  material._vertexQuantizationEnabled = true;
  material.needsUpdate = true;
}

function paintQuantizedTexture(material, cache, sourceMap, palette, labels, plannedSize, rootObject) {
  const { canvas, context, imageData } = cache;
  const data = imageData.data;
  data.set(cache.sourceData);
  for (let offset = 0, pixel = 0; offset < data.length; offset += 4, pixel++) {
    const color = palette[labels[pixel]];
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
  }
  context.putImageData(imageData, 0, 0);

  const texture = cache.texture || new THREE.CanvasTexture(canvas);
  cache.texture = texture;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = sourceMap.flipY;
  texture.wrapS = sourceMap.wrapS;
  texture.wrapT = sourceMap.wrapT;
  texture.offset.copy(sourceMap.offset);
  texture.repeat.copy(sourceMap.repeat);
  texture.center.copy(sourceMap.center);
  texture.rotation = sourceMap.rotation;
  texture.channel = sourceMap.channel;
  texture.magFilter = sourceMap.magFilter;
  texture.minFilter = sourceMap.minFilter;
  texture.anisotropy = sourceMap.anisotropy;
  texture.matrixAutoUpdate = sourceMap.matrixAutoUpdate;
  if (sourceMap.matrixAutoUpdate === false) texture.matrix.copy(sourceMap.matrix);

  material.map = texture;
  material.color?.setRGB(1, 1, 1);
  material._quantizedCanvas = canvas;
  material._quantizedLabels = labels;
  material._quantizedLabelsWidth = cache.width;
  material._quantizedLabelsHeight = cache.height;
  material._quantizationEnabled = true;
  material._textureProcessingResolution = plannedSize;
  rootObject._textureResolutionInfo.push(plannedSize);
  texture.needsUpdate = true;
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
  forceResample = false,
  options = {}
) {
  if (!rootObject) return [];
  let extractedPalette = [];

  // Collect both textured and solid-color materials. Some GLBs use only
  // baseColorFactor values and contain no image textures at all.
  const allMaterials = [];
  const texturedMaterials = [];
  const solidMaterials = [];
  rootObject.traverse(child => {
    if (child.isMesh && child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of materials) {
        if (!mat) continue;
        if (child.isInstancedMesh && child.instanceColor) {
          mat._texture2PaintHasInstanceColor = true;
        }
        if (!allMaterials.includes(mat)) allMaterials.push(mat);
        if (mat.color && !mat._originalColor) mat._originalColor = mat.color.clone();
        if (!mat._originalMap && mat.map) {
          mat._originalMap = mat.map;
        }
        if (mat._originalMap?.image && !texturedMaterials.includes(mat)) {
          texturedMaterials.push(mat);
        } else if (mat.color && !solidMaterials.includes(mat)) {
          solidMaterials.push(mat);
        }
      }
    }
  });

  if (forceResample) {
    rootObject._quantizedPalette = null;
    for (const mat of allMaterials) {
      mat._quantizedPalette = null;
    }
  }

  const collectModelSamples = () => {
    const revision = rootObject._texture2PaintProcessingRevision;
    if (revision !== undefined && rootObject._texture2PaintSurfaceSampleCache?.revision === revision) {
      return rootObject._texture2PaintSurfaceSampleCache.samples;
    }
    const samples = sampleModelSurfaceColors(rootObject);
    if (revision !== undefined) {
      rootObject._texture2PaintSurfaceSampleCache = { revision, samples };
    }
    return samples;
  };

  // 1. Determine a single unified palette across the entire model
  if (customPalette && customPalette.length > 0) {
    const samples = customPalette.length < numColors ? collectModelSamples() : [];
    extractedPalette = adjustPaletteSize(customPalette, samples, numColors);
  } else if (rootObject._quantizedPalette && !forceResample) {
    const samples = rootObject._quantizedPalette.length < numColors ? collectModelSamples() : [];
    extractedPalette = adjustPaletteSize(rootObject._quantizedPalette, samples, numColors);
  } else {
    extractedPalette = quantizePaletteFromSamples(collectModelSamples(), numColors);
  }

  rootObject._quantizedPalette = extractedPalette;

  for (const material of allMaterials) {
    setVertexColorPaletteShader(material, extractedPalette, enabled);
  }

  // 2. Apply this unified palette to all supported materials
  const indexLut = createIndexLUT(extractedPalette);
  const resolutionPlan = planTextureWorkingSizes(texturedMaterials.map(mat => ({
    width: mat._originalMap.image.width,
    height: mat._originalMap.image.height,
  })));
  rootObject._textureResolutionInfo = [];

  // Solid-color materials have no bitmap to rewrite, so quantize their base
  // color directly for the live preview and processed GLB export.
  for (const mat of solidMaterials) {
    if (!mat._originalColor) mat._originalColor = mat.color.clone();
    mat._quantizedPalette = extractedPalette;
    if (!enabled) {
      mat.color.copy(mat._originalColor);
      mat._quantizationEnabled = false;
    } else {
      if (mat.vertexColors || mat._texture2PaintHasInstanceColor) {
        mat.color.copy(mat._originalColor);
      } else {
        const source = materialColorSample({ color: mat._originalColor });
        const closest = closestPaletteIndex(source, extractedPalette);
        setMaterialColorFromSample(mat, extractedPalette[closest]);
      }
      mat._quantizationEnabled = true;
    }
  }

  for (let materialIndex = 0; materialIndex < texturedMaterials.length; materialIndex++) {
    const mat = texturedMaterials[materialIndex];
    mat._quantizedPalette = extractedPalette;

    if (!enabled) {
      mat.map = mat._originalMap;
      if (mat._originalColor) mat.color.copy(mat._originalColor);
      mat._quantizationEnabled = false;
      mat._textureProcessingResolution = null;
      mat.needsUpdate = true;
      continue;
    }

    const sourceMap = mat._originalMap;
    const origImage = sourceMap.image;
    const plannedSize = resolutionPlan[materialIndex];
    const baseColor = mat._originalColor || mat.color || new THREE.Color(1, 1, 1);
    let cache = mat._texture2PaintTextureCache;
    const cacheMatches = cache && cache.image === origImage &&
      cache.sourceTextureVersion === sourceMap.version &&
      cache.width === plannedSize.width && cache.height === plannedSize.height &&
      cache.baseRed === baseColor.r && cache.baseGreen === baseColor.g && cache.baseBlue === baseColor.b;
    if (!cacheMatches) {
      cache?.texture?.dispose?.();
      const canvas = document.createElement('canvas');
      canvas.width = plannedSize.width;
      canvas.height = plannedSize.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(origImage, 0, 0, canvas.width, canvas.height);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const sourceData = new Uint8ClampedArray(imageData.data);
      const effectiveIndices = new Uint16Array(canvas.width * canvas.height);
      for (let offset = 0, pixel = 0; offset < sourceData.length; offset += 4, pixel++) {
        const effective = effectiveTexturePixelSample(sourceData, offset, sourceMap, baseColor);
        effectiveIndices[pixel] = ((effective[0] >> 3) << 10) |
          ((effective[1] >> 3) << 5) | (effective[2] >> 3);
      }
      cache = {
        image: origImage,
        sourceTextureVersion: sourceMap.version,
        width: canvas.width,
        height: canvas.height,
        baseRed: baseColor.r,
        baseGreen: baseColor.g,
        baseBlue: baseColor.b,
        canvas,
        context,
        imageData,
        sourceData,
        effectiveIndices,
        rawLabels: new Map(),
        despeckledLabels: new Map(),
        smoothedLabels: new Map(),
        texture: null,
      };
      mat._texture2PaintTextureCache = cache;
    }

    const W = cache.width;
    const H = cache.height;
    const paletteKey = extractedPalette.map(color => color.join(',')).join(';');
    let rawLabels = cache.rawLabels.get(paletteKey);
    if (!rawLabels) {
      rawLabels = new Uint8Array(W * H);
      for (let pixel = 0; pixel < rawLabels.length; pixel++) {
        rawLabels[pixel] = indexLut[cache.effectiveIndices[pixel]];
      }
      cache.rawLabels.set(paletteKey, rawLabels);
      if (cache.rawLabels.size > 8) cache.rawLabels.delete(cache.rawLabels.keys().next().value);
    }

    if (options.prepareOnly && (despeckleSize > 0 || smoothLevel > 0)) {
      mat._texture2PaintPendingLabels = {
        rawLabels,
        paletteKey,
        despeckleSize,
        smoothLevel,
        plannedSize,
      };
      continue;
    }

    const despeckleKey = `${paletteKey}|${despeckleSize}`;
    let despeckled = cache.despeckledLabels.get(despeckleKey);
    if (!despeckled) {
      despeckled = rawLabels.slice();
      if (despeckleSize > 0) {
        despeckled = despeckleLabels(
          despeckled, W, H, despeckleSize, extractedPalette.length
        );
      }
      cache.despeckledLabels.set(despeckleKey, despeckled);
      if (cache.despeckledLabels.size > 12) {
        cache.despeckledLabels.delete(cache.despeckledLabels.keys().next().value);
      }
    }

    let labels = despeckled;
    for (let pass = 1; pass <= smoothLevel; pass++) {
      const smoothKey = `${despeckleKey}|${pass}`;
      let smoothed = cache.smoothedLabels.get(smoothKey);
      if (!smoothed) {
        smoothed = smoothBoundaries(labels, W, H, 1, extractedPalette.length);
        cache.smoothedLabels.set(smoothKey, smoothed);
        if (cache.smoothedLabels.size > 24) {
          cache.smoothedLabels.delete(cache.smoothedLabels.keys().next().value);
        }
      }
      labels = smoothed;
    }

    paintQuantizedTexture(mat, cache, sourceMap, extractedPalette, labels, plannedSize, rootObject);
  }

  return extractedPalette;
}

let textureProcessingWorker = null;
let textureProcessingJobId = 0;
const textureProcessingJobs = new Map();

function resetTextureProcessingWorker(error) {
  textureProcessingWorker?.terminate?.();
  textureProcessingWorker = null;
  for (const job of textureProcessingJobs.values()) job.reject(error);
  textureProcessingJobs.clear();
}

function processTextureLabelsOffThread(labels, width, height, numColors, despeckleSize, smoothLevel) {
  if (typeof Worker === 'undefined') {
    return Promise.resolve(processTextureLabels(
      labels.slice(), width, height, numColors, despeckleSize, smoothLevel
    ));
  }
  if (!textureProcessingWorker) {
    try {
      textureProcessingWorker = new Worker(
        new URL('./texture-processing-worker.js', import.meta.url),
        { type: 'module' }
      );
    } catch {
      return Promise.resolve(processTextureLabels(
        labels.slice(), width, height, numColors, despeckleSize, smoothLevel
      ));
    }
    textureProcessingWorker.onmessage = event => {
      const job = textureProcessingJobs.get(event.data.id);
      if (!job) return;
      textureProcessingJobs.delete(event.data.id);
      job.resolve(new Uint8Array(event.data.labels));
    };
    textureProcessingWorker.onerror = event => {
      resetTextureProcessingWorker(new Error(event.message || 'Texture processing worker failed'));
    };
  }
  const id = ++textureProcessingJobId;
  const copy = labels.slice();
  return new Promise((resolve, reject) => {
    textureProcessingJobs.set(id, { resolve, reject });
    textureProcessingWorker.postMessage({
      id,
      labels: copy.buffer,
      width,
      height,
      numColors,
      despeckleSize,
      smoothLevel,
    }, [copy.buffer]);
  });
}

/**
 * Async live quantization variant. Palette discovery and canvas setup stay on
 * the UI thread, while potentially expensive despeckle/smoothing passes run
 * in a reusable worker. Its final labels are byte-identical to the synchronous
 * path and share the same material caches.
 */
export async function applyLiveColorQuantizationAsync(
  rootObject,
  numColors = 5,
  enabled = true,
  customPalette = null,
  despeckleSize = 0,
  smoothLevel = 0,
  forceResample = false,
  { shouldApply = () => true } = {}
) {
  if (!enabled || (despeckleSize <= 0 && smoothLevel <= 0)) {
    return applyLiveColorQuantization(
      rootObject, numColors, enabled, customPalette,
      despeckleSize, smoothLevel, forceResample
    );
  }

  const palette = applyLiveColorQuantization(
    rootObject, numColors, enabled, customPalette,
    despeckleSize, smoothLevel, forceResample, { prepareOnly: true }
  );
  const pendingMaterials = [];
  rootObject.traverse(child => {
    if (!child.isMesh || !child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material?._texture2PaintPendingLabels && !pendingMaterials.includes(material)) {
        pendingMaterials.push(material);
      }
    }
  });

  const results = await Promise.all(pendingMaterials.map(async material => {
    const pending = material._texture2PaintPendingLabels;
    const cache = material._texture2PaintTextureCache;
    const despeckleKey = `${pending.paletteKey}|${pending.despeckleSize}`;
    const finalKey = `${despeckleKey}|${pending.smoothLevel}`;
    let labels = pending.smoothLevel > 0
      ? cache.smoothedLabels.get(finalKey)
      : cache.despeckledLabels.get(despeckleKey);
    if (!labels) {
      try {
        labels = await processTextureLabelsOffThread(
          pending.rawLabels,
          cache.width,
          cache.height,
          palette.length,
          pending.despeckleSize,
          pending.smoothLevel
        );
      } catch {
        labels = processTextureLabels(
          pending.rawLabels.slice(),
          cache.width,
          cache.height,
          palette.length,
          pending.despeckleSize,
          pending.smoothLevel
        );
      }
      const targetCache = pending.smoothLevel > 0 ? cache.smoothedLabels : cache.despeckledLabels;
      targetCache.set(pending.smoothLevel > 0 ? finalKey : despeckleKey, labels);
      const limit = pending.smoothLevel > 0 ? 24 : 12;
      if (targetCache.size > limit) targetCache.delete(targetCache.keys().next().value);
    }
    return { material, pending, cache, labels };
  }));

  if (!shouldApply()) {
    for (const { material } of results) material._texture2PaintPendingLabels = null;
    return palette;
  }
  for (const { material, pending, cache, labels } of results) {
    paintQuantizedTexture(
      material,
      cache,
      material._originalMap,
      palette,
      labels,
      pending.plannedSize,
      rootObject
    );
    material._texture2PaintPendingLabels = null;
  }
  return palette;
}

function getPrusaMmuHex(extruderId) {
  if (extruderId === 1) return '4';
  if (extruderId === 2) return '8';
  // TriangleSelector reserves F as a continuation nibble for states above 17.
  // The string is nibble-reversed on disk, so Extruder18 is 0FC (not FC),
  // Extruder19 is 1FC, and so on through the app's 32-color limit.
  const extendedState = extruderId - 3;
  const continuationCount = Math.floor(extendedState / 15);
  const remainder = extendedState % 15;
  return remainder.toString(16).toUpperCase() + 'F'.repeat(continuationCount) + 'C';
}

const PAINT_TRACE_EPSILON = 1e-9;
const MAX_PAINT_BOUNDARY_SCAN_STEPS = 100000000;
const MAX_PAINT_BOUNDARY_SEGMENTS = 2000000;
export const RECOMMENDED_PAINT_OUTPUT_TRIANGLES = 1000000;
// Kept as an API alias for integrations that used the previous name. This is
// a recommendation for automatic mode, not a format or user-enforced limit.
export const MAX_PAINT_OUTPUT_TRIANGLES = RECOMMENDED_PAINT_OUTPUT_TRIANGLES;

export function projectPaintOutputTriangles(sourceTriangles, boundarySegments = 0) {
  const source = Math.max(0, Math.ceil(Number(sourceTriangles) || 0));
  const boundaries = Math.max(0, Number(boundarySegments) || 0);
  // A contour crossing usually turns one source triangle into three. The
  // additional 7.5% covers shared-edge conformity and grid junctions without
  // pretending that a quick preflight is an exact triangulation.
  return source + Math.ceil(boundaries * 2.15);
}

export function shouldUseDenseMeshPaintFallback(
  triangleCount,
  maxOutputTriangles = MAX_PAINT_OUTPUT_TRIANGLES,
  estimatedBoundarySegments = 0
) {
  return projectPaintOutputTriangles(triangleCount, estimatedBoundarySegments) >= maxOutputTriangles;
}

function positiveModulo(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}

function rasterWrapPeriod(size, wrapping) {
  if (wrapping === THREE.RepeatWrapping) return size;
  if (wrapping === THREE.MirroredRepeatWrapping) return size * 2;
  return null;
}

function wrappedRasterCell(cell, size, wrapping) {
  if (wrapping === THREE.RepeatWrapping) return positiveModulo(cell, size);
  if (wrapping === THREE.MirroredRepeatWrapping) {
    const mirrored = positiveModulo(cell, size * 2);
    return mirrored < size ? mirrored : size * 2 - 1 - mirrored;
  }
  return Math.max(0, Math.min(size - 1, cell));
}

function wrappedTextureCoordinate(value, wrapping) {
  if (wrapping === THREE.RepeatWrapping) return positiveModulo(value, 1);
  if (wrapping === THREE.MirroredRepeatWrapping) {
    const mirrored = positiveModulo(value, 2);
    return mirrored <= 1 ? mirrored : 2 - mirrored;
  }
  return Math.max(0, Math.min(1, value));
}

function transformPaintUv(raster, u, v) {
  const elements = raster.uvMatrix;
  if (!elements) return [u * raster.repeatX + raster.offsetX, v * raster.repeatY + raster.offsetY];
  return [
    elements[0] * u + elements[3] * v + elements[6],
    elements[1] * u + elements[4] * v + elements[7],
  ];
}

function localPaintPointToPosition(tri, point) {
  const w1 = point[0];
  const w2 = point[1];
  const w0 = 1 - w1 - w2;
  return [
    w0 * tri.p0[0] + w1 * tri.p1[0] + w2 * tri.p2[0],
    w0 * tri.p0[1] + w1 * tri.p1[1] + w2 * tri.p2[1],
    w0 * tri.p0[2] + w1 * tri.p1[2] + w2 * tri.p2[2],
  ];
}

function localPaintPointToUv(tri, point) {
  const w1 = point[0];
  const w2 = point[1];
  const w0 = 1 - w1 - w2;
  return [
    w0 * tri.u0 + w1 * tri.u1 + w2 * tri.u2,
    w0 * tri.v0 + w1 * tri.v1 + w2 * tri.v2,
  ];
}

function clipLocalSegmentToTriangle(a, b) {
  let start = 0;
  let end = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const constraints = [
    [a[0], dx],
    [a[1], dy],
    [1 - a[0] - a[1], -dx - dy],
  ];

  for (const [base, delta] of constraints) {
    if (Math.abs(delta) <= PAINT_TRACE_EPSILON) {
      if (base < -PAINT_TRACE_EPSILON) return null;
      continue;
    }
    const crossing = -base / delta;
    if (delta > 0) start = Math.max(start, crossing);
    else end = Math.min(end, crossing);
    if (start > end + PAINT_TRACE_EPSILON) return null;
  }

  const p0 = [a[0] + dx * start, a[1] + dy * start];
  const p1 = [a[0] + dx * end, a[1] + dy * end];
  if ((p0[0] - p1[0]) ** 2 + (p0[1] - p1[1]) ** 2 <= PAINT_TRACE_EPSILON ** 2) return null;
  return [p0, p1];
}

function textureTriangleSliceRange(points, axis, value) {
  const other = axis === 0 ? 1 : 0;
  const hits = [];
  for (let edge = 0; edge < 3; edge++) {
    const a = points[edge];
    const b = points[(edge + 1) % 3];
    const da = a[axis] - value;
    const db = b[axis] - value;
    if (Math.abs(da) <= PAINT_TRACE_EPSILON) hits.push(a[other]);
    if (Math.abs(db) <= PAINT_TRACE_EPSILON) hits.push(b[other]);
    const span = b[axis] - a[axis];
    if (Math.abs(span) > PAINT_TRACE_EPSILON) {
      const t = (value - a[axis]) / span;
      if (t > PAINT_TRACE_EPSILON && t < 1 - PAINT_TRACE_EPSILON) {
        hits.push(a[other] + (b[other] - a[other]) * t);
      }
    }
  }
  if (hits.length === 0) return null;
  return [Math.min(...hits), Math.max(...hits)];
}

function rasterCellState(raster, cellX, cellY) {
  const px = wrappedRasterCell(cellX, raster.width, raster.wrapS);
  const textureRow = wrappedRasterCell(cellY, raster.height, raster.wrapT);
  const py = raster.flipY ? raster.height - 1 - textureRow : textureRow;
  const pixelIndex = py * raster.width + px;
  const alpha = raster.rgba ? raster.rgba[pixelIndex * 4 + 3] : 255;
  return alpha < (raster.alphaThreshold ?? 128) ? -1 : raster.labels[pixelIndex];
}

const rasterBoundaryIndexCache = new WeakMap();

function rasterAlphaSnapshot(raster) {
  if (!raster.rgba) return null;
  const alpha = new Uint8Array(raster.width * raster.height);
  for (let pixel = 0; pixel < alpha.length; pixel++) alpha[pixel] = raster.rgba[pixel * 4 + 3];
  return alpha;
}

function equalRasterAlpha(left, right) {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function getRasterBoundaryIndex(raster, traceStats) {
  if (raster.boundaryIndex) return raster.boundaryIndex;
  const cacheKey = `${raster.width}x${raster.height}|${raster.wrapS}|${raster.wrapT}|${raster.flipY}|${raster.alphaThreshold ?? 128}`;
  const alphaSnapshot = rasterAlphaSnapshot(raster);
  const cachedEntries = rasterBoundaryIndexCache.get(raster.labels) || [];
  const cached = cachedEntries.find(entry =>
    entry.key === cacheKey && equalRasterAlpha(entry.alpha, alphaSnapshot)
  );
  if (cached) {
    raster.boundaryIndex = cached.index;
    return cached.index;
  }
  const xPeriod = rasterWrapPeriod(raster.width, raster.wrapS);
  const yPeriod = rasterWrapPeriod(raster.height, raster.wrapT);
  const xBoundaryCount = xPeriod || raster.width + 1;
  const yBoundaryCount = yPeriod || raster.height + 1;
  const xCellCount = xPeriod || raster.width;
  const yCellCount = yPeriod || raster.height;
  const vertical = Array.from({ length: xBoundaryCount }, () => []);
  const horizontal = Array.from({ length: yBoundaryCount }, () => []);
  const comparisons = xBoundaryCount * yCellCount + yBoundaryCount * xCellCount;
  traceStats.scanSteps += comparisons;
  if (!traceStats.ignoreResourceLimits && traceStats.scanSteps > MAX_PAINT_BOUNDARY_SCAN_STEPS) {
    throw new Error('Working textures contain too many texels to trace safely. Reduce the working texture resolution.');
  }

  for (let gridX = 0; gridX < xBoundaryCount; gridX++) {
    const column = vertical[gridX];
    for (let cellY = 0; cellY < yCellCount; cellY++) {
      if (rasterCellState(raster, gridX - 1, cellY) !== rasterCellState(raster, gridX, cellY)) {
        column.push(cellY);
      }
    }
  }
  for (let gridY = 0; gridY < yBoundaryCount; gridY++) {
    const row = horizontal[gridY];
    for (let cellX = 0; cellX < xCellCount; cellX++) {
      if (rasterCellState(raster, cellX, gridY - 1) !== rasterCellState(raster, cellX, gridY)) {
        row.push(cellX);
      }
    }
  }
  raster.boundaryIndex = { vertical, horizontal, xPeriod, yPeriod };
  cachedEntries.push({ key: cacheKey, alpha: alphaSnapshot, index: raster.boundaryIndex });
  if (cachedEntries.length > 4) cachedEntries.shift();
  rasterBoundaryIndexCache.set(raster.labels, cachedEntries);
  return raster.boundaryIndex;
}

function rasterBoundaryIndex(grid, size, period) {
  if (period) return positiveModulo(grid, period);
  return grid >= 0 && grid <= size ? grid : -1;
}

function rasterCellIntervals(baseCells, firstCell, lastCell, size, period) {
  if (firstCell > lastCell || baseCells.length === 0) return [];
  if (period) {
    const intervals = [];
    for (const baseCell of baseCells) {
      const firstTile = Math.ceil((firstCell - baseCell) / period);
      const lastTile = Math.floor((lastCell - baseCell) / period);
      for (let tile = firstTile; tile <= lastTile; tile++) {
        const cell = baseCell + tile * period;
        intervals.push([cell, cell + 1]);
      }
    }
    return intervals;
  }

  const intervals = [];
  // Clamp-to-edge extends the first and last texel indefinitely. Preserve
  // boundaries in out-of-range UVs without iterating one segment per tile.
  if (firstCell < 0 && baseCells.includes(0)) {
    intervals.push([firstCell, Math.min(lastCell + 1, 0)]);
  }
  for (const cell of baseCells) {
    if (cell >= firstCell && cell <= lastCell) intervals.push([cell, cell + 1]);
  }
  if (lastCell >= size && baseCells.includes(size - 1)) {
    intervals.push([Math.max(firstCell, size), lastCell + 1]);
  }
  return intervals;
}

function rasterStateAtTexturePoint(raster, point) {
  return rasterCellState(
    raster,
    Math.floor(point[0] * raster.width),
    Math.floor(point[1] * raster.height)
  );
}

function traceDegenerateTextureBoundarySegments(texturePoints, raster, traceStats) {
  let endpointA = 0;
  let endpointB = 1;
  let maxDistanceSquared = -1;
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 3; b++) {
      const dx = texturePoints[b][0] - texturePoints[a][0];
      const dy = texturePoints[b][1] - texturePoints[a][1];
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > maxDistanceSquared) {
        maxDistanceSquared = distanceSquared;
        endpointA = a;
        endpointB = b;
      }
    }
  }
  if (maxDistanceSquared <= PAINT_TRACE_EPSILON ** 2) return [];

  const origin = texturePoints[endpointA];
  const direction = [
    texturePoints[endpointB][0] - origin[0],
    texturePoints[endpointB][1] - origin[1],
  ];
  const parameters = texturePoints.map(point => (
    ((point[0] - origin[0]) * direction[0] + (point[1] - origin[1]) * direction[1]) /
    maxDistanceSquared
  ));
  const minParameter = Math.min(...parameters);
  const maxParameter = Math.max(...parameters);
  const candidates = [];
  const addAxisCandidates = (axis, size) => {
    const delta = direction[axis];
    if (Math.abs(delta) <= PAINT_TRACE_EPSILON) return;
    const values = texturePoints.map(point => point[axis] * size);
    const firstGrid = Math.ceil(Math.min(...values) - PAINT_TRACE_EPSILON);
    const lastGrid = Math.floor(Math.max(...values) + PAINT_TRACE_EPSILON);
    for (let grid = firstGrid; grid <= lastGrid; grid++) {
      const parameter = (grid / size - origin[axis]) / delta;
      if (parameter > minParameter + PAINT_TRACE_EPSILON &&
        parameter < maxParameter - PAINT_TRACE_EPSILON) {
        candidates.push(parameter);
      }
    }
  };
  addAxisCandidates(0, raster.width);
  addAxisCandidates(1, raster.height);
  candidates.sort((a, b) => a - b);
  const uniqueCandidates = candidates.filter(
    (value, index) => index === 0 || Math.abs(value - candidates[index - 1]) > 1e-10
  );
  traceStats.scanSteps += uniqueCandidates.length;
  if (!traceStats.ignoreResourceLimits && traceStats.scanSteps > MAX_PAINT_BOUNDARY_SCAN_STEPS) {
    throw new Error('Working textures contain too many texels to trace safely. Reduce the working texture resolution.');
  }

  const referenceVertices = [[0, 0], [1, 0], [0, 1]];
  const pointAtParameter = parameter => [
    origin[0] + direction[0] * parameter,
    origin[1] + direction[1] * parameter,
  ];
  const localSegmentAtParameter = parameter => {
    const intersections = [];
    const addIntersection = point => {
      if (!intersections.some(existing =>
        Math.hypot(existing[0] - point[0], existing[1] - point[1]) <= 1e-10
      )) intersections.push(point);
    };
    for (let edge = 0; edge < 3; edge++) {
      const next = (edge + 1) % 3;
      const valueA = parameters[edge];
      const valueB = parameters[next];
      const localA = referenceVertices[edge];
      const localB = referenceVertices[next];
      if (Math.abs(valueA - parameter) <= 1e-10) addIntersection(localA);
      if ((valueA < parameter && valueB > parameter) ||
        (valueA > parameter && valueB < parameter)) {
        const t = (parameter - valueA) / (valueB - valueA);
        addIntersection([
          localA[0] + (localB[0] - localA[0]) * t,
          localA[1] + (localB[1] - localA[1]) * t,
        ]);
      }
    }
    if (intersections.length < 2) return null;
    let best = [intersections[0], intersections[1]];
    let bestDistanceSquared = -1;
    for (let a = 0; a < intersections.length; a++) {
      for (let b = a + 1; b < intersections.length; b++) {
        const dx = intersections[b][0] - intersections[a][0];
        const dy = intersections[b][1] - intersections[a][1];
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > bestDistanceSquared) {
          bestDistanceSquared = distanceSquared;
          best = [intersections[a], intersections[b]];
        }
      }
    }
    return bestDistanceSquared > PAINT_TRACE_EPSILON ** 2 ? best : null;
  };

  const segments = [];
  for (let index = 0; index < uniqueCandidates.length; index++) {
    const parameter = uniqueCandidates[index];
    const previous = index > 0 ? uniqueCandidates[index - 1] : minParameter;
    const next = index + 1 < uniqueCandidates.length ? uniqueCandidates[index + 1] : maxParameter;
    const beforeState = rasterStateAtTexturePoint(raster, pointAtParameter((previous + parameter) * 0.5));
    const afterState = rasterStateAtTexturePoint(raster, pointAtParameter((parameter + next) * 0.5));
    if (beforeState === afterState) continue;
    const segment = localSegmentAtParameter(parameter);
    if (!segment) continue;
    segments.push(segment);
    traceStats.boundarySegments++;
    if (!traceStats.ignoreResourceLimits && traceStats.boundarySegments > MAX_PAINT_BOUNDARY_SEGMENTS) {
      throw new Error('Texture boundary is too complex to trace safely. Despeckle the texture or use a lower working texture resolution.');
    }
  }
  return segments;
}

function traceSingleTextureBoundarySegments(tri, raster, uvCoordinates, traceStats) {
  if (!raster) return [];

  const texturePoints = [
    transformPaintUv(raster, uvCoordinates[0][0], uvCoordinates[0][1]),
    transformPaintUv(raster, uvCoordinates[1][0], uvCoordinates[1][1]),
    transformPaintUv(raster, uvCoordinates[2][0], uvCoordinates[2][1]),
  ];
  const e1x = texturePoints[1][0] - texturePoints[0][0];
  const e1y = texturePoints[1][1] - texturePoints[0][1];
  const e2x = texturePoints[2][0] - texturePoints[0][0];
  const e2y = texturePoints[2][1] - texturePoints[0][1];
  const determinant = e1x * e2y - e1y * e2x;
  if (Math.abs(determinant) <= PAINT_TRACE_EPSILON) {
    traceStats.degenerateUvTriangles++;
    return traceDegenerateTextureBoundarySegments(texturePoints, raster, traceStats);
  }

  const toLocal = point => {
    const dx = point[0] - texturePoints[0][0];
    const dy = point[1] - texturePoints[0][1];
    return [
      (dx * e2y - dy * e2x) / determinant,
      (e1x * dy - e1y * dx) / determinant,
    ];
  };
  const segments = [];
  const appendSegment = (a, b) => {
    const clipped = clipLocalSegmentToTriangle(toLocal(a), toLocal(b));
    if (!clipped) return;
    segments.push(clipped);
    traceStats.boundarySegments++;
    if (!traceStats.ignoreResourceLimits && traceStats.boundarySegments > MAX_PAINT_BOUNDARY_SEGMENTS) {
      throw new Error('Texture boundary is too complex to trace safely. Despeckle the texture or use a lower working texture resolution.');
    }
  };

  const minU = Math.min(...texturePoints.map(point => point[0]));
  const maxU = Math.max(...texturePoints.map(point => point[0]));
  const minV = Math.min(...texturePoints.map(point => point[1]));
  const maxV = Math.max(...texturePoints.map(point => point[1]));
  const minGridX = Math.ceil(minU * raster.width - PAINT_TRACE_EPSILON);
  const maxGridX = Math.floor(maxU * raster.width + PAINT_TRACE_EPSILON);
  const minGridY = Math.ceil(minV * raster.height - PAINT_TRACE_EPSILON);
  const maxGridY = Math.floor(maxV * raster.height + PAINT_TRACE_EPSILON);
  const boundaryIndex = getRasterBoundaryIndex(raster, traceStats);

  for (let gridX = minGridX; gridX <= maxGridX; gridX++) {
    const u = gridX / raster.width;
    const range = textureTriangleSliceRange(texturePoints, 0, u);
    if (!range) continue;
    const firstCellY = Math.floor(range[0] * raster.height);
    const lastCellY = Math.ceil(range[1] * raster.height) - 1;
    const boundaryIndexX = rasterBoundaryIndex(
      gridX, raster.width, boundaryIndex.xPeriod
    );
    if (boundaryIndexX < 0) continue;
    const baseCells = boundaryIndex.vertical[boundaryIndexX];
    const intervals = rasterCellIntervals(
      baseCells, firstCellY, lastCellY, raster.height, boundaryIndex.yPeriod
    );
    for (const [startCellY, endCellY] of intervals) {
      appendSegment([u, startCellY / raster.height], [u, endCellY / raster.height]);
    }
  }

  for (let gridY = minGridY; gridY <= maxGridY; gridY++) {
    const v = gridY / raster.height;
    const range = textureTriangleSliceRange(texturePoints, 1, v);
    if (!range) continue;
    const firstCellX = Math.floor(range[0] * raster.width);
    const lastCellX = Math.ceil(range[1] * raster.width) - 1;
    const boundaryIndexY = rasterBoundaryIndex(
      gridY, raster.height, boundaryIndex.yPeriod
    );
    if (boundaryIndexY < 0) continue;
    const baseCells = boundaryIndex.horizontal[boundaryIndexY];
    const intervals = rasterCellIntervals(
      baseCells, firstCellX, lastCellX, raster.width, boundaryIndex.xPeriod
    );
    for (const [startCellX, endCellX] of intervals) {
      appendSegment([startCellX / raster.width, v], [endCellX / raster.width, v]);
    }
  }

  return segments;
}

function traceTextureBoundarySegments(tri, traceStats) {
  const rasters = tri.paintRasters || (tri.raster ? [{
    raster: tri.raster,
    uv: [[tri.u0, tri.v0], [tri.u1, tri.v1], [tri.u2, tri.v2]],
  }] : []);
  const segments = [];
  for (const entry of rasters) {
    segments.push(...traceSingleTextureBoundarySegments(tri, entry.raster, entry.uv, traceStats));
  }
  return segments;
}

function traceVertexColorBoundarySegments(tri, traceStats, divisions) {
  if (!tri.vertexColors || !tri.sampleLocal) return [];
  const varies = [0, 1, 2, 3].some(component => {
    const values = tri.vertexColors.map(color => color[component]);
    return Math.max(...values) - Math.min(...values) > 1e-7;
  });
  if (!varies) return [];

  const stateAt = point => {
    const paint = tri.sampleLocal(point);
    return paint.alpha < 128 ? -1 : paint.color;
  };
  const crossing = (a, b, stateA) => {
    let low = a;
    let high = b;
    for (let iteration = 0; iteration < 12; iteration++) {
      const midpoint = [(low[0] + high[0]) * 0.5, (low[1] + high[1]) * 0.5];
      if (stateAt(midpoint) === stateA) low = midpoint;
      else high = midpoint;
    }
    return [(low[0] + high[0]) * 0.5, (low[1] + high[1]) * 0.5];
  };
  const segments = [];
  const visitCell = points => {
    const states = points.map(stateAt);
    if (states[0] === states[1] && states[1] === states[2]) return;
    const crossings = [];
    for (let edge = 0; edge < 3; edge++) {
      const next = (edge + 1) % 3;
      if (states[edge] !== states[next]) {
        crossings.push(crossing(points[edge], points[next], states[edge]));
      }
    }
    if (crossings.length === 2) {
      segments.push([crossings[0], crossings[1]]);
    } else if (crossings.length === 3) {
      const junction = [
        (crossings[0][0] + crossings[1][0] + crossings[2][0]) / 3,
        (crossings[0][1] + crossings[1][1] + crossings[2][1]) / 3,
      ];
      for (const point of crossings) segments.push([point, junction]);
    }
  };
  for (let x = 0; x < divisions; x++) {
    for (let y = 0; y < divisions - x; y++) {
      const p00 = [x / divisions, y / divisions];
      const p10 = [(x + 1) / divisions, y / divisions];
      const p01 = [x / divisions, (y + 1) / divisions];
      visitCell([p00, p10, p01]);
      if (x + y <= divisions - 2) {
        visitCell([p10, [(x + 1) / divisions, (y + 1) / divisions], p01]);
      }
    }
  }
  traceStats.boundarySegments += segments.length;
  traceStats.scanSteps += divisions * divisions;
  if (!traceStats.ignoreResourceLimits && traceStats.boundarySegments > MAX_PAINT_BOUNDARY_SEGMENTS) {
    throw new Error('Vertex-color boundary is too complex to trace safely. Reduce the model complexity.');
  }
  return segments;
}

function pointSegmentDistanceSq3D(point, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
  const lengthSq = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = lengthSq > 0
    ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / lengthSq))
    : 0;
  return (point[0] - a[0] - ab[0] * t) ** 2 +
    (point[1] - a[1] - ab[1] * t) ** 2 +
    (point[2] - a[2] - ab[2] * t) ** 2;
}

function simplifyOpenPaintChain(points, tri, toleranceMm) {
  if (points.length <= 2) return points.slice();
  const positions = points.map(point => localPaintPointToPosition(tri, point));
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const toleranceSq = toleranceMm * toleranceMm;
  while (stack.length) {
    const [start, end] = stack.pop();
    let farthest = -1;
    let farthestDistanceSq = toleranceSq;
    for (let i = start + 1; i < end; i++) {
      const distanceSq = pointSegmentDistanceSq3D(positions[i], positions[start], positions[end]);
      if (distanceSq > farthestDistanceSq + 1e-18) {
        farthestDistanceSq = distanceSq;
        farthest = i;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

function simplifyClosedPaintChain(points, tri, toleranceMm) {
  if (points.length <= 3) return points.slice();
  const positions = points.map(point => localPaintPointToPosition(tri, point));
  let anchorB = 1;
  let farthestDistanceSq = -1;
  for (let i = 1; i < positions.length; i++) {
    const distanceSq = (positions[i][0] - positions[0][0]) ** 2 +
      (positions[i][1] - positions[0][1]) ** 2 +
      (positions[i][2] - positions[0][2]) ** 2;
    if (distanceSq > farthestDistanceSq) {
      farthestDistanceSq = distanceSq;
      anchorB = i;
    }
  }
  const firstHalf = simplifyOpenPaintChain(points.slice(0, anchorB + 1), tri, toleranceMm);
  const secondHalf = simplifyOpenPaintChain(
    points.slice(anchorB).concat([points[0]]), tri, toleranceMm
  );
  const result = firstHalf.slice(0, -1).concat(secondHalf.slice(0, -1));
  if (result.length >= 3) return result;
  return [points[0], points[Math.floor(points.length / 3)], points[Math.floor(points.length * 2 / 3)]];
}

function simplifyPaintBoundaryNetwork(segments, tri, toleranceMm) {
  if (segments.length === 0) return [];
  const nodes = new Map();
  const edges = new Set();
  const keyFor = point => `${Math.round(point[0] * 1e9)}_${Math.round(point[1] * 1e9)}`;
  const addNode = point => {
    const key = keyFor(point);
    if (!nodes.has(key)) nodes.set(key, { point, neighbors: new Set() });
    return key;
  };
  for (const [a, b] of segments) {
    const ka = addNode(a);
    const kb = addNode(b);
    if (ka === kb) continue;
    const edgeKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (edges.has(edgeKey)) continue;
    edges.add(edgeKey);
    nodes.get(ka).neighbors.add(kb);
    nodes.get(kb).neighbors.add(ka);
  }

  const usedEdges = new Set();
  const edgeKeyFor = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
  const walk = (start, next) => {
    const path = [start];
    let previous = start;
    let current = next;
    while (true) {
      usedEdges.add(edgeKeyFor(previous, current));
      path.push(current);
      if (current === start || nodes.get(current).neighbors.size !== 2) break;
      const candidates = [...nodes.get(current).neighbors].filter(candidate => candidate !== previous);
      if (candidates.length !== 1 || usedEdges.has(edgeKeyFor(current, candidates[0]))) break;
      previous = current;
      current = candidates[0];
    }
    return path;
  };

  const chains = [];
  for (const [key, node] of nodes) {
    if (node.neighbors.size === 2) continue;
    for (const neighbor of node.neighbors) {
      if (!usedEdges.has(edgeKeyFor(key, neighbor))) chains.push(walk(key, neighbor));
    }
  }
  for (const edgeKey of edges) {
    if (usedEdges.has(edgeKey)) continue;
    const separator = edgeKey.indexOf('|');
    chains.push(walk(edgeKey.slice(0, separator), edgeKey.slice(separator + 1)));
  }

  const simplified = [];
  for (const chain of chains) {
    const closed = chain.length > 2 && chain[0] === chain[chain.length - 1];
    const chainPoints = (closed ? chain.slice(0, -1) : chain).map(key => nodes.get(key).point);
    const result = closed
      ? simplifyClosedPaintChain(chainPoints, tri, toleranceMm)
      : simplifyOpenPaintChain(chainPoints, tri, toleranceMm);
    const edgeCount = closed ? result.length : result.length - 1;
    for (let i = 0; i < edgeCount; i++) {
      simplified.push([result[i], result[(i + 1) % result.length]]);
    }
  }
  return simplified;
}

function paintBudgetRasterForMaterial(material) {
  if (!material?._quantizationEnabled || !material._quantizedLabels) return null;
  const width = material._quantizedLabelsWidth;
  const height = material._quantizedLabelsHeight;
  if (!width || !height || material._quantizedLabels.length !== width * height) return null;
  const map = material._originalMap || material.map;
  if (!map) return null;
  if (map.matrixAutoUpdate !== false) map.updateMatrix?.();

  const analysisScale = Math.max(1, width / 512, height / 512);
  const analysisWidth = Math.max(1, Math.round(width / analysisScale));
  const analysisHeight = Math.max(1, Math.round(height / analysisScale));
  const cached = material._texture2PaintBudgetRaster;
  if (cached?.labels === material._quantizedLabels && cached.mapVersion === map.version) {
    return cached;
  }
  const analysisLabels = analysisScale === 1
    ? material._quantizedLabels
    : new Uint8Array(analysisWidth * analysisHeight);
  if (analysisScale !== 1) {
    for (let y = 0; y < analysisHeight; y++) {
      const sourceY0 = Math.floor(y * height / analysisHeight);
      const sourceY1 = Math.max(sourceY0 + 1, Math.floor((y + 1) * height / analysisHeight));
      for (let x = 0; x < analysisWidth; x++) {
        const sourceX0 = Math.floor(x * width / analysisWidth);
        const sourceX1 = Math.max(sourceX0 + 1, Math.floor((x + 1) * width / analysisWidth));
        // Vary the sample phase per block so periodic details do not disappear
        // when their frequency happens to divide the 512px analysis grid.
        const hash = (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0;
        const sourceX = Math.min(width - 1, sourceX0 + hash % (sourceX1 - sourceX0));
        const sourceY = Math.min(height - 1, sourceY0 + ((hash >>> 8) % (sourceY1 - sourceY0)));
        analysisLabels[y * analysisWidth + x] = material._quantizedLabels[sourceY * width + sourceX];
      }
    }
  }
  let rgba = new Uint8ClampedArray(analysisWidth * analysisHeight * 4);
  rgba.fill(255);
  const canvas = material._quantizedCanvas;
  if (canvas?.width === width && canvas?.height === height) {
    if (analysisScale === 1) {
      const context = canvas.getContext?.('2d', { willReadFrequently: true });
      if (context) rgba = new Uint8ClampedArray(context.getImageData(0, 0, width, height).data);
    } else if (typeof document !== 'undefined') {
      const analysisCanvas = document.createElement('canvas');
      analysisCanvas.width = analysisWidth;
      analysisCanvas.height = analysisHeight;
      const context = analysisCanvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(canvas, 0, 0, analysisWidth, analysisHeight);
      rgba = new Uint8ClampedArray(context.getImageData(0, 0, analysisWidth, analysisHeight).data);
    }
  }
  const raster = {
    width: analysisWidth,
    height: analysisHeight,
    labels: analysisLabels,
    rgba,
    repeatX: map.repeat?.x ?? 1,
    repeatY: map.repeat?.y ?? 1,
    offsetX: map.offset?.x ?? 0,
    offsetY: map.offset?.y ?? 0,
    uvMatrix: map.matrix?.elements ? Array.from(map.matrix.elements) : null,
    wrapS: map.wrapS ?? THREE.ClampToEdgeWrapping,
    wrapT: map.wrapT ?? THREE.ClampToEdgeWrapping,
    flipY: map.flipY ?? true,
    alphaThreshold: Math.min(256, Math.round((material.alphaTest || 0.5) * 255)),
  };
  material._texture2PaintBudgetRaster = {
    labels: material._quantizedLabels,
    mapVersion: map.version,
    raster,
    boundaryScale: analysisScale,
    approximate: analysisScale > 1,
  };
  return material._texture2PaintBudgetRaster;
}

/**
 * Estimates the final painted triangle count by tracing a deterministic,
 * stratified sample of the model's actual quantized texture boundaries. The
 * hard limit remains exact at export; this preflight exists to choose a path
 * and provide guidance before doing the full triangulation.
 */
export function estimatePaintOutputBudget(rootObject, {
  targetSizeMm = 150,
  paintResolutionMm = 0,
  maxSamples = 2048,
  maxOutputTriangles = MAX_PAINT_OUTPUT_TRIANGLES,
} = {}) {
  if (!rootObject) return null;
  rootObject.updateWorldMatrix(true, true);
  const records = [];
  let sourceTriangles = 0;
  rootObject.traverse(mesh => {
    if (!mesh.isMesh || !mesh.geometry?.attributes?.position || !isObjectVisible(mesh)) return;
    const geometry = mesh.geometry;
    const elementCount = geometry.index ? geometry.index.count : geometry.attributes.position.count;
    const total = Math.floor(elementCount / 3);
    const drawStart = Math.max(0, Math.floor((geometry.drawRange?.start || 0) / 3));
    const drawCount = Number.isFinite(geometry.drawRange?.count)
      ? Math.max(0, Math.floor(geometry.drawRange.count / 3))
      : total;
    const triangleCount = Math.max(0, Math.min(total, drawStart + drawCount) - drawStart);
    const copies = mesh.isInstancedMesh ? Math.max(0, mesh.count || 0) : 1;
    if (!triangleCount || !copies) return;
    records.push({ mesh, geometry, drawStart, triangleCount, copies });
    sourceTriangles += triangleCount * copies;
  });
  if (!sourceTriangles) return null;

  const rootBox = new THREE.Box3().setFromObject(rootObject);
  const rootSize = rootBox.getSize(new THREE.Vector3());
  const maxDimension = Math.max(rootSize.x, rootSize.y, rootSize.z) || 1;
  const modelScale = (Number(targetSizeMm) || 150) / maxDimension;
  const tolerance = Math.max(0, Math.min(2, Number(paintResolutionMm) || 0));
  const traceStats = { scanSteps: 0, boundarySegments: 0, degenerateUvTriangles: 0 };
  let weightedSegments = 0;
  let sampledTriangles = 0;
  let analyzableTriangles = 0;
  let uncertainTriangles = 0;
  let approximateTriangles = 0;
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();

  for (const record of records) {
    const { mesh, geometry, drawStart, triangleCount, copies } = record;
    const recordWeight = triangleCount * copies;
    const sampleCount = Math.min(
      triangleCount,
      Math.max(1, Math.round(maxSamples * recordWeight / sourceTriangles))
    );
    const position = geometry.attributes.position;
    for (let sample = 0; sample < sampleCount; sample++) {
      const triangleIndex = drawStart + Math.min(
        triangleCount - 1,
        Math.floor((sample + 0.5) * triangleCount / sampleCount)
      );
      const material = materialAt(mesh, triangleMaterialIndex(geometry, triangleIndex));
      const map = material?._originalMap || material?.map;
      const rasterInfo = paintBudgetRasterForMaterial(material);
      const colorAttribute = material?.vertexColors ? geometry.getAttribute('color') : null;
      const sampleWeight = recordWeight / sampleCount;
      sampledTriangles++;
      if (!rasterInfo || !map) {
        if (map || colorAttribute || material?.alphaMap) uncertainTriangles += sampleWeight;
        continue;
      }
      const channel = Math.max(0, Math.floor(Number(map.channel) || 0));
      const uv = geometry.getAttribute(channel === 0 ? 'uv' : `uv${channel}`);
      if (!uv) {
        uncertainTriangles += sampleWeight;
        continue;
      }
      const ids = [0, 1, 2].map(corner => triangleVertexIndex(geometry, triangleIndex, corner));
      const uvCoordinates = ids.map(index => [uv.getX(index), uv.getY(index)]);
      const before = traceStats.boundarySegments;
      const segments = traceSingleTextureBoundarySegments({}, rasterInfo.raster, uvCoordinates, traceStats);
      let segmentCount = traceStats.boundarySegments - before;
      if (tolerance > 0 && segments.length > 1) {
        p0.fromBufferAttribute(position, ids[0]).applyMatrix4(mesh.matrixWorld).multiplyScalar(modelScale);
        p1.fromBufferAttribute(position, ids[1]).applyMatrix4(mesh.matrixWorld).multiplyScalar(modelScale);
        p2.fromBufferAttribute(position, ids[2]).applyMatrix4(mesh.matrixWorld).multiplyScalar(modelScale);
        const tri = { p0: p0.toArray(), p1: p1.toArray(), p2: p2.toArray() };
        segmentCount = simplifyPaintBoundaryNetwork(segments, tri, tolerance).length;
      }
      weightedSegments += segmentCount * sampleWeight * rasterInfo.boundaryScale;
      analyzableTriangles += sampleWeight;
      if (rasterInfo.approximate) approximateTriangles += sampleWeight;
      if (material?.alphaMap || colorAttribute) uncertainTriangles += sampleWeight;
    }
  }

  // Unmodeled vertex-color/independent-alpha variation gets a conservative
  // single-boundary allowance per affected face. The UI identifies this as a
  // lower-confidence estimate. The recommendation guides automatic mode; an
  // explicit override may intentionally exceed it.
  const estimatedBoundarySegments = Math.ceil(weightedSegments + uncertainTriangles);
  const projectedTriangles = projectPaintOutputTriangles(sourceTriangles, estimatedBoundarySegments);
  const utilization = projectedTriangles / maxOutputTriangles;
  const confidence = analyzableTriangles >= sourceTriangles * 0.95 &&
    uncertainTriangles === 0 && approximateTriangles === 0
    ? 'high'
    : (analyzableTriangles > 0 ? 'medium' : 'low');
  return {
    sourceTriangles,
    sampledTriangles,
    estimatedBoundarySegments,
    projectedTriangles,
    headroom: maxOutputTriangles - projectedTriangles,
    utilization,
    maxOutputTriangles,
    confidence,
    status: utilization >= 1 ? 'over' : (utilization >= 0.8 ? 'warning' : 'ok'),
  };
}

function polygonArea2D(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area * 0.5;
}

function pointInPaintPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (((a[1] > point[1]) !== (b[1] > point[1])) &&
      point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function interiorPaintPolygonPoint(polygon) {
  const vectors = polygon.map(point => new THREE.Vector2(point[0], point[1]));
  const faces = THREE.ShapeUtils.triangulateShape(vectors, []);
  if (faces.length) {
    const [a, b, c] = faces[0];
    return [
      (polygon[a][0] + polygon[b][0] + polygon[c][0]) / 3,
      (polygon[a][1] + polygon[b][1] + polygon[c][1]) / 3,
    ];
  }
  return polygon[0];
}

function conformPaintTriangleJunctions(triangles) {
  const pointKey = point => `${Math.round(point[0] * 1e9)}_${Math.round(point[1] * 1e9)}`;
  const edgeKey = (a, b) => {
    const ka = pointKey(a);
    const kb = pointKey(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const lineKey = (a, b) => {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length <= 1e-14) return null;
    dx /= length;
    dy /= length;
    if (dx < -1e-12 || (Math.abs(dx) <= 1e-12 && dy < 0)) {
      dx = -dx;
      dy = -dy;
    }
    const normalX = -dy;
    const normalY = dx;
    const offset = normalX * a[0] + normalY * a[1];
    return `${Math.round(dx * 1e8)}_${Math.round(dy * 1e8)}_${Math.round(offset * 1e8)}`;
  };

  const edgeRecords = new Map();
  for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex++) {
    const triangle = triangles[triangleIndex];
    for (let edge = 0; edge < 3; edge++) {
      const a = triangle.points[edge];
      const b = triangle.points[(edge + 1) % 3];
      const key = edgeKey(a, b);
      if (!edgeRecords.has(key)) edgeRecords.set(key, []);
      edgeRecords.get(key).push({ triangleIndex, edge, a, b });
    }
  }

  // A T-junction appears as multiple unmatched, collinear edges whose spans
  // overlap. Grouping only unmatched edges avoids touching ordinary internal
  // diagonals and lets every side adopt the union of the boundary endpoints.
  const lineGroups = new Map();
  for (const records of edgeRecords.values()) {
    if (records.length !== 1) continue;
    const record = records[0];
    const key = lineKey(record.a, record.b);
    if (!key) continue;
    if (!lineGroups.has(key)) lineGroups.set(key, new Map());
    const points = lineGroups.get(key);
    points.set(pointKey(record.a), record.a);
    points.set(pointKey(record.b), record.b);
  }

  const result = [];
  for (const triangle of triangles) {
    const boundary = [];
    let subdivided = false;
    for (let edge = 0; edge < 3; edge++) {
      const a = triangle.points[edge];
      const b = triangle.points[(edge + 1) % 3];
      boundary.push(a);
      const records = edgeRecords.get(edgeKey(a, b));
      if (records?.length !== 1) continue;
      const candidates = lineGroups.get(lineKey(a, b));
      if (!candidates || candidates.size <= 2) continue;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const lengthSquared = dx * dx + dy * dy;
      const interior = [];
      for (const point of candidates.values()) {
        const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared;
        if (t <= 1e-9 || t >= 1 - 1e-9) continue;
        const projectedX = a[0] + t * dx;
        const projectedY = a[1] + t * dy;
        if (Math.hypot(point[0] - projectedX, point[1] - projectedY) > 1e-8) continue;
        interior.push({ point, t });
      }
      interior.sort((left, right) => left.t - right.t);
      let lastKey = null;
      for (const entry of interior) {
        const key = pointKey(entry.point);
        if (key === lastKey) continue;
        boundary.push(entry.point);
        lastKey = key;
        subdivided = true;
      }
    }
    if (!subdivided) {
      result.push(triangle);
      continue;
    }
    const center = [
      (triangle.points[0][0] + triangle.points[1][0] + triangle.points[2][0]) / 3,
      (triangle.points[0][1] + triangle.points[1][1] + triangle.points[2][1]) / 3,
    ];
    for (let index = 0; index < boundary.length; index++) {
      const a = boundary[index];
      const b = boundary[(index + 1) % boundary.length];
      if (pointKey(a) === pointKey(b)) continue;
      result.push({ points: [a, b, center], samplePoint: triangle.samplePoint });
    }
  }
  return result;
}

function conformPaintSourceBoundary(triangles, boundaryPoints) {
  // Adjacent source faces can have unrelated UVs and therefore discover
  // different paint intersections along the same physical mesh edge. The
  // shared boundaryPoints list is their union; force every face to retain that
  // exact split sequence so the final spatial weld cannot leave T-junctions.
  const pointKey = point => `${Math.round(point[0] * 1e9)}_${Math.round(point[1] * 1e9)}`;
  const boundaryIndexForEdge = (a, b) => {
    const epsilon = 1e-8;
    if (Math.abs(a[1]) <= epsilon && Math.abs(b[1]) <= epsilon) return 0;
    if (Math.abs(a[0] + a[1] - 1) <= epsilon && Math.abs(b[0] + b[1] - 1) <= epsilon) return 1;
    if (Math.abs(a[0]) <= epsilon && Math.abs(b[0]) <= epsilon) return 2;
    return -1;
  };
  const result = [];
  for (const triangle of triangles) {
    const boundary = [];
    let subdivided = false;
    for (let edge = 0; edge < 3; edge++) {
      const a = triangle.points[edge];
      const b = triangle.points[(edge + 1) % 3];
      boundary.push(a);
      const boundaryIndex = boundaryIndexForEdge(a, b);
      if (boundaryIndex < 0) continue;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const lengthSquared = dx * dx + dy * dy;
      const interior = [];
      for (const point of boundaryPoints[boundaryIndex]) {
        const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared;
        if (t <= 1e-9 || t >= 1 - 1e-9) continue;
        const projectedX = a[0] + t * dx;
        const projectedY = a[1] + t * dy;
        if (Math.hypot(point[0] - projectedX, point[1] - projectedY) > 1e-8) continue;
        interior.push({ point, t });
      }
      interior.sort((left, right) => left.t - right.t);
      let lastKey = null;
      for (const entry of interior) {
        const key = pointKey(entry.point);
        if (key === lastKey) continue;
        boundary.push(entry.point);
        lastKey = key;
        subdivided = true;
      }
    }
    if (!subdivided) {
      result.push(triangle);
      continue;
    }
    const center = [
      (triangle.points[0][0] + triangle.points[1][0] + triangle.points[2][0]) / 3,
      (triangle.points[0][1] + triangle.points[1][1] + triangle.points[2][1]) / 3,
    ];
    for (let index = 0; index < boundary.length; index++) {
      const a = boundary[index];
      const b = boundary[(index + 1) % boundary.length];
      if (pointKey(a) === pointKey(b)) continue;
      result.push({ points: [a, b, center], samplePoint: triangle.samplePoint });
    }
  }
  return result;
}

function triangulatePaintGraph(textureSegments, boundaryPoints) {
  const nodes = [];
  const nodeByKey = new Map();
  const adjacency = [];
  const undirectedEdges = new Set();
  const keyFor = point => `${Math.round(point[0] * 1e9)}_${Math.round(point[1] * 1e9)}`;
  const addNode = point => {
    const key = keyFor(point);
    if (nodeByKey.has(key)) return nodeByKey.get(key);
    const index = nodes.length;
    nodeByKey.set(key, index);
    nodes.push(point);
    adjacency.push(new Set());
    return index;
  };
  const addEdge = (a, b) => {
    const ia = addNode(a);
    const ib = addNode(b);
    if (ia === ib) return;
    const key = ia < ib ? `${ia}|${ib}` : `${ib}|${ia}`;
    if (undirectedEdges.has(key)) return;
    undirectedEdges.add(key);
    adjacency[ia].add(ib);
    adjacency[ib].add(ia);
  };
  for (const segment of textureSegments) addEdge(segment[0], segment[1]);
  for (const edgePoints of boundaryPoints) {
    for (let i = 0; i + 1 < edgePoints.length; i++) addEdge(edgePoints[i], edgePoints[i + 1]);
  }

  const orderedNeighbors = adjacency.map((neighbors, index) =>
    [...neighbors].sort((a, b) =>
      Math.atan2(nodes[a][1] - nodes[index][1], nodes[a][0] - nodes[index][0]) -
      Math.atan2(nodes[b][1] - nodes[index][1], nodes[b][0] - nodes[index][0])
    )
  );
  const visitedDirections = new Set();
  const cycles = [];
  for (let start = 0; start < nodes.length; start++) {
    for (const first of orderedNeighbors[start]) {
      const initialKey = `${start}>${first}`;
      if (visitedDirections.has(initialKey)) continue;
      const cycle = [];
      let previous = start;
      let current = first;
      let valid = true;
      for (let steps = 0; steps <= undirectedEdges.size * 2 + 1; steps++) {
        const directionKey = `${previous}>${current}`;
        if (visitedDirections.has(directionKey)) {
          valid = previous === start && current === first;
          break;
        }
        visitedDirections.add(directionKey);
        cycle.push(previous);
        const neighbors = orderedNeighbors[current];
        const reverseIndex = neighbors.indexOf(previous);
        if (reverseIndex < 0 || neighbors.length === 0) {
          valid = false;
          break;
        }
        const next = neighbors[(reverseIndex - 1 + neighbors.length) % neighbors.length];
        previous = current;
        current = next;
        if (previous === start && current === first) break;
      }
      if (!valid || cycle.length < 3) continue;
      const uniqueCycle = cycle.filter((value, index) => index === 0 || value !== cycle[index - 1]);
      const points = uniqueCycle.map(index => nodes[index]);
      const area = polygonArea2D(points);
      if (Math.abs(area) > 1e-12) cycles.push({ indices: uniqueCycle, points, area });
    }
  }

  const shells = cycles.filter(cycle => cycle.area > 0).map(cycle => ({ ...cycle, holes: [] }));
  const holes = cycles.filter(cycle => cycle.area < 0);
  for (const hole of holes) {
    const interior = interiorPaintPolygonPoint(hole.points.slice().reverse());
    let owner = null;
    for (const shell of shells) {
      if (shell.area <= Math.abs(hole.area) + 1e-12 || !pointInPaintPolygon(interior, shell.points)) continue;
      if (!owner || shell.area < owner.area) owner = shell;
    }
    if (owner) owner.holes.push(hole);
  }

  const result = [];
  for (const shell of shells) {
    const contour = shell.points.map(point => new THREE.Vector2(point[0], point[1]));
    const holeVectors = shell.holes.map(hole => hole.points.map(point => new THREE.Vector2(point[0], point[1])));
    const triangles = THREE.ShapeUtils.triangulateShape(contour, holeVectors);
    const flattened = shell.points.concat(...shell.holes.map(hole => hole.points));
    if (triangles.length === 0) continue;
    const sampleTriangle = triangles[0].map(index => flattened[index]);
    const samplePoint = [
      (sampleTriangle[0][0] + sampleTriangle[1][0] + sampleTriangle[2][0]) / 3,
      (sampleTriangle[0][1] + sampleTriangle[1][1] + sampleTriangle[2][1]) / 3,
    ];
    for (const triangle of triangles) {
      const points = triangle.map(index => flattened[index]);
      if (Math.abs(polygonArea2D(points)) > 1e-14) result.push({ points, samplePoint });
    }
  }
  return conformPaintTriangleJunctions(result);
}

function paintBoundaryPointsForValidation(segments) {
  const parameters = [new Set([0, 1]), new Set([0, 1]), new Set([0, 1])];
  const register = point => {
    const x = point[0];
    const y = point[1];
    const epsilon = 1e-7;
    if (Math.abs(y) <= epsilon) parameters[0].add(Math.max(0, Math.min(1, x)));
    if (Math.abs(1 - x - y) <= epsilon) parameters[1].add(Math.max(0, Math.min(1, y)));
    if (Math.abs(x) <= epsilon) parameters[2].add(Math.max(0, Math.min(1, 1 - y)));
  };
  for (const segment of segments) {
    register(segment[0]);
    register(segment[1]);
  }
  const sorted = parameters.map(values => [...values].sort((a, b) => a - b));
  return [
    sorted[0].map(t => [t, 0]),
    sorted[1].map(t => [1 - t, t]),
    sorted[2].map(t => [0, 1 - t]),
  ];
}

function paintTriangulationSignature(tri, triangles) {
  const areaByState = new Map();
  const regionsByState = new Map();
  let coveredArea = 0;
  for (const triangle of triangles) {
    const area = Math.abs(polygonArea2D(triangle.points));
    coveredArea += area;
    const uv = localPaintPointToUv(tri, triangle.samplePoint);
    const paint = tri.sampleLocal
      ? tri.sampleLocal(triangle.samplePoint)
      : tri.sampler(uv[0], uv[1]);
    const state = paint.alpha < 128 ? -1 : paint.color;
    areaByState.set(state, (areaByState.get(state) || 0) + area);
    if (!regionsByState.has(state)) regionsByState.set(state, new Set());
    regionsByState.get(state).add(
      `${Math.round(triangle.samplePoint[0] * 1e9)}_${Math.round(triangle.samplePoint[1] * 1e9)}`
    );
  }
  return { areaByState, regionsByState, coveredArea };
}

function simplificationPreservesPaint(tri, exactSegments, simplifiedSegments) {
  if (simplifiedSegments.length === exactSegments.length) {
    const keyFor = segment => segment
      .map(point => `${Math.round(point[0] * 1e9)}_${Math.round(point[1] * 1e9)}`)
      .sort()
      .join('|');
    const exactKeys = exactSegments.map(keyFor).sort();
    const simplifiedKeys = simplifiedSegments.map(keyFor).sort();
    if (exactKeys.every((key, index) => key === simplifiedKeys[index])) return true;
  }
  const exactTriangles = triangulatePaintGraph(
    exactSegments, paintBoundaryPointsForValidation(exactSegments)
  );
  const simplifiedTriangles = triangulatePaintGraph(
    simplifiedSegments, paintBoundaryPointsForValidation(simplifiedSegments)
  );
  const exact = paintTriangulationSignature(tri, exactTriangles);
  const simplified = paintTriangulationSignature(tri, simplifiedTriangles);
  if (Math.abs(exact.coveredArea - 0.5) > 1e-7 ||
    Math.abs(simplified.coveredArea - 0.5) > 1e-7) return false;

  const states = new Set([...exact.areaByState.keys(), ...simplified.areaByState.keys()]);
  let totalAreaDifference = 0;
  for (const state of states) {
    const exactRegionCount = exact.regionsByState.get(state)?.size || 0;
    const simplifiedRegionCount = simplified.regionsByState.get(state)?.size || 0;
    if (exactRegionCount !== simplifiedRegionCount) return false;
    totalAreaDifference += Math.abs(
      (exact.areaByState.get(state) || 0) - (simplified.areaByState.get(state) || 0)
    );
  }

  // The tolerance may move a boundary slightly, but it must not materially
  // change a face's paint coverage. The normalized symmetric difference is
  // capped at 0.5% of the source triangle; unsafe faces use exact contours.
  return totalAreaDifference <= 0.0025 + 1e-9;
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
  paintResolutionMm = 0,
  paintOptions = {}
) {
  const refinePaintBoundaries = paintOptions?.refineBoundaries !== false;
  const overridePaintBudget = refinePaintBoundaries && paintOptions?.overrideBudget === true;
  const requestedAutomaticBudget = Number(paintOptions?.automaticTriangleBudget);
  const automaticTriangleBudget = Number.isFinite(requestedAutomaticBudget) && requestedAutomaticBudget > 0
    ? Math.floor(requestedAutomaticBudget)
    : RECOMMENDED_PAINT_OUTPUT_TRIANGLES;
  rootObject.updateWorldMatrix(true, true);
  const renderTriangles = [];
  const rootBox = new THREE.Box3();
  const allMats = [];
  forEachRenderableTriangle(rootObject, triangle => {
    renderTriangles.push(triangle);
    for (const point of triangle.positions) rootBox.expandByPoint(point);
    if (!allMats.includes(triangle.material)) allMats.push(triangle.material);
  });
  if (renderTriangles.length === 0 || rootBox.isEmpty()) {
    throw new Error('No visible mesh triangles found to export');
  }
  const unsupportedMaterial = allMats.find(material =>
    material?.isShaderMaterial || material?.isRawShaderMaterial || material?.isNodeMaterial
  );
  if (unsupportedMaterial) {
    throw new Error('Custom shader materials cannot be converted to printable colors. Bake the shader result to a base-color texture first.');
  }
  const animatedVertexColor = renderTriangles.find(({ mesh, geometry }) =>
    geometry.morphAttributes?.color?.length &&
    mesh.morphTargetInfluences?.some(influence => Math.abs(influence) > 1e-9)
  );
  if (animatedVertexColor) {
    throw new Error('Animated morph-target colors are not supported. Bake the current colors to a base-color texture or static vertex colors first.');
  }

  // 1. Calculate bounds from the same visible, rendered triangles that will
  // be emitted. This keeps hidden children from changing output size/position.
  const rootSize = rootBox.getSize(new THREE.Vector3());
  const maxDim = Math.max(rootSize.x, rootSize.y, rootSize.z) || 1.0;
  const scaleRatio = (targetSizeMm || 150.0) / maxDim;

  // In Three.js world space (Y-up), rotated to Z-up, newZ = worldY.
  // minZ is the lowest Y in world coordinates so model rests at Z=0.
  const minZ = rootBox.min.y;

  // 2. COLOR PALETTE: use only materials referenced by visible triangles.
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
      palette = quantizePaletteFromSamples(sampleModelSurfaceColors(rootObject), numColors);
    }
  }

  const indexLut = createIndexLUT(palette);
  const perceptualPalette = palette.map(srgbSampleToOklab);
  const linearPalette = palette.map(color => color.map(channel => srgbChannelToLinear(channel / 255)));

  const getClosestColor = (r, g, b) => {
    return closestPaletteIndex([r, g, b], palette, perceptualPalette);
  };
  const getClosestLinearColor = (red, green, blue) => {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < linearPalette.length; index++) {
      const color = linearPalette[index];
      const distance = (red - color[0]) ** 2 + (green - color[1]) ** 2 + (blue - color[2]) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    return bestIndex;
  };

  // Build a color sampler for each material
  const materialSamplers = new Map();
  const samplerMaterials = allMats.filter(m => m._originalMap?.image || m.map?.image);
  const samplerResolutionPlan = planTextureWorkingSizes(samplerMaterials.map(m => {
    const image = m._originalMap?.image || m.map?.image;
    return { width: image.width, height: image.height };
  }));
  const samplerResolutionByMaterial = new Map(
    samplerMaterials.map((material, index) => [material, samplerResolutionPlan[index]])
  );
  for (const m of allMats) {
    const img = m._originalMap?.image || m.map?.image;
    if (img) {
      let canvas = m._quantizedCanvas;
      let generatedLabels = null;
      if (!canvas || !isQuantizeEnabled) {
        const plannedSize = samplerResolutionByMaterial.get(m);
        canvas = document.createElement('canvas');
        canvas.width = plannedSize.width;
        canvas.height = plannedSize.height;
        const W = canvas.width;
        const H = canvas.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, W, H);
        const imgData = ctx.getImageData(0, 0, W, H);
        const d = imgData.data;
        const sourceMap = m._originalMap || m.map;
        const sourceColor = m._originalColor || m.color || new THREE.Color(1, 1, 1);

        let labels = new Uint8Array(W * H);
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
          const effective = effectiveTexturePixelSample(d, i, sourceMap, sourceColor);
          const idx = ((effective[0] >> 3) << 10) |
            ((effective[1] >> 3) << 5) | (effective[2] >> 3);
          labels[p] = indexLut[idx];
        }
        labels = processTextureLabels(labels, W, H, palette.length, despeckleSize, smoothLevel);
        generatedLabels = labels;

        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
          const c = palette[labels[p]];
          d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
        }
        ctx.putImageData(imgData, 0, 0);
        m._textureProcessingResolution = plannedSize;
      }

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const imgData = imageData.data;
      const map = m.map || m._originalMap;
      if (map?.matrixAutoUpdate !== false) map?.updateMatrix?.();
      const offset = map?.offset || new THREE.Vector2(0, 0);
      const repeat = map?.repeat || new THREE.Vector2(1, 1);
      const uvMatrix = map?.matrix?.elements ? Array.from(map.matrix.elements) : null;
      const wrapS = map?.wrapS ?? THREE.ClampToEdgeWrapping;
      const wrapT = map?.wrapT ?? THREE.ClampToEdgeWrapping;
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
      } else if (generatedLabels) {
        labels = generatedLabels;
      } else {
        labels = new Uint8Array(W * H);
        for (let i = 0, p = 0; i < imgData.length; i += 4, p++) {
          const lutIdx = ((imgData[i] >> 3) << 10) | ((imgData[i + 1] >> 3) << 5) | (imgData[i + 2] >> 3);
          labels[p] = indexLut[lutIdx];
        }
        labels = processTextureLabels(labels, W, H, palette.length, despeckleSize, smoothLevel);
      }

      const sampler = (rawU, rawV) => {
        const transformed = transformPaintUv({
          uvMatrix,
          repeatX: repeat.x,
          repeatY: repeat.y,
          offsetX: offset.x,
          offsetY: offset.y,
        }, rawU, rawV);
        const su = wrappedTextureCoordinate(transformed[0], wrapS);
        const sv = wrappedTextureCoordinate(transformed[1], wrapT);
        const px = Math.min(W - 1, Math.max(0, Math.floor(su * W)));
        // Match Three.js WebGL texture coordinate orientation:
        // In Three.js, textures default to flipY = true (v = 1.0 is canvas top row 0, v = 0.0 is bottom row H - 1).
        const finalV = (map?.flipY ?? true) ? (1.0 - sv) : sv;
        const py = Math.min(H - 1, Math.max(0, Math.floor(finalV * H)));
        const off = (py * W + px) * 4;
        const color = labels[py * W + px];
        const alpha = Math.round(imgData[off + 3] * Math.max(0, Math.min(1, m.opacity ?? 1)));
        return { color, alpha };
      };
      const rasterRgba = new Uint8ClampedArray(imgData);
      const opacity = Math.max(0, Math.min(1, m.opacity ?? 1));
      for (let pixel = 0; pixel < W * H; pixel++) {
        rasterRgba[pixel * 4 + 3] = Math.round(rasterRgba[pixel * 4 + 3] * opacity);
      }
      sampler.raster = {
        width: W,
        height: H,
        labels,
        rgba: rasterRgba,
        repeatX: repeat.x,
        repeatY: repeat.y,
        offsetX: offset.x,
        offsetY: offset.y,
        uvMatrix,
        wrapS,
        wrapT,
        flipY: map?.flipY ?? true,
        alphaThreshold: Math.min(256, Math.round((m.alphaTest || 0.5) * 255)),
      };
      materialSamplers.set(m, sampler);
    } else if (m.color) {
      const [r, g, b] = materialColorSample(m);
      const colIdx = getClosestColor(r, g, b);
      materialSamplers.set(m, () => ({
        color: colIdx,
        alpha: Math.round(255 * Math.max(0, Math.min(1, m.opacity ?? 1))),
      }));
    } else {
      materialSamplers.set(m, () => ({ color: 0, alpha: 255 }));
    }
  }

  // Alpha maps are independent textures in Three.js: their green channel,
  // transform, wrapping, and UV channel can all differ from the base map.
  const alphaSamplers = new Map();
  for (const material of allMats) {
    const texture = material.alphaMap;
    const image = texture?.image;
    if (!image?.width || !image?.height) continue;
    const planned = planTextureWorkingSizes([{ width: image.width, height: image.height }])[0];
    let source;
    if (image.data) {
      const channels = Math.max(1, Math.floor(image.data.length / (image.width * image.height)));
      source = new Uint8ClampedArray(planned.width * planned.height * 4);
      for (let y = 0; y < planned.height; y++) {
        const sourceY = Math.min(image.height - 1, Math.floor(y * image.height / planned.height));
        for (let x = 0; x < planned.width; x++) {
          const sourceX = Math.min(image.width - 1, Math.floor(x * image.width / planned.width));
          const sourceOffset = (sourceY * image.width + sourceX) * channels;
          const targetOffset = (y * planned.width + x) * 4;
          const red = image.data[sourceOffset] ?? 0;
          source[targetOffset] = red;
          source[targetOffset + 1] = channels > 1 ? image.data[sourceOffset + 1] : red;
          source[targetOffset + 2] = channels > 2 ? image.data[sourceOffset + 2] : red;
          source[targetOffset + 3] = channels > 3 ? image.data[sourceOffset + 3] : 255;
        }
      }
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = planned.width;
      canvas.height = planned.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      source = context.getImageData(0, 0, canvas.width, canvas.height).data;
    }
    if (texture.matrixAutoUpdate !== false) texture.updateMatrix?.();
    const rasterRgba = new Uint8ClampedArray(source);
    const labels = new Uint8Array(planned.width * planned.height);
    for (let pixel = 0; pixel < labels.length; pixel++) {
      rasterRgba[pixel * 4 + 3] = source[pixel * 4 + 1];
    }
    const raster = {
      width: planned.width,
      height: planned.height,
      labels,
      rgba: rasterRgba,
      repeatX: texture.repeat?.x ?? 1,
      repeatY: texture.repeat?.y ?? 1,
      offsetX: texture.offset?.x ?? 0,
      offsetY: texture.offset?.y ?? 0,
      uvMatrix: texture.matrix?.elements ? Array.from(texture.matrix.elements) : null,
      wrapS: texture.wrapS ?? THREE.ClampToEdgeWrapping,
      wrapT: texture.wrapT ?? THREE.ClampToEdgeWrapping,
      flipY: texture.flipY ?? true,
      alphaThreshold: Math.min(
        256,
        Math.round((material.alphaTest || 0.5) * 255 /
          Math.max(1e-9, Math.max(0, Math.min(1, material.opacity ?? 1))))
      ),
    };
    const sample = (rawU, rawV) => {
      const transformed = transformPaintUv(raster, rawU, rawV);
      const u = wrappedTextureCoordinate(transformed[0], raster.wrapS);
      const v = wrappedTextureCoordinate(transformed[1], raster.wrapT);
      const x = Math.min(raster.width - 1, Math.max(0, Math.floor(u * raster.width)));
      const finalV = raster.flipY ? 1 - v : v;
      const y = Math.min(raster.height - 1, Math.max(0, Math.floor(finalV * raster.height)));
      return source[(y * raster.width + x) * 4 + 1];
    };
    sample.raster = raster;
    alphaSamplers.set(material, sample);
  }

  // 3. COLLECT INITIAL TRIANGLES ACROSS ALL MESHES
  const initialTriangles = [];
  const uvAttributeFor = (geometry, texture) => {
    const channel = Math.max(0, Math.floor(Number(texture?.channel) || 0));
    return geometry.getAttribute(channel === 0 ? 'uv' : `uv${channel}`);
  };
  const vertexComponent = (attribute, index, component, fallback) => {
    if (!attribute || component >= attribute.itemSize) return fallback;
    if (component === 0) return attribute.getX(index);
    if (component === 1) return attribute.getY(index);
    if (component === 2) return attribute.getZ(index);
    return attribute.getW(index);
  };

  for (const triangle of renderTriangles) {
      const { geometry: geo, material: mat, indices, positions, instanceColor } = triangle;
      const sampler = materialSamplers.get(mat) || (() => ({ color: 0, alpha: 255 }));
      const sourceMap = mat._originalMap || mat.map;
      const uvAttr = uvAttributeFor(geo, sourceMap);
      const alphaSampler = alphaSamplers.get(mat) || null;
      const alphaUvAttr = uvAttributeFor(geo, mat.alphaMap);
      const colorAttr = mat.vertexColors ? geo.getAttribute('color') : null;
      const [i0, i1, i2] = indices;
      const [tempV0, tempV1, tempV2] = positions;

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

      const alphaUv = [i0, i1, i2].map(index => [
        alphaUvAttr ? alphaUvAttr.getX(index) : 0,
        alphaUvAttr ? alphaUvAttr.getY(index) : 0,
      ]);
      const initialTriangle = {
        p0: [x0, y0, z0],
        p1: [x1, y1, z1],
        p2: [x2, y2, z2],
        u0, v0: v0_uv,
        u1, v1: v1_uv,
        u2, v2: v2_uv,
        sampler,
        raster: sampler.raster || null,
        vertexColors: colorAttr ? [i0, i1, i2].map(index => [
          vertexComponent(colorAttr, index, 0, 1),
          vertexComponent(colorAttr, index, 1, 1),
          vertexComponent(colorAttr, index, 2, 1),
          vertexComponent(colorAttr, index, 3, 1),
        ]) : null,
        instanceColor: instanceColor ? [instanceColor.r, instanceColor.g, instanceColor.b] : null,
      };
      initialTriangle.paintRasters = [];
      if (sampler.raster) {
        initialTriangle.paintRasters.push({
          raster: sampler.raster,
          uv: [[u0, v0_uv], [u1, v1_uv], [u2, v2_uv]],
        });
      }
      if (alphaSampler?.raster) {
        initialTriangle.paintRasters.push({ raster: alphaSampler.raster, uv: alphaUv });
      }
      initialTriangle.sampleLocal = point => {
        const weights = [1 - point[0] - point[1], point[0], point[1]];
        const paintUv = localPaintPointToUv(initialTriangle, point);
        const paint = sampler(paintUv[0], paintUv[1]);
        let alpha = paint.alpha;
        if (alphaSampler) {
          const alphaU = weights[0] * alphaUv[0][0] + weights[1] * alphaUv[1][0] + weights[2] * alphaUv[2][0];
          const alphaV = weights[0] * alphaUv[0][1] + weights[1] * alphaUv[1][1] + weights[2] * alphaUv[2][1];
          alpha *= alphaSampler(alphaU, alphaV) / 255;
        }
        let color = paint.color;
        if (initialTriangle.vertexColors || initialTriangle.instanceColor) {
          const source = palette[color] || palette[0];
          const solidBaseColor = !sourceMap ? (mat._originalColor || mat.color) : null;
          let linearRed = solidBaseColor?.r ?? srgbChannelToLinear(source[0] / 255);
          let linearGreen = solidBaseColor?.g ?? srgbChannelToLinear(source[1] / 255);
          let linearBlue = solidBaseColor?.b ?? srgbChannelToLinear(source[2] / 255);
          if (initialTriangle.vertexColors) {
            const colors = initialTriangle.vertexColors;
            linearRed *= weights[0] * colors[0][0] + weights[1] * colors[1][0] + weights[2] * colors[2][0];
            linearGreen *= weights[0] * colors[0][1] + weights[1] * colors[1][1] + weights[2] * colors[2][1];
            linearBlue *= weights[0] * colors[0][2] + weights[1] * colors[1][2] + weights[2] * colors[2][2];
            alpha *= weights[0] * colors[0][3] + weights[1] * colors[1][3] + weights[2] * colors[2][3];
          }
          if (initialTriangle.instanceColor) {
            linearRed *= initialTriangle.instanceColor[0];
            linearGreen *= initialTriangle.instanceColor[1];
            linearBlue *= initialTriangle.instanceColor[2];
          }
          color = getClosestLinearColor(linearRed, linearGreen, linearBlue);
        }
        const cutoff = Math.max(0, Math.min(1, mat.alphaTest || 0.5));
        return { color, alpha: alpha / 255 < cutoff ? 0 : 255 };
      };
      initialTriangles.push(initialTriangle);
  }

  // 4. TRACE THE DISCRETE TEXTURE BOUNDARIES, THEN CONSTRAIN THE MESH TO THEM.
  // Unlike probe-based midpoint subdivision, this preserves enclosed features
  // and spends triangles on contours instead of uniformly across painted areas.
  const exportCoordinateFactor = 1000000;
  const exportCoordinateDecimals = 6;

  function getPosKey(x, y, z) {
    return `${Math.round(x * exportCoordinateFactor)}_${Math.round(y * exportCoordinateFactor)}_${Math.round(z * exportCoordinateFactor)}`;
  }

  function getEdgeKey(pA, pB) {
    const kA = getPosKey(pA[0], pA[1], pA[2]);
    const kB = getPosKey(pB[0], pB[1], pB[2]);
    return kA < kB ? `${kA}|${kB}` : `${kB}|${kA}`;
  }
  const numericTolerance = Number(paintResolutionMm);
  const boundaryToleranceMm = Number.isFinite(numericTolerance)
    ? Math.max(0, Math.min(2, numericTolerance))
    : 0;
  const traceStats = {
    scanSteps: 0,
    boundarySegments: 0,
    degenerateUvTriangles: 0,
    exactFallbackFaces: 0,
    faceSamplingFallbacks: 0,
    ignoreResourceLimits: overridePaintBudget,
  };
  const sharedEdgeSplits = new Map();
  const vertexColoredTriangleCount = initialTriangles.reduce(
    (count, triangle) => count + (triangle.vertexColors ? 1 : 0), 0
  );
  const vertexTraceDivisions = vertexColoredTriangleCount > 0
    ? (overridePaintBudget
      ? 32
      : Math.max(2, Math.min(32, Math.floor(Math.sqrt(500000 / vertexColoredTriangleCount)))))
    : 0;

  function registerSharedEdgeSplit(pA, pB, t) {
    const keyA = getPosKey(pA[0], pA[1], pA[2]);
    const keyB = getPosKey(pB[0], pB[1], pB[2]);
    const edgeKey = getEdgeKey(pA, pB);
    const canonicalT = keyA <= keyB ? t : 1 - t;
    if (!sharedEdgeSplits.has(edgeKey)) sharedEdgeSplits.set(edgeKey, []);
    const values = sharedEdgeSplits.get(edgeKey);
    if (!values.some(value => Math.abs(value - canonicalT) <= 1e-8)) {
      values.push(Math.max(0, Math.min(1, canonicalT)));
    }
  }

  function registerBoundaryPoint(tri, point) {
    const x = point[0];
    const y = point[1];
    const epsilon = 1e-7;
    if (Math.abs(y) <= epsilon) registerSharedEdgeSplit(tri.p0, tri.p1, x);
    if (Math.abs(1 - x - y) <= epsilon) registerSharedEdgeSplit(tri.p1, tri.p2, y);
    if (Math.abs(x) <= epsilon) registerSharedEdgeSplit(tri.p2, tri.p0, 1 - y);
  }

  // Automatic refinement uses the recommendation as a guardrail. Explicit
  // existing-triangle mode skips tracing, while an override removes every
  // application-imposed resource budget and either succeeds or reports an
  // error without silently changing the requested result.
  let denseMeshPaintFallback = !refinePaintBoundaries || (
    !overridePaintBudget && shouldUseDenseMeshPaintFallback(
      initialTriangles.length,
      automaticTriangleBudget
    )
  );
  let projectedBoundarySegments = 0;
  const tracePaintBoundaries = () => {
    for (const tri of initialTriangles) {
      const exactSegments = traceTextureBoundarySegments(tri, traceStats);
      exactSegments.push(...traceVertexColorBoundarySegments(tri, traceStats, vertexTraceDivisions));
      tri.exactPaintBoundarySegments = exactSegments;
      const simplifiedSegments = simplifyPaintBoundaryNetwork(exactSegments, tri, boundaryToleranceMm);
      if (boundaryToleranceMm > 0 &&
        !simplificationPreservesPaint(tri, exactSegments, simplifiedSegments)) {
        tri.paintBoundarySegments = simplifyPaintBoundaryNetwork(exactSegments, tri, 0);
        traceStats.exactFallbackFaces++;
      } else {
        tri.paintBoundarySegments = simplifiedSegments;
      }
      projectedBoundarySegments += tri.paintBoundarySegments.length;
      if (!overridePaintBudget && shouldUseDenseMeshPaintFallback(
        initialTriangles.length,
        automaticTriangleBudget,
        projectedBoundarySegments
      )) {
        throw new Error('Projected paint mesh exceeds the recommended automatic paint budget.');
      }
      for (const segment of tri.paintBoundarySegments) {
        registerBoundaryPoint(tri, segment[0]);
        registerBoundaryPoint(tri, segment[1]);
      }
    }
  };
  if (!denseMeshPaintFallback) {
    try {
      tracePaintBoundaries();
    } catch (error) {
      if (overridePaintBudget) {
        throw new Error(`Refined paint export could not be completed: ${error?.message || 'boundary tracing failed'}. Turn off Refine Color Boundaries and try again.`);
      }
      if (!/too complex to trace safely|too many texels to trace safely|automatic paint budget/i.test(error?.message || '')) {
        throw error;
      }
      denseMeshPaintFallback = true;
      sharedEdgeSplits.clear();
    }
  }
  if (denseMeshPaintFallback) {
    traceStats.faceSamplingFallbacks = initialTriangles.length;
    traceStats.boundarySegments = 0;
    for (const tri of initialTriangles) {
      tri.exactPaintBoundarySegments = [];
      tri.paintBoundarySegments = [];
    }
  }

  function sharedEdgeParameters(pA, pB) {
    const keyA = getPosKey(pA[0], pA[1], pA[2]);
    const keyB = getPosKey(pB[0], pB[1], pB[2]);
    const canonical = sharedEdgeSplits.get(getEdgeKey(pA, pB)) || [];
    const parameters = canonical.map(value => keyA <= keyB ? value : 1 - value);
    parameters.push(0, 1);
    parameters.sort((a, b) => a - b);
    return parameters.filter((value, index) => index === 0 || Math.abs(value - parameters[index - 1]) > 1e-8);
  }

  function triangleBoundaryPoints(tri) {
    return [
      sharedEdgeParameters(tri.p0, tri.p1).map(t => [t, 0]),
      sharedEdgeParameters(tri.p1, tri.p2).map(t => [1 - t, t]),
      sharedEdgeParameters(tri.p2, tri.p0).map(t => [0, 1 - t]),
    ];
  }

  function triangulateBoundaryFan(sourceBoundaryPoints) {
    const perimeter = [
      ...sourceBoundaryPoints[0].slice(0, -1),
      ...sourceBoundaryPoints[1].slice(0, -1),
      ...sourceBoundaryPoints[2].slice(0, -1),
    ];
    const center = [1 / 3, 1 / 3];
    return perimeter.map((point, index) => {
      const next = perimeter[(index + 1) % perimeter.length];
      return {
        points: [center, point, next],
        samplePoint: [
          (center[0] + point[0] + next[0]) / 3,
          (center[1] + point[1] + next[1]) / 3,
        ],
      };
    });
  }

  const currentTriangles = [];
  for (const sourceTri of initialTriangles) {
    const sourceBoundaryPoints = triangleBoundaryPoints(sourceTri);
    let localTriangles = triangulatePaintGraph(
      sourceTri.paintBoundarySegments,
      sourceBoundaryPoints
    );
    let coveredArea = localTriangles.reduce(
      (sum, region) => sum + Math.abs(polygonArea2D(region.points)), 0
    );
    if (boundaryToleranceMm > 0 && Math.abs(coveredArea - 0.5) > 1e-7) {
      // An aggressive simplification can make nearby contours cross. Revert
      // this source face to its exact shared boundary instead of emitting an
      // overlapping or incomplete surface.
      sourceTri.paintBoundarySegments = simplifyPaintBoundaryNetwork(
        sourceTri.exactPaintBoundarySegments, sourceTri, 0
      );
      localTriangles = triangulatePaintGraph(
        sourceTri.paintBoundarySegments,
        sourceBoundaryPoints
      );
      coveredArea = localTriangles.reduce(
        (sum, region) => sum + Math.abs(polygonArea2D(region.points)), 0
      );
    }
    localTriangles = conformPaintSourceBoundary(localTriangles, sourceBoundaryPoints);
    coveredArea = localTriangles.reduce(
      (sum, region) => sum + Math.abs(polygonArea2D(region.points)), 0
    );
    sourceTri.exactPaintBoundarySegments = null;
    const hasSharedEdgeSplits = sourceBoundaryPoints.some(points => points.length > 2);
    if (localTriangles.length === 0 && sourceTri.paintBoundarySegments.length === 0 && !hasSharedEdgeSplits) {
      localTriangles = [{
        points: [[0, 0], [1, 0], [0, 1]],
        samplePoint: [1 / 3, 1 / 3],
      }];
      coveredArea = 0.5;
    }
    if (Math.abs(coveredArea - 0.5) > 1e-7) {
      if (overridePaintBudget) {
        throw new Error('Refined paint export could not triangulate a color boundary without gaps. Turn off Refine Color Boundaries and try again.');
      }
      // Keep the source face rather than failing the whole export. Boundary
      // edge splits are retained so adjacent faces remain conforming, while
      // paint within this numerically pathological face is sampled per region.
      localTriangles = triangulateBoundaryFan(sourceBoundaryPoints);
      coveredArea = localTriangles.reduce(
        (sum, region) => sum + Math.abs(polygonArea2D(region.points)), 0
      );
      traceStats.faceSamplingFallbacks++;
    }

    for (const regionTriangle of localTriangles) {
      let localTriangle = regionTriangle.points;
      if (polygonArea2D(localTriangle) < 0) {
        localTriangle = [localTriangle[0], localTriangle[2], localTriangle[1]];
      }
      const centerUv = localPaintPointToUv(sourceTri, regionTriangle.samplePoint);
      const paint = sourceTri.sampleLocal
        ? sourceTri.sampleLocal(regionTriangle.samplePoint)
        : sourceTri.sampler(centerUv[0], centerUv[1]);
      const positions = localTriangle.map(point => localPaintPointToPosition(sourceTri, point));
      const uvs = localTriangle.map(point => localPaintPointToUv(sourceTri, point));
      currentTriangles.push({
        p0: positions[0], p1: positions[1], p2: positions[2],
        u0: uvs[0][0], v0: uvs[0][1],
        u1: uvs[1][0], v1: uvs[1][1],
        u2: uvs[2][0], v2: uvs[2][1],
        sampler: sourceTri.sampler,
        chosenColor: paint.color,
        alpha: paint.alpha,
      });
      if (!denseMeshPaintFallback && !overridePaintBudget && currentTriangles.length > automaticTriangleBudget) {
        throw new Error(`Traced paint mesh exceeds the ${automaticTriangleBudget.toLocaleString()}-triangle automatic paint budget. Turn off Refine Color Boundaries or enable its override.`);
      }
    }
  }

  // 5. WELD VERTICES AND EMIT WATERTIGHT MULTI-MATERIAL 3MF MESH
  const coordMap = new Map();
  const weldedVertices = [];

  function getOrAddWeldedVertex(x, y, z) {
    const ix = Math.round(x * exportCoordinateFactor);
    const iy = Math.round(y * exportCoordinateFactor);
    const iz = Math.round(z * exportCoordinateFactor);
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
    // PrusaSlicer and Bambu/Orca use the same TriangleSelector hexadecimal
    // bitstream; only the attribute name differs. A plain palette index in
    // paint_color is decoded as a partial-triangle subdivision instruction.
    allTrianglesXml += `<triangle v1="${v0}" v2="${v1}" v3="${v2}" slic3rpe:mmu_segmentation="${mmuHex}" paint_color="${mmuHex}" pid="1" p1="${colorIdx}" />\n`;
    emittedTriangleCount++;
  }

  for (let i = 0; i < currentTriangles.length; i++) {
    const tri = currentTriangles[i];
    const { p0, p1, p2, chosenColor, alpha } = tri;

    // A fully transparent decal triangle contributes no paint. This only
    // removes the transparent overlay face; the underlying model remains in
    // the export and is never carved by this step.
    if (alpha < 128) continue;

    const v0_idx = getOrAddWeldedVertex(p0[0], p0[1], p0[2]);
    const v1_idx = getOrAddWeldedVertex(p1[0], p1[1], p1[2]);
    const v2_idx = getOrAddWeldedVertex(p2[0], p2[1], p2[2]);

    if (v0_idx !== v1_idx && v1_idx !== v2_idx && v0_idx !== v2_idx) {
      emitTriangle(v0_idx, v1_idx, v2_idx, chosenColor);
    }
  }

  rootObject._lastPaintBake = {
    boundaryToleranceMm,
    requestedResolutionMm: boundaryToleranceMm,
    refinementPasses: 0,
    refinementLimited: false,
    tracedBoundarySegments: traceStats.boundarySegments,
    degenerateUvTriangles: traceStats.degenerateUvTriangles,
    exactFallbackFaces: traceStats.exactFallbackFaces,
    faceSamplingFallbacks: traceStats.faceSamplingFallbacks,
    denseMeshPaintFallback,
    requestedBoundaryRefinement: refinePaintBoundaries,
    paintBudgetOverride: overridePaintBudget,
    paintMode: denseMeshPaintFallback ? 'existing-triangles' : 'refined-boundaries',
    projectedTriangleCount: projectPaintOutputTriangles(
      initialTriangles.length,
      projectedBoundarySegments
    ),
    triangleCount: emittedTriangleCount,
  };

  let verticesXml = '';
  for (let i = 0; i < weldedVertices.length; i++) {
    const v = weldedVertices[i];
    verticesXml += `<vertex x="${v[0].toFixed(exportCoordinateDecimals)}" y="${v[1].toFixed(exportCoordinateDecimals)}" z="${v[2].toFixed(exportCoordinateDecimals)}" />\n`;
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

  const archiveFiles = {
    '[Content_Types].xml': strToU8(contentTypesXml),
    '_rels/.rels': strToU8(relsXml),
    '3D/3dmodel.model': strToU8(modelXml)
  };
  return new Promise(resolve => {
    try {
      zip(archiveFiles, (error, archive) => {
        resolve((error ? zipSync(archiveFiles) : archive).buffer);
      });
    } catch {
      resolve(zipSync(archiveFiles).buffer);
    }
  });
}

function textureHasTransparentPixels(texture) {
  const image = texture?.image;
  if (!image) return false;
  let data = image.data;
  let channels = 0;
  if (data && image.width && image.height) {
    channels = Math.floor(data.length / (image.width * image.height));
  } else {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      channels = 4;
    } catch {
      return true;
    }
  }
  if (channels < 4) return false;
  for (let offset = 3; offset < data.length; offset += channels) {
    if (data[offset] < 255) return true;
  }
  return false;
}

/**
 * Exports GLB, respecting active color quantization toggle and custom palette.
 */
export function exportProcessedGlb(model, {
  GLTFExporter = globalThis.GLTFExporter,
  textureFormat = 'automatic',
} = {}) {
  return new Promise((resolve, reject) => {
    if (!model) return reject(new Error('No model to export'));
    if (!GLTFExporter) return reject(new Error('GLTFExporter is required'));

    const normalizedTextureFormat = textureFormat === 'original' ? 'automatic' : textureFormat;
    if (!['automatic', 'png', 'jpeg'].includes(normalizedTextureFormat)) {
      return reject(new Error(`Unsupported GLB texture encoding: ${textureFormat}`));
    }
    const textureMimeType = normalizedTextureFormat === 'png'
      ? 'image/png'
      : normalizedTextureFormat === 'jpeg' ? 'image/jpeg' : null;
    const textureSlots = [
      'map', 'alphaMap', 'aoMap', 'bumpMap', 'normalMap', 'displacementMap',
      'emissiveMap', 'metalnessMap', 'roughnessMap', 'clearcoatMap',
      'clearcoatNormalMap', 'clearcoatRoughnessMap', 'iridescenceMap',
      'iridescenceThicknessMap', 'sheenColorMap', 'sheenRoughnessMap',
      'specularColorMap', 'specularIntensityMap', 'thicknessMap', 'transmissionMap',
    ];
    const exportScene = model.clone(true);
    const textureClones = new Map();
    exportScene.traverse(child => {
      if (child.isMesh) {
        child.geometry = child.geometry.clone();
        if (child.material) {
          const cloneMaterial = material => {
            const cloned = material.clone();
            if (normalizedTextureFormat === 'jpeg' &&
              (material.alphaMap || material.transparent || (material.opacity ?? 1) < 1 ||
                ((material.alphaTest || 0) > 0 && textureHasTransparentPixels(material.map)))) {
              throw new Error('JPEG cannot preserve transparency used by this model. Choose Automatic or PNG.');
            }
            for (const slot of textureSlots) {
              if (!cloned[slot]) continue;
              const sourceTexture = cloned[slot];
              if (!textureClones.has(sourceTexture)) {
                textureClones.set(sourceTexture, sourceTexture.clone());
              }
              cloned[slot] = textureClones.get(sourceTexture);
              const outputMimeType = textureMimeType ||
                (sourceTexture.userData?.mimeType === 'image/webp' ? 'image/png' : null);
              if (outputMimeType) {
                cloned[slot].userData = {
                  ...cloned[slot].userData,
                  mimeType: outputMimeType,
                };
              }
            }
            return cloned;
          };
          child.material = Array.isArray(child.material)
            ? child.material.map(cloneMaterial)
            : cloneMaterial(child.material);
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

/** Reports whether a model contains authored color information worth processing. */
export function analyzeModelColorSources(rootObject) {
  const result = {
    hasAuthoredColor: false,
    textureCount: 0,
    vertexColorMeshCount: 0,
    solidColorCount: 0,
  };
  if (!rootObject) return result;
  const textures = new Set();
  const solidColors = new Set();
  rootObject.traverse(child => {
    if (!child.isMesh || !child.geometry || !isObjectVisible(child)) return;
    const colorAttribute = child.geometry.getAttribute('color');
    if (colorAttribute && colorAttribute.count > 0) result.vertexColorMeshCount++;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material || material.visible === false) continue;
      const map = material._originalMap || material.map;
      if (map?.image) textures.add(map);
      if (!material._texture2PaintFallback && material.color) {
        const sample = colorToSrgbSample(material._originalColor || material.color);
        if (sample) solidColors.add(sample.join(','));
      }
    }
  });
  result.textureCount = textures.size;
  result.solidColorCount = solidColors.size;
  const hasMeaningfulSolidColor = [...solidColors].some(key => key !== '255,255,255');
  result.hasAuthoredColor = result.textureCount > 0 || result.vertexColorMeshCount > 0 ||
    hasMeaningfulSolidColor || result.solidColorCount > 1;
  return result;
}

export function getModelTextures(rootObject) {
  if (!rootObject) return [];
  const textures = new Map();
  rootObject.traverse(child => {
    if (child.isMesh && child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        if (!mat) continue;
        for (const [slot, texture] of [['BaseColor', mat.map], ['Alpha', mat.alphaMap]]) {
          if (!texture || textures.has(texture)) continue;
          const resolution = slot === 'BaseColor' ? mat._textureProcessingResolution : null;
          textures.set(texture, {
            slot,
            width: texture.image?.width || 0,
            height: texture.image?.height || 0,
            mimeType: texture.userData?.mimeType || 'image/embedded',
            sourceWidth: resolution?.sourceWidth || texture.image?.width || 0,
            sourceHeight: resolution?.sourceHeight || texture.image?.height || 0,
            downsampled: resolution?.downsampled || false,
          });
        }
      }
    }
  });
  return Array.from(textures.values());
}

/** Extracts embedded image payloads from a binary glTF container. */
export function extractGlbImages(buffer) {
  if (ArrayBuffer.isView(buffer)) {
    buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 20) return [];
  try {
    const view = new DataView(buffer);
    let baseOffset = 0;
    if (view.getUint32(0, true) !== 0x46546c67) {
      // Node Buffers may expose a pooled backing ArrayBuffer with a non-zero
      // byte offset. Accept the first internally valid GLB header in that case.
      const bytes = new Uint8Array(buffer);
      baseOffset = -1;
      for (let i = 0; i <= bytes.length - 12; i++) {
        if (bytes[i] === 0x67 && bytes[i + 1] === 0x6c && bytes[i + 2] === 0x54 && bytes[i + 3] === 0x46) {
          const candidate = new DataView(buffer, i);
          const length = candidate.getUint32(8, true);
          if (candidate.getUint32(4, true) === 2 && length >= 20 && i + length <= buffer.byteLength) {
            baseOffset = i;
            break;
          }
        }
      }
      if (baseOffset < 0) return [];
    }
    if (view.getUint32(baseOffset + 4, true) !== 2) return [];
    const declaredLength = view.getUint32(baseOffset + 8, true);
    const declaredEnd = baseOffset + declaredLength;
    if (declaredEnd > buffer.byteLength) return [];
    let offset = baseOffset + 12;
    let json = null;
    let binary = null;
    while (offset + 8 <= declaredEnd) {
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const start = offset + 8;
      const end = start + length;
      if (end > declaredEnd) return [];
      if (type === 0x4e4f534a) {
        json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length)).trim());
      } else if (type === 0x004e4942) {
        binary = new Uint8Array(buffer, start, length);
      }
      offset = end;
    }
    if (!json || !binary) return [];
    const images = [];
    for (const image of json.images || []) {
      if (image.bufferView === undefined) continue;
      const bufferView = json.bufferViews?.[image.bufferView];
      if (!bufferView || (bufferView.buffer || 0) !== 0) continue;
      const start = bufferView.byteOffset || 0;
      const end = start + bufferView.byteLength;
      if (start < 0 || end > binary.byteLength) continue;
      const bytes = binary.slice(start, end);
      images.push({
        bytes,
        data: bytes,
        mimeType: image.mimeType || 'application/octet-stream',
        byteLength: bytes.byteLength,
      });
    }
    return images;
  } catch {
    return [];
  }
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

  if (options.diagnosticOnly) {
    return {
      geometry: null,
      stats: {
        weldedVertices: weldedVerticesCount,
        holesClosed: 0,
        addedTriangles: 0,
        openEdgesBefore,
        openEdgesAfter: openEdgesBefore,
        isWatertight: openEdgesBefore === 0 && activeTriangles.length > 0,
        totalTriangles: activeTriangles.length,
      },
    };
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
  canonicalizeModel(rootObject, { mergeMeshes: true });
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
      const diag = repairBufferGeometry(geo, {
        tolerance,
        closeHoles: false,
        diagnosticOnly: true,
      });
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
