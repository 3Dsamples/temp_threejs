// file number : 031
// full path name : src/math/031_index.js
// description : Single entry point for the entire rewritten three.js r185 math module. Re-exports every class, component, shared pool, constant, and named helper from files 001..030 under one import surface. Uses namespace re-exports (`export * as XxxModule`) for modules that export colliding helper names (preciseLength, disposeNoise3DCache, setFromNoise3D, SCALE_UNITS, etc.) so nothing is silently shadowed. Top-level named re-exports are provided for the primary class of each file, all bitecs components, the shared pools, and the universal constants (DEG2RAD/RAD2DEG, ColorSpace strings). Every default export from the individual files is preserved and surfaced.
// best for  :  `import { Vector3, Quaternion, Color, bitecsVec3FromBitecs } from './math/index.js'` — a single import path for the whole math module. Also lets consumers reach the helper namespaces for collision-prone helpers via `import { Vector2Module } from './math/index.js'` and then `Vector2Module.preciseLength(v)`.
// license : MIT

/* -------------------------------------------------------------------------- */
/* Top-level named re-exports — the primary class or object of each file      */
/* -------------------------------------------------------------------------- */

// Scalars & utilities (file 001 has no default export; MathUtils is a named object).
export { MathUtils } from './001_MathUtils.js';

// Geometry / algebra classes (each file's default export is its primary class).
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
export { default as ColorManagement } from './017_ColorManagement.js';
export { default as ColorManagementConstants } from './030_ColorSpace.js';

/* -------------------------------------------------------------------------- */
/* Universal constants                                                        */
/* -------------------------------------------------------------------------- */

export { DEG2RAD, RAD2DEG } from './001_MathUtils.js';

// r185 color-space strings
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

// Color-space integer codes and code/string converters
export {
  ColorSpaceCode,
  colorSpaceToCode,
  colorSpaceFromCode
} from './030_ColorSpace.js';

/* -------------------------------------------------------------------------- */
/* Bitecs components — the SoA declarations that every bridge targets         */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Shared pools — the caller-managed Float32Arrays the interpolant bridges    */
/* read from and write to. There is exactly one of each, so they can be       */
/* top-level exports without collision.                                       */
/* -------------------------------------------------------------------------- */

export { InterpolantPools } from './022_Interpolant.js';
export { BezierPools } from './028_BezierInterpolant.js';

/* -------------------------------------------------------------------------- */
/* Multi-scale unit tables — currently exported from 019, 020, and 029. All   */
/* three are identical in content (METER == 1, LIGHT_YEAR == 9.46e15, ...),   */
/* so we surface a single canonical name and let consumers reach the others   */
/* via their module namespaces if they care about provenance.                 */
/* -------------------------------------------------------------------------- */

export { SCALE_UNITS } from './019_Cylindrical.js';
export { PLANET_RADIUS } from './019_Cylindrical.js';

/* -------------------------------------------------------------------------- */
/* Namespace re-exports — every helper and bridge from every file, under a    */
/* distinct namespace. This is the safe way to expose names that collide      */
/* across files (preciseLength, preciseDistanceTo, preciseDot, preciseArea,   */
/* preciseVolume, preciseContainsPoint, preciseClampPoint,                    */
/* preciseRelativeLuminance, setFromNoise3D, disposeNoise3DCache,             */
/* glMatrixVec3SRGBToLinear, glMatrixVec3LinearToSRGB, ...).                  */
/*                                                                            */
/* Example usage:                                                             */
/*   import { Vector2Module, Vector3Module } from './math/index.js';          */
/*   const len2 = Vector2Module.preciseLength( v2 );                          */
/*   const len3 = Vector3Module.preciseLength( v3 );                          */
/* -------------------------------------------------------------------------- */

