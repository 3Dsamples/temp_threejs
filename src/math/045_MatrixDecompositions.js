// file number : 045
// full path name : src/math/045_MatrixDecompositions.js
// description : High-performance index re-export for all matrix decomposition classes (LU, QR, SVD, EVD, Cholesky, NIPALS). Provides a single import surface for consumers while maintaining tree-shakability. Fully integrated with 040-044 and 047.
// best for : Convenient imports of all decompositions from a single module without pulling in unused code, and any matrix-decomposition pipeline in the ECS on Android 64-bit.
// license : MIT

export { LuDecomposition, LUInput, LUSolveInput, luDecomposeValidated, luSolveValidated, luDecomposeWithPolicies, luSolveWithPolicies } from './040_MatrixLU.js';
export { QrDecomposition, QRInput, QRSolveInput, qrDecomposeValidated, qrSolveValidated, qrDecomposeWithPolicies, qrSolveWithPolicies } from './041_MatrixQR.js';
export { SingularValueDecomposition, SVDInput, SVDSolveInput, svdDecomposeValidated, svdSolveValidated, svdDecomposeWithPolicies, svdSolveWithPolicies } from './042_MatrixSVD.js';
export { EigenvalueDecomposition, EVDInput, evdDecomposeValidated, evdDecomposeWithPolicies } from './043_MatrixEVD.js';
export { CholeskyDecomposition, CholeskyInput, CholeskySolveInput, choleskyDecomposeValidated, choleskySolveValidated, choleskyDecomposeWithPolicies, choleskySolveWithPolicies } from './044_MatrixCholesky.js';
export { NIPALS, NIPALSInput, nipalsValidated, nipalsWithPolicies } from './043_MatrixNIPALS.js';
export { transposeSquareInPlace, hypotenuse, hypotenuse3 } from './047_MatrixDCUtil.js';