import type { Metadata } from 'next';
import { LegalPage } from '../legal/legal-page';

export const metadata: Metadata = { title: 'Privacy · Persona' };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" updated="September 28, 2026">
      <p>This is a preview of Persona&apos;s onboarding, built as a work trial and run by Idan Mann. It keeps only what it needs to be useful to you, and you can delete it at any time.</p>
      <h2>What we keep</h2>
      <ul>
        <li>From Google sign-in: your name, email address and profile photo. We don&apos;t ask Google for anything else at sign-in.</li>
        <li>Your conversation with the assistant, including transcripts of browser calls.</li>
        <li>Your approximate location (city and time zone) from your network, so times and suggestions fit where you are.</li>
        <li>Notes the assistant saves about you and how you like to work, so it doesn&apos;t ask twice.</li>
      </ul>
      <h2>Gmail and Calendar</h2>
      <p>Only if you choose to connect them, through Composio. Access is read-only: the assistant can search your mail and read your calendar to answer what you ask, and it can&apos;t send, delete or change anything. You can disconnect at any time from the Apps sheet.</p>
      <h2>Public research</h2>
      <p>If you tell the assistant your full name and company, it may look up your public professional profile (Exa, Context.dev) to be more useful. It only does this when exactly one public profile matches, and it never looks for private or sensitive details.</p>
      <h2>Who processes it</h2>
      <p>OpenAI runs the assistant&apos;s language and voice models. Composio handles account connections. Data is stored in a Postgres database hosted for this app. We don&apos;t sell your data or use it for advertising.</p>
      <h2>Deleting your data</h2>
      <p>Use Start over in the app to delete your conversation and disconnect your accounts, or email <a href="mailto:idanmann10@gmail.com">idanmann10@gmail.com</a> and we&apos;ll delete everything tied to your account.</p>
    </LegalPage>
  );
}
