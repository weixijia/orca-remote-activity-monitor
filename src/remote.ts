import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createLinux } from './linux.ts'
import type { Deps, Identity, Provider, QuitResult } from './deps.ts'
import type { CpuTimes } from './parse.ts'

// The agent runs on the remote host under `python3`. It answers one JSON line per request
// with one result per op, so a whole sampling pass costs one round trip over one SSH session.
export const AGENT_PY = String.raw`
import sys, os, json, signal, subprocess, threading, time
ENV = dict(os.environ, LC_ALL='C', LANG='C')
TCK = os.sysconf('SC_CLK_TCK') or 100
def rd(p):
    try:
        with open(p, 'rb') as f:
            return f.read().decode('utf-8', 'replace')
    except Exception:
        return ''
def ls(p):
    try:
        return os.listdir(p)
    except Exception:
        return []
def rl(p):
    try:
        return os.readlink(p)
    except Exception:
        return None
def run(c, a, any_exit):
    # subprocess.run would wait forever on a child stuck in the kernel (a hung GPU driver),
    # so give up on it after a bounded wait instead.
    try:
        p = subprocess.Popen([c] + list(a), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=ENV)
    except Exception:
        return None
    try:
        out, _ = p.communicate(timeout=8)
    except subprocess.TimeoutExpired:
        p.kill()
        try:
            p.wait(timeout=1)
        except Exception:
            pass
        return None
    except Exception:
        return None
    text = out.decode('utf-8', 'replace')
    return text if p.returncode == 0 or any_exit else None
def cpus():
    out = []
    for line in rd('/proc/stat').splitlines():
        f = line.split()
        if len(f) > 7 and f[0].startswith('cpu') and f[0] != 'cpu':
            v = [int(x) * 1000 // TCK for x in f[1:8]]
            out.append({'user': v[0], 'nice': v[1], 'sys': v[2], 'idle': v[3], 'irq': v[5] + v[6]})
    return out
def statvfs(p):
    try:
        s = os.statvfs(p)
        return {'blocks': s.f_blocks, 'bsize': s.f_frsize, 'bavail': s.f_bavail, 'bfree': s.f_bfree}
    except Exception:
        return None
def kill(pid, force):
    try:
        os.kill(int(pid), signal.SIGKILL if force else signal.SIGTERM)
        return {'ok': True}
    except ProcessLookupError:
        return {'ok': False, 'reason': 'Already gone'}
    except PermissionError:
        return {'ok': False, 'reason': 'Not allowed: another user owns it'}
    except Exception:
        return {'ok': False, 'reason': 'Could not quit it'}
def hello():
    u = os.uname()
    return {'pid': os.getpid(), 'ppid': os.getppid(), 'home': os.path.expanduser('~'), 'hostname': u.nodename, 'system': u.sysname}
OPS = {'read': rd, 'list': ls, 'readlink': rl, 'run': run, 'cpus': cpus, 'statvfs': statvfs, 'kill': kill, 'hello': hello}
def one(op):
    try:
        return OPS[op[0]](*op[1:])
    except Exception:
        return None
PARENT = os.getppid()
def watchdog():
    # Exit once the ssh session that started us is gone, even if a request is stuck.
    while True:
        time.sleep(5)
        if os.getppid() != PARENT:
            os._exit(0)
threading.Thread(target=watchdog, daemon=True).start()
for line in sys.stdin:
    try:
        req = json.loads(line)
        ops = req.get('o', [])
        out = json.dumps({'i': req.get('i'), 'r': [one(op) for op in ops]})
    except Exception:
        continue
    sys.stdout.write(out + '\n')
    sys.stdout.flush()
os._exit(0)
`

export type Op =
  | ['read', string]
  | ['list', string]
  | ['readlink', string]
  | ['run', string, string[], boolean]
  | ['cpus']
  | ['statvfs', string]
  | ['kill', number, boolean]
  | ['hello']

export type Hello = { pid: number; ppid: number; home: string; hostname: string; system: string }
export type Status = { host: string; state: 'idle' | 'connecting' | 'connected' | 'error'; error: string | null; hostname: string | null }

type Pending = { op: Op; resolve: (value: unknown) => void }
type Batch = { items: Pending[]; timer: ReturnType<typeof setTimeout> | null }

// What each op reports when the connection is down, matching what the local Deps return on failure.
function fallback(op: Op): unknown {
  switch (op[0]) {
    case 'read': return ''
    case 'list': return []
    case 'cpus': return []
    case 'kill': return { ok: false, reason: 'Not connected to the remote host' }
    default: return null
  }
}

const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._:%-]{0,252}$/

