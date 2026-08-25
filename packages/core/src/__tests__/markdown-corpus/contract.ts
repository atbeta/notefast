/**
 * NoteFast Markdown 现行契约清单。
 *
 * 成功样本 = 已支持且下次保存必须与今天语义等价。
 * 失败样本 = 旧 parser 会丢内容 / 截断 / 认不出围栏；mdast 实现只允许这些条目改善。
 */

export const SUCCESS_FIXTURES = [
  '01-headings-paragraphs',
  '02-soft-break-zh',
  '03-soft-break-en',
  '04-quote-merge-split',
  '05-unordered-markers',
  '06-ordered-list',
  '07-task-list',
  '08-table',
  '09-table-then-paragraph',
  '10-pipe-not-table',
  '11-fenced-code',
  '12-sibling-fences',
  '13-list-then-fence',
  '14-math-fence',
  '15-math-fence-aliases',
  '16-mermaid',
  '17-image-and-link',
  '18-inline-markdown',
  '19-thematic-break',
  '20-empty',
  '21-nested-list',
  '22-html-preserved',
  '23-setext-as-paragraph',
  '24-quote-blank-gt',
] as const

export const FAILURE_FIXTURES = [
  'inner-fence',
  'tilde-fence',
  'unclosed-fence',
  'unclosed-fence-after-para',
  'four-backtick',
] as const

export type SuccessFixtureId = (typeof SUCCESS_FIXTURES)[number]
export type FailureFixtureId = (typeof FAILURE_FIXTURES)[number]

export interface FixtureMeta {
  /** 解析后经 serialize 再 parse，语义必须不变。默认 true */
  roundtrip?: boolean
  /** 失败样本：缺陷代号，供 mdast 对照 */
  defect?: string
  /** 失败样本允许新 parser 改善（不得更丢内容） */
  allowImprove?: boolean
  note?: string
}
