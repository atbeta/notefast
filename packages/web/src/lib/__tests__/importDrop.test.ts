import { describe, expect, test } from 'bun:test'
import {
  classifyImportDrop,
  findLocalImageRefs,
  missingLocalImagesForImport,
} from '../importDrop'

describe('classifyImportDrop', () => {
  test('多于一个文件一律拒绝（含 md+图、文件夹）', () => {
    expect(classifyImportDrop([
      { name: 'note.md' },
      { name: 'a.png', type: 'image/png' },
    ])).toEqual({ status: 'multiple' })
    expect(classifyImportDrop([
      { name: 'a.docx' },
      { name: 'b.docx' },
    ])).toEqual({ status: 'multiple' })
  })

  test('单个 zip / docx / md / txt', () => {
    expect(classifyImportDrop([{ name: 'pack.zip' }])).toEqual({ status: 'zip' })
    expect(classifyImportDrop([{ name: 'x', type: 'application/zip' }])).toEqual({ status: 'zip' })
    expect(classifyImportDrop([{ name: 'doc.docx' }])).toEqual({ status: 'docx' })
    expect(classifyImportDrop([{ name: 'note.md' }])).toEqual({ status: 'markdown' })
    expect(classifyImportDrop([{ name: 'readme.txt' }])).toEqual({ status: 'markdown' })
  })

  test('散落图片或未知类型不收', () => {
    expect(classifyImportDrop([{ name: 'a.png', type: 'image/png' }])).toEqual({ status: 'unsupported' })
    expect(classifyImportDrop([{ name: 'notes.pdf' }])).toEqual({ status: 'unsupported' })
    expect(classifyImportDrop([])).toEqual({ status: 'unsupported' })
  })
})

describe('findLocalImageRefs / missingLocalImagesForImport', () => {
  test('相对路径命中；asset/http/data/绝对路径跳过', () => {
    expect(findLocalImageRefs('![a](foo.png) ![b](images/x.jpg)')).toEqual(['foo.png', 'images/x.jpg'])
    expect(findLocalImageRefs('![](asset:abc) ![](https://x/a.png) ![](/abs.png) ![](data:image/png;base64,aa)')).toEqual([])
  })

  test('手写新建不拦截；从文件载入才拦截', () => {
    const md = '正文 ![图](diagram.png)'
    expect(missingLocalImagesForImport(md, false)).toEqual([])
    expect(missingLocalImagesForImport(md, true)).toEqual(['diagram.png'])
    expect(missingLocalImagesForImport('# 无图', true)).toEqual([])
  })
})
