# Sandbox policy (macOS)

**An agent cannot edit this file from inside the sandbox, by design. If you are an agent reading
this, ask the user to change it; do not try to work around it.**

There is no macOS backend yet. With the sandbox on, every sandboxed tool refuses ("no sandbox
backend for darwin"); it never runs unconfined. Turn the sandbox off to use the tools.

The keys are the same as on Linux (see `pi-config/sandbox-policy/linux/CLAUDE.md`), and this file
is validated the same way. Notes for a future Seatbelt backend (plan v2 §13): canonical paths
must account for `/private/tmp` and `/private/var` firmlinks; the session tmp is only reachable
through `TMPDIR`, not a literal `/tmp`; Seatbelt can filter network destinations natively, so the
proxy may run on the host with one loopback port instead of a relay; Keychain access is a service
to deny, alongside the credential files in `hidden`.
