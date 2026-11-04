# models: which models you can use, what new chats start on, and the sign-ins behind them

<!-- Ids are shared/sova-settings-reference.ts's. Live lines for custom providers and sign-ins: lab-yours ran them at 89393237c. -->
Which models a worker runs on is `workers`. Here is what may be used at all, and what signs in. A card's edit is `{setting: "sova", id, value}`; call `sova_settings` `reference` with the id for the exact value. A value is the whole setting, so read the current one with `get` first.

Sign-ins never pass through you: name the screen or the command, and the person does it.

## Which models may be used

- Change: providers and models switched off for everyone, or only for workers.
- Lives: `<agent dir>/model-policy.json`.
- Approves: the person, by Apply or Save Changes.
- By: Card or Screen. Card `models.policy`, whose turning a model back on needs Apply and Approve. Screen: Settings → Models, Enabled for everyone, Subagents for workers.
- Live: next turn, and next worker. A chat already on a model that's turned off is refused at its next turn and asked to pick another; nothing is swapped silently. Reaches their other computers with sync on.
- Check: the model is gone from the picker, or a worker can't be started on it.

## Requests at once

- Change: how many requests this computer sends a provider at the same time, 1 to 999.
- Lives: `<agent dir>/provider-limits.json`.
- Approves: the person, by Apply or Save Changes.
- By: Card or Screen. Card `models.limits`. Screen: Settings → Models, each provider's At once field.
- Live: next request. Each computer counts its own requests; the numbers reach their other computers with sync on.
- Check: the field shows the number after Save.

## Favourites

- Change: which models are starred in the model picker.
- Lives: `<agent dir>/model-favorites.json`.
- Approves: the person, by clicking.
- By: Screen. The star on a model in the picker.
- Live: now. Reaches their other computers with sync on.
- Check: the star stays lit when the picker reopens.

## What a new chat starts on

- Change: the model and thinking level a new chat starts with.
- Lives: `<agent dir>/sova/defaults.json`.
- Approves: the person, by Apply or by choosing.
- By: Card or Screen. Card `models.default`. Screen: open a new chat and change its model or thinking before the first message: Sova saves that as the default.
- Live: new chat. Reaches their other computers with sync on.
- Check: start another new chat and read its model.

## Claude logins

- Change: which Claude subscriptions Sova uses, their order, and failover when one hits its limit.
- Lives: Settings → Accounts. Credentials are out of your reach.
- Approves: the person, who signs in.
- By: Screen. Settings → Accounts.
- Live: new chat. An open chat never changes login silently.
- Check: the login reads as signed in under Settings → Accounts.

## A project's or organization's Claude login

- Change: which login a project's chats, or an organization's, are billed to.
- Lives: this computer's Sova state. It doesn't spread.
- Approves: the person, by choosing.
- By: Screen. The Settings tab of the project's page, or of the organization.
- Live: new chat. Open chats keep their login.
- Check: the tab shows the login after the change.

## Other providers' sign-ins

- Change: signing in to a provider other than Claude.
- Lives: pi's own credential store, which you never read.
- Approves: the person, who signs in.
- By: Terminal. They open pi, type `/login` and choose the provider. Sova has no screen for this. With no `pi` on their PATH, it's `node_modules/.bin/pi` in Sova's install folder, by default `~/.local/share/sova`.
- Live: now, in the picker of any chat, open chats included.
- Check: the provider's models show in the picker.

## Custom providers and models

- Change: a local server such as Ollama or LM Studio, or any endpoint speaking an API pi knows.
- Lives: `<agent dir>/models.json`. On some installs this is a link into Sova's own folder: a card refuses that, and you never touch it: offer a provider add-on in the person's own folder instead (`pi-extensions`), which also needs a restart.
- Approves: the person, by Apply.
- By: Card `models.providers`, holding the whole file. Its turning on needs Apply and Approve. A card refuses a key: for an endpoint that needs one, write `"apiKey": "$NAME"` and have the person set that environment variable. A local server that ignores the key takes a plain capital word.
- Live: restart. Promise the model only after Sova restarts: until then the person may not be able to pick it, and an open chat refuses it. A chat's `/reload` does nothing here. Say this before their Apply.
- Check: after the restart, find the model in a new chat's picker.

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "LOCAL",
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

## Image fallback

- Change: which small models describe images for a chat whose model can't see them.
- Lives: `<agent dir>/vision-delegate.json`, with the same rule about links as above. A card refuses a link, and there's no other way on that install.
- Approves: the person, by Apply.
- By: Card `models.image-fallback`. `fallbacks` is an ordered list of `provider/model`; `exhaustedAbovePct` skips a provider past that share of its usage; `contextChars` is how much conversation goes with the image.
- Live: new chat.
- Check: attach an image in a new chat on a model that can't see, and read the description it gets.

## pi's own defaults

- Change: pi's default provider, model and thinking level, which a chat falls back on when Sova has no default of its own. For what new chats start on, use the section above.
- Lives: `defaultProvider`, `defaultModel` and `defaultThinkingLevel` in `<agent dir>/settings.json`.
- Approves: the person, by Apply.
- By: Card `models.pi-defaults`. Packages and add-ons in that file stay out of a card.
- Live: new chat. It stays on this computer.
- Check: `sova_settings` `get` and the file show the value.
