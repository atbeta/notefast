import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { extname, join } from 'node:path'
import { getLoadablePath } from 'sqlite-vec'

const source = getLoadablePath()
const nativeDir = join(import.meta.dir, '..', 'dist', 'native')
const target = join(nativeDir, `vec0${extname(source)}`)

// 清空后只保留当前构建平台产物，避免宿主机 dylib 混进 Linux 镜像。
rmSync(nativeDir, { recursive: true, force: true })
mkdirSync(nativeDir, { recursive: true })
copyFileSync(source, target)
console.log(`sqlite-vec: ${source} -> ${target}`)
