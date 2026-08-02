/**
 * 最小 ZIP（STORE，无压缩）—— 单文档导出打包用，避免引入依赖。
 * 仅支持 ASCII/UTF-8 文件名（UTF-8 通用标志 bit 11）。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  /** zip 内路径，使用 `/` 分隔 */
  name: string
  data: Uint8Array
}

function encodeName(name: string): Uint8Array {
  return new TextEncoder().encode(name)
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  return b
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  b[2] = (n >>> 16) & 0xff
  b[3] = (n >>> 24) & 0xff
  return b
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** 将若干文件打成 STORE 方式的 zip（浏览器可直接解压） */
export function buildZipStore(entries: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0
  // bit 11 = UTF-8 文件名
  const generalFlag = 0x0800
  const method = 0 // store
  const dosTime = 0
  const dosDate = 0

  for (const entry of entries) {
    const nameBytes = encodeName(entry.name)
    const data = entry.data
    const crc = crc32(data)
    const localHeader = concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(generalFlag),
      u16(method),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0), // extra
      nameBytes,
    ])
    localParts.push(localHeader, data)

    const central = concat([
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(generalFlag),
      u16(method),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0), // extra
      u16(0), // comment
      u16(0), // disk start
      u16(0), // int attrs
      u32(0), // ext attrs
      u32(offset),
      nameBytes,
    ])
    centralParts.push(central)
    offset += localHeader.length + data.length
  }

  const centralDir = concat(centralParts)
  const eocd = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ])

  return concat([...localParts, centralDir, eocd])
}

/**
 * 读取 zip（只读，无依赖）：
 * - 支持 STORE（method 0）与 DEFLATE（method 8，经 Bun.inflateSync 解压）
 * - 目录项跳过；zip64 / 加密等罕见形态抛错
 * - 数据描述符（bit 3）不影响：大小与偏移一律以中央目录为准
 */
export function parseZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // EOCD：从尾部往前找签名（容忍末尾 comment）
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('无效的 zip 文件：未找到中央目录结尾')
  const cdOffset = view.getUint32(eocd + 16, true)
  const cdCount = view.getUint16(eocd + 10, true)

  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let n = 0; n < cdCount; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break
    const method = view.getUint16(p + 10, true)
    const compSize = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localOffset = view.getUint32(p + 42, true)
    if (compSize === 0xffffffff) {
      throw new Error(`不支持 zip64 大文件条目: ${decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)) || '(无文件名)'}`)
    }
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue
    // 本地文件头在 centralOffset 处读取，名称/额外字段长度与中央目录一致才跳到数据
    const lhNameLen = view.getUint16(localOffset + 26, true)
    const lhExtraLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen
    const comp = new Uint8Array(bytes.subarray(dataStart, dataStart + compSize))
    let data: Uint8Array
    if (method === 0) {
      data = comp
    } else if (method === 8) {
      data = new Uint8Array(Bun.inflateSync(comp))
    } else {
      throw new Error(`不支持的 zip 压缩方式: ${method}（${name}）`)
    }
    entries.push({ name, data })
  }
  return entries
}
