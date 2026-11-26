import type { OrcaWorkerApi } from 'orca/worker'
import { createSampler } from './sampler.ts'
import { clampCritAt, CRIT_AT, type Level } from './health.ts'
import { buildPrompt, pickAgent } from './explain.ts'
import type { AgentRow, ExplainInput } from './explain.ts'
import { createConnection, createRemote, validHost, type Connection, type Status } from './remote.ts'

type HostCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

const PULSE_MS = 3000
const BADGE: Record<Level, { visible: boolean; text?: string; tone?: string }> = {
  ok: { visible: false },
  warn: { visible: false },
  risk: { visible: true, text: 'Critical', tone: 'danger' },
  crit: { visible: true, text: 'Critical', tone: 'danger' }
}

type Prefs = { record: boolean; critAt: number }
type Sampler = ReturnType<typeof createSampler>
type Target = { host: string; conn: Connection; sampler: Sampler }

const DEFAULT_PREFS: Prefs = { record: true, critAt: CRIT_AT }
const HOST_KEY = 'host'

export const seams = {
  connect: (host: string, log?: (line: string) => void): Connection => createConnection(host, { log }),
  sampler: (conn: Connection): Sampler => {
    const remote = createRemote(conn)
    return createSampler({ provider: remote.provider, cpus: remote.cpus, space: remote.space, selfPids: remote.selfPids, localPids: [] })
  }
}

let timer: ReturnType<typeof setInterval> | null = null
let current: Target | null = null

function readPrefs(raw: unknown, base: Prefs): Prefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    record: typeof r.record === 'boolean' ? r.record : base.record,
    critAt: clampCritAt(r.critAt, base.critAt)
  }
}

export function statusLine(s: Status): string {
  if (!s.host) return 'Set the SSH host in Settings → Plugins → Remote Activity Monitor'
  const name = s.hostname && s.hostname !== s.host ? s.host + ' (' + s.hostname + ')' : s.host
  if (s.state === 'connected') return 'Remote: ' + name
  if (s.state === 'error') return 'Remote: ' + name + ' · ' + (s.error ?? 'not connected')
  return 'Remote: ' + name + ' · connecting…'
}

