import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AGENT_PY, NOT_CONNECTED, createConnection, createRemote, sshArgs, validHost } from '../src/remote.ts'
import { createSampler } from '../src/sampler.ts'

// Runs the real agent locally with python3 in place of `ssh host python3 ...`.
function localAgent(spawned) {
  return (command, args) => {
    spawned.push([command, args])
    return spawn('python3', ['-u', '-c', AGENT_PY], { stdio: ['pipe', 'pipe', 'pipe'] })
  }
}

// A child process that never answers, or exits with a message on stderr.
function deadChild({ exitWith = null } = {}) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  if (exitWith) {
    setImmediate(() => {
      child.stderr.write(exitWith + '\n')
      setImmediate(() => child.emit('close', 255))
    })
  }
  return child
}

test('validHost accepts ssh aliases and user@host, and refuses anything ssh could read as an option', () => {
  for (const ok of ['uclic', 'simon@100.102.202.75', 'gpu-box.local', 'host_1', 'u@fe80::1%en0']) assert.equal(validHost(ok), true, ok)
  for (const bad of ['', '-oProxyCommand=x', 'a b', 'a;b', 'a$(x)', '`x`', 'a\nb', '.hidden', 'x@-oFoo', '-x@host', 'a@b@c', 'a+b']) assert.equal(validHost(bad), false, bad)
})

test('sshArgs never lets a host be parsed as an option and runs the agent non-interactively', () => {
  const args = sshArgs('uclic')
  const dash = args.indexOf('--')
  assert.ok(dash > 0)
  assert.equal(args[dash + 1], 'uclic')
  assert.ok(args.includes('BatchMode=yes'))
  assert.match(args[dash + 2], /^python3 -u -c "import base64;exec\(base64\.b64decode\('[A-Za-z0-9+/=]+'\)\)"$/)
})

test('the agent answers read, list, readlink, run, statvfs and hello in one request', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ram-'))
  writeFileSync(path.join(dir, 'a.txt'), 'hello\n')
  mkdirSync(path.join(dir, 'sub'))
  symlinkSync('/target/path', path.join(dir, 'link'))
  const spawned = []
  const conn = createConnection('box', { spawn: localAgent(spawned) })
  const [read, missing, list, link, echo, fails, failsAny, vfs, hello] = await Promise.all([
    conn.call(['read', path.join(dir, 'a.txt')]),
    conn.call(['read', path.join(dir, 'nope')]),
    conn.call(['list', dir]),
    conn.call(['readlink', path.join(dir, 'link')]),
    conn.call(['run', 'echo', ['hi'], false]),
    conn.call(['run', 'sh', ['-c', 'echo out; exit 3'], false]),
    conn.call(['run', 'sh', ['-c', 'echo out; exit 3'], true]),
    conn.call(['statvfs', dir]),
    conn.call(['hello'])
  ])
  assert.equal(spawned.length, 1)
  assert.equal(read, 'hello\n')
  assert.equal(missing, '')
  assert.deepEqual(list.sort(), ['a.txt', 'link', 'sub'])
  assert.equal(link, '/target/path')
  assert.equal(echo, 'hi\n')
  assert.equal(fails, null)
  assert.equal(failsAny, 'out\n')
  assert.ok(vfs.blocks > 0 && vfs.bsize > 0)
  assert.equal(typeof hello.pid, 'number')
  assert.equal(conn.status().state, 'connected')
  conn.close()
})

test('ops issued in the same tick share one request line', async () => {
  const writes = []
  const conn = createConnection('box', {
    spawn: () => {
      const child = deadChild()
      child.stdin.on('data', (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          const req = JSON.parse(line)
          writes.push(req)
          child.stdout.write(JSON.stringify({ i: req.i, r: req.o.map((op) => op[1]) }) + '\n')
        }
      })
      return child
    }
  })
  const results = await Promise.all(['/a', '/b', '/c'].map((p) => conn.call(['read', p])))
  assert.deepEqual(results, ['/a', '/b', '/c'])
  assert.equal(writes.length, 1)
  assert.equal(writes[0].o.length, 3)
  await conn.call(['read', '/d'])
  assert.equal(writes.length, 2)
  conn.close()
})

