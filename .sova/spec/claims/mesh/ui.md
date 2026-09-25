# §mesh/ui — Mesh card, page and settings
> Part of the Sova design spec · [overview](../design/overview.md)

The mesh is part of Sova, not an installable extension, but it looks and navigates like one.

## §mesh.ui/card — The Mesh card

The home page shows a Mesh card in its own section above Extensions, styled like an extension
card, whether or not the mesh is on. It opens `#/mesh`.

## §mesh.ui/page — The Mesh page

`#/mesh` is a full page: this host and each peer with its status, adding and removing peers
(editing `peers.json`), discovery hints, sync status per category, and setup instructions for a
host with no peers.

## §mesh.ui/settings — Settings → Mesh

Settings has a Mesh section: this host's name, a toggle per sync category (settings, themes,
extensions, logins), under Logins a "Sync subscriptions to this host" switch that turns API-keys-only
mode on or off (§mesh.sync/api-keys-only), and the front-door address. The switch shows only while
the mesh and login sync are on.
