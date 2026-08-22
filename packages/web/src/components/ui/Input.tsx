import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'

const FIELD =
  'w-full px-3 py-1.5 rounded-md border bg-background text-base text-foreground placeholder:text-muted-foreground/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed'

function fieldTone(invalid?: boolean, mono?: boolean): string {
  return `${FIELD} ${invalid ? 'border-destructive/50' : 'border-border focus:border-primary/50'} ${mono ? 'font-mono' : ''}`
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
  mono?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, mono, className = '', ...rest },
  ref,
) {
  return <input ref={ref} {...rest} className={`${fieldTone(invalid, mono)} ${className}`} />
})

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
  mono?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, mono, className = '', ...rest },
  ref,
) {
  return <textarea ref={ref} {...rest} className={`${fieldTone(invalid, mono)} resize-y ${className}`} />
})
