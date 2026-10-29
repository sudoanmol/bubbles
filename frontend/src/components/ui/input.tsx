import { Input as InputPrimitive } from '@base-ui/react/input'
import { cn } from 'cn'
import * as React from 'react'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'h-[52px] w-full min-w-0 rounded-[14px] border-2 border-wash bg-wash px-4 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ink focus-visible:bg-paper disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger',
        className
      )}
      {...props}
    />
  )
}

export { Input }
