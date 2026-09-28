/** Prefer the smallest readable screenshot; no image-processing dependency needed. */
export async function compressScreenshot(capture, { targetBytes = 256 * 1024, maxBytes = 1024 * 1024 } = {}) {
  let best = Buffer.from(await capture({ type: 'png', scale: 1 }))
  // Small UI panels are already efficient and stay lossless.
  if (best.length <= 128 * 1024) return best
  for (const options of [
    { type: 'jpeg', quality: 82, scale: 1 },
    { type: 'jpeg', quality: 68, scale: 1 },
    { type: 'jpeg', quality: 68, scale: 0.8 },
    { type: 'jpeg', quality: 60, scale: 0.65 }
  ]) {
    try {
      const candidate = Buffer.from(await capture(options))
      if (candidate.length && candidate.length < best.length) best = candidate
      if (best.length <= targetBytes) break
    } catch {
      // Older browser builds may not support an encoding or scale; keep the prior image.
    }
  }
  // Do not attempt oversized uploads. Existing Markdown fallback preserves the result.
  return best.length <= maxBytes ? best : null
}
