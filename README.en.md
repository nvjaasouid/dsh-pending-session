# dsh-pending-session

code by: V41-Flash  
token by: 我自己(  
另外感谢ds崩溃梁圣用50返50🙏

**Keep unsent chat drafts in the sidebar**

![Example 1](docs/image-2-1.png)
![Example 2](docs/image-3-1.png)

> [!WARNING]
> Besides keeping drafts, this plugin adds a **Delete conversation** action to **every session row**: it permanently removes the session log, the projection cache and the workspace accounting — **it cannot be undone** (this is not archiving). See “Safety and data” below.

## Core features

When you have typed something into a session but have not sent it yet, and then open another conversation or start a new one, that session is no longer hidden: it stays in the sidebar as an entry named **Pending**, side by side with your normal conversations.

Click a pending entry and send, and it becomes a normal conversation.  
A pending draft that is cleared down to whitespace and then left behind is collected automatically.

Several pending entries can coexist.  
Pending entries never affect each other or your normal conversations.

Everything sorts by time:

- Pending entries by their creation time
- Normal conversations by the last time you sent a message to dsh
- Editing a draft does not change a pending entry's position

Pending entries are stored locally and survive a dsh restart.

## What you can do with a pending entry

At any time you can:

- **Edit**
- **Rename**
- **Archive**
- **Delete** (from the session row's “…” menu; multi-select delete from dsh-session-archive is not supported yet)
- **Send**

## Install / Uninstall

**Install** (either way):

```sh
# 1) By name, from dsh's plugin manager (Settings → Plugins)
dsh-pending-session
```

```sh
# 2) With a package manager inside the profile directory
pnpm add dsh-pending-session
```

> [!IMPORTANT]
> Restart dsh once after installing — the host half loads at startup, and without a restart the delete feature does not work.

**Uninstall**:

```sh
# Disable / remove it in the plugin manager, or:
pnpm remove dsh-pending-session
```

Existing conversations and archived records are unaffected; the sidebar returns to its native look.

## Safety and data

> [!CAUTION]
> ### ⚠️ Delete means real deletion, **and it cannot be undone**
> This plugin adds a **Delete conversation** item to the “…” menu of **every session row (not just pending ones)**.
> It wipes the **session log, projection cache and workspace accounting** — that is not archiving, and it cannot be recovered.

- 🚫 **A session that is still running (agent still producing output) cannot be deleted**
- 📦 **Archive ≠ delete**: archiving only hides a session from the sidebar, and you can find it again under archived sessions
- 🧹 Clearing a draft down to whitespace and leaving collects the entry (archived only, no data loss)
- 🛡️ Deletion is done by the plugin's own host endpoint; **when that endpoint is unavailable it falls back to dsh's native archive** instead of deleting

## FAQ

See [FAQ.md](FAQ.md) (Chinese).

## Development

```
client.js          browser half (UI, draft mirror, sidebar projection, delete flow)
index.js           host half (delete endpoint: session storage + workspace accounting)
cordis.patch.yml   bundle row declaration
tests/sim.mjs      simulation tests
```

Run the tests:

```sh
npm test        # same as: node tests/sim.mjs
```

Local development: the browser half (client.js) hot-reloads when copied into the profile's `node_modules`; a change to the host half (index.js) requires a dsh restart.

## License

MIT © 2026 nvjaasouid
