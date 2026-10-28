// Generated from shared/commands-catalog.ts by scripts/card-toolkit-types.mjs: never edit by hand.
// shared/card-toolkit-types.test.ts fails when this file and the catalogue drift.

/** Every Sova command a card view can run, by its catalogue id: each, reads included, once the card's owner is trusted. */
export type CommandId =
  | "session.list"
  | "session.get"
  | "session.read"
  | "session.create"
  | "session.title.set"
  | "session.title.reset"
  | "session.tags.set"
  | "session.archive"
  | "session.unarchive"
  | "session.configure"
  | "session.mode.get"
  | "session.mode.set"
  | "session.send"
  | "session.fork"
  | "session.draft.get"
  | "session.draft.set"
  | "session.sandbox.set"
  | "session.tools.get"
  | "session.align.triage"
  | "session.workers.checks"
  | "session.context"
  | "session.context.file"
  | "session.group.list"
  | "session.group.create"
  | "session.group.rename"
  | "session.group.delete"
  | "session.group.assign"
  | "session.group.send"
  | "session.insights"
  | "worker.resume"
  | "session.offers.get"
  | "session.offers.show"
  | "session.offers.choose"
  | "session.offers.snooze"
  | "session.offers.unsnooze"
  | "session.card.post"
  | "session.card.get"
  | "session.card.answer"
  | "project.verb.create"
  | "project.verb.up"
  | "project.verb.down"
  | "project.verb.apply"
  | "project.verb.status"
  | "project.verb.logs"
  | "project.verb.reset"
  | "project.verb.teardown"
  | "project.verb.doctor"
  | "project.verb.conform"
  | "project.verb.test"
  | "project.verb.share"
  | "project.verb.revoke"
  | "project.verb.deploy.check"
  | "project.verb.deploy.plan"
  | "project.verb.deploy.run"
  | "project.verb.deploy.status"
  | "project.verb.deploy.logs"
  | "project.verb.deploy.rollback"
  | "project.verb.deploy.request"
  | "project.services.view"
  | "project.overseer.idea.list"
  | "project.overseer.idea.get"
  | "project.overseer.idea.add"
  | "project.overseer.idea.update"
  | "project.overseer.todo.list"
  | "project.overseer.todo.add"
  | "project.overseer.todo.update"
  | "project.overseer.todo.remove"
  | "project.overseer.todo.reorder"
  | "project.overseer.todo.clear-done"
  | "project.list"
  | "project.get"
  | "project.create"
  | "project.update"
  | "project.claude-login.get"
  | "project.claude-login.set"
  | "project.archive"
  | "project.unarchive"
  | "project.preview.off"
  | "project.worktree.list"
  | "project.worktree.merge"
  | "project.worktree.remove"
  | "project.files.list"
  | "project.offers.list"
  | "project.cards.list"
  | "project.settings.get"
  | "project.settings.history"
  | "project.settings.undo"
  | "project.settings.propose.withdraw"
  | "project.overseer.settings.set"
  | "project.costs"
  | "overseer.attention"
  | "overseer.todo.list"
  | "overseer.todo.add"
  | "overseer.todo.update"
  | "overseer.todo.remove"
  | "overseer.todo.reorder"
  | "overseer.todo.clear-done"
  | "overseer.idea.list"
  | "overseer.idea.get"
  | "overseer.idea.update"
  | "overseer.notes.get"
  | "overseer.notes.set"
  | "models.list"
  | "extensions.list"
  | "targets.list"
  | "folders.list"
  | "cwds.list"
  | "files.list"
  | "models.favorite"
  | "usage.costs"
  | "usage.performance"
  | "usage.today"
  | "usage.session"
  | "usage.sessions"
  | "usage.prices"
  | "usage.prices.refresh"
  | "insights.usage"
  | "insights.usage.history"
  | "insights.agents"
  | "insights.worktrees"
  | "insights.session.workers"
  | "insights.session.inbox"
  | "sova.health"
  | "settings.sova.get"
  | "settings.models.get"
  | "settings.provider-limits.get"
  | "settings.align.get"
  | "settings.delegate.get"
  | "settings.spec.get"
  | "settings.team.get"
  | "settings.summarizer.get"
  | "settings.overseer.get"
  | "settings.memory.get"
  | "settings.subagents.get"
  | "settings.align.set"
  | "settings.assistant-default.set"
  | "push.test"
  | "audit.list"
  | "org.owner.request.chat"
  | "org.owner.request.done"
  | "org.owner.request.decline"
  | "org.owner.request.noted"
  | "org.project.versions"
  | "org.project.version.rewrite"
  | "org.project.version.automatic"
  | "org.project.version.hide"
  | "org.project.version.show"
  | "org.claude-login.get"
  | "org.claude-login.set"
  | "chat.stop"
  | "chat.compact"
  | "chat.rewind"
  | "chat.regenerate"
  | "chat.queue.remove"
  | "chat.reload-code"
  | "chat.mode-command";