export * as MathUtilsModule from './001_MathUtils.js';
export * as Vector2Module from './002_Vector2.js';
export * as Vector3Module from './003_Vector3.js';
export * as QuaternionModule from './004_Quaternion.js';
export * as Matrix2Module from './005_Matrix2.js';
export * as Matrix3Module from './006_Matrix3.js';
export * as Matrix4Module from './007_Matrix4.js';
export * as EulerModule from './008_Euler.js';
export * as Line3Module from './009_Line3.js';
export * as PlaneModule from './010_Plane.js';
export * as SphereModule from './011_Sphere.js';
export * as Box3Module from './012_Box3.js';
export * as RayModule from './013_Ray.js';
export * as TriangleModule from './014_Triangle.js';
export * as FrustumModule from './015_Frustum.js';
export * as Vector4Module from './016_Vector4.js';
export * as ColorManagementModule from './017_ColorManagement.js';
export * as ColorModule from './018_Color.js';
export * as CylindricalModule from './019_Cylindrical.js';
export * as SphericalModule from './020_Spherical.js';
export * as SphericalHarmonics3Module from './021_SphericalHarmonics3.js';
export * as InterpolantModule from './022_Interpolant.js';
export * as CubicInterpolantModule from './023_CubicInterpolant.js';
export * as LinearInterpolantModule from './024_LinearInterpolant.js';
export * as DiscreteInterpolantModule from './025_DiscreteInterpolant.js';
export * as QuaternionLinearInterpolantModule from './026_QuaternionLinearInterpolant.js';
export * as Box2Module from './027_Box2.js';
export * as BezierInterpolantModule from './028_BezierInterpolant.js';
export * as OBBModule from './029_OBB.js';
export * as ColorSpaceModule from './030_ColorSpace.js';

/* -------------------------------------------------------------------------- */
/* Convenience aggregates — the most commonly used bitecs bridges grouped     */
/* under stable names. These are thin aliases that pick a specific module's   */
/* implementation when the same helper name exists in multiple files. For     */
/* example: the `threeVec3FromBitecs` helper is canonical to file 003, and    */
/* we surface it here so `import { threeVec3FromBitecs } from './math'` works */
/* without ambiguity.                                                         */
/* -------------------------------------------------------------------------- */

// Vector2 SoA bridges
export {
  threeVec2FromBitecs,
  bitecsVec2FromThree,
  bitecsVec2FromGlMatrix,
  glMatrixVec2FromBitecs,
  threeVec2FromGlMatrix,
  glMatrixVec2FromThree,
  threeVec2FromBitecsAdd,
  bitecsVec2AddInto,
  glMatrixVec2LerpFromBitecs
} from './002_Vector2.js';

// Vector3 SoA bridges
export {
  threeVec3FromBitecs,
  bitecsVec3FromThree,
  bitecsVec3FromGlMatrix,
  glMatrixVec3FromBitecs,
  threeVec3FromGlMatrix,
  glMatrixVec3FromThree,
  threeVec3FromBitecsAdd,
  threeVec3FromBitecsSub,
  bitecsVec3AddInto,
  bitecsVec3SubInto,
  bitecsVec3ScaleInPlace,
  bitecsVec3NormalizeInPlace,
  bitecsVec3Dot,
  bitecsVec3CrossInto,
  bitecsVec3DistanceTo,
  bitecsVec3DistanceToSquared,
  threeVec3FromBitecsLerp,
  bitecsVec3LerpInto,
  glMatrixVec3AddFromBitecs,
  glMatrixVec3CrossFromBitecs,
  glMatrixVec3NormalizeFromBitecs
} from './003_Vector3.js';

// Quaternion SoA bridges
export {
  threeQuatFromBitecs,
  bitecsQuatFromThree,
  bitecsQuatFromGlMatrix,
  glMatrixQuatFromBitecs,
  threeQuatFromGlMatrix,
  glMatrixQuatFromThree,
  threeQuatFromBitecsMultiply,
  bitecsQuatMultiplyInto,
  bitecsQuatNormalizeInPlace,
  bitecsQuatConjugateInPlace,
  bitecsQuatInvertInPlace,
  bitecsQuatDot,
  threeQuatFromBitecsSlerp,
  bitecsQuatSlerpInto,
  glMatrixQuatSlerpFromBitecs,
  threeVec3FromBitecsQuatRotate,
  bitecsVec3QuatRotateInto
} from './004_Quaternion.js';

