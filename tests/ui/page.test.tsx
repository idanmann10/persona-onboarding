import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Home from '../../app/page';
import { assistantGroupEnds, Bubble, TimelineEntry } from '../../app/thread';
import { Avatar, avatarCandidates, avatarInitial, DEFAULT_AVATAR_URL } from '../../app/components/avatar';
import type { TimelineItem } from '../../lib/domain/project';

const noop = () => undefined;
const message = (id: string, speaker: 'user' | 'assistant', text: string): TimelineItem => ({ kind: 'message', id, speaker, channel: 'text', text });

describe('chat shell', () => {
  it('presents a conversation, composer, and call control without a forced onboarding form', () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain('Persona');
    expect(html).toContain('Loading your conversation');
    expect(html).toContain('<textarea');
    expect(html).toContain('Call');
    expect(html).not.toContain('Enter your name');
  });

  it('shows the Persona brand, the assistant photo, and the header actions, with no orbs', () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain('class="brand"');
    expect(html).toContain(`src="${DEFAULT_AVATAR_URL}"`);
    expect(html).toContain('>Apps<');
    expect(html).toContain('href="/inspect"');
    expect(html).toContain('Start over');
    expect(html).toContain('call-button glass');
    expect(html).not.toMatch(/\borb\b/);
  });
});

describe('assistant avatars', () => {
  it('tries the assistant photo, then the default photo', () => {
    expect(avatarCandidates('https://cdn.example/a.png')).toEqual(['https://cdn.example/a.png', DEFAULT_AVATAR_URL]);
    expect(avatarCandidates(undefined)).toEqual([DEFAULT_AVATAR_URL]);
    expect(avatarCandidates('  ')).toEqual([DEFAULT_AVATAR_URL]);
    expect(avatarCandidates(DEFAULT_AVATAR_URL)).toEqual([DEFAULT_AVATAR_URL]);
  });

  it('uses the first letter of the name for the fallback circle', () => {
    expect(avatarInitial('nova')).toBe('N');
    expect(avatarInitial('  ')).toBe('P');
    expect(avatarInitial('Émile')).toBe('É');
  });

  it('renders a round image of the given size', () => {
    const html = renderToStaticMarkup(<Avatar src="/avatars/nova.png" name="Nova" size={24} />);
    expect(html).toContain('src="/avatars/nova.png"');
    expect(html).toContain('width="24"');
    expect(html).toContain('class="avatar"');
  });

  it('puts the small avatar next to the last bubble of each assistant group only', () => {
    const timeline = [message('1', 'assistant', 'Hi'), message('2', 'assistant', 'I am Nova'), message('3', 'user', 'Hey'), message('4', 'assistant', 'Welcome')];
    expect([...assistantGroupEnds(timeline)]).toEqual([1, 3]);
    expect([...assistantGroupEnds(timeline, true)]).toEqual([1]);
    const withFace = renderToStaticMarkup(<Bubble speaker="assistant" text={'One\n\nTwo'} face={{ name: 'Nova', avatarUrl: '/avatars/nova.png' }} />);
    expect(withFace.match(/<img/g)).toHaveLength(1);
    expect(withFace.indexOf('<img')).toBeGreaterThan(withFace.indexOf('One'));
    expect(renderToStaticMarkup(<Bubble speaker="assistant" text="Plain" />)).not.toContain('<img');
  });
});

describe('thread cards', () => {
  it('offers a call with the assistant photo and a primary Answer pill', () => {
    const offer = { kind: 'call_offer', id: 'o1', status: 'offered' } as unknown as TimelineItem;
    const html = renderToStaticMarkup(<TimelineEntry item={offer} assistantName="Nova" busy={false} avatarUrl="/avatars/nova.png"
      onAnswer={noop} onDeclineCall={noop} onConnect={noop} onDeclineConnection={noop} onAutomation={noop} />);
    expect(html).toContain('Nova is ready to call');
    expect(html).toContain('src="/avatars/nova.png"');
    expect(html).toMatch(/class="pill primary"[^>]*>.*Answer/);
    expect(html).not.toMatch(/\borb\b/);
  });
});
