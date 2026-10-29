import Beam from 'boring-avatars'
import { cn } from 'cn'

// Our palette: sun, gum, cobalt, mint, ink (Paper: "Default avatars").
const colors = ['#FFD43B', '#FF7EB6', '#2E5BFF', '#1FAE6B', '#121212']

/** Their photo, or a face drawn from their id (a group's id for a group), so it never changes when they rename. */
export function Avatar({ id, image, className }: { id: string; image?: string | null; className?: string }) {
  return (
    <div aria-hidden="true" className={cn('size-11 shrink-0 overflow-hidden rounded-full', className)}>
      {image ? (
        <img src={image} alt="" className="size-full object-cover" />
      ) : (
        <Beam name={id} variant="beam" colors={colors} size="100%" title={false} />
      )}
    </div>
  )
}
