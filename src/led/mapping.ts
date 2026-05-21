import type { CalibrationPoint, MappingHandle } from "../types";

type Vec2 = MappingHandle;

export function computeHomography(src: Vec2[], dst: Vec2[]): number[] | null {
  const [sx0, sy0] = src[0], [sx1, sy1] = src[1], [sx2, sy2] = src[2], [sx3, sy3] = src[3];
  const [dx0, dy0] = dst[0], [dx1, dy1] = dst[1], [dx2, dy2] = dst[2], [dx3, dy3] = dst[3];

  const A = [
    [sx0, sy0, 1, 0, 0, 0, -dx0*sx0, -dx0*sy0],
    [0, 0, 0, sx0, sy0, 1, -dy0*sx0, -dy0*sy0],
    [sx1, sy1, 1, 0, 0, 0, -dx1*sx1, -dx1*sy1],
    [0, 0, 0, sx1, sy1, 1, -dy1*sx1, -dy1*sy1],
    [sx2, sy2, 1, 0, 0, 0, -dx2*sx2, -dx2*sy2],
    [0, 0, 0, sx2, sy2, 1, -dy2*sx2, -dy2*sy2],
    [sx3, sy3, 1, 0, 0, 0, -dx3*sx3, -dx3*sy3],
    [0, 0, 0, sx3, sy3, 1, -dy3*sx3, -dy3*sy3],
  ];
  const b = [dx0, dy0, dx1, dy1, dx2, dy2, dx3, dy3];

  for (let col = 0; col < 8; col++) {
    let maxRow = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[maxRow][col])) maxRow = row;
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];
    [b[col], b[maxRow]] = [b[maxRow], b[col]];
    if (Math.abs(A[col][col]) < 1e-10) return null;
    const pivot = A[col][col];
    for (let j = col; j < 8; j++) A[col][j] /= pivot;
    b[col] /= pivot;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const f = A[row][col];
      for (let j = col; j < 8; j++) A[row][j] -= f * A[col][j];
      b[row] -= f * b[col];
    }
  }

  return [...b, 1];
}

export function applyHomography(H: number[], x: number, y: number): Vec2 {
  const w = H[6] * x + H[7] * y + H[8];
  return [
    (H[0] * x + H[1] * y + H[2]) / w,
    (H[3] * x + H[4] * y + H[5]) / w,
  ];
}

export function mapCameraToVideo(
  camPoints: Vec2[],
  camLedPositions: CalibrationPoint[],
): CalibrationPoint[] {
  const videoCorners: Vec2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const H = computeHomography(camPoints, videoCorners);
  if (!H) return [];

  return camLedPositions.map((p) => {
    const [vx, vy] = applyHomography(H, p.x, p.y);
    return {
      lanternId: p.lanternId,
      x: Math.max(0, Math.min(1, vx)),
      y: Math.max(0, Math.min(1, vy)),
    };
  });
}
