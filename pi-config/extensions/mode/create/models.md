# models: which models you can use, what new chats start on, and the sign-ins behind them

<!-- Screen items become "Card or Screen" when cards' Sova-wide list arrives. models.json timing awaits lab-yours. -->
Which models a worker runs on is `workers`. Here is what may be used at all, and what signs in.

Sign-ins never pass through you: name the screen or the command, and the person does it.

## Which models may be used

- Change: providers and models switched off for everyone, or only for workers.
- Lives: `<agent dir>/model-policy.json`.
- Approves: the person, by Save Changes.
- By: Screen. Settings → Models: Enabled for everyone, Subagents for workers.
- Live: next turn, and next worker. A chat already on a model that's turned off is refused at its next turn and asked to pick another; nothing is swapped silently. Reaches their other computers with sync on.
- Check: the model is gone from the picker, or a worker can't be started on it.

## Requests at once

- Change: how many requests this computer sends a provider at the same time, 1 to 999.
- Lives: `<agent dir>/provider-limits.json`.
- Approves: the person, by Save Changes.
- By: Screen. Settings → Models, each provider's At once field.
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
- Approves: the person, by choosing.
- By: Screen. Open a new chat and change its model or thinking before the first message: Sova saves that as the default. There's no separate setting.
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
- Live: new chat.
- Check: the provider's models show in the picker of a new chat.

## Custom providers and models

- Change: a local server such as Ollama or LM Studio, or any endpoint speaking an API pi knows.
- Lives: `<agent dir>/models.json`. On some installs this is a link into Sova's own folder: resolve it before anything else. If it is, don't touch it: offer a provider add-on in the person's own folder instead (`pi-extensions`).
- Approves: the person, by Apply.
- By: Card. Never carries a key: use a `$NAME` value naming an environment variable, and a dummy value for a local server that ignores it.
- Live: new chat.
- Check: start a new chat and find the model in its picker.

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

## Image fallback

- Change: which small models describe images for a chat whose model can't see them.
- Lives: `<agent dir>/vision-delegate.json`, with the same rule about links as above.
- Approves: the person, by Apply.
- By: Card. `fallbacks` is an ordered list of `provider/model`; `exhaustedAbovePct` skips a provider past that share of its usage; `contextChars` is how much conversation goes with the image.
- Live: new chat.
- Check: attach an image in a new chat on a model that can't see, and read the description it gets.
