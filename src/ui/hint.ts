/**
 * A small "?" that shows a short explanation on hover, focus or tap (no layout shift).
 * The tip spans the nearest positioned ancestor (`.panel-box`, `#log-head`); 'up' opens it upward.
 * `html` is trusted markup written by us, never player text.
 */
export function hint(html: string, place: '' | 'up' = ''): string {
  return `<button type="button" class="hint ${place}" aria-label="Help">?<span class="tip" role="tooltip">${html}</span></button>`;
}

/** The message strip with the Comms tab (game ?comms=1): only the world and the game. */
export const MISSION_EVENTS_HELP = `What happens in the world and the game: goals, weather, supply crates, upgrades, alarms about the
  rover, and actions that could not be done.
  <br><br>What you <b>sent</b> to the rover and what it <b>sent back</b> (your <code>LOG</code>s, copies of registers) is in the
  <b>Comms</b> tab.`;
