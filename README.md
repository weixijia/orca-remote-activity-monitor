# Remote Activity Monitor

Watch a remote Linux machine from Orca's right sidebar: CPU cores, memory, network, disk, NVIDIA/AMD GPU and processes, sampled over SSH.

It is a fork of [Activity Monitor](https://github.com/aamonnaig4/orca-plugins/tree/main/plugins/activity-monitor) by aamonnaig4. Same panel, same graphs, same health strip; the readings come from another machine instead of the one Orca runs on.

**Why:** an Orca plugin's panel only shows in the Orca window of the host it is installed on. When your Mac's Orca is a client of a remote Orca server (or you just work on a GPU box over SSH), a local Activity Monitor shows the Mac, and one installed on the server shows only in the server's own window. This plugin runs on the client and reads the server.

## Set up

1. Make sure `ssh <host>` works from the Orca machine **without a password prompt** (a key in the agent, or `IdentityFile` in `~/.ssh/config`). The plugin runs ssh with `BatchMode=yes`, so it never asks.
2. The remote host needs Linux and `python3` (any 3.6+). Nothing is installed there.
3. Install the plugin, open **Settings → Plugins → Remote Activity Monitor** and set **SSH host** to what you would type after `ssh`: an alias from `~/.ssh/config` (`gpu-box`) or `user@hostname`.
4. Open the **Remote Activity Monitor** panel from the right sidebar. The line under the tabs shows which host you are looking at, or why it cannot connect.

Changing the host takes effect right away; the old SSH session is closed.

## How it reads the remote host

One persistent `ssh -T` session runs a small Python agent (inlined in `src/remote.ts`, sent as the remote command, never written to disk). The plugin sends it newline-delimited JSON requests: read a file, list a folder, read a symlink, run a command (`nvidia-smi`, `getconf`, `ps`), CPU times from `/proc/stat`, `statvfs`, or send a signal. Reads issued in the same tick share one request, so a full sample of `/proc` is a single round trip. Compression is on, which keeps the process list cheap.

If ssh exits or the host stops answering for 12 seconds, the panel shows the ssh error instead of zeros and the plugin reconnects after 5 seconds.

The host setting is checked before it reaches ssh (letters, digits and `._@:%+-`, not starting with `-`) and is passed after `--`, so it cannot become an ssh option.

## What's different from Activity Monitor

- **Remote only.** It always reads the configured SSH host, never the local machine. Install the original alongside it if you want both.
- **Linux hosts.** The remote side uses the Linux provider (`/proc`, `/sys`, `nvidia-smi`).
- **Disk** shows the remote user's home folder.
- **Quit** (× on a process row, and the Quit button in the health drawer) sends SIGTERM, or SIGKILL for Force quit, to the remote process as your SSH user. The identity check from the original still runs first (same name and start time), and the agent's own process and its SSH session cannot be quit.
- **What is this?** tells your agent the process is on the remote host and how to reach it.
- **Clean up is removed.** It launches an agent in a local workspace and judges processes by local paths, which doesn't carry over to another machine.
- Process details refresh every 8 seconds and the process list every 3 (4 and 2 in the original) to keep SSH traffic low.

Everything else (graphs, history, tabs, columns, health levels, Critical at, notifications) works as in the original; see its README.

## Permissions

It runs as a trusted worker because it starts `ssh`. It asks for:

- **Show notifications** (`notifications:show`): the desktop notification when the remote host's memory stays critical.
- **Read agents** (`agent:read`): lists your agents so **What is this?** can pick one.
- **Send to terminals** (`terminal:send`): types the **What is this?** question into that agent's terminal, only when you choose it.
- **Own storage** (`storage:own`) and **own settings** (`settings:own`): your panel preferences and the SSH host.

It connects only to the host you set, with your own SSH configuration and keys.

## Develop

```sh
orca plugin validate .
orca plugin dev watch .
orca plugin test .
```

`tests/remote.test.mjs` runs the real agent locally with `python3` in place of ssh.

## License

MIT, like the original. See `LICENSE`.
