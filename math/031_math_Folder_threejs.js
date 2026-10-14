// file number : 031
// full path name : src/math/Custom math_Folder_threejs.js
// description : Single entry point for the entire rewritten three.js r185 math module (files 001–030). Every file is namespace-exported under `<Name>Module`, so every export from every file is reachable without ambiguity — the namespace surface alone guarantees no missing export. Top-level named exports are provided ONLY for names that are unique across all 30 files: primary classes, bitecs components, shared pools, universal constants, per-type bridges, theme constants, and color-space lookup helpers. Colliding names (`precise*`, `setFromNoise*`, `disposeNoise*`, `SCALE_UNITS`, `PLANET_RADIUS`, and the color-space transfer helpers shared between 017/018/030) are reachable ONLY through their namespaces, which guarantees there are no silent shadowing collisions at the top level. Every default export from files 002–030 is surfaced via `export { default as Xxx }` so consumers get a single import path for the whole math package.
// best for  :  `import { Vector3, Quaternion, Color, bitecsVec3FromBitecs } from './Custom math_Folder_threejs.js'`. Also lets consumers reach colliding helper names via `import { Vector2Module, Vector3Module } from './Custom math_Folder_threejs.js'` and then `Vector2Module.preciseLength(v)` vs `Vector3Module.preciseLength(v)`.
// license : MIT

/* ==========================================================================
 * SECTION 1 — NAMESPACE EXPORTS (30 files)
 * --------------------------------------------------------------------------
 * Every export of every file is reachable as `<Name>Module.<exportName>`.
 * This is the collision-free surface that guarantees no missing export.
 * ========================================================================== */

export * as MathUtilsModule                  from './001_MathUtils.js';
export * as Vector2Module                    from './002_Vector2.js';
export * as Vector3Module                    from './003_Vector3.js';
export * as QuaternionModule                 from './004_Quaternion.js';
export * as Matrix2Module                    from './005_Matrix2.js';
export * as Matrix3Module                    from './006_Matrix3.js';
export * as Matrix4Module                    from './007_Matrix4.js';
export * as EulerModule                      from './008_Euler.js';
export * as Line3Module                      from './009_Line3.js';
export * as PlaneModule                      from './010_Plane.js';
export * as SphereModule                     from './011_Sphere.js';
export * as Box3Module                       from './012_Box3.js';
export * as RayModule                        from './013_Ray.js';
export * as TriangleModule                   from './014_Triangle.js';
export * as FrustumModule                    from './015_Frustum.js';
export * as Vector4Module                    from './016_Vector4.js';
export * as ColorManagementModule            from './017_ColorManagement.js';
export * as ColorModule                      from './018_Color.js';
export * as CylindricalModule                from './019_Cylindrical.js';
export * as SphericalModule                  from './020_Spherical.js';
export * as SphericalHarmonics3Module        from './021_SphericalHarmonics3.js';
export * as InterpolantModule                from './022_Interpolant.js';
export * as CubicInterpolantModule           from './023_CubicInterpolant.js';
export * as LinearInterpolantModule          from './024_LinearInterpolant.js';
export * as DiscreteInterpolantModule        from './025_DiscreteInterpolant.js';
export * as QuaternionLinearInterpolantModule from './026_QuaternionLinearInterpolant.js';
export * as Box2Module                       from './027_Box2.js';
export * as BezierInterpolantModule          from './028_BezierInterpolant.js';
export * as OBBModule                        from './029_OBB.js';
export * as ColorSpaceModule                 from './030_ColorSpace.js';

/* ==========================================================================
 * SECTION 2 — PRIMARY CLASS / OBJECT EXPORTS (one per file)
 * --------------------------------------------------------------------------
 * These names are unique across all 30 files, so they can safely be
 * re-exported at the top level. Each is the file's default export (or its
 * canonical named export, for files that have no default).
 * ========================================================================== */

export { MathUtils } from './001_MathUtils.js';
export { default as Vector2 } from './002_Vector2.js';
export { default as Vector3 } from './003_Vector3.js';
export { default as Quaternion } from './004_Quaternion.js';
export { default as Matrix2 } from './005_Matrix2.js';
export { default as Matrix3 } from './006_Matrix3.js';
export { default as Matrix4 } from './007_Matrix4.js';
export { default as Euler } from './008_Euler.js';
export { default as Line3 } from './009_Line3.js';
export { default as Plane } from './010_Plane.js';
export { default as Sphere } from './011_Sphere.js';
export { default as Box3 } from './012_Box3.js';
export { default as Ray } from './013_Ray.js';
export { default as Triangle } from './014_Triangle.js';
export { default as Frustum } from './015_Frustum.js';
export { default as Vector4 } from './016_Vector4.js';
export { default as ColorManagement } from './017_ColorManagement.js';
export { default as Color } from './018_Color.js';
export { default as Cylindrical } from './019_Cylindrical.js';
export { default as Spherical } from './020_Spherical.js';
export { default as SphericalHarmonics3 } from './021_SphericalHarmonics3.js';
export { default as Interpolant } from './022_Interpolant.js';
export { default as CubicInterpolant } from './023_CubicInterpolant.js';
export { default as LinearInterpolant } from './024_LinearInterpolant.js';
export { default as DiscreteInterpolant } from './025_DiscreteInterpolant.js';
export { default as QuaternionLinearInterpolant } from './026_QuaternionLinearInterpolant.js';
export { default as Box2 } from './027_Box2.js';
export { default as BezierInterpolant } from './028_BezierInterpolant.js';
export { default as OBB } from './029_OBB.js';

/* ==========================================================================
 * SECTION 3 — BITECS COMPONENTS (SoA declarations)
 * --------------------------------------------------------------------------
 * One per file that defines a component. All names are unique (`XxxComponent`).
 * ========================================================================== */

export { Vector2Component } from './002_Vector2.js';
export { Vector3Component } from './003_Vector3.js';
export { QuaternionComponent } from './004_Quaternion.js';
export { Matrix2Component } from './005_Matrix2.js';
export { Matrix3Component } from './006_Matrix3.js';
export { Matrix4Component } from './007_Matrix4.js';
export { EulerComponent } from './008_Euler.js';
export { Line3Component } from './009_Line3.js';
export { PlaneComponent } from './010_Plane.js';
export { SphereComponent } from './011_Sphere.js';
export { Box3Component } from './012_Box3.js';
export { RayComponent } from './013_Ray.js';
export { TriangleComponent } from './014_Triangle.js';
export { FrustumComponent } from './015_Frustum.js';
export { Vector4Component } from './016_Vector4.js';
export { ColorComponent } from './017_ColorManagement.js';
export { CylindricalComponent } from './019_Cylindrical.js';
export { SphericalComponent } from './020_Spherical.js';
export { SphericalHarmonics3Component } from './021_SphericalHarmonics3.js';
export { InterpolantTrackComponent } from './022_Interpolant.js';
export { QuaternionTrackComponent } from './026_QuaternionLinearInterpolant.js';
export { Box2Component } from './027_Box2.js';
export { BezierTrackComponent } from './028_BezierInterpolant.js';
export { OBBComponent } from './029_OBB.js';
export { ColorSpaceComponent } from './030_ColorSpace.js';

