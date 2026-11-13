/**
 * A small "?" that shows a short explanation on hover, focus or tap (no layout shift).
 * The tip spans the nearest positioned ancestor (`.panel-box`, `#log-head`); 'up' opens it upward.
 * `html` is trusted markup written by us, never player text.
 */
export function hint(html: string, place: '' | 'up' = ''): string {
  return `<button type="button" class="hint ${place}" aria-label="Help">?<span class="tip" role="tooltip">${html}</span></button>`;
}

/** The game's message strip under the side panel (main.ts). */
export const MISSION_LOG_HELP = `Messages from the game and mission control: goals, events, upload results, rejected commands.
  <br><br>What the <b>rover itself</b> sends (your <code>LOG</code>s, dump replies) is in the <b>Console</b> tab.`;
