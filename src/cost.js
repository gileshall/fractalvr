// What a 3D image costs and where in it the cost lies. The unit is one accumulate pixel. A
// geometry sample costs the estimator iterations it ran (its work, counted by the geometry
// pass) times the fractal's cost of one.

// cum[j]: the share of the image's cost below band j of rows.length equal bands of rows, from
// rows[j], the work per geometry sample in band j. Returns the cost of the whole image.
export function cumulate(cum, rows, iterCost, geoSamples, accPixels) {
  const n = rows.length;
  let total = 0;
  cum[0] = 0;
  for (let j = 0; j < n; j++) {
    total += (accPixels + iterCost * rows[j] * geoSamples) / n;
    cum[j + 1] = total;
  }
  for (let j = 1; j <= n; j++) cum[j] /= total;
  return total;
}

// The height (0..1 from the bottom) below which lies share t of the image's cost.
export function heightAt(cum, t) {
  const n = cum.length - 1;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let lo = 0, hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= t) lo = mid; else hi = mid;
  }
  return (lo + (t - cum[lo]) / (cum[hi] - cum[lo])) / n;
}