/* ==========================================================================
 * SECTION 4 — SHARED POOLS (single instance each — no collision)
 * ========================================================================== */

export { InterpolantPools } from './022_Interpolant.js';
export { BezierPools } from './028_BezierInterpolant.js';

/* ==========================================================================
 * SECTION 5 — UNIVERSAL CONSTANTS
 * ========================================================================== */

// Scalar trigonometry constants (file 001)
export { DEG2RAD, RAD2DEG } from './001_MathUtils.js';

// Color-space string constants (file 030)
export {
  NoColorSpace,
  SRGBColorSpace,
  LinearSRGBColorSpace,
  DisplayP3ColorSpace,
  LinearDisplayP3ColorSpace,
  Rec709ColorSpace,
  Rec2020ColorSpace,
  LinearRec2020ColorSpace
} from './030_ColorSpace.js';

// Color-space integer codes and converters (file 030)
export {
  ColorSpaceCode,
  colorSpaceToCode,
  colorSpaceFromCode
} from './030_ColorSpace.js';

// Multi-scale unit tables — canonical source is file 019. Files 020 and 029
// redefine the same values; their copies are reachable via
// `SphericalModule.SCALE_UNITS` and `OBBModule.SCALE_UNITS`.
export { SCALE_UNITS, PLANET_RADIUS } from './019_Cylindrical.js';

/* ==========================================================================
 * SECTION 6 — THEME CONSTANTS & HUE/BRIGHTNESS HELPERS (file 017)
 * --------------------------------------------------------------------------
 * All names in this section are unique (no other file exports any of them).
 * ========================================================================== */

export {
  SRGBToLinear,
  LinearToSRGB,
  rgbToHue,
  rgbToHsvInto,
  setHue,
  hueShift,
  complementaryInto,
  analogousInto,
  triadicInto,
  tetradicInto,
  jitterHue,
  jitterSaturation,
  jitterLightness,
  generateVariations,
  generateGradientStops,
  relativeLuminance,
  perceivedBrightness,
  isLight,
  isDark,
  brightnessAdjust,
  brightnessGamma,
  autoContrastInto,
  SKY_THEME,
  OCEAN_THEME,
  CANYON_THEME,
  FOREST_THEME,
  SPACE_THEME,
  MEADOW_THEME,
  COTTAGE_THEME,
  NATURE_THEMES,
  getNatureTheme,
  nearestNatureTheme,
  themeTintInto
} from './017_ColorManagement.js';

/* ==========================================================================
 * SECTION 7 — CSS COLOR NAMES (file 018)
 * ========================================================================== */

export { COLOR_NAMES } from './018_Color.js';

/* ==========================================================================
 * SECTION 8 — SCALAR MATH HELPERS (file 001) — unique names only
 * ========================================================================== */

export {
  generateUUID,
  clamp,
  euclideanModulo,
  mapLinear,
  inverseLerp,
  lerp,
  damp,
  pingpong,
  smoothstep,
  smootherstep,
  randInt,
  randFloat,
  randFloatSpread,
  seededRandom,
  degToRad,
  radToDeg,
  isPowerOfTwo,
  ceilPowerOfTwo,
  floorPowerOfTwo,
  setQuaternionFromProperEuler,
  normalize,
  denormalize,
  preciseAdd,
  preciseSub,
  preciseMul,
  preciseDiv,
  preciseLerp,
  preciseInverseLerp,
  createNoise2DSeeded,
  createNoise3DSeeded,
  createNoise4DSeeded,
  noise2D,
  noise3D,
  noise4D,
  disposeNoiseCache
} from './001_MathUtils.js';

/* ==========================================================================
 * SECTION 9 — GENERIC PER-TYPE BRIDGES
 * --------------------------------------------------------------------------
 * These are the canonical `threeXxxFromBitecs` / `bitecsXxxFromThree` /
 * `threeXxxFromGlMatrix` / `glMatrixXxxFromBitecs` helpers. Their names are
 * prefixed by the type they target (`Xxx`), so they are unique across files.
 * ========================================================================== */

// Vector2 (file 002)
export {
  threeVec2FromGlMatrix,
  glMatrixVec2FromThree,
  bitecsVec2FromGlMatrix,
  glMatrixVec2FromBitecs,
  threeVec2FromBitecs,
  bitecsVec2FromThree,
  threeVec2FromBitecsAdd,
  bitecsVec2AddInto,
  glMatrixVec2LerpFromBitecs
} from './002_Vector2.js';

// Vector3 (file 003)
export {
  threeVec3FromGlMatrix,
  glMatrixVec3FromThree,
  bitecsVec3FromGlMatrix,
  glMatrixVec3FromBitecs,
  threeVec3FromBitecs,
  bitecsVec3FromThree,
  threeVec3FromBitecsAdd,
  threeVec3FromBitecsSub,
  bitecsVec3AddInto,
  bitecsVec3SubInto,
  bitecsVec3ScaleInPlace,
  bitecsVec3NormalizeInPlace,
  bitecsVec3Dot,
  bitecsVec3CrossInto,
  bitecsVec3DistanceToSquared,
  bitecsVec3DistanceTo,
  threeVec3FromBitecsLerp,
  bitecsVec3LerpInto,
  glMatrixVec3AddFromBitecs,
  glMatrixVec3CrossFromBitecs,
  glMatrixVec3NormalizeFromBitecs
} from './003_Vector3.js';

// Quaternion (file 004)
export {
  threeQuatFromGlMatrix,
  glMatrixQuatFromThree,
  bitecsQuatFromGlMatrix,
  glMatrixQuatFromBitecs,
  threeQuatFromBitecs,
  bitecsQuatFromThree,
  threeQuatFromBitecsMultiply,
  bitecsQuatMultiplyInto,
  bitecsQuatNormalizeInPlace,
  bitecsQuatConjugateInPlace,
  bitecsQuatInvertInPlace,
  bitecsQuatDot,
  threeQuatFromBitecsSlerp,
  bitecsQuatSlerpInto,
  glMatrixQuatSlerpFromBitecs,
  bitecsQuatFromGlMatrixAxisAngle,
  bitecsQuatFromGlMatrixEuler,
  threeVec3FromBitecsQuatRotate,
  bitecsVec3QuatRotateInto
} from './004_Quaternion.js';

