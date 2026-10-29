// Portable IEEE-754 float16 vector storage. Encode two bytes per dimension on
// Node.js 22 even when Float16Array is unavailable. Decode legacy float32 too.
export const HAS_F16 = typeof Float16Array === 'function'
const bitsBuf = new ArrayBuffer(4)
const bitsView = new DataView(bitsBuf)

function floatToHalf(value) {
  bitsView.setFloat32(0, value, true)
  const bits = bitsView.getUint32(0, true)
  const sign = (bits >>> 16) & 0x8000
  const exponent = (bits >>> 23) & 0xff
  const mantissa = bits & 0x7fffff
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0)
  const halfExp = exponent - 127 + 15
  if (halfExp >= 31) return sign | 0x7c00
  if (halfExp <= 0) {
    if (halfExp < -10) return sign
    const full = mantissa | 0x800000
    const shift = 14 - halfExp
    let half = full >>> shift
    const rest = full & ((1 << shift) - 1)
    const halfway = 1 << (shift - 1)
    if (rest > halfway || (rest === halfway && (half & 1))) half++
    return sign | half
  }
  let half = (halfExp << 10) | (mantissa >>> 13)
  const rest = mantissa & 0x1fff
  if (rest > 0x1000 || (rest === 0x1000 && (half & 1))) half++
  return sign | half
}

export function vecToBuf(v) {
  const out = Buffer.allocUnsafe(v.length * 2)
  if (HAS_F16) {
    const half = new Float16Array(v.length)
    for (let i = 0; i < v.length; i++) half[i] = v[i]
    Buffer.from(half.buffer).copy(out)
    return out
  }
  for (let i = 0; i < v.length; i++) out.writeUInt16LE(floatToHalf(v[i]), i * 2)
  return out
}

export function decodeVector(buf, dim) {
  if (!buf || !dim) return null
  if (buf.byteLength === dim * 2) {
    const out = new Float32Array(dim)
    for (let i = 0; i < dim; i++) {
      const h = buf.readUInt16LE ? buf.readUInt16LE(i * 2) : new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(i * 2, true)
      const s = h & 0x8000 ? -1 : 1
      const e = (h >> 10) & 0x1f
      const f = h & 0x3ff
      if (e === 0) out[i] = s * f * 5.960464477539063e-8
      else if (e === 31) out[i] = f ? NaN : s * Infinity
      else out[i] = s * (1 + f / 1024) * 2 ** (e - 15)
    }
    return out
  }
  if (buf.byteLength === dim * 4) return new Float32Array(new Float32Array(buf.buffer, buf.byteOffset, dim))
  return null
}

export function vectorBytes(dim) { return dim * 2 }