// An ssh alias or user@host. Neither part may start with '-', so nothing reaches ssh (or a
// ProxyCommand that expands %h / %r) as an option.
export function validHost(host: string): boolean {
  if (host.length > 255) return false
  const at = host.indexOf('@')
  if (at < 0) return NAME_RE.test(host)
  return host.indexOf('@', at + 1) < 0 && USER_RE.test(host.slice(0, at)) && NAME_RE.test(host.slice(at + 1))
}

export function agentCommand(): string {
  const b64 = Buffer.from(AGENT_PY, 'utf8').toString('base64')
  return 'python3 -u -c "import base64;exec(base64.b64decode(\'' + b64 + '\'))"'
}

export function sshArgs(host: string, extra: string[] = []): string[] {
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'Compression=yes',
    ...extra,
    '--', host, agentCommand()
  ]
}

export type Spawn = (command: string, args: string[]) => ChildProcessWithoutNullStreams

export type ConnectionOptions = {
  spawn?: Spawn
  sshExtra?: string[]
  timeoutMs?: number
  connectTimeoutMs?: number
  retryMs?: number
  log?: (line: string) => void
}

// One persistent SSH session. Ops issued in the same turn of the event loop share a request.
export function createConnection(host: string, options: ConnectionOptions = {}) {
  const doSpawn: Spawn = options.spawn ?? ((command, args) => spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }))
  // Below the panel's 15 s request timeout, so a hung host surfaces as an error, not a stuck panel.
  const timeoutMs = options.timeoutMs ?? 12000
  // The first answer also waits for the ssh handshake, login and python start.
  const connectTimeoutMs = options.connectTimeoutMs ?? 30000
  const retryMs = options.retryMs ?? 5000
  const status: Status = { host, state: 'idle', error: null, hostname: null }
  let child: ChildProcessWithoutNullStreams | null = null
  let hello: Promise<Hello | null> | null = null
  let queue: Pending[] = []
  let flushing = false
  let nextId = 1
  let failedAt = -Infinity
  let closed = false
  let stderrTail = ''
  const inflight = new Map<number, Batch>()

  function fail(reason: string): void {
    for (const [, batch] of inflight) {
      if (batch.timer) clearTimeout(batch.timer)
      for (const p of batch.items) p.resolve(fallback(p.op))
    }
    inflight.clear()
    status.state = 'error'
    status.error = reason
    failedAt = Date.now()
    hello = null
    if (child) {
      const c = child
      child = null
      c.stdin.end()
      c.kill()
    }
    if (options.log) options.log('remote ' + host + ': ' + reason)
  }

  function start(): ChildProcessWithoutNullStreams | null {
    if (closed) return null
    if (child) return child
    if (!validHost(host)) {
      status.state = 'error'
      status.error = 'Invalid SSH host'
      return null
    }
    if (Date.now() - failedAt < retryMs) return null
    status.state = 'connecting'
    stderrTail = ''
    let c: ChildProcessWithoutNullStreams
    try {
      c = doSpawn('ssh', sshArgs(host, options.sshExtra))
    } catch (error) {
      fail('Could not start ssh: ' + (error instanceof Error ? error.message : String(error)))
      return null
    }
    child = c
    let buffer = ''
    c.stdout.setEncoding('utf8')
    c.stdout.on('data', (chunk: string) => {
      // Only the new chunk can hold the next newline; avoids rescanning a large partial line.
      let nl = chunk.indexOf('\n')
      buffer += chunk
      if (nl >= 0) nl = buffer.length - chunk.length + nl
      while (nl >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        let msg: { i?: unknown; r?: unknown }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        const batch = typeof msg.i === 'number' ? inflight.get(msg.i) : undefined
        if (!batch) continue
        inflight.delete(msg.i as number)
        if (batch.timer) clearTimeout(batch.timer)
        if (status.state !== 'connected') {
          status.state = 'connected'
          status.error = null
        }
        const results = Array.isArray(msg.r) ? msg.r : []
        batch.items.forEach((p, k) => p.resolve(results[k] ?? fallback(p.op)))
        armHead()
      }
    })
    c.stderr.setEncoding('utf8')
    c.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-400)
    })
    c.on('error', (error) => {
      if (child === c) fail('ssh failed: ' + error.message)
    })
    c.on('close', (code) => {
      if (child !== c) return
      const why = stderrTail.trim().split('\n').filter(Boolean).pop()
      fail(why || 'ssh exited with code ' + code)
    })
    c.stdin.on('error', () => undefined)
    return c
  }

  // The agent answers in order, so only the batch it is working on is timed; queued ones wait.
  function armHead(): void {
    const head = inflight.entries().next()
    if (head.done || head.value[1].timer) return
    const [id, batch] = head.value
    batch.timer = setTimeout(() => {
      if (inflight.has(id)) fail('The remote host stopped answering')
    }, status.state === 'connected' ? timeoutMs : connectTimeoutMs)
  }

  function flush(): void {
    flushing = false
    const items = queue
    queue = []
    if (!items.length) return
    const c = start()
    if (!c) {
      for (const p of items) p.resolve(fallback(p.op))
      return
    }
    const id = nextId++
    inflight.set(id, { items, timer: null })
    armHead()
    c.stdin.write(JSON.stringify({ i: id, o: items.map((p) => p.op) }) + '\n')
  }

  function call<T>(op: Op): Promise<T> {
    return new Promise<T>((resolve) => {
      queue.push({ op, resolve: resolve as (value: unknown) => void })
      if (!flushing) {
        flushing = true
        setImmediate(flush)
      }
    })
  }

  function ready(): Promise<Hello | null> {
    if (!hello) {
      hello = call<Hello | null>(['hello']).then((h) => {
        if (h && typeof h.home === 'string') {
          status.hostname = h.hostname || null
          return h
        }
        hello = null
        return null
      })
    }
    return hello
  }

  function close(): void {
    closed = true
    queue.splice(0).forEach((p) => p.resolve(fallback(p.op)))
    if (child) fail('closed')
    status.state = 'idle'
    status.error = null
  }

  return { call, ready, close, status: (): Status => ({ ...status }) }
}