export default function activate(orca: OrcaWorkerApi): void {
  const host = (orca as unknown as { host?: { call?: HostCall } }).host
  const log = (orca as unknown as { log?: (...args: unknown[]) => void }).log
  const call: HostCall = (method, params) =>
    (host && host.call ? host.call(method, params) : Promise.reject(new Error('no host.call'))).catch((error: unknown) => {
      if (log) log(method + ' failed: ' + (error instanceof Error ? error.message : String(error)))
      return null
    })
  let shown: Level | null = null
  let prefs: Prefs = { ...DEFAULT_PREFS }
  let synced = false

  function badge(level: Level, tooltip: string): void {
    const next = BADGE[level]
    if (shown !== null && BADGE[shown].visible === next.visible && (!next.visible || shown === level)) return
    shown = level
    const where = current?.host ? current.host + ': ' : ''
    void call('statusBar.update', { id: 'health', ...next, icon: 'warning', tooltip: where + tooltip })
  }

  function target(hostName: string): Target {
    if (current && current.host === hostName) return current
    if (current) current.conn.close()
    const conn = seams.connect(hostName, log ? (line) => log(line) : undefined)
    const sampler = seams.sampler(conn)
    sampler.setRecording(prefs.record)
    sampler.setCritAt(prefs.critAt)
    sampler.onAlert((alert) => {
      if (alert.kind === 'notify') void call('notifications.show', { title: hostName + ': ' + alert.title, body: alert.body })
    })
    shown = null
    current = { host: hostName, conn, sampler }
    return current
  }

  async function readHost(): Promise<string> {
    const settings = (orca as unknown as { settings?: { get(key: string): Promise<unknown> } }).settings
    const value = settings ? await settings.get(HOST_KEY).catch(() => null) : null
    const trimmed = typeof value === 'string' ? value.trim() : ''
    return validHost(trimmed) ? trimmed : ''
  }

  // Only the newest settings read may switch hosts, even if an older one resolves later.
  let generation = 0
  function resolve(): Promise<Target> {
    const mine = ++generation
    return readHost().then((hostName) => (mine === generation ? target(hostName) : resolved))
  }
  let resolved: Promise<Target> = resolve()
  const active = () => resolved

  const settings = (orca as unknown as { settings?: { onDidChange?(listener: (change: { key: string }) => void): unknown } }).settings
  if (settings && settings.onDidChange) {
    settings.onDidChange(({ key }) => {
      if (key === HOST_KEY) resolved = resolve()
    })
  }

  orca.storage.get('prefs').then(async (stored) => {
    if (synced) return
    prefs = readPrefs(stored, DEFAULT_PREFS)
    const t = await active()
    t.sampler.setRecording(prefs.record)
    t.sampler.setCritAt(prefs.critAt)
  }, () => undefined)

  orca.panels.handle('prefs.sync', async (input) => {
    prefs = readPrefs(input, prefs)
    synced = true
    const t = await active()
    t.sampler.setRecording(prefs.record)
    t.sampler.setCritAt(prefs.critAt)
    try {
      await orca.storage.set('prefs', prefs)
    } catch (error: unknown) {
      if (log) log('prefs.sync failed: ' + (error instanceof Error ? error.message : String(error)))
    }
    return { ok: true, prefs }
  })

  orca.panels.handle('stats.read', async (input) => {
    const t = await active()
    if (!t.host) throw new Error(statusLine(t.conn.status()))
    let out: Awaited<ReturnType<Sampler['read']>>
    try {
      out = await t.sampler.read(input ?? {})
    } catch {
      // Without a live connection there is no reading; show why instead of zeros.
      throw new Error(statusLine(t.conn.status()))
    }
    if (t !== current) throw new Error('The SSH host changed; reading the new one…')
    const remote = t.conn.status()
    badge(out.health.level, out.health.cause)
    return { ...out, sample: { ...out.sample, note: statusLine(remote) }, remote }
  })
  orca.panels.handle('health.suspects', async () => (await active()).sampler.suspects())
  orca.panels.handle('process.quit', async (input) =>
    (await active()).sampler.quit(Number(input?.pid), String(input?.name ?? ''), input?.start ? String(input.start) : null, input?.force === true)
  )

  orca.panels.handle('process.explain', async (input) => {
    const raw = (input ?? {}) as ExplainInput
    if (!host || !host.call) return { ok: false, reason: 'This Orca cannot send to agents' }
    const t = await active()
    if (!t.host) return { ok: false, reason: 'Set the SSH host first' }
    const pid = Number(raw.pid)
    const path = Number.isInteger(pid) && pid > 0 ? await t.conn.call<string | null>(['readlink', '/proc/' + pid + '/exe']) : null
    const machine = 'the remote Linux host `' + t.host + '` (reach it with `ssh ' + t.host + '`)'
    const prompt = buildPrompt({ ...raw, platform: 'linux', machine }, typeof path === 'string' ? path || null : null)
    if (!prompt) return { ok: false, reason: 'That process is gone' }
    try {
      const listed = (await host.call('agents.list', {})) as { agents?: AgentRow[] } | null
      const pick = pickAgent(listed?.agents ?? [])
      if (!pick.ok) return { ok: false, reason: pick.reason, prompt }
      const sent = (await host.call('terminal.sendText', { terminalId: pick.terminalId, text: prompt, enter: true })) as { accepted?: boolean } | null
      if (!sent?.accepted) return { ok: false, reason: 'Your agent did not take the question', prompt }
      return { ok: true, title: pick.title }
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code
      if (log) log('process.explain failed: ' + (error instanceof Error ? error.message : String(error)))
      const reason = code === 'capability_denied' || code === 'consent_required'
        ? 'Allow agent access for Remote Activity Monitor in Orca plugin settings'
        : 'Could not reach your agent'
      return { ok: false, reason, prompt }
    }
  })

  badge('ok', '')
  if (timer) clearInterval(timer)
  timer = setInterval(() => {
    active().then((t) => {
      if (!t.host) return
      return t.sampler.pulse().then(() => {
        const h = t.sampler.health()
        badge(h.level, h.cause)
      })
    }).catch(() => undefined)
  }, PULSE_MS)
}

export function deactivate(): void {
  if (timer) clearInterval(timer)
  timer = null
  if (current) current.conn.close()
  current = null
}
