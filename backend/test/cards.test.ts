// Link cards in the Workers runtime: the card follows the message as a patch, and an edit that drops the link
// before the page answers leaves no stale card (`pnpm -C backend test`).
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'

import type { ChatDO } from '../src/durable-objects/chat'
import { unfurl } from '../src/unfurl'

const card = { url: 'https://x.com/a', site: 'x.com', title: 'X', description: null, image: null }

/** Answers like a page that has the card, without the network. */
async function seed() {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(card.url))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  await env.MEDIA.put(`unfurl/${hex}`, JSON.stringify(card))
  expect(await unfurl(env, card.url)).toEqual(card)
}

const send = (body: string) => ({ t: 'send', cid: '01JAX9ZZZZZZZZZZZZZZZZZZZ1', chat: 'cards', body }) as const
const settle = () => new Promise((r) => setTimeout(r, 50))

it('adds the card with a patch after the message', async () => {
  await seed()
  await runInDurableObject(env.CHAT.get(env.CHAT.idFromName('cards')), async (instance: ChatDO) => {
    instance.init(['a', 'b'])
    expect(instance.write('a', send(`look ${card.url}`))).toMatchObject({ seq: 1, link: null })
    await settle()
    expect(instance.messages('a')).toMatchObject([
      { seq: 1, link: card, rev: 2 },
      { seq: 2, kind: 'patch', link: card },
    ])
  })
})

it('drops a card whose link was edited away while the page loaded', async () => {
  await seed()
  await runInDurableObject(env.CHAT.get(env.CHAT.idFromName('cards-edit')), async (instance: ChatDO) => {
    instance.init(['a'])
    instance.write('a', send(card.url))
    instance.write('a', {
      t: 'edit',
      cid: '01JAX9ZZZZZZZZZZZZZZZZZZZ2',
      chat: 'cards-edit',
      seq: 1,
      body: 'never mind',
    })
    await settle()
    expect(instance.messages('a')).toMatchObject([{ seq: 1, body: 'never mind', link: null }, { seq: 2 }])
  })
})