/** Each command's params, as its catalogue entry declares them. */
export interface CommandParams {
  /** Every session this server lists, with its title, state and marks. (only looks; needs the card's owner trusted) */
  "session.list": Record<string, never>;
  /** One session's summary, listed or not. (only looks; needs the card's owner trusted) */
  "session.get": {
    /** The session, by id or by path */
    "session"?: string;
  };
  /** A session's transcript, its active branch. (only looks; needs the card's owner trusted) */
  "session.read": {
    /** The session, by id or by path */
    "session"?: string;
  };
  /** A new empty session in a folder, optionally with a profile and a first message. (changes something; needs the card's owner trusted) */
  "session.create": {
    /** The folder it works in (an existing absolute directory) */
    "cwd": string;
    /** A profile id to start it with */
    "profile"?: string;
    /** Its first message (with a profile) */
    "prompt"?: string;
  };
  /** Give a session a title, in Sova only; its file is never written. (changes something; needs the card's owner trusted) */
  "session.title.set": {
    /** The session, by id or by path */
    "session"?: string;
    /** The new title */
    "title": string;
  };
  /** Clear a session's title, so its derived title shows again. (changes something; needs the card's owner trusted) */
  "session.title.reset": {
    /** The session, by id or by path */
    "session"?: string;
  };
  /** Replace a session's own tags, or clear them with null. (changes something; needs the card's owner trusted) */
  "session.tags.set": {
    /** The session, by id or by path */
    "session"?: string;
    /** The tags, comma-separated */
    "tags": string[] | null;
  };
  /** Move a session started in Sova to the archive. (changes something; needs the card's owner trusted) */
  "session.archive": {
    /** The session, by id or by path */
    "session"?: string;
  };
  /** Bring an archived session back to the top region. (changes something; needs the card's owner trusted) */
  "session.unarchive": {
    /** The session, by id or by path */
    "session"?: string;
  };
  /** Set one session's model, thinking, mode or minor modes, never the default. (changes something; needs the card's owner trusted) */
  "session.configure": {
    /** The session, by id or by path */
    "session"?: string;
    /** A model ref "provider/model" */
    "model"?: string;
    /** A thinking level */
    "thinking"?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    /** A mode */
    "mode"?: string;
    /** Minor modes, comma-separated */
    "minor-modes"?: string[];
  };
  /** A held chat's own mode and minor modes. (only looks; needs the card's owner trusted) */
  "session.mode.get": {
    /** The session, by id or by path */
    "session"?: string;
  };
  /** Switch a held chat's mode or minor modes, from its next message. (changes something; needs the card's owner trusted) */
  "session.mode.set": {
    /** The session, by id or by path */
    "session"?: string;
    /** A mode */
    "mode"?: string;
    /** Minor modes, comma-separated */
    "minor-modes"?: string[];
  };
  /** Send one message to a session, as its composer does. (changes something; needs the card's owner trusted) */
  "session.send": {
    /** The session, by id or by path */
    "session"?: string;
    /** The message */
    "text": string;
    /** Mid-turn: queued after the turn, or steered into it */
    "delivery"?: "followUp" | "steer";
  };
  /** A new session holding a session's conversation up to one of its entries. (changes something; needs the card's owner trusted) */
  "session.fork": {
    /** The session, by id or by path */
    "session"?: string;
    /** The entry id it forks at */
    "entry": string;
  };
  /** A session's composer draft, as Sova keeps it beside the session. (only looks; needs the card's owner trusted) */
  "session.draft.get": {
    /** The session, by id or by path */
    "session"?: string;
  };
  /** Replace a session's composer draft; its file is never written. (changes something; needs the card's owner trusted) */
  "session.draft.set": {
    /** The session, by id or by path */
    "session"?: string;
    /** The draft's text */
    "text": string;
    /** The draft's attachments, an array */
    "attachments"?: unknown;
  };
  /** Set a held chat's sandbox state, through the sandbox extension's own command. (changes something; needs the card's owner trusted) */
  "session.sandbox.set": {
    /** The session, by id or by path */
    "session"?: string;
    /** The sandbox state */
    "state": "off" | "subagents" | "on";
  };
  /** The tools a held chat declares to its model now. (only looks; needs the card's owner trusted) */
  "session.tools.get": {
    /** The session, by id or by path */
    "session"?: string;
  };
  /** Each open alignment question's stakes as Jev or the configured model guessed them: low risk, or deletes data, costs money or changes architecture. (only looks; needs the card's owner trusted) */
  "session.align.triage": {
    /** The session, by id or by path */
    "session"?: string;
  };
  /** Whether each worker's newest done report says it ran its tests or checks, as Jev or the configured model guessed it. (only looks; needs the card's owner trusted) */
  "session.workers.checks": {
    /** The session, by id or by path */
    "session"?: string;
  };
  /** What pi loads for a session's folder: its context files and skills, with their sizes. (only looks; needs the card's owner trusted) */
  "session.context": {
    /** The session, by id or by path */
    "session"?: string;
  };
  /** The text of one context file or skill a session's setup lists; no other file. (only looks; needs the card's owner trusted) */
  "session.context.file": {
    /** The session, by id or by path */
    "session"?: string;
    /** A path the session's setup lists (a context file, SKILL.md, SYSTEM.md or APPEND_SYSTEM.md) */
    "file": string;
  };
  /** The sidebar's session groups and their members. (only looks; needs the card's owner trusted) */
  "session.group.list": Record<string, never>;
  /** Make an empty session group. (changes something; needs the card's owner trusted) */
  "session.group.create": {
    /** The group's name */
    "name": string;
  };
  /** Give a session group a new name. (changes something; needs the card's owner trusted) */
  "session.group.rename": {
    /** The group's id */
    "group": string;
    /** The new name */
    "name": string;
  };
  /** Delete a session group; its sessions stay. (changes something; needs the card's owner trusted) */
  "session.group.delete": {
    /** The group's id */
    "group": string;
  };
  /** Put a session in a group, or take it out with null. (changes something; needs the card's owner trusted) */
  "session.group.assign": {
    /** The session, by id or by path */
    "session"?: string;
    /** The group's id, or null to take it out */
    "group": string | null;
    /** Its label in the group */
    "label"?: string | null;
    /** Where in the group's order it lands */
    "index"?: number;
  };
  /** One message to a group's sessions, all or none. (changes something; needs the card's owner trusted) */
  "session.group.send": {
    /** The group's id */
    "group": string;
    /** The message */
    "text": string;
    /** Only these members (session ids), comma-separated */
    "members"?: string[];
  };
  /** One session's insight, as its pane reads it. (only looks; needs the card's owner trusted) */
  "session.insights": {
    /** The session, by id or by path */
    "session"?: string;
  };
  /** Resume one restored subagent worker of a held chat, idle. (changes something; needs the card's owner trusted) */
  "worker.resume": {
    /** The session, by id or by path */
    "session"?: string;
    /** The worker's id, like ag_03 */
    "worker": string;
  };
  /** A session's offer cards, open and answered, and the offers it set to Not Now. (only looks; needs the card's owner trusted) */
  "session.offers.get": {
    /** The session, by id or by path */
    "session"?: string;
  };
  /** Show one of the project's offers in a session, from another chat (its from). (changes something; needs the card's owner trusted) */
  "session.offers.show": {
    /** The session, by id or by path */
    "session"?: string;
    /** The offer's name in the project's .sova/offers.json */
    "offer": string;
    /** One short sentence under its title */
    "note"?: string;
    /** The session that shows it, by id or path (needed by a button that sends to it) */
    "from"?: string;
    /** For an offer that declares rows: [{label, values}], one per item */
    "rows"?: unknown;
  };
  /** Click one of an open offer card's buttons: send its text, or run its action; on a rows card, one row's, or the all button. (changes something; needs the card's owner trusted) */
  "session.offers.choose": {
    /** The session, by id or by path */
    "session"?: string;
    /** The card, like of_3 */
    "card": string;
    /** The button's number, from 0 (not with all) */
    "button"?: number;
    /** On a rows card: the row, like r_2 */
    "row"?: string;
    /** On a rows card: the all button, with the row ids its confirm named, like ["r_1","r_2"] */
    "all"?: unknown;
  };
  /** Hide an offer for the rest of a session (its open card reads Not now). (changes something; needs the card's owner trusted) */
  "session.offers.snooze": {
    /** The session, by id or by path */
    "session"?: string;
    /** The offer's name */
    "offer": string;
  };
  /** Let a session show an offer it set to Not Now again. (changes something; needs the card's owner trusted) */
  "session.offers.unsnooze": {
    /** The session, by id or by path */
    "session"?: string;
    /** The offer's name */
    "offer": string;
  };
  /** Raise one of a session's transcript card types with its data, or give an open card new data or mark it done (its card). (changes something; needs the card's owner trusted) */
  "session.card.post": {
    /** The session, by id or by path */
    "session"?: string;
    /** The card type, like project.deploy (not with card) */
    "type"?: string;
    /** The card's data, in its type's shape */
    "data"?: unknown;
    /** A follow type's key: the same key raises its next revision */
    "key"?: string;
    /** An open card, like cd_3: new data for it, or done */
    "card"?: string;
    /** With card: mark it done */
    "done"?: boolean;
  };
  /** A session's transcript cards, their data and their answers, and the card types it may raise. (only looks; needs the card's owner trusted) */
  "session.card.get": {
    /** The session, by id or by path */
    "session"?: string;
  };
  /** Answer an open transcript card as a press on it would: {option}, {button} or {items}. (changes something; needs the card's owner trusted) */
  "session.card.answer": {
    /** The session, by id or by path */
    "session"?: string;
    /** The card, like cd_3 */
    "card": string;
    /** {option: n}, {button: n} or {items: [true|false, …]} */
    "answer": unknown;
  };
  /** The project verb create, as the operator (sova-project create). (changes something; needs the card's owner trusted) */
  "project.verb.create": {
    /** The project's root */
    "project"?: string;
    /** An instance id */
    "instance"?: string;
    /** A checkout's path */
    "checkout"?: string;
    /** A branch name */
    "branch"?: string;
    /** The ref a new branch starts from */
    "from"?: string;
    /** A slot number */
    "slot"?: number;
    /** Service names, comma-separated */
    "services"?: string[];
    /** Restart what runs */
    "restart"?: boolean;
    /** How many log lines */
    "lines"?: number;
    /** Keep the instance's data */
    "keep-data"?: boolean;
    /** Resource names, comma-separated */
    "resources"?: string[];
    /** A git ref */
    "ref"?: string;
    /** Test selectors, comma-separated */
    "select"?: string[];
    /** A service endpoint, service.port */
    "endpoint"?: string;
    /** How many days a share link lasts */
    "days"?: number;
    /** A share link id */
    "link"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
  };
  /** The project verb up, as the operator (sova-project up). (changes something; needs the card's owner trusted) */
  "project.verb.up": {
    /** The project's root */
    "project"?: string;
    /** An instance id */
    "instance"?: string;
    /** A checkout's path */
    "checkout"?: string;
    /** A branch name */
    "branch"?: string;
    /** The ref a new branch starts from */
    "from"?: string;
    /** A slot number */
    "slot"?: number;
    /** Service names, comma-separated */
    "services"?: string[];
    /** Restart what runs */
    "restart"?: boolean;
    /** How many log lines */
    "lines"?: number;
    /** Keep the instance's data */
    "keep-data"?: boolean;
    /** Resource names, comma-separated */
    "resources"?: string[];
    /** A git ref */
    "ref"?: string;
    /** Test selectors, comma-separated */
    "select"?: string[];
    /** A service endpoint, service.port */
    "endpoint"?: string;
    /** How many days a share link lasts */
    "days"?: number;
    /** A share link id */
    "link"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
  };
  /** The project verb down, as the operator (sova-project down). (changes something; needs the card's owner trusted) */
  "project.verb.down": {
    /** The project's root */
    "project"?: string;
    /** An instance id */
    "instance"?: string;
    /** A checkout's path */
    "checkout"?: string;
    /** A branch name */
    "branch"?: string;
    /** The ref a new branch starts from */
    "from"?: string;
    /** A slot number */
    "slot"?: number;
    /** Service names, comma-separated */
    "services"?: string[];
    /** Restart what runs */
    "restart"?: boolean;
    /** How many log lines */
    "lines"?: number;
    /** Keep the instance's data */
    "keep-data"?: boolean;
    /** Resource names, comma-separated */
    "resources"?: string[];
    /** A git ref */
    "ref"?: string;
    /** Test selectors, comma-separated */
    "select"?: string[];
    /** A service endpoint, service.port */
    "endpoint"?: string;
    /** How many days a share link lasts */
    "days"?: number;
    /** A share link id */
    "link"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
  };
  /** The project verb apply, as the operator (sova-project apply). (changes something; needs the card's owner trusted) */
  "project.verb.apply": {
    /** The project's root */
    "project"?: string;
    /** An instance id */
    "instance"?: string;
    /** A checkout's path */
    "checkout"?: string;
    /** A branch name */
    "branch"?: string;
    /** The ref a new branch starts from */
    "from"?: string;
    /** A slot number */
    "slot"?: number;
    /** Service names, comma-separated */
    "services"?: string[];
    /** Restart what runs */
    "restart"?: boolean;
    /** How many log lines */
    "lines"?: number;
    /** Keep the instance's data */
    "keep-data"?: boolean;
    /** Resource names, comma-separated */
    "resources"?: string[];
    /** A git ref */
    "ref"?: string;
    /** Test selectors, comma-separated */
    "select"?: string[];
    /** A service endpoint, service.port */
    "endpoint"?: string;
    /** How many days a share link lasts */
    "days"?: number;
    /** A share link id */
    "link"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
  };
  /** The project verb status, as the operator (sova-project status). (only looks; needs the card's owner trusted) */
  "project.verb.status": {
    /** The project's root */
    "project"?: string;
    /** An instance id */
    "instance"?: string;
    /** A checkout's path */
    "checkout"?: string;
    /** A branch name */
    "branch"?: string;
    /** The ref a new branch starts from */
    "from"?: string;
    /** A slot number */
    "slot"?: number;
    /** Service names, comma-separated */
    "services"?: string[];
    /** Restart what runs */
    "restart"?: boolean;
    /** How many log lines */
    "lines"?: number;
    /** Keep the instance's data */
    "keep-data"?: boolean;
    /** Resource names, comma-separated */
    "resources"?: string[];
    /** A git ref */
    "ref"?: string;
    /** Test selectors, comma-separated */
    "select"?: string[];
    /** A service endpoint, service.port */
    "endpoint"?: string;
    /** How many days a share link lasts */
    "days"?: number;
    /** A share link id */
    "link"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
  };
  /** The project verb logs, as the operator (sova-project logs). (only looks; needs the card's owner trusted) */
  "project.verb.logs": {
    /** The project's root */
    "project"?: string;
    /** An instance id */
    "instance"?: string;
    /** A checkout's path */
    "checkout"?: string;
    /** A branch name */
    "branch"?: string;
    /** The ref a new branch starts from */
    "from"?: string;
    /** A slot number */
    "slot"?: number;
    /** Service names, comma-separated */
    "services"?: string[];
    /** Restart what runs */
    "restart"?: boolean;
    /** How many log lines */
    "lines"?: number;
    /** Keep the instance's data */
    "keep-data"?: boolean;
    /** Resource names, comma-separated */
    "resources"?: string[];
    /** A git ref */
    "ref"?: string;
    /** Test selectors, comma-separated */
    "select"?: string[];
    /** A service endpoint, service.port */
    "endpoint"?: string;
    /** How many days a share link lasts */
    "days"?: number;
    /** A share link id */
    "link"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
  };
  /** The project verb reset, as the operator (sova-project reset). (changes something; needs the card's owner trusted) */
  "project.verb.reset": {
    /** The project's root */
    "project"?: string;
    /** An instance id */
    "instance"?: string;
    /** A checkout's path */
    "checkout"?: string;
    /** A branch name */
    "branch"?: string;
    /** The ref a new branch starts from */
    "from"?: string;
    /** A slot number */
    "slot"?: number;
    /** Service names, comma-separated */
    "services"?: string[];
    /** Restart what runs */
    "restart"?: boolean;
    /** How many log lines */
    "lines"?: number;
    /** Keep the instance's data */
    "keep-data"?: boolean;
    /** Resource names, comma-separated */
    "resources"?: string[];
    /** A git ref */
    "ref"?: string;
    /** Test selectors, comma-separated */
    "select"?: string[];
    /** A service endpoint, service.port */
    "endpoint"?: string;
    /** How many days a share link lasts */
    "days"?: number;
    /** A share link id */
    "link"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
  };
  /** The project verb teardown, as the operator (sova-project teardown). (changes something; needs the card's owner trusted) */
  "project.verb.teardown": {
    /** The project's root */
    "project"?: string;
    /** An instance id */
    "instance"?: string;
    /** A checkout's path */
    "checkout"?: string;
    /** A branch name */
    "branch"?: string;
    /** The ref a new branch starts from */
    "from"?: string;
    /** A slot number */
    "slot"?: number;
    /** Service names, comma-separated */
    "services"?: string[];
    /** Restart what runs */
    "restart"?: boolean;
    /** How many log lines */
    "lines"?: number;
    /** Keep the instance's data */
    "keep-data"?: boolean;
    /** Resource names, comma-separated */
    "resources"?: string[];
    /** A git ref */
    "ref"?: string;
    /** Test selectors, comma-separated */
    "select"?: string[];
    /** A service endpoint, service.port */
    "endpoint"?: string;
    /** How many days a share link lasts */
    "days"?: number;
    /** A share link id */
    "link"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
  };
  /** The project verb doctor, as the operator (sova-project doctor). (only looks; needs the card's owner trusted) */
  "project.verb.doctor": {
    /** The project's root */
    "project"?: string;
    /** An instance id */
    "instance"?: string;
    /** A checkout's path */
    "checkout"?: string;
    /** A branch name */
    "branch"?: string;
    /** The ref a new branch starts from */
    "from"?: string;
    /** A slot number */
    "slot"?: number;
    /** Service names, comma-separated */
    "services"?: string[];
    /** Restart what runs */
    "restart"?: boolean;
    /** How many log lines */
    "lines"?: number;
    /** Keep the instance's data */
    "keep-data"?: boolean;
    /** Resource names, comma-separated */
    "resources"?: string[];
    /** A git ref */
    "ref"?: string;
    /** Test selectors, comma-separated */
    "select"?: string[];
    /** A service endpoint, service.port */
    "endpoint"?: string;
    /** How many days a share link lasts */
    "days"?: number;
    /** A share link id */
    "link"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
  };
  /** The project verb conform, as the operator (sova-project conform). (changes something; needs the card's owner trusted) */
  "project.verb.conform": {
    /** The project's root */
    "project"?: string;
    /** An instance id */
    "instance"?: string;
    /** A checkout's path */
    "checkout"?: string;
    /** A branch name */
    "branch"?: string;
    /** The ref a new branch starts from */
    "from"?: string;
    /** A slot number */
    "slot"?: number;
    /** Service names, comma-separated */
    "services"?: string[];
    /** Restart what runs */
    "restart"?: boolean;
    /** How many log lines */
    "lines"?: number;
    /** Keep the instance's data */
    "keep-data"?: boolean;
    /** Resource names, comma-separated */
    "resources"?: string[];
    /** A git ref */
    "ref"?: string;
    /** Test selectors, comma-separated */
    "select"?: string[];
    /** A service endpoint, service.port */
    "endpoint"?: string;
    /** How many days a share link lasts */
    "days"?: number;
    /** A share link id */
    "link"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
  };
  /** The project verb test, as the operator (sova-project test). (changes something; needs the card's owner trusted) */
  "project.verb.test": {
    /** The project's root */
    "project"?: string;
    /** An instance id */
    "instance"?: string;
    /** A checkout's path */
    "checkout"?: string;
    /** A branch name */
    "branch"?: string;
    /** The ref a new branch starts from */
    "from"?: string;
    /** A slot number */
    "slot"?: number;
    /** Service names, comma-separated */
    "services"?: string[];
    /** Restart what runs */
    "restart"?: boolean;
    /** How many log lines */
    "lines"?: number;
    /** Keep the instance's data */
    "keep-data"?: boolean;
    /** Resource names, comma-separated */
    "resources"?: string[];
    /** A git ref */
    "ref"?: string;
    /** Test selectors, comma-separated */
    "select"?: string[];
    /** A service endpoint, service.port */
    "endpoint"?: string;
    /** How many days a share link lasts */
    "days"?: number;
    /** A share link id */
    "link"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
  };
  /** The project verb share, as the operator (sova-project share). (changes something; needs the card's owner trusted) */
  "project.verb.share": {
    /** The project's root */
    "project"?: string;
    /** An instance id */
    "instance"?: string;
    /** A checkout's path */
    "checkout"?: string;
    /** A branch name */
    "branch"?: string;
    /** The ref a new branch starts from */
    "from"?: string;
    /** A slot number */
    "slot"?: number;
    /** Service names, comma-separated */
    "services"?: string[];
    /** Restart what runs */
    "restart"?: boolean;
    /** How many log lines */
    "lines"?: number;
    /** Keep the instance's data */
    "keep-data"?: boolean;
    /** Resource names, comma-separated */
    "resources"?: string[];
    /** A git ref */
    "ref"?: string;
    /** Test selectors, comma-separated */
    "select"?: string[];
    /** A service endpoint, service.port */
    "endpoint"?: string;
    /** How many days a share link lasts */
    "days"?: number;
    /** A share link id */
    "link"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
  };
  /** The project verb revoke, as the operator (sova-project revoke). (changes something; needs the card's owner trusted) */
  "project.verb.revoke": {
    /** The project's root */
    "project"?: string;
    /** An instance id */
    "instance"?: string;
    /** A checkout's path */
    "checkout"?: string;
    /** A branch name */
    "branch"?: string;
    /** The ref a new branch starts from */
    "from"?: string;
    /** A slot number */
    "slot"?: number;
    /** Service names, comma-separated */
    "services"?: string[];
    /** Restart what runs */
    "restart"?: boolean;
    /** How many log lines */
    "lines"?: number;
    /** Keep the instance's data */
    "keep-data"?: boolean;
    /** Resource names, comma-separated */
    "resources"?: string[];
    /** A git ref */
    "ref"?: string;
    /** Test selectors, comma-separated */
    "select"?: string[];
    /** A service endpoint, service.port */
    "endpoint"?: string;
    /** How many days a share link lasts */
    "days"?: number;
    /** A share link id */
    "link"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
  };
  /** The project verb deploy.check, as the operator (sova-project deploy.check). (only looks; needs the card's owner trusted) */
  "project.verb.deploy.check": {
    /** The project's root */
    "project"?: string;
    /** A deploy target */
    "target"?: string;
    /** A commit */
    "commit"?: string;
    /** A git ref */
    "ref"?: string;
    /** A plan id */
    "plan"?: string;
    /** A deploy id */
    "deploy"?: string;
    /** Why */
    "why"?: string;
    /** How many log lines */
    "lines"?: number;
    /** Why the tests are overridden */
    "override-tests"?: string;
    /** Why a dirty tree is overridden */
    "override-dirty"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
    /** Dismiss the request */
    "dismiss"?: boolean;
  };
  /** The project verb deploy.plan, as the operator (sova-project deploy.plan). (changes something; needs the card's owner trusted) */
  "project.verb.deploy.plan": {
    /** The project's root */
    "project"?: string;
    /** A deploy target */
    "target"?: string;
    /** A commit */
    "commit"?: string;
    /** A git ref */
    "ref"?: string;
    /** A plan id */
    "plan"?: string;
    /** A deploy id */
    "deploy"?: string;
    /** Why */
    "why"?: string;
    /** How many log lines */
    "lines"?: number;
    /** Why the tests are overridden */
    "override-tests"?: string;
    /** Why a dirty tree is overridden */
    "override-dirty"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
    /** Dismiss the request */
    "dismiss"?: boolean;
  };
  /** The project verb deploy.run, as the operator (sova-project deploy.run). (changes something; needs the card's owner trusted) */
  "project.verb.deploy.run": {
    /** The project's root */
    "project"?: string;
    /** A deploy target */
    "target"?: string;
    /** A commit */
    "commit"?: string;
    /** A git ref */
    "ref"?: string;
    /** A plan id */
    "plan"?: string;
    /** A deploy id */
    "deploy"?: string;
    /** Why */
    "why"?: string;
    /** How many log lines */
    "lines"?: number;
    /** Why the tests are overridden */
    "override-tests"?: string;
    /** Why a dirty tree is overridden */
    "override-dirty"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
    /** Dismiss the request */
    "dismiss"?: boolean;
  };
  /** The project verb deploy.status, as the operator (sova-project deploy.status). (only looks; needs the card's owner trusted) */
  "project.verb.deploy.status": {
    /** The project's root */
    "project"?: string;
    /** A deploy target */
    "target"?: string;
    /** A commit */
    "commit"?: string;
    /** A git ref */
    "ref"?: string;
    /** A plan id */
    "plan"?: string;
    /** A deploy id */
    "deploy"?: string;
    /** Why */
    "why"?: string;
    /** How many log lines */
    "lines"?: number;
    /** Why the tests are overridden */
    "override-tests"?: string;
    /** Why a dirty tree is overridden */
    "override-dirty"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
    /** Dismiss the request */
    "dismiss"?: boolean;
  };
  /** The project verb deploy.logs, as the operator (sova-project deploy.logs). (only looks; needs the card's owner trusted) */
  "project.verb.deploy.logs": {
    /** The project's root */
    "project"?: string;
    /** A deploy target */
    "target"?: string;
    /** A commit */
    "commit"?: string;
    /** A git ref */
    "ref"?: string;
    /** A plan id */
    "plan"?: string;
    /** A deploy id */
    "deploy"?: string;
    /** Why */
    "why"?: string;
    /** How many log lines */
    "lines"?: number;
    /** Why the tests are overridden */
    "override-tests"?: string;
    /** Why a dirty tree is overridden */
    "override-dirty"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
    /** Dismiss the request */
    "dismiss"?: boolean;
  };
  /** The project verb deploy.rollback, as the operator (sova-project deploy.rollback). (changes something; needs the card's owner trusted) */
  "project.verb.deploy.rollback": {
    /** The project's root */
    "project"?: string;
    /** A deploy target */
    "target"?: string;
    /** A commit */
    "commit"?: string;
    /** A git ref */
    "ref"?: string;
    /** A plan id */
    "plan"?: string;
    /** A deploy id */
    "deploy"?: string;
    /** Why */
    "why"?: string;
    /** How many log lines */
    "lines"?: number;
    /** Why the tests are overridden */
    "override-tests"?: string;
    /** Why a dirty tree is overridden */
    "override-dirty"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
    /** Dismiss the request */
    "dismiss"?: boolean;
  };
  /** The project verb deploy.request, as the operator (sova-project deploy.request). (changes something; needs the card's owner trusted) */
  "project.verb.deploy.request": {
    /** The project's root */
    "project"?: string;
    /** A deploy target */
    "target"?: string;
    /** A commit */
    "commit"?: string;
    /** A git ref */
    "ref"?: string;
    /** A plan id */
    "plan"?: string;
    /** A deploy id */
    "deploy"?: string;
    /** Why */
    "why"?: string;
    /** How many log lines */
    "lines"?: number;
    /** Why the tests are overridden */
    "override-tests"?: string;
    /** Why a dirty tree is overridden */
    "override-dirty"?: string;
    /** The operator's confirm */
    "confirm"?: boolean;
    /** Dismiss the request */
    "dismiss"?: boolean;
  };
  /** A project's Branches tab: its copies, their services and the supervisor. (only looks; needs the card's owner trusted) */
  "project.services.view": {
    /** The project's id */
    "pid": string;
  };
  /** A project overseer's ideas. (only looks; needs the card's owner trusted) */
  "project.overseer.idea.list": {
    /** The project's id */
    "pid": string;
  };
  /** One of a project overseer's ideas, with its text. (only looks; needs the card's owner trusted) */
  "project.overseer.idea.get": {
    /** The project's id */
    "pid": string;
    /** The idea's id (§<project>/<name>) */
    "id": string;
  };
  /** Add an idea to a project overseer's list. (changes something; needs the card's owner trusted) */
  "project.overseer.idea.add": {
    /** The project's id */
    "pid": string;
    /** The idea's title */
    "title": string;
    /** Its id (§<project>/<name>) */
    "id": string;
    /** The idea's text */
    "text"?: string;
    /** Its tags */
    "tags"?: string[];
  };
  /** Change a project idea's title, status, tags, links or text. (changes something; needs the card's owner trusted) */
  "project.overseer.idea.update": {
    /** The project's id */
    "pid": string;
    /** The idea's id (§<project>/<name>) */
    "id": string;
    /** The updatedAt you last read, so a newer edit isn't lost */
    "base"?: string;
    /** The new title */
    "title"?: string;
    /** The new status */
    "status"?: string;
    /** The new tags */
    "tags"?: string[];
    /** The new links */
    "links"?: string[];
    /** The new text */
    "text"?: string;
  };
  /** A project overseer's to-do list. (only looks; needs the card's owner trusted) */
  "project.overseer.todo.list": {
    /** The project's id */
    "pid": string;
  };
  /** Add a to-do to a project overseer's list. (changes something; needs the card's owner trusted) */
  "project.overseer.todo.add": {
    /** The project's id */
    "pid": string;
    /** The to-do */
    "text": string;
    /** An idea it belongs to */
    "idea-id"?: string;
    /** A session it belongs to */
    "session-id"?: string;
  };
  /** Change a project to-do's text, mark it done, or link it. (changes something; needs the card's owner trusted) */
  "project.overseer.todo.update": {
    /** The project's id */
    "pid": string;
    /** The to-do's id */
    "id": string;
    /** The text you last read, so a newer edit isn't lost */
    "base"?: string;
    /** The new text */
    "text"?: string;
    /** Done or not */
    "done"?: boolean;
    /** An idea it belongs to */
    "idea-id"?: string | null;
    /** A session it belongs to */
    "session-id"?: string | null;
  };
  /** Remove one to-do from a project overseer's list. (changes something; needs the card's owner trusted) */
  "project.overseer.todo.remove": {
    /** The project's id */
    "pid": string;
    /** The to-do's id */
    "id": string;
  };
  /** Put a project overseer's to-dos in a new order. (changes something; needs the card's owner trusted) */
  "project.overseer.todo.reorder": {
    /** The project's id */
    "pid": string;
    /** Every to-do's id, in the new order */
    "ids": string[];
  };
  /** Remove every done to-do from a project overseer's list. (changes something; needs the card's owner trusted) */
  "project.overseer.todo.clear-done": {
    /** The project's id */
    "pid": string;
  };
  /** Every registered project, in an organization or not. (only looks; needs the card's owner trusted) */
  "project.list": Record<string, never>;
  /** One registered project. (only looks; needs the card's owner trusted) */
  "project.get": {
    /** The project's id */
    "pid": string;
  };
  /** Register a folder as a project, or clone a GitHub repository and register it; on this host only. (changes something; needs the card's owner trusted) */
  "project.create": {
    /** The folder to register */
    "root"?: string;
    /** Clone instead: { repo, parent, folder? } */
    "clone"?: unknown;
  };
  /** Rename a project or move its root. (changes something; needs the card's owner trusted) */
  "project.update": {
    /** The project's id */
    "pid": string;
    /** The new name */
    "name"?: string;
    /** The new root folder */
    "root"?: string;
  };
  /** The Claude login a project's new chats start on, and where it comes from. (only looks; needs the card's owner trusted) */
  "project.claude-login.get": {
    /** The project's id */
    "pid": string;
  };
  /** Choose the Claude login a project's new chats start on: a login id, org (same as its organization) or none (this computer's order). Open chats keep theirs. (changes something; needs the card's owner trusted) */
  "project.claude-login.set": {
    /** The project's id */
    "pid": string;
    /** A login id (default: this computer's own), org, or none */
    "login": string;
  };
  /** Archive a project; refused while anything in it is open. (changes something; needs the card's owner trusted) */
  "project.archive": {
    /** The project's id */
    "pid": string;
  };
  /** Bring an archived project back. (changes something; needs the card's owner trusted) */
  "project.unarchive": {
    /** The project's id */
    "pid": string;
  };
  /** Turn a preview link off at once. (changes something; needs the card's owner trusted) */
  "project.preview.off": {
    /** The preview's id */
    "id": string;
  };
  /** A project's coding sessions' worktrees and their branches. (only looks; needs the card's owner trusted) */
  "project.worktree.list": {
    /** The project's id */
    "pid": string;
  };
  /** Merge a coding session's worktree branch into its target. (changes something; needs the card's owner trusted) */
  "project.worktree.merge": {
    /** The project's id */
    "pid": string;
    /** The coding session's id */
    "session-id": string;
  };
  /** Remove a coding session's worktree; its branch goes too only when merged. (changes something; needs the card's owner trusted) */
  "project.worktree.remove": {
    /** The project's id */
    "pid": string;
    /** The coding session's id */
    "session-id": string;
  };
  /** The files a project keeps. (only looks; needs the card's owner trusted) */
  "project.files.list": {
    /** The project's id */
    "pid": string;
  };
  /** A project's offers file, read now: each offer, its buttons, run approval and shown/used counts. (only looks; needs the card's owner trusted) */
  "project.offers.list": {
    /** The project's id */
    "pid": string;
  };
  /** A project's card folders on its main checkout, read now: each type, or what is wrong with a broken one, and whether its cards are trusted. (only looks; needs the card's owner trusted) */
  "project.cards.list": {
    /** The project's id */
    "pid": string;
  };
  /** Every setting of a project, Sova-kept and in its files, with its state; the settings cards waiting and the folder's uncommitted settings edits. (only looks; needs the card's owner trusted) */
  "project.settings.get": {
    /** The project's id */
    "pid": string;
  };
  /** A project's settings changes, newest first: what changed, from and to, and who changed it. (only looks; needs the card's owner trusted) */
  "project.settings.history": {
    /** The project's id */
    "pid": string;
  };
  /** Put a Sova-kept setting back (refused when it changed since); undoing a file change makes a new card to apply. (changes something; needs the card's owner trusted) */
  "project.settings.undo": {
    /** The project's id */
    "pid": string;
    /** The history line's id (h…) */
    "id": string;
  };
  /** Dismiss a settings card the project overseer made; on the folder's uncommitted edits (local) it discards them. (changes something; needs the card's owner trusted) */
  "project.settings.propose.withdraw": {
    /** The project's id */
    "pid": string;
    /** The card's id (sc_…), or local */
    "card": string;
    /** local only: the fingerprint the card showed */
    "fingerprint"?: string;
  };
  /** Change a project overseer's settings: Watch, powers, models, limits, pace, the hold, extra instructions. (changes something; needs the card's owner trusted) */
  "project.overseer.settings.set": {
    /** The project's id */
    "pid": string;
    /** Watch: it looks on its own */
    "watch"?: boolean;
    /** Switches: {overseer: {<power>: true|false}, assistant: {…}} */
    "powers"?: unknown;
    /** true lifts the brake */
    "resume"?: boolean;
    /** Limits: {<limit>: <whole number> | null} */
    "caps"?: unknown;
    /** Its model (provider/model), or null for the default */
    "model"?: string | null;
    /** Its thinking level, or null */
    "thinking"?: string | null;
    /** Coding sessions' model, or null for its own */
    "coding-model"?: string | null;
    /** Coding sessions' thinking, or null */
    "coding-thinking"?: string | null;
    /** Gathering sessions' model, or null for its own */
    "gathering-model"?: string | null;
    /** Gathering sessions' thinking, or null */
    "gathering-thinking"?: string | null;
    /** Gathering sessions' abilities, or null for Automatic */
    "gathering-abilities"?: unknown | null;
    /** At most one look every this many minutes (1–1440) */
    "watch-gap-min"?: number;
    /** A look this many seconds after something to see soon (30–3600), or null for Off */
    "soon-look-sec"?: number | null;
    /** The hold in minutes (0–1440; 0: no hold) */
    "hold-min"?: number;
    /** Its extra instructions (blank removes them) */
    "extra-instructions"?: string;
    /** The Project Assistant's models for this project, or null */
    "assistant-models"?: unknown | null;
  };
  /** A project's cost card: the last count at once, or a new one with --fresh 1. (only looks; needs the card's owner trusted) */
  "project.costs": {
    /** The project's id */
    "pid": string;
    /** 1: wait for a new count */
    "fresh"?: "1";
  };
  /** What needs the user now, as the Overseer's digest has it. (only looks; needs the card's owner trusted) */
  "overseer.attention": Record<string, never>;
  /** The Overseer's to-do list. (only looks; needs the card's owner trusted) */
  "overseer.todo.list": Record<string, never>;
  /** Add a to-do to the Overseer's list. (changes something; needs the card's owner trusted) */
  "overseer.todo.add": {
    /** The to-do */
    "text": string;
    /** An idea it belongs to */
    "idea-id"?: string;
    /** A session it belongs to */
    "session-id"?: string;
  };
  /** Change a to-do's text, mark it done, or link it. (changes something; needs the card's owner trusted) */
  "overseer.todo.update": {
    /** The to-do's id */
    "id": string;
    /** The text you last read, so a newer edit isn't lost */
    "base"?: string;
    /** The new text */
    "text"?: string;
    /** Done or not */
    "done"?: boolean;
    /** An idea it belongs to */
    "idea-id"?: string | null;
    /** A session it belongs to */
    "session-id"?: string | null;
  };
  /** Remove one to-do from the Overseer's list. (changes something; needs the card's owner trusted) */
  "overseer.todo.remove": {
    /** The to-do's id */
    "id": string;
  };
  /** Put the Overseer's to-dos in a new order. (changes something; needs the card's owner trusted) */
  "overseer.todo.reorder": {
    /** Every to-do's id, in the new order */
    "ids": string[];
  };
  /** Remove every done to-do from the Overseer's list. (changes something; needs the card's owner trusted) */
  "overseer.todo.clear-done": Record<string, never>;
  /** The Overseer's ideas backlog. (only looks; needs the card's owner trusted) */
  "overseer.idea.list": Record<string, never>;
  /** One idea from the Overseer's backlog, with its text. (only looks; needs the card's owner trusted) */
  "overseer.idea.get": {
    /** The idea's id (§<project>/<name>) */
    "id": string;
  };
  /** Change an idea's title, status, tags, links or text, or rename it. (changes something; needs the card's owner trusted) */
  "overseer.idea.update": {
    /** The idea's id (§<project>/<name>) */
    "id": string;
    /** The updatedAt you last read, so a newer edit isn't lost */
    "base"?: string;
    /** The new title */
    "title"?: string;
    /** The new status */
    "status"?: string;
    /** The new tags */
    "tags"?: string[];
    /** The new links */
    "links"?: string[];
    /** The new text */
    "text"?: string;
    /** A new id to rename it to */
    "new-id"?: string;
  };
  /** The Overseer's standing notes. (only looks; needs the card's owner trusted) */
  "overseer.notes.get": Record<string, never>;
  /** Replace the Overseer's standing notes. (changes something; needs the card's owner trusted) */
  "overseer.notes.set": {
    /** The new notes */
    "text": string;
    /** The notes you last read, so one the Overseer added meanwhile isn't lost */
    "base"?: string;
  };
  /** The models this server can run, with favorites and the policy's verdicts. (only looks; needs the card's owner trusted) */
  "models.list": Record<string, never>;
  /** The installed extensions and whether each backend answers. (only looks; needs the card's owner trusted) */
  "extensions.list": Record<string, never>;
  /** The configured remote targets, each with its reachability. (only looks; needs the card's owner trusted) */
  "targets.list": Record<string, never>;
  /** The subfolders of a folder, for the folder picker; directory names only. (only looks; needs the card's owner trusted) */
  "folders.list": {
    /** The folder (default: your home folder) */
    "path"?: string;
  };
  /** The folders sessions have run in. (only looks; needs the card's owner trusted) */
  "cwds.list": Record<string, never>;
  /** Every non-ignored file under a folder, as the composer's @-mention index. (only looks; needs the card's owner trusted) */
  "files.list": {
    /** The folder */
    "cwd": string;
  };
  /** Star or unstar one model, as the model picker's star does. (changes something; needs the card's owner trusted) */
  "models.favorite": {
    /** The model, as provider/id */
    "ref": string;
    /** Starred or not */
    "favorite": boolean;
  };
  /** Spending over a range, by day, provider and model. (only looks; needs the card's owner trusted) */
  "usage.costs": {
    /** The range, such as 30d */
    "range"?: string;
    /** Only this provider */
    "provider"?: string;
    /** Only this model */
    "model"?: string;
    /** The time zone (default UTC) */
    "tz"?: string;
  };
  /** Measured reply timing over a range. (only looks; needs the card's owner trusted) */
  "usage.performance": {
    /** The range, such as 30d */
    "range"?: string;
    /** Only this provider */
    "provider"?: string;
    /** Only this model */
    "model"?: string;
    /** The time zone (default UTC) */
    "tz"?: string;
  };
  /** Today's spending. (only looks; needs the card's owner trusted) */
  "usage.today": {
    /** The time zone (default UTC) */
    "tz"?: string;
  };
  /** One session's spending, by session id. (only looks; needs the card's owner trusted) */
  "usage.session": {
    /** The session id */
    "sid": string;
  };
  /** Several sessions' spending, by session id. (only looks; needs the card's owner trusted) */
  "usage.sessions": {
    /** Session ids, comma-separated */
    "sids": string[];
  };
  /** The price list the usage ledger uses. (only looks; needs the card's owner trusted) */
  "usage.prices": Record<string, never>;
  /** Fetch the price list again. (changes something; needs the card's owner trusted) */
  "usage.prices.refresh": Record<string, never>;
  /** Each provider's usage against its limits, as the sidebar shows it. (only looks; needs the card's owner trusted) */
  "insights.usage": Record<string, never>;
  /** One usage chart's recorded readings. (only looks; needs the card's owner trusted) */
  "insights.usage.history": {
    /** The series */
    "series": string;
    /** The window */
    "window": string;
    /** Readings around this time (epoch ms) */
    "at"?: number;
  };
  /** The Agents page's workers and teams. (only looks; needs the card's owner trusted) */
  "insights.agents": {
    /** 1 adds each session's output tokens (the board's Tokens/min) */
    "tokens"?: string;
  };
  /** The git worktrees each session touches. (only looks; needs the card's owner trusted) */
  "insights.worktrees": {
    /** Session paths, comma-separated */
    "paths": string[];
  };
  /** The workers a session's pane lists under Show More. (only looks; needs the card's owner trusted) */
  "insights.session.workers": {
    /** The session */
    "session"?: string;
  };
  /** A team member's inbox, read-only: its items, or with an item id that item's whole message. (only looks; needs the card's owner trusted) */
  "insights.session.inbox": {
    /** The session that owns the team */
    "session"?: string;
    /** The team id (team_01) */
    "team": string;
    /** The member's worker id (ag_03) */
    "worker": string;
    /** An item id (i_2a): answer that item's whole message */
    "item"?: string;
  };
  /** What this server runs: its start, its commit and its runtime. (only looks; needs the card's owner trusted) */
  "sova.health": Record<string, never>;
  /** Sova's own switches, from Alignment and Experimental. (only looks; needs the card's owner trusted) */
  "settings.sova.get": Record<string, never>;
  /** The model policy: which models are disabled. (only looks; needs the card's owner trusted) */
  "settings.models.get": Record<string, never>;
  /** How many requests each provider may run at once. (only looks; needs the card's owner trusted) */
  "settings.provider-limits.get": Record<string, never>;
  /** The align mode's writing style and Visuals. (only looks; needs the card's owner trusted) */
  "settings.align.get": Record<string, never>;
  /** Legacy Delegate routing (mode-delegate.json): the profile library's seed and fallback, not what Settings → Subagents shows. (only looks; needs the card's owner trusted) */
  "settings.delegate.get": Record<string, never>;
  /** The legacy spec writer (mode-spec.json): the profile library's seed and fallback, not what Settings → Subagents shows. (only looks; needs the card's owner trusted) */
  "settings.spec.get": Record<string, never>;
  /** The coordinator and monitor every new team gets. (only looks; needs the card's owner trusted) */
  "settings.team.get": Record<string, never>;
  /** Which model writes the sidebar's summary line. (only looks; needs the card's owner trusted) */
  "settings.summarizer.get": Record<string, never>;
  /** The Overseer's model and behaviour. (only looks; needs the card's owner trusted) */
  "settings.overseer.get": Record<string, never>;
  /** The memory mode's settings. (only looks; needs the card's owner trusted) */
  "settings.memory.get": Record<string, never>;
  /** The subagent profile library. (only looks; needs the card's owner trusted) */
  "settings.subagents.get": Record<string, never>;
  /** Save the align mode's writing style and Visuals. (changes something; needs the card's owner trusted) */
  "settings.align.set": {
    /** The writing style */
    "style"?: unknown;
    /** The Visuals */
    "visuals"?: unknown;
  };
  /** Set or clear the model and thinking every organization's Project Assistant uses unless it picks its own. (changes something; needs the card's owner trusted) */
  "settings.assistant-default.set": {
    /** The default: {model: "provider/model", thinking?}, or null to clear it */
    "assistant": unknown;
  };
  /** Send the test notification to every registered device. (changes something; needs the card's owner trusted) */
  "push.test": Record<string, never>;
  /** The record of calls made with the token, newest first: who (a chat's key, or none), the command, the route and its status; never their params. (only looks; needs the card's owner trusted) */
  "audit.list": {
    /** At most this many rows (1 to 1000, default 100) */
    "limit"?: number;
    /** Only this caller's rows (chat:<id>, unattributed or no-key) */
    "caller"?: string;
    /** Only the rows naming this command */
    "command"?: string;
  };
  /** Open a new chat in an owner request's project with the request in it as a note; nothing is sent until you write. (changes something; needs the card's owner trusted) */
  "org.owner.request.chat": {
    /** The organization's id */
    "org-id": string;
    /** The owner request's id (or_…) */
    "request-id": string;
  };
  /** Mark an owner request done. (changes something; needs the card's owner trusted) */
  "org.owner.request.done": {
    /** The organization's id */
    "org-id": string;
    /** The owner request's id (or_…) */
    "request-id": string;
  };
  /** Decline an owner request. (changes something; needs the card's owner trusted) */
  "org.owner.request.decline": {
    /** The organization's id */
    "org-id": string;
    /** The owner request's id (or_…) */
    "request-id": string;
  };
  /** Note an owner request the owner closed while it was being worked on: its Needs you item ends. (changes something; needs the card's owner trusted) */
  "org.owner.request.noted": {
    /** The organization's id */
    "org-id": string;
    /** The owner request's id (or_…) */
    "request-id": string;
  };
  /** The versions of a project on the owner's page, each with its summary as kept (automatic, the team's rewrite, hidden). (only looks; needs the card's owner trusted) */
  "org.project.versions": {
    /** The organization's id */
    "org-id": string;
    /** The project's id */
    "project-id": string;
  };
  /** Replace a version's summary on the owner's page with your own words. (changes something; needs the card's owner trusted) */
  "org.project.version.rewrite": {
    /** The organization's id */
    "org-id": string;
    /** The project's id */
    "project-id": string;
    /** The version's copy (its instance id) */
    "instance": string;
    /** The summary the owner reads */
    "text": string;
  };
  /** Show a version's automatic summary again instead of your rewrite. (changes something; needs the card's owner trusted) */
  "org.project.version.automatic": {
    /** The organization's id */
    "org-id": string;
    /** The project's id */
    "project-id": string;
    /** The version's copy (its instance id) */
    "instance": string;
  };
  /** Hide a version's summary from the owner and their assistant. (changes something; needs the card's owner trusted) */
  "org.project.version.hide": {
    /** The organization's id */
    "org-id": string;
    /** The project's id */
    "project-id": string;
    /** The version's copy (its instance id) */
    "instance": string;
  };
  /** Show a hidden version summary to the owner again. (changes something; needs the card's owner trusted) */
  "org.project.version.show": {
    /** The organization's id */
    "org-id": string;
    /** The project's id */
    "project-id": string;
    /** The version's copy (its instance id) */
    "instance": string;
  };
  /** The Claude login every project of an organization follows unless it picks its own. (only looks; needs the card's owner trusted) */
  "org.claude-login.get": {
    /** The organization's id */
    "org-id": string;
  };
  /** Choose the Claude login an organization's projects follow: a login id (default: this computer's own) or none. Kept on this computer. (changes something; needs the card's owner trusted) */
  "org.claude-login.set": {
    /** The organization's id */
    "org-id": string;
    /** A login id, or none */
    "login": string;
  };
  /** Stop a chat's reply, as its Stop button does, and wait until it has stopped. (changes something; needs the card's owner trusted) */
  "chat.stop": {
    /** The session, by id or by path */
    "session"?: string;
    /** How long to wait for the outcome, in ms (0 to 300000; default 30000). Past it the answer is `unknown` (exit 5), never a retry */
    "wait"?: number;
  };
  /** Compact a chat's context now, as /compact does, and wait for the outcome. (changes something; needs the card's owner trusted) */
  "chat.compact": {
    /** The session, by id or by path */
    "session"?: string;
    /** How long to wait for the outcome, in ms (0 to 300000; default 30000). Past it the answer is `unknown` (exit 5), never a retry */
    "wait"?: number;
    /** What the summary should keep */
    "instructions"?: string;
  };
  /** Rewind a chat to just before one of its messages; the answer holds that message's text. (changes something; needs the card's owner trusted) */
  "chat.rewind": {
    /** The session, by id or by path */
    "session"?: string;
    /** How long to wait for the outcome, in ms (0 to 300000; default 30000). Past it the answer is `unknown` (exit 5), never a retry */
    "wait"?: number;
    /** The user message's transcript row id */
    "entry": string;
  };
  /** Redo the reply an assistant row belongs to, with the chat's current model. (changes something; needs the card's owner trusted) */
  "chat.regenerate": {
    /** The session, by id or by path */
    "session"?: string;
    /** How long to wait for the outcome, in ms (0 to 300000; default 30000). Past it the answer is `unknown` (exit 5), never a retry */
    "wait"?: number;
    /** The assistant row's transcript id */
    "entry": string;
  };
  /** Remove one still-unsent message from a chat's queue. (changes something; needs the card's owner trusted) */
  "chat.queue.remove": {
    /** The session, by id or by path */
    "session"?: string;
    /** How long to wait for the outcome, in ms (0 to 300000; default 30000). Past it the answer is `unknown` (exit 5), never a retry */
    "wait"?: number;
    /** The queued message's id */
    "item": string;
  };
  /** Reload a chat on the server's current code, now or at its next quiet moment. (changes something; needs the card's owner trusted) */
  "chat.reload-code": {
    /** The session, by id or by path */
    "session"?: string;
    /** How long to wait for the outcome, in ms (0 to 300000; default 30000). Past it the answer is `unknown` (exit 5), never a retry */
    "wait"?: number;
  };
  /** Run a command of a project mode that is on in a chat, from the version the chat approved. (changes something; needs the card's owner trusted) */
  "chat.mode-command": {
    /** The session, by id or by path */
    "session"?: string;
    /** The project mode's id */
    "mode": string;
    /** The command's name */
    "name": string;
    /** The command's arguments, a JSON object */
    "args"?: unknown;
  };
}