// Matrix2 SoA bridges
export {
  threeMat2FromBitecs,
  bitecsMat2FromThree,
  bitecsMat2FromGlMatrix,
  glMatrixMat2FromBitecs,
  threeMat2FromGlMatrix,
  glMatrixMat2FromThree,
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

// Matrix3 SoA bridges
export {
  threeMat3FromBitecs,
  bitecsMat3FromThree,
  bitecsMat3FromGlMatrix,
  glMatrixMat3FromBitecs,
  threeMat3FromGlMatrix,
  glMatrixMat3FromThree,
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

// Matrix4 SoA bridges
export {
  threeMat4FromBitecs,
  bitecsMat4FromThree,
  bitecsMat4FromGlMatrix,
  glMatrixMat4FromBitecs,
  threeMat4FromGlMatrix,
  glMatrixMat4FromThree,
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

// Euler SoA bridges
export {
  threeEulerFromBitecs,
  bitecsEulerFromThree,
  bitecsEulerFromGlMatrix,
  glMatrixEulerFromBitecs,
  threeEulerFromGlMatrix,
  glMatrixEulerFromThree,
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

// Line3 SoA bridges
export {
  threeLine3FromBitecs,
  bitecsLine3FromThree,
  bitecsLine3FromGlMatrix,
  glMatrixLine3FromBitecs,
  threeLine3FromGlMatrix,
  glMatrixLine3FromThree,
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

// Plane SoA bridges
export {
  threePlaneFromBitecs,
  bitecsPlaneFromThree,
  bitecsPlaneFromGlMatrix,
  glMatrixPlaneFromBitecs,
  threePlaneFromGlMatrix,
  glMatrixPlaneFromThree,
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
  threeVec3FromBitecsPlaneLine3Intersect,
  bitecsPlaneApplyMatrix4InPlace,
  glMatrixPlanePackedFromBitecsFrustum,
  glMatrixVec3NormalizeFromBitecsPlane,
  glMatrixVec4FromBitecsPlane
} from './010_Plane.js';

// Sphere SoA bridges
export {
  threeSphereFromBitecs,
  bitecsSphereFromThree,
  bitecsSphereFromGlMatrix,
  glMatrixSphereFromBitecs,
  threeSphereFromGlMatrix,
  glMatrixSphereFromThree,
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

// Box3 SoA bridges
export {
  threeBox3FromBitecs,
  bitecsBox3FromThree,
  bitecsBox3FromGlMatrix,
  glMatrixBox3FromBitecs,
  threeBox3FromGlMatrix,
  glMatrixBox3FromThree,
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

// Ray SoA bridges
export {
  threeRayFromBitecs,
  bitecsRayFromThree,
  bitecsRayFromGlMatrix,
  glMatrixRayFromBitecs,
  threeRayFromGlMatrix,
  glMatrixRayFromThree,
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

// Triangle SoA bridges
export {
  threeTriangleFromBitecs,
  bitecsTriangleFromThree,
  bitecsTriangleFromGlMatrix,
  glMatrixTriangleFromBitecs,
  threeTriangleFromGlMatrix,
  glMatrixTriangleFromThree,
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

// Frustum SoA bridges
export {
  threeFrustumFromBitecs,
  bitecsFrustumFromThree,
  bitecsFrustumFromGlMatrixPacked,
  glMatrixFrustumPackedFromBitecs,
  threeFrustumFromGlMatrixPacked,
  glMatrixFrustumPackedFromThree,
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

// Vector4 SoA bridges
export {
  threeVec4FromBitecs,
  bitecsVec4FromThree,
  bitecsVec4FromGlMatrix,
  glMatrixVec4FromBitecs,
  threeVec4FromGlMatrix,
  glMatrixVec4FromThree,
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

// Color SoA bridges (from 017_ColorManagement.js)
export {
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
  glMatrixVec3SRGBToLinear,
  glMatrixVec3LinearToSRGB,
  glMatrixVec3AddFromBitecsColors,
  glMatrixVec4FromBitecsColor,
  glMatrixVec3LerpFromBitecsColors
} from './017_ColorManagement.js';

// Color class bridges (from 018_Color.js)
export {
  threeColorFromBitecs,
  threeColorFromBitecsSRGB,
  bitecsColorFromThreeColor,
  bitecsColorFromThreeColorSRGB,
  threeColorFromGlMatrixVec3,
  threeColorFromGlMatrixVec4,
  glMatrixVec3FromThreeColor,
  glMatrixVec4FromThreeColor,
  bitecsColorSetHexFromSRGB,
  bitecsColorSetHSLFromSRGB,
  bitecsColorAddInPlace,
  bitecsColorMultiplyInto,
  bitecsColorLerpVectorsInto,
  bitecsColorFromGlMatrixVec3SRGB,
  glMatrixVec3FromBitecsColorSRGB,
  glMatrixVec4FromBitecsColorSRGB,
  glMatrixVec3MultiplyFromBitecsColors,
  glMatrixVec4CopyFromBitecsColor
} from './018_Color.js';

// Cylindrical SoA bridges
export {
  threeCylindricalFromBitecs,
  bitecsCylindricalFromThree,
  bitecsCylindricalFromGlMatrix,
  glMatrixCylindricalFromBitecs,
  threeCylindricalFromGlMatrix,
  glMatrixCylindricalFromThree,
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
  glMatrixVec3NormalizedFromBitecsCylindrical
} from './019_Cylindrical.js';

// Spherical SoA bridges
export {
  threeSphericalFromBitecs,
  bitecsSphericalFromThree,
  bitecsSphericalFromGlMatrix,
  glMatrixSphericalFromBitecs,
  threeSphericalFromGlMatrix,
  glMatrixSphericalFromThree,
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

// SphericalHarmonics3 SoA bridges + anime probe builders
export {
  threeSH3FromBitecs,
  bitecsSH3FromThree,
  bitecsSH3FromGlMatrix,
  glMatrixSH3FromBitecs,
  threeSH3FromGlMatrix,
  glMatrixSH3FromThree,
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

// Interpolant SoA bridges (base)
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
  bitecsInterpolantSampleSlotFromT
} from './022_Interpolant.js';

// CubicInterpolant SoA bridges + helpers
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
  preciseCubicWeights,
  preciseCubicInterpolate
} from './023_CubicInterpolant.js';

// LinearInterpolant SoA bridges + helpers
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
  preciseLinearInterpolate,
  preciseLinearInterpolateBuffer,
  threeVec3FromBitecsLinearInterpolantEvaluatePrecise
} from './024_LinearInterpolant.js';

// DiscreteInterpolant SoA bridges + helpers
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

// QuaternionLinearInterpolant SoA bridges + helpers
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

// Box2 SoA bridges
export {
  threeBox2FromBitecs,
  bitecsBox2FromThree,
  bitecsBox2FromGlMatrix,
  glMatrixBox2FromBitecs,
  threeBox2FromGlMatrix,
  glMatrixBox2FromThree,
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

// BezierInterpolant SoA bridges + helpers
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

// OBB SoA bridges + SAT tests
export {
  obbFromBitecs,
  bitecsOBBFromObb,
  bitecsOBBFromGlMatrix,
  bitecsOBBFromGlMatrixPacked,
  glMatrixOBBFromBitecs,
  glMatrixOBBPackedFromBitecs,
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
  glMatrixVec3RotateOBBFromBitecs
} from './029_OBB.js';

// ColorSpace SoA bridges + helpers
export {
  glMatrixVec3ConvertColorSpace,
  glMatrixVec4ConvertColorSpace,
  glMatrixVec3SRGBToLinear as glMatrixVec3SRGBToLinearColorSpace,
  glMatrixVec3LinearToSRGB as glMatrixVec3LinearToSRGBColorSpace,
  glMatrixVec4SRGBToLinear,
  glMatrixVec4LinearToSRGB,
  glMatrixVec3LerpColors,
  glMatrixVec4FromBitecsColorCopy,
  bitecsColorConvertColorSpaceInPlace,
  bitecsColorSRGBToLinearInPlace as bitecsColorSRGBToLinearInPlaceColorSpace,
  bitecsColorLinearToSRGBInPlace as bitecsColorLinearToSRGBInPlaceColorSpace,
  bitecsColorFromGlMatrixVec3SRGB,
  bitecsColorFromGlMatrixVec3Linear,
  glMatrixVec3SRGBFromBitecsColor,
  glMatrixVec3LinearFromBitecsColor,
  glMatrixVec4SRGBFromBitecsColor,
  glMatrixVec4LinearFromBitecsColor,
  bitecsColorFromGlMatrixVec4SRGB,
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
  getColorSpacePrimaries,
  getColorSpaceTransfer,
  isLinearColorSpace,
  isSRGBFamilyColorSpace,
  clampedLuminance,
  preciseSRGBToLinear,
  preciseLinearToSRGB,
  preciseRelativeLuminance,
  preciseContrastRatio
} from './030_ColorSpace.js';

/* -------------------------------------------------------------------------- */
/* Noise cache management — a single call to clear every module's cache.      */
/* Individual modules expose their own disposeNoise3DCache /                   */
/* disposeNoise4DCache / disposeNoise2DCache; this aggregate calls them all.  */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Index module — no default export. Consumers import named symbols:          */
/*                                                                            */
/*   import { Vector3, Quaternion, Color } from './math/index.js';            */
/*   import { Vector3Module } from './math/index.js';                         */
/*   import { bitecsVec3FromBitecs } from './math/index.js';                  */
/*   import { disposeAllNoiseCaches } from './math/index.js';                 */
/* -------------------------------------------------------------------------- */