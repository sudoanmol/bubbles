export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const lg = size === 'lg'

  return (
    <div className="flex items-center gap-2.5">
      <div
        className={
          lg
            ? 'size-9 rounded-[18px_18px_18px_4px] bg-ink'
            : 'size-[30px] rounded-[15px_15px_15px_4px] border-2 border-ink bg-sun'
        }
      />
      <span className={`font-display font-extrabold tracking-[-0.03em] ${lg ? 'text-[26px]' : 'text-[22px]'}`}>
        bubbles
      </span>
    </div>
  )
}
