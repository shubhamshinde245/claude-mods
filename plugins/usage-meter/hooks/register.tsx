import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionContextUsage,
  SessionCost,
  SessionRateLimit,
} from 'claude-code'

import type { Limit, Limits, Pace, Tokens } from '../types'

const limits = atom({ plugin: 'usage-meter', key: 'limits' } as const, {
  session: null,
  weekly: null,
})
const costUsd = atom({ plugin: 'usage-meter', key: 'costUsd' } as const, null)
const contextPercent = atom({ plugin: 'usage-meter', key: 'contextPercent' } as const, null)
const model = atom({ plugin: 'usage-meter', key: 'model' } as const, null)
const effort = atom({ plugin: 'usage-meter', key: 'effort' } as const, null)
const tokens = atom({ plugin: 'usage-meter', key: 'tokens' } as const, {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
})
// Recent session-percent readings, for the time-to-limit projection
const pace = atom({ plugin: 'usage-meter', key: 'pace' } as const, { window: null, samples: [] })
// Thresholds already toasted, as `<kind>@<resetsAt>:<threshold>`
const warned = atom({ plugin: 'usage-meter', key: 'warned' } as const, [])

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WARN_AT = [80, 95]
const PACE_WINDOW_MS = 45 * 60 * 1000
const PACE_MIN_SPAN_MS = 3 * 60 * 1000

type Seg = { text: string; color?: string }

function formatIn(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function formatAt(date: Date): string {
  const hours = date.getHours()
  const mins = date.getMinutes()
  const suffix = hours < 12 ? 'am' : 'pm'
  const h12 = hours % 12 === 0 ? 12 : hours % 12
  const time = mins === 0 ? `${h12}${suffix}` : `${h12}:${String(mins).padStart(2, '0')}${suffix}`
  return `${DAYS[date.getDay()]} ${time}`
}

function count(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

// `claude-opus-5-5[1m]` → `Opus 5.5 (1M)`; anything else is shown as given
function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id)
  const [, word = '', major = '', minor] = m ?? []
  if (!m || !word) return id
  const family = word.charAt(0).toUpperCase() + word.slice(1)
  const version = minor === undefined ? major : `${major}.${minor}`
  return `${family} ${version}${m[4] ? ' (1M)' : ''}`
}

// Amber from 70%, red from 90%; undefined keeps the band's dim default
function levelColor(pct: number): string | undefined {
  if (pct >= 90) return 'red'
  if (pct >= 70) return 'yellow'
  return undefined
}

function resetText(kind: string, resetsAt: string | undefined, now: number): string {
  const resets = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(resets)) return ''
  return kind === 'five_hour'
    ? ` · resets in ${formatIn(resets - now)}`
    : ` · resets ${formatAt(new Date(resets))}`
}

// Milliseconds until the session window is used up at the recent rate, or null
// when there are too few readings, usage isn't climbing, or the reset comes first
function timeToLimit(session: Limit, p: Pace, now: number): number | null {
  const first = p.samples[0]
  const last = p.samples[p.samples.length - 1]
  if (!first || !last || first === last) return null
  const span = last.at - first.at
  const climbed = last.percent - first.percent
  if (span < PACE_MIN_SPAN_MS || climbed <= 0) return null
  const remaining = ((100 - session.percentUsed) / climbed) * span
  const resets = session.resetsAt ? Date.parse(session.resetsAt) : NaN
  if (!Number.isNaN(resets) && now + remaining >= resets) return null
  return Math.max(0, remaining)
}

async function apply(
  $: EngineInterface,
  rateLimits: SessionRateLimit[],
  cost: SessionCost | undefined,
  context: SessionContextUsage,
) {
  const pick = (kind: string): Limit | null => {
    const found = rateLimits.find(r => r.kind === kind)
    return found ? { percentUsed: found.percentUsed, resetsAt: found.resetsAt } : null
  }
  const fresh: Limits = { session: pick('five_hour'), weekly: pick('seven_day') }
  await update($, limits, () => fresh)
  await update($, costUsd, () => cost?.usd ?? null)
  await update($, contextPercent, () => context.percent ?? null)

  const now = await $.clock.now()
  const session = fresh.session
  if (session) {
    const window = session.resetsAt ?? null
    await update($, pace, (p): Pace => {
      const kept = p.window === window ? p.samples.filter(s => now - s.at <= PACE_WINDOW_MS) : []
      const last = kept[kept.length - 1]
      const samples =
        last && last.percent === session.percentUsed
          ? kept
          : [...kept, { at: now, percent: session.percentUsed }]
      return { window, samples }
    })
  }

  const done = await read($, warned)
  const fired: string[] = []
  for (const [kind, limit, label] of [
    ['five_hour', fresh.session, 'Session'],
    ['seven_day', fresh.weekly, 'Weekly'],
  ] as const) {
    if (!limit) continue
    const top = [...WARN_AT].reverse().find(t => limit.percentUsed >= t)
    if (top === undefined) continue
    const key = `${kind}@${limit.resetsAt ?? ''}:${top}`
    if (done.includes(key)) continue
    fired.push(key)
    $.ui.toast(
      `${label} limit at ${Math.round(limit.percentUsed)}%${resetText(kind, limit.resetsAt, now)}`,
      { timeoutMs: 10000 },
    )
  }
  if (fired.length > 0) {
    // Firing 95 also covers 80, so a later dip and climb doesn't toast 80 again
    const extra = fired.flatMap(k => {
      const top = Number(k.slice(k.lastIndexOf(':') + 1))
      return WARN_AT.filter(t => t < top).map(t => k.replace(/:\d+$/, `:${t}`))
    })
    await update($, warned, w => [...new Set([...w, ...fired, ...extra])].slice(-40))
  }
}

