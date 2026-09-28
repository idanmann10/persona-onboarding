import type { Metadata } from 'next';
import { LegalPage } from '../legal/legal-page';

export const metadata: Metadata = { title: 'Terms · Persona' };

export default function TermsPage() {
  return (
    <LegalPage title="Terms" updated="September 28, 2026">
      <p>This is a preview of Persona&apos;s onboarding, built as a work trial and run by Idan Mann. By using it you agree to these terms.</p>
      <h2>A preview, not a product</h2>
      <p>It&apos;s provided as is, for trying out, with no guarantee that it&apos;s available, correct or kept running. Don&apos;t rely on it for anything important.</p>
      <h2>What the assistant can do</h2>
      <p>It can read the Gmail and Calendar accounts you choose to connect and run the recurring tasks you approve. It can&apos;t send email or change your calendar. It can make mistakes, so check anything that matters.</p>
      <h2>Fair use</h2>
      <p>Don&apos;t use it to break the law, to harm others, or to try to get at other people&apos;s data. Usage is rate-limited, and access can be removed at any time.</p>
      <h2>Your data</h2>
      <p>How your data is used and deleted is described in the <a href="/privacy">privacy page</a>.</p>
      <h2>Contact</h2>
      <p><a href="mailto:idanmann10@gmail.com">idanmann10@gmail.com</a></p>
    </LegalPage>
  );
}