// Matrix2 (file 005)
export {
  threeMat2FromGlMatrix,
  glMatrixMat2FromThree,
  bitecsMat2FromGlMatrix,
  glMatrixMat2FromBitecs,
  threeMat2FromBitecs,
  bitecsMat2FromThree,
  threeMat2FromBitecsMultiply,
  bitecsMat2MultiplyInto,
  threeMat2FromBitecsAdd,
  bitecsMat2AddInto,
  threeMat2FromBitecsSub,
  bitecsMat2SubInto,
  bitecsMat2ScaleInPlace,
  bitecsMat2TransposeInPlace,
  bitecsMat2InvertInPlace,
  bitecsMat2Determinant,
  glMatrixMat2MultiplyFromBitecs,
  glMatrixMat2InvertFromBitecs,
  glMatrixMat2AdjointFromBitecs,
  glMatrixMat2DeterminantFromBitecs
} from './005_Matrix2.js';

// Matrix3 (file 006)
export {
  threeMat3FromGlMatrix,
  glMatrixMat3FromThree,
  bitecsMat3FromGlMatrix,
  glMatrixMat3FromBitecs,
  threeMat3FromBitecs,
  bitecsMat3FromThree,
  threeMat3FromBitecsMultiply,
  bitecsMat3MultiplyInto,
  threeMat3FromBitecsAdd,
  bitecsMat3AddInto,
  threeMat3FromBitecsSub,
  bitecsMat3SubInto,
  bitecsMat3ScaleInPlace,
  bitecsMat3TransposeInPlace,
  bitecsMat3InvertInPlace,
  bitecsMat3Determinant,
  glMatrixMat3MultiplyFromBitecs,
  glMatrixMat3InvertFromBitecs,
  glMatrixMat3TransposeFromBitecs,
  glMatrixMat3AdjointFromBitecs,
  glMatrixMat3DeterminantFromBitecs,
  glMatrixMat3FromBitecsQuat,
  glMatrixMat3NormalFromBitecsMat4
} from './006_Matrix3.js';

// Matrix4 (file 007)
export {
  threeMat4FromGlMatrix,
  glMatrixMat4FromThree,
  bitecsMat4FromGlMatrix,
  glMatrixMat4FromBitecs,
  threeMat4FromBitecs,
  bitecsMat4FromThree,
  threeMat4FromBitecsMultiply,
  bitecsMat4MultiplyInto,
  bitecsMat4InvertInPlace,
  bitecsMat4TransposeInPlace,
  bitecsMat4Determinant,
  bitecsMat4DeterminantAffine,
  bitecsMat4ScaleInPlace,
  bitecsMat4DecomposeInto,
  bitecsMat4ComposeFrom,
  glMatrixMat4MultiplyFromBitecs,
  glMatrixMat4InvertFromBitecs,
  glMatrixMat4TransposeFromBitecs,
  glMatrixMat4DeterminantFromBitecs,
  glMatrixMat4FromBitecsQuat,
  glMatrixMat4FromBitecsRotTrans,
  glMatrixMat4Frustum,
  glMatrixMat4Perspective,
  glMatrixMat4Ortho,
  glMatrixMat4LookAtFromBitecs
} from './007_Matrix4.js';

// Euler (file 008)
export {
  threeEulerFromGlMatrix,
  glMatrixEulerFromThree,
  bitecsEulerFromGlMatrix,
  glMatrixEulerFromBitecs,
  threeEulerFromBitecs,
  bitecsEulerFromThree,
  threeEulerFromBitecsAdd,
  bitecsEulerAddInto,
  threeEulerFromBitecsSub,
  bitecsEulerSubInto,
  bitecsEulerScaleInPlace,
  threeEulerFromBitecsLerp,
  bitecsEulerLerpInto,
  bitecsEulerDot,
  bitecsEulerFromGlMatrixQuat,
  glMatrixQuatFromBitecsEuler,
  threeQuatFromBitecsEuler
} from './008_Euler.js';

// Line3 (file 009)
export {
  threeLine3FromGlMatrix,
  threeLine3FromGlMatrixPacked,
  glMatrixLine3FromThree,
  glMatrixLine3PackedFromThree,
  bitecsLine3FromGlMatrix,
  bitecsLine3FromGlMatrixPacked,
  glMatrixLine3FromBitecs,
  glMatrixLine3PackedFromBitecs,
  threeLine3FromBitecs,
  bitecsLine3FromThree,
  threeLine3FromBitecsAdd,
  bitecsLine3AddInto,
  threeLine3FromBitecsSub,
  bitecsLine3SubInto,
  bitecsLine3ScaleInPlace,
  threeLine3FromBitecsLerp,
  bitecsLine3LerpInto,
  threeVec3FromBitecsLine3Delta,
  bitecsVec3DeltaFromLine3Into,
  bitecsLine3LengthSq,
  bitecsLine3Length,
  threeVec3FromBitecsLine3At,
  bitecsVec3Line3AtInto,
  bitecsLine3ClosestPointToPointT,
  threeVec3FromBitecsLine3ClosestPoint,
  glMatrixVec3ClosestPointOnLineFromBitecs,
  glMatrixVec3LerpFromBitecsLines
} from './009_Line3.js';

// Plane (file 010)
export {
  threePlaneFromGlMatrix,
  threePlaneFromGlMatrixPacked,
  glMatrixPlaneFromThree,
  glMatrixPlanePackedFromThree,
  bitecsPlaneFromGlMatrix,
  bitecsPlaneFromGlMatrixPacked,
  glMatrixPlaneFromBitecs,
  glMatrixPlanePackedFromBitecs,
  threePlaneFromBitecs,
  bitecsPlaneFromThree,
  threePlaneFromBitecsAdd,
  bitecsPlaneAddInto,
  threePlaneFromBitecsSub,
  bitecsPlaneSubInto,
  bitecsPlaneScaleInPlace,
  bitecsPlaneNegateInPlace,
  bitecsPlaneNormalizeInPlace,
  bitecsPlaneDistanceToPoint,
  bitecsPlaneDistanceToSphere,
  threeVec3FromBitecsPlaneProjectPoint,
  bitecsVec3PlaneProjectPointInto,
  glMatrixPlanePackedFromBitecsNormalize,
  glMatrixVec3NormalizeFromBitecsPlane,
  glMatrixVec4FromBitecsPlane,
  threeVec3FromBitecsPlaneLine3Intersect,
  bitecsPlaneApplyMatrix4InPlace,
  glMatrixPlanePackedFromBitecsFrustum
} from './010_Plane.js';

// Sphere (file 011)
export {
  threeSphereFromGlMatrix,
  threeSphereFromGlMatrixPacked,
  glMatrixSphereFromThree,
  glMatrixSpherePackedFromThree,
  bitecsSphereFromGlMatrix,
  bitecsSphereFromGlMatrixPacked,
  glMatrixSphereFromBitecs,
  glMatrixSpherePackedFromBitecs,
  threeSphereFromBitecs,
  bitecsSphereFromThree,
  threeSphereFromBitecsUnion,
  bitecsSphereUnionInto,
  bitecsSphereContainsPoint,
  bitecsSphereDistanceToPoint,
  bitecsSphereIntersectsSphere,
  bitecsSphereIntersectsPlane,
  threeVec3FromBitecsSphereClampPoint,
  bitecsVec3SphereClampPointInto,
  threeBox3FromBitecsSphereBoundingBox,
  bitecsSphereApplyMatrix4InPlace,
  bitecsSphereTranslateInPlace,
  bitecsSphereScaleInPlace,
  glMatrixVec3DistanceToBitecsSphere,
  glMatrixVec4FromBitecsSphere,
  glMatrixVec3DistanceBetweenBitecsSpheres,
  glMatrixRayIntersectBitecsSphere
} from './011_Sphere.js';