/** Whether each command only looks or changes something; a view runs either only once its owner is trusted. */
export const COMMAND_EFFECTS: Record<CommandId, "looks" | "changes"> = {
  "session.list": "looks",
  "session.get": "looks",
  "session.read": "looks",
  "session.create": "changes",
  "session.title.set": "changes",
  "session.title.reset": "changes",
  "session.tags.set": "changes",
  "session.archive": "changes",
  "session.unarchive": "changes",
  "session.configure": "changes",
  "session.mode.get": "looks",
  "session.mode.set": "changes",
  "session.send": "changes",
  "session.fork": "changes",
  "session.draft.get": "looks",
  "session.draft.set": "changes",
  "session.sandbox.set": "changes",
  "session.tools.get": "looks",
  "session.align.triage": "looks",
  "session.workers.checks": "looks",
  "session.context": "looks",
  "session.context.file": "looks",
  "session.group.list": "looks",
  "session.group.create": "changes",
  "session.group.rename": "changes",
  "session.group.delete": "changes",
  "session.group.assign": "changes",
  "session.group.send": "changes",
  "session.insights": "looks",
  "worker.resume": "changes",
  "session.offers.get": "looks",
  "session.offers.show": "changes",
  "session.offers.choose": "changes",
  "session.offers.snooze": "changes",
  "session.offers.unsnooze": "changes",
  "session.card.post": "changes",
  "session.card.get": "looks",
  "session.card.answer": "changes",
  "project.verb.create": "changes",
  "project.verb.up": "changes",
  "project.verb.down": "changes",
  "project.verb.apply": "changes",
  "project.verb.status": "looks",
  "project.verb.logs": "looks",
  "project.verb.reset": "changes",
  "project.verb.teardown": "changes",
  "project.verb.doctor": "looks",
  "project.verb.conform": "changes",
  "project.verb.test": "changes",
  "project.verb.share": "changes",
  "project.verb.revoke": "changes",
  "project.verb.deploy.check": "looks",
  "project.verb.deploy.plan": "changes",
  "project.verb.deploy.run": "changes",
  "project.verb.deploy.status": "looks",
  "project.verb.deploy.logs": "looks",
  "project.verb.deploy.rollback": "changes",
  "project.verb.deploy.request": "changes",
  "project.services.view": "looks",
  "project.overseer.idea.list": "looks",
  "project.overseer.idea.get": "looks",
  "project.overseer.idea.add": "changes",
  "project.overseer.idea.update": "changes",
  "project.overseer.todo.list": "looks",
  "project.overseer.todo.add": "changes",
  "project.overseer.todo.update": "changes",
  "project.overseer.todo.remove": "changes",
  "project.overseer.todo.reorder": "changes",
  "project.overseer.todo.clear-done": "changes",
  "project.list": "looks",
  "project.get": "looks",
  "project.create": "changes",
  "project.update": "changes",
  "project.claude-login.get": "looks",
  "project.claude-login.set": "changes",
  "project.archive": "changes",
  "project.unarchive": "changes",
  "project.preview.off": "changes",
  "project.worktree.list": "looks",
  "project.worktree.merge": "changes",
  "project.worktree.remove": "changes",
  "project.files.list": "looks",
  "project.offers.list": "looks",
  "project.cards.list": "looks",
  "project.settings.get": "looks",
  "project.settings.history": "looks",
  "project.settings.undo": "changes",
  "project.settings.propose.withdraw": "changes",
  "project.overseer.settings.set": "changes",
  "project.costs": "looks",
  "overseer.attention": "looks",
  "overseer.todo.list": "looks",
  "overseer.todo.add": "changes",
  "overseer.todo.update": "changes",
  "overseer.todo.remove": "changes",
  "overseer.todo.reorder": "changes",
  "overseer.todo.clear-done": "changes",
  "overseer.idea.list": "looks",
  "overseer.idea.get": "looks",
  "overseer.idea.update": "changes",
  "overseer.notes.get": "looks",
  "overseer.notes.set": "changes",
  "models.list": "looks",
  "extensions.list": "looks",
  "targets.list": "looks",
  "folders.list": "looks",
  "cwds.list": "looks",
  "files.list": "looks",
  "models.favorite": "changes",
  "usage.costs": "looks",
  "usage.performance": "looks",
  "usage.today": "looks",
  "usage.session": "looks",
  "usage.sessions": "looks",
  "usage.prices": "looks",
  "usage.prices.refresh": "changes",
  "insights.usage": "looks",
  "insights.usage.history": "looks",
  "insights.agents": "looks",
  "insights.worktrees": "looks",
  "insights.session.workers": "looks",
  "insights.session.inbox": "looks",
  "sova.health": "looks",
  "settings.sova.get": "looks",
  "settings.models.get": "looks",
  "settings.provider-limits.get": "looks",
  "settings.align.get": "looks",
  "settings.delegate.get": "looks",
  "settings.spec.get": "looks",
  "settings.team.get": "looks",
  "settings.summarizer.get": "looks",
  "settings.overseer.get": "looks",
  "settings.memory.get": "looks",
  "settings.subagents.get": "looks",
  "settings.align.set": "changes",
  "settings.assistant-default.set": "changes",
  "push.test": "changes",
  "audit.list": "looks",
  "org.owner.request.chat": "changes",
  "org.owner.request.done": "changes",
  "org.owner.request.decline": "changes",
  "org.owner.request.noted": "changes",
  "org.project.versions": "looks",
  "org.project.version.rewrite": "changes",
  "org.project.version.automatic": "changes",
  "org.project.version.hide": "changes",
  "org.project.version.show": "changes",
  "org.claude-login.get": "looks",
  "org.claude-login.set": "changes",
  "chat.stop": "changes",
  "chat.compact": "changes",
  "chat.rewind": "changes",
  "chat.regenerate": "changes",
  "chat.queue.remove": "changes",
  "chat.reload-code": "changes",
  "chat.mode-command": "changes",
};
