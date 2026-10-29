import type { GroupEvent, Person } from 'backend/protocol'

export const firstName = (name: string) => name.split(' ')[0]

/**
 * A group event as a sentence from `uid`'s point of view, in parts: `name` wraps each person's name, so the chat can
 * bold them and the sidebar can keep plain text. "You" is whoever reads it.
 */
export function describe<T>(e: GroupEvent, uid: string, name: (s: string) => T): (T | string)[] {
  const who = (p: Person) => name(p.id === uid ? 'You' : firstName(p.name))
  const whom = (p: Person) => (p.id === uid ? 'you' : name(firstName(p.name)))
  const list = (people: Person[]) => {
    const shown = people.length > 4 ? people.slice(0, 3) : people
    const parts: (T | string)[] = shown.map(whom)
    if (shown.length < people.length) parts.push(`${people.length - shown.length} others`)
    return parts.flatMap((p, i) => (i === 0 ? [p] : [i === parts.length - 1 ? ' and ' : ', ', p]))
  }
  switch (e.t) {
    case 'created':
      return [who(e.by), ` created “${e.name}”`]
    case 'added':
      return [who(e.by), ' added ', ...list(e.users)]
    case 'left':
      return [who(e.by), ' left']
    case 'removed':
      return [who(e.by), ' removed ', whom(e.user)]
    case 'renamed':
      return [who(e.by), ` renamed the group “${e.name}”`]
    case 'admin':
      return e.admin
        ? [who(e.by), ' made ', whom(e.user), ' an admin']
        : [who(e.by), ' removed ', whom(e.user), ' as admin']
    case 'deleted':
      return [who(e.by), ' deleted the group']
  }
}

/** The same sentence as plain text, from a stored event body. */
export const describeText = (body: string, uid: string) =>
  describe(JSON.parse(body) as GroupEvent, uid, (s) => s).join('')