// Box3 (file 012)
export {
  threeBox3FromGlMatrix,
  threeBox3FromGlMatrixPacked,
  glMatrixBox3FromThree,
  glMatrixBox3PackedFromThree,
  bitecsBox3FromGlMatrix,
  bitecsBox3FromGlMatrixPacked,
  glMatrixBox3FromBitecs,
  glMatrixBox3PackedFromBitecs,
  threeBox3FromBitecs,
  bitecsBox3FromThree,
  threeBox3FromBitecsUnion,
  bitecsBox3UnionInto,
  threeBox3FromBitecsIntersect,
  bitecsBox3IntersectInto,
  bitecsBox3ExpandByPointInPlace,
  bitecsBox3ExpandByVectorInPlace,
  bitecsBox3ExpandByScalarInPlace,
  bitecsBox3ContainsPoint,
  bitecsBox3ContainsBox,
  bitecsBox3IntersectsBox,
  bitecsBox3IntersectsSphere,
  threeVec3FromBitecsBox3ClampPoint,
  bitecsVec3Box3ClampPointInto,
  bitecsBox3DistanceToPoint,
  threeVec3FromBitecsBox3Center,
  bitecsVec3Box3CenterInto,
  threeSphereFromBitecsBox3BoundingSphere,
  bitecsBox3ApplyMatrix4InPlace,
  bitecsBox3TranslateInPlace,
  glMatrixVec3MinMaxFromBitecs,
  glMatrixRayIntersectBitecsBox3
} from './012_Box3.js';

// Ray (file 013)
export {
  threeRayFromGlMatrix,
  threeRayFromGlMatrixPacked,
  glMatrixRayFromThree,
  glMatrixRayPackedFromThree,
  bitecsRayFromGlMatrix,
  bitecsRayFromGlMatrixPacked,
  glMatrixRayFromBitecs,
  glMatrixRayPackedFromBitecs,
  threeRayFromBitecs,
  bitecsRayFromThree,
  threeRayFromBitecsAdd,
  bitecsRayAddInto,
  threeRayFromBitecsSub,
  bitecsRaySubInto,
  bitecsRayScaleInPlace,
  threeRayFromBitecsLerp,
  bitecsRayLerpInto,
  bitecsRayNormalizeInPlace,
  glMatrixVec3DirectionFromBitecsRay,
  glMatrixVec3OriginFromBitecsRay,
  glMatrixVec3LerpDirectionsFromBitecsRays,
  threeVec3FromBitecsRayAt,
  bitecsVec3RayAtInto,
  threeVec3FromBitecsRayClosestPoint,
  bitecsVec3RayClosestPointInto,
  bitecsRayDistanceSqToPoint,
  bitecsRayDistanceToPoint,
  threeVec3FromBitecsRayIntersectSphere,
  bitecsVec3RayIntersectSphereInto,
  bitecsRayIntersectsSphere,
  bitecsRayDistanceToPlane,
  threeVec3FromBitecsRayIntersectPlane,
  bitecsRayIntersectsPlane,
  threeVec3FromBitecsRayIntersectBox,
  bitecsRayIntersectsBox,
  threeVec3FromBitecsRayIntersectTriangle,
  bitecsRayApplyMatrix4InPlace,
  glMatrixRayIntersectBitecsSphere,
  glMatrixRayIntersectBitecsPlane,
  glMatrixRayIntersectBitecsBox,
  glMatrixRayIntersectBitecsTriangle
} from './013_Ray.js';

// Triangle (file 014)
export {
  threeTriangleFromGlMatrix,
  threeTriangleFromGlMatrixPacked,
  glMatrixTriangleFromThree,
  glMatrixTrianglePackedFromThree,
  bitecsTriangleFromGlMatrix,
  bitecsTriangleFromGlMatrixPacked,
  glMatrixTriangleFromBitecs,
  glMatrixTrianglePackedFromBitecs,
  threeTriangleFromBitecs,
  bitecsTriangleFromThree,
  threeTriangleFromBitecsAdd,
  bitecsTriangleAddInto,
  threeTriangleFromBitecsSub,
  bitecsTriangleSubInto,
  bitecsTriangleScaleInPlace,
  threeTriangleFromBitecsLerp,
  bitecsTriangleLerpInto,
  threeVec3FromBitecsTriangleNormal,
  bitecsVec3TriangleNormalInto,
  glMatrixVec3NormalFromBitecsTriangle,
  glMatrixVec3CentroidFromBitecsTriangle,
  threePlaneFromBitecsTriangle,
  threeVec3FromBitecsTriangleBarycoord,
  bitecsVec3TriangleBarycoordInto,
  threeVec3FromBitecsTriangleInterpolation,
  bitecsVec3TriangleInterpolationInto,
  bitecsTriangleContainsPoint,
  threeVec3FromBitecsTriangleMidpoint,
  bitecsVec3TriangleMidpointInto,
  bitecsTriangleArea,
  bitecsTriangleIntersectsBox,
  bitecsTriangleIntersectsSphere,
  threeVec3FromBitecsTriangleClosestPoint,
  bitecsVec3TriangleClosestPointInto,
  bitecsTriangleApplyMatrix4InPlace,
  bitecsTriangleTranslateInPlace,
  bitecsTriangleIsFrontFacing,
  glMatrixRayIntersectBitecsTriangle
} from './014_Triangle.js';

// Frustum (file 015)
export {
  threeFrustumFromGlMatrixPacked,
  glMatrixFrustumPackedFromThree,
  bitecsFrustumFromGlMatrixPacked,
  glMatrixFrustumPackedFromBitecs,
  threeFrustumFromBitecs,
  bitecsFrustumFromThree,
  bitecsFrustumSetFromProjectionMatrixInPlace,
  bitecsFrustumContainsPoint,
  bitecsFrustumIntersectsSphere,
  bitecsFrustumIntersectsBox,
  bitecsFrustumIntersectsObject,
  bitecsFrustumIntersectsSprite,
  bitecsFrustumCopyInto,
  bitecsFrustumFromBitecsMat4Projection,
  glMatrixFrustumPackedFromBitecsRaw,
  glMatrixVec3PlaneNormalFromBitecsFrustum
} from './015_Frustum.js';

