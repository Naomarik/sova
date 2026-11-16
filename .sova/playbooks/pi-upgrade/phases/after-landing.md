# After landing

As soon as the merge queue reports the branch landed:

**The terminal pi** (if "Update the terminal pi too" is on). The terminal pi and Sova's chats share `pi-config/` through `~/.pi/agent`, so it moves now, not later:

```sh
cd ~                                   # outside any project's mise.toml
pi --version; command -v pi; mise current node
npm ls -g --depth=0 @earendil-works/pi-coding-agent      # is npm's global install the one answering?
npm install -g @earendil-works/pi-coding-agent@<new>
mise reshim
pi --version                           # must print <new>
```

- If another manager owns it, use that manager's install at `<new>`. Never `pi update` (it follows pi's newest, not Sova's pin), never `sudo`. Check `<new>`'s `engines.node` first.
- A sandboxed chat can't write the global prefix: put this exact block in your message for the user instead. Either way it isn't done until `pi --version` prints `<new>`.

**Your message**, in plain words:

- It's landed. The merge thread restarts Sova by itself once the queue is idle; you never restart it or ask for a restart.
- Running chats stay on the old code until they reload (`On older code`); Reload Now once the restart has happened. Reloads stop at the first chat that fails to start: that's a finding, and the user should tell you.
- The terminal pi is at `<new>`, or here is the block to run, and to quit and reopen any open terminal pi.
- Mesh peers keep their old pi until the new commit is deployed to them: name which.
- Going back is a new branch restoring the old pins, through the queue. Anything the new pi wrote into session files stays there.

Then delete `<W>`.
