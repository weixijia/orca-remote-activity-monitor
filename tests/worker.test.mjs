import test from 'node:test'
import assert from 'node:assert/strict'
import { mockHost, mountWorker } from 'orca/testing'
import * as main from '../src/worker.ts'
import { createSampler } from '../src/sampler.ts'

const START = 'Thu Nov 5 09:02:44 2026'

function stubProvider(over = {}) {
  return {
    diskPath: '~',
    diskName: 'Home',
    countIrq: true,
    procEvery: 0,
    protectedNames: /^(systemd)$/,
    info: async () => ({ performance: [], efficiency: [], model: '' }),
    note: async () => null,
    read: async () => ({ memory: { total: 100, used: 25, app: 25, wired: 0, compressed: 0, cached: 0 }, swap: null, pressure: null, net: null, disk: null, gpu: null }),
    procs: async () => [{ pid: 4242, ppid: 1, name: 'train.py', cpu: 0, mem: 10, start: START }],
    identify: async (pid) => (pid === 4242 ? { name: 'train.py', start: START } : null),
    quit: async () => ({ ok: true }),
    detailsEvery: 0,
    details: async () => null,
    cwds: async () => new Map(),
    args: async () => new Map(),
    ...over
  }
}

// A stand-in for the SSH connection: records ops and the hosts it was opened for.
function fakeRemote({ state = 'connected', error = null, runs = {} } = {}) {
  const down = state !== 'connected'
  const opened = []
  const closed = []
  const ops = []
  main.seams.connect = (host) => {
    opened.push(host)
    return {
      call: async (op) => {
        ops.push(op)
        return op[0] === 'run' ? runs[op[1]] ?? null : null
      },
      ready: async () => ({ pid: 1, ppid: 1, home: '/home/me', hostname: 'box', system: 'Linux' }),
      close: () => closed.push(host),
      status: () => ({ host, state, error, hostname: 'box' })
    }
  }
  const quits = []
  main.seams.sampler = () =>
    createSampler({
      provider: stubProvider({
        quit: async (pid, force) => { quits.push([pid, force]); return { ok: true } },
        read: down ? async () => { throw new Error('Not connected to the remote host') } : stubProvider().read
      }),
      cpus: async () => [{ user: 1, nice: 0, sys: 1, idle: 8, irq: 0 }],
      space: async () => null,
      selfPids: [],
      settle: 0
    })
  return { opened, closed, ops, quits }
}

const withHost = (host, over = {}) => mockHost({ settings: { host }, ...over })

test('without an SSH host the panel is told to set one and nothing connects to a real host', async () => {
  const fake = fakeRemote()
  const worker = await mountWorker(main, { host: mockHost() })
  await assert.rejects(worker.request('stats.read', { interval: 1000 }), /Set the SSH host in Settings/)
  assert.deepEqual(fake.opened, [''])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('stats.read samples the configured host and labels the sample with it', async () => {
  const fake = fakeRemote()
  const worker = await mountWorker(main, { host: withHost('gpu-box') })
  const out = await worker.request('stats.read', { interval: 1000 })
  assert.deepEqual(fake.opened, ['gpu-box'])
  assert.equal(out.remote.state, 'connected')
  assert.equal(out.sample.note, 'Remote: gpu-box (box)')
  assert.equal(out.sample.cores.length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
  assert.deepEqual(fake.closed, ['gpu-box'])
})

test('an unreachable host surfaces the ssh error instead of zeroed readings', async () => {
  fakeRemote({ state: 'error', error: 'ssh: connect to host gpu-box port 22: Connection refused' })
  const worker = await mountWorker(main, { host: withHost('gpu-box') })
  await assert.rejects(worker.request('stats.read', { interval: 1000 }), /Remote: gpu-box \(box\) · ssh: connect to host gpu-box port 22: Connection refused/)
  await worker.deactivate()
})

test('a host value that could pass ssh an option is ignored', async () => {
  const fake = fakeRemote()
  const worker = await mountWorker(main, { host: withHost('-oProxyCommand=touch /tmp/x') })
  await assert.rejects(worker.request('stats.read', { interval: 1000 }), /Set the SSH host/)
  assert.deepEqual(fake.opened, [''])
  await worker.deactivate()
})

test('process.quit goes through the remote provider after the identity check', async () => {
  const fake = fakeRemote()
  const worker = await mountWorker(main, { host: withHost('gpu-box') })
  const ok = await worker.request('process.quit', { pid: 4242, name: 'train.py', start: START })
  assert.deepEqual(ok, { ok: true })
  const changed = await worker.request('process.quit', { pid: 4242, name: 'other', start: START })
  assert.equal(changed.ok, false)
  assert.deepEqual(fake.quits, [[4242, false]])
  await worker.deactivate()
})

test('process.explain tells the agent the process is on the remote host', async () => {
  const fake = fakeRemote()
  const host = withHost('gpu-box', {
    results: {
      'agents.list': { agents: [{ terminalId: 't1', title: 'claude', agent: 'claude', state: 'done', stateStartedAt: 0 }] },
      'terminal.sendText': { accepted: true }
    }
  })
  const worker = await mountWorker(main, { host })
  const out = await worker.request('process.explain', { pid: 4242, name: 'python3', cpu: 50, mem: 1024 })
  assert.equal(out.ok, true)
  const sent = host.callsOf('terminal.sendText')[0]
  assert.match(sent.text, /^I saw a process in Activity Monitor on the remote Linux host `gpu-box` \(reach it with `ssh gpu-box`\)\. /)
  assert.deepEqual(fake.ops.at(-1), ['readlink', '/proc/4242/exe'])
  await worker.deactivate()
})

test('prefs.sync stores the footer critical percent and clamps it', async () => {
  fakeRemote()
  const host = withHost('gpu-box')
  const worker = await mountWorker(main, { host })
  await worker.request('prefs.sync', { record: false, critAt: 'nope' })
  assert.deepEqual(host.data().storage.prefs, { record: false, critAt: 95 })
  await worker.request('prefs.sync', { critAt: 150 })
  assert.equal(host.data().storage.prefs.critAt, 99)
  await worker.request('prefs.sync', { critAt: 10 })
  assert.equal(host.data().storage.prefs.critAt, 70)
  await worker.deactivate()
})

test('the status bar badge starts hidden and Orca refuses none of the calls', async () => {
  fakeRemote()
  const worker = await mountWorker(main, { host: withHost('gpu-box') })
  const updates = worker.host.callsOf('statusBar.update')
  assert.ok(updates.length >= 1)
  assert.equal(updates[0].id, 'health')
  assert.equal(updates[0].visible, false)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
