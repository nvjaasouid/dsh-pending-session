# dsh-pending-session

Keep unsent chat drafts in the sidebar.

Type something in a new session, then go look at another conversation — natively that session is treated as blank and hidden. This plugin keeps it as a **Pending** entry in the sidebar instead. Click it to keep writing; send it and it becomes a normal conversation.

![Pending entry](docs/pending-row.png)

## What you can do with a pending entry

- **Keep editing** — clicking it opens the native composer with your text and attachments restored
- **Rename** — the row menu's Rename, or double-click the title
- **Archive** — it leaves the sidebar but is *not* deleted; find it again under archived sessions
- **Delete** — a real delete: the conversation history is removed and **cannot be recovered**. Sessions that are still running cannot be deleted
- **Send** — it stops being pending, becomes a normal conversation, and moves to the top by send time

## Behaviour notes

- Multiple pending entries can coexist; they never affect each other or normal conversations
- Entries sort together with normal conversations by the last send time. A pending entry's time is **its creation time** — editing the draft does not change its time or position
- Only blank sessions with a draft (text or attachments) become pending; sessions that already have messages are untouched
- Drafts and attachments are stored locally and survive a restart

## Install

Install by name from the dsh plugin manager (Settings → Plugins):

```
dsh-pending-session
```

Or with a package manager inside the profile directory:

```sh
pnpm add dsh-pending-session
```

Restart dsh once after installing (the host half loads at startup).

## Uninstall

Disable or remove it in the plugin manager. Existing conversations and archived records are not affected; the sidebar returns to its native look.

## Safety and data

The plugin adds a **Delete conversation** item to every session row's “…” menu, and that delete is permanent (session log, projection cache and workspace accounting are all removed):

- A session whose agent is still running cannot be deleted
- Archive and delete are different things: archiving only hides the session and is reversible
- Clearing a draft back to blank and leaving removes the entry (archived only, no data loss)

Deletion is handled by the plugin's own host endpoint; when that endpoint is unavailable it falls back to the system's native archive.

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

Local development: the browser half (client.js) hot-reloads when copied into the profile's `node_modules`; the **host half (index.js) requires a dsh restart**.

## License

MIT