// Vector4 (file 016)
export {
  threeVec4FromGlMatrix,
  glMatrixVec4FromThree,
  bitecsVec4FromGlMatrix,
  glMatrixVec4FromBitecs,
  threeVec4FromBitecs,
  bitecsVec4FromThree,
  threeVec4FromBitecsAdd,
  bitecsVec4AddInto,
  threeVec4FromBitecsSub,
  bitecsVec4SubInto,
  bitecsVec4ScaleInPlace,
  bitecsVec4NormalizeInPlace,
  bitecsVec4NegateInPlace,
  bitecsVec4FloorInPlace,
  bitecsVec4CeilInPlace,
  bitecsVec4RoundInPlace,
  bitecsVec4RoundToZeroInPlace,
  bitecsVec4Dot,
  bitecsVec4LengthSq,
  bitecsVec4Length,
  bitecsVec4ManhattanLength,
  threeVec4FromBitecsLerp,
  bitecsVec4LerpInto,
  threeVec4FromBitecsLerpVectors,
  bitecsVec4LerpVectorsInto,
  threeVec4FromBitecsMin,
  bitecsVec4MinInto,
  threeVec4FromBitecsMax,
  bitecsVec4MaxInto,
  bitecsVec4ClampInPlace,
  bitecsVec4ClampScalarInPlace,
  bitecsVec4ClampLengthInPlace,
  bitecsVec4DistanceToSquared,
  bitecsVec4DistanceTo,
  bitecsVec4ManhattanDistanceTo,
  bitecsVec4SetLengthInPlace,
  bitecsVec4SetScalarInPlace,
  bitecsVec4SetComponentInPlace,
  bitecsVec4GetComponent,
  threeVec4FromBitecsApplyMatrix4,
  bitecsVec4ApplyMatrix4Into,
  glMatrixVec4FromBitecsApplyMatrix4,
  glMatrixVec4DotFromBitecs,
  glMatrixVec4NormalizeFromBitecs,
  glMatrixVec4LerpFromBitecs,
  glMatrixVec4AddFromBitecs
} from './016_Vector4.js';

// Cylindrical (file 019)
export {
  threeCylindricalFromGlMatrix,
  threeCylindricalFromGlMatrixPacked,
  glMatrixCylindricalFromThree,
  glMatrixCylindricalPackedFromThree,
  bitecsCylindricalFromGlMatrix,
  bitecsCylindricalFromGlMatrixPacked,
  glMatrixCylindricalFromBitecs,
  glMatrixCylindricalPackedFromBitecs,
  threeCylindricalFromBitecs,
  bitecsCylindricalFromThree,
  threeCylindricalFromBitecsAdd,
  bitecsCylindricalAddInto,
  threeCylindricalFromBitecsSub,
  bitecsCylindricalSubInto,
  bitecsCylindricalScaleInPlace,
  threeCylindricalFromBitecsLerp,
  bitecsCylindricalLerpInto,
  threeVec3FromBitecsCylindrical,
  bitecsVec3FromCylindricalInto,
  bitecsCylindricalFromVec3Into,
  threeVec3FromBitecsCylindricalScaled,
  bitecsCylindricalFromVec3ScaledInto,
  bitecsCylindricalFromGlMatrixVec3,
  glMatrixVec3FromBitecsCylindrical,
  glMatrixVec3LerpFromBitecsCylindrical,
  glMatrixVec3NormalizedFromBitecsCylindrical,
  scaleToMeters,
  scaleFromMeters,
  toLightYears,
  fromLightYears,
  toAstronomicalUnits,
  fromAstronomicalUnits,
  toSolarRadii,
  fromSolarRadii,
  toGalacticRadii,
  fromGalacticRadii,
  getPlanetRadiusMeters,
  realTimeDistanceScale
} from './019_Cylindrical.js';

// Spherical (file 020)
export {
  threeSphericalFromGlMatrix,
  threeSphericalFromGlMatrixPacked,
  glMatrixSphericalFromThree,
  glMatrixSphericalPackedFromThree,
  bitecsSphericalFromGlMatrix,
  bitecsSphericalFromGlMatrixPacked,
  glMatrixSphericalFromBitecs,
  glMatrixSphericalPackedFromBitecs,
  threeSphericalFromBitecs,
  bitecsSphericalFromThree,
  threeSphericalFromBitecsAdd,
  bitecsSphericalAddInto,
  threeSphericalFromBitecsSub,
  bitecsSphericalSubInto,
  bitecsSphericalScaleInPlace,
  threeSphericalFromBitecsLerp,
  bitecsSphericalLerpInto,
  threeVec3FromBitecsSpherical,
  bitecsVec3FromSphericalInto,
  bitecsSphericalFromVec3Into,
  threeVec3FromBitecsSphericalScaled,
  bitecsSphericalFromVec3ScaledInto,
  bitecsSphericalFromGlMatrixVec3,
  glMatrixVec3FromBitecsSpherical,
  glMatrixVec3LerpFromBitecsSpherical,
  glMatrixVec3NormalizedFromBitecsSpherical,
  bitecsSphericalMakeSafeInPlace,
  bitecsSphericalClampRadiusInPlace,
  bitecsSphericalWrapThetaInPlace,
  bitecsSphericalDeltaTheta,
  glMatrixSphericalFromBitecsScaled
} from './020_Spherical.js';

// SphericalHarmonics3 (file 021)
export {
  threeSH3FromGlMatrix,
  threeSH3FromGlMatrixPacked,
  glMatrixSH3FromThree,
  glMatrixSH3PackedFromThree,
  bitecsSH3FromGlMatrix,
  bitecsSH3FromGlMatrixPacked,
  glMatrixSH3FromBitecs,
  glMatrixSH3PackedFromBitecs,
  threeSH3FromBitecs,
  bitecsSH3FromThree,
  bitecsSH3ZeroInPlace,
  threeSH3FromBitecsAdd,
  bitecsSH3AddInto,
  bitecsSH3AddScaledInto,
  bitecsSH3ScaleInPlace,
  threeSH3FromBitecsLerp,
  bitecsSH3LerpInto,
  bitecsSH3IsEmpty,
  threeVec3FromBitecsSH3GetAt,
  threeVec3FromBitecsSH3GetAtXYZ,
  glMatrixVec3SH3GetAtFromBitecs,
  bitecsSH3CopyInto,
  threeSH3AnimeFromTheme,
  threeSH3AnimeNearestFromColor,
  bitecsSH3AnimeFromTheme,
  bitecsSH3AnimeNearestFromBitecsColor,
  threeSH3AnimeLerp,
  threeSH3AnimeAddHueVariant
} from './021_SphericalHarmonics3.js';

