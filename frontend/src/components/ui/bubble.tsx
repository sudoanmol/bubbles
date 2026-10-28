import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'
import * as React from 'react'

const bubbleVariants = cva(
  'group/bubble relative flex w-fit max-w-[min(80%,460px)] min-w-0 flex-col gap-1 group-data-[align=end]/message:self-end data-[align=end]:self-end',
  {
    variants: {
      variant: {
        // Someone else's message: white with a hairline.
        incoming: '*:data-[slot=bubble-content]:border-line *:data-[slot=bubble-content]:bg-paper',
        // Your message: cobalt.
        outgoing: '*:data-[slot=bubble-content]:bg-cobalt *:data-[slot=bubble-content]:text-paper',
      },
    },
    defaultVariants: { variant: 'incoming' },
  }
)

function Bubble({
  variant = 'incoming',
  align = 'start',
  className,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof bubbleVariants> & { align?: 'start' | 'end' }) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      className={cn(bubbleVariants({ variant }), className)}
      {...props}
    />
  )
}

function BubbleContent({ className, render, ...props }: useRender.ComponentProps<'div'>) {
  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(
      {
        className: cn(
          'w-fit max-w-full min-w-0 overflow-hidden rounded-bubble border-[1.5px] border-transparent px-4 py-3 text-base leading-[22px] wrap-break-word whitespace-pre-wrap group-data-[align=end]/bubble:self-end',
          className
        ),
      },
      props
    ),
    render,
    state: { slot: 'bubble-content' },
  })
}

export { Bubble, BubbleContent }
