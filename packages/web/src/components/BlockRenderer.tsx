import type { Block } from '@notefast/core'

interface BlockRendererProps {
  block: Block
  depth?: number
}

export default function BlockRenderer({ block, depth = 0 }: BlockRendererProps) {
  if (depth > 20) return null

  if (block.type === 'document') {
    return (
      <article className="prose max-w-none">
        {block.content && depth === 0 && (
          <h1 className="text-3xl font-bold mb-8">{block.content}</h1>
        )}
        {block.children.map((child) => (
          <BlockNode key={child.id} block={child} depth={depth + 1} />
        ))}
      </article>
    )
  }

  return (
    <div className="prose max-w-none">
      <BlockNode block={block} depth={depth} />
    </div>
  )
}

function BlockNode({ block, depth }: { block: Block; depth: number }) {
  switch (block.type) {
    case 'heading': {
      const level = (block.properties.headingLevel as number) || 1
      const tagLevel = Math.min(level + 1, 6)
      const id = block.id
      return (
        <div className="group relative">
          {tagLevel === 2 && <h2 id={id} className="scroll-mt-20"><a href={`#${id}`} className="no-underline text-inherit hover:text-blue-600">{block.content}</a></h2>}
          {tagLevel === 3 && <h3 id={id} className="scroll-mt-20"><a href={`#${id}`} className="no-underline text-inherit hover:text-blue-600">{block.content}</a></h3>}
          {tagLevel === 4 && <h4 id={id} className="scroll-mt-20"><a href={`#${id}`} className="no-underline text-inherit hover:text-blue-600">{block.content}</a></h4>}
          {tagLevel === 5 && <h5 id={id} className="scroll-mt-20"><a href={`#${id}`} className="no-underline text-inherit hover:text-blue-600">{block.content}</a></h5>}
          {tagLevel === 6 && <h6 id={id} className="scroll-mt-20"><a href={`#${id}`} className="no-underline text-inherit hover:text-blue-600">{block.content}</a></h6>}
          {tagLevel < 2 && <h2 id={id} className="scroll-mt-20"><a href={`#${id}`} className="no-underline text-inherit hover:text-blue-600">{block.content}</a></h2>}
          {tagLevel > 6 && <h6 id={id} className="scroll-mt-20"><a href={`#${id}`} className="no-underline text-inherit hover:text-blue-600">{block.content}</a></h6>}
          {block.children.map((child) => (
            <BlockNode key={child.id} block={child} depth={depth + 1} />
          ))}
        </div>
      )
    }

    case 'paragraph':
      return <p>{block.content}</p>

    case 'list':
      return (
        <ul>
          {block.children.map((child) => (
            <BlockNode key={child.id} block={child} depth={depth + 1} />
          ))}
        </ul>
      )

    case 'list_item':
      return (
        <li>
          {block.content}
          {block.children.length > 0 && (
            <ul>
              {block.children.map((child) => (
                <BlockNode key={child.id} block={child} depth={depth + 1} />
              ))}
            </ul>
          )}
        </li>
      )

    case 'code': {
      const lang = (block.properties.language as string) || ''
      return (
        <pre>
          <code className={lang ? `language-${lang}` : ''}>{block.content}</code>
        </pre>
      )
    }

    case 'quote':
      return (
        <blockquote>
          <p>{block.content}</p>
          {block.children.map((child) => (
            <BlockNode key={child.id} block={child} depth={depth + 1} />
          ))}
        </blockquote>
      )

    default:
      return <p className="text-gray-400 italic">[未知块类型: {block.type}]</p>
  }
}
