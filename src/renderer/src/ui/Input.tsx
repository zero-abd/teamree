// Text fields: one line, or several. Mono for refs and paths.

import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

type InputProps = InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; invalid?: boolean }

export function Input({ mono = false, invalid = false, className, ...rest }: InputProps): React.JSX.Element {
  const classes = `input${mono ? ' input--mono' : ''}${className === undefined ? '' : ` ${className}`}`
  return <input type="text" {...rest} className={classes} aria-invalid={invalid || undefined} />
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }

export function Textarea({ invalid = false, className, ...rest }: TextareaProps): React.JSX.Element {
  const classes = `textarea${className === undefined ? '' : ` ${className}`}`
  return <textarea {...rest} className={classes} aria-invalid={invalid || undefined} />
}
