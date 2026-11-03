/**
 * Steers land together (quirk P28 steer-all): pi takes every queued steer at the agent's next step,
 * each its own message, in the order queued, instead of one per step.
 *
 * pi reads the steering mode from its settings manager's getter when it builds a session
 * (`createAgentSession`) and again on every `AgentSession.reload()` (`syncQueueModesFromSettings`, after
 * `settingsManager.reload()` re-read settings.json), so the getter of this runtime's own settings object
 * answers "all". Never `setSteeringMode`: it saves into settings.json, which the user's terminal pi reads
 * too. Only steering: follow-ups (worker reports, wake-ups, a parent's follow-up instructions) keep pi's
 * one at a time.
 */
export function steerAllAtOnce(settings: { getSteeringMode(): string }): void {
  settings.getSteeringMode = () => "all";
}
