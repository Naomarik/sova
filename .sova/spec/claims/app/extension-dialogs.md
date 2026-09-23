# §app/extension-dialogs — 06 · Extension dialogs (`ui_request`, optional in MVP)
> Part of the Sova design spec · [overview](../design/overview.md)

Use the same `.modal` shell, titled with the request's title.

| Request | Body | Foot |
|---|---|---|
| `confirm` | `.modal-body` shows the message | `.button-primary` with the request's confirm label, then the spacer, then a `Cancel` ghost |
| `select` | Options as a `.list` of `role="option"` rows | `Cancel` ghost only. Picking a row answers |
| `input` | A `.field` with a label | `Submit` primary and `Cancel` ghost |

`Esc` or Cancel sends `ui_response` with `value: null`. Dialogs never stack: a new request while
one is open queues behind it.

---

