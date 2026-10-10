/** Keep the exterior of a concentric shell for a whole-shell composite.
 * Blender exports both interfaces. Applying an already integrated transmission
 * shader to both front-facing interfaces subtracts the same backdrop twice.
 * The classification is in object space, so bobbing, scaling and orbiting do
 * not change it. No source geometry or asset is modified.
 */
export function exteriorShellGeometry(source) {
  const position = source.getAttribute('position');
  const normal = source.getAttribute('normal');
  if (!position || !normal) throw new Error('Shell needs positions and normals');
  const index = source.index;
  const kept = [];
  const count = index ? index.count : position.count;
  for (let i = 0; i < count; i += 3) {
    let outward = 0;
    const triangle = [];
    for (let j = 0; j < 3; j++) {
      const v = index ? index.getX(i + j) : i + j;
      triangle.push(v);
      outward += position.getX(v) * normal.getX(v)
        + position.getY(v) * normal.getY(v) + position.getZ(v) * normal.getZ(v);
    }
    if (outward > 0) kept.push(...triangle);
  }
  if (!kept.length) throw new Error('No exterior shell triangles found');
  const result = source.clone();
  result.setIndex(kept);
  result.clearGroups();
  result.userData.shellTriangles = { source: count / 3, exterior: kept.length / 3 };
  return result;
}
