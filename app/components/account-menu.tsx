'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { AgentLogIcon, ExternalIcon, SignOutIcon, StartOverIcon } from './icons';

export type Account = { email: string; name?: string; picture?: string };

interface AccountMenuProps {
  account: Account;
  /** A call is live: signing out or starting over would cut it off. */
  onCall: boolean;
  signingOut: boolean;
  deleting: boolean;
  /** Start over waits while a reply is streaming or the page is still loading. */
  startOverDisabled: boolean;
  onSignOut(): void;
  onStartOver(): void;
}

function Monogram({ account, size }: { account: Account; size: number }) {
  const [broken, setBroken] = useState(false);
  const initial = (Array.from((account.name || account.email).trim())[0] ?? '?').toUpperCase();
  if (account.picture && !broken) {
    return <img className="monogram" src={account.picture} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return <span className="monogram" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">{initial}</span>;
}

/**
 * The account button at the right of the header: the user's photo or initial. Its menu holds who is
 * signed in, the agent log, Start over (behind a confirm step) and Sign out. Arrow keys move through the
 * items; Escape, Tab or a click outside closes it.
 */
export function AccountMenu({ account, onCall, signingOut, deleting, startOverDisabled, onSignOut, onStartOver }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const backingOut = useRef(false);

  function backOut() {
    backingOut.current = true;
    setConfirming(false);
  }

  function close(focusButton: boolean) {
    setOpen(false);
    setConfirming(false);
    if (focusButton) buttonRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) close(false); };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  // Opening focuses the first item; the confirm step focuses Cancel, the safe choice, and backing out of it returns to Start over.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const target = confirming ? panel?.querySelector<HTMLElement>('[data-autofocus]') : backingOut.current ? panel?.querySelector<HTMLElement>('[data-start-over]') : items()[0];
    backingOut.current = false;
    target?.focus();
  }, [open, confirming]);

  function items(): HTMLElement[] {
    return [...(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Escape backs out of the confirm step first, then closes.
      if (confirming) backOut();
      else close(true);
      return;
    }
    // Tab leaves the menu from its button, so focus moves on to what follows (or precedes) it in the page.
    if (event.key === 'Tab') { close(true); return; }
    if (confirming) return;
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: list.length - 1 }[event.key];
    if (next === undefined || !list.length) return;
    event.preventDefault();
    list[(next + list.length) % list.length]?.focus();
  }

  function onButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); }
  }

  const blocked = onCall ? 'End the call first' : undefined;

  return (
    <div className="account" ref={rootRef} onKeyDown={open ? onKeyDown : undefined}>
      <button ref={buttonRef} type="button" className="account-button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined}
        aria-label={`Account: ${account.email}`} title={account.email} onClick={() => (open ? close(false) : setOpen(true))} onKeyDown={onButtonKeyDown}>
        <Monogram account={account} size={32} />
      </button>
      {open ? (
        <div className="account-panel" ref={panelRef}>
          <div className="account-who">
            <Monogram account={account} size={40} />
            <span className="account-who-text">
              {account.name ? <strong>{account.name}</strong> : <strong>Signed in</strong>}
              <small>{account.email}</small>
            </span>
          </div>
          {confirming ? (
            <div className="account-confirm" role="alertdialog" aria-labelledby={`${id}-confirm-title`} aria-describedby={`${id}-confirm-text`}>
              <strong id={`${id}-confirm-title`}>Start over?</strong>
              <p id={`${id}-confirm-text`}>This clears the chat and disconnects your accounts. It can&apos;t be undone.</p>
              <div className="account-confirm-actions">
                <button type="button" className="pill" data-autofocus disabled={deleting} onClick={backOut}>Cancel</button>
                <button type="button" className="pill destructive" disabled={startOverDisabled || onCall} onClick={onStartOver}>{deleting ? 'Clearing…' : 'Start over'}</button>
              </div>
            </div>
          ) : (
            <div role="menu" id={`${id}-menu`} aria-label="Account">
              <a role="menuitem" className="menu-item" href="/inspect" target="_blank" rel="noreferrer" onClick={() => close(false)}>
                <AgentLogIcon width={17} height={17} className="menu-icon" />
                <span>Agent log</span>
                <ExternalIcon width={15} height={15} className="menu-trail" />
              </a>
              <button type="button" role="menuitem" className="menu-item" data-start-over aria-disabled={Boolean(blocked) || startOverDisabled} title={blocked}
                onClick={() => { if (!blocked && !startOverDisabled) setConfirming(true); }}>
                <StartOverIcon width={17} height={17} className="menu-icon" />
                <span>Start over…</span>
              </button>
              <div className="menu-separator" role="separator" />
              <button type="button" role="menuitem" className="menu-item" aria-disabled={Boolean(blocked) || signingOut} title={blocked}
                onClick={() => { if (!blocked && !signingOut) onSignOut(); }}>
                <SignOutIcon width={17} height={17} className="menu-icon" />
                <span>{signingOut ? 'Signing out…' : 'Sign out'}</span>
              </button>
            </div>
          )}
          {blocked && !confirming ? <p className="menu-note">Start over and Sign out are available after the call.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
