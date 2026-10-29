import type { Link } from './protocol'

/** How long a page gets to answer. */
const TIMEOUT_MS = 4_000

/** How much of a page is read: its tags are in <head>, and all of a huge page could fill this object's memory. */
const MAX_PAGE_BYTES = 1024 * 1024

/**
 * The card for a URL: its Open Graph (or Twitter, or plain HTML) title, description, image and site name. Null when
 * the page has no title or can't be fetched. Cards are kept in R2 by URL, so a link shared in many chats is fetched once.
 * ponytail: cached forever; refetch after a while if stale cards come up.
 */
export async function unfurl(env: CloudflareBindings, url: string): Promise<Link | null> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url))
  const key = `unfurl/${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
  const cached = await env.MEDIA.get(key)

  // Only this function writes under unfurl/: a Link as JSON.
  if (cached) return cached.json<Link>()

  const link = await fetchCard(url).catch(() => null)

  // Only cards are kept: a page that failed may answer next time.
  if (link) await env.MEDIA.put(key, JSON.stringify(link))

  return link
}

async function fetchCard(url: string): Promise<Link | null> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; Bubbles/1.0; link preview)', accept: 'text/html' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!res.ok || !res.body || !res.headers.get('content-type')?.includes('text/html')) return null

  const meta = new Map<string, string>()
  let title = ''

  const page = new HTMLRewriter()
    .on('meta', {
      element(el) {
        const name = el.getAttribute('property') ?? el.getAttribute('name')
        const content = el.getAttribute('content')

        if (name && content && !meta.has(name.toLowerCase())) meta.set(name.toLowerCase(), decode(content.trim()))
      },
    })
    .on('head > title', {
      text(t) {
        title += t.text
      },
    })
    .transform(res)
    .body!.getReader()

  // The handlers run as the page is read; nothing read is kept.
  // ponytail: reads on past </head> up to the cap; stop there if big pages cost too much.
  for (let read = 0; read < MAX_PAGE_BYTES;) {
    const { done, value } = await page.read()

    if (done) break
    read += value.byteLength
  }

  await page.cancel()

  const pick = (...names: string[]) => names.map((n) => meta.get(n)).find(Boolean) ?? null
  const final = new URL(res.url || url)
  const heading = pick('og:title', 'twitter:title') ?? decode(title.trim())

  if (!heading) return null
  const image = pick('og:image', 'og:image:url', 'twitter:image')
  // Pages over plain http would be blocked as mixed content.
  const src = image && URL.canParse(image, final.href) ? new URL(image, final) : null

  return {
    url,
    site: pick('og:site_name') ?? final.hostname.replace(/^www\./, ''),
    title: heading.slice(0, 200),
    description: pick('og:description', 'twitter:description', 'description')?.slice(0, 300) ?? null,
    image: src?.protocol === 'https:' ? src.href : null,
  }
}

const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
])

/** HTMLRewriter hands text and attributes over as written, entities and all. */
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) =>
    e[0] !== '#'
      ? (ENTITIES.get(e.toLowerCase()) ?? whole)
      : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
  )
