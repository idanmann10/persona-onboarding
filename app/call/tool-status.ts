/** What the call screen says while the assistant runs a tool, and for a moment after it finishes. */
export interface ToolStatus { running: string; done: string }

type Args = Record<string, unknown>;

const TOOLKIT_NAMES: Record<string, string> = { gmail: 'Gmail', calendar: 'Google Calendar' };

const NOTING: ToolStatus = { running: 'Noting that…', done: 'Noted' };
const FALLBACK: ToolStatus = { running: 'Working on it…', done: 'Done' };

/** Known voice tools by name. The backend's tool list can change, so anything else falls back to the name's wording below. */
const KNOWN: Record<string, (args: Args) => ToolStatus> = {
  search_gmail: () => ({ running: 'Checking your inbox…', done: 'Checked your inbox' }),
  read_calendar_window: () => ({ running: 'Looking at your calendar…', done: 'Looked at your calendar' }),
  show_connection: (args) => {
    const button = TOOLKIT_NAMES[String(args.toolkit)] ? `Connect ${TOOLKIT_NAMES[String(args.toolkit)]}` : 'Connect';
    return { running: `Putting the ${button} button on your screen…`, done: `The ${button} button is on your screen` };
  },
  remember: (args) => args.key === 'preferred_name' ? { running: 'Noting your name…', done: 'Noted your name' }
    : args.key === 'current_need' ? { running: 'Noting what you need…', done: 'Noted what you need' }
      : NOTING,
  note_decline: () => NOTING,
  customize: (args) => args.name ? { running: 'Changing my name…', done: 'Changed my name' }
    : args.avatar ? { running: 'Changing my look…', done: 'Changed my look' }
      : args.voice ? { running: 'Changing my voice…', done: 'Changed my voice' }
        : args.personality ? { running: 'Adjusting my personality…', done: 'Adjusted my personality' }
          : { running: 'Changing my look…', done: 'Updated' },
  graduate: () => ({ running: 'Skipping the rest of setup…', done: 'Skipped the rest of setup' }),
  propose_automation: () => ({ running: 'Drafting a recurring task…', done: 'Drafted a recurring task' }),
  approve_automation: () => ({ running: 'Turning it on…', done: 'Your recurring task is on' }),
  offer_call: () => ({ running: 'Setting up a call…', done: 'Call is ready' }),
  end_call: () => ({ running: 'Saying goodbye…', done: 'Call ended' }),
};

/** Unknown tools: guess from the words in the name, e.g. `search_calendar_events` reads as the calendar. */
const BY_WORD: Array<[RegExp, ToolStatus]> = [
  [/gmail|mail|inbox|email/, { running: 'Checking your inbox…', done: 'Checked your inbox' }],
  [/calendar|event|schedule|meeting/, { running: 'Looking at your calendar…', done: 'Looked at your calendar' }],
  [/connect|connection/, { running: 'Putting the Connect button on your screen…', done: 'The Connect button is on your screen' }],
  [/search|lookup|look_up|research|find|web/, { running: 'Looking that up…', done: 'Looked it up' }],
  [/remember|note|save|memory|fact/, NOTING],
  [/customi[sz]e|avatar|rename|persona|look/, { running: 'Changing my look…', done: 'Updated' }],
  [/automation|recurring|routine|task/, { running: 'Setting up a task…', done: 'Task is ready' }],
  [/draft|write|compose/, { running: 'Drafting that…', done: 'Drafted' }],
];

function parseArgs(json: string): Args {
  try {
    const value: unknown = JSON.parse(json || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Args : {};
  } catch { return {}; }
}

export function toolStatus(name: string, argumentsJson = '{}'): ToolStatus {
  const known = KNOWN[name];
  if (known) return known(parseArgs(argumentsJson));
  const words = name.toLowerCase();
  return BY_WORD.find(([pattern]) => pattern.test(words))?.[1] ?? FALLBACK;
}
