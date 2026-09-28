'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { AVATARS, DEFAULT_AVATAR, DEFAULT_LOOK, avatarUrl, type PersonaSettings } from '@/lib/domain/persona';
import { Avatar } from './avatar';
import { CheckIcon, CloseIcon, PaintIcon } from './icons';

type Look = { id: string; label: string; url: string };

/** The stock looks: the cute set first (AVATARS order), then the original Classic portrait. */
const STOCK: Look[] = [
  ...Object.entries(AVATARS).map(([id, look]) => ({ id, label: look.label, url: avatarUrl(id) })),
  { id: DEFAULT_AVATAR, label: DEFAULT_LOOK.label, url: avatarUrl(DEFAULT_AVATAR) },
];

const DESCRIPTION_LIMIT = 200;

interface LookPickerProps {
  name: string;
  /** The saved look: a stock id, `default` or `img:<uuid>`. */
  current: string;
  /** Looks painted earlier in this conversation (`img:<uuid>`), newest first, so going back costs nothing. */
  painted: string[];
  onSaved(settings: PersonaSettings): void;
  onClose(): void;
}

async function saveLook(body: { avatar: string } | { paint: string }): Promise<PersonaSettings> {
  const response = await fetch('/api/persona', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.text().catch(() => '')).trim() || 'That did not go through. Please try again.');
  return (await response.json() as { settings: PersonaSettings }).settings;
}

/**
 * The look picker, opened from the assistant's portrait in the header: every stock portrait with the
 * current one marked (a tap saves it), the user's earlier paintings, and "describe a new look", which
 * paints one with the same image model the customize tool uses.
 */
export function LookPicker({ name, current, painted, onSaved, onClose }: LookPickerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  const [selected, setSelected] = useState(current);
  const [saving, setSaving] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [painting, setPainting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    // With a keyboard or mouse, start on the current look so arrow keys move from there; a touch screen keeps the dialog's own focus.
    if (window.matchMedia?.('(pointer: fine)').matches) gridRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
  }, []);

  // A change made elsewhere (the chat's customize tool) while the picker is open.
  useEffect(() => { setSelected(current); }, [current]);

  const yours: Look[] = [...new Set([...(current.startsWith('img:') ? [current] : []), ...painted])]
    .map((id) => ({ id, label: 'Painted', url: avatarUrl(id) }));
  const looks = [...yours, ...STOCK];
  const preview = looks.find((look) => look.id === selected) ?? { id: selected, label: 'Painted', url: avatarUrl(selected) };

  function close() {
    const dialog = dialogRef.current;
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
    else onClose();
  }

  function onBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) close();
  }

  async function pick(id: string) {
    if (saving || painting || id === selected) return;
    const previous = selected;
    setSelected(id);
    setSaving(id);
    setError('');
    try { onSaved(await saveLook({ avatar: id })); }
    catch (cause) { setSelected(previous); setError(cause instanceof Error ? cause.message : 'That look could not be saved.'); }
    finally { setSaving(null); }
  }

  async function paint(event: FormEvent) {
    event.preventDefault();
    const text = description.trim();
    if (text.length < 3 || painting || saving) return;
    setPainting(true);
    setError('');
    try {
      const settings = await saveLook({ paint: text });
      setSelected(settings.avatar);
      setDescription('');
      onSaved(settings);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'That look could not be painted.'); }
    finally { setPainting(false); }
  }

  // Arrow keys move around the grid (Enter or Space picks), so Tab reaches the paint field in one step.
  function onGridKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const buttons = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const columns = Math.max(1, buttons.filter((button) => button.offsetTop === buttons[0].offsetTop).length);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, ArrowDown: index + columns, ArrowUp: index - columns, Home: 0, End: buttons.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    buttons[Math.min(buttons.length - 1, Math.max(0, next))]?.focus();
  }

  const focusable = looks.some((look) => look.id === selected) ? selected : looks[0]?.id;

  return (
    <dialog ref={dialogRef} className="sheet look-sheet" aria-labelledby="look-title" onClose={onClose} onClick={onBackdrop}>
      <div className="sheet-panel">
        <div className="sheet-head">
          <div>
            <h2 id="look-title">Look</h2>
            <p>Pick a portrait for {name}, or describe a new one.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={close}><CloseIcon width={18} height={18} /></button>
        </div>

        <div className="look-body">
          <div className="look-preview" aria-live="polite">
            <span className={`look-preview-ring${painting ? ' painting' : ''}`}>
              <Avatar src={preview.url} name={name} size={76} />
            </span>
            <span className="look-preview-text">
              <strong>{name}</strong>
              <small>{painting ? 'Painting a new look…' : saving ? 'Saving…' : preview.id.startsWith('img:') ? 'Your painted look' : preview.label}</small>
            </span>
          </div>

          {error ? <p className="sheet-error look-error" role="alert">{error}</p> : null}

          <ul className="look-grid" ref={gridRef} aria-label="Looks" onKeyDown={onGridKeyDown}>
            {looks.map((look) => {
              const active = look.id === selected;
              return (
                <li key={look.id}>
                  <button type="button" className="look-tile" aria-pressed={active} aria-label={look.id.startsWith('img:') ? 'Your painted look' : look.label}
                    tabIndex={look.id === focusable ? 0 : -1} disabled={painting} onClick={() => void pick(look.id)}>
                    <span className="look-tile-ring">
                      <Avatar src={look.url} name={look.label} size={64} />
                      {active ? <span className="look-check" aria-hidden="true">{saving === look.id ? <span className="look-spinner" /> : <CheckIcon width={12} height={12} />}</span> : null}
                    </span>
                    <span className="look-tile-label">{look.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <form className="look-paint" onSubmit={paint}>
            <label htmlFor="look-describe">Describe a new look</label>
            <div className="look-paint-row">
              <input id="look-describe" type="text" value={description} maxLength={DESCRIPTION_LIMIT} disabled={painting} autoComplete="off"
                placeholder="A sleepy cat in a tiny astronaut helmet" onChange={(event) => setDescription(event.target.value)} />
              <button type="submit" className="pill primary" disabled={painting || Boolean(saving) || description.trim().length < 3}>
                {painting ? <span className="look-spinner light" aria-hidden="true" /> : <PaintIcon width={15} height={15} />}
                {painting ? 'Painting…' : 'Paint'}
              </button>
            </div>
            <small className="look-paint-note">{painting ? 'About half a minute. You can close this; the new look shows up when it is ready.' : 'Painted for you in about half a minute.'}</small>
          </form>
        </div>
      </div>
    </dialog>
  );
}