// Box2 (file 027)
export {
  threeBox2FromGlMatrix,
  threeBox2FromGlMatrixPacked,
  glMatrixBox2FromThree,
  glMatrixBox2PackedFromThree,
  bitecsBox2FromGlMatrix,
  bitecsBox2FromGlMatrixPacked,
  glMatrixBox2FromBitecs,
  glMatrixBox2PackedFromBitecs,
  threeBox2FromBitecs,
  bitecsBox2FromThree,
  threeBox2FromBitecsUnion,
  bitecsBox2UnionInto,
  threeBox2FromBitecsIntersect,
  bitecsBox2IntersectInto,
  bitecsBox2ExpandByPointInPlace,
  bitecsBox2ExpandByVectorInPlace,
  bitecsBox2ExpandByScalarInPlace,
  bitecsBox2ContainsPoint,
  bitecsBox2ContainsBox,
  bitecsBox2IntersectsBox,
  threeVec2FromBitecsBox2ClampPoint,
  bitecsVec2Box2ClampPointInto,
  bitecsBox2DistanceToPoint,
  threeVec2FromBitecsBox2Center,
  bitecsVec2Box2CenterInto,
  threeVec2FromBitecsBox2Size,
  bitecsVec2Box2SizeInto,
  threeVec2FromBitecsBox2Parameter,
  bitecsVec2Box2ParameterInto,
  bitecsBox2TranslateInPlace,
  bitecsBox2IsEmpty,
  bitecsBox2MakeEmptyInPlace,
  glMatrixVec2DistanceToBitecsBox2,
  glMatrixVec2InsideBitecsBox2,
  glMatrixBox2PackedUnionFromBitecs,
  glMatrixBox2PackedIntersectFromBitecs,
  glMatrixVec2MinFromBitecsBox2,
  glMatrixVec2MaxFromBitecsBox2,
  glMatrixVec2LerpFromBitecsBox2
} from './027_Box2.js';

/* ==========================================================================
 * SECTION 10 — INTERPOLANT BRIDGES (files 022–028)
 * --------------------------------------------------------------------------
 * Every interpolant-specific bridge is prefixed by its interpolant type, so
 * the names are unique across the 7 interpolant files.
 * ========================================================================== */

// Base Interpolant (file 022)
export {
  bitecsInterpolantBindFromTrack,
  threeVec3FromBitecsInterpolantEvaluate,
  threeVec4FromBitecsInterpolantEvaluate,
  glMatrixVec3FromBitecsInterpolantEvaluate,
  glMatrixVec4FromBitecsInterpolantEvaluate,
  bitecsVec3FromBitecsInterpolantEvaluate,
  bitecsVec4FromBitecsInterpolantEvaluate,
  bitecsInterpolantResultIntoPool,
  threeVec3FromBitecsInterpolantSample,
  threeVec4FromBitecsInterpolantSample,
  glMatrixVec3FromBitecsInterpolantSample,
  glMatrixVec4FromBitecsInterpolantSample,
  bitecsInterpolantSampleFromVec3,
  bitecsInterpolantSampleFromVec4,
  bitecsInterpolantPositionSet,
  bitecsInterpolantPositionGet,
  bitecsInterpolantSampleSlotFromT,
  fillNoiseTrack
} from './022_Interpolant.js';

// CubicInterpolant (file 023)
export {
  bitecsCubicInterpolantBindFromTrack,
  threeVec3FromBitecsCubicInterpolantEvaluate,
  threeVec4FromBitecsCubicInterpolantEvaluate,
  glMatrixVec3FromBitecsCubicInterpolantEvaluate,
  glMatrixVec4FromBitecsCubicInterpolantEvaluate,
  bitecsVec3FromBitecsCubicInterpolantEvaluate,
  bitecsVec4FromBitecsCubicInterpolantEvaluate,
  bitecsCubicInterpolantResultIntoPool,
  threeVec3FromBitecsCubicInterpolantSample,
  threeVec4FromBitecsCubicInterpolantSample,
  glMatrixVec3FromBitecsCubicInterpolantSample,
  glMatrixVec4FromBitecsCubicInterpolantSample,
  bitecsCubicInterpolantSampleFromVec3,
  bitecsCubicInterpolantSampleFromVec4,
  bitecsCubicInterpolantPositionSet,
  bitecsCubicInterpolantPositionGet,
  bitecsCubicInterpolantSampleSlotFromT,
  bitecsCubicInterpolantFillPositionsFromVec3s,
  bitecsCubicInterpolantFillPositionsFromVec4s,
  bitecsCubicInterpolantFillFromNoise,
  preciseCubicWeights
} from './023_CubicInterpolant.js';

// LinearInterpolant (file 024)
export {
  bitecsLinearInterpolantBindFromTrack,
  threeVec3FromBitecsLinearInterpolantEvaluate,
  threeVec4FromBitecsLinearInterpolantEvaluate,
  glMatrixVec3FromBitecsLinearInterpolantEvaluate,
  glMatrixVec4FromBitecsLinearInterpolantEvaluate,
  bitecsVec3FromBitecsLinearInterpolantEvaluate,
  bitecsVec4FromBitecsLinearInterpolantEvaluate,
  bitecsLinearInterpolantResultIntoPool,
  threeVec3FromBitecsLinearInterpolantSample,
  threeVec4FromBitecsLinearInterpolantSample,
  glMatrixVec3FromBitecsLinearInterpolantSample,
  glMatrixVec4FromBitecsLinearInterpolantSample,
  bitecsLinearInterpolantSampleFromVec3,
  bitecsLinearInterpolantSampleFromVec4,
  bitecsLinearInterpolantPositionSet,
  bitecsLinearInterpolantPositionGet,
  bitecsLinearInterpolantSampleSlotFromT,
  bitecsLinearInterpolantFillPositionsFromVec3s,
  bitecsLinearInterpolantFillPositionsFromVec4s,
  bitecsLinearInterpolantFillFromNoise,
  preciseLinearInterpolateBuffer,
  threeVec3FromBitecsLinearInterpolantEvaluatePrecise
} from './024_LinearInterpolant.js';

// DiscreteInterpolant (file 025)
export {
  bitecsDiscreteInterpolantBindFromTrack,
  threeVec3FromBitecsDiscreteInterpolantEvaluate,
  threeVec4FromBitecsDiscreteInterpolantEvaluate,
  glMatrixVec3FromBitecsDiscreteInterpolantEvaluate,
  glMatrixVec4FromBitecsDiscreteInterpolantEvaluate,
  bitecsVec3FromBitecsDiscreteInterpolantEvaluate,
  bitecsVec4FromBitecsDiscreteInterpolantEvaluate,
  bitecsDiscreteInterpolantResultIntoPool,
  threeVec3FromBitecsDiscreteInterpolantSample,
  threeVec4FromBitecsDiscreteInterpolantSample,
  glMatrixVec3FromBitecsDiscreteInterpolantSample,
  glMatrixVec4FromBitecsDiscreteInterpolantSample,
  bitecsDiscreteInterpolantSampleFromVec3,
  bitecsDiscreteInterpolantSampleFromVec4,
  bitecsDiscreteInterpolantPositionSet,
  bitecsDiscreteInterpolantPositionGet,
  bitecsDiscreteInterpolantSampleSlotFromT,
  bitecsDiscreteInterpolantFillPositionsFromVec3s,
  bitecsDiscreteInterpolantFillPositionsFromVec4s,
  bitecsDiscreteInterpolantFillFromNoise,
  preciseDiscreteIndex,
  preciseDiscreteEvaluateInPlace,
  preciseDiscreteResidual,
  threeVec3FromBitecsDiscreteInterpolantEvaluatePrecise
} from './025_DiscreteInterpolant.js';

