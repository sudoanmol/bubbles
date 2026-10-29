import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'

// Sticker buttons sit on an offset shadow and press flat into it.
const press =
  'transition-[translate,box-shadow] duration-100 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none'

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2.5 font-semibold whitespace-nowrap outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:translate-0 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Ink fill with a sun shadow: the primary action.
        default: `bg-ink text-paper shadow-sticker-sun ${press}`,
        // White sticker with an ink outline.
        sticker: `border-2 border-ink bg-paper text-ink shadow-sticker ${press}`,
        // Sun sticker for small icon actions (new chat, send).
        sun: `border-2 border-ink bg-sun text-black shadow-[2px_2px_0_var(--color-ink)] ${press}`,
        ghost: 'text-muted-foreground hover:bg-wash hover:text-ink',
        // Quiet secondary actions (Cancel, Leave group): a hairline border.
        outline: 'border-[1.5px] border-line bg-paper text-ink transition-colors hover:bg-wash',
        // The destructive step of a confirmation.
        danger: 'bg-danger text-white font-bold transition-[filter] hover:brightness-95',
      },
      size: {
        default: 'h-14 rounded-[14px] px-5 text-base',
        sm: 'h-9 rounded-lg px-3 text-sm',
        md: 'h-10 rounded-xl px-4 text-sm',
        icon: 'size-10 rounded-xl',
        'icon-sm': 'size-9 rounded-xl',
        'icon-xs': 'size-6 rounded-full [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
