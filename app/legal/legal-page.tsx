import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './legal.module.css';

/** Shared frame for the privacy and terms pages that Google's consent screen links to; readable signed out. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className={styles.page}>
      <Link href="/" className={styles.back}>Persona</Link>
      <h1>{title}</h1>
      <p className={styles.updated}>Last updated {updated}</p>
      {children}
    </main>
  );
}