async function refresh($: EngineInterface) {
  const { rateLimits, cost, context } = await $.session.usage()
  await apply($, rateLimits, cost, context)
  const name = await $.session.model()
  await update($, model, () => (name ? modelName(name) : null))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  // Pushed whenever a rate-limit window moves a whole point, so warnings land mid-turn
  on('session.measure', async ($, e, next) => {
    await apply($, e.rateLimits, e.cost, e.context)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const level = e.effort === undefined ? null : String(e.effort)
      if (level !== (await read($, effort))) {
        await update($, effort, () => level)
      }
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const usage = e.usage
    if (usage) {
      await update($, tokens, (t): Tokens => ({
        input: t.input + usage.input_tokens,
        output: t.output + usage.output_tokens,
        cacheRead: t.cacheRead + usage.cache_read_input_tokens,
        cacheWrite: t.cacheWrite + usage.cache_creation_input_tokens,
      }))
    }
    await refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { session, weekly } = await read($, limits)
    const cost = await read($, costUsd)
    const ctx = await read($, contextPercent)
    const name = await read($, model)
    const level = await read($, effort)
    const t = await read($, tokens)
    const p = await read($, pace)
    const prompt = t.input + t.cacheRead + t.cacheWrite
    const hasLimits = session !== null || weekly !== null
    if (e.props.hasSurvey || (!hasLimits && prompt + t.output === 0 && !cost && ctx === null && name === null)) {
      return next(e)
    }

    const now = await $.clock.now()
    const limitItems: Seg[][] = []
    if (session) {
      const item: Seg[] = [
        { text: 'Session ' },
        { text: `${Math.round(session.percentUsed)}%`, color: levelColor(session.percentUsed) },
        { text: resetText('five_hour', session.resetsAt, now) },
      ]
      const left = timeToLimit(session, p, now)
      if (left !== null) {
        item.push({
          text: ` · ~${formatIn(left)} to limit at this pace`,
          color: left < 30 * 60 * 1000 ? 'red' : 'yellow',
        })
      }
      limitItems.push(item)
    }
    if (weekly) {
      limitItems.push([
        { text: 'Week ' },
        { text: `${Math.round(weekly.percentUsed)}%`, color: levelColor(weekly.percentUsed) },
        { text: resetText('seven_day', weekly.resetsAt, now) },
      ])
    }

    const spendItems: Seg[][] = []
    if (name !== null) spendItems.push([{ text: level === null ? name : `${name} (${level} effort)` }])
    if (ctx !== null) spendItems.push([{ text: 'Context ' }, { text: `${ctx}%`, color: levelColor(ctx) }])
    if (cost) spendItems.push([{ text: `$${cost.toFixed(2)}` }])
    if (prompt + t.output > 0) {
      spendItems.push([{ text: `in ${count(t.input)}` }], [{ text: `out ${count(t.output)}` }])
      if (prompt > 0) {
        const hit = Math.round((t.cacheRead / prompt) * 100)
        const hitColor = hit < 50 ? 'red' : hit < 80 ? 'yellow' : undefined
        spendItems.push([{ text: 'cache ' }, { text: `${hit}% hit`, color: hitColor }])
      }
    }

    const { Box, Text } = $.ui.resolve(e)
    const line = (items: Seg[][], sep: string, key: string) => (
      <Box key={key} flexWrap="wrap">
        {items.map((segs, i) => (
          <Box key={String(i)}>
            {segs.map((s, j) => (
              <Text key={String(j)} dimColor={s.color === undefined} color={s.color}>
                {s.text}
              </Text>
            ))}
            {i < items.length - 1 && <Text dimColor>{sep}</Text>}
          </Box>
        ))}
      </Box>
    )
    return (
      <Box flexDirection="column">
        {limitItems.length > 0 && line(limitItems, '   ', 'limits')}
        {spendItems.length > 0 && line(spendItems, ' · ', 'spend')}
      </Box>
    )
  })
}