export type Connection = ReturnType<typeof createConnection>

export function remoteDeps(conn: Connection): Deps {
  return {
    run: (command, args, options) => conn.call<string | null>(['run', command, args, options?.anyExit === true]),
    read: (path) => conn.call<string>(['read', path]).then((v) => (typeof v === 'string' ? v : '')),
    list: (path) => conn.call<string[]>(['list', path]).then((v) => (Array.isArray(v) ? v : [])),
    readlink: (path) => conn.call<string | null>(['readlink', path]).then((v) => (typeof v === 'string' ? v : null))
  }
}

const LINUX_PROTECTED = /^(systemd|init|gnome-shell|Xorg|Xwayland|kwin_wayland|kwin_x11|plasmashell|gdm|gdm3|sddm|lightdm|dbus-daemon|dbus-broker|sshd|login)$/

export const NOT_CONNECTED = 'Not connected to the remote host'

// A Linux provider whose every read goes through the SSH connection. The inner Linux provider is
// rebuilt for each SSH session (each hello): what it caches (GPU kind, users, CPU ticks) may have
// been learned from placeholder answers while the old session died, and the agent's pids change.
export function createRemote(conn: Connection) {
  const deps = remoteDeps(conn)
  let inner: Provider | null = null
  let innerFor: Hello | null = null
  let home = '/'
  // Live list: the sampler keeps this array and sees the agent's pids once they are known.
  const self: number[] = []

  async function linux(): Promise<Provider> {
    const h = await conn.ready()
    if (!h) throw new Error(NOT_CONNECTED)
    if (!inner || innerFor !== h) {
      home = h.home
      self.splice(0, self.length, h.pid, h.ppid)
      inner = createLinux(deps, '', home)
      innerFor = h
    }
    return inner
  }

  // A failed op answers with an empty value, and the Linux provider would fill the gaps with this
  // computer's own memory. Refuse the whole reading instead.
  function live<T>(value: T): T {
    if (conn.status().state !== 'connected') throw new Error(NOT_CONNECTED)
    return value
  }

  const provider: Provider = {
    diskPath: '~',
    diskName: 'Home',
    countIrq: true,
    procEvery: 3000,
    detailsEvery: 8000,
    protectedNames: LINUX_PROTECTED,
    info: async () => (await linux()).info(),
    note: async () => null,
    read: async () => live(await (await linux()).read()),
    procs: async () => live(await (await linux()).procs()),
    details: async (energy) => live(await (await linux()).details(energy)),
    identify: async (pid): Promise<Identity | null> => (await linux()).identify(pid),
    cwds: async (pids) => (await linux()).cwds(pids),
    args: async (pids) => (await linux()).args(pids),
    quit: async (pid, force): Promise<QuitResult> => {
      if (self.includes(pid)) return { ok: false, reason: 'Not allowed' }
      const r = await conn.call<QuitResult | null>(['kill', pid, force])
      return r && typeof r.ok === 'boolean' ? r : { ok: false, reason: 'Could not quit it' }
    }
  }

  return {
    provider,
    cpus: async (): Promise<CpuTimes[]> => {
      const v = await conn.call<CpuTimes[]>(['cpus'])
      return live(Array.isArray(v) ? v : [])
    },
    space: async () => {
      await linux()
      return live(await conn.call<{ blocks: number; bsize: number; bavail: number; bfree: number } | null>(['statvfs', home]))
    },
    selfPids: self
  }
}
