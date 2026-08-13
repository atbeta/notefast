/**
 * 导入 tab 的拖放/选择分类。
 *
 * 产品约束：一次只接受一个文件。带本地图片的文档请打成 zip，
 * 由服务端 /import/zip 做相对路径收编；Web 不再收集散落的图片文件。
 */

const MD_RE = /\.(md|markdown|mdown|mkd|txt)$/i
const ZIP_RE = /\.zip$/i
const DOCX_RE = /\.docx$/i

export type ImportDropFile = { name: string; type?: string }

export type ImportDropResult =
  | { status: 'multiple' }
  | { status: 'unsupported' }
  | { status: 'zip' }
  | { status: 'docx' }
  | { status: 'markdown' }

export function classifyImportDrop(files: ReadonlyArray<ImportDropFile>): ImportDropResult {
  if (files.length === 0) return { status: 'unsupported' }
  if (files.length > 1) return { status: 'multiple' }
  const f = files[0]!
  const type = f.type ?? ''
  if (ZIP_RE.test(f.name) || type === 'application/zip' || type === 'application/x-zip-compressed') {
    return { status: 'zip' }
  }
  if (DOCX_RE.test(f.name)) return { status: 'docx' }
  if (MD_RE.test(f.name)) return { status: 'markdown' }
  return { status: 'unsupported' }
}

/** 提取 md 中「相对路径」本地图片引用（排除 asset:/http(s):/data:/绝对路径）。 */
export function findLocalImageRefs(markdown: string): string[] {
  const refs = new Set<string>()
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    const src = m[2]!
    if (
      src.startsWith('asset:') ||
      src.startsWith('http:') ||
      src.startsWith('https:') ||
      src.startsWith('data:') ||
      src.startsWith('/')
    ) {
      continue
    }
    const clean = src.split(/[?#]/)[0]!.trim()
    if (clean) refs.add(clean)
  }
  return [...refs]
}

/**
 * 仅「从文件载入」的 markdown 才拦截相对路径图。
 * 手写新建允许写 ![x](foo.png) 这类示例/占位，不挡创建。
 */
export function missingLocalImagesForImport(markdown: string, importedFromFile: boolean): string[] {
  if (!importedFromFile) return []
  return findLocalImageRefs(markdown)
}
