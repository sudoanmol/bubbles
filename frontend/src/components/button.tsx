import type { ComponentProps } from 'react'

const variants = {
  // Ink fill with a sun offset shadow: the primary action.
  primary: 'bg-ink text-paper shadow-sticker-sun',
  // White sticker with an ink outline.
  sticker: 'border-2 border-ink bg-paper text-ink shadow-sticker',
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: keyof typeof variants }) {
  return (
    <button
      className={`flex h-14 cursor-pointer items-center justify-center gap-2.5 rounded-[14px] px-5 text-base font-semibold transition-[translate,box-shadow] duration-100 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60 disabled:active:translate-0 ${variants[variant]} ${className}`}
      {...props}
    />
  )
}