// QuaternionLinearInterpolant (file 026)
export {
  bitecsQuaternionLinearInterpolantBindFromTrack,
  threeVec4FromBitecsQuaternionLinearInterpolantEvaluate,
  glMatrixVec4FromBitecsQuaternionLinearInterpolantEvaluate,
  bitecsVec4FromBitecsQuaternionLinearInterpolantEvaluate,
  bitecsQuaternionLinearInterpolantResultIntoPool,
  threeVec4FromBitecsQuaternionLinearInterpolantSample,
  glMatrixVec4FromBitecsQuaternionLinearInterpolantSample,
  bitecsQuaternionLinearInterpolantSampleFromVec4,
  bitecsQuaternionLinearInterpolantPositionSet,
  bitecsQuaternionLinearInterpolantPositionGet,
  bitecsQuaternionLinearInterpolantSampleSlotFromT,
  bitecsQuaternionLinearInterpolantFillPositionsFromVec4s,
  bitecsQuaternionLinearInterpolantFillFromNoise,
  bitecsQuaternionLinearInterpolantNormalizeTrack,
  preciseSlerpFlat,
  threeVec4FromBitecsQuaternionLinearInterpolantEvaluatePrecise
} from './026_QuaternionLinearInterpolant.js';

// BezierInterpolant (file 028)
export {
  bitecsBezierInterpolantBindFromTrack,
  threeVec3FromBitecsBezierInterpolantEvaluate,
  threeVec4FromBitecsBezierInterpolantEvaluate,
  glMatrixVec3FromBitecsBezierInterpolantEvaluate,
  glMatrixVec4FromBitecsBezierInterpolantEvaluate,
  bitecsVec3FromBitecsBezierInterpolantEvaluate,
  bitecsVec4FromBitecsBezierInterpolantEvaluate,
  bitecsBezierInterpolantResultIntoPool,
  threeVec3FromBitecsBezierInterpolantSample,
  threeVec4FromBitecsBezierInterpolantSample,
  glMatrixVec3FromBitecsBezierInterpolantSample,
  glMatrixVec4FromBitecsBezierInterpolantSample,
  bitecsBezierInterpolantSampleFromVec3,
  bitecsBezierInterpolantSampleFromVec4,
  bitecsBezierInterpolantInTangentSet,
  bitecsBezierInterpolantOutTangentSet,
  bitecsBezierInterpolantInTangentGet,
  bitecsBezierInterpolantOutTangentGet,
  bitecsBezierInterpolantPositionSet,
  bitecsBezierInterpolantPositionGet,
  bitecsBezierInterpolantSampleSlotFromT,
  bitecsBezierInterpolantFillPositionsFromVec3s,
  bitecsBezierInterpolantFillPositionsFromVec4s,
  bitecsBezierInterpolantFillFromNoise,
  preciseBezierInterpolate,
  threeVec3FromBitecsBezierInterpolantEvaluatePrecise
} from './028_BezierInterpolant.js';

/* ==========================================================================
 * SECTION 11 — OBB SAT TESTS & BRIDGES (file 029)
 * --------------------------------------------------------------------------
 * Every OBB-specific helper is prefixed with `bitecsOBB` or `glMatrixOBB`,
 * so the names are unique across the 30 files.
 * ========================================================================== */

export {
  obbFromGlMatrix,
  obbFromGlMatrixPacked,
  glMatrixOBBFromObb,
  glMatrixOBBPackedFromObb,
  bitecsOBBFromGlMatrix,
  bitecsOBBFromGlMatrixPacked,
  glMatrixOBBFromBitecs,
  glMatrixOBBPackedFromBitecs,
  obbFromBitecs,
  bitecsOBBFromObb,
  threeVec3OBBGetAxesFromBitecs,
  glMatrixOBBPackedAxesFromBitecs,
  glMatrixOBBPackedCornersFromBitecs,
  bitecsOBBContainsPoint,
  threeVec3FromBitecsOBBClampPoint,
  bitecsVec3OBBClampPointInto,
  bitecsOBBDistanceToPoint,
  threeVec3FromBitecsOBBCenter,
  bitecsVec3OBBCenterInto,
  threeVec3FromBitecsOBBHalfExtents,
  bitecsVec3OBBHalfExtentsInto,
  threeQuatFromBitecsOBBOrientation,
  bitecsOBBFromAABB,
  threeBox3FromBitecsOBBWorldAABB,
  bitecsBox3FromBitecsOBBWorldAABB,
  bitecsOBBIntersectsAABB,
  bitecsOBBIntersectsOBB,
  bitecsOBBIntersectsSphere,
  bitecsOBBIntersectsPlane,
  bitecsOBBApplyMatrix4InPlace,
  bitecsOBBTranslateInPlace,
  bitecsOBBScaleInPlace,
  glMatrixVec3RotateOBBFromBitecs,
  preciseClampPoint
} from './029_OBB.js';

/* ==========================================================================
 * SECTION 12 — COLOR SOA BRIDGES
 * --------------------------------------------------------------------------
 * Where 017/018/030 share a name, we expose the canonical 017 version at the
 * top level. The 018 and 030 variants remain reachable via
 * `ColorModule.*` and `ColorSpaceModule.*`.
 * ========================================================================== */

// Canonical color bridges from 017 (ColorManagement)
export {
  colorFromGlMatrixVec3,
  glMatrixVec3FromColor,
  colorFromGlMatrixVec4,
  glMatrixVec4FromColor,
  colorFromBitecs,
  bitecsColorFromRgb,
  bitecsColorFromGlMatrixVec3,
  bitecsColorFromGlMatrixVec4,
  glMatrixVec3FromBitecsColor,
  glMatrixVec4FromBitecsColor,
  bitecsColorCopyInto,
  bitecsColorAddInto,
  bitecsColorScaleInPlace,
  bitecsColorLerpInto,
  bitecsColorHueShiftInPlace,
  bitecsColorBrightnessInPlace,
  bitecsColorRelativeLuminance,
  bitecsColorPerceivedBrightness,
  bitecsColorThemeTintInto,
  bitecsColorSRGBToLinearInPlace,
  bitecsColorLinearToSRGBInPlace,
  glMatrixVec3AddFromBitecsColors,
  glMatrixVec3LerpFromBitecsColors
} from './017_ColorManagement.js';

