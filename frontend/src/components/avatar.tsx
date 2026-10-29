import { cn } from 'cn'
import { useId } from 'react'

// Our palette: sun, gum, cobalt, mint, ink (Paper: "Default avatars").
const colors = ['#FFD43B', '#FF7EB6', '#2E5BFF', '#1FAE6B', '#121212']

/** Their photo, or a face drawn from their id (a group's id for a group), so it never changes when they rename. */
export function Avatar({ id, image, className }: { id: string; image?: string | null; className?: string }) {
  return (
    <div aria-hidden="true" className={cn('size-11 shrink-0 overflow-hidden rounded-full', className)}>
      {image ? <img src={image} alt="" className="size-full object-cover" /> : <Beam name={id} />}
    </div>
  )
}

// boring-avatars' "beam" (MIT, boringdesigners), ported so the bundle carries one face instead of all six variants.
// Keep the math identical: changing it changes everyone's avatar.
const S = 36

function hash(name: string) {
  let h = 0

  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0

  return Math.abs(h)
}

const digit = (n: number, place: number) => Math.floor((n / 10 ** place) % 10)

const even = (n: number, place: number) => digit(n, place) % 2 === 0

function unit(n: number, range: number, place?: number) {
  const value = n % range

  return place && digit(n, place) % 2 === 0 ? -value : value
}

function contrast(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? '#000000' : '#FFFFFF'
}

function Beam({ name }: { name: string }) {
  const mask = useId()
  const n = hash(name)
  const wrapperColor = colors[n % colors.length]
  const face = contrast(wrapperColor)
  const x0 = unit(n, 10, 1)
  const x = x0 < 5 ? x0 + S / 9 : x0
  const y0 = unit(n, 10, 2)
  const y = y0 < 5 ? y0 + S / 9 : y0
  const faceX = x > S / 6 ? x / 2 : unit(n, 8, 1)
  const faceY = y > S / 6 ? y / 2 : unit(n, 7, 2)
  const eyeSpread = unit(n, 5)
  const mouthSpread = unit(n, 3)

  return (
    <svg viewBox={`0 0 ${S} ${S}`} fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <mask id={mask} maskUnits="userSpaceOnUse" x={0} y={0} width={S} height={S}>
        <rect width={S} height={S} rx={S * 2} fill="#FFFFFF" />
      </mask>
      <g mask={`url(#${mask})`}>
        <rect width={S} height={S} fill={colors[(n + 13) % colors.length]} />
        <rect
          x="0"
          y="0"
          width={S}
          height={S}
          transform={`translate(${x} ${y}) rotate(${unit(n, 360)} ${S / 2} ${S / 2}) scale(${1 + unit(n, S / 12) / 10})`}
          fill={wrapperColor}
          rx={even(n, 1) ? S : S / 6}
        />
        <g transform={`translate(${faceX} ${faceY}) rotate(${unit(n, 10, 3)} ${S / 2} ${S / 2})`}>
          {even(n, 2) ? (
            <path d={`M15 ${19 + mouthSpread}c2 1 4 1 6 0`} stroke={face} fill="none" strokeLinecap="round" />
          ) : (
            <path d={`M13,${19 + mouthSpread} a1,0.75 0 0,0 10,0`} fill={face} />
          )}
          <rect x={14 - eyeSpread} y={14} width={1.5} height={2} rx={1} stroke="none" fill={face} />
          <rect x={20 + eyeSpread} y={14} width={1.5} height={2} rx={1} stroke="none" fill={face} />
        </g>
      </g>
    </svg>
  )
}