test('when ssh exits, pending ops get empty values and the status carries the ssh error', async () => {
  const conn = createConnection('box', { spawn: () => deadChild({ exitWith: 'Permission denied (publickey).' }), retryMs: 60000 })
  const [read, list, kill] = await Promise.all([conn.call(['read', '/proc/meminfo']), conn.call(['list', '/proc']), conn.call(['kill', 5, false])])
  assert.equal(read, '')
  assert.deepEqual(list, [])
  assert.equal(kill.ok, false)
  assert.deepEqual(conn.status(), { host: 'box', state: 'error', error: 'Permission denied (publickey).', hostname: null })
  conn.close()
})

test('a failed host is retried only after the back-off', async () => {
  let spawns = 0
  const conn = createConnection('box', { spawn: () => { spawns++; return deadChild({ exitWith: 'down' }) }, retryMs: 50 })
  await conn.call(['read', '/x'])
  await conn.call(['read', '/x'])
  assert.equal(spawns, 1)
  await new Promise((resolve) => setTimeout(resolve, 60))
  await conn.call(['read', '/x'])
  assert.equal(spawns, 2)
  conn.close()
})

test('a host that stops answering times out instead of hanging the panel', async () => {
  const conn = createConnection('box', { spawn: () => deadChild(), timeoutMs: 30, connectTimeoutMs: 30 })
  assert.equal(await conn.call(['read', '/x']), '')
  assert.equal(conn.status().error, 'The remote host stopped answering')
  conn.close()
})

test('the remote provider refuses to quit its own agent and its ssh session', async () => {
  const conn = createConnection('box', { spawn: localAgent([]) })
  const remote = createRemote(conn)
  await remote.provider.info()
  assert.equal(remote.selfPids.length, 2)
  for (const pid of remote.selfPids) assert.deepEqual(await remote.provider.quit(pid, true), { ok: false, reason: 'Not allowed' })
  conn.close()
})

test('only the batch the agent is working on is timed, so a queue behind a slow one survives', async () => {
  let child
  const conn = createConnection('box', {
    timeoutMs: 80,
    connectTimeoutMs: 80,
    spawn: () => {
      child = deadChild()
      child.stdin.on('data', (chunk) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          const req = JSON.parse(line)
          // Each batch takes 50 ms, one after another, like the single-threaded agent.
          setTimeout(() => child.stdout.write(JSON.stringify({ i: req.i, r: req.o.map(() => 'ok') }) + '\n'), 50 * req.i)
        }
      })
      return child
    }
  })
  const first = conn.call(['read', '/a'])
  await new Promise((resolve) => setImmediate(resolve))
  const second = conn.call(['read', '/b'])
  await new Promise((resolve) => setImmediate(resolve))
  const third = conn.call(['read', '/c'])
  assert.deepEqual(await Promise.all([first, second, third]), ['ok', 'ok', 'ok'])
  assert.equal(conn.status().state, 'connected')
  conn.close()
})

test('while disconnected the remote provider refuses to read instead of reporting this computer', async () => {
  const conn = createConnection('box', { spawn: () => deadChild({ exitWith: 'Connection refused' }), retryMs: 60000 })
  const remote = createRemote(conn)
  await assert.rejects(remote.provider.read(), new RegExp(NOT_CONNECTED))
  await assert.rejects(remote.cpus(), new RegExp(NOT_CONNECTED))
  const sampler = createSampler({ provider: remote.provider, cpus: remote.cpus, space: remote.space, selfPids: remote.selfPids, localPids: [], settle: 0 })
  await assert.rejects(sampler.read({ interval: 1000 }))
  assert.equal(sampler.health().level, 'ok')
  conn.close()
})

test('a new SSH session rebuilds the Linux provider and protects the new agent pids', async () => {
  const conn = createConnection('box', { spawn: localAgent([]), retryMs: 0 })
  const remote = createRemote(conn)
  await remote.provider.info()
  const before = [...remote.selfPids]
  conn.call(['read', '/x'])
  // Kill the agent from outside, as a dropped network would.
  process.kill(before[0], 'SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 200))
  await remote.provider.info()
  assert.notDeepEqual(remote.selfPids, before)
  for (const pid of remote.selfPids) assert.deepEqual(await remote.provider.quit(pid, true), { ok: false, reason: 'Not allowed' })
  conn.close()
})
