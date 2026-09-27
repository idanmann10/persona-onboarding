import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Home from '../../app/page';

describe('chat shell', () => {
  it('presents a conversation, composer, and call control without a forced onboarding form', () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain('Persona');
    expect(html).toContain('Loading your conversation');
    expect(html).toContain('<textarea');
    expect(html).toContain('Call');
    expect(html).not.toContain('Enter your name');
  });
});