// Color-class-specific bridges from 018 (unique names only)
export {
  threeColorFromGlMatrixVec3,
  threeColorFromGlMatrixVec4,
  glMatrixVec3FromThreeColor,
  glMatrixVec4FromThreeColor,
  bitecsColorFromThreeColor,
  threeColorFromBitecs,
  bitecsColorFromThreeColorSRGB,
  threeColorFromBitecsSRGB,
  bitecsColorSetHexFromSRGB,
  bitecsColorSetHSLFromSRGB,
  bitecsColorAddInPlace,
  bitecsColorMultiplyInto,
  bitecsColorLerpVectorsInto,
  glMatrixVec3FromBitecsColorSRGB,
  glMatrixVec4FromBitecsColorSRGB,
  glMatrixVec3MultiplyFromBitecsColors,
  glMatrixVec4CopyFromBitecsColor,
  preciseFromHexInto
} from './018_Color.js';

// Color-space-specific bridges from 030 (unique-to-030 names)
export {
  glMatrixVec3ConvertColorSpace,
  glMatrixVec4ConvertColorSpace,
  glMatrixVec4SRGBToLinear,
  glMatrixVec4LinearToSRGB,
  glMatrixVec3LerpColors,
  glMatrixVec4FromBitecsColorCopy,
  bitecsColorConvertColorSpaceInPlace,
  bitecsColorFromGlMatrixVec3Linear,
  glMatrixVec3LinearFromBitecsColor,
  glMatrixVec4LinearFromBitecsColor,
  bitecsColorFromGlMatrixVec4Linear,
  bitecsColorConvertColorSpaceInto,
  bitecsColorSRGBToLinearInto,
  bitecsColorLinearToSRGBInto,
  bitecsColorSpaceFromColor,
  bitecsColorSpaceString,
  bitecsColorSpaceConvertInPlace,
  glMatrixVec3NoiseSRGBInto,
  glMatrixVec3NoiseLinearInto,
  bitecsColorNoiseSRGB,
  applyTransfer,
  applyTransferInverse,
  getColorSpacePrimaries,
  getColorSpaceTransfer,
  isLinearColorSpace,
  isSRGBFamilyColorSpace,
  clampedLuminance
} from './030_ColorSpace.js';

/* ==========================================================================
 * SECTION 13 — NOISE CACHE AGGREGATE
 * --------------------------------------------------------------------------
 * One call clears every module's cached simplex-noise generator `Map`.
 * ========================================================================== */

import { disposeNoiseCache as _disposeMathUtilsNoise } from './001_MathUtils.js';
import { disposeNoise2DCache as _disposeVector2Noise } from './002_Vector2.js';
import { disposeNoise3DCache as _disposeVector3Noise } from './003_Vector3.js';
import { disposeNoise3DCache as _disposeQuaternionNoise } from './004_Quaternion.js';
import { disposeNoise2DCache as _disposeMatrix2Noise } from './005_Matrix2.js';
import { disposeNoise2DCache as _disposeMatrix3Noise } from './006_Matrix3.js';
import { disposeNoise4DCache as _disposeMatrix4Noise } from './007_Matrix4.js';
import { disposeNoise3DCache as _disposeEulerNoise } from './008_Euler.js';
import { disposeNoise3DCache as _disposeLine3Noise } from './009_Line3.js';
import { disposeNoise3DCache as _disposePlaneNoise } from './010_Plane.js';
import { disposeNoise3DCache as _disposeSphereNoise } from './011_Sphere.js';
import { disposeNoise3DCache as _disposeBox3Noise } from './012_Box3.js';
import { disposeNoise3DCache as _disposeRayNoise } from './013_Ray.js';
import { disposeNoise3DCache as _disposeTriangleNoise } from './014_Triangle.js';
import { disposeNoise3DCache as _disposeFrustumNoise } from './015_Frustum.js';
import { disposeNoise4DCache as _disposeVector4Noise } from './016_Vector4.js';
import { disposeNoise3DCache as _disposeColorManagementNoise } from './017_ColorManagement.js';
import { disposeNoise3DCache as _disposeColorNoise } from './018_Color.js';
import { disposeNoise3DCache as _disposeCylindricalNoise } from './019_Cylindrical.js';
import { disposeNoise3DCache as _disposeSphericalNoise } from './020_Spherical.js';
import { disposeNoise3DCache as _disposeSH3Noise } from './021_SphericalHarmonics3.js';
import { disposeNoise3DCache as _disposeBox2Noise } from './027_Box2.js';
import { disposeNoise3DCache as _disposeOBBNoise } from './029_OBB.js';
import { disposeNoise3DCache as _disposeColorSpaceNoise } from './030_ColorSpace.js';

// Clears every module's cached simplex-noise generators. Call this when seeds
// are no longer reused so the permutation tables can be garbage-collected.
export function disposeAllNoiseCaches() {
  _disposeMathUtilsNoise();
  _disposeVector2Noise();
  _disposeVector3Noise();
  _disposeQuaternionNoise();
  _disposeMatrix2Noise();
  _disposeMatrix3Noise();
  _disposeMatrix4Noise();
  _disposeEulerNoise();
  _disposeLine3Noise();
  _disposePlaneNoise();
  _disposeSphereNoise();
  _disposeBox3Noise();
  _disposeRayNoise();
  _disposeTriangleNoise();
  _disposeFrustumNoise();
  _disposeVector4Noise();
  _disposeColorManagementNoise();
  _disposeColorNoise();
  _disposeCylindricalNoise();
  _disposeSphericalNoise();
  _disposeSH3Noise();
  _disposeBox2Noise();
  _disposeOBBNoise();
  _disposeColorSpaceNoise();
}

/* ==========================================================================
 * USAGE NOTES
 * --------------------------------------------------------------------------
 * Preferred pattern — reach for unique names at the top level:
 *
 *   import {
 *     Vector3, Quaternion, Color, ColorManagement,
 *     bitecsVec3FromBitecs, glMatrixQuatFromThree,
 *     bitecsOBBIntersectsOBB, disposeAllNoiseCaches
 *   } from './Custom math_Folder_threejs.js';
 *
 * Colliding helper names (`preciseLength`, `preciseDistanceTo`, `preciseDot`,
 * `preciseArea`, `preciseVolume`, `preciseContainsPoint`, `preciseClampPoint`,
 * `preciseRelativeLuminance`, `setFromNoise3D`, `setFromNoise2D`,
 * `setFromNoise4D`, `disposeNoise3DCache`, `disposeNoise2DCache`,
 * `disposeNoise4DCache`, `SCALE_UNITS`, `PLANET_RADIUS`, and the color-space
 * transfer helpers shared between files 017/018/030) are reachable ONLY via
 * their namespaces:
 *
 *   import { Vector3Module, Vector4Module, OBBModule } from './Custom math_Folder_threejs.js';
 *   const l3 = Vector3Module.preciseLength(v3);
 *   const l4 = Vector4Module.preciseLength(v4);
 *   const obbVolume = OBBModule.preciseVolume(obb);
 *
 * This guarantees there are no silent shadowing collisions at the top level
 * and that every export from every one of the 30 files is reachable.
 * ========================================================================== */